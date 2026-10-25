"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, memoryDb } = require("./test-fixtures.cjs");
const { analyzeNineAI } = require("./nine-ai-pipeline");
const { newTrade, TradeLifecycle, TIMEOUT_MS } = require("./trade-lifecycle");
const { createOfflineLearning } = require("./nine-ai-offline-learning");

function harness({ initial = false, shared = false, side = "LONG" } = {}) {
  let now = Date.now(),
    qty = 0,
    sequence = 1;
  const f = fixture(side, now),
    d = analyzeNineAI({
      ...f,
      outcomes: initial ? [] : shared
        ? Array.from({ length: 100 }, (_, i) => ({
            ...f.outcomes[0], tradeId: "shared-" + i, maePct: 0.5, mfePct: 3,
          }))
        : f.outcomes,
    });
  d.nineAiDecisionKey = "decision";
  const rules = {
    step: 0.1,
    tick: 0.01,
    minQty: 0.1,
    maxQty: 10000,
    minNotional: 5,
  };
  const sizing = {
    quantity: 2,
    tp1Quantity: 1.2,
    tp2Quantity: 0.8,
    sl: d.sl,
    tp1: d.tp1,
    tp2: d.tp2,
    risk: 2 * Math.abs(d.entry - d.sl),
    initialRisk: Math.abs(d.entry - d.sl),
    rules,
  };
  const trade = newTrade(d, sizing, now),
    db = memoryDb(),
    orders = new Map(),
    algos = new Map(),
    fills = [],
    calls = [];
  const exchange = {
    entryPrice: d.entry,
    async positions() {
      return qty
        ? [
            {
              symbol: d.symbol,
              positionAmt: String(qty),
              entryPrice: String(this.entryPrice),
              markPrice: String(this.entryPrice),
            },
          ]
        : [];
    },
    async openOrders() {
      return [];
    },
    async cancelAlgos() {
      calls.push("cancel");
      for (const a of algos.values())
        if (a.algoStatus === "NEW") a.algoStatus = "CANCELED";
    },
    async cancelAlgo(_, algoId) {
      const a = [...algos.values()].find((a) => a.algoId === algoId);
      if (a) a.algoStatus = "CANCELED";
    },
    async openAlgos() {
      return [...algos.values()].filter((a) => a.algoStatus === "NEW");
    },
    async order(_, id) {
      const o = orders.get(id);
      if (!o) {
        const e = new Error("not found");
        e.code = -2013;
        throw e;
      }
      return { ...o };
    },
    async market(t, cid, reduceOnly, amount = t.quantity) {
      calls.push(reduceOnly ? "close" : "entry");
      const price = this.entryPrice,
        id = sequence++;
      qty = reduceOnly ? 0 : (side === "LONG" ? amount : -amount);
      const o = {
        orderId: id,
        status: "FILLED",
        executedQty: String(amount),
        avgPrice: String(price),
        updateTime: now,
        clientOrderId: cid,
      };
      orders.set(cid, o);
      fills.push({
        id,
        orderId: id,
        symbol: t.symbol,
        time: now,
        side: (side === "LONG") !== !!reduceOnly ? "BUY" : "SELL",
        qty: String(amount),
        price: String(price),
        commission: ".01",
        commissionAsset: "USDT",
        realizedPnl: reduceOnly ? String((price - trade.entry) * amount * (side === "LONG" ? 1 : -1)) : "0",
      });
      return o;
    },
    async protection(t, kind, cid) {
      calls.push(kind);
      const a = {
        algoId: sequence++,
        clientAlgoId: cid,
        symbol: t.symbol,
        side: side === "LONG" ? "SELL" : "BUY",
        orderType: kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
        triggerPrice: t[kind],
        quantity: kind === "tp1" ? t.tp1Quantity : kind === "tp2" ? t.tp2Quantity : 0,
        reduceOnly: kind !== "sl",
        closePosition: kind === "sl",
        algoStatus: "NEW",
        kind,
      };
      algos.set(cid, a);
      return a;
    },
    async algo(_, cid) {
      const a = algos.get(cid);
      if (!a) {
        const e = new Error("not found");
        e.code = -2013;
        throw e;
      }
      return a;
    },
    async algoById(_, algoId) {
      return [...algos.values()].find(
        (a) => String(a.algoId) === String(algoId),
      );
    },
    async request(_, p) {
      return orders.get(String(p.orderId));
    },
    async fills() {
      return structuredClone(fills);
    },
    async funding() {
      return [];
    },
    async convertFees() {},
    async candles() {
      return [];
    },
    async info() {
      return { filters: [] };
    },
    trigger(kind) {
      const a = [...algos.values()].find(
        (a) => a.kind === kind && a.algoStatus === "NEW",
      );
      assert.ok(a);
      const amount = kind === "tp1" ? trade.tp1Quantity :
        kind === "tp2" ? trade.tp2Quantity : Math.abs(qty);
      qty -= amount * (side === "LONG" ? 1 : -1);
      if (Math.abs(qty) < 1e-9) qty = 0;
      const orderId = sequence++;
      a.algoStatus = "FINISHED";
      a.actualOrderId = String(orderId);
      orders.set(String(orderId), {
        orderId,
        status: "FILLED",
        executedQty: String(amount),
      });
      fills.push({
        id: orderId,
        orderId,
        symbol: trade.symbol,
        time: ++now,
        side: side === "LONG" ? "SELL" : "BUY",
        qty: String(amount),
        price: String(a.triggerPrice),
        commission: ".01",
        commissionAsset: "USDT",
        realizedPnl: String((a.triggerPrice - trade.entry) * amount * (side === "LONG" ? 1 : -1)),
      });
    },
  };
  const journal = {
      actuals: [],
      async recordActualOutcome(o) {
        this.actuals.push(o);
      },
    },
    learner = createOfflineLearning(db);
  const create = (options = {}) =>
    new TradeLifecycle({
      exchange,
      db,
      journal,
      learner,
      notify: async () => {},
      now: () => now,
      wait: async () => {},
      ...options,
    });
  return {
    trade,
    db,
    exchange,
    calls,
    algos,
    fills,
    journal,
    create,
    advance: (ms) => {
      now += ms;
    },
  };
}
test("initial AI-2 plans do not add a two-position strategy veto", async () => {
  const h = harness({ initial: true }),
    l = h.create();
  await l.initialize();
  l.active.set("one", { tradePlan: { outcomeMode: "AI2_INITIAL" } });
  l.active.set("two", { tradePlan: { outcomeMode: "AI2_INITIAL" } });
  assert.equal(await l.enter(h.trade), true);
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
});

