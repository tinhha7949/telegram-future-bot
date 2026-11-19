"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TradingEngine } = require("../src/engine");

test("entry is blocked when exchange already has the configured 20 open positions", async () => {
  let accountRequested = false;
  const exchange = {
    positions: async () => Array.from({ length: 20 }, (_, i) => ({
      symbol: "COIN" + i + "USDT", positionAmt: "1"
    })),
    account: async () => { accountRequested = true; throw new Error("must not request account at cap"); }
  };
  const store = {
    getPosition: async () => null,
    getOpenPositions: async () => []
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    risk: { maxActivePositions: 20 }
  }, exchange, store, {});
  await engine.openTrade("NEWUSDT", { side: "LONG", entry: 100, stop: 99 });
  assert.equal(accountRequested, false);
});

test("entry cap counts unique positions across Binance and MongoDB", async () => {
  let accountRequested = false;
  const exchange = {
    positions: async () => Array.from({ length: 12 }, (_, i) => ({
      symbol: "COIN" + i + "USDT", positionAmt: "1"
    })),
    account: async () => { accountRequested = true; throw new Error("must not request account at cap"); }
  };
  const store = {
    getPosition: async () => null,
    getOpenPositions: async () => [
      ...Array.from({ length: 12 }, (_, i) => ({ symbol: "COIN" + i + "USDT" })),
      ...Array.from({ length: 8 }, (_, i) => ({ symbol: "DBONLY" + i + "USDT" }))
    ]
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    risk: { maxActivePositions: 20 }
  }, exchange, store, {});
  await engine.openTrade("NEWUSDT", { side: "LONG", entry: 100, stop: 99 });
  assert.equal(accountRequested, false);
});

test("signal scanning processes coins sequentially in configurable batches", async () => {
  const symbols = Array.from({ length: 12 }, (_, i) => "TEST" + i + "USDT");
  const calls = [];
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: { entryTimeframe: "5m", trendTimeframe: "15m", historyCandles: 160 }
  }, { positions: async () => [] }, { getPosition: async () => null }, {});
  engine.running = true;
  engine.universe = symbols;
  for (const symbol of symbols) engine.lastCandle.set(symbol, 123);
  engine.candles = async (symbol, interval) => {
    calls.push(symbol + ":" + interval);
    return [{ closeTime: 123 }];
  };

  await engine.checkSignals();

  assert.equal(calls.length, 24);
  for (let i = 0; i < symbols.length; i++) {
    assert.deepEqual(calls.slice(i * 2, i * 2 + 2), [
      symbols[i] + ":15m",
      symbols[i] + ":5m"
    ]);
  }
});

