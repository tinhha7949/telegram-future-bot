"use strict";

// Autonomous adaptation from confirmed exchange-closed trades.
// Research evidence can adjust ranking; a hard veto requires a large,
// chronological holdout sample and a materially negative net-R edge.
const COLLECTION = "nine_ai_autonomous_adaptation";
const HISTORY_COLLECTION = "nine_ai_autonomous_adaptation_history";
const MAX_TRADES = 3000;
const MIN_TRAIN = 30;
const MIN_TEST = 20;
const HARD_VETO_MIN_TEST = 40;
let tradesCollection = null;
let stateCollection = null;
let historyCollection = null;
let activePolicies = [];
let activeVersion = "cold-start";
let lastRefreshAt = 0;
let refreshRunning = false;
const REFRESH_MS = 15 * 60 * 1000;

const num = (v, fallback = null) => v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v);
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const se = xs => {
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length * xs.length));
};
const round = (v, p = 4) => Number(v.toFixed(p));

function tradeFeatures(trade) {
  const f = trade?.nineAiLearningFeatures || trade?.rankMetrics?.features || trade?.features || {};
  const c = trade?.nineAiLearningContext || trade?.context || {};
  return {
    raw: f, context: c,
    side: String(trade?.side || "").toUpperCase(),
    regime: String(c.marketRegime || c.regime || trade?.marketState || f.marketRegime || "UNKNOWN").toUpperCase(),
    rsi: num(f.rsi14 ?? f.rsi),
    extension: num(f.extensionAtr ?? f.extension),
    volume: num(f.volumeRatio),
    momentum: num(f.momentum4 ?? f.mom4),
    longQuality: num(f.longEntryQuality),
    shortQuality: num(f.shortEntryQuality),
    entryQuality: num(c.entryQuality ?? f.entryQuality),
    roomQuality: num(f.roomQuality ?? c.roomQuality),
    family: String(c.strategyFamily || trade?.strategyFamily || trade?.nineAiStrategyFamily || "UNKNOWN").toUpperCase()
  };
}

function readNumericFeature(features, name) {
  const value = features?.raw?.[name] ?? features?.[name];
  return num(value);
}

// A strategy is a data-only genome: one or more observed numeric feature
// predicates. It cannot execute JavaScript or alter the order/risk pipeline.
function ruleMatches(features, rule, params = {}) {
  if (rule !== "LEARNED_CONJUNCTION") return false;
  const conditions = Array.isArray(params.conditions) ? params.conditions : [];
  return conditions.length > 0 && conditions.every(condition => {
    const value = readNumericFeature(features, condition.feature);
    if (value === null || !Number.isFinite(Number(condition.threshold))) return false;
    return condition.operator === "gte" ? value >= condition.threshold
      : condition.operator === "lte" ? value <= condition.threshold : false;
  });
}

function normalizeTrade(t) {
  if (!t || !["LONG", "SHORT"].includes(String(t.side || "").toUpperCase())) return null;
  const result = String(t.result || t.outcome || "").toUpperCase();
  if (!["WIN", "LOSS", "BREAKEVEN", "BE"].includes(result)) return null;
  const closedAt = new Date(t.closedAt || t.updatedAt || t.exitTime || 0);
  if (!Number.isFinite(closedAt.getTime()) || closedAt.getTime() <= 0) return null;
  const quantity = num(t.quantity);
  const initialRisk = num(t.initialRisk ?? t.riskDetail?.initialRisk);
  const stopDefinedRisk = quantity !== null && initialRisk !== null ? quantity * initialRisk : null;
  const storedActualRisk = num(t.finalRisk);
  const riskBudget = stopDefinedRisk > 0 ? stopDefinedRisk
    : storedActualRisk > 0 ? storedActualRisk
      : num(t.riskDetail?.riskBudget ?? t.risk);
  const pnl = num(t.pnl ?? t.realizedPnl);
  const realizedR = num(t.realizedR, riskBudget > 0 && pnl !== null ? pnl / riskBudget : null);
  if (realizedR === null) return null;
  const features = tradeFeatures(t);
  if (!features.raw || !Object.keys(features.raw).length) return null;
  return { tradeId: String(t._id || t.tradeId || t.symbol + ":" + closedAt.getTime()),
    closedAt, realizedR, features };
}