test("empty database -> AI-2 initial trade -> restart -> close -> first real label -> AI-7", async () => {
  const h = harness({ initial: true });
  assert.equal(h.trade.tradePlan.outcomeMode, "AI2_INITIAL");
  let l = h.create();
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  l = h.create();
  await l.initialize();
  await l.tick();
  h.exchange.entryPrice = h.trade.entry - 0.5;
  await l.tick();
  h.exchange.entryPrice = h.trade.entry;
  h.exchange.trigger("tp1");
  await l.tick();
  h.exchange.trigger("tp2");
  await l.tick();
  assert.equal(l.active.size, 0);
  const outcomes = await h.db
    .collection("nine_ai_outcome_labels")
    .find({ labeled: true })
    .toArray();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].entryOutcomeMode, "AI2_INITIAL");
  assert.equal(outcomes[0].win, true);
  const f = fixture("LONG", Math.max(Date.now(), outcomes[0].closedAt + 2000));
  const next = analyzeNineAI({ ...f, outcomes });
  assert.equal(next.action, "LONG");
  assert.equal(next.agents.outcome.enabled, false);
  assert.equal(next.tradePlan.outcomeMode, "AI2_INITIAL");
  const matured = [...f.outcomes.filter(o => o.setupKey === outcomes[0].setupKey)
    .slice(0, 99), outcomes[0]];
  const trained = analyzeNineAI({ ...f, outcomes: matured });
  assert.equal(trained.agents.outcome.enabled, true);
  assert.equal(trained.tradePlan.outcomeMode, "AI7_LABELED");
});

