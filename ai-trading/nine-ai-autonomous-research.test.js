"use strict";
const assert = require("node:assert/strict");
const research = require("./nine-ai-autonomous-research");

assert.equal(research.ruleCandidates().length, 0, "strategy hypotheses require observed data, not a manually fixed threshold grid");
assert.equal(research.matchesRule({ features: { volume: 1.2 } },
  { path: "features.volume", operator: "gte", threshold: 1.1 }), true);
assert.equal(research.matchesRule({ features: { volume: 0.8 } },
  { path: "features.volume", operator: "gte", threshold: 1.1 }), false);
assert.equal(research.matchesRule({ side: "SHORT", features: { longEntryQuality: 90 } },
  { path: "features.longEntryQuality", operator: "gte", threshold: 70, side: "LONG" }), false);
assert.deepEqual(research.stats([]), { n: 0, meanR: null, standardDeviation: null, winRate: null, totalR: 0 });

const few = Array.from({ length: 15 }, (_, i) => ({
  closed: true, side: "LONG", realizedR: i % 2 ? 1 : -1,
  features: { volume: 1.2 }, closedAt: new Date(1700000000000 + i * 1000)
}));
assert.notEqual(research.buildResearch(few).status, "WARMUP", "research should evaluate available outcomes instead of waiting for an arbitrary 100-trade gate");

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
assert.equal(result.split, "chronological_70_30_thresholds_mined_from_train_only");
assert.ok(result.evaluatedRules > 0);
assert.ok(result.candidates.every(candidate => candidate.activation === "AUTO_PROMOTE_IF_VALIDATED"));
assert.ok(result.candidates.every(candidate => candidate.test.candidate.n > 0));
assert.ok(result.candidates.every(candidate => candidate.test.upliftR > 0));
const liveDecision = { side: "LONG", rankMetrics: { roleScore: 80, entryQuality: 80,
  features: { volumeRatio: 1.4, rsi14: 60, extensionAtr: 0.2, momentum4: 0.8,
    atrPercent: 1, falseBreakoutRisk: 0, longEntryQuality: 80, shortEntryQuality: 35 } } };
assert.equal(research.decisionToResearchRow(liveDecision).features.volume, 1.4);
const matchedPolicyResult = research.evaluateLiveDecision(liveDecision, { status: "ACTIVE", policyId: "p1",
  testUpliftR: 0.3, rule: { path: "features.volume", operator: "gte", threshold: 1.1 } });
assert.equal(matchedPolicyResult.allowed, true);
assert.equal(matchedPolicyResult.matched, true);
assert.equal(matchedPolicyResult.scoreEvidence, 0.3);
const activePolicyResult = research.evaluateLiveDecision(liveDecision, { status: "ACTIVE", policyId: "p2",
  testUpliftR: 0.3, rule: { path: "features.volume", operator: "gte", threshold: 1.5 } });
assert.equal(activePolicyResult.allowed, true,
  "a research-rule mismatch must never veto a valid Nine-AI directional signal");
assert.equal(activePolicyResult.matched, false);
assert.equal(activePolicyResult.scoreEvidence, -0.3);
assert.equal(activePolicyResult.reason, "ACTIVE_RESEARCH_RULE_MISMATCH_SOFT_EVIDENCE");
assert.equal(research.evaluateLiveDecision(liveDecision, null).reason, "NO_ACTIVE_RESEARCH_POLICY");

// Live retirement must evaluate the policy's matched trades against unmatched
// trades, not merely the account's overall PnL while a policy was active.
const underperformingLiveRows = [
  ...Array.from({ length: 10 }, (_, i) => ({
    realizedR: -0.5, researchPolicy: { matched: true }, closedAt: new Date(1700000000000 + i)
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    realizedR: 0.25, researchPolicy: { matched: false }, closedAt: new Date(1700000001000 + i)
  }))
];
const underperformingLive = research.assessLivePolicyPerformance(underperformingLiveRows);
assert.equal(underperformingLive.enoughEvidence, true);
assert.equal(underperformingLive.underperforming, true);
assert.ok(underperformingLive.matchedVsUnmatchedUpliftR < 0);