// Candidate parameter values come from the observed training distribution,
// rather than a hand-authored list of RSI/volume/extension cutoffs. The number
// of cut points grows with the amount of distinct data (approximately sqrt(n))
// to explore more finely as the ledger grows without evaluating every row
// against every possible floating-point threshold.
function observedThresholds(values) {
  const sorted = [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
  if (sorted.length <= 8) return sorted;
  const count = Math.ceil(Math.sqrt(sorted.length));
  const result = new Set();
  for (let i = 1; i <= count; i++) {
    result.add(sorted[Math.floor(i * (sorted.length - 1) / (count + 1))]);
  }
  return [...result].sort((a, b) => a - b);
}

function candidatePredicates(trainingRows = []) {
  const names = new Set();
  for (const row of trainingRows) {
    for (const [name, value] of Object.entries(row.features?.raw || {})) {
      if (value != null && value !== "" && Number.isFinite(Number(value))) names.add(name);
    }
  }
  const result = [];
  for (const feature of names) {
    const values = trainingRows.map(row => readNumericFeature(row.features, feature))
      .filter(value => value !== null);
    for (const threshold of observedThresholds(values)) {
      for (const operator of ["gte", "lte"]) {
        result.push({ feature, operator, threshold });
      }
    }
  }
  return result;
}

function predicateFitness(rows, condition) {
  const matches = rows.filter(row => ruleMatches(row.features, "LEARNED_CONJUNCTION", { conditions: [condition] }));
  const controls = rows.filter(row => !ruleMatches(row.features, "LEARNED_CONJUNCTION", { conditions: [condition] }));
  const minCoverage = Math.max(8, Math.floor(rows.length * 0.08));
  if (matches.length < minCoverage || controls.length < minCoverage) return null;
  const edge = mean(matches.map(row => row.realizedR)) - mean(controls.map(row => row.realizedR));
  const uncertainty = se(matches.map(row => row.realizedR)) + se(controls.map(row => row.realizedR));
  return { condition, edge, fitness: Math.abs(edge) - uncertainty, matches: matches.length };
}

// Search conditions over every numeric feature present in the training ledger.
// The next generation combines the strongest independent predicates, allowing
// the bot to discover new conjunction strategies without a hand-written rule list.
function buildRuleGrid(trainingRows = []) {
  if (trainingRows.length < MIN_TRAIN) return [];
  const ranked = candidatePredicates(trainingRows)
    .map(condition => predicateFitness(trainingRows, condition))
    .filter(Boolean)
    .sort((a, b) => b.fitness - a.fitness || Math.abs(b.edge) - Math.abs(a.edge));
  const parents = ranked.slice(0, Math.min(32, ranked.length));
  const result = ranked.slice(0, 64).map(item => ({
    rule: "LEARNED_CONJUNCTION", params: { conditions: [item.condition] }
  }));
  for (let i = 0; i < parents.length; i++) {
    for (let j = i + 1; j < parents.length; j++) {
      if (parents[i].condition.feature === parents[j].condition.feature) continue;
      const conditions = [parents[i].condition, parents[j].condition];
      result.push({ rule: "LEARNED_CONJUNCTION", params: { conditions } });
    }
  }
  const unique = new Map(result.map(candidate => [
    JSON.stringify(candidate.params.conditions), candidate
  ]));
  return [...unique.values()];
}

function searchConfidenceZ(comparisonCount = 1, familywiseError = 0.01) {
  const tests = Math.max(1, Number(comparisonCount) || 1);
  const alpha = Math.max(Number.EPSILON, Math.min(0.5, Number(familywiseError) || 0.01));
  // Gaussian tail bound with a Bonferroni family-wise correction. Searching
  // more genomes therefore requires stronger held-out evidence for promotion.
  return Math.sqrt(2 * Math.log(2 * tests / alpha));
}

function evaluateRule(rows, rule, params, side, regime, { comparisonCount = 1 } = {}) {
  const matching = rows.filter(r => r.features.side === side && r.features.regime === regime &&
    ruleMatches(r.features, rule, params)).sort((a, b) => a.closedAt - b.closedAt);
  if (matching.length < MIN_TRAIN + MIN_TEST) return null;
  const split = Math.floor(matching.length * 0.7);
  const train = matching.slice(0, split);
  const test = matching.slice(split);
  if (train.length < MIN_TRAIN || test.length < MIN_TEST) return null;
  const allSameContext = rows.filter(r => r.features.side === side && r.features.regime === regime);
  const testIds = new Set(test.map(r => r.tradeId));
  const chronologicalTest = allSameContext.filter(r => r.closedAt >= test[0].closedAt);
  const matchedTest = chronologicalTest.filter(r => testIds.has(r.tradeId));
  const controlTest = chronologicalTest.filter(r => !testIds.has(r.tradeId));
  const values = matchedTest.map(r => r.realizedR);
  const controls = controlTest.map(r => r.realizedR);
  if (values.length < MIN_TEST || controls.length < 10) return null;
  const testMeanR = mean(values);
  const controlMeanR = mean(controls);
  const upliftR = testMeanR - controlMeanR;
  const uncertainty = se(values);
  const upliftUncertainty = Math.sqrt(uncertainty ** 2 + se(controls) ** 2);
  const confidenceMultiplier = searchConfidenceZ(comparisonCount);
  const validatedNegative = testMeanR + confidenceMultiplier * uncertainty < 0 &&
    upliftR + confidenceMultiplier * upliftUncertainty < 0;
  const validatedPositive = testMeanR - confidenceMultiplier * uncertainty > 0 &&
    upliftR - confidenceMultiplier * upliftUncertainty > 0;
  const hardVeto = values.length >= HARD_VETO_MIN_TEST &&
    validatedNegative;
  // Scale the live score effect by the out-of-sample edge after its uncertainty
  // penalty. This is learned from the measured effect, not a fixed strategy bonus.
  const significantEdge = Math.max(0, Math.abs(upliftR) - confidenceMultiplier * upliftUncertainty);
  const adjustment = validatedNegative ? -significantEdge * 100
    : validatedPositive ? significantEdge * 100 : 0;
  return {
    policyId: [rule, JSON.stringify(params), side, regime].join(":"),
    rule, params, side, regime, status: hardVeto ? "ACTIVE_VETO" :
      validatedNegative ? "ACTIVE_PENALTY" : validatedPositive ? "ACTIVE_BONUS" : "OBSERVE",
    samples: matching.length, trainSamples: train.length, testSamples: values.length,
    testMeanR: round(testMeanR), controlMeanR: round(controlMeanR), upliftR: round(upliftR),
    standardError: round(uncertainty), upliftStandardError: round(upliftUncertainty),
    confidenceMultiplier: round(confidenceMultiplier, 4), comparisonCount,
    adjustment: round(adjustment, 2),
    veto: hardVeto, validated: validatedNegative || validatedPositive || hardVeto
  };
}

function buildPolicies(rawTrades) {
  const dedup = new Map();
  for (const t of rawTrades || []) {
    const row = normalizeTrade(t);
    if (!row) continue;
    const old = dedup.get(row.tradeId);
    if (!old || row.closedAt > old.closedAt) dedup.set(row.tradeId, row);
  }
  const rows = [...dedup.values()].sort((a, b) => a.closedAt - b.closedAt);
  const policies = [];
  const contexts = new Set(rows.map(r => r.features.side + "|" + r.features.regime));
  const searches = [];
  for (const key of contexts) {
    const [side, regime] = key.split("|");
    const contextRows = rows.filter(row => row.features.side === side && row.features.regime === regime);
    const trainingRows = contextRows.slice(0, Math.floor(contextRows.length * 0.7));
    const candidates = buildRuleGrid(trainingRows);
    searches.push({ side, regime, candidates });
  }
  const comparisonCount = searches.reduce((sum, search) => sum + search.candidates.length, 0);
  for (const { side, regime, candidates } of searches) {
    for (const candidate of candidates) {
      const policy = evaluateRule(rows, candidate.rule, candidate.params, side, regime,
        { comparisonCount });
      if (policy) policies.push(policy);
    }
  }
  return { rows: rows.length, policies };
}

function assess(features = {}, side, context = {}) {
  const f = {
    ...tradeFeatures({ side, nineAiLearningFeatures: features, nineAiLearningContext: context,
      marketState: context.marketRegime })
  };
  const matched = activePolicies.filter(p => p.side === f.side && p.regime === f.regime &&
    ruleMatches(f, p.rule, p.params || {}) && p.validated);
  const veto = matched.find(p => p.veto);
  const adjustment = matched.length
    ? round(matched.reduce((sum, p) => sum + Number(p.adjustment || 0), 0) / matched.length, 2)
    : 0;
  return {
    ready: activeVersion !== "cold-start", version: activeVersion,
    allowed: !veto, vetoReason: veto ? "VALIDATED_NEGATIVE_EDGE:" + veto.policyId : null,
    adjustment: round(adjustment, 2),
    matched: matched.map(p => ({ policyId: p.policyId, rule: p.rule, params: p.params,
      status: p.status, testMeanR: p.testMeanR, upliftR: p.upliftR,
      testSamples: p.testSamples, adjustment: p.adjustment })),
    reason: veto ? "ROBUST_OUT_OF_SAMPLE_NEGATIVE_EDGE" :
      matched.length ? "VALIDATED_POLICY_APPLIED" : "NO_VALIDATED_CONTEXT_POLICY"
  };
}

async function initialize(db, existingTradesCollection = null) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_ADAPTATION_MONGODB_REQUIRED");
  tradesCollection = existingTradesCollection || db.collection("trades");
  stateCollection = db.collection(COLLECTION);
  historyCollection = db.collection(HISTORY_COLLECTION);
  await stateCollection.createIndex({ updatedAt: -1 }, { name: "nine_ai_adaptation_state_updated" });
  await historyCollection.createIndex({ version: 1 }, { unique: true, name: "uniq_nine_ai_adaptation_version" });
  const stored = await stateCollection.findOne({ _id: "active" });
  if (stored && Array.isArray(stored.policies)) {
    activePolicies = stored.policies;
    activeVersion = String(stored.version || "loaded");
  }
  const result = await refresh({ force: true });
  return { ready: true, version: activeVersion, trades: result.trades, policies: activePolicies.length };
}

