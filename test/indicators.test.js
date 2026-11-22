"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ema, rsi, atr, findSwing, adxWilder } = require("../src/indicators");

test("EMA returns expected average for a flat series", () => assert.equal(ema(Array(60).fill(10), 50), 10));
test("RSI returns 100 for a rising series", () => assert.equal(rsi(Array.from({length: 20}, (_, i) => i + 1), 14), 100));
test("ATR is positive for candles with range", () => {
  const cs = Array.from({length: 20}, (_, i) => ({high: 12+i, low: 10+i, close: 11+i}));
  assert.ok(atr(cs, 14) > 0);
});
test("swing finder identifies a confirmed local high", () => {
  const cs = [1,2,3,2,1,1,1].map(v=>({high:v,low:v-1,close:v}));
  assert.equal(findSwing(cs, "SHORT", 1, 1, 10), 3);
});
test("Wilder ADX reaches 100 for a persistent one-directional trend", () => {
  const cs = Array.from({length: 60}, (_, i) => ({
    high: 102 + i, low: 100 + i, close: 101 + i
  }));
  assert.equal(adxWilder(cs, 14), 100);
});
test("Wilder ADX is zero when there is no directional movement", () => {
  const cs = Array.from({length: 60}, () => ({high: 101, low: 99, close: 100}));
  assert.equal(adxWilder(cs, 14), 0);
});
test("ADX returns null when history is shorter than the Wilder seed requirement", () => {
  const cs = Array.from({length: 27}, (_, i) => ({high: i+2, low: i, close: i+1}));
  assert.equal(adxWilder(cs, 14), null);
});
