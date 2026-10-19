"use strict";
const assert = require("node:assert/strict");
const adaptation = require("./nine-ai-autonomous-adaptation");

function trade(i, matched, outcome) {
  const closedAt = new Date(1700000000000 + i * 86400000);
  return {
    _id: "trade-" + i, setup: "NINE_AI_15M", side: "LONG",
    result: outcome, pnl: matched ? -40 : 20, riskDetail: { riskBudget: 100 },
    quantity: 2, initialRisk: 25, finalRisk: 50,
    closedAt,
    nineAiLearningFeatures: {
      extensionAtr: matched ? 2.0 : 0.2,
      rsi14: matched ? 78 : 52,
      volumeRatio: matched ? 0.5 : 1.2,
      longEntryQuality: matched ? 42 : 80,
      shortEntryQuality: 70,
      roomQuality: matched ? 20 : 80,
      momentum4: 0.1,
      marketRegime: "TREND_UP"
    },
    nineAiLearningContext: { marketRegime: "TREND_UP" }
  };
}

const matched = trade(1, true, "LOSS");
assert.equal(adaptation.normalizeTrade(matched).realizedR, -0.8,
  "adaptive policy R must use quantity × stop distance, not configured risk budget");
assert.equal(adaptation.ruleMatches(adaptation.tradeFeatures(matched), "EXTENDED_MOMENTUM_ENTRY"), true);
assert.equal(adaptation.ruleMatches(adaptation.tradeFeatures(matched), "LOW_VOLUME"), true);

const learnedGrid = adaptation.buildRuleGrid([
  adaptation.normalizeTrade(trade(10, true, "LOSS")),
  adaptation.normalizeTrade(trade(11, false, "WIN"))
]);
assert.ok(learnedGrid.some(item => item.rule === "EXTENDED_MOMENTUM_ENTRY" &&
  item.params.extensionThreshold === 2 && item.params.rsiThreshold === 78),
"candidate thresholds must be mined from observed training values");
assert.ok(learnedGrid.some(item => item.rule === "LOW_VOLUME" && item.params.volumeThreshold === 1.2));
assert.ok(!learnedGrid.some(item => Object.values(item.params).includes(65)),
  "the optimizer must not require the old hand-authored RSI cutoff");

const rows = [];
for (let i = 0; i < 200; i++) {
  rows.push(trade(i, true, "LOSS"));
  rows.push(trade(1000 + i, false, "WIN"));
}
const built = adaptation.buildPolicies(rows);
const extended = built.policies.find(p => p.rule === "EXTENDED_MOMENTUM_ENTRY" &&
  p.side === "LONG" && p.regime === "TREND_UP");
assert.ok(extended, "enough chronological samples should produce an evaluated policy");
assert.equal(extended.validated, true);
assert.equal(extended.veto, true);
assert.ok(extended.testMeanR < 0);
assert.ok(extended.upliftR < -0.12);

const insufficient = adaptation.buildPolicies(rows.slice(0, 30));
assert.equal(insufficient.policies.length, 0, "small samples must not create live policies");

console.log("nine-ai-autonomous-adaptation.test.js: OK (data-derived thresholds and actual-risk normalization)");
