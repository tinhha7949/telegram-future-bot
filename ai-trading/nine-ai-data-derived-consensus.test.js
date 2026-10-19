"use strict";
const assert = require("node:assert/strict");
const consensus = require("./nine-ai-data-derived-consensus");

const roleNames = ["Technical Analyst AI", "ML Signal AI", "Learning & Memory AI", "Bull AI",
  "Bear AI", "Contrarian AI", "Analyst AI", "Decision AI", "Risk Manager AI"];
function makeRows(longR) {
  return Array.from({ length: 240 }, (_, i) => ({
    symbol: "S" + (i % 12), signalTime: Date.UTC(2024, 0, 1) + i * 4 * 60 * 60 * 1000,
    scannedAt: Date.UTC(2024, 0, 1) + i * 4 * 60 * 60 * 1000,
    marketRegime: "OBSERVED_TREND", rankScore: 55 + (i % 20), outcomeStatus: "EVALUATED",
    roles: roleNames.map((name, index) => ({ name,
      side: index < 6 ? "LONG" : index === 6 ? "SHORT" : "WAIT" })),
    evaluations: {
      "4": { longNetR: longR, shortNetR: -longR },
      "16": { longNetR: longR, shortNetR: -longR }
    }
  }));
}

const learned = consensus.learnPolicies(makeRows(0.6));
assert.equal(learned.rows, 240);
assert.equal(learned.policies.length, 1, "positive held-out observations should activate a learned gate");
const policy = learned.policies[0];
assert.equal(policy.regime, "OBSERVED_TREND");
assert.ok(policy.minimumVotes >= 1 && policy.minimumVotes <= 6);
assert.ok(policy.minimumRank >= 55 && policy.minimumRank <= 74);
assert.ok(policy.test.samples >= consensus.MIN_TEST);
assert.ok(policy.test.lowerBoundR > 0);
const allowed = consensus.assessPolicy(makeRows(0.6)[0].roles, policy, policy.minimumRank);
assert.equal(allowed.allowed, true);
assert.equal(allowed.side, "LONG");
assert.equal(allowed.rankAllowed, true);
assert.equal(consensus.assessPolicy(makeRows(0.6)[0].roles, policy, policy.minimumRank - 1).rankAllowed, false);
assert.equal(consensus.assessLive(makeRows(0.6)[0].roles, "UNSEEN_REGIME", 100).ready, false,
  "unvalidated regimes must not fall back to a hard-coded live vote gate");
assert.equal(consensus.learnPolicies(makeRows(-0.6)).policies.length, 0,
  "a losing strategy must not be promoted from negative held-out results");

const featureRows = makeRows(0).map((row, index) => {
  row.roles = roleNames.map(name => ({ name, side: "WAIT" }));
  row.features = { observedPattern: index % 2 };
  row.evaluations["4"].longNetR = index % 2 ? 0.8 : -0.5;
  row.evaluations["16"].longNetR = index % 2 ? 0.8 : -0.5;
  row.evaluations["4"].shortNetR = -0.6;
  row.evaluations["16"].shortNetR = -0.6;
  return row;
});
const featureLearned = consensus.learnPolicies(featureRows);
assert.equal(featureLearned.policies.length, 1, "journal features should be able to generate a strategy without vote heuristics");
assert.equal(featureLearned.policies[0].type, "FEATURE_RULE");
assert.equal(featureLearned.policies[0].side, "LONG");
assert.equal(consensus.assessPolicy(featureRows[1].roles, featureLearned.policies[0],
  featureLearned.policies[0].minimumRank, featureRows[1].features).allowed, true);
assert.equal(consensus.assessPolicy(featureRows[0].roles, featureLearned.policies[0],
  featureLearned.policies[0].minimumRank, featureRows[0].features).allowed, false);

console.log("nine-ai-data-derived-consensus.test.js: OK");
