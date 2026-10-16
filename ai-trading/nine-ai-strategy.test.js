"use strict";
const assert = require("node:assert/strict");
const { ROLE_NAMES, analyzeNineAI, parseClosedCandles, compareNineAICandidates } = require("./nine-ai-strategy");
assert.equal(ROLE_NAMES.length, 9);
assert.equal(new Set(ROLE_NAMES).size, 9);
const now = Date.now();
const rows = [];
let price = 100;
for (let i = 0; i < 100; i++) {
  const open = price;
  price += 0.18 + Math.sin(i / 3) * 0.06;
  rows.push([now - (100 - i) * 900000, open, Math.max(open, price) + 0.2,
    Math.min(open, price) - 0.2, price, 100 + i, now - (100 - i) * 900000 + 899999]);
}
rows.push([now, price, price + 0.1, price - 0.1, price + 0.05, 100, now + 899999]);
assert.equal(parseClosedCandles(rows, now).length, 100);
const result = analyzeNineAI(rows, "TESTUSDT", now);
assert.equal(result.symbol, "TESTUSDT");
assert.equal(result.roles.length, 9);
assert.equal(result.roles[7].name, "Decision AI");
assert.equal(result.roles[8].name, "Risk Manager AI");
if (result.side) {
  assert.ok(result.sl > 0 && result.tp > 0 && result.price > 0);
  assert.ok(result.rr >= 1.7);
  assert.equal(result.authorizedForExecution, true);
  assert.equal(result.tradePlan.timeframe, "15m");
  assert.equal(result.tradePlan.entryMethod, "LATEST_CLOSED_CANDLE");
  assert.equal(result.tradePlan.stopMethod, "ATR_AND_RECENT_STRUCTURE");
  assert.equal(result.entry, result.price);
} else {
  assert.equal(result.authorizedForExecution, undefined);
}

const highQuality = {
  symbol: "ZZZUSDT", confidence: 60, rankScore: 72,
  rankMetrics: { consensusMargin: 3, directionalVotes: 5, setupQuality: 90, volumeQuality: 80 }
};
const lowerQuality = {
  symbol: "AAAUSDT", confidence: 61, rankScore: 68,
  rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80, volumeQuality: 70 }
};
assert.ok(compareNineAICandidates(highQuality, lowerQuality) < 0,
  "higher composite score must outrank a coin with slightly higher raw confidence");
assert.ok(compareNineAICandidates(
  { symbol: "BBB", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 3, directionalVotes: 5, setupQuality: 80 } },
  { symbol: "AAA", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80 } }
) < 0, "consensus margin must break a true composite-score tie before symbol name");
assert.ok(compareNineAICandidates(
  { symbol: "AAA", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80 } },
  { symbol: "ZZZ", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80 } }
) < 0, "symbol name is only the final deterministic tie-breaker");

console.log("PASS: nine roles, closed-candle filter, execution authorization, weighted ranking, tie-breaks, and trade geometry");
