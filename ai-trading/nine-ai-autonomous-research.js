"use strict";

// Autonomous, zero-API strategy research. It mines closed-trade memory for
// candidate entry filters, validates them on a chronological holdout, and
// stores versioned candidates. This module never edits source code or changes
// live execution; promotion remains shadow-only until separately gated.
const MIN_SAMPLES = 40;
const MAX_OUTCOMES = 2000;
const MIN_TRAIN_MATCHES = 12;
const MIN_TEST_MATCHES = 10;
const MIN_TEST_UPLIFT_R = 0.10;
const MIN_TEST_MEAN_R = 0.05;
const FEATURE_RULES = Object.freeze({
  "features.volume": { label: "volume ratio", thresholds: [0.7, 0.85, 1, 1.1, 1.25, 1.5], direction: "gte" },
  "features.rsi": { label: "RSI", thresholds: [25, 30, 35, 45, 50, 55, 65, 70, 75], direction: "range" },
  "features.extension": { label: "EMA extension in ATR", thresholds: [-2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2], direction: "abs_lte" },
  "features.momentum": { label: "normalized momentum", thresholds: [-1.5, -1, -0.5, 0, 0.5, 1, 1.5], direction: "sign" },
  "features.falseBreakoutRisk": { label: "false-breakout risk", thresholds: [0.5], direction: "lte" },
  "features.longEntryQuality": { label: "long entry quality", thresholds: [40, 50, 60, 70, 80], direction: "gte" },
  "features.shortEntryQuality": { label: "short entry quality", thresholds: [40, 50, 60, 70, 80], direction: "gte" },
  "context.roleScore": { label: "Nine-AI role score", thresholds: [55, 60, 65, 70, 75, 80, 85], direction: "gte" },
  "context.entryQuality": { label: "entry quality", thresholds: [40, 50, 60, 70, 80], direction: "gte" }
});
let outcomesCollection = null;
let hypothesesCollection = null;
let versionsCollection = null;
let cycleRunning = false;

