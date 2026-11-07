"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  atr, rsiSeries, pivots, detectDivergence,
  findSweepAndConfirmation, marketVeto, coreLogic
} = require("./coreLogic");
const { loadSimpleConfig } = require("./simple-config");
const { buildProtection, splitQuantity } = require("./tpsl");

const C = loadSimpleConfig();
const NOW = 2000000000000;

function makeCandles(length, step = 60000) {
  return Array.from({ length }, (_, i) => ({
    open: 100, high: 102, low: 95, close: 100,
    closeTime: NOW - (length - i) * step
  }));
}

test("strategy config has one adjustable timeframe and no legacy 4H/1H entry settings", () => {
  assert.equal(C.STRATEGY_TIMEFRAME, "15m");
  assert.equal(Object.hasOwn(C, "TREND_TIMEFRAME"), false);
  assert.equal(Object.hasOwn(C, "CONFIRMATION_TIMEFRAME"), false);
  assert.equal(Object.hasOwn(C, "ENTRY_TIMEFRAME"), false);
  assert.equal(C.RSI_PERIOD, 14);
  assert.equal(C.PIVOT_LEFT_BARS, 2);
  assert.equal(C.PIVOT_RIGHT_BARS, 2);
  assert.equal(C.RSI_PIVOT_MATCH_TOLERANCE, 2);
});

test("strategy timeframe can be changed through CONFIG.yaml without changing tests", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "CONFIG.yaml"), "utf8");
  const customSource = source.replace(/^STRATEGY_TIMEFRAME:.*$/m, 'STRATEGY_TIMEFRAME: "5m"');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "single-timeframe-config-"));
  const file = path.join(dir, "CONFIG.yaml");
  try {
    fs.writeFileSync(file, customSource);
    assert.equal(loadSimpleConfig(file).STRATEGY_TIMEFRAME, "5m");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ATR and RSI series produce finite indicator values after warmup", () => {
  const candles = Array.from({ length: 100 }, (_, i) => {
    const close = 100 + i * 0.1 + Math.sin(i / 3);
    return { open: close, high: close + 0.5, low: close - 0.5, close, closeTime: NOW - (100 - i) * 60000 };
  });
  assert.ok(atr(candles, C.ATR_PERIOD) > 0);
  assert.ok(Number.isFinite(rsiSeries(candles, C.RSI_PERIOD).at(-1)));
});

test("confirmed pivots and regular bullish divergence use the latest two confirmed lows", () => {
  const candles = makeCandles(31);
  candles[20].low = 90;
  candles[28].low = 88;
  const rsi = Array(31).fill(50);
  rsi[20] = 25;
  rsi[28] = 31;
  const found = detectDivergence(candles, {
    PIVOT_LEFT_BARS: 2, PIVOT_RIGHT_BARS: 2,
    MIN_PIVOT_DISTANCE: 5, MAX_PIVOT_DISTANCE: 40, RSI_PERIOD: 14
  }, rsi);
  assert.equal(found.direction, 1);
  assert.equal(found.type, "REGULAR_BULLISH");
  assert.equal(found.pivotIndex, 28);
  assert.equal(found.confirmIndex, 30);
  assert.equal(found.referencePrice, 90);
});

test("does not reuse an older divergence when newest two confirmed pivots do not diverge",()=>{
 const candles=makeCandles(40);candles[10].low=90;candles[20].low=88;candles[30].low=85;
 const rsi=Array(40).fill(50);rsi[10]=20;rsi[20]=30;rsi[30]=25;
 const found=detectDivergence(candles,{PIVOT_LEFT_BARS:2,PIVOT_RIGHT_BARS:2,MIN_PIVOT_DISTANCE:5,MAX_PIVOT_DISTANCE:40,RSI_PERIOD:14},rsi);
 assert.equal(found,null);
});

test("RSI pivot can be a few candles away from its matching price pivot", () => {
  const candles = makeCandles(36);
  candles[20].low = 90;
  candles[28].low = 88;
  const rsi = Array(36).fill(50);
  rsi[19] = 24;
  rsi[27] = 32;
  const found = detectDivergence(candles, {
    PIVOT_LEFT_BARS: 2, PIVOT_RIGHT_BARS: 2, RSI_PIVOT_LEFT_BARS: 2, RSI_PIVOT_RIGHT_BARS: 2,
    RSI_PIVOT_MATCH_TOLERANCE: 1, MIN_DIVERGENCE_RSI_DELTA: 3, MIN_DIVERGENCE_PRICE_PCT: 0.15,
    MIN_RSI_PIVOT_PROMINENCE: 1, MIN_PIVOT_DISTANCE: 5, MAX_PIVOT_DISTANCE: 40
  }, rsi);
  assert.equal(found?.type, "REGULAR_BULLISH");
  assert.equal(found?.pivotIndex, 28);
  assert.equal(found?.confirmIndex, 30);
});