async function refresh({ force = false, now = Date.now() } = {}) {
  if (!tradesCollection || !stateCollection || !historyCollection) throw new Error("NINE_AI_ADAPTATION_NOT_INITIALIZED");
  if (refreshRunning || (!force && now - lastRefreshAt < REFRESH_MS)) {
    return { ready: true, cached: true, trades: 0, policies: activePolicies.length, version: activeVersion };
  }
  refreshRunning = true;
  try {
    const docs = await tradesCollection.find({ setup: "NINE_AI_15M" })
      .sort({ closedAt: -1 }).limit(MAX_TRADES).toArray();
    const built = buildPolicies(docs);
    const fingerprint = JSON.stringify(built.policies);
    const currentFingerprint = JSON.stringify(activePolicies);
    lastRefreshAt = now;
    if (fingerprint !== currentFingerprint) {
      const version = "adapt-" + new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      const snapshot = { _id: "active", version, updatedAt: new Date(now),
        tradesAnalyzed: built.rows, policies: built.policies,
        mode: "CHRONOLOGICAL_HOLDOUT_BOUNDED_ADAPTATION" };
      await historyCollection.updateOne({ version }, { $setOnInsert: snapshot }, { upsert: true });
      await stateCollection.updateOne({ _id: "active" }, { $set: snapshot }, { upsert: true });
      activePolicies = built.policies;
      activeVersion = version;
    }
    return { ready: true, cached: false, trades: built.rows, policies: activePolicies.length, version: activeVersion };
  } finally {
    refreshRunning = false;
  }
}

function status() {
  return { version: activeVersion, policies: activePolicies.length,
    active: activePolicies.filter(p => p.validated).length,
    vetoes: activePolicies.filter(p => p.veto).length,
    policiesSummary: activePolicies.map(p => ({ policyId: p.policyId, status: p.status,
      testSamples: p.testSamples, testMeanR: p.testMeanR, upliftR: p.upliftR, adjustment: p.adjustment })) };
}

module.exports = { COLLECTION, HISTORY_COLLECTION, MIN_TRAIN, MIN_TEST,
  tradeFeatures, readNumericFeature, ruleMatches, normalizeTrade, observedThresholds,
  candidatePredicates, predicateFitness, buildRuleGrid, searchConfidenceZ,
  evaluateRule, buildPolicies, assess, initialize, refresh, status };

