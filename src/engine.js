"use strict";
const { evaluateClosedCandle } = require("./strategy");
const { atr } = require("./indicators");
const { calculateMargin, calculateRawQuantity } = require("./risk");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number(v || 0);
function timeframeMs(value) {
  const m = /^(\d+)([mhdw])$/.exec(value);
  if (!m) throw new Error("Unsupported timeframe " + value);
  return Number(m[1]) * ({m:60000,h:3600000,d:86400000,w:604800000}[m[2]]);
}
class TradingEngine {
  constructor(config, exchange, store, alerts) {
    this.c = config; this.x = exchange; this.db = store; this.alerts = alerts;
    this.running = false; this.universe = []; this.lastScan = 0; this.lastScanFailedAt = 0;
    this.lastCandle = new Map(); this.lastSignalCheckAt = 0; this.lastManageAt = 0;
  }
  log(...args) { if (this.c.app.logLevel !== "silent") console.log(new Date().toISOString(), ...args); }
  async replaceStopLoss(symbol, side, triggerPrice, fallbackPrice, currentSlId) {
    const exitSide = side === "LONG" ? "SELL" : "BUY";
    const priceProtect = String(Boolean(this.c.execution.priceProtect)).toLowerCase();
    const isOurStop = order => order && order.orderType === "STOP_MARKET"
      && order.algoStatus === "NEW" && order.side === exitSide && order.closePosition === true;
    const listActiveStops = async () => (await this.x.openAlgoOrders(symbol)).filter(isOurStop);
    const samePrice = (a, b) => Math.abs(num(a) - num(b)) <= this.x.filters.get(symbol).tickSize / 2;

    let activeStops = await listActiveStops();
    if (!activeStops.length && currentSlId) {
      const known = await this.x.algoOrder(currentSlId).catch(() => null);
      if (isOurStop(known)) activeStops = [known];
    }

    const alreadyAtTarget = activeStops.find(order => samePrice(order.triggerPrice, triggerPrice));
    const toCancel = activeStops.filter(order => !alreadyAtTarget || String(order.algoId) !== String(alreadyAtTarget.algoId));
    for (const old of toCancel) {
      try {
        await this.x.cancelAlgoOrder(old.algoId);
      } catch (cancelError) {
        const stillActive = (await listActiveStops()).some(order => String(order.algoId) === String(old.algoId));
        if (stillActive) throw new Error("Could not cancel old SL " + old.algoId + ": " + cancelError.message);
      }
    }

    // A cancel acknowledgement is not enough: confirm Binance no longer lists the old SL.
    if (toCancel.length) {
      let remaining = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await listActiveStops();
        const canceledIds = new Set(toCancel.map(order => String(order.algoId)));
        remaining = current.filter(order => canceledIds.has(String(order.algoId)));
        if (!remaining.length) break;
        await sleep(250);
      }
      if (remaining.length) throw new Error("Old SL cancellation was not confirmed; keeping existing protection");
    }

    if (alreadyAtTarget) return { order: alreadyAtTarget, restored: false };

    const placeAndConfirm = async price => {
      const placed = await this.x.newAlgoOrder({
        symbol, side: exitSide, type: "STOP_MARKET", triggerPrice: price,
        closePosition: "true", workingType: this.c.binance.workingType, priceProtect
      });
      if (!placed?.algoId) throw new Error("Binance did not return algoId for replacement SL");
      for (let attempt = 0; attempt < 4; attempt++) {
        const active = await listActiveStops();
        const found = active.find(order => String(order.algoId) === String(placed.algoId));
        if (found) return found;
        const queried = await this.x.algoOrder(placed.algoId).catch(() => null);
        if (isOurStop(queried)) return queried;
        if (queried && queried.algoStatus && queried.algoStatus !== "NEW") {
          throw new Error("Replacement SL is not active: " + queried.algoStatus);
        }
        await sleep(250);
      }
      throw new Error("Replacement SL was submitted but could not be confirmed active");
    };

