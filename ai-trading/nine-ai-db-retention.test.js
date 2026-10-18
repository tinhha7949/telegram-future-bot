"use strict";
const assert = require("assert");
const retention = require("./nine-ai-db-retention");

const config = { limitMB: 5120, triggerRatio: 0.80, targetRatio: 0.60 };
assert.strictEqual(retention.DEFAULTS.triggerRatio, 0.80);
assert.strictEqual(retention.DEFAULTS.targetRatio, 0.60);
assert.strictEqual(retention.DEFAULTS.enabled, false, "deletion must be disabled by default");
assert.strictEqual(retention.DEFAULTS.dryRun, true, "safe default must be preview-only");
assert.strictEqual(retention.DEFAULTS.maxDeletesPerRun, 500);
const priorDryRun = process.env.DB_RETENTION_DRY_RUN;
const priorEnableDelete = process.env.DB_RETENTION_ENABLE_DELETE;
delete process.env.DB_RETENTION_DRY_RUN;
delete process.env.DB_RETENTION_ENABLE_DELETE;
let envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, false, "unset opt-in must disable deletion");
assert.strictEqual(envConfig.dryRun, true, "unset env must preview only");
process.env.DB_RETENTION_ENABLE_DELETE = "true";
envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, true, "explicit delete opt-in should be recognized");
assert.strictEqual(envConfig.dryRun, true, "delete opt-in alone must still preview");
process.env.DB_RETENTION_DRY_RUN = "false";
envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, true);
assert.strictEqual(envConfig.dryRun, false, "real deletion requires explicit opt-in and explicit dry-run false");
process.env.DB_RETENTION_DRY_RUN = "true";
assert.strictEqual(retention.configFromEnv().dryRun, true, "explicit dry-run must override deletion opt-in");
process.env.DB_RETENTION_ENABLE_DELETE = "false";
process.env.DB_RETENTION_DRY_RUN = "false";
envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, false, "false opt-in must keep deletion disabled");
assert.strictEqual(envConfig.dryRun, true, "deletion-disabled mode must stay preview-only");
if (priorDryRun === undefined) delete process.env.DB_RETENTION_DRY_RUN;
else process.env.DB_RETENTION_DRY_RUN = priorDryRun;
if (priorEnableDelete === undefined) delete process.env.DB_RETENTION_ENABLE_DELETE;
else process.env.DB_RETENTION_ENABLE_DELETE = priorEnableDelete;
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
assert.strictEqual(specs.length, 2, "only disposable generated reports may be automatically deleted until learning preservation is proven");
assert.strictEqual(byName.nine_ai_strategy_lab_reports.days, 90);
assert.strictEqual(byName.nine_ai_autonomous_decision_reports.days, 90);
for (const protectedCollection of [
  "trades", "nine_ai_decision_journal", "nine_ai_loss_diagnoses",
  "nine_ai_counterfactual_outcomes", "nine_ai_contextual_outcomes",
  "nine_ai_learning_outcomes", "nine_ai_reward_model_outcomes",
  "nine_ai_strategy_evolution_outcomes", "nine_ai_ml_technical_outcomes",
  "nine_ai_ml_signal_outcomes", "nine_ai_ml_memory_outcomes",
  "nine_ai_ml_bull_outcomes", "nine_ai_ml_bear_outcomes",
  "nine_ai_ml_contrarian_outcomes", "nine_ai_ml_analyst_outcomes",
  "nine_ai_ml_decision_outcomes", "nine_ai_ml_risk_outcomes",
  "nine_ai_learning_state", "nine_ai_timing_deployment_policies"
]) {
  assert(!specs.some(s => s.name === protectedCollection),
    protectedCollection + " must be preserved until durable compact learning memory is implemented and verified");
}
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
