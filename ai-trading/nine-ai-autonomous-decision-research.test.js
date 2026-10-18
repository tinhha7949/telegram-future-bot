"use strict";
const assert = require("node:assert/strict");
const research = require("./nine-ai-autonomous-decision-research");

assert.equal(research.maxDrawdownR([1, -2, 1]), 2);
const values = Array.from({ length: 100 }, (_, i) => ({
  signalTime: i * 900000,
  side: i % 2 ? "WAIT" : "LONG",
  marketRegime: "TREND_UP",
  researchVariants: {
    now_4: { netR: 0.5 },
    now_16: { netR: 0.4 },
    wait1_4: { netR: 0.1 },
    wait1_16: { netR: 0.1 },
    wait2_4: { netR: -0.1 },
    wait2_16: { netR: -0.1 }
  }
}));
const metrics = research.metrics(values, "now_4");
assert.equal(metrics.n, 100);
assert.equal(metrics.expectancyR, 0.5);
assert.equal(metrics.winRate, 1);
assert.equal(metrics.maxDrawdownR, 0);
const evaluated = research.evaluateGroup(values);
assert.equal(evaluated.split, "chronological_70_30");
assert.equal(evaluated.variants.now_4.train.n, 70);
assert.equal(evaluated.variants.now_4.test.n, 30);
assert.ok(evaluated.candidates.some(candidate => candidate.variant === "now_4" && candidate.validated));
assert.ok(!evaluated.candidates.find(candidate => candidate.variant === "wait2_4").validated);
assert.equal(research.assessLive({ marketRegime: "TREND_UP" }, "LONG").bonus, 0);
console.log("nine-ai-autonomous-decision-research.test.js: OK");
