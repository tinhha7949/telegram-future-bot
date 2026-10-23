"use strict";
const { CONFIG } = require("./config");

// Capacity-aware MongoDB retention. Only runs when estimated collection storage
// crosses the configured threshold. Never drops collections/indexes. The explicit
// allowlist covers historical trade/learning/research events; mutable model state,
// active policies, pending work, and unknown collections remain protected.
const DEFAULTS = Object.freeze({
  limitMB: CONFIG.MEMORY_LIMIT_MB,
  triggerRatio: CONFIG.RETENTION_TRIGGER_RATIO,
  targetRatio: CONFIG.RETENTION_TARGET_RATIO,
  batchSize: CONFIG.RETENTION_BATCH_SIZE,
  maxDeletesPerRun: CONFIG.RETENTION_MAX_DELETES_PER_RUN,
  intervalMs: CONFIG.RETENTION_INTERVAL_HOURS * 60 * 60 * 1000,
  // Automatically perform bounded cleanup when the storage threshold is crossed.
  // The allowlist below contains reviewed historical event ledgers; live state stays protected.
  enabled: true,
  dryRun: false
});

// Event-ledger retention: only terminal/historical documents with a valid old
// lifecycle timestamp can be removed. Retention age is set per dataset and row type.
// Mutable state/policy collections and unknown collections remain protected.
// Outcome ledgers are eligible only after they were applied; the legacy ledger
// also must finish independent-model migration before it can be pruned.
const SPECS = Object.freeze([
  { name: "trades", dateFields: ["closedAt", "updatedAt", "createdAt"], days: 90,
    category: "closed_trade", filter: { result: { $in: ["WIN", "LOSS", "CLOSED_UNRESOLVED"] } } },
  { name: "nine_ai_decision_journal", dateFields: [
    "actualOutcomeRecordedAt", "actualOutcome.closedAt", "evaluations.16.evaluatedAt",
    "researchVariants.now_16.evaluatedAt", "researchVariants.wait2_16.evaluatedAt",
    "scannedAt", "signalTime", "createdAt"
  ], days: 90, category: "evaluated_decision", filter: {
    outcomeStatus: "EVALUATED", side: { $ne: "WAIT" }
  } },
  // WAIT rows remain useful after their forward outcomes mature, but they are
  // generated much more frequently than trades. Keep one week of evaluated WAIT
  // evidence; never delete pending or actual-trade records.
  { name: "nine_ai_decision_journal", dateFields: [
    "actualOutcomeRecordedAt", "actualOutcome.closedAt", "evaluations.16.evaluatedAt",
    "researchVariants.now_16.evaluatedAt", "researchVariants.wait2_16.evaluatedAt",
    "scannedAt", "signalTime", "createdAt"
  ], days: 90, category: "evaluated_wait_decision", filter: {
    outcomeStatus: "EVALUATED", side: "WAIT", actualTrade: { $ne: true }
  } },
  { name: "nine_ai_learning_outcomes", dateFields: ["closedAt"], days: 90,
    category: "applied_learning_outcome", filter: {
      closed: true, applied: true, independentModelsMigrated: true
    } },
  { name: "nine_ai_reward_model_outcomes", dateFields: ["closedAt"], days: 90,
    category: "applied_learning_outcome", filter: { closed: true, applied: true } },
  { name: "nine_ai_contextual_outcomes", dateFields: ["closedAt"], days: 90,
    category: "closed_learning_outcome", filter: { closed: true } },
  { name: "nine_ai_counterfactual_outcomes", dateFields: ["closedAt"], days: 90,
    category: "counterfactual_outcome", filter: { closedAt: { $exists: true } } },
  { name: "nine_ai_loss_diagnoses", dateFields: ["diagnosedAt"], days: 90,
    category: "loss_diagnosis", filter: { diagnosedAt: { $exists: true } } },
  { name: "nine_ai_strategy_lab_reports", dateFields: ["createdAt"], days: 90,
    category: "generated_report" },
  { name: "nine_ai_autonomous_decision_reports", dateFields: ["createdAt"], days: 90,
    category: "generated_report" },
  { name: "nine_ai_data_derived_consensus_reports", dateFields: ["createdAt"], days: 90,
    category: "generated_report" },
  { name: "nine_ai_strategy_hypotheses", dateFields: ["createdAt"], days: 90,
    category: "research_hypothesis", filter: { createdAt: { $exists: true } } },
  { name: "nine_ai_strategy_versions", dateFields: ["updatedAt", "createdAt"], days: 90,
    category: "research_version", filter: { createdAt: { $exists: true } } },
  { name: "nine_ai_autonomous_adaptation_history", dateFields: ["updatedAt", "createdAt"], days: 90,
    category: "adaptation_history", filter: { version: { $exists: true } } }
]);
// Strict capacity hierarchy: raw capture -> derived features -> failed model
// checkpoints -> generated research -> evaluated decisions -> closed trade ->
// actual labels. Compact OHLCV is bounded by N_CANDLES at write time, never
// deleted as a collection by maintenance.
const EXTRA_SPECS = Object.freeze([
  {name:"nine_ai_raw_ticks",dateFields:["observedAt","createdAt"],days:CONFIG.RETENTION_RAW_DAYS,
    category:"raw_tick",filter:{observedAt:{$exists:true}}},
  {name:"nine_ai_raw_liquidations",dateFields:["observedAt","createdAt"],days:CONFIG.RETENTION_RAW_DAYS,
    category:"raw_tick",filter:{observedAt:{$exists:true}}},
  {name:"nine_ai_feature_cache",dateFields:["snapshotAt","createdAt"],days:CONFIG.RETENTION_FEATURE_DAYS,
    category:"derived_feature",filter:{snapshotAt:{$exists:true}}},
  {name:"nine_ai_model_checkpoints",dateFields:["createdAt"],days:CONFIG.RETENTION_HISTORY_DAYS,
    category:"failed_checkpoint",filter:{status:{$in:["FAILED","REJECTED","SUPERSEDED"]}}},
  {name:"nine_ai_outcome_labels",dateFields:["closedAt"],days:CONFIG.RETENTION_LABEL_DAYS,
    category:"actual_label",filter:{source:"REALIZED_CLOSED_TRADE",labeled:true}},
  {name:"nine_ai_actual_outcomes",dateFields:["closedAt"],days:CONFIG.RETENTION_LABEL_DAYS,
    category:"actual_label",filter:{source:"REALIZED_CLOSED_TRADE"}},
]);
const RETENTION_PRIORITY = Object.freeze({
 raw_tick:0, derived_feature:2, failed_checkpoint:3,
 generated_report:4, research_hypothesis:4, research_version:4,
 counterfactual_outcome:4, loss_diagnosis:4,
 evaluated_wait_decision:5, evaluated_decision:6,
 closed_trade:7, actual_label:9,
});
function tier(item) {
  return RETENTION_PRIORITY[item.spec?.category] ?? 5;
}
function sortByRetentionPriority(items, limit=items.length){
  return [...items].filter(x=>Number.isFinite(x.timestamp))
    .sort((a,b)=>tier(a)-tier(b)||a.timestamp-b.timestamp)
    .slice(0,limit);
}
const MODEL_OUTCOME_PATTERN = /^nine_ai_ml_(technical|signal|memory|bull|bear|contrarian|analyst|decision|risk)_outcomes$/;
const MODEL_OUTCOME_SPEC = Object.freeze({ dateFields: ["closedAt"], days: 90,
  category: "applied_model_outcome", filter: { closed: true, applied: true } });

