"use strict";

// Autonomous adaptation from confirmed exchange-closed trades.
// Research evidence can adjust ranking; a hard veto requires a large,
// chronological holdout sample and a materially negative net-R edge.
const COLLECTION = "nine_ai_autonomous_adaptation";
const HISTORY_COLLECTION = "nine_ai_autonomous_adaptation_history";
const MAX_TRADES = 3000;
const MIN_TRAIN = 30;
const MIN_TEST = 20;
const MAX_ADJUSTMENT = 8;
const HARD_VETO_MIN_TEST = 40;
const HARD_VETO_MAX_MEAN_R = -0.15;
const HARD_VETO_MAX_UPLIFT_R = -0.12;
let tradesCollection = null;
let stateCollection = null;
let historyCollection = null;
let activePolicies = [];
let activeVersion = "cold-start";
let lastRefreshAt = 0;
let refreshRunning = false;
const REFRESH_MS = 15 * 60 * 1000;

const num = (v, fallback = null) => v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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

function ruleMatches(features, rule, params = {}) {
  const f = features;
  if (rule === "EXTENDED_MOMENTUM_ENTRY") {
    const extensionThreshold = num(params.extensionThreshold, 1.5);
    const rsiThreshold = num(params.rsiThreshold, 65);
    return f.extension !== null && f.rsi !== null && Math.abs(f.extension) >= extensionThreshold &&
      ((f.side === "LONG" && f.extension > 0 && f.rsi >= rsiThreshold) ||
       (f.side === "SHORT" && f.extension < 0 && f.rsi <= 100 - rsiThreshold));
  }
  if (rule === "OVERBOUGHT_LONG") return f.side === "LONG" && f.rsi !== null && f.rsi >= num(params.rsiThreshold, 70);
  if (rule === "OVERSOLD_SHORT") return f.side === "SHORT" && f.rsi !== null && f.rsi <= num(params.rsiThreshold, 30);
  if (rule === "WEAK_ENTRY_QUALITY") {
    const q = f.side === "LONG" ? f.longQuality : f.side === "SHORT" ? f.shortQuality : f.entryQuality;
    return q !== null && q < num(params.qualityThreshold, 50);
  }
  if (rule === "LOW_VOLUME") return f.volume !== null && f.volume < num(params.volumeThreshold, 0.75);
  if (rule === "LOW_ROOM") return f.roomQuality !== null && f.roomQuality <= num(params.roomThreshold, 25);
  if (rule === "FALSE_BREAKOUT_RISK") {
    const risk = num(f.raw?.falseBreakoutRisk);
    return risk !== null && risk >= num(params.falseBreakoutThreshold, 0.6);
  }
  return false;
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

function buildRuleGrid(trainingRows = []) {
  const result = [];
  const add = (rule, params) => {
    if (Object.values(params).some(value => !Number.isFinite(value))) return;
    result.push({ rule, params });
  };
  const features = trainingRows.map(row => row.features || {});
  const extension = observedThresholds(features.map(f =>
    f.extension === null ? NaN : Math.abs(f.extension)));
  const longRsi = observedThresholds(features.filter(f => f.side === "LONG")
    .map(f => f.rsi).filter(v => v !== null && v >= 50));
  const shortRsi = observedThresholds(features.filter(f => f.side === "SHORT")
    .map(f => f.rsi).filter(v => v !== null && v <= 50));
  const rsi = observedThresholds(features.map(f => f.rsi).filter(v => v !== null));
  const volume = observedThresholds(features.map(f => f.volume).filter(v => v !== null));
  const quality = observedThresholds(features.map(f =>
    f.side === "LONG" ? f.longQuality : f.side === "SHORT" ? f.shortQuality : f.entryQuality
  ).filter(v => v !== null));
  const room = observedThresholds(features.map(f => f.roomQuality).filter(v => v !== null));
  const breakout = observedThresholds(features.map(f =>
    num(f.raw?.falseBreakoutRisk)).filter(v => v !== null));

  for (const extensionThreshold of extension) {
    for (const rsiThreshold of longRsi) {
      add("EXTENDED_MOMENTUM_ENTRY", { extensionThreshold, rsiThreshold });
    }
    for (const rsiThreshold of shortRsi) {
      add("EXTENDED_MOMENTUM_ENTRY", { extensionThreshold, rsiThreshold });
    }
  }
  for (const rsiThreshold of rsi) {
    if (rsiThreshold >= 50) add("OVERBOUGHT_LONG", { rsiThreshold });
    if (rsiThreshold <= 50) add("OVERSOLD_SHORT", { rsiThreshold });
  }
  for (const volumeThreshold of volume) add("LOW_VOLUME", { volumeThreshold });
  for (const qualityThreshold of quality) add("WEAK_ENTRY_QUALITY", { qualityThreshold });
  for (const roomThreshold of room) add("LOW_ROOM", { roomThreshold });
  for (const falseBreakoutThreshold of breakout) add("FALSE_BREAKOUT_RISK", { falseBreakoutThreshold });

  const unique = new Map(result.map(candidate =>
    [candidate.rule + ":" + Object.values(candidate.params).join(","), candidate]));
  return [...unique.values()];
}

function evaluateRule(rows, rule, params, side, regime) {
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
  const validatedNegative = testMeanR < -0.03 && upliftR <= -0.08 &&
    testMeanR + 2.58 * uncertainty < 0;
  const validatedPositive = testMeanR > 0.03 && upliftR >= 0.08 &&
    testMeanR - 2.58 * uncertainty > 0;
  const hardVeto = values.length >= HARD_VETO_MIN_TEST &&
    testMeanR <= HARD_VETO_MAX_MEAN_R && upliftR <= HARD_VETO_MAX_UPLIFT_R &&
    testMeanR + 2.58 * uncertainty < 0;
  const adjustment = validatedNegative
    ? -clamp(3 + Math.abs(upliftR) * 15, 3, MAX_ADJUSTMENT)
    : validatedPositive
      ? clamp(2 + upliftR * 10, 2, MAX_ADJUSTMENT)
      : 0;
  return {
    policyId: [rule, Object.values(params).join(","), side, regime].join(":"),
    rule, params, side, regime, status: hardVeto ? "ACTIVE_VETO" :
      validatedNegative ? "ACTIVE_PENALTY" : validatedPositive ? "ACTIVE_BONUS" : "OBSERVE",
    samples: matching.length, trainSamples: train.length, testSamples: values.length,
    testMeanR: round(testMeanR), controlMeanR: round(controlMeanR), upliftR: round(upliftR),
    standardError: round(uncertainty), adjustment: round(adjustment, 2),
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
  for (const key of contexts) {
    const [side, regime] = key.split("|");
    const contextRows = rows.filter(row => row.features.side === side && row.features.regime === regime);
    const trainingRows = contextRows.slice(0, Math.floor(contextRows.length * 0.7));
    const candidates = buildRuleGrid(trainingRows);
    for (const candidate of candidates) {
      const policy = evaluateRule(rows, candidate.rule, candidate.params, side, regime);
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
  const adjustment = clamp(matched.reduce((sum, p) => sum + p.adjustment, 0), -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
  return {
    ready: activeVersion !== "cold-start", version: activeVersion,
    allowed: !veto, vetoReason: veto ? "VALIDATED_NEGATIVE_EDGE:" + veto.policyId : null,
    adjustment: round(adjustment, 2),
    matched: matched.map(p => ({ policyId: p.policyId, status: p.status,
      testMeanR: p.testMeanR, upliftR: p.upliftR, testSamples: p.testSamples })),
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

module.exports = { COLLECTION, HISTORY_COLLECTION, MIN_TRAIN, MIN_TEST, MAX_ADJUSTMENT,
  tradeFeatures, ruleMatches, normalizeTrade, observedThresholds, buildRuleGrid,
  evaluateRule, buildPolicies, assess, initialize, refresh, status };
