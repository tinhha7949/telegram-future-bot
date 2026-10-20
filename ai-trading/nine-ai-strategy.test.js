"use strict";
const assert = require("node:assert/strict");
const strategy = require("./nine-ai-strategy");

assert.equal(typeof strategy.analyzeNineAI, "function");
assert.equal(typeof strategy.compareNineAICandidates, "function");
assert.equal(strategy.RISK_FRACTION, 0.0075);
assert.equal(strategy.MAX_HOLD_BARS, 24);
assert.equal(strategy.MIN_LABELS, 30);

const a = { edge: 0.2, side: "LONG" };
const b = { edge: 0.4, side: "SHORT" };
assert.ok(strategy.compareNineAICandidates(b, a) < 0, "higher net edge ranks first");

const result = strategy.analyzeNineAI([], "BTCUSDT", {}, Date.now());
assert.equal(result.action, "WAIT");
assert.equal(result.authorizedForExecution, false);
assert.equal(result.setup, "NINE_AI_4H");

console.log("Nine-AI strategy facade tests passed");
