"use strict";
const assert = require("node:assert/strict");
const { assessAvailableMargin, assessMinNotionalRisk, requiredQtyForNotional, isRiskWithinBudget } = require("./execution-risk");

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

const leveragedMargin = assessAvailableMargin({
  availableBalance: 150, notional: 2000, leverage: 20, maxNotional: 50000, multiplier: 1
});
assert.equal(leveragedMargin.ok, true, "20x leverage requires 100 USDT initial margin, not 2000 USDT notional");
assert.equal(leveragedMargin.requiredMargin, 100);
assert.equal(assessAvailableMargin({
  availableBalance: 99, notional: 2000, leverage: 20, maxNotional: 50000, multiplier: 1
}).reason, "INSUFFICIENT_AVAILABLE_MARGIN");
assert.equal(assessAvailableMargin({
  availableBalance: 10000, notional: 2000, leverage: 20, maxNotional: 1500, multiplier: 1
}).reason, "MAX_NOTIONAL_EXCEEDED");
assert.equal(assessAvailableMargin({
  availableBalance: 10000, notional: 2000, leverage: null, maxNotional: 50000, multiplier: 1
}).reason, "INVALID_MARGIN_INPUT");
console.log("PASS: entry margin gate uses current leverage and honors notional tier");