test("divergence waits for the RSI pivot to be fully confirmed, even when price pivot confirms earlier", () => {
  const candles = makeCandles(33);
  candles[20].low = 90;
  candles[28].low = 88;
  const rsi = Array(33).fill(50);
  rsi[20] = 25;
  rsi[30] = 32;
  const config = {
    PIVOT_LEFT_BARS: 2, PIVOT_RIGHT_BARS: 2, RSI_PIVOT_LEFT_BARS: 2, RSI_PIVOT_RIGHT_BARS: 2,
    RSI_PIVOT_MATCH_TOLERANCE: 2, MIN_DIVERGENCE_RSI_DELTA: 3, MIN_DIVERGENCE_PRICE_PCT: 0.15,
    MIN_RSI_PIVOT_PROMINENCE: 1, MIN_PIVOT_DISTANCE: 5, MAX_PIVOT_DISTANCE: 40
  };
  const found = detectDivergence(candles, config, rsi);
  assert.equal(found?.type, "REGULAR_BULLISH");
  assert.equal(found?.pivotIndex, 28);
  assert.equal(found?.confirmIndex, 32);

  const notYetClosed = detectDivergence(candles.slice(0, 32), config, rsi.slice(0, 32));
  assert.equal(notYetClosed, null);
});

test("weak divergence below configured RSI or price separation is rejected", () => {
  const candles = makeCandles(31);
  candles[20].low = 90;
  candles[28].low = 89.95;
  const rsi = Array(31).fill(50);
  rsi[20] = 30;
  rsi[28] = 31;
  const found = detectDivergence(candles, {
    PIVOT_LEFT_BARS: 2, PIVOT_RIGHT_BARS: 2, RSI_PIVOT_LEFT_BARS: 2, RSI_PIVOT_RIGHT_BARS: 2,
    RSI_PIVOT_MATCH_TOLERANCE: 0, MIN_DIVERGENCE_RSI_DELTA: 3, MIN_DIVERGENCE_PRICE_PCT: 0.15,
    MIN_RSI_PIVOT_PROMINENCE: 1, MIN_PIVOT_DISTANCE: 5, MAX_PIVOT_DISTANCE: 40
  }, rsi);
  assert.equal(found, null);
});

test("regular bearish divergence is detected using independent RSI high pivots", () => {
  const candles = makeCandles(31);
  candles[20].high = 110;
  candles[28].high = 112;
  const rsi = Array(31).fill(50);
  rsi[20] = 75;
  rsi[28] = 68;
  const found = detectDivergence(candles, {
    PIVOT_LEFT_BARS: 2, PIVOT_RIGHT_BARS: 2, RSI_PIVOT_LEFT_BARS: 2, RSI_PIVOT_RIGHT_BARS: 2,
    RSI_PIVOT_MATCH_TOLERANCE: 0, MIN_DIVERGENCE_RSI_DELTA: 3, MIN_DIVERGENCE_PRICE_PCT: 0.15,
    MIN_RSI_PIVOT_PROMINENCE: 1, MIN_PIVOT_DISTANCE: 5, MAX_PIVOT_DISTANCE: 40
  }, rsi);
  assert.equal(found?.direction, -1);
  assert.equal(found?.type, "REGULAR_BEARISH");
});


test("hidden bullish divergence is detected from a higher price low and lower RSI low", () => {
  const candles = makeCandles(31);
  candles[20].low = 90;
  candles[28].low = 92;
  const rsi = Array(31).fill(50);
  rsi[20] = 30;
  rsi[28] = 24;
  const found = detectDivergence(candles, {
    PIVOT_LEFT_BARS: 2, PIVOT_RIGHT_BARS: 2, RSI_PIVOT_LEFT_BARS: 2, RSI_PIVOT_RIGHT_BARS: 2,
    RSI_PIVOT_MATCH_TOLERANCE: 0, MIN_DIVERGENCE_RSI_DELTA: 3, MIN_DIVERGENCE_PRICE_PCT: 0.15,
    MIN_RSI_PIVOT_PROMINENCE: 1, MIN_PIVOT_DISTANCE: 5, MAX_PIVOT_DISTANCE: 40
  }, rsi);
  assert.equal(found?.direction, 1);
  assert.equal(found?.type, "HIDDEN_BULLISH");
});

