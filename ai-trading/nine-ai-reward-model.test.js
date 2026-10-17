"use strict";
const assert = require("node:assert/strict");
const learner = require("./nine-ai-reward-model");

const features = { trend: 1, momentum: 0.8, rsi: 61, volume: 1.4, extension: 0.3,
  candleBody: 0.6, wickImbalance: 0.2, breakoutStrength: 0.4, regime: 1,
  volatilityRegime: 0, structurePosition: 0.5, roomToResistance: 1.2,
  roomToSupport: 0.8, falseBreakoutRisk: 0, directionalStreak: 0.6,
  longEntryQuality: 78, shortEntryQuality: 32 };

const vector = learner.featureVector(features);
assert.equal(vector.length, learner.FEATURE_KEYS.length + 1);
assert.equal(vector[0], 1);
assert.ok(vector.every(Number.isFinite));
assert.notDeepEqual(vector, learner.featureVector({ ...features, trend: -1 }));

const cold = learner.freshState();
assert.equal(learner.predict(features, "LONG", cold).ready, false);
assert.equal(learner.predict(features, "SHORT", cold).expectedR, 0);

// A persisted trained state must produce a feature-dependent, uncertainty-aware
// net-R estimate without hard-coded setup tags or a fixed sample-count gate.
const trained = learner.freshState();
trained.sides.LONG.samples = 40;
trained.sides.LONG.weights[0] = 0.25;
trained.sides.LONG.weights[1] = 0.7;
trained.sides.LONG.variance = 0.4;
const prediction = learner.predict(features, "LONG", trained);
assert.equal(prediction.ready, true);
assert.ok(Number.isFinite(prediction.expectedR));
assert.ok(prediction.uncertainty > 0);
assert.ok(prediction.samples === 40);
assert.notEqual(prediction.expectedR, learner.predict({ ...features, trend: -1 }, "LONG", trained).expectedR);
assert.equal(learner.predict(features, "WAIT", trained).ready, false);

console.log("nine-ai-reward-model tests passed");
