"use strict";
const assert = require("node:assert/strict");
const { assessMinNotionalRisk, requiredQtyForNotional, isRiskWithinBudget } = require("./execution-risk");

const impossible = assessMinNotionalRisk({
  minNotional: 5, price: 1.8, stopDistance: 0.0366,
  stepSize: 0.001, maxRisk: 0.0697486146
});
assert.equal(impossible.feasible, false);
assert.equal(impossible.reason, "MIN_NOTIONAL_EXCEEDS_RISK");
assert.ok(impossible.requiredRisk > impossible.maxAllowedRisk);
assert.ok(impossible.estimatedNotional >= 5);

const feasible = assessMinNotionalRisk({
  minNotional: 5, price: 1.8, stopDistance: 0.01,
  stepSize: 0.001, maxRisk: 0.0697486146
});
assert.equal(feasible.feasible, true);
assert.ok(feasible.requiredRisk <= feasible.maxAllowedRisk + 1e-10);
assert.ok(requiredQtyForNotional(5, 1.8, 0.001) * 1.8 >= 5);

assert.equal(isRiskWithinBudget(0.0697486146, 0.0697486146), true);
assert.equal(isRiskWithinBudget(0.07672347606, 0.0697486146), false,
  "10% risk overrun must not be permitted");
assert.equal(isRiskWithinBudget(NaN, 0.1), false);
assert.equal(isRiskWithinBudget(0.1, 0), false);
console.log("PASS: minimum-notional sizing never authorizes risk above the configured budget");
