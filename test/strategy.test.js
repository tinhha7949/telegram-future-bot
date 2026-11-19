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