test("hidden bearish divergence is detected from a lower price high and higher RSI high", () => {
  const candles = makeCandles(31);
  candles[20].high = 110;
  candles[28].high = 108;
  const rsi = Array(31).fill(50);
  rsi[20] = 70;
  rsi[28] = 78;
  const found = detectDivergence(candles, {
    PIVOT_LEFT_BARS: 2, PIVOT_RIGHT_BARS: 2, RSI_PIVOT_LEFT_BARS: 2, RSI_PIVOT_RIGHT_BARS: 2,
    RSI_PIVOT_MATCH_TOLERANCE: 0, MIN_DIVERGENCE_RSI_DELTA: 3, MIN_DIVERGENCE_PRICE_PCT: 0.15,
    MIN_RSI_PIVOT_PROMINENCE: 1, MIN_PIVOT_DISTANCE: 5, MAX_PIVOT_DISTANCE: 40
  }, rsi);
  assert.equal(found?.direction, -1);
  assert.equal(found?.type, "HIDDEN_BEARISH");
});

test("hidden bullish and bearish divergence can pass the full live-entry sequence", () => {
  const config = {
    ...C,
    HISTORY_CANDLES: 300,
    MIN_PIVOT_DISTANCE: 5,
    MAX_PIVOT_DISTANCE: 40,
    RSI_PIVOT_MATCH_TOLERANCE: 0,
    MIN_DIVERGENCE_RSI_DELTA: 3,
    MIN_DIVERGENCE_PRICE_PCT: 0.15,
    MIN_RSI_PIVOT_PROMINENCE: 1,
    SWEEP_MAX_WAIT_BARS: 20,
    SWEEP_MIN_ATR: 0.05,
    CONFIRMATION_MAX_BARS: 3
  };

  // Hidden bullish: price makes a higher low (90 -> 92), RSI makes a lower low (30 -> 24).
  const bullishCandles = makeCandles(70);
  bullishCandles[45].low = 90;
  bullishCandles[55].low = 92;
  bullishCandles[58] = { ...bullishCandles[58], open: 92.5, high: 94, low: 91.5, close: 93 };
  bullishCandles[59] = { ...bullishCandles[59], open: 93, high: 96, low: 92.8, close: 95 };
  const bullishRsi = Array(70).fill(50);
  bullishRsi[45] = 30;
  bullishRsi[55] = 24;
  const bullish = coreLogic({ candles: bullishCandles, config, now: NOW, rsiOverride: bullishRsi });
  assert.equal(bullish.side, "LONG");
  assert.equal(bullish.divergenceType, "HIDDEN_BULLISH");
  assert.equal(bullish.sweepReferencePrice, 92);

  // Hidden bearish: price makes a lower high (110 -> 108), RSI makes a higher high (70 -> 78).
  const bearishCandles = makeCandles(70);
  bearishCandles[45].high = 110;
  bearishCandles[55].high = 108;
  bearishCandles[58] = { ...bearishCandles[58], open: 108.2, high: 108.5, low: 106.5, close: 107.5 };
  bearishCandles[59] = { ...bearishCandles[59], open: 107, high: 107.2, low: 105, close: 105.5 };
  const bearishRsi = Array(70).fill(50);
  bearishRsi[45] = 70;
  bearishRsi[55] = 78;
  const bearish = coreLogic({ candles: bearishCandles, config, now: NOW, rsiOverride: bearishRsi });
  assert.equal(bearish.side, "SHORT");
  assert.equal(bearish.divergenceType, "HIDDEN_BEARISH");
  assert.equal(bearish.sweepReferencePrice, 108);
});

test("liquidity sweep must reclaim the reference and then get a candle close beyond the sweep high", () => {
  const candles = makeCandles(32);
  candles[30] = { ...candles[30], open: 90.5, high: 92, low: 89, close: 91 };
  candles[31] = { ...candles[31], open: 91, high: 94, low: 90.8, close: 93 };
  const atrValues = Array(32).fill(0.5);
  const result = findSweepAndConfirmation(candles, {
    direction: 1, confirmIndex: 30, referencePrice: 90
  }, { SWEEP_MAX_WAIT_BARS: 20, SWEEP_MIN_ATR: 0.05, CONFIRMATION_MAX_BARS: 3 }, atrValues);
  assert.equal(result.confirmed, true);
  assert.equal(result.sweep.low, 89);
  assert.equal(result.confirmation.close, 93);
});

