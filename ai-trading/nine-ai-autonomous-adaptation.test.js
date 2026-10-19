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
assert.equal(adaptation.ruleMatches(adaptation.tradeFeatures(matched), "LEARNED_CONJUNCTION", {
  conditions: [{ feature: "extensionAtr", operator: "gte", threshold: 2 }]
}), true);
assert.equal(adaptation.ruleMatches(adaptation.tradeFeatures(matched), "LEARNED_CONJUNCTION", {
  conditions: [{ feature: "volumeRatio", operator: "lte", threshold: 0.5 }]
}), true);

const learnedGrid = adaptation.buildRuleGrid(Array.from({ length: 40 }, (_, i) =>
  adaptation.normalizeTrade(trade(i + 10, i % 2 === 0, i % 2 === 0 ? "LOSS" : "WIN"))));
assert.ok(learnedGrid.some(item => item.rule === "LEARNED_CONJUNCTION" &&
  item.params.conditions.some(c => c.feature === "extensionAtr" && c.threshold === 2)),
"candidate strategy predicates must be mined from observed feature values");
assert.ok(learnedGrid.some(item => item.params.conditions.length === 2),
  "strategy evolution must combine predicates into newly generated strategies");
assert.ok(learnedGrid.every(item => item.rule === "LEARNED_CONJUNCTION"),
  "strategy candidates must use the data-only learned rule grammar");

const rows = [];
for (let i = 0; i < 200; i++) {
  rows.push(trade(i, true, "LOSS"));
  rows.push(trade(1000 + i, false, "WIN"));
}
const built = adaptation.buildPolicies(rows);
const extended = built.policies.find(p => p.rule === "LEARNED_CONJUNCTION" &&
  p.side === "LONG" && p.regime === "TREND_UP" && p.params.conditions.some(c =>
    c.feature === "extensionAtr" && c.operator === "gte" && c.threshold === 2));
assert.ok(extended, "enough chronological samples should produce an evaluated policy");
assert.equal(extended.validated, true);
assert.equal(extended.veto, true);
assert.ok(extended.testMeanR < 0);
assert.ok(extended.upliftR < -0.12);
assert.ok(extended.adjustment < 0, "validated harmful strategies must lower live rank by their measured edge");

const insufficient = adaptation.buildPolicies(rows.slice(0, 30));
assert.equal(insufficient.policies.length, 0, "small samples must not create live policies");

console.log("nine-ai-autonomous-adaptation.test.js: OK (evolved feature strategies and actual-risk normalization)");

