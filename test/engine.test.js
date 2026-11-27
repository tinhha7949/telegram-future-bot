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

function pullbackBars(side) {
  const closes = side === "LONG" ? [100,101,102,103,104,105,106,105,104,105.5] : [105,104,103,102,101,100,99,100,101,99.5];
  return closes.map((close, i) => {
    const bar = { open: close + .1, high: close + .3, low: close - .3, close, openTime: i * 900000, closeTime: (i + 1) * 900000 };
    if (i === closes.length - 2 && side === "LONG") { bar.open = close + 1; bar.low = close - 2; }
    if (i === closes.length - 2 && side === "SHORT") { bar.open = close - 1; bar.high = close + 2; }
    if (i === closes.length - 1) bar.open = close + (side === "LONG" ? -1 : 1);
    return bar;
  });
}
function pullbackStrategy(overrides = {}) {
  return { confirmationEnabled: false, confirmationCandles: 3, signalCheckIntervalSeconds: 60,
    timeframe: "15m", historyCandles: 160, pullbackEmaPeriod: 9, pullbackLookbackCandles: 5,
    pullbackEmaTolerancePct: 0.15,
    adx: { enabled: false, rangeMax: 20, mixedMax: 26, requireWeakCandleWhenDisabled: false },
    slBufferPct: 0.12, minStopDistancePct: 0.1, maxStopDistancePct: 5,
    rewardRiskTp1: 1.2, rewardRiskTp2: 1.8, ...overrides };
}
test("disabled breakout confirmation enters immediately on a valid EMA9 pullback recovery", async () => {
  const bars = pullbackBars("LONG"); let opened = null, setupSaved = false;
  const engine = new TradingEngine({ app: { logLevel: "silent" }, scanner: { batchSize: 10, batchDelayMs: 0 }, strategy: pullbackStrategy() },
    { positions: async () => [] }, { getPosition: async () => null, getSetup: async () => null,
      saveSetup: async () => { setupSaved = true; }, deleteSetup: async () => {} }, {});
  engine.running = true; engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => { assert.equal(interval, "15m"); return bars; };
  engine.openTrade = async (symbol, signal) => { opened = { symbol, signal }; return true; };
  await engine.checkSignals();
  assert.equal(opened?.symbol, "TESTUSDT"); assert.equal(opened?.signal.side, "LONG");
  assert.equal(opened?.signal.entry, bars.at(-1).close); assert.equal(opened?.signal.rsi, null);
  assert.equal(setupSaved, false);
});
test("enabled breakout confirmation stores the EMA9 pullback setup instead of entering immediately", async () => {
  const bars = pullbackBars("SHORT"); let saved = null, opened = false;
  const engine = new TradingEngine({ app: { logLevel: "silent" }, scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: pullbackStrategy({ confirmationEnabled: true }) }, { positions: async () => [] },
    { getPosition: async () => null, getSetup: async () => null, saveSetup: async (_symbol, setup) => { saved = setup; }, deleteSetup: async () => {} }, {});
  engine.running = true; engine.universe = ["TESTUSDT"]; engine.candles = async () => bars;
  engine.openTrade = async () => { opened = true; };
  await engine.checkSignals();
  assert.equal(saved?.side, "SHORT"); assert.equal(saved?.timeframe, "15m");
  assert.equal(saved?.signalLogic, "EMA9_PULLBACK_V1"); assert.equal(saved?.rsi, null); assert.equal(opened, false);
});
test("pending setup created by the previous RSI rule is discarded", async () => {
  const bars = pullbackBars("LONG"); let deleted = 0, saved = null;
  const engine = new TradingEngine({ app: { logLevel: "silent" }, scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: pullbackStrategy({ confirmationEnabled: true }) }, { positions: async () => [] },
    { getPosition: async () => null, getSetup: async () => ({
      side: "SHORT", timeframe: "15m", signalTime: bars.at(-2).closeTime, signalHigh: 104, signalLow: 100,
      structureHigh: 104, structureLow: 99, signalLogic: "RSI_RANGE_V1"
    }), deleteSetup: async () => { deleted += 1; }, saveSetup: async (_symbol, setup) => { saved = setup; } }, {});
  engine.running = true; engine.universe = ["TESTUSDT"]; engine.candles = async () => bars;
  engine.openTrade = async () => { throw new Error("must not enter immediately when confirmation is enabled"); };
  await engine.checkSignals();
  assert.equal(deleted, 1); assert.equal(saved?.signalLogic, "EMA9_PULLBACK_V1"); assert.equal(saved?.side, "LONG");
});
test("transient pre-entry failure leaves the same closed EMA9 signal candle eligible for retry", async () => {
  const bars = pullbackBars("LONG");
  const engine = new TradingEngine({ app: { logLevel: "silent" }, scanner: { batchSize: 10, batchDelayMs: 0 }, strategy: pullbackStrategy() },
    { positions: async () => [] }, { getPosition: async () => null, getSetup: async () => null, deleteSetup: async () => {} }, {});
  engine.running = true; engine.universe = ["TESTUSDT"]; engine.candles = async () => bars;
  engine.openTrade = async () => { const error = new Error("temporary Binance API timeout before order submission"); error.retrySignalCandle = true; throw error; };
  await engine.checkSignals();
  assert.equal(engine.lastCandle.has("TESTUSDT"), false);
});
test("ADX candle-fetch failure does not mark the current trade candle as processed", async () => {
  const bars = pullbackBars("LONG");
  const engine = new TradingEngine({ app: { logLevel: "silent" }, scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: pullbackStrategy({ adx: { enabled: true, timeframe: "4h", period: 14, historyCandles: 100,
      rangeMax: 20, mixedMax: 26, requireWeakCandleWhenDisabled: true } }) },
    { positions: async () => [] }, { getPosition: async () => null, getSetup: async () => null, deleteSetup: async () => {} }, {});
  engine.running = true; engine.universe = ["TESTUSDT"];
  engine.candles = async (_symbol, interval) => { if (interval === "15m") return bars; throw new Error("temporary ADX kline API failure"); };
  await engine.checkSignals();
  assert.equal(engine.lastCandle.has("TESTUSDT"), false);
});

