"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateClosedCandle, buildConfirmedEntry, checkBreakoutConfirmation } = require("../src/strategy");

const cfg = { strategy: {
  timeframe: "1h", rsiPeriod: 2,
  rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
  adx: { enabled: true, timeframe: "4h", period: 14, rangeMax: 20, mixedMax: 26, requireWeakCandleWhenDisabled: true },
  slBufferPct: .12, minStopDistancePct: .1, maxStopDistancePct: 5,
  rewardRiskTp1: 1.2, rewardRiskTp2: 1.8
} };

function shortBars() {
  const closes = [100, 101, 103, 101];
  const bars = closes.map((close, i) => ({ open: close - .1, high: close + .2, low: close - .2, close, closeTime: i + 1, openTime: i }));
  bars[3].open = 101.1;
  return bars;
}
function longBars() {
  const closes = [100, 99, 97, 99];
  const bars = closes.map((close, i) => ({ open: close + .1, high: close + .2, low: close - .2, close, closeTime: i + 1, openTime: i }));
  bars[3].open = 98.9;
  return bars;
}
const evaluate = (bars, adx = 15, strategy = cfg.strategy) => evaluateClosedCandle({ candles: bars, config: { strategy }, adx });
function makeSignal(side) {
  return { side, signalTime: 1000, signalHigh: 102, signalLow: 98, structureHigh: 102.5, structureLow: 97.5,
    rsi: side === "LONG" ? 40 : 60, previousRsi: side === "LONG" ? 20 : 80, adx: 15, regime: "RANGE", weakCandle: false };
}

test("SHORT signal requires RSI condition and a red signal candle", () => {
  const bars = shortBars(); const result = evaluate(bars);
  assert.equal(result.action, "SIGNAL"); assert.equal(result.side, "SHORT");
  assert.ok(result.rsi < 70); assert.ok(result.previousRsi >= 65);
  assert.equal(result.signalHigh, bars[3].high);
});
test("LONG signal requires RSI condition and a green signal candle", () => {
  const bars = longBars(); const result = evaluate(bars);
  assert.equal(result.action, "SIGNAL"); assert.equal(result.side, "LONG");
  assert.ok(result.rsi > 30); assert.ok(result.previousRsi <= 35);
  assert.equal(result.signalLow, bars[3].low);
});
test("RSI-valid SHORT candle with wrong color is discarded, not armed", () => {
  const bars = shortBars(); bars[3].open = 100.9;
  assert.equal(evaluate(bars).action, "WAIT");
  assert.equal(evaluate(bars).reason, "NO_TRIGGER");
});
test("RSI-valid LONG candle with wrong color is discarded, not armed", () => {
  const bars = longBars(); bars[3].open = 99.1;
  assert.equal(evaluate(bars).action, "WAIT");
  assert.equal(evaluate(bars).reason, "NO_TRIGGER");
});
test("a later valid candle becomes its own signal candle after a wrong-color candle", () => {
  const invalid = shortBars(); invalid[3].open = 100.9;
  assert.equal(evaluate(invalid).action, "WAIT");
  const next = shortBars(); next[3].openTime = 4; next[3].closeTime = 5; next[3].high = 105;
  const result = evaluate(next);
  assert.equal(result.action, "SIGNAL"); assert.equal(result.signalTime, 5);
  assert.equal(result.signalHigh, 105);
});
test("LONG confirms only on a subsequent close strictly above signal high", () => {
  const signal = makeSignal("LONG");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 102 }, elapsedCandles: 1, maxWaitCandles: 3 }).status, "WAIT");
  const check = checkBreakoutConfirmation({ signal, candle: { close: 102.01 }, elapsedCandles: 1, maxWaitCandles: 3 });
  assert.equal(check.status, "CONFIRMED");
});
test("SHORT confirms only on a subsequent close strictly below signal low", () => {
  const signal = makeSignal("SHORT");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 98 }, elapsedCandles: 1, maxWaitCandles: 3 }).status, "WAIT");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 97.99 }, elapsedCandles: 1, maxWaitCandles: 3 }).status, "CONFIRMED");
});
test("confirmation candle color is irrelevant; only its close beyond the level matters", () => {
  const signal = makeSignal("SHORT");
  const greenConfirmation = { open: 97, close: 97.9 };
  assert.ok(greenConfirmation.close < signal.signalLow);
  assert.equal(checkBreakoutConfirmation({ signal, candle: greenConfirmation, elapsedCandles: 2, maxWaitCandles: 3 }).status, "CONFIRMED");
});
test("wick-only breakout is not confirmed when the candle closes back inside", () => {
  const signal = makeSignal("LONG");
  const candle = { open: 101, high: 103, low: 100, close: 101.9 };
  assert.equal(checkBreakoutConfirmation({ signal, candle, elapsedCandles: 1, maxWaitCandles: 3 }).status, "WAIT");
});
test("the final configured wait candle is eligible for confirmation", () => {
  const signal = makeSignal("LONG");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 102.1 }, elapsedCandles: 3, maxWaitCandles: 3 }).status, "CONFIRMED");
});
test("pending setup expires only after the configured wait count has passed", () => {
  const signal = makeSignal("LONG");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 101 }, elapsedCandles: 3, maxWaitCandles: 3 }).status, "WAIT");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 103 }, elapsedCandles: 4, maxWaitCandles: 3 }).status, "EXPIRED");
});
test("signal candle cannot confirm itself", () => {
  const signal = makeSignal("LONG");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 103 }, elapsedCandles: 0, maxWaitCandles: 3 }).status, "WAIT");
});
test("confirmed entry keeps two-candle structural SL and configured TP ratios", () => {
  const short = buildConfirmedEntry({ signal: makeSignal("SHORT"), candle: { close: 97.99, closeTime: 2000 }, config: { strategy: cfg.strategy } });
  const long = buildConfirmedEntry({ signal: makeSignal("LONG"), candle: { close: 102.01, closeTime: 2000 }, config: { strategy: cfg.strategy } });
  assert.equal(short.action, "ENTRY"); assert.equal(long.action, "ENTRY");
  assert.ok(short.stop > 102.5); assert.ok(long.stop < 97.5);
  assert.ok(short.tp1 < short.entry && short.tp2 < short.tp1);
  assert.ok(long.tp1 > long.entry && long.tp2 > long.tp1);
});
test("MIXED still requires a weaker signal candle", () => {
  const bars = shortBars(); bars[3].high = 101.15; bars[3].low = 100.95;
  const result = evaluate(bars, 20);
  assert.equal(result.action, "SIGNAL"); assert.equal(result.regime, "MIXED"); assert.equal(result.weakCandle, true);
});
test("ADX above mixedMax blocks signal creation", () => {
  const result = evaluate(shortBars(), 26.0001);
  assert.equal(result.action, "WAIT"); assert.equal(result.reason, "ADX_MOMENTUM_BLOCK");
});

