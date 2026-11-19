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
    if (this.c.telegram.sendStartupMessage) await this.alerts.startup("🤖 Futures bot started\nUniverse: " + this.universe.length + " coins\nMode: " + (process.env.BINANCE_TESTNET === "true" ? "TESTNET" : "LIVE"));
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
    for (const symbol of this.universe) {
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
  }
  async openTrade(symbol, signal) {
    if (await this.db.getPosition(symbol)) return;
    const exchangePositions = await this.x.positions();
    if (exchangePositions.some(p => p.symbol === symbol && Math.abs(num(p.positionAmt)) > 0)) return;
    const open = await this.db.getOpenPositions();
    if (open.length >= this.c.risk.maxActivePositions) return;
    const account = await this.x.account(), wallet = num(account.totalWalletBalance);
    if (!(wallet > 0)) throw new Error("Invalid totalWalletBalance");
    const margin = calculateMargin(wallet, this.c.risk);
    const leverage = this.c.binance.leverage;
    const quantity = this.x.quantity(symbol, calculateRawQuantity(margin, leverage, signal.entry));
    const filters = this.x.filters.get(symbol);
    if (quantity * signal.entry < filters.minNotional) throw new Error("Order below Binance minNotional");
    if (!(signal.side === "LONG" ? signal.stop < signal.entry : signal.stop > signal.entry)) throw new Error("Stop is on the wrong side of entry");
    await this.x.setMarginType(symbol, this.c.binance.marginType); await this.x.setLeverage(symbol, leverage);
    const side = signal.side === "LONG" ? "BUY" : "SELL", exitSide = side === "BUY" ? "SELL" : "BUY";
    const entryOrder = await this.x.newOrder({ symbol, side, type: "MARKET", quantity, newOrderRespType: "RESULT" });
    try {
      const position = (await this.x.positions()).find(p => p.symbol === symbol);
      const entry = num(position?.entryPrice) || num(entryOrder.avgPrice) || signal.entry;
      const actualQty = Math.abs(num(position?.positionAmt)) || quantity;
      const direction = signal.side === "LONG" ? 1 : -1, risk = Math.abs(entry - signal.stop);
      const tp1 = entry + direction * risk * this.c.strategy.rewardRiskTp1;
      const tp2 = entry + direction * risk * this.c.strategy.rewardRiskTp2;
      const stop = this.x.price(symbol, signal.stop), qty = this.x.quantity(symbol, actualQty);
      const tp1Qty = this.x.quantity(symbol, qty * this.c.strategy.tp1ClosePct / 100);
      const tp2Qty = this.x.quantity(symbol, Math.max(0, qty - tp1Qty));
      if (tp1Qty <= 0 || tp2Qty <= 0) throw new Error("Position too small to split into TP1 and TP2; adjust margin or leverage");
      if (tp1Qty * tp1 < filters.minNotional || tp2Qty * tp2 < filters.minNotional) throw new Error("TP split is below Binance minNotional");
      let slOrder, tp1Order, tp2Order;
      try {
        slOrder = await this.x.newOrder({ symbol, side: exitSide, type: "STOP_MARKET", stopPrice: stop, quantity: qty, reduceOnly: "true", workingType: this.c.binance.workingType, priceProtect: this.c.execution.priceProtect });
        tp1Order = await this.x.newOrder({ symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", stopPrice: this.x.price(symbol, tp1), quantity: tp1Qty, reduceOnly: "true", workingType: this.c.binance.workingType, priceProtect: this.c.execution.priceProtect });
        tp2Order = await this.x.newOrder({ symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", stopPrice: this.x.price(symbol, tp2), quantity: tp2Qty, reduceOnly: "true", workingType: this.c.binance.workingType, priceProtect: this.c.execution.priceProtect });
      } catch (e) {
        await this.x.cancelAll(symbol).catch(() => {});
        await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: qty, reduceOnly: "true" }).catch(() => {});
        throw new Error("Exit protection placement failed; emergency close attempted: " + e.message);
      }
      const doc = { symbol, side: signal.side, entry, stop, tp1: this.x.price(symbol, tp1), tp2: this.x.price(symbol, tp2), risk,
        quantity: qty, initialQuantity: qty, tp1Quantity: tp1Qty, tp2Quantity: tp2Qty, margin, leverage,
        entryOrderId: entryOrder.orderId, slOrderId: slOrder.orderId, tp1OrderId: tp1Order.orderId, tp2OrderId: tp2Order.orderId,
        tp1Done: false, openedAt: new Date(), walletAtEntry: wallet, realizedPnl: 0 };
      try { await this.db.openPosition(doc); }
      catch (e) {
        await this.x.cancelAll(symbol).catch(() => {});
        await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: qty, reduceOnly: "true" }).catch(() => {});
        throw e;
      }
      await this.alerts.opened(doc); await this.db.saveEvent({ type: "OPEN", symbol, side: signal.side, entry, quantity: qty, margin });
      this.log("[opened]", symbol, signal.side, "qty", qty, "margin", margin);
    } catch (e) {
      const stillOpen = (await this.x.positions()).find(p => p.symbol === symbol && Math.abs(num(p.positionAmt)) > 0);
      if (stillOpen) {
        await this.x.cancelAll(symbol).catch(() => {});
        await this.x.newOrder({ symbol, side: exitSide, type: "MARKET", quantity: Math.abs(num(stillOpen.positionAmt)), reduceOnly: "true" }).catch(() => {});
      }
      throw e;
    }
  }
  async managePositions() {
    const positions = await this.db.getOpenPositions();
    if (!positions.length) return;
    const exchangePositions = await this.x.positions(), liveBySymbol = new Map(exchangePositions.map(p => [p.symbol, p]));
    for (const p of positions) {
      try {
        const live = liveBySymbol.get(p.symbol), amount = Math.abs(num(live?.positionAmt));
        if (p.unmanaged) {
          if (amount <= 0) await this.db.closePosition(p.symbol, { reason: "EXTERNAL_CLOSE", pnl: 0, pnlPct: 0 });
          continue;
        }
        const [tp1, tp2, sl] = await Promise.all([
          this.x.order(p.symbol, p.tp1OrderId), this.x.order(p.symbol, p.tp2OrderId), this.x.order(p.symbol, p.slOrderId)
        ]);
        if (amount <= 0) {
          const trades = await this.x.trades(p.symbol, new Date(p.openedAt).getTime());
          const related = trades.filter(t => Number(t.time) >= new Date(p.openedAt).getTime());
          const pnl = related.reduce((sum, t) => sum + num(t.realizedPnl) - num(t.commission), 0);
          const exitTrades = related.filter(t => t.side === (p.side === "LONG" ? "SELL" : "BUY"));
          const exitQty = exitTrades.reduce((sum, t) => sum + num(t.qty), 0);
          const exit = exitQty ? exitTrades.reduce((sum, t) => sum + num(t.price) * num(t.qty), 0) / exitQty : p.stop;
          const reason = tp2.status === "FILLED" ? "TP2" : sl.status === "FILLED" ? (p.tp1Done ? "TRAILING_SL" : "SL") : tp1.status === "FILLED" ? "TP1_POSITION_CLOSED" : "CLOSED";
          const pnlPct = p.margin ? pnl / p.margin * 100 : 0;
          await this.db.closePosition(p.symbol, { exit, pnl, pnlPct, reason });
          await this.alerts.result({ ...p, exit, pnl, pnlPct, reason });
          await this.db.saveEvent({ type: "CLOSE", symbol: p.symbol, pnl, reason });
          continue;
        }
        const tp1Executed = num(tp1.executedQty) > 0;
        if (!p.tp1Done && (tp1.status === "FILLED" || tp1Executed)) {
          await this.x.cancelAll(p.symbol);
          const offset = this.c.strategy.breakevenOffsetPct / 100;
          const be = p.side === "LONG" ? p.entry * (1 + offset) : p.entry * (1 - offset);
          const stop = this.x.price(p.symbol, be), exitSide = p.side === "LONG" ? "SELL" : "BUY";
          const remaining = this.x.quantity(p.symbol, amount);
          const newSl = await this.x.newOrder({ symbol: p.symbol, side: exitSide, type: "STOP_MARKET", stopPrice: stop, quantity: remaining, reduceOnly: "true", workingType: this.c.binance.workingType });
          const newTp2 = await this.x.newOrder({ symbol: p.symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", stopPrice: p.tp2, quantity: remaining, reduceOnly: "true", workingType: this.c.binance.workingType });
          await this.db.updatePosition(p.symbol, { tp1Done: true, slOrderId: newSl.orderId, tp2OrderId: newTp2.orderId, tp1FilledAt: new Date(), remainingQuantity: remaining, stop });
          await this.db.saveEvent({ type: "TP1", symbol: p.symbol, stop, remaining });
          this.log("[tp1]", p.symbol, "remaining", remaining, "new SL", stop);
        }
      } catch (e) { this.log("[manage]", p.symbol, e.message); }
    }
  }
  async reconcile() {
    const [exchangePositions, stored] = await Promise.all([this.x.positions(), this.db.getOpenPositions()]);
    const active = exchangePositions.filter(p => Math.abs(num(p.positionAmt)) > 0);
    for (const p of active) {
      if (stored.some(x => x.symbol === p.symbol)) continue;
      this.log("[reconcile] unmanaged exchange position detected; locking symbol", p.symbol);
      const openOrders = await this.x.openOrders(p.symbol).catch(() => []);
      let stopOrder = openOrders.find(o => o.type === "STOP_MARKET");
      if (!stopOrder) {
        const bars = await this.candles(p.symbol, this.c.strategy.entryTimeframe, this.c.strategy.historyCandles).catch(() => []);
        const a = atr(bars, this.c.strategy.atrPeriod), entry = num(p.entryPrice), side = num(p.positionAmt) > 0 ? "LONG" : "SHORT";
        if (a && entry > 0) {
          const stopPrice = this.x.price(p.symbol, side === "LONG" ? entry - a * this.c.strategy.fallbackAtrMultiple : entry + a * this.c.strategy.fallbackAtrMultiple);
          stopOrder = await this.x.newOrder({ symbol: p.symbol, side: side === "LONG" ? "SELL" : "BUY", type: "STOP_MARKET", stopPrice, closePosition: "true", workingType: this.c.binance.workingType }).catch(e => { this.log("[reconcile-stop-error]", p.symbol, e.message); return null; });
        }
      }
      await this.db.openPosition({ symbol: p.symbol, side: num(p.positionAmt) > 0 ? "LONG" : "SHORT", entry: num(p.entryPrice),
        stop: num(stopOrder?.stopPrice), tp1: 0, tp2: 0, risk: 0, quantity: Math.abs(num(p.positionAmt)),
        initialQuantity: Math.abs(num(p.positionAmt)), margin: num(p.initialMargin), leverage: num(p.leverage) || this.c.binance.leverage,
        tp1Done: false, openedAt: new Date(), walletAtEntry: 0, unmanaged: true, slOrderId: stopOrder?.orderId || 0,
        tp1OrderId: 0, tp2OrderId: 0 });
    }
  }
}
module.exports = { TradingEngine, timeframeMs };