for (const first of ["tp1", "tp2"])
  test(
    "coincident quantile targets close separate halves and recover after " +
      first,
    async () => {
      const h = harness({ shared: true });
      let l = h.create();
      await l.initialize();
      assert.equal(await l.enter(h.trade), true);
      assert.equal(h.trade.tp1, h.trade.tp2);
      l = h.create();
      await l.initialize();
      await l.tick();
      const active = [...l.active.values()][0];
      assert.notEqual(active.protectionIds.tp1, active.protectionIds.tp2);
      const second = first === "tp1" ? "tp2" : "tp1";
      h.exchange.trigger(first);
      await l.tick();
      assert.equal(
        Math.abs(Number((await h.exchange.positions())[0].positionAmt)),
        first === "tp1" ? h.trade.tp2Quantity : h.trade.tp1Quantity,
      );
      const other = [...h.algos.values()].find(
        (a) => a.kind === second && a.algoStatus === "NEW",
      );
      other.algoStatus = "CANCELED";
      l = h.create();
      await l.initialize();
      await l.tick();
      assert.equal(h.calls.filter((c) => c === first).length, 1);
      assert.equal(h.calls.filter((c) => c === second).length, 2);
      h.exchange.trigger(second);
      await l.tick();
      assert.equal(l.active.size, 0);
      assert.equal(h.db.collection("nine_ai_outcome_labels").rows.length, 1);
      assert.equal(h.db.collection("nine_ai_actual_outcomes").rows.length, 1);
    },
  );

