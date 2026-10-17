"use strict";
const assert = require("node:assert/strict");
const { summarizeOutcomes, chooseManagementAction } = require("./nine-ai-tpsl-learning");

const stats = summarizeOutcomes([
  { action: "EXTEND_TP", regime: "TREND_UP", realizedR: 1.4 },
  { action: "EXTEND_TP", regime: "TREND_UP", realizedR: 0.9 },
  { action: "CLOSE_PROFIT", regime: "TREND_UP", realizedR: 0.6 }
]);
assert.equal(stats.actions.EXTEND_TP.samples, 2);
assert.equal(stats.regimes["TREND_UP:EXTEND_TP"].meanR, 1.15);

const base = {
  side: "LONG", entry: 100, current: 109.8, oldTP: 110,
  initialRisk: 10, tickSize: 0.1, maxRR: 1.8, score: 85,
  decisionSide: "LONG", trendAligned: true, momentumAligned: true, regime: "TREND_UP"
};
assert.equal(chooseManagementAction(base, {}).action, "EXTEND_TP");
assert.equal(chooseManagementAction({ ...base, current: 110.1 }, {}).action, "CLOSE_PROFIT");
assert.equal(chooseManagementAction({ ...base, current: 107, score: 40 }, {}).action, "TIGHTEN_TP");
assert.equal(chooseManagementAction({ ...base, current: 106, decisionSide: "SHORT", score: 80 }, {}).action, "CLOSE_EARLY");

const noExtension = chooseManagementAction({ ...base, current: 109.8, score: 76 }, {});
assert.equal(noExtension.action, "HOLD", "weak untrained continuation must not extend TP");
console.log("PASS: adaptive TPSL action policy and outcome statistics");
