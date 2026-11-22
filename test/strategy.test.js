"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateClosedCandle } = require("../src/strategy");

const cfg = { strategy: {
  timeframe: "1h",
  rsiPeriod: 2,
  rsiShortMin: 65,
  rsiShortMax: 70,
  rsiLongMin: 30,
  rsiLongMax: 35,
  adx: {
    enabled: true,
    timeframe: "4h",
    period: 14,
    rangeMax: 20,
    mixedMax: 26,
    requireWeakCandleWhenDisabled: true
  },
  slBufferPct: .12,
  minStopDistancePct: .1,
  maxStopDistancePct: 5,
  rewardRiskTp1: 1.2,
  rewardRiskTp2: 1.8
} };

function shortBars() {
  const closes = [100, 101, 103, 102];
  const bars = closes.map((close, i) => ({
    open: close - .1, high: close + .2, low: close - .2, close, closeTime: i + 1
  }));
  bars[3].open = 102.1; // T must be a red candle.
  return bars;
}
function longBars() {
  const closes = [100, 99, 97, 98];
  const bars = closes.map((close, i) => ({
    open: close + .1, high: close + .2, low: close - .2, close, closeTime: i + 1
  }));
  bars[3].open = 97.9; // T must be a green candle.
  return bars;
}
const evaluate = (bars, adx = 15, strategy = cfg.strategy) =>
  evaluateClosedCandle({ candles: bars, config: { strategy }, adx });

test("SHORT enters when RSI leaves the upper zone on a red candle in RANGE", () => {
  const bars = shortBars();
  const result = evaluate(bars, 19.99);
  assert.equal(result.action, "ENTRY");
  assert.equal(result.side, "SHORT");
  assert.ok(result.rsi < 70);
  assert.ok(result.previousRsi >= 65);
  assert.equal(result.regime, "RANGE");
  assert.ok(result.stop > bars[2].high);
  assert.equal(result.entry, bars[3].close);
});
test("LONG enters when RSI leaves the lower zone on a green candle in RANGE", () => {
  const bars = longBars();
  const result = evaluate(bars, 12);
  assert.equal(result.action, "ENTRY");
  assert.equal(result.side, "LONG");
  assert.ok(result.rsi > 30);
  assert.ok(result.previousRsi <= 35);
  assert.equal(result.regime, "RANGE");
  assert.ok(result.stop < bars[2].low);
});
test("RANGE does not require the weak-candle condition", () => {
  const bars = shortBars();
  bars[3].high = 104;
  bars[3].low = 100; // Current range is wider than T-1.
  const result = evaluate(bars, 15);
  assert.equal(result.action, "ENTRY");
  assert.equal(result.weakCandle, false);
});
test("MIXED requires the current candle range to be smaller than T-1", () => {
  const bars = shortBars();
  bars[3].high = 102.1;
  bars[3].low = 101.9;
  const result = evaluate(bars, 20);
  assert.equal(result.action, "ENTRY");
  assert.equal(result.regime, "MIXED");
  assert.equal(result.weakCandle, true);
});
test("MIXED blocks a signal when the confirmation candle is not weaker", () => {
  const bars = shortBars();
  bars[3].high = 104;
  bars[3].low = 100;
  const result = evaluate(bars, 23);
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "WEAK_CANDLE_REQUIRED");
});
test("ADX exactly at mixedMax remains MIXED and values above it block entries", () => {
  const bars = shortBars();
  bars[3].high = 102.1;
  bars[3].low = 101.9;
  assert.equal(evaluate(bars, 26).regime, "MIXED");
  const blocked = evaluate(bars, 26.0001);
  assert.equal(blocked.action, "WAIT");
  assert.equal(blocked.reason, "ADX_MOMENTUM_BLOCK");
});
test("ADX enabled but unavailable fails closed without opening a trade", () => {
  const result = evaluate(shortBars(), null);
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "ADX_UNAVAILABLE");
});
test("ADX can be disabled and the weak-candle requirement remains configurable", () => {
  const bars = shortBars();
  bars[3].high = 104;
  bars[3].low = 100;
  const disabled = { ...cfg.strategy, adx: { ...cfg.strategy.adx, enabled: false } };
  assert.equal(evaluate(bars, null, disabled).reason, "WEAK_CANDLE_REQUIRED");
  disabled.adx.requireWeakCandleWhenDisabled = false;
  assert.equal(evaluate(bars, null, disabled).action, "ENTRY");
});
test("RSI leaving the zone without the required candle color does not enter", () => {
  const bars = shortBars();
  bars[3].open = 101.9; // Green instead of red.
  assert.equal(evaluate(bars, 15).action, "WAIT");
});
test("SL is anchored beyond the previous candle extreme and TP RR settings remain configurable", () => {
  const bars = shortBars();
  const result = evaluate(bars, 15);
  const risk = result.stop - result.entry;
  assert.ok(result.stop > bars[2].high);
  assert.ok(Math.abs(result.tp1 - (result.entry - risk * cfg.strategy.rewardRiskTp1)) < 1e-9);
  assert.ok(Math.abs(result.tp2 - (result.entry - risk * cfg.strategy.rewardRiskTp2)) < 1e-9);
});