test("RANGE does not require a weak signal candle", () => {
  const bars = shortBars(); bars[3].high = 104; bars[3].low = 100;
  const result = evaluate(bars, 15);
  assert.equal(result.action, "SIGNAL"); assert.equal(result.weakCandle, false);
});
test("MIXED blocks a signal when the signal candle is not weaker than T-1", () => {
  const bars = shortBars(); bars[3].high = 103; bars[3].low = 99;
  const result = evaluate(bars, 23);
  assert.equal(result.action, "WAIT"); assert.equal(result.reason, "WEAK_CANDLE_REQUIRED");
});
test("ADX exactly at mixedMax is MIXED while values above it block signals", () => {
  const bars = shortBars(); bars[3].high = 101.15; bars[3].low = 100.95;
  assert.equal(evaluate(bars, 26).regime, "MIXED");
  const blocked = evaluate(bars, 26.0001);
  assert.equal(blocked.action, "WAIT"); assert.equal(blocked.reason, "ADX_MOMENTUM_BLOCK");
});
test("ADX enabled but unavailable fails closed", () => {
  const result = evaluate(shortBars(), null);
  assert.equal(result.action, "WAIT"); assert.equal(result.reason, "ADX_UNAVAILABLE");
});
test("ADX disabled keeps the configured weak-candle requirement", () => {
  const bars = shortBars(); bars[3].high = 104; bars[3].low = 100;
  const disabled = { ...cfg.strategy, adx: { ...cfg.strategy.adx, enabled: false } };
  assert.equal(evaluate(bars, null, disabled).reason, "WEAK_CANDLE_REQUIRED");
  disabled.adx.requireWeakCandleWhenDisabled = false;
  assert.equal(evaluate(bars, null, disabled).action, "SIGNAL");
});
test("maximum stop-distance filter is applied to the saved two-candle structure", () => {
  const signal = { ...makeSignal("SHORT"), structureHigh: 110 };
  const result = buildConfirmedEntry({ signal, candle: { close: 97.99, closeTime: 2000 }, config: { strategy: cfg.strategy } });
  assert.equal(result.action, "WAIT"); assert.equal(result.reason, "STOP_TOO_WIDE");
});
