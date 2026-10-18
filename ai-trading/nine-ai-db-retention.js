"use strict";

// Capacity-aware MongoDB retention. Only runs when estimated collection storage
// crosses the configured threshold. Never drops collections/indexes or deletes
// active trades, model state, or strategy policies.
const DEFAULTS = Object.freeze({
  limitMB: 5120,
  triggerRatio: 0.80,
  targetRatio: 0.60,
  batchSize: 500,
  intervalMs: 6 * 60 * 60 * 1000,
  dryRun: false
});

const SPECS = Object.freeze([
  { name: "nine_ai_decision_journal", dateFields: ["createdAt", "scannedAt"], days: 45, emergencyDays: 30,
    filter: { outcomeStatus: "EVALUATED" }, priority: 10 },
  { name: "nine_ai_strategy_lab_reports", dateFields: ["createdAt"], days: 90, emergencyDays: 60, priority: 20 },
  { name: "nine_ai_autonomous_decision_reports", dateFields: ["createdAt"], days: 90, emergencyDays: 60, priority: 20 },
  { name: "nine_ai_counterfactual_outcomes", dateFields: ["closedAt", "createdAt"], days: 180, emergencyDays: 120, priority: 30 },
  { name: "nine_ai_contextual_outcomes", dateFields: ["closedAt", "createdAt"], days: 365, emergencyDays: 180, priority: 40 },
  { name: "nine_ai_learning_outcomes", dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365, emergencyDays: 180, priority: 40 },
  { name: "nine_ai_reward_model_outcomes", dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365, emergencyDays: 180, priority: 45 },
  { name: "nine_ai_loss_diagnoses", dateFields: ["closedAt", "createdAt", "diagnosedAt"], days: 180, emergencyDays: 120, priority: 35 }
]);

const ML_OUTCOME_NAMES = new Set([
  "nine_ai_ml_technical_outcomes", "nine_ai_ml_signal_outcomes", "nine_ai_ml_memory_outcomes",
  "nine_ai_ml_bull_outcomes", "nine_ai_ml_bear_outcomes", "nine_ai_ml_contrarian_outcomes",
  "nine_ai_ml_analyst_outcomes", "nine_ai_ml_decision_outcomes", "nine_ai_ml_risk_outcomes"
]);