    try {
      return { order: await placeAndConfirm(triggerPrice), restored: false };
    } catch (moveError) {
      // The POST may have succeeded even if its confirmation request timed out.
      // Check for the requested stop before attempting to restore the old level.
      const afterMoveError = await listActiveStops().catch(() => []);
      const targetNowActive = afterMoveError.find(order => samePrice(order.triggerPrice, triggerPrice));
      if (targetNowActive) return { order: targetNowActive, restored: false };

      // Restore the previous protective level if the requested move failed.
      const fallback = num(fallbackPrice) || num(toCancel[0]?.triggerPrice);
      if (fallback > 0) {
        try {
          const fallbackExists = afterMoveError.find(order => samePrice(order.triggerPrice, fallback));
          const restoredOrder = fallbackExists || await placeAndConfirm(fallback);
          return { order: restoredOrder, restored: true, error: moveError };
        } catch (restoreError) {
          this.log("[sl-restore-failed]", symbol, restoreError.message);
        }
      }

      // Never leave a live position deliberately unprotected if both replacement and restore fail.
      const live = (await this.x.positions()).find(position => position.symbol === symbol);
      const liveQty = Math.abs(num(live?.positionAmt));
      if (liveQty > 0) {
        await this.x.newOrder({
          symbol, side: exitSide, type: "MARKET",
          quantity: this.x.quantity(symbol, liveQty, true), reduceOnly: "true"
        }).catch(closeError => this.log("[sl-emergency-close-failed]", symbol, closeError.message));
      }
      throw new Error("Could not install replacement or restore previous SL; emergency close attempted: " + moveError.message);
    }
  }
  async start() {
    await this.x.exchangeInfo(); await this.x.assertOneWayMode();
    if (this.c.app.startupReconcile) await this.reconcile();
    const cached = await this.db.getScanner();
    if (cached?.symbols?.length) this.universe = cached.symbols;
    this.running = true;
    if (this.c.telegram.sendStartupMessage) {
      try {
        await this.alerts.startup("🤖 Futures bot started\nUniverse: " + this.universe.length + " coins\nMode: LIVE");
      } catch (e) {
        this.log("[startup-alert-error]", e.message);
      }
    }
    while (this.running) {
      await this.runCycle();
      await sleep(this.c.app.loopIntervalMs);
    }
  }
  async runCycle() {
    const now = Date.now();
    const scanDue = !this.lastScan || now - this.lastScan >= this.c.scanner.intervalMinutes * 60000;
    const scanRetryMs = Math.max(10, num(this.c.scanner.errorRetrySeconds) || 60) * 1000;
    const scanRetryReady = !this.lastScanFailedAt || now - this.lastScanFailedAt >= scanRetryMs;
    if (scanDue && scanRetryReady) {
      try {
        await this.scan();
        this.lastScanFailedAt = 0;
      } catch (e) {
        this.lastScanFailedAt = Date.now();
        this.log("[scanner-error]", e.message);
      }
    }

    if (Date.now() - this.lastManageAt >= this.c.execution.orderPollIntervalMs) {
      try {
        await this.managePositions();
        this.lastManageAt = Date.now();
      } catch (e) {
        this.log("[manage-loop-error]", e.message);
      }
      // Reconcile Binance positions periodically, not only at startup. This catches
      // late fills and positions left untracked after an ambiguous network response.
      try {
        await this.reconcile();
      } catch (e) {
        this.log("[reconcile-loop-error]", e.message);
      }
    }

    try {
      await this.checkSignals();
    } catch (e) {
      this.log("[signal-loop-error]", e.message);
    }
  }
  async stop() { this.running = false; }
  async scan() {
    const tickers = await this.x.ticker24hr(), excluded = new Set(this.c.scanner.excludeSymbols || []);
    const ranked = tickers.filter(t => {
      const f = this.x.filters.get(t.symbol);
      return f && t.symbol.endsWith(this.c.scanner.quoteAsset) && !excluded.has(t.symbol)
        && num(t.quoteVolume) >= this.c.scanner.minQuoteVolume
        && Math.abs(num(t.priceChangePercent)) >= this.c.scanner.minAbsPriceChangePct;
    }).sort((a, b) => Math.abs(num(b.priceChangePercent)) - Math.abs(num(a.priceChangePercent)))
      .slice(0, this.c.scanner.maxCoins).map(t => t.symbol);
    this.universe = ranked; await this.db.saveScanner(ranked); this.lastScan = Date.now();
    this.log("[scanner]", ranked.length, "symbols selected");
  }
  async candles(symbol, interval, limit) {
    const rows = await this.x.klines(symbol, interval, limit), now = Date.now();
    return rows.filter(k => Number(k[6]) < now).map(k => ({
      openTime: Number(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]),
      close: num(k[4]), volume: num(k[5]), closeTime: Number(k[6])
    }));
  }
  async checkSignals() {
    const signalCheckIntervalMs = this.c.strategy.signalCheckIntervalSeconds * 1000;
    const now = Date.now();
    if (now - this.lastSignalCheckAt < signalCheckIntervalMs) return;
    this.lastSignalCheckAt = now;
    const exchangePositions = await this.x.positions();
    const active = new Set(exchangePositions.filter(p => Math.abs(num(p.positionAmt)) > 0).map(p => p.symbol));
    this.log("[signal-check-start]", "universe", this.universe.length, "exchangePositions", active.size, "intervalSeconds", this.c.strategy.signalCheckIntervalSeconds);
    const batchSize = Math.max(1, Math.floor(num(this.c.scanner.batchSize) || 10));
    const batchDelayMs = Math.max(0, num(this.c.scanner.batchDelayMs));
    const batchCount = Math.ceil(this.universe.length / batchSize);
    for (let offset = 0; offset < this.universe.length; offset += batchSize) {
      if (!this.running) break;
      const batch = this.universe.slice(offset, offset + batchSize);
      const batchNumber = Math.floor(offset / batchSize) + 1;
      this.log("[signals] batch", batchNumber + "/" + batchCount, "processing", batch.length, "coins");
      for (const symbol of batch) {
        if (!this.running) break;
      try {
        if (active.has(symbol)) continue;
        if (await this.db.getPosition(symbol)) continue;
        const [trendCandles, entryCandles] = await Promise.all([
          this.candles(symbol, this.c.strategy.trendTimeframe, this.c.strategy.historyCandles),
          this.candles(symbol, this.c.strategy.entryTimeframe, this.c.strategy.historyCandles)
        ]);
        if (!entryCandles.length) continue;
        const latest = entryCandles[entryCandles.length - 1];
        if (this.lastCandle.get(symbol) === latest.closeTime) continue;
        const setup = await this.db.getSetup(symbol);
        const result = evaluateClosedCandle({ trendCandles, entryCandles, setup, config: this.c });
        if (result.action === "ARM") {
          await this.db.saveSetup(symbol, result.setup);
          this.lastCandle.set(symbol, latest.closeTime);
        } else if (result.action === "CANCEL") {
          await this.db.deleteSetup(symbol);
          this.lastCandle.set(symbol, latest.closeTime);
        } else if (result.action === "KEEP") {
          await this.db.saveSetup(symbol, result.setup);
          this.lastCandle.set(symbol, latest.closeTime);
        } else if (result.action === "ENTRY") {
          // Mark before order submission to prevent duplicate MARKET orders after an uncertain response.
          this.lastCandle.set(symbol, latest.closeTime);
          const opened = await this.openTrade(symbol, result);
          if (opened) {
            await this.db.deleteSetup(symbol);
            active.add(symbol);
          }
        } else {
          this.lastCandle.set(symbol, latest.closeTime);
        }
        } catch (e) {
          if (e.retrySignalCandle) this.lastCandle.delete(symbol);
          const rejected = String(e.message || "").startsWith("ENTRY_REJECTED_");
          this.log(rejected ? "[entry-rejected]" : "[signal-error]", symbol,
            "message", e.message, "code", e.code ?? "-", "status", e.status ?? "-", "stack", e.stack || "-");
        }
      }
      if (this.running && offset + batchSize < this.universe.length && batchDelayMs > 0) {
        await sleep(batchDelayMs);
      }
    }
  }
  async openTrade(symbol, signal) {
    const [exchangePositions, open, existing] = await Promise.all([
      this.x.positions(),
      this.db.getOpenPositions(),
      this.db.getPosition(symbol)
    ]).catch(error => {
      if (!error.status || error.status === 418 || error.status === 429 || error.status >= 500) error.retrySignalCandle = true;
      throw error;
    });
    if (existing) {
      this.log("[entry-skip]", symbol, "reason", "DATABASE_POSITION_EXISTS");
      return false;
    }
    if (exchangePositions.some(p => p.symbol === symbol && Math.abs(num(p.positionAmt)) > 0)) {
      this.log("[entry-skip]", symbol, "reason", "BINANCE_POSITION_EXISTS");
      return false;
    }

    // Count the union of exchange and database positions so stale/missing DB records
    // cannot allow the bot to exceed the configured account-wide position cap.
    const openSymbols = new Set(open.map(p => p.symbol));
    for (const p of exchangePositions) {
      if (Math.abs(num(p.positionAmt)) > 0) openSymbols.add(p.symbol);
    }
    const maxActivePositions = Math.max(1, Math.floor(num(this.c.risk.maxActivePositions) || 20));
    if (openSymbols.size >= maxActivePositions) {
      this.log("[entry-skip]", symbol, "reason", "MAX_ACTIVE_POSITIONS", openSymbols.size + "/" + maxActivePositions);
      return false;
    }

    const account = await this.x.account().catch(error => {
      if (!error.status || error.status === 418 || error.status === 429 || error.status >= 500) error.retrySignalCandle = true;
      throw error;
    });
    const wallet = num(account.totalWalletBalance);
    if (!(wallet > 0)) throw new Error("ENTRY_REJECTED_INVALID_WALLET_BALANCE");
    const availableBalance = Number(account.availableBalance);
    if (!Number.isFinite(availableBalance) || availableBalance < 0) {
      throw new Error("ENTRY_REJECTED_INVALID_AVAILABLE_BALANCE");
    }
    const margin = calculateMargin(wallet, this.c.risk);
    const leverage = Number(this.c.binance.leverage);
    const marketQty = this.x.quantity(symbol, calculateRawQuantity(margin, leverage, signal.entry), true);
    const filters = this.x.filters.get(symbol);
    if (!filters) throw new Error("ENTRY_REJECTED_MISSING_EXCHANGE_FILTERS");
    const notional = marketQty * signal.entry;
    if (notional < filters.minNotional) throw new Error("ENTRY_REJECTED_MIN_NOTIONAL");
    const requiredMargin = notional / leverage;
    if (requiredMargin > availableBalance) {
      throw new Error("ENTRY_REJECTED_INSUFFICIENT_AVAILABLE_BALANCE: required " +
        requiredMargin.toFixed(8) + " USDT, available " + availableBalance.toFixed(8) + " USDT");
    }
    if (!(signal.side === "LONG" ? signal.stop < signal.entry : signal.stop > signal.entry)) throw new Error("Stop is on the wrong side of entry");

    // Validate the planned TP1 split before sending a live MARKET order. The same checks
    // are repeated against the actual fill below because fill price/quantity can differ.
    const plannedDirection = signal.side === "LONG" ? 1 : -1;
    const plannedRisk = Math.abs(signal.entry - signal.stop);
    const plannedTp1 = signal.entry + plannedDirection * plannedRisk * this.c.strategy.rewardRiskTp1;
    const plannedTp1Price = this.x.price(symbol, plannedTp1, signal.side === "LONG" ? "UP" : "DOWN");
    const plannedTp1Qty = this.x.quantity(symbol, marketQty * this.c.strategy.tp1ClosePct / 100, false);
    if (plannedTp1Qty * plannedTp1Price < filters.minNotional) {
      throw new Error("TP1 partial quantity is below Binance minNotional; entry skipped before MARKET order");
    }

    try {
      const bracketResponse = await this.x.leverageBracket(symbol);
      const symbolBracket = Array.isArray(bracketResponse)
        ? bracketResponse.find(item => item.symbol === symbol) || bracketResponse[0]
        : bracketResponse;
      const brackets = Array.isArray(symbolBracket?.brackets) ? symbolBracket.brackets : [];
      if (brackets.length) {
        const selected = brackets.find(item => notional <= num(item.notionalCap)
          && notional > num(item.notionalFloor));
        if (!selected) {
          throw new Error("ENTRY_REJECTED_NOTIONAL_BRACKET: " + notional.toFixed(4) + " USDT exceeds Binance symbol limits");
        }
        const maxLeverage = num(selected.initialLeverage);
        if (maxLeverage > 0 && leverage > maxLeverage) {
          throw new Error("ENTRY_REJECTED_LEVERAGE_LIMIT: configured " + leverage +
            "x, Binance allows " + maxLeverage + "x for " + notional.toFixed(4) + " USDT notional");
        }
      } else {
        throw new Error("ENTRY_REJECTED_LEVERAGE_BRACKET_UNAVAILABLE");
      }
      await this.x.setMarginType(symbol, this.c.binance.marginType);
      await this.x.setLeverage(symbol, leverage);
    } catch (error) {
      // These requests happen before MARKET submission, so transient failures are safe to retry.
      const rejected = String(error.message || "").startsWith("ENTRY_REJECTED_");
      if (!rejected && (!error.status || error.status === 418 || error.status === 429 || error.status >= 500)) {
        error.retrySignalCandle = true;
      }
      throw error;
    }
    const side = signal.side === "LONG" ? "BUY" : "SELL";
    const exitSide = side === "BUY" ? "SELL" : "BUY";
    const entryClientOrderId = "E" + require("node:crypto").randomBytes(11).toString("hex");
    let entryOrder;
    let protectionIds = [];
    let positionPersisted = false;
    try {
      try {
        entryOrder = await this.x.newOrder({ symbol, side, type: "MARKET", quantity: marketQty, newClientOrderId: entryClientOrderId, newOrderRespType: "RESULT" });
      } catch (error) {
        // A timed-out POST may still have reached Binance. Reconcile by the unique
        // client order ID and live position before deciding whether the entry exists.
        let lookupError = null;
        let livePosition = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            entryOrder = await this.x.order(symbol, undefined, entryClientOrderId);
            if (entryOrder) break;
          } catch (queryError) {
            lookupError = queryError;
          }
          try {
            livePosition = (await this.x.positions()).find(p => p.symbol === symbol
              && Math.abs(num(p.positionAmt)) > 0);
            if (livePosition) break;
          } catch (positionError) {
            lookupError = positionError;
          }
          if (attempt < 3) await sleep(500);
        }
        if (!entryOrder && livePosition) {
          const expectedSign = signal.side === "LONG" ? 1 : -1;
          if (Math.sign(num(livePosition.positionAmt)) === expectedSign) {
            entryOrder = {
              status: "FILLED",
              avgPrice: livePosition.entryPrice,
              executedQty: Math.abs(num(livePosition.positionAmt)),
              clientOrderId: entryClientOrderId
            };
          }
        }
        if (!entryOrder) {
          const uncertain = new Error("Entry response uncertain; no automatic MARKET retry was sent to prevent duplicates. Check Binance order history for " +
            entryClientOrderId + ". Original error: " + error.message +
            (lookupError ? "; reconciliation error: " + lookupError.message : ""));
          uncertain.uncertainOrder = true;
          throw uncertain;
        }
      }
      if (!["FILLED", "PARTIALLY_FILLED"].includes(entryOrder.status)) throw new Error("Entry market order was not filled: " + entryOrder.status);

      const position = (await this.x.positions()).find(p => p.symbol === symbol);
      const entry = num(position?.entryPrice) || num(entryOrder.avgPrice) || signal.entry;
      const actualQty = Math.abs(num(position?.positionAmt)) || num(entryOrder.executedQty) || marketQty;
      if (!(actualQty > 0)) throw new Error("Binance returned an entry without a confirmed filled quantity");
      if (!(signal.side === "LONG" ? signal.stop < entry : signal.stop > entry)) throw new Error("Actual fill moved beyond the planned stop; closing position");

      const direction = signal.side === "LONG" ? 1 : -1;
      const risk = Math.abs(entry - signal.stop);
      const tp1 = entry + direction * risk * this.c.strategy.rewardRiskTp1;
      const tp2 = entry + direction * risk * this.c.strategy.rewardRiskTp2;
      const stop = this.x.price(symbol, signal.stop, signal.side === "LONG" ? "DOWN" : "UP");
      const tp1Price = this.x.price(symbol, tp1, signal.side === "LONG" ? "UP" : "DOWN");
      const tp2Price = this.x.price(symbol, tp2, signal.side === "LONG" ? "UP" : "DOWN");
      const tp1Qty = this.x.quantity(symbol, actualQty * this.c.strategy.tp1ClosePct / 100, false);
      const storedQty = this.x.quantity(symbol, actualQty, true);
      if (tp1Qty * tp1Price < filters.minNotional) throw new Error("TP1 partial quantity is below Binance minNotional; refusing invalid TP split");

      const priceProtect = String(Boolean(this.c.execution.priceProtect)).toLowerCase();
      let slOrder, tp1Order, tp2Order;
      try {
        // SL protects the entire live position. closePosition cannot be combined with quantity/reduceOnly.
        slOrder = await this.x.newAlgoOrder({ symbol, side: exitSide, type: "STOP_MARKET", triggerPrice: stop, closePosition: "true", workingType: this.c.binance.workingType, priceProtect });
        protectionIds.push(slOrder.algoId);
        tp1Order = await this.x.newAlgoOrder({ symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", triggerPrice: tp1Price, quantity: tp1Qty, reduceOnly: "true", workingType: this.c.binance.workingType, priceProtect });
        protectionIds.push(tp1Order.algoId);
        // TP2 closes whatever remains after TP1; do not hard-code a stale remainder quantity.
        tp2Order = await this.x.newAlgoOrder({ symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", triggerPrice: tp2Price, closePosition: "true", workingType: this.c.binance.workingType, priceProtect });
        protectionIds.push(tp2Order.algoId);
      } catch (e) {
        this.log("[entry-protection-error]", symbol, "message", e.message, "code", e.code ?? "-", "status", e.status ?? "-", "acceptedAlgoIds", protectionIds.join(","));
        await this.x.cancelProtection(symbol, protectionIds).catch(() => {});
        await this.x.cancelAll(symbol).catch(() => {});
        const liveQty = Math.abs(num((await this.x.positions()).find(p => p.symbol === symbol)?.positionAmt));
        if (liveQty > 0) await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: this.x.quantity(symbol, liveQty, true), reduceOnly: "true" }).catch(() => {});
        throw new Error("Algo TP/SL protection placement failed; emergency close attempted: " + e.message);
      }

      const doc = {
        symbol, side: signal.side, entry, stop, tp1: tp1Price, tp2: tp2Price, risk,
        quantity: storedQty, initialQuantity: storedQty, tp1Quantity: tp1Qty,
        tp2Quantity: Math.max(0, storedQty - tp1Qty), margin, leverage,
        entryOrderId: entryOrder.orderId, slOrderId: slOrder.algoId,
        tp1OrderId: tp1Order.algoId, tp2OrderId: tp2Order.algoId,
        tp1Done: false, openedAt: new Date(), walletAtEntry: wallet, realizedPnl: 0
      };
      try {
        await this.db.openPosition(doc);
        positionPersisted = true;
      } catch (e) {
        await this.x.cancelProtection(symbol, protectionIds).catch(() => {});
        await this.x.cancelAll(symbol).catch(() => {});
        const liveQty = Math.abs(num((await this.x.positions()).find(p => p.symbol === symbol)?.positionAmt));
        if (liveQty > 0) await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: this.x.quantity(symbol, liveQty, true), reduceOnly: "true" }).catch(() => {});
        throw e;
      }
      try {
        await this.alerts.opened(doc);
      } catch (alertError) {
        this.log("[entry-alert-error]", symbol, alertError.message);
      }
      try {
        await this.db.saveEvent({ type: "OPEN", symbol, side: signal.side, entry, quantity: storedQty, margin });
      } catch (eventError) {
        this.log("[entry-event-error]", symbol, eventError.message);
      }
      return true;
    } catch (e) {
      // Once MongoDB has the live position, failures in notifications/event logging
      // must never remove exchange protection or close a valid trade.
      if (positionPersisted) {
        this.log("[entry-post-open-error]", symbol, e.message);
        return true;
      }
      const stillOpen = (await this.x.positions()).find(p => p.symbol === symbol && Math.abs(num(p.positionAmt)) > 0);
      if (stillOpen) {
        await this.x.cancelProtection(symbol, protectionIds).catch(() => {});
        await this.x.cancelAll(symbol).catch(() => {});
        await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: this.x.quantity(symbol, Math.abs(num(stillOpen.positionAmt)), true), reduceOnly: "true" }).catch(() => {});
      }
      throw e;
    }
  }
  async managePositions() {
    const positions = await this.db.getOpenPositions();
    if (!positions.length) return;
    const exchangePositions = await this.x.positions();
    const liveBySymbol = new Map(exchangePositions.map(p => [p.symbol, p]));
    for (const p of positions) {
      try {
        const live = liveBySymbol.get(p.symbol);
        const amount = Math.abs(num(live?.positionAmt));
        if (p.unmanaged) {
          if (amount <= 0) {
            await this.db.closePosition(p.symbol, { reason: "EXTERNAL_CLOSE", pnl: 0, pnlPct: 0 });
            continue;
          }
          const existingStop = p.slOrderId ? await this.x.algoOrder(p.slOrderId) : null;
          if (existingStop?.algoStatus === "NEW") continue;
          const bars = await this.candles(p.symbol, this.c.strategy.entryTimeframe, this.c.strategy.historyCandles);
          const atrValue = atr(bars, this.c.strategy.atrPeriod);
          const entryPrice = num(live?.entryPrice) || num(p.entry);
          if (atrValue > 0 && entryPrice > 0) {
            const fallback = p.side === "LONG"
              ? entryPrice - atrValue * this.c.strategy.fallbackAtrMultiple
              : entryPrice + atrValue * this.c.strategy.fallbackAtrMultiple;
            const triggerPrice = this.x.price(p.symbol, fallback, p.side === "LONG" ? "DOWN" : "UP");
            const recovered = await this.replaceStopLoss(p.symbol, p.side, triggerPrice, p.stop, p.slOrderId);
            const replacement = recovered.order;
            const confirmedStop = num(replacement.triggerPrice) || (recovered.restored ? num(p.stop) : triggerPrice);
            await this.db.updatePosition(p.symbol, { slOrderId: replacement.algoId, stop: confirmedStop });
          } else {
            this.log("[unmanaged-unprotected]", p.symbol, "no ATR available; emergency close");
            await this.x.newOrder({
              symbol: p.symbol, side: p.side === "LONG" ? "SELL" : "BUY", type: "MARKET",
              quantity: this.x.quantity(p.symbol, amount, true), reduceOnly: "true"
            });
          }
          continue;
        }

        const [tp1, tp2, sl] = await Promise.all([
          p.tp1OrderId ? this.x.algoOrder(p.tp1OrderId) : null,
          p.tp2OrderId ? this.x.algoOrder(p.tp2OrderId) : null,
          p.slOrderId ? this.x.algoOrder(p.slOrderId) : null
        ]);
        const [tp1Execution, tp2Execution, slExecution] = await Promise.all([
          tp1?.actualOrderId ? this.x.order(p.symbol, tp1.actualOrderId).catch(() => null) : null,
          tp2?.actualOrderId ? this.x.order(p.symbol, tp2.actualOrderId).catch(() => null) : null,
          sl?.actualOrderId ? this.x.order(p.symbol, sl.actualOrderId).catch(() => null) : null
        ]);

        if (amount <= 0) {
          const trades = await this.x.trades(p.symbol, new Date(p.openedAt).getTime());
          const related = trades.filter(t => Number(t.time) >= new Date(p.openedAt).getTime());
          const pnl = related.reduce((sum, t) => sum + num(t.realizedPnl) - num(t.commission), 0);
          const exitTrades = related.filter(t => t.side === (p.side === "LONG" ? "SELL" : "BUY"));
          const exitQty = exitTrades.reduce((sum, t) => sum + num(t.qty), 0);
          const exit = exitQty ? exitTrades.reduce((sum, t) => sum + num(t.price) * num(t.qty), 0) / exitQty : p.stop;
          const reason = tp2Execution?.status === "FILLED" ? "TP2"
            : slExecution?.status === "FILLED" ? (p.tp1Done ? "BREAKEVEN_SL" : "SL")
            : tp1Execution?.status === "FILLED" ? "TP1_POSITION_CLOSED" : "CLOSED";
          const pnlPct = p.margin ? pnl / p.margin * 100 : 0;
          await this.x.cancelProtection(p.symbol, [p.slOrderId, p.tp1OrderId, p.tp2OrderId]).catch(() => {});
          await this.db.closePosition(p.symbol, { exit, pnl, pnlPct, reason });
          await this.alerts.result({ ...p, exit, pnl, pnlPct, reason });
          await this.db.saveEvent({ type: "CLOSE", symbol: p.symbol, pnl, reason });
          continue;
        }

        // TP1 must be fully filled before moving the stop. A trigger acknowledgement alone is not a fill.
        if (!p.tp1Done && tp1Execution?.status === "FILLED") {
          const offset = this.c.strategy.breakevenOffsetPct / 100;
          const be = p.side === "LONG" ? p.entry * (1 + offset) : p.entry * (1 - offset);
          const stop = this.x.price(p.symbol, be, p.side === "LONG" ? "UP" : "DOWN");
          const exitSide = p.side === "LONG" ? "SELL" : "BUY";
          // Binance can reject two closePosition STOP/TAKE_PROFIT orders in the same direction.
          // Cancel only the old STOP_MARKET SL, confirm cancellation, then install and verify the new SL.
          const moved = await this.replaceStopLoss(p.symbol, p.side, stop, p.stop, p.slOrderId);
          const newSl = moved.order;
          const confirmedStop = num(newSl.triggerPrice) || (moved.restored ? num(p.stop) : stop);
          await this.db.updatePosition(p.symbol, moved.restored
            ? { slOrderId: newSl.algoId, stop: confirmedStop }
            : { tp1Done: true, slOrderId: newSl.algoId, tp1FilledAt: new Date(), remainingQuantity: amount, stop: confirmedStop });
          if (moved.restored) {
            continue;
          }
          await this.db.saveEvent({ type: "TP1", symbol: p.symbol, stop: confirmedStop, remaining: amount });
          continue;
        }

        // If Binance no longer has an active stop and it has not already triggered, restore protection.
        const slStillWorking = sl && sl.algoStatus === "NEW";
        const slExecutionActive = slExecution && ["NEW", "PARTIALLY_FILLED"].includes(slExecution.status);
        if (!slStillWorking && !slExecutionActive) {
          const exitSide = p.side === "LONG" ? "SELL" : "BUY";
          const baseStop = p.tp1Done
            ? (p.side === "LONG" ? p.entry * (1 + this.c.strategy.breakevenOffsetPct / 100) : p.entry * (1 - this.c.strategy.breakevenOffsetPct / 100))
            : p.stop;
          const safeStop = this.x.price(p.symbol, baseStop, p.tp1Done ? (p.side === "LONG" ? "UP" : "DOWN") : (p.side === "LONG" ? "DOWN" : "UP"));
          const recovered = await this.replaceStopLoss(p.symbol, p.side, safeStop, p.stop, p.slOrderId);
          const replacement = recovered.order;
          await this.db.updatePosition(p.symbol, {
            slOrderId: replacement.algoId,
            stop: num(replacement.triggerPrice) || (recovered.restored ? num(p.stop) : safeStop)
          });
        }
      } catch (e) {
        this.log("[manage]", p.symbol, e.message);
      }
    }
  }
  async reconcile() {
    const [exchangePositions, stored] = await Promise.all([this.x.positions(), this.db.getOpenPositions()]);
    const active = exchangePositions.filter(p => Math.abs(num(p.positionAmt)) > 0);
    for (const p of active) {
      if (stored.some(x => x.symbol === p.symbol)) continue;
      const side = num(p.positionAmt) > 0 ? "LONG" : "SHORT";
      const openAlgo = await this.x.openAlgoOrders(p.symbol);
      let stopOrder = openAlgo.find(o => o.orderType === "STOP_MARKET" && o.algoStatus === "NEW"
        && o.side === (side === "LONG" ? "SELL" : "BUY") && o.closePosition === true);
      if (!stopOrder) {
        const bars = await this.candles(p.symbol, this.c.strategy.entryTimeframe, this.c.strategy.historyCandles).catch(() => []);
        const a = atr(bars, this.c.strategy.atrPeriod);
        const entry = num(p.entryPrice);
        if (a && entry > 0) {
          const stopPrice = this.x.price(p.symbol, side === "LONG"
            ? entry - a * this.c.strategy.fallbackAtrMultiple
            : entry + a * this.c.strategy.fallbackAtrMultiple, side === "LONG" ? "DOWN" : "UP");
          try {
            stopOrder = await this.x.newAlgoOrder({
              symbol: p.symbol, side: side === "LONG" ? "SELL" : "BUY", type: "STOP_MARKET",
              triggerPrice: stopPrice, closePosition: "true", workingType: this.c.binance.workingType,
              priceProtect: "false"
            });
          } catch (e) {
            this.log("[reconcile-stop-error]", p.symbol, e.message, "attempting emergency close");
            await this.x.newOrder({
              symbol: p.symbol, side: side === "LONG" ? "SELL" : "BUY", type: "MARKET",
              quantity: this.x.quantity(p.symbol, Math.abs(num(p.positionAmt)), true), reduceOnly: "true"
            }).catch(closeError => this.log("[reconcile-close-error]", p.symbol, closeError.message));
          }
        }
      }
      if (!stopOrder) {
        const current = (await this.x.positions()).find(x => x.symbol === p.symbol);
        const remaining = Math.abs(num(current?.positionAmt));
        if (remaining > 0) {
          this.log("[reconcile-unprotected]", p.symbol, "no valid SL could be installed; emergency close");
          await this.x.newOrder({
            symbol: p.symbol, side: side === "LONG" ? "SELL" : "BUY", type: "MARKET",
            quantity: this.x.quantity(p.symbol, remaining, true), reduceOnly: "true"
          }).catch(e => this.log("[reconcile-emergency-close-error]", p.symbol, e.message));
        }
      }
      await this.db.openPosition({
        symbol: p.symbol, side, entry: num(p.entryPrice), stop: num(stopOrder?.triggerPrice),
        tp1: 0, tp2: 0, risk: 0, quantity: Math.abs(num(p.positionAmt)),
        initialQuantity: Math.abs(num(p.positionAmt)), margin: num(p.initialMargin),
        leverage: num(p.leverage) || this.c.binance.leverage, tp1Done: false,
        openedAt: new Date(), walletAtEntry: 0, unmanaged: true, slOrderId: stopOrder?.algoId || 0,
        tp1OrderId: 0, tp2OrderId: 0
      });
    }
  }

}
module.exports = { TradingEngine, timeframeMs };
