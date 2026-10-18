"use strict";

// Capacity-aware MongoDB retention. Only runs when estimated collection storage
// crosses the configured threshold. Never drops collections/indexes or deletes
// active trades, model state, or strategy policies.
const DEFAULTS = Object.freeze({
  limitMB: 5120,
  triggerRatio: 0.80,
  targetRatio: 0.60,
  batchSize: 100,
  maxDeletesPerRun: 500,
  intervalMs: 6 * 60 * 60 * 1000,
  // Autonomous cleanup is the default. Set DB_RETENTION_DRY_RUN=true only to pause deletion.
  dryRun: false
});

// Automatic cleanup runs for explicitly reviewed, age-bounded collections only.
// Tiered retention based on the role of each collection. High-volume evaluated
// research artifacts can age out sooner; actual learning evidence stays >= 365d.
// Mutable policies, model state, active trades, and unknown collections are excluded.
const SPECS = Object.freeze([
  // Completed trades only. "result" is the source-of-truth terminal state in index.js;
  // PENDING/unknown statuses never match. Keep 90 days because recent trade history
  // feeds live performance statistics; older closed records are outside the live window.
  { name: "trades", dateFields: ["closedAt", "updatedAt", "createdAt"], days: 90,
    filter: { result: { $in: ["WIN", "LOSS"] } }, category: "closed_trade_history", priority: 5 },
  { name: "nine_ai_decision_journal", dateFields: ["createdAt", "scannedAt"], days: 90,
    filter: { outcomeStatus: "EVALUATED" }, category: "evaluated_research", priority: 10 },
  { name: "nine_ai_strategy_lab_reports", dateFields: ["createdAt"], days: 90,
    category: "generated_report", priority: 20 },
  { name: "nine_ai_autonomous_decision_reports", dateFields: ["createdAt"], days: 90,
    category: "generated_report", priority: 20 },
  { name: "nine_ai_loss_diagnoses", dateFields: ["closedAt", "createdAt", "diagnosedAt"], days: 180,
    category: "derived_diagnosis", priority: 30 },
  { name: "nine_ai_counterfactual_outcomes", dateFields: ["closedAt", "createdAt"], days: 365,
    category: "learning_evidence", priority: 40 },
  { name: "nine_ai_contextual_outcomes", dateFields: ["closedAt", "createdAt"], days: 365,
    filter: { closed: true }, category: "learning_evidence", priority: 50 },
  { name: "nine_ai_learning_outcomes", dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365,
    filter: { closed: true, applied: true }, category: "learning_evidence", priority: 50 },
  { name: "nine_ai_reward_model_outcomes", dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365,
    filter: { closed: true, applied: true }, category: "learning_evidence", priority: 50 },
  { name: "nine_ai_strategy_evolution_outcomes", dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365,
    filter: { closed: true, applied: true }, category: "learning_evidence", priority: 50 },
  ...[
    "technical", "signal", "memory", "bull", "bear", "contrarian", "analyst", "decision", "risk"
  ].map(id => ({
    name: "nine_ai_ml_" + id + "_outcomes",
    dateFields: ["closedAt", "createdAt", "updatedAt"],
    days: 365,
    filter: { closed: true, applied: true },
    category: "learning_evidence",
    priority: 50
  }))
]);

function boundedNumber(env, fallback, min, max) {
  const value = Number(process.env[env]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function configFromEnv() {
  const dryRunEnv = process.env.DB_RETENTION_DRY_RUN;
  const triggerRatio = boundedNumber("DB_STORAGE_TRIGGER_RATIO", DEFAULTS.triggerRatio, 0.50, 0.95);
  return {
    limitMB: boundedNumber("DB_STORAGE_LIMIT_MB", DEFAULTS.limitMB, 512, 1024 * 1024),
    triggerRatio,
    targetRatio: Math.min(
      boundedNumber("DB_STORAGE_TARGET_RATIO", DEFAULTS.targetRatio, 0.25, 0.80),
      triggerRatio - 0.05
    ),
    batchSize: Math.round(boundedNumber("DB_RETENTION_BATCH_SIZE", DEFAULTS.batchSize, 10, 500)),
    maxDeletesPerRun: Math.round(boundedNumber("DB_RETENTION_MAX_DELETES_PER_RUN", DEFAULTS.maxDeletesPerRun, 10, 2000)),
    intervalMs: Math.round(boundedNumber("DB_RETENTION_INTERVAL_HOURS", 6, 1, 24) * 60 * 60 * 1000),
    // Default to real bounded cleanup. Dry-run is an explicit operational override.
    dryRun: dryRunEnv != null && /^(1|true|yes)$/i.test(String(dryRunEnv))
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
  // Fail closed: only explicitly reviewed collections are eligible.
  return SPECS.filter(spec => present.has(spec.name)).map(spec => ({ ...spec }));
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
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name);
    const stats = [];
    for (const name of names) {
      try {
        const s = await db.collection(name).stats(1024 * 1024);
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
        // A collection disappearing during measurement should not stop the bot.
      }
    }
    return { names, stats, usageMB: estimateUsageMB(stats) };
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
    return sortOldestCandidates(candidates, limit);
  }

  async function pruneOldestBatch(specs, dryRun, limit = config.batchSize) {
    // Select the oldest eligible records across ALL allowed collections, not
    // a collection-priority order.
    const candidates = await collectOldestCandidates(specs, limit);
    if (!candidates.length) return { deleted: 0, candidates: 0, perCollection: {} };
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
      if (!force && before.usageMB < triggerMB) {
        lastSummary = { status: "BELOW_THRESHOLD", usageMB: before.usageMB,
          triggerMB, targetMB, deleted: 0 };
        return lastSummary;
      }

      let usageMB = before.usageMB;
      let totalDeleted = 0;
      let totalCandidates = 0;
      const perCollection = {};
      const specs = getSpecs(before.names);

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
  DEFAULTS, SPECS, configFromEnv, estimateUsageMB, shouldCleanup, makeCutoffQuery,
  makeRetentionDateExpression, makeSafeDeleteQuery,
  getSpecs, toTimestamp, sortOldestCandidates, createRetention
};