const healthyLiveRows = [
  ...Array.from({ length: 10 }, (_, i) => ({
    realizedR: 0.5, researchPolicy: { matched: true }, closedAt: new Date(1700000000000 + i)
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    realizedR: 0.1, researchPolicy: { matched: false }, closedAt: new Date(1700000001000 + i)
  }))
];
const healthyLive = research.assessLivePolicyPerformance(healthyLiveRows);
assert.equal(healthyLive.enoughEvidence, true);
assert.equal(healthyLive.underperforming, false);
assert.ok(healthyLive.matchedVsUnmatchedUpliftR > 0);

const tooFewLiveRows = underperformingLiveRows.slice(0, 15);
assert.equal(research.assessLivePolicyPerformance(tooFewLiveRows).underperforming, false,
  "policy rollback must wait for enough matched and unmatched live observations");

const overlayMatchDecision = { ...liveDecision, rankScore: 70, qualityScore: 70, score: 70, rankMetrics: { ...liveDecision.rankMetrics } };
const overlayMatch = research.applyResearchPolicyEvidence(overlayMatchDecision, {
  status: "ACTIVE", policyId: "p-match", testUpliftR: 0.3,
  rule: { path: "features.volume", operator: "gte", threshold: 1.1 }
});
assert.equal(overlayMatch.policyCheck.allowed, true);
assert.equal(overlayMatch.policyCheck.matched, true);
assert.equal(overlayMatch.adjustmentPoints, 3);
assert.equal(overlayMatchDecision.rankScore, 73);
assert.equal(overlayMatchDecision.authorizedForExecution, undefined);
const overlayMismatchDecision = { ...liveDecision, rankScore: 70, rankMetrics: { ...liveDecision.rankMetrics } };
const overlayMismatch = research.applyResearchPolicyEvidence(overlayMismatchDecision, {
  status: "ACTIVE", policyId: "p-mismatch", testUpliftR: 0.3,
  rule: { path: "features.volume", operator: "gte", threshold: 1.5 }
});
assert.equal(overlayMismatch.policyCheck.allowed, true, "research mismatch is ranking evidence, never a veto");
assert.equal(overlayMismatch.adjustmentPoints, -3);
assert.equal(overlayMismatchDecision.rankScore, 67);
const boundedDecision = { ...liveDecision, rankScore: 99, rankMetrics: { ...liveDecision.rankMetrics } };
const bounded = research.applyResearchPolicyEvidence(boundedDecision, {
  status: "ACTIVE", policyId: "p-bound", testUpliftR: 9,
  rule: { path: "features.volume", operator: "gte", threshold: 1.1 }
});
assert.equal(bounded.adjustmentPoints, 10);
assert.equal(boundedDecision.rankScore, 100);


const small = research.buildResearch(rows.slice(0, 40));
assert.equal(small.status, "COLLECTING_OUTCOMES", "small samples must never promote a live strategy");
assert.equal(small.requiredSamples, research.MIN_RESEARCH_SAMPLES);

// Threshold candidates must be derived from the first 70% only, not from
// extreme feature values that appear exclusively in the held-out future.
const leakageRows = Array.from({ length: 100 }, (_, i) => ({
  closed: true, side: "LONG", realizedR: i < 70 ? (i % 2 ? 0.2 : -0.1) : 0.3,
  features: { volume: i < 70 ? 1 + (i % 5) * 0.1 : 99, rsi: 50,
    extension: 0.2, momentum: 0.1, falseBreakoutRisk: 0.2,
    longEntryQuality: 60, shortEntryQuality: 40 },
  closedAt: new Date(1700000000000 + i * 1000)
}));
const leakageResearch = research.buildResearch(leakageRows);
assert.ok(leakageResearch.evaluatedRules > 0);
assert.ok(!research.ruleCandidates(leakageRows.slice(0, 70)).some(rule => rule.threshold === 99),
  "held-out future values must not be used to mine candidate thresholds");

(async () => {
  const db = { collection: () => ({ createIndex: async () => ({}) }) };
  const initialized = await research.initialize(db);
  assert.equal(initialized.minSamples, research.MIN_RESEARCH_SAMPLES,
    "startup status must expose the actual minimum sample threshold");
})().catch(error => { console.error(error); process.exitCode = 1; });

console.log("nine-ai-autonomous-research tests passed");