test("sweep during divergence pivot confirmation is retained; no second sweep is required", () => {
  const candles = makeCandles(32);
  // Pivot at 28; the sweep/reclaim happens at 29, before divergence confirms at 30.
  candles[29] = { ...candles[29], open: 90.5, high: 92, low: 89, close: 91 };
  // After divergence confirmation, price confirms above the already-recorded sweep high.
  candles[31] = { ...candles[31], open: 91, high: 94, low: 90.8, close: 93 };
  const atrValues = Array(32).fill(0.5);
  const result = findSweepAndConfirmation(candles, {
    direction: 1, pivotIndex: 28, confirmIndex: 30, referencePrice: 90
  }, { SWEEP_MAX_WAIT_BARS: 20, SWEEP_MIN_ATR: 0.05, CONFIRMATION_MAX_BARS: 3 }, atrValues);
  assert.equal(result.confirmed, true);
  assert.equal(result.sweep.index, 29);
  assert.equal(result.sweep.low, 89);
  assert.equal(result.confirmation.close, 93);
});

test("confirmation before divergence confirmation cannot trigger an entry", () => {
  const candles = makeCandles(32);
  candles[29] = { ...candles[29], open: 90.5, high: 92, low: 89, close: 91 };
  // This candle breaks the sweep high, but divergence is not confirmed until 30.
  candles[30] = { ...candles[30], open: 91, high: 94, low: 90.8, close: 93 };
  // No later confirmation candle yet.
  const atrValues = Array(32).fill(0.5);
  const result = findSweepAndConfirmation(candles.slice(0, 31), {
    direction: 1, pivotIndex: 28, confirmIndex: 30, referencePrice: 90
  }, { SWEEP_MAX_WAIT_BARS: 20, SWEEP_MIN_ATR: 0.05, CONFIRMATION_MAX_BARS: 3 }, atrValues.slice(0, 31));
  assert.equal(result.confirmed, undefined);
  assert.equal(result.reason, "WAITING_CONFIRMATION");
});

test("SL is anchored beyond the sweep extreme with the MT5 ATR/percent buffer; TP formulas remain config-driven", () => {
  const config = {
    STRATEGY_TIMEFRAME: "15m", SL_ATR_BUFFER: 0.2, SL_MIN_BUFFER_PERCENT: 0.1,
    MAX_SL_ATR: 3, TP1_REWARD_RISK: 1.2, TP2_REWARD_RISK: 1.5,
    TP1_CLOSE_PERCENT: 60, TP2_CLOSE_PERCENT: 40
  };
  const long = buildProtection({ side: "LONG", entryPrice: 100, atrValue: 1, pivotPrice: 98.5, config, priceTick: 0.01 });
  const short = buildProtection({ side: "SHORT", entryPrice: 100, atrValue: 1, pivotPrice: 101.5, config, priceTick: 0.01 });
  assert.equal(long.buffer, 0.2);
  assert.equal(long.sl, 98.3);
  assert.equal(long.tp1, 102.04);
  assert.equal(long.tp2, 102.55);
  assert.equal(short.sl, 101.7);
  assert.equal(short.tp1, 97.96);
  assert.equal(short.tp2, 97.45);
  assert.equal(long.stopMethod, "15M_LIQUIDITY_SWEEP");
  assert.throws(() => buildProtection({ side: "LONG", entryPrice: 100, atrValue: 1, pivotPrice: 97.1, config, priceTick: 0.01 }), /BLOCKED_SL_TOO_WIDE/);
});

test("existing Binance TP quantity split remains unchanged", () => {
  const split = splitQuantity({
    quantity: 1, stepSize: 0.01, minQty: 0.01,
    config: { TP1_CLOSE_PERCENT: 60, TP2_CLOSE_PERCENT: 40 }
  });
  assert.deepEqual(split, { total: 1, tp1: 0.6, tp2: 0.4 });
});

test("funding and spread vetoes retain the existing Binance safeguards", () => {
  const config = { MAX_ABS_FUNDING_RATE: 0.0005, MAX_SPREAD_BPS: 10 };
  assert.equal(marketVeto({ side: "LONG", fundingRate: 0.0006, bidPrice: 100, askPrice: 100, config }).reason, "FUNDING_TOO_HOT");
  assert.equal(marketVeto({ side: "SHORT", fundingRate: -0.0006, bidPrice: 100, askPrice: 100, config }).reason, "FUNDING_TOO_HOT");
  assert.equal(marketVeto({ side: "LONG", fundingRate: -0.0006, bidPrice: 100, askPrice: 100, config }).allowed, true);
  assert.equal(marketVeto({ side: "LONG", fundingRate: 0, bidPrice: 100, askPrice: 101, config }).reason, "SPREAD_TOO_WIDE");
});

test("core logic never emits an entry without enough closed single-timeframe history", () => {
  const signal = coreLogic({ candles: makeCandles(40), config: C, now: NOW });
  assert.equal(signal.side, null);
  assert.equal(signal.reason, "INSUFFICIENT_CLOSED_CANDLES");
});