function boundedNumber(env, fallback, min, max) {
  const value = Number(process.env[env]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function configFromEnv() {
  const triggerRatio = boundedNumber("DB_STORAGE_TRIGGER_RATIO", DEFAULTS.triggerRatio, 0.50, 0.95);
  return {
    limitMB: boundedNumber("DB_STORAGE_LIMIT_MB", DEFAULTS.limitMB, 512, 1024 * 1024),
    triggerRatio,
    targetRatio: Math.min(
      boundedNumber("DB_STORAGE_TARGET_RATIO", DEFAULTS.targetRatio, 0.25, 0.80),
      triggerRatio - 0.05
    ),
    batchSize: Math.round(boundedNumber("DB_RETENTION_BATCH_SIZE", DEFAULTS.batchSize, 50, 2000)),
    intervalMs: Math.round(boundedNumber("DB_RETENTION_INTERVAL_HOURS", 6, 1, 24) * 60 * 60 * 1000),
    dryRun: /^(1|true|yes)$/i.test(String(process.env.DB_RETENTION_DRY_RUN || "false"))
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
function getSpecs(collectionNames) {
  const present = new Set(collectionNames);
  const specs = SPECS.filter(spec => present.has(spec.name));
  for (const name of ML_OUTCOME_NAMES) {
    if (present.has(name)) specs.push({
      name, dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365, emergencyDays: 180, priority: 45
    });
  }
  // Trades are last-resort history only. The query explicitly excludes PENDING.
  if (present.has("trades")) specs.push({
    name: "trades", dateFields: ["closedAt", "updatedAt", "createdAt"],
    days: 730, emergencyDays: 365, priority: 90,
    filter: { result: { $in: ["WIN", "LOSS", "CLOSED"] } }
  });
  return specs.sort((a, b) => a.priority - b.priority);
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

  async function collectOldestCandidates(specs, phase) {
    const candidatesByKey = new Map();
    const now = Date.now();
    for (const spec of specs) {
      const days = phase === "normal" ? spec.days : spec.emergencyDays;
      if (!Number.isFinite(days) || days <= 0) continue;
      const cutoffMs = now - days * 24 * 60 * 60 * 1000;
      const cutoffDate = new Date(cutoffMs);
      for (const field of spec.dateFields) {
        const query = makeCutoffQuery(field, cutoffDate, cutoffMs, spec.filter || {});
        const projection = { _id: 1 };
        for (const dateField of spec.dateFields) projection[dateField] = 1;
        const docs = await db.collection(spec.name)
          .find(query, { projection })
          .sort({ [field]: 1 })
          .limit(config.batchSize)
          .toArray();
        for (const doc of docs) {
          // Prefer the collection's primary date field; use later fields only
          // when earlier schema variants are absent.
          let timestamp = null;
          for (const dateField of spec.dateFields) {
            timestamp = toTimestamp(doc[dateField]);
            if (timestamp !== null) break;
          }
          if (timestamp === null || timestamp >= cutoffMs) continue;
          const key = spec.name + ":" + String(doc._id);
          if (!candidatesByKey.has(key)) {
            candidatesByKey.set(key, { name: spec.name, id: doc._id, timestamp });
          } else if (timestamp < candidatesByKey.get(key).timestamp) {
            candidatesByKey.get(key).timestamp = timestamp;
          }
        }
      }
    }
    return sortOldestCandidates([...candidatesByKey.values()], config.batchSize);
  }

  async function pruneOldestBatch(specs, phase, dryRun) {
    // Select the oldest eligible records across ALL allowed collections, not
    // a collection-priority order.
    const candidates = await collectOldestCandidates(specs, phase);
    if (!candidates.length) return { deleted: 0, candidates: 0, perCollection: {} };
    const perCollection = {};
    if (dryRun) {
      for (const item of candidates) perCollection[item.name] = (perCollection[item.name] || 0) + 1;
      return { deleted: 0, candidates: candidates.length, perCollection };
    }
    const grouped = new Map();
    for (const item of candidates) {
      if (!grouped.has(item.name)) grouped.set(item.name, []);
      grouped.get(item.name).push(item.id);
    }
    let deleted = 0;
    for (const [name, ids] of grouped) {
      const result = await db.collection(name).deleteMany({ _id: { $in: ids } });
      const count = Number(result.deletedCount || 0);
      deleted += count;
      perCollection[name] = count;
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

      // Normal retention windows first, then emergency windows only if needed.
      // Within each phase every batch is globally ordered oldest-first.
      for (const phase of ["normal", "emergency"]) {
        let guard = 0;
        while (usageMB > targetMB && guard++ < 100) {
          const result = await pruneOldestBatch(specs, phase, config.dryRun);
          totalCandidates += result.candidates;
          totalDeleted += result.deleted;
          for (const [name, count] of Object.entries(result.perCollection)) {
            perCollection[name] = (perCollection[name] || 0) + count;
          }
          if (!result.candidates || config.dryRun || result.deleted === 0) break;
          const current = await readUsage();
          usageMB = current.usageMB;
        }
        if (usageMB <= targetMB || config.dryRun) break;
      }

      const after = config.dryRun ? before : await readUsage();
      lastSummary = {
        status: config.dryRun ? "DRY_RUN" : "COMPLETED",
        usageBeforeMB: Number(before.usageMB.toFixed(2)),
        usageAfterMB: Number(after.usageMB.toFixed(2)),
        triggerMB: Number(triggerMB.toFixed(2)),
        targetMB: Number(targetMB.toFixed(2)),
        limitMB: config.limitMB,
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
  getSpecs, toTimestamp, sortOldestCandidates, createRetention
};
