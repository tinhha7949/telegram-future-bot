"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG } = require("./config");
const { phaseForLabelCount, riskForPhase, weightedPercentile } = require("./online-learning");
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