test("small-wallet sizing adapts to Binance leverage limits and keeps TP1 above minNotional", async () => {
  let marketOrderSubmitted = false;
  let leverageBracketChecked = false;
  let appliedLeverage = null;
  let storedPosition = null;
  let algoId = 0;
  const filters = {
    marketStepSize: 0.001, marketMinQty: 0.001,
    lotStepSize: 0.01, lotMinQty: 0.01,
    tickSize: 0.1, minNotional: 5
  };
  const exchange = {
    filters: new Map([["TESTUSDT", filters]]),
    positions: async () => marketOrderSubmitted
      ? [{ symbol: "TESTUSDT", entryPrice: 100, positionAmt: "0.072" }]
      : [],
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
    leverageBracket: async () => {
      leverageBracketChecked = true;
      return [{ symbol: "TESTUSDT", brackets: [{ notionalFloor: 0, notionalCap: 100000, initialLeverage: 10 }] }];
    },
    setMarginType: async () => {},
    setLeverage: async (_symbol, value) => { appliedLeverage = value; },
    newOrder: async order => {
      if (order.type === "MARKET") marketOrderSubmitted = true;
      return { status: "FILLED", avgPrice: 100, executedQty: order.quantity, orderId: 123 };
    },
    newAlgoOrder: async () => ({ algoId: ++algoId })
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    risk: { walletPercentPerTrade: 10, maxMarginPerTradeUsdt: 0, minMarginPerTradeUsdt: 0, maxActivePositions: 20 },
    binance: { leverage: 20, autoAdjustLeverageToBinanceLimit: true, marginType: "ISOLATED", workingType: "MARK_PRICE" },
    strategy: { tp1ClosePct: 70, rewardRiskTp1: 1.5, rewardRiskTp2: 2 },
    execution: { priceProtect: false }
  }, exchange, {
    getPosition: async () => null,
    getOpenPositions: async () => [],
    openPosition: async doc => { storedPosition = doc; },
    saveEvent: async () => {}
  }, { opened: async () => {} });

  const opened = await engine.openTrade("TESTUSDT", { side: "LONG", entry: 100, stop: 99 });
  assert.equal(opened, true);
  assert.equal(leverageBracketChecked, true);
  assert.equal(marketOrderSubmitted, true);
  assert.equal(appliedLeverage, 10);
  assert.ok(storedPosition);
  assert.equal(storedPosition.leverage, 10);
  assert.ok(storedPosition.margin > 0.7);
  assert.ok(storedPosition.margin < 0.8);
  assert.ok(storedPosition.tp1Quantity * storedPosition.tp1 >= filters.minNotional);
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
    account: async () => ({ totalWalletBalance: 3, availableBalance: 0.35 }),
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
    /ENTRY_REJECTED_TP1_MIN_NOTIONAL_INSUFFICIENT_BALANCE/
  );
  assert.equal(marketOrderSubmitted, false);
});

