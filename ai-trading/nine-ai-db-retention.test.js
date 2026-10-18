"use strict";
const assert = require("assert");
const retention = require("./nine-ai-db-retention");

const config = { limitMB: 5120, triggerRatio: 0.80, targetRatio: 0.60 };
assert.strictEqual(retention.DEFAULTS.triggerRatio, 0.80);
assert.strictEqual(retention.DEFAULTS.targetRatio, 0.60);
assert.strictEqual(retention.DEFAULTS.enabled, true, "bounded cleanup must run by default");
assert.strictEqual(retention.DEFAULTS.dryRun, false, "production default must actually clean eligible reports");
assert.strictEqual(retention.DEFAULTS.maxDeletesPerRun, 500);
const priorDryRun = process.env.DB_RETENTION_DRY_RUN;
const priorEnableDelete = process.env.DB_RETENTION_ENABLE_DELETE;
delete process.env.DB_RETENTION_DRY_RUN;
delete process.env.DB_RETENTION_ENABLE_DELETE;
let envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, true, "unset env must enable bounded cleanup by default");
assert.strictEqual(envConfig.dryRun, false, "unset env must perform real cleanup of allowlisted reports");
process.env.DB_RETENTION_DRY_RUN = "true";
envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, true);
assert.strictEqual(envConfig.dryRun, true, "explicit dry-run must enable preview mode");
process.env.DB_RETENTION_DRY_RUN = "false";
envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.dryRun, false, "explicit false must allow actual bounded cleanup");
process.env.DB_RETENTION_ENABLE_DELETE = "false";
envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, false, "explicit kill-switch must disable deletion");
assert.strictEqual(envConfig.dryRun, true, "disabled deletion must remain non-mutating");
process.env.DB_RETENTION_ENABLE_DELETE = "true";
process.env.DB_RETENTION_DRY_RUN = "unexpected";
envConfig = retention.configFromEnv();
assert.strictEqual(envConfig.enabled, true);
assert.strictEqual(envConfig.dryRun, true, "unknown dry-run values must fail safe to preview");
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
assert(specs.length > 2, "retention must dynamically evaluate eligible collections beyond the original two reports");
assert.strictEqual(byName.nine_ai_strategy_lab_reports.days, 90);
assert.strictEqual(byName.nine_ai_autonomous_decision_reports.days, 90);
assert(byName.future_unknown_collection === undefined, "specs are built only from supplied collection names");
for (const protectedCollection of [
  "trades", "trade_history", "orders", "positions", "fills",
  "nine_ai_decision_journal", "nine_ai_loss_diagnoses",
  "nine_ai_counterfactual_outcomes", "nine_ai_contextual_outcomes",
  "nine_ai_learning_outcomes", "nine_ai_reward_model_outcomes",
  "nine_ai_strategy_evolution_outcomes", "nine_ai_ml_technical_outcomes",
  "nine_ai_ml_signal_outcomes", "nine_ai_ml_memory_outcomes",
  "nine_ai_ml_bull_outcomes", "nine_ai_ml_bear_outcomes",
  "nine_ai_ml_contrarian_outcomes", "nine_ai_ml_analyst_outcomes",
  "nine_ai_ml_decision_outcomes", "nine_ai_ml_risk_outcomes",
  "nine_ai_learning_state", "nine_ai_timing_deployment_policies"
]) {
  assert(retention.isProtectedCollection(protectedCollection),
    protectedCollection + " must be preserved as source-of-truth trading or learning data");
}
assert(retention.getSpecs(["future_unknown_collection"]).some(s => s.name === "future_unknown_collection"),
  "unrecognized non-core collections must be dynamically evaluated rather than ignored");
assert(retention.getSpecs(["system.profile"]).length === 0,
  "MongoDB system collections must never be cleaned");
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




async function testAutomaticCleanupActuallyDeletesOnlyEligibleReports() {
  const originalEnable = process.env.DB_RETENTION_ENABLE_DELETE;
  const originalDryRun = process.env.DB_RETENTION_DRY_RUN;
  delete process.env.DB_RETENTION_ENABLE_DELETE;
  delete process.env.DB_RETENTION_DRY_RUN;

  let reportUsageMB = 4100;
  let deleteCalls = 0;
  const db = {
    listCollections() {
      return { toArray: async () => [
        { name: "nine_ai_strategy_lab_reports" },
        { name: "nine_ai_autonomous_decision_reports" },
        { name: "trades" }
      ] };
    },
    collection(name) {
      return {
        stats: async () => ({
          size: name === "nine_ai_strategy_lab_reports" ? reportUsageMB : 0,
          totalIndexSize: 0,
          storageSize: 0
        }),
        aggregate() {
          return {
            toArray: async () => name === "nine_ai_strategy_lab_reports" && reportUsageMB > 4000
              ? [{ _id: "old-report-1", _retentionDate: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) }]
              : []
          };
        },
        deleteMany: async query => {
          assert.strictEqual(name, "nine_ai_strategy_lab_reports",
            "only allowlisted generated reports may be deleted");
          assert.deepStrictEqual(query.$and[0], { _id: { $in: ["old-report-1"] } });
          assert(query.$and[2].$expr, "delete must recheck the candidate's retention date");
          deleteCalls += 1;
          reportUsageMB = 3000;
          return { deletedCount: 1 };
        }
      };
    }
  };

  try {
    const controller = retention.createRetention(db);
    assert.strictEqual(controller.config.enabled, true, "default runtime must enable bounded cleanup");
    assert.strictEqual(controller.config.dryRun, false, "default runtime must perform cleanup");
    const result = await controller.runCleanup();
    assert.strictEqual(deleteCalls, 1, "controller must issue a real delete when over threshold");
    assert.strictEqual(result.status, "COMPLETED");
    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(result.usageAfterMB, 3000);
    assert.deepStrictEqual(Object.keys(result.perCollection), ["nine_ai_strategy_lab_reports"]);
  } finally {
    if (originalEnable === undefined) delete process.env.DB_RETENTION_ENABLE_DELETE;
    else process.env.DB_RETENTION_ENABLE_DELETE = originalEnable;
    if (originalDryRun === undefined) delete process.env.DB_RETENTION_DRY_RUN;
    else process.env.DB_RETENTION_DRY_RUN = originalDryRun;
  }
}

testAutomaticCleanupActuallyDeletesOnlyEligibleReports()
  .then(() => console.log("NINE-AI DB RETENTION TESTS PASSED"))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
