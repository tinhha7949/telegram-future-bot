"use strict";
const assert = require("node:assert/strict");
const learner = require("./nine-ai-offline-learning");
assert.equal(learner.policyAction({ decisionSnapshot: { regime: { regime: "RANGE" } } }, learner.DEFAULT_CHAMPION), "WAIT");
assert.equal(learner.policyAction({ decisionSnapshot: { regime: { regime: "UPTREND" }, agents: { flow: { confirmation: "NEUTRAL" } }, edges: { LONG: { edge: 0.8 }, SHORT: { edge: 0.1 } } } }, learner.DEFAULT_CHAMPION), "WAIT");
const rows = Array.from({ length: 600 }, (_, i) => ({
  signalTime: 1_700_000_000_000 + i * learner.BAR_MS,
  outcomeStatus: "EVALUATED",
  decisionSnapshot: {
    setup: "NINE_AI_4H",
    side: "LONG",
    regime: { regime: "UPTREND", regime_conf: 0.9 },
    agents: { flow: { confirmation: "CONFIRMED", confirmationSide: "LONG" } },
    edges: {
      LONG: { edge: 0.3, p: 0.7, expectedR: 1.0 },
      SHORT: { edge: -0.1, p: 0.4, expectedR: 0.2 }
    }
  },
  evaluations: { "24": { longNetR: 0.4, shortNetR: -0.4 } }
}));
const splits = learner.walkForwardSplits(rows);
assert.ok(splits.train.length >= 30);
assert.ok(splits.validation.length >= 15);
assert.ok(splits.test.length >= learner.MIN_TEST_ROWS || splits.test.length >= 20);
assert.ok(splits.purgeEmbargoMs >= 24 * 4 * 60 * 60 * 1000);
assert.equal(learner.evaluatePolicy(rows.slice(0, 10), learner.DEFAULT_CHAMPION).trades, 10);
const trained = learner.trainCandidate(rows, learner.DEFAULT_CHAMPION);
assert.ok(["SHADOW_PENDING", "CANDIDATE_DID_NOT_BEAT_CHAMPION", "INSUFFICIENT_WALK_FORWARD_SAMPLES", "NO_VALID_CANDIDATE"].includes(trained.status));
const calibration = learner.calibrationSummary([{ predictedEdgeR: 0.2, realizedR: 0.1 }, { predictedEdgeR: 0.4, realizedR: 0.2 }, { predictedEdgeR: null, realizedR: null }]);
assert.equal(calibration.samples, 2);
assert.ok(Math.abs(calibration.biasR - 0.15) < 1e-9);
console.log("nine-ai-offline-learning tests passed");