function finite(value) {
  return Number.isFinite(Number(value));
}
function getPath(obj, path) {
  return path.split(".").reduce((value, key) => value == null ? undefined : value[key], obj);
}
function matchesRule(row, rule) {
  if (rule.side && row.side !== rule.side) return false;
  const value = Number(getPath(row, rule.path));
  if (!Number.isFinite(value)) return false;
  if (rule.operator === "gte") return value >= rule.threshold;
  if (rule.operator === "lte") return value <= rule.threshold;
  if (rule.operator === "abs_lte") return Math.abs(value) <= rule.threshold;
  if (rule.operator === "rsi_band") return value >= rule.low && value <= rule.high;
  if (rule.operator === "positive") return value > rule.threshold;
  if (rule.operator === "negative") return value < rule.threshold;
  return false;
}
function stats(rows) {
  if (!rows.length) return { n: 0, meanR: null, winRate: null, totalR: 0 };
  const totalR = rows.reduce((sum, row) => sum + Math.max(-5, Math.min(5, Number(row.realizedR))), 0);
  return {
    n: rows.length,
    meanR: totalR / rows.length,
    winRate: rows.filter(row => Number(row.realizedR) > 0).length / rows.length,
    totalR
  };
}
function ruleCandidates() {
  const result = [];
  for (const [path, spec] of Object.entries(FEATURE_RULES)) {
    for (const threshold of spec.thresholds) {
      if (spec.direction === "range") {
        const width = threshold <= 35 || threshold >= 65 ? 15 : 10;
        result.push({ path, operator: "rsi_band", low: threshold, high: Math.min(100, threshold + width),
          description: `${spec.label} in ${threshold}-${Math.min(100, threshold + width)}` });
      } else if (spec.direction === "abs_lte") {
        result.push({ path, operator: "abs_lte", threshold,
          description: `absolute ${spec.label} <= ${threshold}` });
      } else if (spec.direction === "sign") {
        result.push({ path, operator: "positive", threshold,
          description: `${spec.label} > ${threshold}` });
        result.push({ path, operator: "negative", threshold: -Math.abs(threshold),
          description: `${spec.label} < ${-Math.abs(threshold)}` });
      } else {
        result.push({ path, operator: spec.direction, threshold,
          description: `${spec.label} ${spec.direction === "gte" ? ">=" : "<="} ${threshold}` });
      }
    }
  }
  return result;
}
function evaluateRule(rows, rule) {
  const matched = rows.filter(row => matchesRule(row, rule));
  return { ...stats(matched), coverage: rows.length ? matched.length / rows.length : 0 };
}
function evaluateCandidate(rows, rule) {
  const sorted = [...rows].sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
  const split = Math.floor(sorted.length * 0.7);
  const train = sorted.slice(0, split);
  const test = sorted.slice(split);
  const baselineTrain = stats(train);
  const baselineTest = stats(test);
  const trainResult = evaluateRule(train, rule);
  const testResult = evaluateRule(test, rule);
  const trainUpliftR = trainResult.meanR == null || baselineTrain.meanR == null
    ? null : trainResult.meanR - baselineTrain.meanR;
  const testUpliftR = testResult.meanR == null || baselineTest.meanR == null
    ? null : testResult.meanR - baselineTest.meanR;
  const qualified = trainResult.n >= MIN_TRAIN_MATCHES &&
    testResult.n >= MIN_TEST_MATCHES &&
    trainUpliftR >= 0 && testUpliftR >= MIN_TEST_UPLIFT_R &&
    testResult.meanR >= MIN_TEST_MEAN_R;
  return {
    rule, qualified,
    train: { baseline: baselineTrain, candidate: trainResult, upliftR: trainUpliftR },
    test: { baseline: baselineTest, candidate: testResult, upliftR: testUpliftR },
    status: qualified ? "SHADOW_CANDIDATE" : "REJECTED",
    rejectionReason: qualified ? null : "INSUFFICIENT_SAMPLE_OR_OUT_OF_SAMPLE_UPLIFT"
  };
}
function buildResearch(rows, now = new Date()) {
  const usable = rows.filter(row => row && row.closed === true &&
    finite(row.realizedR) && row.features && typeof row.features === "object" &&
    ["LONG", "SHORT"].includes(row.side));
  if (usable.length < MIN_SAMPLES) {
    return { status: "WARMUP", sampleCount: usable.length, requiredSamples: MIN_SAMPLES, candidates: [] };
  }
  const candidates = ruleCandidates().map(rule => evaluateCandidate(usable, rule))
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) ||
      Number(b.test.upliftR ?? -Infinity) - Number(a.test.upliftR ?? -Infinity));
  const accepted = candidates.filter(candidate => candidate.qualified).slice(0, 5);
  return {
    status: accepted.length ? "CANDIDATES_FOUND" : "NO_QUALIFIED_CANDIDATE",
    sampleCount: usable.length,
    baseline: stats(usable),
    split: "chronological_70_30",
    evaluatedRules: candidates.length,
    candidates: accepted.map((candidate, index) => ({
      ...candidate,
      candidateId: `nine-ai-rule-${new Date(now).getTime()}-${index + 1}`,
      createdAt: new Date(now),
      source: "AUTONOMOUS_MEMORY_MINING",
      activation: "SHADOW_ONLY"
    })),
    rejectedCount: candidates.length - accepted.length
  };
}
async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_RESEARCH_MONGODB_REQUIRED");
  outcomesCollection = db.collection("nine_ai_learning_outcomes");
  hypothesesCollection = db.collection("nine_ai_strategy_hypotheses");
  versionsCollection = db.collection("nine_ai_strategy_versions");
  await hypothesesCollection.createIndex({ candidateId: 1 }, { unique: true, name: "uniq_nine_ai_hypothesis" });
  await versionsCollection.createIndex({ version: 1 }, { unique: true, name: "uniq_nine_ai_strategy_version" });
  return { ready: true, mode: "SHADOW_ONLY", minSamples: MIN_SAMPLES };
}
async function runResearchCycle({ now = new Date() } = {}) {
  if (!outcomesCollection || !hypothesesCollection || !versionsCollection) {
    throw new Error("NINE_AI_RESEARCH_NOT_INITIALIZED");
  }
  if (cycleRunning) return { status: "SKIPPED", reason: "CYCLE_ALREADY_RUNNING" };
  cycleRunning = true;
  try {
    const rows = await outcomesCollection.find({ closed: true, applied: true })
      .sort({ closedAt: -1 }).limit(MAX_OUTCOMES).toArray();
    const research = buildResearch(rows, now);
    const cycleId = `research-${new Date(now).getTime()}`;
    await versionsCollection.updateOne({ version: cycleId }, { $set: {
      version: cycleId, createdAt: new Date(now), mode: "SHADOW_ONLY",
      sampleCount: research.sampleCount, status: research.status,
      baseline: research.baseline || null, evaluatedRules: research.evaluatedRules || 0
    } }, { upsert: true });
    for (const candidate of research.candidates) {
      try {
        await hypothesesCollection.insertOne({ ...candidate, cycleId });
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
    return { ...research, cycleId, storedCandidates: research.candidates.length };
  } finally {
    cycleRunning = false;
  }
}
module.exports = {
  MIN_SAMPLES, MIN_TRAIN_MATCHES, MIN_TEST_MATCHES, MIN_TEST_UPLIFT_R,
  FEATURE_RULES, getPath, matchesRule, stats, ruleCandidates, evaluateRule,
  evaluateCandidate, buildResearch, initialize, runResearchCycle
};
