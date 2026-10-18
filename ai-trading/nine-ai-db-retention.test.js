"use strict";
const assert = require("assert");
const retention = require("./nine-ai-db-retention");

const config = { limitMB: 5120, triggerRatio: 0.80, targetRatio: 0.60 };
assert.strictEqual(retention.DEFAULTS.triggerRatio, 0.80);
assert.strictEqual(retention.DEFAULTS.targetRatio, 0.60);
assert.strictEqual(retention.DEFAULTS.dryRun, false, "cleanup must autonomously delete eligible records by default");
assert.strictEqual(retention.DEFAULTS.maxDeletesPerRun, 500);
const priorDryRun = process.env.DB_RETENTION_DRY_RUN;
delete process.env.DB_RETENTION_DRY_RUN;
assert.strictEqual(retention.configFromEnv().dryRun, false, "unset env must enable autonomous real cleanup");
process.env.DB_RETENTION_DRY_RUN = "true";
assert.strictEqual(retention.configFromEnv().dryRun, true, "explicit true must enable preview-only mode");
process.env.DB_RETENTION_DRY_RUN = "false";
assert.strictEqual(retention.configFromEnv().dryRun, false, "explicit false must enable real cleanup");
if (priorDryRun === undefined) delete process.env.DB_RETENTION_DRY_RUN;
else process.env.DB_RETENTION_DRY_RUN = priorDryRun;
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

const names = [
  "trades", "nine_ai_decision_journal", "nine_ai_learning_state",
  "nine_ai_timing_deployment_policies", "nine_ai_ml_signal_outcomes",
  "nine_ai_strategy_lab_reports", "nine_ai_autonomous_decision_reports",
  "nine_ai_learning_outcomes", "nine_ai_counterfactual_outcomes",
  "nine_ai_contextual_outcomes", "nine_ai_reward_model_outcomes",
  "nine_ai_loss_diagnoses", "nine_ai_strategy_evolution_outcomes",
  "nine_ai_ml_technical_outcomes", "nine_ai_ml_memory_outcomes"
];
const specs = retention.getSpecs(names);
const byName = Object.fromEntries(specs.map(s => [s.name, s]));
assert.strictEqual(specs.length, 13, "all approved data-retention tiers, including closed trade history, must be available");
assert.strictEqual(byName.trades.days, 90, "closed trade history must have a bounded retention window");
assert.deepStrictEqual(byName.trades.filter, { result: { $in: ["WIN", "LOSS"] } }, "only terminal WIN/LOSS trades are eligible");
assert.deepStrictEqual(byName.trades.dateFields, ["closedAt", "updatedAt", "createdAt"]);
assert.strictEqual(byName.nine_ai_decision_journal.days, 90);
assert.deepStrictEqual(byName.nine_ai_decision_journal.filter, { outcomeStatus: "EVALUATED" });
assert.strictEqual(byName.nine_ai_strategy_lab_reports.days, 90);
assert.strictEqual(byName.nine_ai_autonomous_decision_reports.days, 90);
assert.strictEqual(byName.nine_ai_loss_diagnoses.days, 180);
assert.deepStrictEqual(byName.nine_ai_contextual_outcomes.filter, { closed: true },
  "only completed contextual outcomes are eligible");
for (const name of [
  "nine_ai_learning_outcomes", "nine_ai_reward_model_outcomes",
  "nine_ai_strategy_evolution_outcomes", "nine_ai_ml_signal_outcomes",
  "nine_ai_ml_technical_outcomes", "nine_ai_ml_memory_outcomes"
]) {
  assert.deepStrictEqual(byName[name].filter, { closed: true, applied: true },
    name + " must not delete outcomes until learning has been applied");
}
for (const name of [
  "nine_ai_counterfactual_outcomes", "nine_ai_contextual_outcomes",
  "nine_ai_learning_outcomes", "nine_ai_reward_model_outcomes",
  "nine_ai_strategy_evolution_outcomes", "nine_ai_ml_signal_outcomes",
  "nine_ai_ml_technical_outcomes", "nine_ai_ml_memory_outcomes"
]) {
  assert.strictEqual(byName[name].days, 365, name + " must retain learning evidence for at least 365 days");
}
assert(!specs.some(s => ["nine_ai_learning_state", "nine_ai_timing_deployment_policies"].includes(s.name)),
  "mutable model/policy state must never be automatically deleted");
assert(!retention.getSpecs(["future_unknown_collection"]).length,
  "unknown collections must fail closed and remain untouched");
assert(!specs.some(s => Object.hasOwn(s, "emergencyDays")), "no emergency path may shorten age limits");

const safeSpec = { dateFields: ["closedAt", "createdAt"], filter: { outcomeStatus: "EVALUATED" } };
const safeDelete = retention.makeSafeDeleteQuery(["id-1"], safeSpec, 5000);
assert.deepStrictEqual(safeDelete.$and[0], { _id: { $in: ["id-1"] } });
assert.deepStrictEqual(safeDelete.$and[1], { outcomeStatus: "EVALUATED" });
assert.deepStrictEqual(safeDelete.$and[2].$expr.$lt[0], {
  $max: [
    { $convert: { input: "$closedAt", to: "date", onError: null, onNull: null } },
    { $convert: { input: "$createdAt", to: "date", onError: null, onNull: null } }
  ]
});
assert.strictEqual(safeDelete.$and[2].$expr.$lt[1].getTime(), 5000);
assert.deepStrictEqual(retention.makeRetentionDateExpression(["createdAt"]), {
  $max: [{ $convert: { input: "$createdAt", to: "date", onError: null, onNull: null } }]
});
assert.deepStrictEqual(retention.makeRetentionDateExpression(["closedAt", "updatedAt", "createdAt"]), {
  $max: [
    { $convert: { input: "$closedAt", to: "date", onError: null, onNull: null } },
    { $convert: { input: "$updatedAt", to: "date", onError: null, onNull: null } },
    { $convert: { input: "$createdAt", to: "date", onError: null, onNull: null } }
  ]
}, "any recent valid lifecycle timestamp must protect a document");

console.log("NINE-AI DB RETENTION TESTS PASSED");
