"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateClosedCandle } = require("../src/strategy");

const cfg = { strategy: {
  timeframe: "15m", rsiPeriod: 2, atrPeriod: 2, maxConfirmationCandles: 3,
  rsiShortMin: 65, rsiShortMax: 70, rsiLongMin: 30, rsiLongMax: 35,
  swingLeft: 1, swingRight: 1, swingLookback: 10,
  fallbackAtrMultiple: 1.5, slBufferPct: .12, minStopDistancePct: .1, maxStopDistancePct: 5,
  rewardRiskTp1: 1.5, rewardRiskTp2: 2
} };
const candles = (closes, start = 1) => closes.map((close, i) => ({
  open: close - .1, high: close + .2, low: close - .2, close, closeTime: start + i
}));
const evaluate = (bars, setup = null) => evaluateClosedCandle({ candles: bars, setup, config: cfg });

test("waits safely when same-timeframe candle history is insufficient", () => {
  assert.equal(evaluate([]).action, "WAIT");
});
test("SHORT candidate arms only when closed-candle RSI is inside 65-70 inclusive", () => {
  const bars = candles([100, 102, 101]);
  const result = evaluate(bars);
  assert.equal(result.action, "ARM");
  assert.equal(result.setup.side, "SHORT");
  assert.equal(result.setup.triggerHigh, 101.2);
});
test("LONG candidate arms only when closed-candle RSI is inside 30-35 inclusive", () => {
  const bars = candles([100, 98, 99]);
  const result = evaluate(bars);
  assert.equal(result.action, "ARM");
  assert.equal(result.setup.side, "LONG");
});
test("RSI outside both exact candidate zones does not arm a setup", () => {
  const result = evaluate(candles([100, 101, 102]));
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "NO_TRIGGER");
});
test("both candidate RSI zones include their exact configured boundaries", () => {
  for (const closes of [[100, 113, 106], [100, 107, 104]]) {
    assert.equal(evaluate(candles(closes)).setup.side, "SHORT");
  }
  for (const closes of [[100, 93, 96], [100, 107, 94]]) {
    assert.equal(evaluate(candles(closes)).setup.side, "LONG");
  }
});
test("SHORT enters when RSI is below 65 and close is below the signal-candle midpoint", () => {
  const signalBars = candles([100, 102, 101]);
  const armed = evaluate(signalBars);
  const confirmation = candles([98], 4)[0];
  const result = evaluate([...signalBars, confirmation], armed.setup);
  assert.equal(result.action, "ENTRY");
  assert.equal(result.side, "SHORT");
  assert.equal(result.entry, confirmation.close);
  assert.ok(result.stop > result.entry);
  assert.ok(result.tp1 < result.entry);
  assert.ok(result.tp2 < result.tp1);
});
test("LONG enters when RSI is above 35 and close is above the signal-candle midpoint", () => {
  const signalBars = candles([100, 98, 99]);
  const armed = evaluate(signalBars);
  const confirmation = candles([102], 4)[0];
  const result = evaluate([...signalBars, confirmation], armed.setup);
  assert.equal(result.action, "ENTRY");
  assert.equal(result.side, "LONG");
  assert.equal(result.entry, confirmation.close);
  assert.ok(result.stop < result.entry);
  assert.ok(result.tp1 > result.entry);
  assert.ok(result.tp2 > result.tp1);
});
test("SHORT does not confirm above the signal-candle midpoint even if close is below signal high", () => {
  const signalBars = candles([100, 102, 101]);
  const armed = evaluate(signalBars);
  const confirmation = candles([101.1], 4)[0]; // signal midpoint is 101; signal high is 101.2
  const result = evaluate([...signalBars, confirmation], armed.setup);
  assert.equal(result.action, "KEEP");
  assert.equal(result.setup.confirmationCount, 1);
});

test("LONG does not confirm below the signal-candle midpoint even if close is above signal low", () => {
  const signalBars = candles([100, 98, 99]);
  const armed = evaluate(signalBars);
  const confirmation = candles([98.9], 4)[0]; // signal midpoint is 99; signal low is 98.8
  const result = evaluate([...signalBars, confirmation], armed.setup);
  assert.equal(result.action, "KEEP");
  assert.equal(result.setup.confirmationCount, 1);
});

test("SHORT candidate is canceled when confirmation RSI remains above 70", () => {
  const signalBars = candles([100, 102, 101]);
  const armed = evaluate(signalBars);
  const result = evaluate([...signalBars, ...candles([104], 4)], armed.setup);
  assert.equal(result.action, "CANCEL");
  assert.equal(result.reason, "SHORT_RSI_INVALIDATED");
});
test("LONG candidate is canceled when confirmation RSI remains below 30", () => {
  const signalBars = candles([100, 98, 99]);
  const armed = evaluate(signalBars);
  const result = evaluate([...signalBars, ...candles([96], 4)], armed.setup);
  assert.equal(result.action, "CANCEL");
  assert.equal(result.reason, "LONG_RSI_INVALIDATED");
});
test("candidate stays armed after first candle and can confirm on second candle", () => {
  const signalBars = candles([100, 102, 101]);
  const armed = evaluate(signalBars);
  signalBars[2].high = 101.01;
  const firstWait = candles([101.02], 4)[0];
  const waiting = evaluate([...signalBars, firstWait], armed.setup);
  assert.equal(waiting.action, "KEEP");
  assert.equal(waiting.setup.confirmationCount, 1);
  const secondConfirm = candles([99], 5)[0];
  const result = evaluate([...signalBars, firstWait, secondConfirm], waiting.setup);
  assert.equal(result.action, "ENTRY");
  assert.equal(result.side, "SHORT");
  assert.equal(result.entry, secondConfirm.close);
});
test("legacy persisted multi-timeframe setups are discarded", () => {
  const signalBars = candles([100, 102, 101]);
  const oldSetup = { status: "ARMED", side: "SHORT", triggerCloseTime: 3, triggerHigh: 101.2, triggerLow: 100.8 };
  const result = evaluate([...signalBars, ...candles([98], 4)], oldSetup);
  assert.equal(result.action, "CANCEL");
  assert.equal(result.reason, "STALE_SETUP_VERSION_OR_TIMEFRAME");
});

test("candidate expires after configured maximum confirmation candles", () => {
  const signalBars = candles([100, 102, 101]);
  const armed = evaluate(signalBars);
  signalBars[2].high = 101.01;
  const waits = candles([101.02, 101.02, 101.02], 4);
  const result = evaluate([...signalBars, ...waits], armed.setup);
  assert.equal(result.action, "CANCEL");
  assert.equal(result.reason, "CONFIRMATION_TIMEOUT");
});
test("candidate can wait for a user-configured fifth confirmation candle", () => {
  cfg.strategy.maxConfirmationCandles = 5;
  const signalBars = candles([100, 102, 101]);
  const armed = evaluate(signalBars);
  signalBars[2].high = 101.01;
  const waits = candles([101.02, 101.02, 101.02, 101.02], 4);
  const waiting = evaluate([...signalBars, ...waits], armed.setup);
  assert.equal(waiting.action, "KEEP");
  const confirm = candles([99], 8)[0];
  const result = evaluate([...signalBars, ...waits, confirm], waiting.setup);
  assert.equal(result.action, "ENTRY");
  cfg.strategy.maxConfirmationCandles = 3;
});
