"use strict";
const { CONFIG } = require("./config");
const crypto = require("node:crypto");
const { roundStep, symbolRules } = require("./binance-execution");
const { isRiskWithinBudget } = require("./execution-risk");
const {
  getTradeActualRisk,
  summarizeClosedTrade,
} = require("./trade-accounting");
const TIMEOUT_MS = CONFIG.TIMEOUT_BARS * CONFIG.BAR_HOURS * 60 * 60 * 1000;
const id = (trade, kind) =>
  `n9_${trade.keyPrefix}_${kind}_${crypto.randomBytes(5).toString("hex")}`;
const same = (a, b) =>
  Math.abs(Number(a) - Number(b)) <= Math.max(1e-9, Math.abs(Number(b)) * 1e-9);
function hasConfirmedEntryFill(order) {
  const qty = Number(order?.executedQty),
    price = Number(order?.avgPrice) > 0 ? Number(order.avgPrice)
      : Number(order?.cumQuote) / qty,
    time = Number(order?.time || order?.transactTime || order?.updateTime);
  return order?.orderId != null &&
    [qty, price, time].every((v) => Number.isFinite(v) && v > 0);
}

function newTrade(decision, sizing, now = Date.now()) {
  const signalKey = `${decision.symbol}:${decision.signalAt}`;
  return {
    ...decision,
    ...sizing,
    signalKey,
    tradeId: signalKey,
    keyPrefix: crypto
      .createHash("sha256")
      .update(signalKey)
      .digest("hex")
      .slice(0, 8),
    setup: "NINE_AI_4H",
    result: "PENDING",
    createdAt: now,
    decisionAt: now,
    plannedLevels: {
      entry: decision.entry,
      sl: sizing.sl,
      tp1: sizing.tp1,
      tp2: sizing.tp2,
    },
    protectionIds: {},
    protectionAlgoIds: {},
    maxAdverseMove: 0,
    maxFavorableMove: 0,
    nineAiDecisionKey: decision.nineAiDecisionKey,
    nineAiSetupKey: decision.setupKey,
    nineAiFeatureSnapshot: decision.featureSnapshot,
    nineAiPredictionSnapshot: {
      edges: decision.edges,
      predictedEdgeR: decision.edges[decision.side].edge,
      predictedR:
        decision.edges[decision.side].p *
          decision.edges[decision.side].expectedR -
        decision.edges[decision.side].cost,
      predictedCostR: decision.edges[decision.side].cost,
      predictedProbability: decision.edges[decision.side].p,
      predictedExpectedR: decision.edges[decision.side].expectedR,
    },
    state: "CLAIMED",
    opening: false,
  };
}
function hydrateFill(trade, order) {
  const qty = Number(order.executedQty),
    entry =
      Number(order.avgPrice) > 0
        ? Number(order.avgPrice)
        : Number(order.cumQuote) / qty;
  if (
    !(qty > 0 && entry > 0) ||
    !Number.isFinite(qty) ||
    !Number.isFinite(entry)
  )
    throw new Error("ENTRY_FILL_NOT_CONFIRMED");
  const p = trade.plannedLevels;
  if (!p || ![p.entry, p.sl, p.tp1, p.tp2].every(Number.isFinite))
    throw new Error("MISSING_DURABLE_TRADE_PLAN");
  const sign = trade.side === "LONG" ? 1 : -1;
  trade.entry = entry;
  trade.price = p.entry;
  const quantiles = trade.tradePlan;
  const ai7 =
    quantiles?.outcomeMode === "AI7_LABELED" &&
    [quantiles.maePct, quantiles.mfe50Pct, quantiles.mfe90Pct].every(
      Number.isFinite,
    );
  const rules = trade.rules;
  trade.sl = ai7
    ? roundStep(
        entry * (1 - (sign * quantiles.maePct) / 100),
        rules.tick,
        sign > 0 ? "ceil" : "floor",
      )
    : p.sl;
  // After the real fill, recompute TP from actual entry, quantiles AND actual SL.
  // Floors are rounded outward; preserve raw MFE separately in entryExecution.
  const minReward = CONFIG.MIN_RR * Math.abs(entry - trade.sl);
  const tp1Distance = ai7
    ? Math.max(entry * quantiles.mfe50Pct / 100, minReward)
    : Math.abs(p.tp1 - p.entry);
  const tp2Distance = ai7
    ? Math.max(entry * quantiles.mfe90Pct / 100, tp1Distance)
    : Math.abs(p.tp2 - p.entry);
  trade.tp1 = roundStep(ai7 ? entry + sign * tp1Distance : p.tp1,
    rules.tick, sign > 0 ? "ceil" : "floor");
  trade.tp2 = roundStep(ai7 ? entry + sign * tp2Distance : p.tp2,
    rules.tick, sign > 0 ? "ceil" : "floor");
  trade.tp = trade.tp2;
  trade.actualQuantity = qty;
  const sliceTotal = CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1];
  trade.tp1Quantity = roundStep(qty * CONFIG.TP_BATCHES[0] / sliceTotal, trade.rules.step);
  trade.tp2Quantity = roundStep(qty - trade.tp1Quantity, trade.rules.step);
  trade.initialRisk = Math.abs(entry - trade.sl);
  trade.actualInitialRiskUSDT = qty * trade.initialRisk;
  trade.enteredAt = Number(
    order.time || order.transactTime || order.updateTime,
  );
  if (!(trade.enteredAt > 0)) throw new Error("ENTRY_TIME_NOT_CONFIRMED");
  trade.openedAt = trade.enteredAt;
  trade.deadlineAt = trade.enteredAt + TIMEOUT_MS;
  trade.entryExecution = {
    orderId: String(order.orderId),
    clientOrderId: order.clientOrderId || trade.entryClientId,
    status: order.status,
    fillSource: order.fillSource || "CONFIRMED_ORDER_RESPONSE",
    averagePrice: entry,
    executedQuantity: qty,
    orderTime: trade.enteredAt,
    plannedEntry: p.entry,
    plannedSL: p.sl,
    plannedTP1: p.tp1,
    plannedTP: p.tp2,
    actualEntry: entry,
    actualSL: trade.sl,
    rawQuantileSL: ai7 ? entry * (1 - (sign * quantiles.maePct) / 100) : null,
    rawQuantileTP1: ai7
      ? entry * (1 + (sign * quantiles.mfe50Pct) / 100)
      : null,
    rawQuantileTP2: ai7
      ? entry * (1 + (sign * quantiles.mfe90Pct) / 100)
      : null,
    actualTP1: trade.tp1,
    actualTP: trade.tp2,
    entrySlippage: entry - p.entry,
  };
  trade.state = "NEEDS_PROTECTION";
  return trade;
}
function fillRiskValid(t) {
  const sign = t.side === "LONG" ? 1 : -1;
  return (
    Number.isFinite(t.actualInitialRiskUSDT) &&
    isRiskWithinBudget(t.actualInitialRiskUSDT, t.risk) &&
    (sign > 0
      ? t.sl < t.entry && t.entry < t.tp1 && t.tp1 <= t.tp2
      : t.tp2 <= t.tp1 && t.tp1 < t.entry && t.entry < t.sl) &&
    Math.abs(t.tp1 - t.entry) + Number.EPSILON * Math.max(t.entry,t.tp1) >=
      CONFIG.MIN_RR * Math.abs(t.entry - t.sl) &&
    t.tp1Quantity >= t.rules.minQty &&
    t.tp2Quantity >= t.rules.minQty &&
    same(t.tp1Quantity + t.tp2Quantity, t.actualQuantity) &&
    same(roundStep(t.tp1Quantity, t.rules.step), t.tp1Quantity) &&
    same(roundStep(t.tp2Quantity, t.rules.step), t.tp2Quantity)
  );
}

