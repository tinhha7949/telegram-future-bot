"use strict";
const assert = require("assert");
const retention = require("./nine-ai-db-retention");

const config = { limitMB: 5120, triggerRatio: 0.80, targetRatio: 0.60 };
assert.strictEqual(retention.DEFAULTS.triggerRatio, 0.80);
assert.strictEqual(retention.DEFAULTS.targetRatio, 0.60);
assert.strictEqual(retention.DEFAULTS.dryRun, true, "cleanup must default to non-destructive preview");
assert.strictEqual(retention.DEFAULTS.maxDeletesPerRun, 500);
assert.strictEqual(retention.shouldCleanup(4096, config), true);
assert.strictEqual(retention.shouldCleanup(4095.99, config), false);
assert.strictEqual(retention.estimateUsageMB([
  { totalSize: 1024 * 1024 }, { storageSize: 1024 * 1024, totalIndexSize: 512 * 1024 }
]), 2.5);

const query = retention.makeCutoffQuery("createdAt", new Date(1000), 1000, { outcomeStatus: "EVALUATED" });
assert.deepStrictEqual(query.$and[0], { outcomeStatus: "EVALUATED" });
assert.strictEqual(query.$and[1].$or.length, 2);
assert.strictEqual(query.$and[1].$or[0].createdAt.$lt.getTime(), 1000);
assert.strictEqual(query.$and[1].$or[1].createdAt.$lt, 1000);

assert.strictEqual(retention.toTimestamp(new Date(100)), 100);
assert.strictEqual(retention.toTimestamp(200), 200);
assert.strictEqual(retention.toTimestamp("1970-01-01T00:00:00.300Z"), 300);
assert.deepStrictEqual(
  retention.sortOldestCandidates([
    { name: "newer", timestamp: 300 },
    { name: "oldest", timestamp: 100 },
    { name: "middle", timestamp: 200 }
  ], 2).map(x => x.name),
  ["oldest", "middle"]
);

const names = ["trades", "nine_ai_decision_journal", "nine_ai_learning_state",
  "nine_ai_timing_deployment_policies", "nine_ai_ml_signal_outcomes",
  "nine_ai_strategy_lab_reports", "nine_ai_autonomous_decision_reports",
  "nine_ai_learning_outcomes", "nine_ai_counterfactual_outcomes"];
const specs = retention.getSpecs(names);
assert.deepStrictEqual(specs.map(s => s.name), [
  "nine_ai_strategy_lab_reports", "nine_ai_autonomous_decision_reports"
], "only explicitly approved old report artifacts may be automatically pruned");
assert(specs.every(s => s.days >= 365), "minimum retention age must be at least 365 days");
assert(specs.every(s => !Object.hasOwn(s, "emergencyDays")), "there must be no shorter emergency retention window");
assert(!specs.some(s => ["trades", "nine_ai_decision_journal", "nine_ai_ml_signal_outcomes",
  "nine_ai_learning_state", "nine_ai_timing_deployment_policies", "nine_ai_learning_outcomes",
  "nine_ai_counterfactual_outcomes"].includes(s.name)));

const safeSpec = { dateFields: ["closedAt", "createdAt"], filter: { outcomeStatus: "EVALUATED" } };
const safeDelete = retention.makeSafeDeleteQuery(["id-1"], safeSpec, 5000);
assert.deepStrictEqual(safeDelete.$and[0], { _id: { $in: ["id-1"] } });
assert.deepStrictEqual(safeDelete.$and[1], { outcomeStatus: "EVALUATED" });
assert.deepStrictEqual(safeDelete.$and[2].$expr.$lt[0], {
  $convert: {
    input: { $ifNull: ["$closedAt", "$createdAt"] },
    to: "date", onError: null, onNull: null
  }
});
assert.strictEqual(safeDelete.$and[2].$expr.$lt[1].getTime(), 5000);
assert.deepStrictEqual(retention.makeRetentionDateExpression(["createdAt"]), {
  $convert: { input: "$createdAt", to: "date", onError: null, onNull: null }
});

console.log("NINE-AI DB RETENTION TESTS PASSED");
