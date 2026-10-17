"use strict";
const assert = require("node:assert/strict");
const { summarizeOutcomes, chooseManagementAction, featureVector } = require("./nine-ai-tpsl-learning");

const stats = summarizeOutcomes([
  { action: "EXTEND_TP", regime: "TREND_UP", realizedR: 1.4 },
  { action: "EXTEND_TP", regime: "TREND_UP", realizedR: 0.9 },
  { action: "CLOSE_PROFIT", regime: "TREND_UP", realizedR: 0.6 },
  { action: "HOLD", regime: "TREND_UP", realizedR: -0.4 }
]);
assert.equal(stats.actions.EXTEND_TP.samples, 2);
assert.equal(stats.regimes["TREND_UP:EXTEND_TP"].meanR, 1.15);
assert.equal(stats.global.samples, 4);

const base = {
  side: "LONG", entry: 100, current: 109.8, oldTP: 110,
  initialRisk: 10, tickSize: 0.1, maxRR: 1.8,
  decisionSide: "LONG", trendAligned: true, momentumAligned: true, regime: "TREND_UP",
  features: { trend: "UP", momentum12: 1, atrPercent: 0.01, extensionAtr: 0.4 }
};
assert.equal(chooseManagementAction(base, {}).action, "HOLD",
  "untrained policy must not invent a management action or block entry");
assert.equal(chooseManagementAction({ ...base, current: 110.1 }, {}).action, "CLOSE_PROFIT");

const extensionEvidence = summarizeOutcomes([
  { action: "EXTEND_TP", regime: "TREND_UP", realizedR: 2.0 },
  { action: "EXTEND_TP", regime: "TREND_UP", realizedR: 1.8 },
  { action: "HOLD", regime: "TREND_UP", realizedR: -1.0 },
  { action: "HOLD", regime: "TREND_UP", realizedR: -0.8 }
]);
assert.equal(chooseManagementAction(base, extensionEvidence).action, "EXTEND_TP",
  "learned positive continuation outcomes must change the next management decision");

const stopEarlyEvidence = summarizeOutcomes([
  { action: "CLOSE_EARLY", regime: "TRANSITION", realizedR: 0.9 },
  { action: "CLOSE_EARLY", regime: "TRANSITION", realizedR: 0.7 },
  { action: "HOLD", regime: "TRANSITION", realizedR: -1.2 },
  { action: "HOLD", regime: "TRANSITION", realizedR: -0.9 }
]);
const reversalInput = {
  ...base, current: 104, decisionSide: "SHORT", regime: "TRANSITION",
  trendAligned: false, momentumAligned: false,
  features: { trend: "DOWN", momentum12: -1.2, structureTrend: "LOWER_HIGHS_LOWS",
    reversalStrength: 1, atrPercent: 0.02, extensionAtr: -0.5 }
};
assert.equal(chooseManagementAction(reversalInput, stopEarlyEvidence).action, "CLOSE_EARLY",
  "losses during reversal context must teach the next position to exit earlier");

const trailAction = chooseManagementAction({
  ...reversalInput, oldSL: 95,
  features: { ...reversalInput.features, atr14: 2 }
}, {});
assert.equal(trailAction.action, "TRAIL_SL",
  "15m reversal evidence must protect open profit by moving SL, not merely changing TP");
assert.ok(trailAction.sl > 95 && trailAction.sl < 104,
  "learned stop trailing must be monotonic and remain behind current price");

const trailBetterEvidence = summarizeOutcomes([
  { action: "TRAIL_SL", regime: "TRANSITION", realizedR: 2.0 },
  { action: "HOLD", regime: "TRANSITION", realizedR: -1.0 }
]);
const learnedTrailAction = chooseManagementAction({
  ...reversalInput, decisionSide: "LONG", oldSL: 95,
  features: { ...reversalInput.features, atr14: 2 }
}, trailBetterEvidence);
assert.equal(learnedTrailAction.action, "TRAIL_SL",
  "trailing remains eligible when learned TRAIL_SL expectancy beats HOLD");

const trailWorseEvidence = summarizeOutcomes([
  { action: "TRAIL_SL", regime: "TRANSITION", realizedR: -1.0 },
  { action: "HOLD", regime: "TRANSITION", realizedR: 2.0 }
]);
const rejectedTrailAction = chooseManagementAction({
  ...reversalInput, decisionSide: "LONG", oldSL: 95,
  features: { ...reversalInput.features, atr14: 2 }
}, trailWorseEvidence);
assert.notEqual(rejectedTrailAction.action, "TRAIL_SL",
  "trailing must be gated when learned TRAIL_SL expectancy is below HOLD");

const vector = featureVector(reversalInput);
assert.ok(vector.opposingDirection > 0);
assert.ok(vector.momentum < 0, "adverse momentum must be represented relative to the held side");
assert.ok(vector.reversalStructure > 0);
console.log("PASS: continuous TPSL expectancy learning uses wins and losses without fixed sample gates");
