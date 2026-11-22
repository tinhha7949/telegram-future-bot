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
    strategy: { timeframe: "15m", historyCandles: 160 }
  }, { positions: async () => [] }, { getPosition: async () => null }, {});
  engine.running = true;
  engine.universe = symbols;
  for (const symbol of symbols) engine.lastCandle.set(symbol, 123);
  engine.candles = async (symbol, interval) => {
    calls.push(symbol + ":" + interval);
    return [{ closeTime: 123 }];
  };

  await engine.checkSignals();

  assert.equal(calls.length, 12);
  for (let i = 0; i < symbols.length; i++) {
    assert.equal(calls[i], symbols[i] + ":15m");
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
        timeframe: "15m",
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

test("closed-candle RSI exit ENTRY is passed to openTrade and legacy setup is cleared", async () => {
  const bars = [100, 102, 101, 100].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  bars[3].open = 100.1;
  let opened = null;
  let deleted = null;
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      signalCheckIntervalSeconds: 60, timeframe: "15m", historyCandles: 160,
      rsiPeriod: 2, rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
      adx: { enabled: false, rangeMax: 20, mixedMax: 26, requireWeakCandleWhenDisabled: false },
      slBufferPct: 0.12, minStopDistancePct: 0.1, maxStopDistancePct: 5,
      rewardRiskTp1: 1.2, rewardRiskTp2: 1.5
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    deleteSetup: async symbol => { deleted = symbol; }
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => {
    assert.equal(interval, "15m");
    return bars;
  };
  engine.openTrade = async (symbol, signal) => {
    opened = { symbol, signal };
    return true;
  };

  await engine.checkSignals();

  assert.equal(opened?.symbol, "TESTUSDT");
  assert.equal(opened?.signal.side, "SHORT");
  assert.equal(deleted, "TESTUSDT");
});

test("disabled breakout confirmation enters immediately from a valid same-candle RSI signal", async () => {
  const closes = [100, 102, 104, 103];
  const bars = closes.map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  bars[3].open = 103.05;
  let opened = null;
  let setupSaved = false;
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      rsiEnabled: true, confirmationEnabled: false, confirmationCandles: 3,
      signalCheckIntervalSeconds: 60, timeframe: "15m", historyCandles: 160,
      rsiPeriod: 2, rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
      adx: { enabled: false, requireWeakCandleWhenDisabled: false },
      slBufferPct: 0.12, minStopDistancePct: 0.1, maxStopDistancePct: 5,
      rewardRiskTp1: 1.2, rewardRiskTp2: 1.8
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    getSetup: async () => null,
    saveSetup: async () => { setupSaved = true; },
    deleteSetup: async () => {}
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => {
    assert.equal(interval, "15m");
    return bars;
  };
  engine.openTrade = async (symbol, signal) => {
    opened = { symbol, signal };
    return true;
  };

  await engine.checkSignals();

  assert.equal(opened?.symbol, "TESTUSDT");
  assert.equal(opened?.signal.side, "SHORT");
  assert.equal(opened?.signal.entry, 103);
  assert.equal(setupSaved, false);
});

test("enabled breakout confirmation stores the valid RSI signal instead of entering immediately", async () => {
  const closes = [100, 102, 104, 103];
  const bars = closes.map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  bars[3].open = 103.05;
  let saved = null;
  let opened = false;
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      rsiEnabled: true, confirmationEnabled: true, confirmationCandles: 3,
      signalCheckIntervalSeconds: 60, timeframe: "15m", historyCandles: 160,
      rsiPeriod: 2, rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
      adx: { enabled: false, requireWeakCandleWhenDisabled: false }
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    getSetup: async () => null,
    saveSetup: async (_symbol, setup) => { saved = setup; },
    deleteSetup: async () => {}
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async () => bars;
  engine.openTrade = async () => { opened = true; };

  await engine.checkSignals();

  assert.equal(saved?.side, "SHORT");
  assert.equal(saved?.signalHigh, bars[3].high);
  assert.equal(saved?.timeframe, "15m");
  assert.equal(saved?.signalLogic, "RSI_RANGE_V1");
  assert.equal(opened, false);
});

test("pending setup created by the previous RSI rule is discarded", async () => {
  const bars = [100, 102, 104, 103].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  bars[3].open = 103.05;
  let deleted = 0;
  let saved = null;
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      rsiEnabled: true, confirmationEnabled: true, confirmationCandles: 3,
      signalCheckIntervalSeconds: 60, timeframe: "15m", historyCandles: 160,
      rsiPeriod: 2, rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
      adx: { enabled: false, requireWeakCandleWhenDisabled: false }
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    getSetup: async () => ({
      side: "SHORT", timeframe: "15m", signalTime: 3,
      signalHigh: 104, signalLow: 100, structureHigh: 104, structureLow: 99
    }),
    deleteSetup: async () => { deleted += 1; },
    saveSetup: async (_symbol, setup) => { saved = setup; }
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async () => bars;
  engine.openTrade = async () => { throw new Error("should not enter while a new setup is armed"); };

  await engine.checkSignals();

  assert.equal(deleted, 1);
  assert.equal(saved?.signalLogic, "RSI_RANGE_V1");
  assert.equal(saved?.side, "SHORT");
});

test("disabled RSI strategy clears pending setup and never evaluates an entry", async () => {
  const bars = [100, 102, 104, 103].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  let deleted = 0;
  let opened = false;
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      rsiEnabled: false, confirmationEnabled: true,
      signalCheckIntervalSeconds: 60, timeframe: "15m", historyCandles: 160,
      rsiPeriod: 2, adx: { enabled: false, requireWeakCandleWhenDisabled: false }
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    deleteSetup: async () => { deleted += 1; }
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.lastCandle.set("TESTUSDT", 4);
  engine.candles = async () => bars;
  engine.openTrade = async () => { opened = true; };

  await engine.checkSignals();

  assert.equal(deleted, 1);
  assert.equal(opened, false);
});

test("ADX candle-fetch failure does not mark the current trade candle as processed", async () => {
  const bars = [100, 102, 101, 100].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      signalCheckIntervalSeconds: 60, timeframe: "1h", historyCandles: 160,
      rsiPeriod: 2, rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
      adx: { enabled: true, timeframe: "4h", period: 14, rangeMax: 20, mixedMax: 26, requireWeakCandleWhenDisabled: true }
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    deleteSetup: async () => {}
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => {
    if (interval === "1h") return bars;
    throw new Error("temporary ADX kline API failure");
  };

  await engine.checkSignals();

  assert.equal(engine.lastCandle.has("TESTUSDT"), false);
});test("TP1 minimum-notional failure is detected before submitting a live MARKET entry", async () => {
  let marketOrderSubmitted = false;
  const filters = {
    marketStepSize: 0.001, marketMinQty: 0.001,
    lotStepSize: 0.01, lotMinQty: 0.01,
    tickSize: 0.1, minNotional: 5
  };
  const exchange = {
    filters: new Map([["TESTUSDT", filters]]),
    positions: async () => [],
    account: async () => ({ totalWalletBalance: 3, availableBalance: 3 }),
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

test("transient pre-entry failure leaves the same closed RSI signal candle eligible for retry", async () => {
  const bars = [100, 102, 101, 100].map((close, i) => ({
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, closeTime: i + 1
  }));
  bars[3].open = 100.1;
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: {
      signalCheckIntervalSeconds: 60, timeframe: "15m", historyCandles: 160,
      rsiPeriod: 2, rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
      adx: { enabled: false, rangeMax: 20, mixedMax: 26, requireWeakCandleWhenDisabled: false },
      slBufferPct: 0.12, minStopDistancePct: 0.1, maxStopDistancePct: 5,
      rewardRiskTp1: 1.2, rewardRiskTp2: 1.5
    }
  }, {
    positions: async () => []
  }, {
    getPosition: async () => null,
    deleteSetup: async () => {}
  }, {});
  engine.running = true;
  engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => {
    assert.equal(interval, "15m");
    return bars;
  };
  engine.openTrade = async () => {
    const error = new Error("temporary Binance API timeout before order submission");
    error.retrySignalCandle = true;
    throw error;
  };

  await engine.checkSignals();

  assert.equal(engine.lastCandle.has("TESTUSDT"), false);
});test("scanner failure does not skip position management or signal checks", async () => {
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { intervalMinutes: 15 },
    execution: { orderPollIntervalMs: 15000 }
  }, {}, {}, {});
  let managed = false;
  let reconciled = false;
  let signalsChecked = false;
  engine.scan = async () => { throw new Error("temporary ticker API failure"); };
  engine.managePositions = async () => { managed = true; };
  engine.reconcile = async () => { reconciled = true; };
  engine.checkSignals = async () => { signalsChecked = true; };

  await engine.runCycle();

  assert.equal(managed, true);
  assert.equal(reconciled, true);
  assert.equal(signalsChecked, true);
});

