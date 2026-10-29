"use strict";
const assert = require("assert");
const retention = require("./nine-ai-db-retention");
const { CONFIG } = require("./config");

const config = { limitMB: 500, triggerRatio: 0.86, targetRatio: 0.60 };
assert.strictEqual(retention.DEFAULTS.limitMB, 500);
assert.strictEqual(retention.DEFAULTS.triggerRatio, 0.86);
assert.strictEqual(retention.configFromEnv().limitMB * retention.DEFAULTS.triggerRatio, 430);
assert.strictEqual(retention.configFromEnv().limitMB * retention.DEFAULTS.targetRatio, 300);
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
assert.strictEqual(retention.shouldCleanup(430, config), true);
assert.strictEqual(retention.shouldCleanup(429.99, config), false);
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
  "nine_ai_data_derived_consensus_reports",
  "nine_ai_learning_outcomes", "nine_ai_counterfactual_outcomes",
  "nine_ai_contextual_outcomes", "nine_ai_reward_model_outcomes",
  "nine_ai_loss_diagnoses", "nine_ai_strategy_evolution_outcomes",
  "nine_ai_ml_technical_outcomes", "nine_ai_ml_memory_outcomes",
  "nine_ai_ml_bull_outcomes", "nine_ai_ml_bear_outcomes",
  "nine_ai_ml_contrarian_outcomes", "nine_ai_ml_analyst_outcomes",
  "nine_ai_ml_decision_outcomes", "nine_ai_ml_risk_outcomes",
  "nine_ai_autonomous_adaptation_history", "nine_ai_strategy_hypotheses",
  "nine_ai_strategy_versions", "nine_ai_ml_unknown_outcomes"
];
const specs = retention.getSpecs(names);
const byName = Object.fromEntries(specs.map(s => [s.name, s]));
assert.strictEqual(specs.length, 23, "all explicitly reviewed event ledgers and model outcomes must be eligible");
assert.strictEqual(byName.trades.days, 90);
assert.deepStrictEqual(byName.trades.filter, { result: { $in: ["WIN", "LOSS", "CLOSED_UNRESOLVED"] } });
const journalSpecs = specs.filter(s => s.name === "nine_ai_decision_journal");
assert.strictEqual(journalSpecs.length, 2, "journal has separate directional and WAIT retention");
assert.strictEqual(retention.DECISION_RETENTION_DAYS, Math.ceil((CONFIG.TRAIN_WINDOW_CANDLES + CONFIG.TIMEOUT_BARS) * CONFIG.BAR_HOURS / 24));
assert.strictEqual(journalSpecs.find(s => s.category === "evaluated_decision").days, retention.DECISION_RETENTION_DAYS);
assert.deepStrictEqual(journalSpecs.find(s => s.category === "evaluated_decision").filter, {
  outcomeStatus: "EVALUATED", side: { $ne: "WAIT" }
});
assert.strictEqual(journalSpecs.find(s => s.category === "evaluated_wait_decision").days, retention.DECISION_RETENTION_DAYS);
assert.deepStrictEqual(journalSpecs.find(s => s.category === "evaluated_wait_decision").filter, {
  outcomeStatus: "EVALUATED", side: "WAIT", actualTrade: { $ne: true }
});
assert.strictEqual(byName.nine_ai_learning_outcomes.filter.applied, true);
assert.strictEqual(byName.nine_ai_learning_outcomes.filter.independentModelsMigrated, true);
for (const model of ["technical", "signal", "memory", "bull", "bear", "contrarian", "analyst", "decision", "risk"]) {
  assert.strictEqual(byName[`nine_ai_ml_${model}_outcomes`].filter.applied, true,
    "only already-applied model training evidence may be removed");
}
assert.strictEqual(byName.nine_ai_strategy_lab_reports.days, 90);
assert.strictEqual(byName.nine_ai_autonomous_decision_reports.days, 90);
assert.strictEqual(byName.nine_ai_data_derived_consensus_reports.days, 90);
for (const protectedCollection of [
  "nine_ai_learning_state", "nine_ai_timing_deployment_policies",
  "nine_ai_reward_model_state", "nine_ai_decision_policies",
  "nine_ai_strategy_policy", "nine_ai_counterfactual_policies",
  "nine_ai_data_derived_consensus_policies",
  "nine_ai_ml_signal_state", "nine_ai_ml_unknown_outcomes",
  "nine_ai_pending_timing_entries", "trade_signal_claims"
]) {
  assert(!specs.some(s => s.name === protectedCollection),
    protectedCollection + " must remain protected from age-based event retention");
}
assert(!retention.getSpecs(["future_unknown_collection"]).length,
  "unknown collections must fail closed and remain untouched");
