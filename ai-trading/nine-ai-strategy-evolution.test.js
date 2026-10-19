"use strict";
const assert = require("node:assert/strict");
const evolution = require("./nine-ai-strategy-evolution");

const trend = {
  symbol: "TREND", side: "LONG", rankScore: 45, confidence: 50,
  marketState: "TREND_UP",
  rankMetrics: { features: { marketRegime: "TREND_UP", trend: "UP", momentum4: 0.02,
    volumeRatio: 1.2, breakoutStrength: 0.1, falseBreakoutRisk: 0.1 } }
};
const trap = {
  symbol: "TRAP", side: "LONG", rankScore: 90, confidence: 95,
  rankMetrics: { contrarian: { side: "LONG", strength: 82, reason: "BEAR_TRAP_RECLAIM" },
    features: { marketRegime: "SIDEWAYS", extensionAtr: -1.2, volumeRatio: 1.1,
      lowerWickRatio: 0.6, upperWickRatio: 0.1, falseBreakoutRisk: 0.2 } }
};
assert.equal(evolution.classifyStrategy(trend).family, "TREND_CONTINUATION");
assert.equal(evolution.classifyStrategy(trap).family, "LIQUIDITY_TRAP_REVERSAL");

const rows = [];
for (let i = 0; i < 40; i++) {
  rows.push({
    closed: true, applied: true, realizedR: i % 4 === 0 ? -0.5 : 1.2,
    side: "LONG", context: { strategyFamily: "LIQUIDITY_TRAP_REVERSAL", marketRegime: "SIDEWAYS" }
  });
}
const stats = evolution.buildPerformance(rows);
assert.equal(stats.get("LIQUIDITY_TRAP_REVERSAL|SIDEWAYS").n, 40);
assert.equal(stats.get("LIQUIDITY_TRAP_REVERSAL|*").n, 40);
assert.ok(stats.get("LIQUIDITY_TRAP_REVERSAL|SIDEWAYS").meanR > 0);

const cold = evolution.estimateEdge(trend, new Map());
const trained = evolution.estimateEdge({ ...trap, strategyClassification: evolution.classifyStrategy(trap) }, stats);
assert.equal(cold.edgeSource, "COLD_START");
assert.equal(trained.edgeSource, "REGIME");
assert.ok(trained.selectionValue > cold.selectionValue);

const ranked = evolution.rankCandidates([trap, trend]);
assert.equal(ranked.length, 2);
assert.ok(ranked.every(x => x.strategyClassification && x.strategyEdge));
const learnedFirst = evolution.compareCandidates(
  { ...trend, rankMetrics: { ...trend.rankMetrics, autonomousAdaptation: { adjustment: 7 } } },
  { ...trap, rankMetrics: { ...trap.rankMetrics, autonomousAdaptation: { adjustment: -2 } } }
);
assert.ok(learnedFirst < 0, "validated generated strategy effect must lead static family tie-breaking");
console.log("nine-ai-strategy-evolution tests passed");