test("transient pre-entry failure leaves the same closed EMA9 signal candle eligible for retry", async () => {
  const bars = pullbackBars("LONG");
  const engine = new TradingEngine({ app: { logLevel: "silent" }, scanner: { batchSize: 10, batchDelayMs: 0 }, strategy: pullbackStrategy() },
    { positions: async () => [] }, { getPosition: async () => null, getSetup: async () => null, deleteSetup: async () => {} }, {});
  engine.running = true; engine.universe = ["TESTUSDT"]; engine.candles = async () => bars;
  engine.openTrade = async () => { const error = new Error("temporary Binance API timeout before order submission"); error.retrySignalCandle = true; throw error; };
  await engine.checkSignals();
  assert.equal(engine.lastCandle.has("TESTUSDT"), false);
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

test("symbol leverage bracket still rejects when automatic leverage adjustment is disabled", async () => {
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
    binance: { leverage: 20, autoAdjustLeverageToBinanceLimit: false, marginType: "ISOLATED" },
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

test("EMA bias is bullish when latest closed price is above the single EMA", async () => {
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    strategy: { emaBias: { enabled: true, timeframe: "4h", period: 20, historyCandles: 100 } }
  }, {}, {}, {});
  let requested = null;
  engine.candles = async (_symbol, interval, limit) => {
    requested = { interval, limit };
    return Array.from({ length: 100 }, (_, i) => ({ close: 100 + i, closeTime: Date.now() - 1000 }));
  };
  const bias = await engine.getEmaBias("TESTUSDT");
  assert.deepEqual(requested, { interval: "4h", limit: 100 });
  assert.equal(bias.direction, "LONG");
  assert.ok(bias.price > bias.ema);
});

test("EMA bias is bearish when latest closed price is below the single EMA", async () => {
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    strategy: { emaBias: { enabled: true, timeframe: "4h", period: 20, historyCandles: 100 } }
  }, {}, {}, {});
  engine.candles = async () => Array.from({ length: 100 }, (_, i) => ({ close: 200 - i, closeTime: Date.now() - 1000 }));
  const bias = await engine.getEmaBias("TESTUSDT");
  assert.equal(bias.direction, "SHORT");
  assert.ok(bias.price < bias.ema);
});

test("EMA bias is neutral when latest closed price equals the single EMA", async () => {
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    strategy: { emaBias: { enabled: true, timeframe: "4h", period: 20, historyCandles: 100 } }
  }, {}, {}, {});
  engine.candles = async () => Array.from({ length: 100 }, () => ({ close: 100, closeTime: Date.now() - 1000 }));
  const bias = await engine.getEmaBias("TESTUSDT");
  assert.equal(bias.direction, null);
});
