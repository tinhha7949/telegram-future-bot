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
assert.equal(consensus.MIN_TRAIN, 35);
assert.equal(consensus.MIN_TEST, 15);
assert.equal(consensus.MIN_INDEPENDENT_GAP_MS, 2 * 60 * 60 * 1000);
const compactLearned = consensus.learnPolicies(makeRows(0.6).slice(0, 50));
assert.equal(compactLearned.policies.length, 1,
  "50 independent observations should be enough for a train/holdout policy when evidence is clean");
assert.equal(compactLearned.reports[0].trainRows, 35);
assert.equal(compactLearned.reports[0].testRows, 15);
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

const diagnosticRows = makeRows(0.6).slice(0, 2);
diagnosticRows[0].rankScore = null;
diagnosticRows[1].evaluations["16"].shortNetR = null;
const diagnostics = {};
assert.equal(consensus.normalizeRows(diagnosticRows, diagnostics).length, 0);
assert.equal(diagnostics.missingRankScore, 1);
assert.equal(diagnostics.incompleteOutcomes, 1);

const overlapBase = makeRows(0.2)[0];
const twoHourRows = [
  { ...overlapBase, symbol: "GAP", signalTime: 1_000_000, scannedAt: 1_000_000 },
  { ...overlapBase, symbol: "GAP", signalTime: 1_000_000 + 60 * 60 * 1000, scannedAt: 1_000_000 + 60 * 60 * 1000 },
  { ...overlapBase, symbol: "GAP", signalTime: 1_000_000 + 2 * 60 * 60 * 1000, scannedAt: 1_000_000 + 2 * 60 * 60 * 1000 }
];
const twoHourDiagnostics = {};
const twoHourIndependent = consensus.normalizeRows(twoHourRows, twoHourDiagnostics);
assert.equal(twoHourIndependent.length, 2,
  "same-symbol opportunities 2h apart should be retained; a 1h repeat should be excluded");
assert.equal(twoHourDiagnostics.overlappingOpportunities, 1);

const legacyRankRows = makeRows(0.2).slice(0, 1).map(row => ({
  ...row, rankScore: null, originalRankScore: 61.5
}));
const legacyRankDiagnostics = {};
assert.equal(consensus.normalizeRows(legacyRankRows, legacyRankDiagnostics).length, 1,
  "legacy rows with a genuine originalRankScore should be recoverable");
assert.equal(legacyRankDiagnostics.recoveredRankScore, 1);

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

const interactionRows = Array.from({ length: 360 }, (_, i) => {
  const x = i % 2;
  const y = Math.floor(i / 2) % 2;
  const winsOnlyWhenBothConditionsMatch = x === 1 && y === 1;
  const result = winsOnlyWhenBothConditionsMatch ? 1 : -1;
  return {
    symbol: "I" + (i % 12), signalTime: Date.UTC(2025, 0, 1) + i * 4 * 60 * 60 * 1000,
    scannedAt: Date.UTC(2025, 0, 1) + i * 4 * 60 * 60 * 1000,
    marketRegime: "INTERACTION_REGIME", rankScore: 70, outcomeStatus: "EVALUATED",
    roles: roleNames.map(name => ({ name, side: "WAIT" })), features: { patternX: x, patternY: y },
    evaluations: { "4": { longNetR: result, shortNetR: -1 },
      "16": { longNetR: result, shortNetR: -1 } }
  };
});
const interactionLearned = consensus.learnPolicies(interactionRows);
assert.equal(interactionLearned.policies.length, 1,
  "the researcher should discover an out-of-sample profitable multi-feature condition");
const interactionPolicy = interactionLearned.policies[0];
assert.equal(interactionPolicy.type, "FEATURE_RULE");
assert.equal(interactionPolicy.conditions.length, 2,
  "the learned strategy should combine predicates when neither vote rules nor a single feature is sufficient");
assert.equal(interactionPolicy.conditionMode, "AND");
assert.ok(interactionPolicy.test.lowerBoundR > 0);
assert.equal(consensus.assessPolicy(roleNames.map(name => ({ name, side: "WAIT" })),
  interactionPolicy, 70, { patternX: 1, patternY: 1 }).side, "LONG");
assert.equal(consensus.assessPolicy(roleNames.map(name => ({ name, side: "WAIT" })),
  interactionPolicy, 70, { patternX: 1, patternY: 0 }).allowed, false);

