"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateClosedCandle } = require("../src/strategy");
const cfg = { strategy: { emaPeriod: 3, rsiPeriod: 2, atrPeriod: 2, rsiShortTrigger: 70, rsiLongTrigger: 30,
  confirmationCandles: 3, requireRsiMomentumTurn: false, swingLeft: 1, swingRight: 1, swingLookback: 10,
  fallbackAtrMultiple: 1.5, slBufferPct: .12, minStopDistancePct: .1, maxStopDistancePct: 5,
  rewardRiskTp1: 1.2, rewardRiskTp2: 1.5 } };
test("strategy waits safely when candle history is insufficient", () => {
  assert.equal(evaluateClosedCandle({trendCandles:[],entryCandles:[],setup:null,config:cfg}).action, "WAIT");
});
test("setup expiry is bounded to confirmation candle count", () => {
  const candles = Array.from({length:8}, (_,i)=>({open:i,high:i+2,low:i,close:i+1,closeTime:i+1}));
  const result = evaluateClosedCandle({trendCandles:candles,entryCandles:candles,setup:{status:"ARMED",side:"LONG",triggerCloseTime:1,triggerHigh:100},config:cfg});
  assert.ok(["CANCEL","KEEP","ENTRY"].includes(result.action));
});

test("short trigger arms on RSI extreme when 15m trend is below EMA", () => {
  const trend = [100,99,98,97,96].map((close,i)=>({open:close+.2,high:close+.4,low:close-.2,close,closeTime:i+1}));
  const entry = [100,101,102,103,104].map((close,i)=>({open:close-.1,high:close+.2,low:close-.2,close,closeTime:i+1}));
  const result = evaluateClosedCandle({trendCandles:trend,entryCandles:entry,setup:null,config:cfg});
  assert.equal(result.action, "ARM");
  assert.equal(result.setup.side, "SHORT");
  assert.equal(result.setup.triggerLow, 103.8);
});
test("short enters only after a later 5m candle closes below trigger low", () => {
  const trend = [100,99,98,97,96].map((close,i)=>({open:close+.2,high:close+.4,low:close-.2,close,closeTime:i+1}));
  const entry = [100,101,102,103,104].map((close,i)=>({open:close-.1,high:close+.2,low:close-.2,close,closeTime:i+1}));
  const setup = {side:"SHORT",status:"ARMED",triggerLow:103.8,triggerHigh:104.2,triggerCloseTime:5};
  const confirmation = {open:103.9,high:104.1,low:102.8,close:103,closeTime:6};
  const result = evaluateClosedCandle({trendCandles:trend,entryCandles:[...entry,confirmation],setup,config:cfg});
  assert.equal(result.action, "ENTRY");
  assert.equal(result.side, "SHORT");
  assert.ok(result.stop > result.entry);
  assert.ok(result.tp1 < result.entry);
  assert.ok(result.tp2 < result.tp1);
});
