"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateClosedCandle, buildConfirmedEntry, checkBreakoutConfirmation } = require("../src/strategy");

const strategy = {
  pullbackEmaPeriod: 9, pullbackLookbackCandles: 5, pullbackEmaTolerancePct: 0.15,
  adx: { enabled: false, rangeMax: 20, mixedMax: 26, requireWeakCandleWhenDisabled: false },
  slBufferPct: .12, minStopDistancePct: .1, maxStopDistancePct: 5,
  rewardRiskTp1: 2, rewardRiskTp2: 3.5
};
const config = { strategy };
function bars(closes, side) {
  return closes.map((close, i) => {
    const bar = { open: close + .1, high: close + .3, low: close - .3, close,
      openTime: i * 900000, closeTime: (i + 1) * 900000 };
    if (i === closes.length - 2 && side === "LONG") { bar.open = close + 1; bar.low = close - 2; }
    if (i === closes.length - 2 && side === "SHORT") { bar.open = close - 1; bar.high = close + 2; }
    if (i === closes.length - 1) bar.open = close + (side === "LONG" ? -1 : 1);
    return bar;
  });
}
const longBars = () => bars([100,101,102,103,104,105,106,105,104,105.5], "LONG");
const shortBars = () => bars([105,104,103,102,101,100,99,100,101,99.5], "SHORT");

test("LONG requires a bearish EMA9 pullback followed by a green close above EMA9", () => {
  const candles = longBars();
  const result = evaluateClosedCandle({ candles, config, adx: null });
  assert.equal(result.action, "SIGNAL");
  assert.equal(result.side, "LONG");
  assert.equal(result.rsi, null);
  assert.equal(result.signalTime, candles.at(-1).closeTime);
});
test("SHORT requires a bullish EMA9 pullback followed by a red close below EMA9", () => {
  const result = evaluateClosedCandle({ candles: shortBars(), config, adx: null });
  assert.equal(result.action, "SIGNAL");
  assert.equal(result.side, "SHORT");
});
test("a green candle that does not close above EMA9 is not a LONG trigger", () => {
  const candles = longBars();
  candles.at(-1).close = 103;
  candles.at(-1).open = 102.9;
  assert.equal(evaluateClosedCandle({ candles, config, adx: null }).action, "WAIT");
});
test("a red candle that does not close below EMA9 is not a SHORT trigger", () => {
  const candles = shortBars();
  candles.at(-1).close = 102;
  candles.at(-1).open = 102.1;
  assert.equal(evaluateClosedCandle({ candles, config, adx: null }).action, "WAIT");
});
test("a reversal candle without a prior EMA9 pullback does not trigger", () => {
  const candles = longBars();
  candles.at(-2).low = 104.5;
  candles.at(-2).open = 104.1;
  candles.at(-2).close = 104;
  assert.equal(evaluateClosedCandle({ candles, config, adx: null }).action, "WAIT");
});
test("EMA pullback signals do not depend on RSI values", () => {
  const result = evaluateClosedCandle({ candles: longBars(), config, adx: null });
  assert.equal(result.rsi, null);
  assert.equal(result.previousRsi, null);
});
test("ADX momentum filter remains active when explicitly enabled", () => {
  const withAdx = { ...strategy, adx: { ...strategy.adx, enabled: true } };
  const result = evaluateClosedCandle({ candles: longBars(), config: { strategy: withAdx }, adx: 27 });
  assert.equal(result.action, "WAIT");
  assert.equal(result.reason, "ADX_MOMENTUM_BLOCK");
});
test("confirmed entry preserves structural stop and configured TP ratios", () => {
  const signal = { side: "LONG", signalTime: 100, structureHigh: 101, structureLow: 98,
    adx: null, regime: "DISABLED", weakCandle: false };
  const result = buildConfirmedEntry({ signal, candle: { close: 100, closeTime: 200 }, config });
  assert.equal(result.action, "ENTRY");
  assert.ok(result.stop < 98);
  assert.ok(result.tp1 > result.entry);
  assert.ok(result.tp2 > result.tp1);
  assert.equal(result.rsi, null);
});
test("optional breakout confirmation still requires a close beyond the signal candle", () => {
  const signal = { side: "LONG", signalHigh: 105 };
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 105 }, elapsedCandles: 1, maxWaitCandles: 2 }).status, "WAIT");
  assert.equal(checkBreakoutConfirmation({ signal, candle: { close: 105.1 }, elapsedCandles: 1, maxWaitCandles: 2 }).status, "CONFIRMED");
});
