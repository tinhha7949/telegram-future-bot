"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG } = require("./config");
const { phaseForLabelCount, riskForPhase, weightedPercentile, updateOnlineCalibration, calibrationPenaltyForState } = require("./online-learning");
const { uncertaintyFor } = require("./nine-ai-policy");
test("LIVE starts with zero labels and risk remains at early micro-risk", () => {
  assert.equal(CONFIG.MODE, "LIVE");
  assert.equal(phaseForLabelCount(0), "EARLY");
  assert.equal(riskForPhase(0), 0.0025);
  assert.equal(riskForPhase(29), CONFIG.EARLY_RISK);
});
test("phase transition is exact at 29->30 and 149->150 labels", () => {
  assert.equal(phaseForLabelCount(29), "EARLY");
  assert.equal(phaseForLabelCount(30), "ADAPT");
  assert.equal(riskForPhase(30), 0.005);
  assert.equal(phaseForLabelCount(149), "ADAPT");
  assert.equal(phaseForLabelCount(150), "MATURE");
  assert.equal(riskForPhase(150), 0.01);
});
test("first completed trade immediately produces usable MAE/MFE quantiles", () => {
  assert.equal(weightedPercentile([0.7], 0.8), 0.7);
  assert.equal(weightedPercentile([1.1], 0.5), 1.1);
  assert.equal(weightedPercentile([1.1], 0.9), 1.1);
});
test("recency decay gives a newer sample more weight than an older sample", () => {
  assert.equal(weightedPercentile([10, 1], 0.5, 0.95), 10);
  assert.equal(weightedPercentile([10, 1], 0.5, 1), 1);
});

test("early uncertainty penalty is applied on top of confidence penalty", () => {
  assert.equal(uncertaintyFor({ regime_conf: 0.8 }, 1000, 1000, 1001, {
    uncertaintyPenalty: 0, earlyPhase: true,
  }), CONFIG.EARLY_UNCERTAINTY_PENALTY);
  assert.equal(uncertaintyFor({ regime_conf: 0.4 }, 1000, 1000, 1001, {
    uncertaintyPenalty: 0, earlyPhase: true,
  }), CONFIG.LOW_CONF_PENALTY + CONFIG.EARLY_UNCERTAINTY_PENALTY);
});
test("online calibration updates on one label and penalizes measured prediction drift", () => {
  const first = updateOnlineCalibration(null, 1, 0, 1000);
  assert.equal(first.samples, 1);
  assert.equal(first.biasR, 1);
  assert.equal(first.maeR, 1);
  assert.equal(calibrationPenaltyForState(first), CONFIG.LOW_CONF_PENALTY);
  const second = updateOnlineCalibration(first, 0, 0, 2000);
  assert.equal(second.samples, 2);
  assert.ok(second.weight > 1);
});