assert(!retention.getSpecs(["nine_ai_ml_future_outcomes"]).length,
  "unknown model outcome collections must fail closed");
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
const tradeSpec = byName.trades;
const safeTradeDelete = retention.makeSafeDeleteQuery(["trade-1"], tradeSpec, 5000);
assert.deepStrictEqual(safeTradeDelete.$and[1], tradeSpec.filter,
  "trade deletion must recheck that the trade is terminal at deletion time");
assert.deepStrictEqual(safeTradeDelete.$and[2].$expr.$lt[0], {
  $max: [
    { $convert: { input: "$closedAt", to: "date", onError: null, onNull: null } },
    { $convert: { input: "$updatedAt", to: "date", onError: null, onNull: null } },
    { $convert: { input: "$createdAt", to: "date", onError: null, onNull: null } }
  ]
}, "a recently updated or recently closed trade must be protected even if created long ago");
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




async function testAutomaticCleanupDeletesOldEventsAcrossEligibleCollectors() {
  const originalEnable = process.env.DB_RETENTION_ENABLE_DELETE;
  const originalDryRun = process.env.DB_RETENTION_DRY_RUN;
  delete process.env.DB_RETENTION_ENABLE_DELETE;
  delete process.env.DB_RETENTION_DRY_RUN;

  let reportUsageMB = 450;
  let deleteCalls = 0;
  const deletedCollections = [];
  const db = {
    listCollections() {
      return { toArray: async () => [
        { name: "nine_ai_strategy_lab_reports" },
        { name: "nine_ai_autonomous_decision_reports" },
        { name: "trades" }
      ] };
    },
    async command(command) {
      assert.strictEqual(command.scale, 1024 * 1024);
      return { size: command.collStats === "nine_ai_strategy_lab_reports" ? reportUsageMB : 0,
        totalIndexSize: 0, storageSize: 0 };
    },
    collection(name) {
      return {
        aggregate(pipeline) {
          return {
            toArray: async () => {
              if (name === "trades") assert.deepStrictEqual(pipeline[0].$match, byName.trades.filter,
                "candidate scan must exclude active trades");
              return name === "nine_ai_strategy_lab_reports" && reportUsageMB > 400
                ? [{ _id: "old-report-1", _retentionDate: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) }]
                : name === "trades" && reportUsageMB > 400
                  ? [{ _id: "old-closed-trade", _retentionDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) }]
                  : [];
            }
          };
        },
        deleteMany: async query => {
          assert(["nine_ai_strategy_lab_reports", "trades"].includes(name),
            "cleanup may delete from eligible historical collectors");
          assert.deepStrictEqual(query.$and[0], { _id: { $in: [name === "trades" ? "old-closed-trade" : "old-report-1"] } });
          assert(query.$and[2].$expr, "delete must recheck the candidate's retention date");
          if (name === "trades") assert.deepStrictEqual(query.$and[1], byName.trades.filter,
            "delete-time check must preserve open and nonterminal trades");
          deleteCalls += 1;
          deletedCollections.push(name);
          reportUsageMB = 300;
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
    assert.strictEqual(deleteCalls, 1, "delete lower-priority trades only after reports and remeasuring");
    assert.strictEqual(result.status, "COMPLETED");
    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(result.usageAfterMB, 300);
    assert.deepStrictEqual(new Set(Object.keys(result.perCollection)),
      new Set(["nine_ai_strategy_lab_reports"]));
    assert.deepStrictEqual(new Set(deletedCollections),
      new Set(["nine_ai_strategy_lab_reports"]));
  } finally {
    if (originalEnable === undefined) delete process.env.DB_RETENTION_ENABLE_DELETE;
    else process.env.DB_RETENTION_ENABLE_DELETE = originalEnable;
    if (originalDryRun === undefined) delete process.env.DB_RETENTION_DRY_RUN;
    else process.env.DB_RETENTION_DRY_RUN = originalDryRun;
  }
}

async function testExpiredWaitRowsArePrunedBelowCapacityThreshold() {
  const originalEnable = process.env.DB_RETENTION_ENABLE_DELETE;
  const originalDryRun = process.env.DB_RETENTION_DRY_RUN;
  delete process.env.DB_RETENTION_ENABLE_DELETE;
  delete process.env.DB_RETENTION_DRY_RUN;
  let deleteCalls = 0;
  const db = {
    listCollections() {
      return { toArray: async () => [{ name: "nine_ai_decision_journal" }] };
    },
    async command() {
      return { size: 100, totalIndexSize: 0, storageSize: 100 };
    },
    collection(name) {
      assert.strictEqual(name, "nine_ai_decision_journal");
      return {
        aggregate(pipeline) {
          return {
            toArray: async () => {
              assert.deepStrictEqual(pipeline[0].$match, {
                outcomeStatus: "EVALUATED", side: "WAIT", actualTrade: { $ne: true }
              });
              return [{ _id: "expired-wait", _retentionDate: new Date(Date.now() - (retention.DECISION_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000) }];
            }
          };
        },
        deleteMany: async query => {
          assert.deepStrictEqual(query.$and[0], { _id: { $in: ["expired-wait"] } });
          assert.deepStrictEqual(query.$and[1], {
            outcomeStatus: "EVALUATED", side: "WAIT", actualTrade: { $ne: true }
          });
          deleteCalls += 1;
          return { deletedCount: 1 };
        }
      };
    }
  };
  try {
    const result = await retention.createRetention(db).runCleanup();
    assert.strictEqual(result.status, "WAIT_RETENTION_COMPLETED");
    assert.strictEqual(result.usageMB, 100, "WAIT cleanup must run even below the 430 MB threshold");
    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(deleteCalls, 1);
  } finally {
    if (originalEnable === undefined) delete process.env.DB_RETENTION_ENABLE_DELETE;
    else process.env.DB_RETENTION_ENABLE_DELETE = originalEnable;
    if (originalDryRun === undefined) delete process.env.DB_RETENTION_DRY_RUN;
    else process.env.DB_RETENTION_DRY_RUN = originalDryRun;
  }
}

async function testIncompleteMeasurementNeverDeletes() {
  const originalEnable = process.env.DB_RETENTION_ENABLE_DELETE;
  const originalDryRun = process.env.DB_RETENTION_DRY_RUN;
  delete process.env.DB_RETENTION_ENABLE_DELETE;
  delete process.env.DB_RETENTION_DRY_RUN;
  let deleteCalls = 0;
  const db = {
    listCollections() { return { toArray: async () => [{ name: "trades" }, { name: "nine_ai_strategy_lab_reports" }] }; },
    async command({ collStats }) {
      if (collStats === "trades") throw new Error("stats permission denied");
      return { size: 5000, totalIndexSize: 0, storageSize: 0 };
    },
    collection(name) {
      return {
        deleteMany: async () => { deleteCalls += 1; return { deletedCount: 1 }; }
      };
    }
  };
  try {
    const result = await retention.createRetention(db).runCleanup();
    assert.strictEqual(result.status, "MEASUREMENT_INCOMPLETE");
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(deleteCalls, 0, "partial storage measurement must not trigger a possibly mis-sized purge");
  } finally {
    if (originalEnable === undefined) delete process.env.DB_RETENTION_ENABLE_DELETE;
    else process.env.DB_RETENTION_ENABLE_DELETE = originalEnable;
    if (originalDryRun === undefined) delete process.env.DB_RETENTION_DRY_RUN;
    else process.env.DB_RETENTION_DRY_RUN = originalDryRun;
  }
}

testAutomaticCleanupDeletesOldEventsAcrossEligibleCollectors()
  .then(testExpiredWaitRowsArePrunedBelowCapacityThreshold)
  .then(testIncompleteMeasurementNeverDeletes)
  .then(() => console.log("NINE-AI DB RETENTION TESTS PASSED"))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

const tiers=retention.sortByRetentionPriority([
 {name:"label",timestamp:1,spec:{category:"actual_label"}},
 {name:"raw",timestamp:999,spec:{category:"raw_tick"}},
 {name:"feature",timestamp:2,spec:{category:"derived_feature"}},
 {name:"report",timestamp:3,spec:{category:"generated_report"}}
]).map(x=>x.name);
assert.deepStrictEqual(tiers,["raw","feature","report","label"],
 "label is last regardless of document age");
const prevLimit=process.env.DB_STORAGE_LIMIT_MB;
process.env.DB_STORAGE_LIMIT_MB="1";
assert.strictEqual(retention.configFromEnv().limitMB,500,
 "environment must not override YAML capacity");
if(prevLimit===undefined)delete process.env.DB_STORAGE_LIMIT_MB;
else process.env.DB_STORAGE_LIMIT_MB=prevLimit;