test("entry -> durable full plan -> restart -> TP1 -> restart -> TP2 -> complete accounting and labels", async () => {
  const h = harness();
  let l = h.create();
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  assert.deepEqual(
    h.calls.filter((c) => ["sl", "tp1", "tp2"].includes(c)),
    ["sl", "tp2", "tp1"],
  );
  const claim = await h.db
    .collection("trade_signal_claims")
    .findOne({ signalKey: h.trade.signalKey });
  assert.equal(
    claim.tradeSnapshot.plannedLevels.tp1,
    h.trade.plannedLevels.tp1,
  );
  l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  h.exchange.trigger("tp1");
  await l.tick();
  assert.equal([...l.active.values()][0].tp1Filled, true);
  l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  h.exchange.trigger("tp2");
  await l.tick();
  assert.equal(l.active.size, 0);
  const saved = await h.db
    .collection("trades")
    .findOne({ signalKey: h.trade.signalKey });
  assert.equal(saved.result, "WIN");
  assert.equal(saved.closedAccounting.accountingComplete, true);
  assert.equal(saved.closedAccounting.executionFillCount, 3);
  const actual = h.db.collection("nine_ai_actual_outcomes").rows[0];
  assert.equal(actual.realizedR, h.journal.actuals[0].realizedR);
  assert.equal(h.db.collection("nine_ai_outcome_labels").rows.length, 1);
});
test("missing MAE/MFE history stays pending and is labeled once the real interval is recovered", async () => {
  const h = harness({ initial: true }),
    l = h.create();
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  h.advance(120000);
  h.exchange.trigger("tp1");
  await l.tick();
  h.exchange.trigger("tp2");
  await l.tick();
  assert.equal(l.active.size, 1);
  assert.equal(h.db.collection("nine_ai_outcome_labels").rows.length, 0);
  h.exchange.candles = async (_, interval, limit, { startTime, endTime }) => {
    const rows = [];
    for (let at = startTime; at + 59999 <= endTime; at += 60000)
      rows.push([
        at,
        h.trade.entry,
        h.trade.entry + 1,
        h.trade.entry - 0.4,
        h.trade.entry + 0.1,
        100,
        at + 59999,
      ]);
    return rows;
  };
  await l.tick();
  assert.equal(l.active.size, 0);
  const labels = h.db.collection("nine_ai_outcome_labels").rows;
  assert.equal(labels.length, 1);
  assert.ok(labels[0].maePct > 0);
});
test("restart immediately after accepted MARKET recovers full TP1 plan from the claim", async () => {
  const h = harness(),
    t = h.trade;
  t.entryClientId = "accepted-entry";
  t.state = "ORDER_SUBMITTING";
  await h.db.collection("trade_signal_claims").insertOne({
    signalKey: t.signalKey,
    orderClientId: t.entryClientId,
    state: t.state,
    tradeSnapshot: t,
  });
  await h.exchange.market(t, t.entryClientId);
  const l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  assert.equal([...l.active.values()][0].state, "ACTIVE");
});
test("a canceled SL is repaired without canceling TP1/TP2 or changing the original plan", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  [...h.algos.values()].find((a) => a.kind === "sl").algoStatus = "CANCELED";
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "sl").length, 2);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp2").length, 1);
});
test("post-fill slippage beyond risk budget closes instead of accepting excess exposure", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  h.exchange.entryPrice += 10;
  assert.equal(await l.enter(h.trade), false);
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 0);
});
test("DB failure before MARKET prevents entry; DB failure after entry does not disable timeout", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  const claims = h.db.collection("trade_signal_claims");
  const original = claims.insertOne;
  claims.insertOne = async () => {
    throw new Error("DB down");
  };
  assert.equal(await l.enter(h.trade), false);
  assert.equal(h.calls.filter((c) => c === "entry").length, 0);
  claims.insertOne = original;
  await l.enter(h.trade);
  h.advance(TIMEOUT_MS + 1);
  claims.find = () => {
    throw new Error("DB down");
  };
  claims.updateOne = async () => {
    throw new Error("DB down");
  };
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
});
test("funding outage keeps reconciliation pending and retries without losing PnL", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("tp1");
  await l.tick();
  h.exchange.trigger("tp2");
  h.exchange.funding = async () => {
    throw new Error("funding history unavailable");
  };
  await l.tick();
  assert.equal(l.active.size, 1);
  assert.equal(h.db.collection("nine_ai_actual_outcomes").rows.length, 0);
  h.exchange.funding = async () => [];
  await l.tick();
  assert.equal(l.active.size, 0);
});
test("upgrade preserves an already-filled legacy TP1 and its original deadline", async () => {
  const h = harness();
  let l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  const collection = h.db.collection("trades"),
    saved = collection.rows[0],
    deadline = saved.deadlineAt;
  for (const kind of ["sl", "tp1", "tp2"])
    saved[kind + "OrderId"] = [...h.algos.values()].find(
      (a) => a.kind === kind,
    ).algoId;
  saved.protectionIds = {};
  saved.protectionAlgoIds = {};
  h.exchange.trigger("tp1");
  l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal([...l.active.values()][0].tp1Filled, true);
  assert.equal([...l.active.values()][0].deadlineAt, deadline);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  assert.equal(h.calls.filter((c) => c === "close").length, 0);
});
test("a consumed signal cannot submit a second entry after a fast exit", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("tp2");
  assert.equal(await l.enter(h.trade), false);
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
});