test("signal checks run on the configured interval instead of waiting for a new 5m bucket", async () => {
  let now = 1_000_000;
  let positionsCalls = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const engine = new TradingEngine({
      app: { logLevel: "silent" },
      scanner: { batchSize: 10, batchDelayMs: 0 },
      strategy: {
        signalCheckIntervalSeconds: 60,
        entryTimeframe: "5m",
        trendTimeframe: "15m",
        historyCandles: 160
      }
    }, {
      positions: async () => { positionsCalls += 1; return []; }
    }, {}, {});
    engine.running = true;
    engine.universe = [];

    await engine.checkSignals();
    assert.equal(positionsCalls, 1);

    now += 30_000;
    await engine.checkSignals();
    assert.equal(positionsCalls, 1);

    now += 30_000;
    await engine.checkSignals();
    assert.equal(positionsCalls, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("confirmed ENTRY signals are passed to openTrade and their setup is cleared only after success", async () => {
  const trend = [100, 99, 98, 97, 96].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  const entry = [100, 98, 96, 97, 99, 98].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  const setup = {
    side: "SHORT", status: "ARMED",
    triggerLow: 98.8, triggerHigh: 99.2, triggerCloseTime: 5
  };
  let opened = null;
  let deleted = null;
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      signalCheckIntervalSeconds: 60, trendTimeframe: "15m", entryTimeframe: "5m",
      historyCandles: 160, emaPeriod: 3, rsiPeriod: 2, atrPeriod: 2,
      rsiShortMin: 70, rsiShortMax: 75, rsiLongMin: 25, rsiLongMax: 30,
      confirmationCandles: 3, requireRsiMomentumTurn: false, swingLeft: 1, swingRight: 1,
      swingLookback: 10, fallbackAtrMultiple: 1.5, slBufferPct: 0.12,
      minStopDistancePct: 0.1, maxStopDistancePct: 5,
      rewardRiskTp1: 1.2, rewardRiskTp2: 1.5
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    getSetup: async () => setup,
    deleteSetup: async symbol => { deleted = symbol; },
    saveSetup: async () => {}
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => interval === "15m" ? trend : entry;
  engine.openTrade = async (symbol, signal) => {
    opened = { symbol, signal };
    return true;
  };

  await engine.checkSignals();

  assert.equal(opened?.symbol, "TESTUSDT");
  assert.equal(opened?.signal.side, "SHORT");
  assert.equal(deleted, "TESTUSDT");
});

test("a transient setup-store read error does not mark the current candle as processed", async () => {
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: { signalCheckIntervalSeconds: 60, trendTimeframe: "15m", entryTimeframe: "5m", historyCandles: 160 }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    getSetup: async () => { throw new Error("temporary MongoDB read failure"); }
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async () => [{ closeTime: 123, open: 1, high: 2, low: 0.5, close: 1.5 }];

  await engine.checkSignals();

  assert.equal(engine.lastCandle.has("TESTUSDT"), false);
});

test("TP1 minimum-notional failure is detected before submitting a live MARKET entry", async () => {
  let marketOrderSubmitted = false;
  const filters = {
    marketStepSize: 0.001, marketMinQty: 0.001,
    lotStepSize: 0.01, lotMinQty: 0.01,
    tickSize: 0.1, minNotional: 5
  };
  const exchange = {
    filters: new Map([["TESTUSDT", filters]]),
    positions: async () => [],
    account: async () => ({ totalWalletBalance: 3 }),
    quantity: (_symbol, raw, marketOrder = false) => {
      const step = marketOrder ? filters.marketStepSize : filters.lotStepSize;
      const min = marketOrder ? filters.marketMinQty : filters.lotMinQty;
      const value = Math.floor((raw + step * 1e-10) / step) * step;
      if (!(value > 0) || value < min) throw new Error("Quantity below Binance minQty/stepSize");
      return Number(value.toFixed(3));
    },
    price: (_symbol, raw, rounding) => {
      const units = raw / filters.tickSize;
      const value = (rounding === "UP" ? Math.ceil(units - 1e-10) : Math.floor(units + 1e-10)) * filters.tickSize;
      return Number(value.toFixed(1));
    },
    setMarginType: async () => {},
    setLeverage: async () => {},
    newOrder: async () => { marketOrderSubmitted = true; return { status: "FILLED" }; }
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    risk: { walletPercentPerTrade: 10, maxMarginPerTradeUsdt: 0, minMarginPerTradeUsdt: 0, maxActivePositions: 20 },
    binance: { leverage: 20, marginType: "ISOLATED" },
    strategy: { tp1ClosePct: 70, rewardRiskTp1: 1.5 }
  }, exchange, {
    getPosition: async () => null,
    getOpenPositions: async () => []
  }, {});

  await assert.rejects(
    engine.openTrade("TESTUSDT", { side: "LONG", entry: 100, stop: 99 }),
    /TP1 partial quantity is below Binance minNotional/
  );
  assert.equal(marketOrderSubmitted, false);
});

test("transient pre-entry failure leaves the same signal candle eligible for retry", async () => {
  const trend = [100, 99, 98, 97, 96].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  const entry = [100, 98, 96, 97, 99, 98].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  const setup = {
    side: "SHORT", status: "ARMED",
    triggerLow: 98.8, triggerHigh: 99.2, triggerCloseTime: 5
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      signalCheckIntervalSeconds: 60, trendTimeframe: "15m", entryTimeframe: "5m",
      historyCandles: 160, emaPeriod: 3, rsiPeriod: 2, atrPeriod: 2,
      rsiShortMin: 70, rsiShortMax: 75, rsiLongMin: 25, rsiLongMax: 30,
      confirmationCandles: 3, requireRsiMomentumTurn: false, swingLeft: 1, swingRight: 1,
      swingLookback: 10, fallbackAtrMultiple: 1.5, slBufferPct: 0.12,
      minStopDistancePct: 0.1, maxStopDistancePct: 5,
      rewardRiskTp1: 1.2, rewardRiskTp2: 1.5
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    getSetup: async () => setup,
    saveSetup: async () => {},
    deleteSetup: async () => {}
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => interval === "15m" ? trend : entry;
  engine.openTrade = async () => {
    const error = new Error("temporary Binance API timeout before order submission");
    error.retrySignalCandle = true;
    throw error;
  };

  await engine.checkSignals();

  assert.equal(engine.lastCandle.has("TESTUSDT"), false);
});