const mixedBooleanPolicy = { type: "FEATURE_RULE", side: "SHORT", minimumRank: -Infinity,
  conditionTree: { operator: "OR", children: [
    { operator: "AND", conditions: [
      { feature: "a", operator: "gte", threshold: 1 },
      { feature: "b", operator: "gte", threshold: 1 }
    ] },
    { operator: "AND", conditions: [{ feature: "c", operator: "lte", threshold: 0 }] }
  ] } };
assert.equal(consensus.selectSide({ rank: 50, features: { a: 1, b: 1, c: 1 } }, mixedBooleanPolicy), "SHORT",
  "live policy evaluation should support nested mixed AND/OR condition trees");
assert.equal(consensus.selectSide({ rank: 50, features: { a: 1, b: 0, c: 1 } }, mixedBooleanPolicy), null);

const threeWayRows = Array.from({ length: 1200 }, (_, i) => {
  const a = i % 2;
  const b = Math.floor(i / 2) % 2;
  const c = Math.floor(i / 4) % 2;
  const winsOnlyWhenAllThreeMatch = a === 1 && b === 1 && c === 1;
  const result = winsOnlyWhenAllThreeMatch ? 1 : -1;
  return {
    symbol: "T" + (i % 10), signalTime: Date.UTC(2025, 0, 1) + i * 4 * 60 * 60 * 1000,
    scannedAt: Date.UTC(2025, 0, 1) + i * 4 * 60 * 60 * 1000,
    marketRegime: "THREE_WAY_REGIME", rankScore: 70, outcomeStatus: "EVALUATED",
    roles: roleNames.map(name => ({ name, side: "WAIT" })), features: { regimeA: a, regimeB: b, regimeC: c },
    evaluations: { "4": { longNetR: result, shortNetR: -1 },
      "16": { longNetR: result, shortNetR: -1 } }
  };
});
const threeWayLearned = consensus.learnPolicies(threeWayRows);
assert.equal(threeWayLearned.policies.length, 1,
  "the search depth should grow with training evidence to discover higher-order setups");
assert.equal(threeWayLearned.policies[0].conditions.length, 3);
assert.ok(threeWayLearned.reports[0].maximumConditionComplexitySearched >= 3);
assert.ok(threeWayLearned.policies[0].test.lowerBoundR > 0);

(async () => {
  const retained = { policyId: "data-consensus:OBSERVED_TREND", status: "ACTIVE", regime: "OBSERVED_TREND" };
  let retiredOrUpdatedWithoutReplacement = false;
  const makeCursor = rows => ({
    sort() { return this; }, hint() { return this; }, limit() { return this; },
    async toArray() { return rows; }
  });
  let journalIndexCreateCalls = 0;
  const journalCollection = {
    async createIndex() { journalIndexCreateCalls++; },
    listIndexes() { return makeCursor([{ name: "nine_ai_consensus_journal_scan",
      key: { outcomeStatus: 1, signalTime: -1 } }]); },
    find() { return makeCursor([]); }
  };
  const policyCollection = {
    async createIndex() {},
    find() { return makeCursor([retained]); },
    async updateMany() { retiredOrUpdatedWithoutReplacement = true; },
    async updateOne() { retiredOrUpdatedWithoutReplacement = true; }
  };
  const reportsCollection = { async insertOne() {} };
  const handoffCollection = {
    async findOne() { return null; },
    async updateOne() {}
  };
  const db = { collection(name) {
    if (name === "nine_ai_decision_journal") return journalCollection;
    if (name === "nine_ai_data_derived_consensus_policies") return policyCollection;
    if (name === "nine_ai_data_derived_consensus_reports") return reportsCollection;
    if (name === "nine_ai_strategy_handoff_state") return handoffCollection;
    throw new Error("Unexpected collection: " + name);
  } };
  await consensus.initialize(db);
  assert.equal(consensus.status().handoffActivated, true,
    "an existing active native policy must latch the handoff at startup");
  assert.equal(journalIndexCreateCalls, 0, "an equivalent legacy index must be reused regardless of name");
  const cycle = await consensus.runResearchCycle({ now: new Date("2026-10-19T00:00:00Z") });
  assert.equal(cycle.activePolicies, 1);
  assert.equal(consensus.status().policies[0].policyId, retained.policyId,
    "an empty research cycle must preserve the existing validated policy");
  assert.equal(retiredOrUpdatedWithoutReplacement, false,
    "the researcher must not retire or mutate policies when no validated replacement exists");
})().catch(error => { console.error(error); process.exitCode = 1; });

console.log("nine-ai-data-derived-consensus.test.js: OK");
