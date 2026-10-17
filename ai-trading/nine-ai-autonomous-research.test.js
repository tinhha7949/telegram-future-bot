"use strict";
const assert = require("node:assert/strict");
const research = require("./nine-ai-autonomous-research");

assert.ok(research.ruleCandidates().length > 50);
assert.equal(research.matchesRule({ features: { volume: 1.2 } },
  { path: "features.volume", operator: "gte", threshold: 1.1 }), true);
assert.equal(research.matchesRule({ features: { volume: 0.8 } },
  { path: "features.volume", operator: "gte", threshold: 1.1 }), false);
assert.equal(research.matchesRule({ side: "SHORT", features: { longEntryQuality: 90 } },
  { path: "features.longEntryQuality", operator: "gte", threshold: 70, side: "LONG" }), false);
assert.deepEqual(research.stats([]), { n: 0, meanR: null, winRate: null, totalR: 0 });

const few = Array.from({ length: 15 }, (_, i) => ({
  closed: true, side: "LONG", realizedR: i % 2 ? 1 : -1,
  features: { volume: 1.2 }, closedAt: new Date(1700000000000 + i * 1000)
}));
assert.equal(research.buildResearch(few).status, "WARMUP");

const rows = [];
for (let i = 0; i < 100; i++) {
  const good = i % 2 === 0;
  rows.push({
    closed: true, side: "LONG", realizedR: good ? 1.2 : -0.8,
    features: { volume: good ? 1.4 : 0.6, rsi: good ? 60 : 40,
      extension: 0.2, momentum: good ? 0.8 : -0.8, falseBreakoutRisk: good ? 0 : 1,
      longEntryQuality: good ? 80 : 35, shortEntryQuality: good ? 35 : 80 },
    context: { roleScore: good ? 80 : 50, entryQuality: good ? 80 : 35 },
    closedAt: new Date(1700000000000 + i * 1000)
  });
}
const result = research.buildResearch(rows, new Date("2026-10-17T00:00:00Z"));
assert.equal(result.sampleCount, 100);
assert.equal(result.split, "chronological_70_30");
assert.ok(result.evaluatedRules > 50);
assert.ok(result.candidates.every(candidate => candidate.activation === "AUTO_PROMOTE_IF_VALIDATED"));
assert.ok(result.candidates.every(candidate => candidate.test.candidate.n >= research.MIN_TEST_MATCHES));
assert.ok(result.candidates.every(candidate => candidate.test.upliftR >= research.MIN_TEST_UPLIFT_R));
const liveDecision = { side: "LONG", rankMetrics: { roleScore: 80, entryQuality: 80,
  features: { volumeRatio: 1.4, rsi14: 60, extensionAtr: 0.2, momentum4: 0.8,
    atrPercent: 1, falseBreakoutRisk: 0, longEntryQuality: 80, shortEntryQuality: 35 } } };
assert.equal(research.decisionToResearchRow(liveDecision).features.volume, 1.4);
assert.equal(research.evaluateLiveDecision(liveDecision, { status: "ACTIVE", policyId: "p1",
  rule: { path: "features.volume", operator: "gte", threshold: 1.1 } }).allowed, true);
const activePolicyResult = research.evaluateLiveDecision(liveDecision, { status: "ACTIVE", policyId: "p2",
  rule: { path: "features.volume", operator: "gte", threshold: 1.5 } });
assert.equal(activePolicyResult.allowed, false, "validated ACTIVE research policies must be enforced without an environment opt-in");
assert.equal(activePolicyResult.reason, "ACTIVE_RESEARCH_RULE_BLOCKED");
assert.equal(research.evaluateLiveDecision(liveDecision, null).reason, "NO_ACTIVE_RESEARCH_POLICY");
console.log("nine-ai-autonomous-research tests passed");
