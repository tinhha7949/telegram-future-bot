"use strict";

// Autonomous, zero-API strategy research. It mines closed-trade memory for
// candidate entry filters, validates them on a chronological holdout, and
// stores versioned candidates. Qualified rules are automatically promoted to
// live signal eligibility, attributed to trades, and rolled back on poor results.
const MAX_OUTCOMES = 2000;
const FEATURE_RULES = Object.freeze({
  "features.volume": { label: "volume ratio", direction: "gte" },
  "features.rsi": { label: "RSI", direction: "range" },
  "features.extension": { label: "EMA extension in ATR", direction: "abs_lte" },
  "features.momentum": { label: "normalized momentum", direction: "sign" },
  "features.falseBreakoutRisk": { label: "false-breakout risk", direction: "lte" },
  "features.longEntryQuality": { label: "long entry quality", direction: "gte" },
  "features.shortEntryQuality": { label: "short entry quality", direction: "gte" },
  "context.roleScore": { label: "Nine-AI role score", direction: "gte" },
  "context.entryQuality": { label: "entry quality", direction: "gte" }
});
let outcomesCollection = null;
let hypothesesCollection = null;
let versionsCollection = null;
let policyCollection = null;
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
  if (!rows.length) return { n: 0, meanR: null, standardDeviation: null, winRate: null, totalR: 0 };
  const totalR = rows.reduce((sum, row) => sum + Math.max(-5, Math.min(5, Number(row.realizedR))), 0);
  return {
    n: rows.length,
    meanR: totalR / rows.length,
    standardDeviation: Math.sqrt(rows.reduce((sum, row) => sum + (Math.max(-5, Math.min(5, Number(row.realizedR))) - totalR / rows.length) ** 2, 0) / rows.length),
    winRate: rows.filter(row => Number(row.realizedR) > 0).length / rows.length,
    totalR
  };
}
function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return [];
  return [...new Set([0.2, 0.4, 0.6, 0.8].map(q => sorted[Math.round((sorted.length - 1) * q)]))];
}
function ruleCandidates(rows = []) {
  const result = [];
  for (const [path, spec] of Object.entries(FEATURE_RULES)) {
    const values = (Array.isArray(rows) ? rows : [])
      .map(row => Number(getPath(row, path))).filter(Number.isFinite);
    const thresholds = quantiles(values);
    for (let i = 0; i < thresholds.length; i++) {
      const threshold = thresholds[i];
      if (spec.direction === "range") {
        const high = thresholds[Math.min(i + 1, thresholds.length - 1)];
        result.push({ path, operator: "rsi_band", low: Math.min(threshold, high), high: Math.max(threshold, high),
          description: `${spec.label} observed quantile band ${Math.min(threshold, high)}-${Math.max(threshold, high)}` });
      } else if (spec.direction === "abs_lte") {
        result.push({ path, operator: "abs_lte", threshold: Math.abs(threshold),
          description: `absolute ${spec.label} <= observed quantile ${Math.abs(threshold)}` });
      } else if (spec.direction === "sign") {
        result.push({ path, operator: "positive", threshold,
          description: `${spec.label} > observed quantile ${threshold}` });
        result.push({ path, operator: "negative", threshold: -Math.abs(threshold),
          description: `${spec.label} < observed quantile ${-Math.abs(threshold)}` });
      } else {
        result.push({ path, operator: spec.direction, threshold,
          ...(path === "features.longEntryQuality" ? { side: "LONG" } : {}),
          ...(path === "features.shortEntryQuality" ? { side: "SHORT" } : {}),
          description: `${spec.label} ${spec.direction === "gte" ? ">=" : "<="} observed quantile ${threshold}` });
      }
    }
  }
  return result;
}
function evaluateRule(rows, rule) {
  const matched = rows.filter(row => matchesRule(row, rule));
  return { ...stats(matched), coverage: rows.length ? matched.length / rows.length : 0 };
}
const MIN_RESEARCH_SAMPLES = 60;
const MIN_TRAIN_MATCHES = 15;
const MIN_TEST_MATCHES = 8;
const MIN_TEST_COVERAGE = 0.15;