function boundedNumber(env, fallback, min, max) {
  const value = Number(process.env[env]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function configFromEnv() {
  const dryRunEnv = process.env.DB_RETENTION_DRY_RUN;
  const enabledEnv = process.env.DB_RETENTION_ENABLE_DELETE;
  // Cleanup is enabled by default. Explicit false is the kill-switch; explicit true
  // can re-enable it after an environment-level override.
  const enabled = enabledEnv == null
    ? DEFAULTS.enabled
    : /^(1|true|yes)$/i.test(String(enabledEnv));
  // Numeric capacity/retention settings are immutable and solely from CONFIG.yaml.
  // .env may only explicitly disable or preview destructive maintenance.
  return {
    limitMB: DEFAULTS.limitMB,
    triggerRatio: DEFAULTS.triggerRatio,
    targetRatio: DEFAULTS.targetRatio,
    batchSize: DEFAULTS.batchSize,
    maxDeletesPerRun: DEFAULTS.maxDeletesPerRun,
    intervalMs: DEFAULTS.intervalMs,
    // Default is real bounded cleanup. DB_RETENTION_DRY_RUN=true is the preview
    // switch; unknown values fail safe to preview. DB_RETENTION_ENABLE_DELETE=false
    // disables all deletion regardless of dry-run configuration.
    enabled,
    dryRun: !enabled || (dryRunEnv != null && !/^(false|0|no)$/i.test(String(dryRunEnv)))
  };
}
function estimateUsageMB(collectionStats) {
  return collectionStats.reduce((sum, s) => {
    const total = Number(s?.totalSize);
    const fallback = Number(s?.storageSize || 0) + Number(s?.totalIndexSize || s?.indexSize || 0);
    return sum + (Number.isFinite(total) && total > 0 ? total : fallback) / (1024 * 1024);
  }, 0);
}
function shouldCleanup(usageMB, config = configFromEnv()) {
  return Number.isFinite(Number(usageMB)) && Number(usageMB) >= config.limitMB * config.triggerRatio;
}
function makeCutoffQuery(dateField, cutoffDate, cutoffMs, filter = {}) {
  // Source collections contain both BSON Date and Unix-millisecond timestamps.
  return {
    $and: [
      filter,
      { $or: [
        { [dateField]: { $lt: cutoffDate } },
        { [dateField]: { $lt: cutoffMs } }
      ] }
    ]
  };
}
function makeRetentionDateExpression(dateFields) {
  // Safety rule: the newest valid timestamp wins. A recent close/update must
  // protect a document even when createdAt/closedAt is old. Invalid fields
  // become null and are ignored by $max; all-invalid dates remain ineligible.
  const convertedDates = dateFields.map(field => ({
    $convert: { input: "$" + field, to: "date", onError: null, onNull: null }
  }));
  return { $max: convertedDates };
}
function makeSafeDeleteQuery(ids, spec, cutoffMs) {
  const cutoffDate = new Date(cutoffMs);
  return {
    $and: [
      { _id: { $in: ids } },
      spec.filter || {},
      { $expr: { $lt: [makeRetentionDateExpression(spec.dateFields), cutoffDate] } }
    ]
  };
}
function getSpecs(collectionNames) {
  const present = new Set(collectionNames);
  // Fail closed: explicit event ledgers plus the nine known independent-model
  // ledgers are eligible. Do not infer eligibility from a broad name prefix.
  const specs = [...SPECS, ...EXTRA_SPECS]
    .filter(spec => present.has(spec.name)).map(spec => ({ ...spec }));
  for (const name of present) {
    if (MODEL_OUTCOME_PATTERN.test(name)) specs.push({ name, ...MODEL_OUTCOME_SPEC });
  }
  return specs;
}
function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function sortOldestCandidates(candidates, limit = candidates.length) {
  return candidates
    .filter(item => Number.isFinite(item.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, limit);
}

function createRetention(db, overrides = {}) {
  if (!db || typeof db.collection !== "function" || typeof db.listCollections !== "function") {
    throw new Error("NINE_AI_DB_RETENTION_MONGODB_REQUIRED");
  }
  const config = { ...configFromEnv(), ...overrides };
  let running = false;
  let lastSummary = null;

  async function readUsage() {
    const collectionInfo = await db.listCollections({}, { nameOnly: true }).toArray();
    const names = collectionInfo.filter(item => item.type !== "view").map(item => item.name);
    const stats = [];
    const statsErrors = [];
    for (const name of names) {
      try {
        // `stats()` is a mongosh helper, not part of the MongoDB Node.js
        // Collection API. Use the supported database command through the driver.
        const s = await db.command({ collStats: name, scale: 1024 * 1024 });
        // Use logical data + indexes for the cleanup loop. WiredTiger may keep
        // allocated storage after deletes, so storageSize can stay flat and cause
        // an otherwise-safe loop to over-delete eligible history.
        stats.push({
          name,
          totalSize: (Number(s.size || 0) + Number(s.totalIndexSize || s.indexSize || 0)) * 1024 * 1024,
          storageSize: Number(s.storageSize || 0) * 1024 * 1024,
          totalIndexSize: Number(s.totalIndexSize || s.indexSize || 0) * 1024 * 1024
        });
      } catch (error) {
        // Never make a deletion decision from a partial DB-size estimate.
        statsErrors.push({ name, message: String(error?.message || error) });
      }
    }
    return { names, stats, statsErrors, usageMB: estimateUsageMB(stats) };
  }

  async function collectOldestCandidates(specs, limit = config.batchSize) {
    const candidates = [];
    const now = Date.now();
    for (const spec of specs) {
      const days = spec.days;
      if (!Number.isFinite(days) || days <= 0) continue;
      const cutoffMs = now - days * 24 * 60 * 60 * 1000;
      // Coalesce schema variants in declared preference order, then convert
      // BSON Date, Unix-ms number, or parseable date string into one BSON Date.
      const dateInput = makeRetentionDateExpression(spec.dateFields);
      const docs = await db.collection(spec.name).aggregate([
        { $match: spec.filter || {} },
        { $addFields: { _retentionDate: dateInput } },
        { $match: { _retentionDate: { $lt: new Date(cutoffMs) } } },
        { $sort: { _retentionDate: 1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 1, _retentionDate: 1 } }
      ]).toArray();
      for (const doc of docs) {
        const timestamp = toTimestamp(doc._retentionDate);
        if (timestamp !== null && timestamp < cutoffMs) {
          candidates.push({ name: spec.name, id: doc._id, timestamp, cutoffMs, spec });
        }
      }
    }
    // Taking the first batchSize from each collection is sufficient to find
    // the global oldest batchSize records, then sort the combined candidates.
    return sortByRetentionPriority(candidates, limit);
  }

  async function pruneOldestBatch(specs, dryRun, limit = config.batchSize) {
    // Select the oldest eligible records across ALL allowed collections, not
    // a collection-priority order.
    const allCandidates = await collectOldestCandidates(specs, limit);
    if (!allCandidates.length) return { deleted: 0, candidates: 0, perCollection: {} };
    // Never delete a lower-priority tier before measuring the effect of the
    // highest-priority deletions. This protects actual labels under pressure.
    const selectedTier=tier(allCandidates[0]);
    const candidates=allCandidates.filter(item=>tier(item)===selectedTier);
    const perCollection = {};
    if (dryRun) {
      for (const item of candidates) perCollection[item.name] = (perCollection[item.name] || 0) + 1;
      return { deleted: 0, candidates: candidates.length, perCollection };
    }
    const grouped = new Map();
    for (const item of candidates) {
      const key = item.name + "|" + item.cutoffMs;
      if (!grouped.has(key)) grouped.set(key, { name: item.name, cutoffMs: item.cutoffMs, spec: item.spec, ids: [] });
      grouped.get(key).ids.push(item.id);
    }
    let deleted = 0;
    for (const group of grouped.values()) {
      // Re-check the retention age at delete time. If a record's timestamp or
      // eligibility status changed after candidate selection, it is not deleted.
      const safeQuery = makeSafeDeleteQuery(group.ids, group.spec, group.cutoffMs);
      const result = await db.collection(group.name).deleteMany(safeQuery);
      const count = Number(result.deletedCount || 0);
      deleted += count;
      perCollection[group.name] = (perCollection[group.name] || 0) + count;
    }
    return { deleted, candidates: candidates.length, perCollection };
  }

  async function runCleanup({ force = false } = {}) {
    if (running) return { status: "SKIPPED", reason: "CLEANUP_ALREADY_RUNNING" };
    running = true;
    try {
      const before = await readUsage();
      const triggerMB = config.limitMB * config.triggerRatio;
      const targetMB = config.limitMB * config.targetRatio;
      if (before.statsErrors.length) {
        lastSummary = { status: "MEASUREMENT_INCOMPLETE", usageMB: before.usageMB,
          triggerMB, targetMB, statsErrors: before.statsErrors, deleted: 0,
          note: "No deletion performed because one or more collection sizes could not be measured." };
        console.error("⚠️ NINE-AI DB RETENTION MEASUREMENT INCOMPLETE: " + JSON.stringify(lastSummary));
        return lastSummary;
      }
      const specs = getSpecs(before.names);
      // Expired evaluated WAIT rows are pruned on every retention cycle, even
      // below the global capacity threshold. This prevents the scan journal from
      // accumulating indefinitely on smaller databases. Pending and actual-trade
      // rows are excluded by the dedicated allowlisted spec.
      if (!force && before.usageMB < triggerMB) {
        const waitSpec = specs.find(spec => spec.category === "evaluated_wait_decision");
        const waitCleanup = waitSpec
          ? await pruneOldestBatch([waitSpec], config.dryRun,
            Math.min(config.batchSize, config.maxDeletesPerRun))
          : { deleted: 0, candidates: 0, perCollection: {} };
        lastSummary = {
          status: config.dryRun && waitCleanup.candidates ? "DRY_RUN" :
            waitCleanup.deleted ? "WAIT_RETENTION_COMPLETED" : "BELOW_THRESHOLD",
          usageMB: Number(before.usageMB.toFixed(2)), triggerMB, targetMB,
          deleted: waitCleanup.deleted, candidates: waitCleanup.candidates,
          perCollection: waitCleanup.perCollection, dryRun: config.dryRun
        };
        if (waitCleanup.deleted || (config.dryRun && waitCleanup.candidates)) {
          console.log("🧹 NINE-AI DB RETENTION: " + JSON.stringify(lastSummary));
        }
        return lastSummary;
      }

      let usageMB = before.usageMB;
      let totalDeleted = 0;
      let totalCandidates = 0;
      const perCollection = {};

      // One strict retention policy only. No emergency mode may shorten age limits.
      // Cap total deletes per run so a bad estimate cannot trigger an unbounded purge.
      let guard = 0;
      while (usageMB > targetMB && totalDeleted < config.maxDeletesPerRun && guard++ < 100) {
          const remaining = config.dryRun ? config.batchSize : Math.min(config.batchSize, config.maxDeletesPerRun - totalDeleted);
          const result = await pruneOldestBatch(specs, config.dryRun, remaining);
          totalCandidates += result.candidates;
          totalDeleted += result.deleted;
          for (const [name, count] of Object.entries(result.perCollection)) {
            perCollection[name] = (perCollection[name] || 0) + count;
          }
          if (!result.candidates || config.dryRun || result.deleted === 0) break;
          const current = await readUsage();
          usageMB = current.usageMB;
      }

      const after = config.dryRun ? before : await readUsage();
      lastSummary = {
        status: config.dryRun ? "DRY_RUN" : "COMPLETED",
        deletionEnabled: config.enabled,
        usageBeforeMB: Number(before.usageMB.toFixed(2)),
        usageAfterMB: Number(after.usageMB.toFixed(2)),
        triggerMB: Number(triggerMB.toFixed(2)),
        targetMB: Number(targetMB.toFixed(2)),
        limitMB: config.limitMB,
        maxDeletesPerRun: config.maxDeletesPerRun,
        eligibleCollections: specs.map(spec => ({ name: spec.name, days: spec.days, category: spec.category })),
        // Report but never mutate collections outside the explicit reviewed allowlist.
        preservedUnreviewedCollections: before.names.filter(name => !specs.some(spec => spec.name === name)),
        deleted: totalDeleted,
        candidates: totalCandidates,
        perCollection,
        dryRun: config.dryRun,
        note: after.usageMB > targetMB
          ? "Target not reached: no more eligible old records, or Atlas usage differs from per-collection estimates."
          : "Target reached."
      };
      if (totalDeleted > 0 || config.dryRun) {
        console.log("🧹 NINE-AI DB RETENTION: " + JSON.stringify(lastSummary));
      }
      return lastSummary;
    } finally {
      running = false;
    }
  }

  return { runCleanup, readUsage, getLastSummary: () => lastSummary, config };
}

module.exports = {
  DEFAULTS, SPECS, EXTRA_SPECS, sortByRetentionPriority,
  configFromEnv, estimateUsageMB, shouldCleanup, makeCutoffQuery,
  makeRetentionDateExpression, makeSafeDeleteQuery,
  getSpecs, toTimestamp, sortOldestCandidates, createRetention
};