for (const side of ["LONG", "SHORT"]) {
  for (const exit of ["sl", "tp2"])
    for (const outage of ["fills", "funding", "convertFees", "database", "candles"])
      test(`${side} ${exit}: cleanup precedes ${outage} outage and survives restart`, async () => {
        const h = harness({ side });
        let l = h.create();
        await l.initialize();
        assert.equal(await l.enter(h.trade), true);
        if (outage === "candles") h.advance(180000);
        if (exit === "tp2") h.exchange.trigger("tp1");
        h.exchange.trigger(exit);
        if (outage === "database") {
          for (const name of ["trades", "trade_signal_claims", "nine_ai_outcome_labels"])
            h.db.collection(name).updateOne = async () => { throw new Error("DB down"); };
        } else if (outage !== "candles") {
          h.exchange[outage] = async () => { throw new Error("history unavailable"); };
        }
        // The process can restart after the exchange exit, before it sees the fill.
        l = h.create();
        await l.initialize();
        await l.tick();
        assert.equal((await h.exchange.positions()).length, 0);
        assert.equal((await h.exchange.openAlgos()).length, 0);
        assert.equal(l.active.size, 1, "accounting remains retryable");
        assert.equal(l.uncertain, false, "cleaned flat trade is not uncertain exposure");
        assert.equal(h.db.collection("nine_ai_outcome_labels").rows.length, 0);
      });

  test(`${side} TP1 realizes half and SL removes the remaining TP2`, async () => {
    const h = harness({ side }), l = h.create();
    await l.initialize();
    await l.enter(h.trade);
    h.exchange.trigger("tp1");
    await l.tick();
    assert.equal(Math.abs(Number((await h.exchange.positions())[0].positionAmt)),
      h.trade.tp2Quantity);
    assert.equal(h.fills[1].qty, String(h.trade.tp1Quantity));
    assert.ok(Number(h.fills[1].realizedPnl) > 0);
    assert.equal((await h.exchange.openAlgos()).length, 2);
    h.exchange.trigger("sl");
    await l.tick();
    assert.equal((await h.exchange.openAlgos()).length, 0);
    assert.equal(l.active.size, 0);
    assert.equal(h.db.collection("nine_ai_outcome_labels").rows.length, 1);
  });

  test(`${side} AI-2 keeps structure prices after a slipped entry`, async () => {
    const h = harness({ side, initial: true }), l = h.create();
    await l.initialize();
    h.exchange.entryPrice += side === "LONG" ? -0.01 : 0.01;
    assert.equal(await l.enter(h.trade), true);
    for (const kind of ["sl", "tp1", "tp2"])
      assert.ok(Math.abs(h.trade[kind] - h.trade.plannedLevels[kind]) <= h.trade.rules.tick);
  });
}

for (const first of ["tp1", "tp2"])
  test(`coincident targets recover ${first} before replacing a canceled sibling after restart`, async () => {
    const h = harness({ shared: true });
    let l = h.create();
    await l.initialize();
    await l.enter(h.trade);
    h.exchange.trigger(first);
    const other = first === "tp1" ? "tp2" : "tp1";
    [...h.algos.values()].find((a) => a.kind === other).algoStatus = "CANCELED";
    l = h.create();
    await l.initialize();
    await l.tick();
    assert.equal(h.calls.filter((c) => c === "close").length, 0);
    assert.equal(h.calls.filter((c) => c === first).length, 1);
    assert.equal(h.calls.filter((c) => c === other).length, 2);
    assert.equal(Math.abs(Number((await h.exchange.positions())[0].positionAmt)),
      first === "tp1" ? h.trade.tp2Quantity : h.trade.tp1Quantity);
  });

test("timeout clears protection immediately even if fills cannot be fetched", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.advance(TIMEOUT_MS + 1);
  h.exchange.fills = async () => { throw new Error("history unavailable"); };
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal((await h.exchange.openAlgos()).length, 0);
});

test("failed cleanup pauses entries and retries while preserving the pending trade", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("sl");
  const cancel = h.exchange.cancelAlgos;
  h.exchange.cancelAlgos = async () => { throw new Error("cancel unavailable"); };
  await l.tick();
  assert.equal(l.uncertain, true);
  assert.equal(l.active.size, 1);
  assert.ok((await h.exchange.openAlgos()).length > 0);
  h.exchange.cancelAlgos = cancel;
  await l.tick();
  assert.equal(l.uncertain, false);
  assert.equal(l.active.size, 0);
  assert.equal((await h.exchange.openAlgos()).length, 0);
});

test("flat cleanup cancels triggered bot children but preserves unrelated manual orders", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("sl");
  const pending = [
    { orderId: 900, clientOrderId: `n9_${h.trade.keyPrefix}_tp1_child` },
    { orderId: 901, clientOrderId: "manual-order" },
  ];
  h.exchange.openOrders = async () => pending;
  h.exchange.cancelOrder = async (_, orderId) => pending.splice(pending.findIndex((o) => o.orderId === orderId), 1);
  await l.tick();
  assert.deepEqual(pending.map((o) => o.orderId), [901]);
  assert.equal(l.active.size, 0);
});