function evaluateCandidate(train, test, rule) {
  const baselineTrain = stats(train);
  const baselineTest = stats(test);
  const trainResult = evaluateRule(train, rule);
  const testResult = evaluateRule(test, rule);
  const trainUpliftR = trainResult.meanR == null || baselineTrain.meanR == null
    ? null : trainResult.meanR - baselineTrain.meanR;
  const testUpliftR = testResult.meanR == null || baselineTest.meanR == null
    ? null : testResult.meanR - baselineTest.meanR;
  const trainUncertainty = trainResult.n ? (trainResult.standardDeviation || 0) / Math.sqrt(trainResult.n) : Infinity;
  const testUncertainty = testResult.n ? (testResult.standardDeviation || 0) / Math.sqrt(testResult.n) : Infinity;
  const baselineTestUncertainty = baselineTest.n ? (baselineTest.standardDeviation || 0) / Math.sqrt(baselineTest.n) : Infinity;
  const enoughData = trainResult.n >= MIN_TRAIN_MATCHES &&
    testResult.n >= MIN_TEST_MATCHES && testResult.coverage >= MIN_TEST_COVERAGE;
  const qualified = enoughData && trainUpliftR > trainUncertainty &&
    testUpliftR > 0 &&
    testResult.meanR - testUncertainty > baselineTest.meanR + baselineTestUncertainty;
  return {
    rule, qualified,
    train: { baseline: baselineTrain, candidate: trainResult, upliftR: trainUpliftR },
    test: { baseline: baselineTest, candidate: testResult, upliftR: testUpliftR },
    status: qualified ? "SHADOW_CANDIDATE" : "REJECTED",
    rejectionReason: qualified ? null : !enoughData
      ? "INSUFFICIENT_TRAIN_TEST_MATCHES_OR_COVERAGE"
      : "INSUFFICIENT_OUT_OF_SAMPLE_UPLIFT"
  };
}
function buildResearch(rows, now = new Date()) {
  const usable = rows.filter(row => row && row.closed === true &&
    finite(row.realizedR) && row.features && typeof row.features === "object" &&
    ["LONG", "SHORT"].includes(row.side))
    .sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));
  if (usable.length < MIN_RESEARCH_SAMPLES) {
    return { status: "COLLECTING_OUTCOMES", sampleCount: usable.length, requiredSamples: MIN_RESEARCH_SAMPLES, candidates: [] };
  }
  const splitAt = Math.floor(usable.length * 0.7);
  const train = usable.slice(0, splitAt);
  const test = usable.slice(splitAt);
  // Candidate thresholds are mined from TRAIN only. The latest 30% remains
  // untouched until final evaluation, preventing threshold-selection leakage.
  const candidates = ruleCandidates(train).map(rule => evaluateCandidate(train, test, rule))
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) ||
      Number(b.test.upliftR ?? -Infinity) - Number(a.test.upliftR ?? -Infinity));
  const accepted = candidates.filter(candidate => candidate.qualified).slice(0, 5);
  return {
    status: accepted.length ? "CANDIDATES_FOUND" : "NO_QUALIFIED_CANDIDATE",
    sampleCount: usable.length,
    baseline: { train: stats(train), test: stats(test) },
    split: "chronological_70_30_thresholds_mined_from_train_only",
    evaluatedRules: candidates.length,
    candidates: accepted.map((candidate, index) => ({
      ...candidate,
      candidateId: `nine-ai-rule-${new Date(now).getTime()}-${index + 1}`,
      createdAt: new Date(now),
      source: "AUTONOMOUS_MEMORY_MINING",
      activation: "AUTO_PROMOTE_IF_VALIDATED"
    })),
    rejectedCount: candidates.length - accepted.length
  };
}
function assessLivePolicyPerformance(rows) {
  const matchedRows = rows.filter(row => row?.researchPolicy?.matched === true);
  const unmatchedRows = rows.filter(row => row?.researchPolicy?.matched === false);
  const all = stats(rows);
  const matched = stats(matchedRows);
  const unmatched = stats(unmatchedRows);
  const matchedUncertainty = matched.n ? (matched.standardDeviation || 0) / Math.sqrt(matched.n) : Infinity;
  const unmatchedUncertainty = unmatched.n ? (unmatched.standardDeviation || 0) / Math.sqrt(unmatched.n) : Infinity;
  const upliftR = matched.meanR == null || unmatched.meanR == null ? null : matched.meanR - unmatched.meanR;
  const enoughEvidence = all.n >= 20 && matched.n >= 8 && unmatched.n >= 8;
  const underperforming = enoughEvidence && (
    matched.meanR < 0 ||
    matched.meanR + matchedUncertainty < unmatched.meanR - unmatchedUncertainty
  );
  return {
    all, matched, unmatched, matchedVsUnmatchedUpliftR: upliftR,
    enoughEvidence, underperforming
  };
}

