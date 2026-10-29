"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG } = require("./config");
const { phaseForLabelCount, countRealizedLabels, riskForPhase, weightedPercentile, updateOnlineCalibration, calibrationPenaltyForState } = require("./online-learning");
const { uncertaintyFor } = require("./nine-ai-policy");
test("LIVE starts with zero labels and risk remains at early micro-risk", () => {
  assert.equal(CONFIG.MODE, "LIVE");
  assert.equal(phaseForLabelCount(0), "EARLY");
  assert.equal(riskForPhase(0), CONFIG.EARLY_RISK);
  assert.equal(riskForPhase(CONFIG.EARLY_PHASE_LABELS - 1), CONFIG.EARLY_RISK);
});
test("phase transitions and risk follow the configured label boundaries", () => {
  const earlyLast = CONFIG.EARLY_PHASE_LABELS - 1;
  const adaptFirst = CONFIG.EARLY_PHASE_LABELS;
  const adaptLast = CONFIG.ADAPT_PHASE_LABELS - 1;
  const matureFirst = CONFIG.ADAPT_PHASE_LABELS;
  assert.equal(phaseForLabelCount(earlyLast), "EARLY");
  assert.equal(riskForPhase(earlyLast), CONFIG.EARLY_RISK);
  assert.equal(phaseForLabelCount(adaptFirst), "ADAPT");
  assert.equal(riskForPhase(adaptFirst), CONFIG.ADAPT_RISK);
  assert.equal(phaseForLabelCount(adaptLast), "ADAPT");
  assert.equal(phaseForLabelCount(matureFirst), "MATURE");
  assert.equal(riskForPhase(matureFirst), CONFIG.RISK_PER_TRADE);
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

test("risk sizing does not compound after consecutive losses", () => {
  const { riskForPhase } = require("./online-learning");
  const equity = 8;
  const first = equity * riskForPhase(0);
  const afterLoss = equity * riskForPhase(0);
  const afterManyLosses = equity * riskForPhase(0);
  assert.equal(first, equity * CONFIG.EARLY_RISK);
  assert.equal(afterLoss, first);
  assert.equal(afterManyLosses, first);
});
test("phase count ignores simulated labels and duplicate trade IDs", () => {
  const valid = {
    tradeId: "real-1", labeled: true, source: "REALIZED_CLOSED_TRADE",
    accountingSchemaVersion: 2, closedAt: 50, maePct: 0.2, mfePct: 0.4,
    side: "LONG", setupKey: "UPTREND_CONTINUATION", win: false,
    featureSnapshot: { snapshotAt: 40 },
  };
  assert.equal(countRealizedLabels([valid, { ...valid }, {
    ...valid, tradeId: "paper-1", source: "SIMULATED",
  }], 100), 1);
  assert.equal(countRealizedLabels([{ ...valid, closedAt: 101 }], 100), 0);
  assert.equal(countRealizedLabels([{ ...valid, featureSnapshot: null }], 100), 0);
  assert.equal(countRealizedLabels([{ ...valid, win: undefined }], 100), 0);
  assert.equal(countRealizedLabels([{ ...valid, maePct: "0.2" }], 100), 0);
  assert.equal(countRealizedLabels([{ ...valid, accountingSchemaVersion: 1 }], 100), 0);
});