test("startup removes orphan bot TP only on flat symbols, preserving manual and live protection", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.algos.set("orphan", { symbol: "FLATUSDT", algoId: 901, clientAlgoId: "n9_1234abcd_tp2_orphan", algoStatus: "NEW" });
  h.algos.set("manual", { symbol: "FLATUSDT", algoId: 902, clientAlgoId: "manual-tp", algoStatus: "NEW" });
  await l.tick();
  assert.equal(h.algos.get("orphan").algoStatus, "CANCELED");
  assert.equal(h.algos.get("manual").algoStatus, "NEW");
  assert.equal((await h.exchange.openAlgos()).filter((o) => o.symbol === h.trade.symbol).length, 3);
});

test("all flat trades have protection removed before the first accounting request", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("sl");
  const other = { ...h.trade, symbol: "OTHERUSDT", signalKey: "OTHER:1", protectionCleanupConfirmed: false };
  l.active.set(other.signalKey, other);
  const canceled = new Set(), cancel = h.exchange.cancelAlgos;
  h.exchange.cancelAlgos = async (symbol) => { canceled.add(symbol); await cancel(symbol); };
  h.exchange.fills = async () => {
    assert.deepEqual([...canceled].sort(), ["OTHERUSDT", h.trade.symbol].sort());
    return [];
  };
  await l.tick();
  assert.equal(l.active.size, 2);
  assert.equal(l.uncertain, false);
});

test("restart preserves a pending close instead of resurrecting ACTIVE protection", async () => {
  const h = harness();
  let l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.trade.state = "CLOSING";
  h.trade.exitReason = "PROTECTION_RECOVERY_FAILED";
  await l.persist(h.trade);
  l = h.create();
  await l.initialize();
  assert.equal([...l.active.values()][0].state, "CLOSING");
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal((await h.exchange.openAlgos()).length, 0);
});

test("cleanup refuses to cancel protection if fresh positions show exposure", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  const count = h.calls.filter((c) => c === "cancel").length;
  assert.equal(await l.cleanupFlatTrade(h.trade), false);
  assert.equal(h.calls.filter((c) => c === "cancel").length, count);
  assert.equal((await h.exchange.openAlgos()).length, 3);
});

test("fractional exchange offset is removed before persisting submittedAt", async () => {
  const h = harness(), l = h.create();
  h.exchange.offset = 0.5;
  await l.initialize();
  await l.enter(h.trade);
  assert.ok(Number.isSafeInteger(h.trade.submittedAt));
  const claim = await h.db.collection("trade_signal_claims").findOne({ signalKey: h.trade.signalKey });
  assert.ok(Number.isSafeInteger(claim.tradeSnapshot.submittedAt));
});

test("timeout compares exchange timestamps against the synchronized server clock", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.offset = 2000.5;
  h.advance(TIMEOUT_MS - 1000);
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
});