async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_RESEARCH_MONGODB_REQUIRED");
  outcomesCollection = db.collection("nine_ai_learning_outcomes");
  hypothesesCollection = db.collection("nine_ai_strategy_hypotheses");
  versionsCollection = db.collection("nine_ai_strategy_versions");
  policyCollection = db.collection("nine_ai_strategy_policy");
  await policyCollection.createIndex({ status: 1, activatedAt: -1 }, { name: "nine_ai_active_policy_lookup" });
  await hypothesesCollection.createIndex({ candidateId: 1 }, { unique: true, name: "uniq_nine_ai_hypothesis" });
  await versionsCollection.createIndex({ version: 1 }, { unique: true, name: "uniq_nine_ai_strategy_version" });
  return { ready: true, mode: "CONTINUOUS_DATA_DERIVED_HYPOTHESES" };
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
    let rolledBackPolicy = null;
    const currentPolicy = await policyCollection.findOne({ status: "ACTIVE" });
    if (currentPolicy) {
      const policyOutcomes = await outcomesCollection.find({
        "researchPolicy.policyId": currentPolicy.policyId, closed: true, applied: true
      }).sort({ closedAt: -1 }).limit(200).toArray();
      // Compare trades where the live policy matched its learned rule against
      // trades where it did not. Overall PnL alone cannot identify whether the
      // policy's evidence helped or hurt, because the Nine-AI core still selects
      // direction and the overlay only changes candidate ranking.
      const policyPerformance = assessLivePolicyPerformance(policyOutcomes);
      if (policyPerformance.underperforming) {
        await policyCollection.updateOne({ _id: currentPolicy._id }, { $set: {
          status: "ROLLED_BACK", rolledBackAt: new Date(now),
          rollbackReason: policyPerformance.matched.meanR < 0
            ? "LIVE_MATCHED_POLICY_TRADES_NEGATIVE"
            : "LIVE_MATCHED_POLICY_TRADES_UNDERPERFORM_UNMATCHED",
          livePerformance: policyPerformance
        } });
        rolledBackPolicy = { policyId: currentPolicy.policyId, livePerformance: policyPerformance };
      }
    }
    let activatedPolicy = null;
    const best = research.candidates[0];
    if (best && best.qualified && policyCollection) {
      const current = await policyCollection.findOne({ status: "ACTIVE" });
      if (!current || Number(best.test.upliftR) > Number(current.testUpliftR ?? -Infinity)) {
        activatedPolicy = {
          policyId: best.candidateId, version: cycleId, status: "ACTIVE",
          mode: "AUTO_PROMOTED_AFTER_OUT_OF_SAMPLE_VALIDATION",
          rule: best.rule, description: best.rule.description,
          sampleCount: research.sampleCount, trainUpliftR: best.train.upliftR,
          testUpliftR: best.test.upliftR, testMeanR: best.test.candidate.meanR,
          testMatches: best.test.candidate.n, activatedAt: new Date(now)
        };
        await policyCollection.insertOne(activatedPolicy);
        await policyCollection.updateMany({ status: "ACTIVE", policyId: { $ne: activatedPolicy.policyId } }, {
          $set: { status: "SUPERSEDED", supersededAt: new Date(now) }
        });
      }
    }
    return { ...research, cycleId, storedCandidates: research.candidates.length,
      activatedPolicy: activatedPolicy ? { policyId: activatedPolicy.policyId, description: activatedPolicy.description } : null,
      rolledBackPolicy };
  } finally {
    cycleRunning = false;
  }
}
async function getActivePolicy() {
  if (!policyCollection) throw new Error("NINE_AI_RESEARCH_NOT_INITIALIZED");
  return policyCollection.findOne({ status: "ACTIVE" }, { sort: { activatedAt: -1 } });
}
function applyResearchPolicyEvidence(decision, policy) {
  if (!decision || typeof decision !== "object") {
    return { decision, policyCheck: { allowed: true, matched: null, scoreEvidence: 0, reason: "INVALID_DECISION" } };
  }
  const policyCheck = evaluateLiveDecision(decision, policy);
  if (!policy || policy.status !== "ACTIVE" || !policy.rule) {
    return { decision, policyCheck, adjustmentPoints: 0 };
  }
  // A validated research rule influences ranking, never authorization. Keep
  // the adjustment bounded so a narrow hypothesis cannot overpower the nine-role
  // consensus or bypass execution/risk/TPSL safety checks.
  const adjustmentPoints = Math.round(Math.max(-10, Math.min(10,
    Number(policyCheck.scoreEvidence || 0) * 10)) * 100) / 100;
  const baseRankScore = Number(decision.rankScore ?? decision.qualityScore ?? decision.confidence ?? 0);
  const adjustedRankScore = Math.round(Math.max(0, Math.min(100,
    (Number.isFinite(baseRankScore) ? baseRankScore : 0) + adjustmentPoints)) * 100) / 100;
  decision.rankMetrics = decision.rankMetrics || {};
  decision.rankMetrics.researchPolicyEvidence = {
    policyId: policy.policyId,
    matched: policyCheck.matched,
    scoreEvidence: policyCheck.scoreEvidence,
    testUpliftR: Number(policy.testUpliftR) || 0,
    baseRankScore,
    adjustmentPoints,
    adjustedRankScore,
    reason: policyCheck.reason
  };
  decision.rankMetrics.score = adjustedRankScore;
  decision.rankScore = adjustedRankScore;
  decision.qualityScore = adjustedRankScore;
  decision.score = adjustedRankScore;
  return { decision, policyCheck, adjustmentPoints };
}

