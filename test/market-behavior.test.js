"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateMarketBehavior } = require("../src/market-behavior");

const config = {
  enabled: true, lookbackCandles: 10, atrPeriod: 5, pressureCandles: 3,
  volumeLookback: 5, pressureThreshold: 0.15, minDisplacementAtr: 0.5,
  minCloseLocation: 0.62, maxOpposingWickRatio: 0.55,
  volumeExpansionMultiplier: 1.1, minScore: 45
};

function makeBars(side = "LONG") {
  const bars = [];
  for (let i = 0; i < 20; i++) {
    const close = 100 + i * 0.1;
    bars.push({
      open: close - 0.05, high: close + 0.2, low: close - 0.2,
      close, volume: 100, openTime: i * 900000, closeTime: (i + 1) * 900000
    });
  }
  const last = bars.at(-1);
  if (side === "LONG") {
    last.open = 101.8; last.low = 101.4; last.high = 102.7; last.close = 102.6; last.volume = 180;
  } else {
    last.open = 102.6; last.high = 103.0; last.low = 101.7; last.close = 101.8; last.volume = 180;
  }
  return bars;
}

test("disabled market-behavior filter leaves the existing entry decision untouched", () => {
  const result = evaluateMarketBehavior({ candles: [], side: "LONG", config: { enabled: false } });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "DISABLED");
});

test("directional closed-candle behavior can confirm a LONG setup", () => {
  const result = evaluateMarketBehavior({ candles: makeBars("LONG"), side: "LONG", config });
  assert.equal(result.allowed, true);
  assert.ok(result.score >= config.minScore);
  assert.equal(result.reason, "PRICE_ACTION_CONFIRMED");
});

test("directional closed-candle behavior can confirm a SHORT setup", () => {
  const result = evaluateMarketBehavior({ candles: makeBars("SHORT"), side: "SHORT", config });
  assert.equal(result.allowed, true);
  assert.ok(result.score >= config.minScore);
});

test("insufficient history blocks evaluation rather than inventing a score", () => {
  const result = evaluateMarketBehavior({ candles: makeBars().slice(0, 5), side: "LONG", config });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "INSUFFICIENT_CANDLES");
});

test("invalid side and malformed candles are rejected safely", () => {
  assert.equal(evaluateMarketBehavior({ candles: makeBars(), side: "BUY", config }).reason, "INVALID_SIDE");
  const bars = makeBars();
  bars.at(-1).high = NaN;
  assert.equal(evaluateMarketBehavior({ candles: bars, side: "LONG", config }).reason, "INVALID_CANDLE_DATA");
});

test("a strong opposite-direction candle reduces confirmation quality", () => {
  const bars = makeBars("LONG");
  bars.at(-1).open = 103.0;
  bars.at(-1).close = 101.5;
  bars.at(-1).high = 103.1;
  bars.at(-1).low = 101.3;
  const result = evaluateMarketBehavior({ candles: bars, side: "LONG", config });
  assert.ok(result.score < config.minScore);
  assert.equal(result.allowed, false);
});