test("confirmed entries queue Telegram 1 once after protection, including after restart", async () => {
  const h = harness(), events = [];
  const notifyEntry = async (t) => {
    assert.equal((await h.exchange.openAlgos()).length, 3);
    events.push(t.signalKey);
  };
  let l = h.create({ notifyEntry });
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  assert.deepEqual(events, [h.trade.signalKey]);
  l = h.create({ notifyEntry });
  await l.initialize();
  await l.tick();
  assert.equal(events.length, 1);
});
test("entry notification queue failure cannot close a protected trade and retries after restart", async () => {
  const h = harness();
  let l = h.create({ notifyEntry: async () => { throw new Error("queue DB down"); } });
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  assert.equal(h.calls.filter((c) => c === "close").length, 0);
  const events = [];
  l = h.create({ notifyEntry: async (t) => events.push(t.signalKey) });
  await l.initialize();
  await l.tick();
  await l.tick();
  assert.deepEqual(events, [h.trade.signalKey]);
});
test("rejected/unsafe entries do not send a successful entry notification", async () => {
  const h = harness(), events = [], l = h.create({ notifyEntry: async (t) => events.push(t) });
  await l.initialize();
  h.exchange.entryPrice += 10;
  assert.equal(await l.enter(h.trade), false);
  await l.tick();
  assert.equal(events.length, 0);
});
test("a failed WIN/LOSS queue write remains retryable after protection is cleared", async () => {
  const h = harness(), l = h.create({ notify: async () => { throw new Error("queue unavailable"); } });
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("sl");
  await l.tick();
  assert.equal(l.active.size, 1);
  assert.equal(h.trade.result, "PENDING");
  assert.equal((await h.exchange.openAlgos()).length, 0);
  const events = [];
  l.notify = async (message, metadata) => events.push({ message, metadata });
  await l.tick();
  assert.equal(l.active.size, 0);
  assert.equal(events[0].metadata.eventKey, `CLOSED:${h.trade.signalKey}`);
  assert.match(events[0].message, /LOSS/);
});
test("production protection loop still executes timeout while candle history is blocked", { timeout: 3000 }, async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.advance(120000);
  let ready, release;
  const started = new Promise((resolve) => { ready = resolve; });
  h.exchange.candles = async () => {
    ready();
    return new Promise((resolve) => { release = () => resolve([]); });
  };
  const bookkeeping = l.maintenance();
  await started;
  h.advance(TIMEOUT_MS);
  await l.tick({ runMaintenance: false });
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal((await h.exchange.openAlgos()).length, 0);
  release();
  await bookkeeping;
});
test("alert queue failure cannot abort protection management for live positions", async () => {
  const h = harness(), l = h.create({ notify: async () => { throw new Error("outbox DB down"); } });
  await l.initialize();
  await l.enter(h.trade);
  const positions = h.exchange.positions.bind(h.exchange);
  h.exchange.positions = async () => [...await positions(), { symbol: "MANUALUSDT", positionAmt: "1" }];
  h.advance(TIMEOUT_MS + 1);
  await l.tick({ runMaintenance: false });
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal((await h.exchange.openAlgos()).length, 0);
});

test("a status-write outage does not close an already protected live position", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  const claims = h.db.collection("trade_signal_claims"), write = claims.updateOne;
  claims.updateOne = async () => { throw new Error("DB down"); };
  await l.tick({ runMaintenance: false });
  assert.equal(h.calls.filter((c) => c === "close").length, 0);
  assert.equal((await h.exchange.openAlgos()).length, 3);
  assert.equal(l.uncertain, true);
  claims.updateOne = write;
  await l.tick({ runMaintenance: false });
  assert.equal(l.uncertain, false);
});

test("concurrent background and protection writes cannot overwrite a newer CLOSING snapshot", async () => {
  const h = harness(), l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  const claims = h.db.collection("trade_signal_claims"), write = claims.updateOne;
  let release, ready, requests = 0, concurrent = 0, maximum = 0;
  const started = new Promise((resolve) => { ready = resolve; });
  claims.updateOne = async (...args) => {
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    if (++requests === 1) {
      ready();
      await new Promise((resolve) => { release = resolve; });
    }
    try { return await write(...args); } finally { concurrent--; }
  };
  const first = l.persist(h.trade);
  await started;
  h.trade.state = "CLOSING";
  const second = l.persist(h.trade);
  release();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal((await claims.findOne({ signalKey: h.trade.signalKey })).state, "CLOSING");
  assert.equal((await h.db.collection("trades").findOne({ signalKey: h.trade.signalKey })).state, "CLOSING");
  assert.equal(l.persistPending.size, 0);
});

test("real lifecycle integration delivers protected entry to Telegram 1 and SL result to Telegram 2", async () => {
  const { TelegramNotifications } = require("./telegram-notifications");
  const h = harness(), calls = [];
  const notifications = new TelegramNotifications({ db: h.db,
    env: { BOT_TOKEN: "fake-one", CHAT_ID: "one", BOT_TOKEN_2: "fake-two", AI_CHAT_ID: "two" },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await notifications.initialize();
  const l = h.create({ notifyEntry: (t) => notifications.entry(t),
    notify: (text, meta) => notifications.report(text, meta) });
  await l.initialize();
  await l.enter(h.trade);
  await notifications.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, "one");
  assert.match(calls[0].body.text, /MỞ LỆNH THÀNH CÔNG/);
  h.exchange.trigger("sl");
  await l.tick();
  await notifications.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.chat_id, "two");
  assert.match(calls[1].body.text, /LOSS/);
  assert.equal(l.active.size, 0);
  assert.equal((await h.exchange.openAlgos()).length, 0);
});