function decisionToResearchRow(decision) {
  const f = decision?.rankMetrics?.features || {};
  return {
    side: decision?.side,
    features: {
      volume: Number(f.volumeRatio), rsi: Number(f.rsi14), extension: Number(f.extensionAtr),
      momentum: Number(f.momentum4) / Math.max(Number(f.atrPercent) || 0, 0.0001),
      falseBreakoutRisk: Number(f.falseBreakoutRisk),
      longEntryQuality: Number(f.longEntryQuality), shortEntryQuality: Number(f.shortEntryQuality)
    },
    context: {
      roleScore: Number(decision?.rankMetrics?.roleScore ?? decision?.rankScore ?? decision?.confidence),
      entryQuality: Number(decision?.rankMetrics?.entryQuality)
    }
  };
}
function evaluateLiveDecision(decision, policy) {
  if (!policy || policy.status !== "ACTIVE" || !policy.rule) {
    return { allowed: true, matched: null, scoreEvidence: 0, reason: "NO_ACTIVE_RESEARCH_POLICY" };
  }
  const matched = matchesRule(decisionToResearchRow(decision), policy.rule);
  const testUpliftR = Number(policy.testUpliftR);
  // Research findings are attribution/ranking evidence only. A mismatch must
  // never veto a valid Nine-AI direction or turn a losing strategy into WAIT.
  return {
    allowed: true,
    matched,
    scoreEvidence: Number.isFinite(testUpliftR) ? (matched ? testUpliftR : -Math.abs(testUpliftR)) : 0,
    reason: matched ? "ACTIVE_RESEARCH_RULE_MATCHED_SOFT_EVIDENCE" : "ACTIVE_RESEARCH_RULE_MISMATCH_SOFT_EVIDENCE",
    policyId: policy.policyId,
    description: policy.description || policy.rule.description
  };
}

module.exports = {
  FEATURE_RULES, MIN_RESEARCH_SAMPLES, MIN_TRAIN_MATCHES, MIN_TEST_MATCHES, MIN_TEST_COVERAGE,
  getPath, matchesRule, stats, quantiles, ruleCandidates, evaluateRule,
  evaluateCandidate, buildResearch, assessLivePolicyPerformance, initialize, runResearchCycle, getActivePolicy, decisionToResearchRow, evaluateLiveDecision, applyResearchPolicyEvidence
};
