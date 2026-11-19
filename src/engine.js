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
    this.running = false; this.universe = []; this.lastScan = 0;
    this.lastCandle = new Map(); this.lastSignalBucket = 0; this.lastManageAt = 0;
  }
  log(...args) { if (this.c.app.logLevel !== "silent") console.log(new Date().toISOString(), ...args); }
  async start() {
    await this.x.exchangeInfo(); await this.x.assertOneWayMode();
    if (this.c.app.startupReconcile) await this.reconcile();
    const cached = await this.db.getScanner();
    if (cached?.symbols?.length) this.universe = cached.symbols;
    this.running = true;
    if (this.c.telegram.sendStartupMessage) await this.alerts.startup("🤖 Futures bot started\nUniverse: " + this.universe.length + " coins\nMode: LIVE");
    while (this.running) {
      try {
        if (!this.lastScan || Date.now() - this.lastScan >= this.c.scanner.intervalMinutes * 60000) await this.scan();
        if (Date.now() - this.lastManageAt >= this.c.execution.orderPollIntervalMs) {
          await this.managePositions(); this.lastManageAt = Date.now();
        }
        await this.checkSignals();
      } catch (e) { this.log("[loop-error]", e.message); }
      await sleep(this.c.app.loopIntervalMs);
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
    const bucket = Math.floor(Date.now() / timeframeMs(this.c.strategy.entryTimeframe));
    if (bucket === this.lastSignalBucket) return;
    this.lastSignalBucket = bucket;
    const exchangePositions = await this.x.positions();
    const active = new Set(exchangePositions.filter(p => Math.abs(num(p.positionAmt)) > 0).map(p => p.symbol));
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
        if (active.has(symbol) || await this.db.getPosition(symbol)) continue;
        const [trendCandles, entryCandles] = await Promise.all([
          this.candles(symbol, this.c.strategy.trendTimeframe, this.c.strategy.historyCandles),
          this.candles(symbol, this.c.strategy.entryTimeframe, this.c.strategy.historyCandles)
        ]);
        if (!entryCandles.length) continue;
        const latest = entryCandles[entryCandles.length - 1];
        if (this.lastCandle.get(symbol) === latest.closeTime) continue;
        this.lastCandle.set(symbol, latest.closeTime);
        const setup = await this.db.getSetup(symbol);
        const result = evaluateClosedCandle({ trendCandles, entryCandles, setup, config: this.c });
        if (result.action === "ARM") await this.db.saveSetup(symbol, result.setup);
        else if (result.action === "CANCEL") await this.db.deleteSetup(symbol);
        else if (result.action === "KEEP") await this.db.saveSetup(symbol, result.setup);
        else if (result.action === "ENTRY") { await this.db.deleteSetup(symbol); await this.openTrade(symbol, result); }
        } catch (e) { this.log("[signal]", symbol, e.message); }
      }
      if (this.running && offset + batchSize < this.universe.length && batchDelayMs > 0) {
        await sleep(batchDelayMs);
      }
    }
  }
  async openTrade(symbol, signal) {
    if (await this.db.getPosition(symbol)) return;
    const exchangePositions = await this.x.positions();
    if (exchangePositions.some(p => p.symbol === symbol && Math.abs(num(p.positionAmt)) > 0)) return;
    const open = await this.db.getOpenPositions();
    if (open.length >= this.c.risk.maxActivePositions) return;

    const account = await this.x.account();
    const wallet = num(account.totalWalletBalance);
    if (!(wallet > 0)) throw new Error("Invalid totalWalletBalance");
    const margin = calculateMargin(wallet, this.c.risk);
    const leverage = this.c.binance.leverage;
    const marketQty = this.x.quantity(symbol, calculateRawQuantity(margin, leverage, signal.entry), true);
    const filters = this.x.filters.get(symbol);
    if (marketQty * signal.entry < filters.minNotional) throw new Error("Order below Binance minNotional");
    if (!(signal.side === "LONG" ? signal.stop < signal.entry : signal.stop > signal.entry)) throw new Error("Stop is on the wrong side of entry");

    await this.x.setMarginType(symbol, this.c.binance.marginType);
    await this.x.setLeverage(symbol, leverage);
    const side = signal.side === "LONG" ? "BUY" : "SELL";
    const exitSide = side === "BUY" ? "SELL" : "BUY";
    const entryClientOrderId = "E" + require("node:crypto").randomBytes(11).toString("hex");
    let entryOrder;
    let protectionIds = [];
    try {
      try {
        entryOrder = await this.x.newOrder({ symbol, side, type: "MARKET", quantity: marketQty, newClientOrderId: entryClientOrderId, newOrderRespType: "RESULT" });
      } catch (error) {
        try {
          entryOrder = await this.x.order(symbol, undefined, entryClientOrderId);
        } catch {
          const uncertain = (await this.x.positions()).find(p => p.symbol === symbol && Math.abs(num(p.positionAmt)) > 0);
          if (uncertain) {
            await this.x.cancelAll(symbol).catch(() => {});
            await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: this.x.quantity(symbol, Math.abs(num(uncertain.positionAmt)), true), reduceOnly: "true" }).catch(() => {});
          }
          throw new Error("Entry response uncertain; duplicate retry prevented and position reconciliation attempted: " + error.message);
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
      } catch (e) {
        await this.x.cancelProtection(symbol, protectionIds).catch(() => {});
        await this.x.cancelAll(symbol).catch(() => {});
        const liveQty = Math.abs(num((await this.x.positions()).find(p => p.symbol === symbol)?.positionAmt));
        if (liveQty > 0) await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: this.x.quantity(symbol, liveQty, true), reduceOnly: "true" }).catch(() => {});
        throw e;
      }
      await this.alerts.opened(doc);
      await this.db.saveEvent({ type: "OPEN", symbol, side: signal.side, entry, quantity: storedQty, margin });
      this.log("[opened]", symbol, signal.side, "qty", storedQty, "margin", margin, "SL/TP algo ids", protectionIds.join(","));
    } catch (e) {
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
            const replacement = await this.x.newAlgoOrder({
              symbol: p.symbol, side: p.side === "LONG" ? "SELL" : "BUY", type: "STOP_MARKET",
              triggerPrice, closePosition: "true", workingType: this.c.binance.workingType, priceProtect: "false"
            });
            await this.db.updatePosition(p.symbol, { slOrderId: replacement.algoId, stop: triggerPrice });
            this.log("[unmanaged-sl-recovered]", p.symbol, triggerPrice);
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
          // Place the replacement stop first; keep TP2 working, then retire the old stop.
          const activeAlgos = await this.x.openAlgoOrders(p.symbol);
          let newSl = activeAlgos.find(o => o.orderType === "STOP_MARKET" && o.algoStatus === "NEW"
            && o.side === exitSide && o.closePosition === true
            && Math.abs(num(o.triggerPrice) - stop) <= this.x.filters.get(p.symbol).tickSize / 2);
          if (!newSl) {
            newSl = await this.x.newAlgoOrder({
              symbol: p.symbol, side: exitSide, type: "STOP_MARKET", triggerPrice: stop,
              closePosition: "true", workingType: this.c.binance.workingType,
              priceProtect: String(Boolean(this.c.execution.priceProtect)).toLowerCase()
            });
          }
          if (p.slOrderId && String(p.slOrderId) !== String(newSl.algoId)) {
            await this.x.cancelAlgoOrder(p.slOrderId).catch(e => this.log("[old-sl-cancel]", p.symbol, e.message));
          }
          await this.db.updatePosition(p.symbol, { tp1Done: true, slOrderId: newSl.algoId, tp1FilledAt: new Date(), remainingQuantity: amount, stop });
          await this.db.saveEvent({ type: "TP1", symbol: p.symbol, stop, remaining: amount });
          this.log("[tp1]", p.symbol, "remaining", amount, "new SL", stop);
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
          const activeAlgos = await this.x.openAlgoOrders(p.symbol);
          let replacement = activeAlgos.find(o => o.orderType === "STOP_MARKET" && o.algoStatus === "NEW"
            && o.side === exitSide && o.closePosition === true);
          if (!replacement) {
            replacement = await this.x.newAlgoOrder({
              symbol: p.symbol, side: exitSide, type: "STOP_MARKET", triggerPrice: safeStop,
              closePosition: "true", workingType: this.c.binance.workingType, priceProtect: "false"
            });
          }
          await this.db.updatePosition(p.symbol, { slOrderId: replacement.algoId, stop: num(replacement.triggerPrice) || safeStop });
          this.log("[sl-recovered]", p.symbol, replacement.triggerPrice || safeStop);
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
      this.log("[reconcile] unmanaged exchange position detected; locking symbol", p.symbol);
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