test("insufficient available balance rejects entry before any MARKET order", async () => {
  let marketOrderSubmitted = false;
  const filters = {
    marketStepSize: 0.001, marketMinQty: 0.001,
    lotStepSize: 0.01, lotMinQty: 0.01,
    tickSize: 0.1, minNotional: 5
  };
  const exchange = {
    filters: new Map([["TESTUSDT", filters]]),
    positions: async () => [],
    account: async () => ({ totalWalletBalance: 100, availableBalance: 0.1 }),
    quantity: (_symbol, raw, marketOrder = false) => {
      const step = marketOrder ? filters.marketStepSize : filters.lotStepSize;
      return Number((Math.floor(raw / step) * step).toFixed(3));
    },
    price: (_symbol, raw) => raw,
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

  await assert.rejects(engine.openTrade("TESTUSDT", { side: "LONG", entry: 100, stop: 99 }), /ENTRY_REJECTED_INSUFFICIENT_AVAILABLE_BALANCE/);
  assert.equal(marketOrderSubmitted, false);
});

test("symbol leverage bracket rejects unsupported leverage before MARKET entry", async () => {
  let marketOrderSubmitted = false;
  let leverageSet = false;
  const filters = {
    marketStepSize: 0.001, marketMinQty: 0.001,
    lotStepSize: 0.01, lotMinQty: 0.01,
    tickSize: 0.1, minNotional: 5
  };
  const exchange = {
    filters: new Map([["TESTUSDT", filters]]),
    positions: async () => [],
    account: async () => ({ totalWalletBalance: 100, availableBalance: 100 }),
    quantity: (_symbol, raw, marketOrder = false) => {
      const step = marketOrder ? filters.marketStepSize : filters.lotStepSize;
      return Number((Math.floor(raw / step) * step).toFixed(3));
    },
    price: (_symbol, raw) => raw,
    leverageBracket: async () => [{ symbol: "TESTUSDT", brackets: [{ notionalFloor: 0, notionalCap: 100000, initialLeverage: 10 }] }],
    setMarginType: async () => {},
    setLeverage: async () => { leverageSet = true; },
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

  await assert.rejects(engine.openTrade("TESTUSDT", { side: "LONG", entry: 100, stop: 99 }), /ENTRY_REJECTED_LEVERAGE_LIMIT/);
  assert.equal(leverageSet, false);
  assert.equal(marketOrderSubmitted, false);
});

test("uncertain MARKET response is reconciled and post-open logging failures never close the position", async () => {
  let live = false;
  let marketOrderSubmitted = false;
  let protectionOrders = 0;
  let cleanupCalls = 0;
  const filters = {
    marketStepSize: 0.001, marketMinQty: 0.001,
    lotStepSize: 0.01, lotMinQty: 0.01,
    tickSize: 0.1, minNotional: 5
  };
  const exchange = {
    filters: new Map([["TESTUSDT", filters]]),
    positions: async () => live ? [{ symbol: "TESTUSDT", positionAmt: "2", entryPrice: "100" }] : [],
    order: async () => { throw new Error("simulated order lookup timeout"); },
    account: async () => ({ totalWalletBalance: 100, availableBalance: 100 }),
    quantity: (_symbol, raw, marketOrder = false) => {
      const step = marketOrder ? filters.marketStepSize : filters.lotStepSize;
      return Number((Math.floor(raw / step) * step).toFixed(3));
    },
    price: (_symbol, raw) => raw,
    leverageBracket: async () => [{ symbol: "TESTUSDT", brackets: [{ notionalFloor: 0, notionalCap: 100000, initialLeverage: 50 }] }],
    setMarginType: async () => {},
    setLeverage: async () => {},
    newOrder: async params => {
      if (params.type === "MARKET" && !params.reduceOnly) {
        marketOrderSubmitted = true;
        live = true;
        throw new Error("simulated MARKET response timeout");
      }
      cleanupCalls += 1;
      return { status: "FILLED" };
    },
    newAlgoOrder: async () => ({ algoId: ++protectionOrders }),
    cancelProtection: async () => { cleanupCalls += 1; },
    cancelAll: async () => { cleanupCalls += 1; }
  };
  let persisted = false;
  const store = {
    getPosition: async () => null,
    getOpenPositions: async () => [],
    openPosition: async () => { persisted = true; },
    saveEvent: async () => { throw new Error("Mongo event insert failed"); }
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    risk: { walletPercentPerTrade: 10, maxMarginPerTradeUsdt: 0, minMarginPerTradeUsdt: 0, maxActivePositions: 20 },
    binance: { leverage: 20, marginType: "ISOLATED", workingType: "MARK_PRICE" },
    execution: { priceProtect: false },
    strategy: { tp1ClosePct: 70, rewardRiskTp1: 1.5, rewardRiskTp2: 2 }
  }, exchange, store, { opened: async () => { throw new Error("Telegram unavailable"); } });

  const opened = await engine.openTrade("TESTUSDT", { side: "LONG", entry: 100, stop: 99 });
  assert.equal(opened, true);
  assert.equal(marketOrderSubmitted, true);
  assert.equal(persisted, true);
  assert.equal(protectionOrders, 3);
  assert.equal(cleanupCalls, 0);
});


test("Telegram startup notification failure does not stop the trading loop", async () => {
  let startupAttempted = false;
  const engine = new TradingEngine({
    app: { logLevel: "silent", startupReconcile: false, loopIntervalMs: 0 },
    telegram: { sendStartupMessage: true }
  }, {
    exchangeInfo: async () => {},
    assertOneWayMode: async () => {}
  }, {
    getScanner: async () => null
  }, {
    startup: async () => { startupAttempted = true; throw new Error("Telegram unavailable"); }
  });
  engine.runCycle = async () => { engine.running = false; };

  await engine.start();

  assert.equal(startupAttempted, true);
  assert.equal(engine.running, false);
});

test("ADX uses its configured timeframe and Wilder period, then caches until the next closed candle", async () => {
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    strategy: { adx: { enabled: true, timeframe: "4h", period: 2, historyCandles: 6 } }
  }, {}, {}, {});
  let calls = 0;
  engine.candles = async (_symbol, interval, limit) => {
    calls += 1;
    assert.equal(interval, "4h");
    assert.equal(limit, 6);
    return Array.from({ length: 6 }, (_, i) => ({
      high: 102 + i, low: 100 + i, close: 101 + i,
      closeTime: Date.now() - 1000 + i
    }));
  };
  assert.equal(await engine.getAdx("TESTUSDT"), 100);
  assert.equal(await engine.getAdx("TESTUSDT"), 100);
  assert.equal(calls, 1);
});

test("ADX returns unavailable when there is insufficient higher-timeframe history", async () => {
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    strategy: { adx: { enabled: true, timeframe: "4h", period: 14, historyCandles: 42 } }
  }, {}, {}, {});
  engine.candles = async () => [{ high: 101, low: 99, close: 100, closeTime: Date.now() - 1000 }];
  assert.equal(await engine.getAdx("TESTUSDT"), null);
});
