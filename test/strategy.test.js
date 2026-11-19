"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateClosedCandle } = require("../src/strategy");
const cfg = { strategy: { emaPeriod: 3, rsiPeriod: 2, atrPeriod: 2,
  rsiShortMin: 70, rsiShortMax: 75, rsiLongMin: 25, rsiLongMax: 30,
  confirmationCandles: 3, requireRsiMomentumTurn: false, swingLeft: 1, swingRight: 1, swingLookback: 10,
  fallbackAtrMultiple: 1.5, slBufferPct: .12, minStopDistancePct: .1, maxStopDistancePct: 5,
  rewardRiskTp1: 1.2, rewardRiskTp2: 1.5 } };
const candles = (closes, start = 1) => closes.map((close, i) => ({
  open: close - .1, high: close + .2, low: close - .2, close, closeTime: start + i
}));
test("strategy waits safely when candle history is insufficient", () => {
  assert.equal(evaluateClosedCandle({trendCandles:[],entryCandles:[],setup:null,config:cfg}).action, "WAIT");
});
test("setup expiry is bounded to confirmation candle count", () => {
  const bars = candles([1,2,3,4,5,6,7,8]);
  const result = evaluateClosedCandle({trendCandles:bars,entryCandles:bars,setup:{status:"ARMED",side:"LONG",triggerCloseTime:1,triggerHigh:100},config:cfg});
  assert.ok(["CANCEL","KEEP","ENTRY"].includes(result.action));
});

test("short trigger arms only inside RSI 70-75 when 15m trend is below EMA", () => {
  const trend = candles([100,99,98,97,96]);
  const entry = candles([100,98,96,97,99]);
  const result = evaluateClosedCandle({trendCandles:trend,entryCandles:entry,setup:null,config:cfg});
  assert.equal(result.action, "ARM");
  assert.equal(result.setup.side, "SHORT");
  assert.equal(result.rsi, 71.42857142857143);
  assert.equal(result.setup.triggerLow, 98.8);
});
test("long trigger arms only inside RSI 25-30 when 15m trend is above EMA", () => {
  const trend = candles([96,97,98,99,100]);
  const entry = candles([100,102,104,103,101]);
  const result = evaluateClosedCandle({trendCandles:trend,entryCandles:entry,setup:null,config:cfg});
  assert.equal(result.action, "ARM");
  assert.equal(result.setup.side, "LONG");
  assert.equal(result.rsi, 28.57142857142857);
});
test("RSI outside the configured trigger zones does not arm a setup", () => {
  const trend = candles([100,99,98,97,96]);
  const entry = candles([100,101,102,103,104]);
  const result = evaluateClosedCandle({trendCandles:trend,entryCandles:entry,setup:null,config:cfg});
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "NO_TRIGGER");
});
test("short enters only after a later 5m candle closes below trigger low", () => {
  const trend = candles([100,99,98,97,96]);
  const entry = candles([100,98,96,97,99]);
  const setup = {side:"SHORT",status:"ARMED",triggerLow:98.8,triggerHigh:99.2,triggerCloseTime:5};
  const confirmation = candles([98], 6)[0];
  const result = evaluateClosedCandle({trendCandles:trend,entryCandles:[...entry,confirmation],setup,config:cfg});
  assert.equal(result.action, "ENTRY");
  assert.equal(result.side, "SHORT");
  assert.ok(result.stop > result.entry);
  assert.ok(result.tp1 < result.entry);
  assert.ok(result.tp2 < result.tp1);
});