test("FILLED with missing average price queries the same entry before placing protection", async () => {
  const h = harness(), l = h.create(), market = h.exchange.market.bind(h.exchange);
  let queries = 0;
  const query = h.exchange.order.bind(h.exchange);
  h.exchange.market = async (...args) => {
    const order = await market(...args);
    return { ...order, avgPrice: "0", cumQuote: "0" };
  };
  h.exchange.order = async (...args) => { queries++; return query(...args); };
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  assert.equal(queries, 1);
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
  assert.equal((await h.exchange.openAlgos()).length, 3);
});

test("persistent incomplete order responses fall back to confirmed entry fill history", async () => {
  const h = harness(), l = h.create(), market = h.exchange.market.bind(h.exchange),
    query = h.exchange.order.bind(h.exchange);
  h.exchange.market = async (...args) => ({ ...await market(...args), avgPrice: "0", cumQuote: "0" });
  h.exchange.order = async (...args) => ({ ...await query(...args), avgPrice: "0", cumQuote: "0" });
  let lookups = 0;
  h.exchange.entryFill = async (t, order) => {
    lookups++;
    return { ...order, avgPrice: String(h.exchange.entryPrice), fillSource: "CONFIRMED_ORDER_TRADE_HISTORY" };
  };
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  assert.equal(lookups, 1);
  assert.equal(h.trade.entryExecution.fillSource, "CONFIRMED_ORDER_TRADE_HISTORY");
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
});

test("unconfirmed accepted fill pauses further entries, closes actual exposure and later reconciles once", async () => {
  const h = harness(), l = h.create(), market = h.exchange.market.bind(h.exchange),
    query = h.exchange.order.bind(h.exchange);
  h.exchange.market = async (...args) => {
    const order = await market(...args);
    return args[2] ? order : { ...order, avgPrice: "0", cumQuote: "0" };
  };
  h.exchange.order = async (...args) => {
    const order = await query(...args);
    return args[1] === h.trade.entryClientId ? { ...order, avgPrice: "0", cumQuote: "0" } : order;
  };
  h.exchange.entryFill = async () => { throw new Error("ENTRY_FILL_HISTORY_INCOMPLETE"); };
  await l.initialize();
  assert.equal(await l.enter(h.trade), false);
  assert.equal(l.uncertain, true);
  assert.equal(l.active.size, 1);
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal((await h.exchange.positions()).length, 0);
  assert.equal(await l.enter({ ...h.trade, signalKey: "another" }), false);
  h.exchange.order = query;
  await l.tick();
  assert.equal(l.active.size, 0);
  assert.equal(h.db.collection("nine_ai_outcome_labels").rows.length, 1);
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
});

test("a claim-only uncertain entry stays managed even when recovery lacks fill details", async () => {
  const h = harness(), t = h.trade;
  t.entryClientId = "claim-only";
  t.state = "ORDER_SUBMITTING";
  await h.db.collection("trade_signal_claims").insertOne({ signalKey: t.signalKey,
    orderClientId: t.entryClientId, state: t.state, tradeSnapshot: t });
  await h.exchange.market(t, t.entryClientId);
  const query = h.exchange.order.bind(h.exchange);
  h.exchange.order = async (...args) => ({ ...await query(...args), avgPrice: "0", cumQuote: "0" });
  const l = h.create();
  await l.initialize();
  assert.equal(l.active.size, 1);
  assert.equal(l.uncertain, true);
  await l.tick({ runMaintenance: false });
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
});

test("entry waits while an unrelated conditional order remains on the symbol", async () => {
  const h = harness();
  h.exchange.openAlgos = async () => [
    { symbol: h.trade.symbol, algoId: 77, clientAlgoId: "manual-stop" },
  ];
  assert.equal(await h.lifecycle.enter(h.trade), false);
  assert.equal(h.calls.includes("entry"), false);
});