class TradeLifecycle {
  constructor({
    exchange,
    db,
    journal,
    learner,
    notify = async () => {},
    notifyEntry = async () => {},
    now = () => Date.now(),
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    Object.assign(this, { exchange, db, journal, learner, notify, notifyEntry, now, wait });
    this.trades = db.collection("trades");
    this.claims = db.collection("trade_signal_claims");
    this.active = new Map();
    this.running = false;
    this.entryRunning = false;
    this.uncertain = false;
    this.untracked = new Set();
    this.persistPending = new Map();
    this.maintenanceRunning = false;
  }
  async initialize() {
    await this.trades.createIndex(
      { signalKey: 1 },
      {
        unique: true,
        partialFilterExpression: { signalKey: { $type: "string" } },
        name: "uniq_trade_signal_key_v2",
      },
    );
    await this.trades.createIndex(
      { result: 1, createdAt: -1 },
      { name: "trades_result_recent" },
    );
    await this.claims.createIndex(
      { signalKey: 1 },
      { unique: true, name: "uniq_trade_signal_key" },
    );
    for (const name of [
      "expire_trade_signal_claims_10d",
      "expire_trade_signal_claims_90d",
    ]) {
      try {
        await this.claims.dropIndex(name);
      } catch (e) {
        if (![26, 27].includes(e.code)) throw e;
      }
    }
    // Update existing TTL policy in place when the configured days change.
    // Claims with no closedAt (active/uncertain) must never expire.
    const claimTTL = CONFIG.TRADE_CLOSED_CLAIMS_RETENTION_DAYS * 86400;
    const claimTTLName = "expire_closed_signal_claims_90d";
    if (typeof this.claims.listIndexes === "function") {
      const indexes = await this.claims.listIndexes().toArray();
      const prior = indexes.find(index => index.name === claimTTLName);
      if (prior && prior.expireAfterSeconds !== claimTTL) {
        if (typeof this.db.command !== "function") throw new Error("CLAIM_TTL_MIGRATION_UNAVAILABLE");
        await this.db.command({
          collMod: "trade_signal_claims",
          index: { name: claimTTLName, expireAfterSeconds: claimTTL },
        });
      }
    }
    await this.claims.createIndex(
      { closedAt: 1 },
      {
        expireAfterSeconds: CONFIG.TRADE_CLOSED_CLAIMS_RETENTION_DAYS * 86400,
        name: "expire_closed_signal_claims_90d",
      },
    );
    await this.db
      .collection("nine_ai_outcome_labels")
      .createIndex(
        { tradeId: 1 },
        { unique: true, name: "uniq_nine_ai_outcome_trade" },
      );
    await this.db
      .collection("nine_ai_outcome_labels")
      .createIndex(
        { source: 1, labeled: 1, closedAt: -1 },
        { name: "nine_ai_labeled_outcomes_by_close" },
      );
    const pending = await this.trades.find({ result: "PENDING" }).toArray();
    for (const t of pending) {
      if (t.setup !== "NINE_AI_4H" && !t.plannedLevels) continue;
      t.signalKey = t.signalKey || `${t.symbol}:${t.signalAt || t.createdAt}`;
      t.tradeId = t.signalKey;
      if (t._id)
        await this.trades.updateOne(
          { _id: t._id },
          { $set: { signalKey: t.signalKey, tradeId: t.signalKey } },
        );
      t.keyPrefix =
        t.keyPrefix ||
        crypto
          .createHash("sha256")
          .update(t.signalKey)
          .digest("hex")
          .slice(0, 8);
      t.protectionIds = t.protectionIds || {};
      t.protectionAlgoIds = t.protectionAlgoIds || {};
      t.actualQuantity = Number(
        t.actualQuantity || t.entryExecution?.executedQuantity || t.quantity,
      );
      t.tp2 = Number(t.tp2 || t.tp);
      t.initialRisk = Number(t.initialRisk || Math.abs(t.entry - t.sl));
      t.actualInitialRiskUSDT = getTradeActualRisk(t);
      if (
        !t.entryExecution &&
        Number(t.enteredAt) > 0 &&
        Number(t.entry) > 0 &&
        t.actualQuantity > 0
      ) {
        t.entryExecution = {
          orderId: t.entryOrderId ?? null,
          orderTime: Number(t.enteredAt),
          executedQuantity: t.actualQuantity,
          averagePrice: Number(t.entry),
          plannedEntry: Number(t.price || t.entry),
          captureStatus: "LEGACY_POSITION_METADATA",
        };
      }
      t.rules = t.rules || symbolRules(await this.exchange.info(t.symbol));
      t.deadlineAt =
        t.deadlineAt || Number(t.enteredAt || t.openedAt || t.createdAt) + TIMEOUT_MS;
      // Legacy records must verify/adopt real protection before being considered active.
      if (
        !["CLOSING", "ENTRY_UNKNOWN", "CLOSED_PENDING_ACCOUNTING"].includes(t.state)
      )
        t.state = "NEEDS_PROTECTION";
      // Recheck exchange cleanup after every process restart.
      t.protectionCleanupConfirmed = false;
      t.opening = false;
      this.active.set(t.signalKey, t);
    }
    await this.recoverClaims();
  }
  async persist(t) {
    // Background accounting and critical protection can progress independently.
    // Serialize writes and snapshot at dispatch so older writes cannot restore
    // stale protection IDs or CLOSING/ACTIVE state after newer changes.
    const previous = this.persistPending.get(t.signalKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.persistNow(t));
    this.persistPending.set(t.signalKey, task);
    try {
      await task;
    } finally {
      if (this.persistPending.get(t.signalKey) === task)
        this.persistPending.delete(t.signalKey);
    }
  }
  async persistNow(t) {
    const doc = { ...t, updatedAt: this.now() };
    delete doc._id;
    delete doc.opening;
    delete doc.entryOrderAttempted;
    await this.claims.updateOne(
      { signalKey: t.signalKey },
      {
        $set: {
          symbol: t.symbol,
          side: t.side,
          state: t.state,
          orderClientId: t.entryClientId,
          tradeSnapshot: doc,
          updatedAt: new Date(this.now()),
        },
      },
      { upsert: true },
    );
    await this.trades.updateOne(
      { signalKey: t.signalKey },
      { $set: doc },
      { upsert: true },
    );
  }
  async recoverClaims() {
    const claims = await this.claims
      .find({
        state: {
          $in: [
            "CLAIMED",
            "ORDER_SUBMITTING",
            "ENTRY_UNKNOWN",
            "NEEDS_PROTECTION",
            "ACTIVE",
            "CLOSING",
            "CLOSED_PENDING_ACCOUNTING",
            "OPEN_UNRECORDED",
            "TRADE_SAVED",
          ],
        },
      })
      .toArray();
    for (const claim of claims) {
      if (this.active.has(claim.signalKey)) continue;
      const t = claim.tradeSnapshot;
      if (!t || !t.plannedLevels || !claim.orderClientId) continue;
      t.entryClientId = claim.orderClientId;
      t.opening = false;
      // Keep accepted/uncertain claims under management even if fill details
      // are still missing. They must not become unattended untracked positions.
      this.active.set(t.signalKey, t);
      try {
        if (!t.entryExecution && !(await this.resolveEntry(t))) continue;
        await this.persist(t);
      } catch (e) {
        this.uncertain = true;
        await this.alert(
          `Entry reconciliation pending: ${t.symbol}: ${e.message}`,
        );
      }
    }
  }
  async alert(message) {
    try {
      await this.notify(message);
    } catch (_) {
      // Operational reporting must never abort the protection/timeout pass.
      console.error("OPERATIONAL NOTIFICATION PENDING");
    }
  }
  async resolveEntry(t, initialOrder = null) {
    let order =
      initialOrder || (await this.exchange.order(t.symbol, t.entryClientId));
    const terminal = new Set([
      "FILLED",
      "CANCELED",
      "EXPIRED",
      "EXPIRED_IN_MATCH",
      "REJECTED",
    ]);
    const needsDetails = (o) => !terminal.has(o.status) ||
      ((o.status === "FILLED" || Number(o.executedQty) > 0) && !hasConfirmedEntryFill(o));
    for (let i = 0; needsDetails(order) && i < CONFIG.TRADE_ENTRY_LOOKUP_ATTEMPTS; i++) {
      await this.wait(CONFIG.TRADE_ENTRY_LOOKUP_DELAY_MS);
      order = await this.exchange.order(t.symbol, t.entryClientId);
    }
    if (!terminal.has(order.status)) order = await this.exchange.cancelEntry(t);
    if (!terminal.has(order.status)) throw new Error("ENTRY_STILL_SETTLING");
    if (order.executedQty != null && String(order.executedQty).trim() !== "" &&
        Number(order.executedQty) === 0 && order.status !== "FILLED") {
      t.state = "ENTRY_REJECTED";
      t.result = "ENTRY_REJECTED";
      await this.persist(t);
      this.active.delete(t.signalKey);
      return false;
    }
    if (!hasConfirmedEntryFill(order)) {
      // Retain only diagnostic order fields, never credentials or the full
      // signed request. FILLED alone does not establish actual price/quantity.
      t.entryResponseSummary = Object.fromEntries(
        ["orderId", "status", "executedQty", "avgPrice", "cumQuote", "time", "updateTime"]
          .map((key) => [key, order[key] ?? null]),
      );
      if (this.exchange.entryFill) order = await this.exchange.entryFill(t, order);
      if (!hasConfirmedEntryFill(order)) throw new Error("ENTRY_FILL_NOT_CONFIRMED");
    }
    hydrateFill(t, order);
    return true;
  }
  async enter(trade) {
    if (this.entryRunning || this.uncertain || this.untracked.size)
      return false;
    if ([...this.active.values()].some((t) => t.symbol === trade.symbol))
      return false;
    this.entryRunning = true;
    trade.opening = true;
    try {
      if (
        (await this.exchange.positions()).some((p) => p.symbol === trade.symbol)
      )
        return false;
      if ((await this.exchange.openOrders(trade.symbol)).length) return false;
      // Stale siblings are cleared only while the exchange confirms flat.
      await this.exchange.cancelAlgos(trade.symbol);
      if ((await this.exchange.openAlgos()).some((o) => o.symbol === trade.symbol))
        return false;
      trade.entryClientId = id(trade, "entry");
      trade.state = "ORDER_SUBMITTING";
      trade.submittedAt = Math.floor(this.now() + (this.exchange.offset || 0));
      const priorClaim = await this.claims.findOne({ signalKey: trade.signalKey });
      const claim = {
        signalKey: trade.signalKey,
        symbol: trade.symbol,
        side: trade.side,
        state: trade.state,
        orderClientId: trade.entryClientId,
        tradeSnapshot: { ...trade, opening: false },
        updatedAt: new Date(this.now()),
      };
      if (priorClaim) {
        // Only a definitive exchange rejection is retryable. Unknown submissions
        // retain their original client ID and remain blocked to prevent duplicates.
        if (priorClaim.state !== "ENTRY_REJECTED") return false;
        const retried = await this.claims.updateOne(
          { signalKey: trade.signalKey, state: "ENTRY_REJECTED" },
          { $set: claim, $unset: { closedAt: "" } },
        );
        if (retried.matchedCount !== 1) return false;
      } else {
        try {
          await this.claims.insertOne({ ...claim, createdAt: new Date(this.now()) });
        } catch (e) {
          if (e.code === 11000) return false;
          throw e;
        }
      }
      this.active.set(trade.signalKey, trade);
      let order;
      try {
        trade.entryOrderAttempted = true;
        order = await this.exchange.market(trade, trade.entryClientId);
      } catch (e) {
        trade.state = e.ambiguous ? "ENTRY_UNKNOWN" : "ENTRY_REJECTED";
        if (e.ambiguous) this.uncertain = true;
        else {
          this.active.delete(trade.signalKey);
          trade.result = "ENTRY_REJECTED";
        }
        await this.persist(trade);
        throw e;
      }
      try {
        if (!(await this.resolveEntry(trade, order))) return false;
      } catch (e) {
        trade.state = "ENTRY_UNKNOWN";
        this.uncertain = true;
        try { await this.persist(trade); }
        catch (saveError) { console.error("ENTRY RECOVERY SNAPSHOT PENDING", trade.symbol, saveError.message); }
        throw e;
      }
      try {
        await this.persist(trade);
      } catch (e) {
        this.uncertain = true;
        console.error("ENTRY SNAPSHOT PERSIST PENDING", e.message);
      }
      if (!fillRiskValid(trade)) {
        await this.close(trade, "POST_FILL_RISK_OR_GEOMETRY");
        return false;
      }
      try {
        await this.ensureProtection(trade, await this.exchange.openAlgos());
      } catch (e) {
        await this.close(trade, "INITIAL_PROTECTION_FAILED");
        throw e;
      }
      await this.queueEntryNotification(trade);
      return true;
    } catch (e) {
      console.error("ENTRY", trade.symbol, e.message);
      if (trade.entryResponseSummary)
        console.error("ENTRY RESPONSE DETAILS", trade.symbol, JSON.stringify(trade.entryResponseSummary));
      if (this.active.has(trade.signalKey) && trade.state === "ENTRY_UNKNOWN" && !trade.entryExecution) {
        // No verified fill means protection cannot be sized correctly. Never
        // continue submitting other entries while this exposure is unresolved.
        this.uncertain = true;
        try { await this.close(trade, "UNCONFIRMED_ENTRY_FILL"); }
        catch (closeError) { console.error("EMERGENCY CLOSE PENDING", trade.symbol, closeError.message); }
      }
      return false;
    } finally {
      trade.opening = false;
      this.entryRunning = false;
    }
  }
  async queueEntryNotification(t) {
    if (t.entryNotificationQueued || !t.protectionEstablishedAt) return;
    try {
      await this.notifyEntry(t);
      t.entryNotificationQueued = true;
      await this.persist(t);
    } catch (_) {
      t.entryNotificationQueued = false;
      console.error("ENTRY NOTIFICATION PENDING", t.symbol);
    }
  }
  async ensureProtection(t, openAlgos, position = null) {
    t.protectionIds = t.protectionIds || {};
    t.protectionAlgoIds = t.protectionAlgoIds || {};
    if (
      ![t.sl, t.tp1, t.tp2, t.actualQuantity].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new Error("INCOMPLETE_PROTECTION_PLAN");
    position =
      position ||
      (await this.exchange.positions()).find((p) => p.symbol === t.symbol);
    if (!position) return;
    const currentQty = Math.abs(Number(position.positionAmt));
    const sharedTarget = t.tp1 === t.tp2;
    // Recover both half-target fills before repairing either sibling. Otherwise
    // a restart with coincident targets and a canceled sibling can mistake
    // the remaining half for unexplained exposure and close it.
    const priorOrders = new Map();
    if (!same(currentQty, t.actualQuantity)) {
      for (const kind of ["tp1", "tp2"]) {
        if (t[kind + "Filled"]) continue;
        const previous = t.protectionIds[kind],
          legacyAlgoId = t[kind + "OrderId"];
        if (!previous && !legacyAlgoId) continue;
        if (
          openAlgos.some((o) => o.symbol === t.symbol &&
            (previous ? o.clientAlgoId === previous
              : String(o.algoId) === String(legacyAlgoId)))
        )
          continue;
        let prior;
        try {
          prior = previous
            ? await this.exchange.algo(t.symbol, previous)
            : await this.exchange.algoById(t.symbol, legacyAlgoId);
        } catch (e) {
          if (![-2011, -2013].includes(e.code)) throw e;
        }
        priorOrders.set(kind, prior);
        if (!prior?.actualOrderId) continue;
        const child = await this.exchange.request(
          "/fapi/v1/order",
          { symbol: t.symbol, orderId: prior.actualOrderId },
          { signed: true },
        );
        if (
          child.status === "FILLED" && same(child.executedQty, t[kind + "Quantity"])
        ) {
          t[kind + "Filled"] = true;
          t.protectionOrderIds = t.protectionOrderIds || {};
          t.protectionOrderIds[kind] = String(child.orderId);
        }
      }
    }
    for (const kind of ["sl", "tp2", "tp1"]) {
      if (kind === "tp1" && t.tp1Filled) continue;
      if (kind === "tp2" && t.tp2Filled) continue;
      const trigger = t[kind],
        closeSide = t.side === "LONG" ? "SELL" : "BUY";
      const matches = (o) =>
        o.symbol === t.symbol &&
        o.side === closeSide &&
        same(o.triggerPrice, trigger) &&
        (o.orderType || o.type) ===
          (kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET") &&
        (kind === "tp1" || kind === "tp2"
          ? String(o.reduceOnly) === "true" &&
            same(o.quantity, t[kind + "Quantity"])
          : String(o.closePosition) === "true");
      const existing = openAlgos.find(
        (o) =>
          matches(o) &&
          (o.clientAlgoId === t.protectionIds[kind] ||
            String(o.clientAlgoId).startsWith(`n9_${t.keyPrefix}_${kind}_`) ||
            String(o.algoId) === String(t[`${kind}OrderId`])),
      );
      if (existing) {
        t.protectionIds[kind] = existing.clientAlgoId;
        t.protectionAlgoIds[kind] = existing.algoId;
        continue;
      }
      const previous = t.protectionIds[kind];
      const legacyAlgoId = t[`${kind}OrderId`];
      if (previous || legacyAlgoId) {
        let prior;
        try {
          prior = priorOrders.has(kind)
            ? priorOrders.get(kind)
            : previous
              ? await this.exchange.algo(t.symbol, previous)
              : await this.exchange.algoById(t.symbol, legacyAlgoId);
          if (prior?.clientAlgoId) t.protectionIds[kind] = prior.clientAlgoId;
        } catch (e) {
          if (![-2011, -2013].includes(e.code)) throw e;
        }
        if (prior?.actualOrderId) {
          const child = await this.exchange.request(
            "/fapi/v1/order",
            { symbol: t.symbol, orderId: prior.actualOrderId },
            { signed: true },
          );
          if (child.status === "FILLED") {
            t.protectionOrderIds = t.protectionOrderIds || {};
            t.protectionOrderIds[kind] = String(child.orderId);
            if (
              (kind === "tp1" || kind === "tp2") &&
              same(child.executedQty, t[kind + "Quantity"])
            ) {
              t[kind + "Filled"] = true;
              continue;
            }
            // SL/TP2 may have just flattened it; next position snapshot reconciles.
            if (kind !== "tp1") return;
          }
          if (["NEW", "PARTIALLY_FILLED"].includes(child.status)) return;
        }
        if (
          prior &&
          ["NEW", "TRIGGERING", "WORKING"].includes(prior.algoStatus)
        )
          return;
      }
      if (
        (kind === "tp1" || kind === "tp2") &&
        !same(currentQty, t.actualQuantity) &&
        !(
           t[kind === "tp1" ? "tp2Filled" : "tp1Filled"] &&
          same(currentQty, t[kind + "Quantity"])
        )
      )
        throw new Error("PARTIAL_POSITION_REQUIRES_FILL_RECONCILIATION");
      t.protectionIds[kind] = id(t, kind);
      t.state = "NEEDS_PROTECTION";
      // Save the ID before POST. On restart the same order can be queried/adopted.
      await this.persist(t);
      const order = await this.exchange.protection(
        t,
        kind,
        t.protectionIds[kind],
      );
      if (!order?.algoId) throw new Error("PROTECTION_NOT_CONFIRMED");
      t.protectionAlgoIds[kind] = order.algoId;
    }
    t.state = "ACTIVE";
    t.protectionEstablishedAt = t.protectionEstablishedAt || this.now();
    try {
      await this.persist(t);
    } catch (e) {
      // Every new client ID was saved before POST. Confirmed exchange-side
      // protection remains valid even if this final status write fails.
      this.uncertain = true;
      console.error("PROTECTION SNAPSHOT PENDING", t.symbol, e.message);
    }
  }
  async close(t, reason) {
    t.exitReason = reason;
    t.state = "CLOSING";
    const pos = (await this.exchange.positions()).find(
      (p) => p.symbol === t.symbol,
    );
    if (!pos) return this.cleanupFlatTrade(t);
    if (t.closeClientId) {
      try {
        const previous = await this.exchange.order(t.symbol, t.closeClientId);
        if (["NEW", "PARTIALLY_FILLED"].includes(previous.status)) return false;
        // Re-read remaining exposure before any new reduce-only close.
      } catch (e) {
        if (![-2011, -2013].includes(e.code)) throw e;
      }
    }
    const fresh = (await this.exchange.positions()).find(
      (p) => p.symbol === t.symbol,
    );
    if (!fresh) return this.cleanupFlatTrade(t);
    t.closeReferencePrice = Number(fresh.markPrice) || null;
    t.closeClientId = id(t, "exit");
    try {
      await this.persist(t);
    } catch (e) {
      this.uncertain = true;
      console.error("CLOSE SNAPSHOT PENDING", e.message);
    }
    const actualSide = Number(fresh.positionAmt) > 0 ? "LONG" : "SHORT";
    const closeOrder = await this.exchange.market(
      { ...t, side: actualSide },
      t.closeClientId,
      true,
      Math.abs(Number(fresh.positionAmt)),
    );
    t.closeOrderId =
      closeOrder?.orderId == null ? null : String(closeOrder.orderId);
    return this.cleanupFlatTrade(t);
  }
  async cleanupFlatTrade(t) {
    // Exchange safety precedes fills, funding, candle history and database writes.
    // Never remove protection while any exposure still exists in this symbol.
    if ((await this.exchange.positions()).some((p) => p.symbol === t.symbol))
      return false;
    if (!t.protectionCleanupConfirmed) {
      await this.exchange.cancelAlgos(t.symbol);
      const orders = await this.exchange.openOrders(t.symbol);
      if (orders.length) {
        const ownedIds = new Set(
          Object.values(t.protectionOrderIds || {}).map(String),
        );
        if (t.closeOrderId != null) ownedIds.add(String(t.closeOrderId));
        for (const kind of ["sl", "tp1", "tp2"]) {
          const clientId = t.protectionIds?.[kind],
            algoId = t[kind + "OrderId"];
          if (!clientId && !algoId) continue;
          try {
            const algo = clientId
              ? await this.exchange.algo(t.symbol, clientId)
              : await this.exchange.algoById(t.symbol, algoId);
            if (algo?.actualOrderId) ownedIds.add(String(algo.actualOrderId));
          } catch (e) {
            if (![-2011, -2013].includes(e.code)) throw e;
          }
        }
        const owned = (o) =>
          ownedIds.has(String(o.orderId)) ||
          String(o.clientOrderId).startsWith(`n9_${t.keyPrefix}_`);
        for (const o of orders.filter(owned))
          await this.exchange.cancelOrder(t.symbol, o.orderId);
        if ((await this.exchange.openOrders(t.symbol)).some(owned))
          throw new Error("CHILD_ORDER_CLEANUP_PENDING");
      }
      if ((await this.exchange.openAlgos()).some((o) =>
        o.symbol === t.symbol &&
        /^n9_[a-f0-9]{8}_(sl|tp1|tp2)_/.test(String(o.clientAlgoId))))
        throw new Error("PROTECTION_CLEANUP_PENDING");
      t.protectionCleanupConfirmed = true;
    }
    t.state = "CLOSED_PENDING_ACCOUNTING";
    return true;
  }
  async cleanupOrphanAlgos(positions, algos) {
    if (this.entryRunning) return;
    const known = new Set([...this.active.values()].map((t) => t.symbol));
    const exposed = new Set(positions.map((p) => p.symbol));
    const canceled = new Set();
    for (const o of algos) {
      if (
        known.has(o.symbol) || exposed.has(o.symbol) ||
        !/^n9_[a-f0-9]{8}_(sl|tp1|tp2)_/.test(String(o.clientAlgoId))
      )
        continue;
      const fresh = await this.exchange.positions();
      if (
        this.entryRunning ||
        [...this.active.values()].some((t) => t.symbol === o.symbol) ||
        fresh.some((p) => p.symbol === o.symbol)
      )
        continue;
      await this.exchange.cancelAlgo(o.symbol, o.algoId);
      canceled.add(String(o.algoId));
    }
    if (
      canceled.size &&
      (await this.exchange.openAlgos()).some((o) => canceled.has(String(o.algoId)))
    )
      throw new Error("ORPHAN_PROTECTION_CLEANUP_PENDING");
  }
  observe(t, price) {
    if (!(Number(price) > 0 && Number(t.entry) > 0)) return;
    const move = (Number(price) - t.entry) * (t.side === "LONG" ? 1 : -1);
    t.maxAdverseMove = Math.max(Number(t.maxAdverseMove) || 0, -move);
    t.maxFavorableMove = Math.max(Number(t.maxFavorableMove) || 0, move);
  }
  async excursions(t, until = this.now()) {
    // Retry incomplete measurement from entry, rather than permanently losing
    // a missing interval and then treating a partially measured trade as labeled.
    if (t.excursionDataIncomplete) t.excursionCursor = 0;
    t.excursionDataIncomplete = false;
    let cursor = Math.max(
      Math.ceil(Number(t.enteredAt) / 60000) * 60000,
      Number(t.excursionCursor) || 0,
    );
    const end = Math.floor(until / 60000) * 60000 - 1;
    for (let page = 0; cursor <= end && page < 20; page++) {
      const rows = await this.exchange.candles(t.symbol, "1m", 1500, {
        startTime: cursor,
        endTime: end,
      });
      if (!rows.length) {
        t.excursionDataIncomplete = true;
        break;
      }
      for (const row of rows) {
        if (Number(row[0]) !== cursor) {
          t.excursionDataIncomplete = true;
          break;
        }
        if (Number(row[0]) >= t.enteredAt && Number(row[6]) <= until) {
          this.observe(t, row[2]);
          this.observe(t, row[3]);
        }
        cursor = Number(row[0]) + 60000;
      }
      if (t.excursionDataIncomplete) break;
      if (rows.length < 1500) break;
    }
    if (cursor <= end) t.excursionDataIncomplete = true;
    t.excursionCursor = cursor;
    t.excursionSource = "CLOSED_1M_BARS_AND_OBSERVED_MARK_AND_FILL_PRICES";
    t.excursionBoundaryPrecision = "SAMPLED_WITHIN_ENTRY_AND_EXIT_MINUTES";
  }
  async finish(t) {
    if (!(await this.cleanupFlatTrade(t))) return false;
    const fills = await this.exchange.fills(t);
    const end = Math.max(...fills.map((f) => Number(f.time)));
    if (!Number.isFinite(end)) return false;
    const funding = await this.exchange.funding(
      t.symbol,
      t.enteredAt - 5000,
      end,
    );
    await this.exchange.convertFees(fills, funding);
    const closed = summarizeClosedTrade(t, fills, funding);
    if (!closed?.accountingComplete) {
      t.accountingPending = true;
      await this.persist(t);
      return false;
    }
    for (const kind of ["sl", "tp1", "tp2"]) {
      if (!t.protectionIds?.[kind]) continue;
      try {
        const algo = await this.exchange.algo(t.symbol, t.protectionIds[kind]);
        if (algo.actualOrderId) {
          t.protectionOrderIds = t.protectionOrderIds || {};
          t.protectionOrderIds[kind] = String(algo.actualOrderId);
          if (String(algo.actualOrderId) === String(closed.exitOrderId))
            t.exitReason = kind.toUpperCase();
        }
      } catch (e) {
        if (![-2011, -2013].includes(e.code)) throw e;
      }
    }
    closed.exitSlippageUSDT = 0;
    closed.exitSlippageComplete = true;
    for (const fill of closed.executionFills.filter(
      (f) => f.side === (t.side === "LONG" ? "SELL" : "BUY"),
    )) {
      const kind = Object.keys(t.protectionOrderIds || {}).find(
        (k) => String(t.protectionOrderIds[k]) === String(fill.orderId),
      );
      const reference = kind
        ? t[kind]
        : String(fill.orderId) === String(t.closeOrderId)
          ? t.closeReferencePrice
          : null;
      if (!(reference > 0)) {
        closed.exitSlippageComplete = false;
        continue;
      }
      closed.exitSlippageUSDT +=
        (t.side === "LONG"
          ? reference - Number(fill.price)
          : Number(fill.price) - reference) * Number(fill.qty);
    }
    for (const f of closed.executionFills) this.observe(t, Number(f.price));
    await this.excursions(t, closed.closedAt);
    // Preserve raw accounting before learning writes, so retry after a crash is idempotent.
    t.closedAccounting = closed;
    t.accountingPending = true;
    await this.persist(t);
    if (t.excursionDataIncomplete) return false;
    const actualRisk = getTradeActualRisk(t),
      tradeId = t.signalKey;
    if (!(actualRisk > 0)) throw new Error("ACTUAL_INITIAL_RISK_MISSING");
    if (t.nineAiSetupKey && !t.excursionDataIncomplete) {
      await this.db.collection("nine_ai_outcome_labels").updateOne(
        { tradeId },
        {
          $set: {
            tradeId,
            symbol: t.symbol,
            side: t.side,
            setupKey: t.nineAiSetupKey,
            entryPrice: t.entry,
            mae: t.maxAdverseMove,
            mfe: t.maxFavorableMove,
            maePct: (t.maxAdverseMove / t.entry) * 100,
            mfePct: (t.maxFavorableMove / t.entry) * 100,
            grossR: closed.grossRealizedPnl / actualRisk,
            realizedR: closed.pnl / actualRisk,
            grossUSDT: closed.grossRealizedPnl,
            netUSDT: closed.pnl,
            feesUSDT: closed.feesUSDT,
            fundingUSDT: closed.fundingUSDT,
            entrySlippageUSDT: closed.entrySlippageUSDT,
            exitSlippageUSDT: closed.exitSlippageComplete
              ? closed.exitSlippageUSDT : null,
            slippageComplete: closed.exitSlippageComplete === true,
            labeled: true,
            win: closed.pnl > 0,
            source: "REALIZED_CLOSED_TRADE",
            closedAt: closed.closedAt,
            accountingSchemaVersion: 2,
            featureSnapshot: t.nineAiFeatureSnapshot,
            decisionAt: t.decisionAt,
            entryOutcomeMode: t.tradePlan?.outcomeMode || null,
            entryStopMethod: t.tradePlan?.stopMethod || null,
            excursionSource: t.excursionSource,
            excursionBoundaryPrecision: t.excursionBoundaryPrecision,
          },
        },
        { upsert: true },
      );
    }
    if (t.nineAiDecisionKey)
      await this.journal.recordActualOutcome({
        decisionKey: t.nineAiDecisionKey,
        tradeId,
        realizedR: closed.pnl / actualRisk,
        pnl: closed.pnl,
        closedAt: closed.closedAt,
        symbol: t.symbol,
        side: t.side,
        entryExecution: t.entryExecution,
        exit: {
          price: closed.exitPrice,
          quantity: closed.exitQty,
          orderIds: closed.exitOrderIds,
          reason: t.exitReason || "EXCHANGE_EXIT",
        },
        accounting: closed,
      });
    await this.learner.recordClosedTrade(t, closed);
    // Queue durably before marking CLOSED: a DB/notification-queue failure
    // leaves the trade retryable, without keeping exchange protection alive.
    const result = closed.pnl > 0 ? "WIN" : "LOSS";
    await this.notify(
      `${t.symbol} ${t.side} ${result}: net ${closed.pnl.toFixed(4)} USDT | R=${(closed.pnl / actualRisk).toFixed(3)}`,
      { eventKey: `CLOSED:${t.signalKey}` },
    );
    t.accountingPending = false;
    t.state = "CLOSED";
    t.result = closed.pnl > 0 ? "WIN" : "LOSS";
    Object.assign(t, {
      pnl: closed.pnl,
      grossRealizedPnl: closed.grossRealizedPnl,
      feesUSDT: closed.feesUSDT,
      fundingUSDT: closed.fundingUSDT,
      closedAt: closed.closedAt,
      realizedR: closed.pnl / actualRisk,
    });
    await this.persist(t);
    await this.claims.updateOne(
      { signalKey: t.signalKey },
      { $set: { closedAt: new Date(closed.closedAt) } },
    );
    this.active.delete(t.signalKey);
    return true;
  }
  async maintenance() {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      for (const t of [...this.active.values()]) {
        if (t.opening || !t.entryExecution) continue;
        try {
          await this.queueEntryNotification(t);
          if (t.protectionCleanupConfirmed) {
            await this.finish(t);
          } else if (this.now() - (t.lastExcursionAt || 0) >= 60000) {
            await this.excursions(t);
            t.lastExcursionAt = this.now();
            await this.persist(t);
          }
        } catch (e) {
          // Optional bookkeeping never decides whether live exposure is safe.
          console.error("TRADE BOOKKEEPING PENDING", t.symbol, e.message);
        }
      }
    } finally {
      this.maintenanceRunning = false;
    }
  }
  async tick({ runMaintenance = true } = {}) {
    if (this.running) return;
    this.running = true;
    try {
      this.uncertain = false;
      try {
        await this.recoverClaims();
      } catch (e) {
        this.uncertain = true;
        console.error("CLAIM RECOVERY", e.message);
      }
      const positions = await this.exchange.positions();
      const known = new Set([...this.active.values()].map((t) => t.symbol));
      this.untracked = new Set(
        positions.filter((p) => !known.has(p.symbol)).map((p) => p.symbol),
      );
      const untrackedKey = [...this.untracked].sort().join(", ");
      if (untrackedKey && untrackedKey !== this.lastUntrackedKey)
        await this.alert(
          "Untracked positions require protection/reconciliation: " +
            untrackedKey,
        );
      this.lastUntrackedKey = untrackedKey;
      let algos = null;
      try {
        algos = await this.exchange.openAlgos();
        await this.cleanupOrphanAlgos(positions, algos);
      } catch (e) {
        this.uncertain = true;
        console.error("PROTECTION QUERY", e.message);
      }
      // Clear every confirmed-flat symbol before any slow accounting request
      // for another trade can delay sibling cancellation.
      for (const t of [...this.active.values()]) {
        if (t.opening || !t.entryExecution ||
            positions.some((p) => p.symbol === t.symbol)) continue;
        try {
          await this.cleanupFlatTrade(t);
        } catch (e) {
          this.uncertain = true;
          console.error("PROTECTION CLEANUP", t.symbol, e.message);
        }
      }
      for (const t of [...this.active.values()]) {
        if (t.opening) continue;
        const pos = positions.find((p) => p.symbol === t.symbol);
        try {
          if (t.state === "ENTRY_UNKNOWN" || !t.entryExecution) {
            if (!(await this.resolveEntry(t))) continue;
            await this.persist(t);
          }
          if (!pos) {
            await this.cleanupFlatTrade(t);
            continue;
          }
          if (
            (Number(pos.positionAmt) > 0 ? "LONG" : "SHORT") !== t.side ||
            Math.abs(Number(pos.positionAmt)) > t.actualQuantity * (1 + 1e-7)
          ) {
            this.uncertain = true;
            await this.alert(
              `Unexpected exposure change: ${t.symbol}; entries paused.`,
            );
            continue;
          }
          this.observe(t, Number(pos.markPrice));
          const deadline = Number(
            t.deadlineAt || Number(t.enteredAt) + TIMEOUT_MS,
          );
          if (this.now() + (this.exchange.offset || 0) >= deadline) {
            await this.close(t, "TIMEOUT_24_4H_BARS");
            continue;
          }
          if (!fillRiskValid(t)) {
            await this.close(t, "POST_FILL_RISK_OR_GEOMETRY");
            continue;
          }
          if (t.state === "CLOSING") {
            await this.close(t, t.exitReason);
            continue;
          }
          if (algos) {
            try {
              await this.ensureProtection(t, algos, pos);
            } catch (e) {
              console.error("PROTECTION", t.symbol, e.message);
              await this.close(t, "PROTECTION_RECOVERY_FAILED");
              continue;
            }
          }
        } catch (e) {
          // An accounting outage after verified cleanup must not masquerade
          // as uncertain live exposure and pause every other symbol.
          if (pos || !t.protectionCleanupConfirmed) this.uncertain = true;
          console.error(
            pos || !t.protectionCleanupConfirmed
              ? "POSITION MANAGEMENT" : "CLOSED TRADE ACCOUNTING PENDING",
            t.symbol, e.message,
          );
          if (pos && !t.entryExecution) {
            try {
              await this.close(t, "UNCONFIRMED_ENTRY_FILL");
            } catch (closeError) {
              console.error("EMERGENCY CLOSE", t.symbol, closeError.message);
            }
          }
        }
      }
      if (runMaintenance) await this.maintenance();
    } catch (e) {
      this.uncertain = true;
      console.error("POSITION SNAPSHOT", e.message);
    } finally {
      this.running = false;
    }
  }
}
module.exports = {
  TIMEOUT_MS,
  newTrade,
  hydrateFill,
  fillRiskValid,
  TradeLifecycle,
};
