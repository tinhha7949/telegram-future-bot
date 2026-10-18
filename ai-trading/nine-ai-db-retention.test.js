"use strict";
const assert = require("assert");
const retention = require("./nine-ai-db-retention");

const config = { limitMB: 5120, triggerRatio: 0.70, targetRatio: 0.55 };
assert.strictEqual(retention.shouldCleanup(3584, config), true);
assert.strictEqual(retention.shouldCleanup(3583.99, config), false);
assert.strictEqual(retention.estimateUsageMB([
  { totalSize: 1024 * 1024 }, { storageSize: 1024 * 1024, totalIndexSize: 512 * 1024 }
]), 2.5);

const query = retention.makeCutoffQuery("createdAt", new Date(1000), 1000, { outcomeStatus: "EVALUATED" });
assert.deepStrictEqual(query.$and[0], { outcomeStatus: "EVALUATED" });
assert.strictEqual(query.$and[1].$or.length, 2);
assert.strictEqual(query.$and[1].$or[0].createdAt.$lt.getTime(), 1000);
assert.strictEqual(query.$and[1].$or[1].createdAt.$lt, 1000);

const names = ["trades", "nine_ai_decision_journal", "nine_ai_learning_state",
  "nine_ai_timing_deployment_policies", "nine_ai_ml_signal_outcomes"];
const specs = retention.getSpecs(names);
assert(specs.some(s => s.name === "nine_ai_decision_journal"));
assert(specs.some(s => s.name === "nine_ai_ml_signal_outcomes"));
assert(!specs.some(s => s.name === "nine_ai_learning_state"));
assert(!specs.some(s => s.name === "nine_ai_timing_deployment_policies"));
assert(specs.find(s => s.name === "trades").priority > specs.find(s => s.name === "nine_ai_decision_journal").priority);
assert.deepStrictEqual(specs.find(s => s.name === "trades").filter, { result: { $in: ["WIN", "LOSS", "CLOSED"] } });

console.log("NINE-AI DB RETENTION TESTS PASSED");
