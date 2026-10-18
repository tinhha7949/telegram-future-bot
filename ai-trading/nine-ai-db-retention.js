"use strict";

// Capacity-aware MongoDB retention. Only runs when estimated collection storage
// crosses the configured threshold. Never drops collections/indexes or deletes
// active trades, model state, or strategy policies.
const DEFAULTS = Object.freeze({
  limitMB: 5120,
  triggerRatio: 0.70,
  targetRatio: 0.55,
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
  { name: "nine_ai_counterfactual_policies", dateFields: ["updatedAt", "createdAt"], days: 365, emergencyDays: 365, priority: 80,
    filter: { status: { $ne: "ACTIVE" } } },
  { name: "nine_ai_contextual_outcomes", dateFields: ["closedAt", "createdAt"], days: 365, emergencyDays: 180, priority: 40 },
  { name: "nine_ai_learning_outcomes", dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365, emergencyDays: 180, priority: 40 },
  { name: "nine_ai_reward_model_outcomes", dateFields: ["closedAt", "createdAt", "updatedAt"], days: 365, emergencyDays: 180, priority: 45 },
  { name: "nine_ai_loss_diagnoses", dateFields: ["closedAt", "createdAt", "diagnosedAt"], days: 180, emergencyDays: 120, priority: 35 },
  { name: "nine_ai_strategy_hypotheses", dateFields: ["updatedAt", "createdAt"], days: 180, emergencyDays: 120, priority: 25,
    filter: { status: { $nin: ["ACTIVE", "PROMOTED"] } } },
  { name: "nine_ai_strategy_lab_reports", dateFields: ["createdAt"], days: 90, emergencyDays: 60, priority: 20 }
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
  return {
    limitMB: boundedNumber("DB_STORAGE_LIMIT_MB", DEFAULTS.limitMB, 512, 1024 * 1024),
    triggerRatio: boundedNumber("DB_STORAGE_TRIGGER_RATIO", DEFAULTS.triggerRatio, 0.50, 0.95),
    targetRatio: boundedNumber("DB_STORAGE_TARGET_RATIO", DEFAULTS.targetRatio, 0.25, 0.80),
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
        stats.push({ name, totalSize: Number(s.totalSize || 0) * 1024 * 1024,
          storageSize: Number(s.storageSize || 0) * 1024 * 1024,
          totalIndexSize: Number(s.totalIndexSize || s.indexSize || 0) * 1024 * 1024 });
      } catch (error) {
        // A collection disappearing during measurement should not stop the bot.
      }
    }
    return { names, stats, usageMB: estimateUsageMB(stats) };
  }

  async function pruneBatch(spec, days, dryRun) {
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(cutoffMs);
    let ids = [];
    let matchedField = null;
    for (const field of spec.dateFields) {
      const query = makeCutoffQuery(field, cutoffDate, cutoffMs, spec.filter || {});
      const docs = await db.collection(spec.name).find(query, { projection: { _id: 1 } })
        .sort({ [field]: 1 }).limit(config.batchSize).toArray();
      if (docs.length) {
        ids = docs.map(doc => doc._id);
        matchedField = field;
        break;
      }
    }
    if (!ids.length) return { deleted: 0, candidates: 0 };
    if (dryRun) return { deleted: 0, candidates: ids.length, field: matchedField };
    const result = await db.collection(spec.name).deleteMany({ _id: { $in: ids } });
    return { deleted: Number(result.deletedCount || 0), candidates: ids.length, field: matchedField };
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

      // Phase 1 uses the normal retention age. Phase 2 shortens only the
      // eligible historical window if the target still cannot be reached.
      for (const phase of ["normal", "emergency"]) {
        for (const spec of specs) {
          if (usageMB <= targetMB) break;
          const days = phase === "normal" ? spec.days : spec.emergencyDays;
          if (!Number.isFinite(days) || days <= 0) continue;
          let guard = 0;
          while (usageMB > targetMB && guard++ < 100) {
            const result = await pruneBatch(spec, days, config.dryRun);
            totalCandidates += result.candidates;
            totalDeleted += result.deleted;
            if (result.candidates) {
              perCollection[spec.name] = (perCollection[spec.name] || 0) + result.deleted;
            }
            if (!result.candidates || config.dryRun || result.deleted === 0) break;
            const current = await readUsage();
            usageMB = current.usageMB;
          }
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
  DEFAULTS, SPECS, configFromEnv, estimateUsageMB, shouldCleanup, makeCutoffQuery, getSpecs, createRetention
};
