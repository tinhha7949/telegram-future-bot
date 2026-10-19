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
const RULE_GRID = [
  ...[1.0, 1.25, 1.5, 1.75, 2.0].map(extensionThreshold => ({
    rule: "EXTENDED_MOMENTUM_ENTRY", params: { extensionThreshold, rsiThreshold: 65 }
  })),
  ...[60, 65, 68, 70, 75].map(rsiThreshold => ({ rule: "OVERBOUGHT_LONG", params: { rsiThreshold } })),
  ...[25, 30, 32, 35, 40].map(rsiThreshold => ({ rule: "OVERSOLD_SHORT", params: { rsiThreshold } })),
  ...[0.55, 0.65, 0.75, 0.85].map(volumeThreshold => ({ rule: "LOW_VOLUME", params: { volumeThreshold } })),
  ...[35, 40, 45, 50, 55].map(qualityThreshold => ({ rule: "WEAK_ENTRY_QUALITY", params: { qualityThreshold } })),
  ...[0.5, 0.75, 1.0, 1.25, 1.5].map(roomThreshold => ({ rule: "LOW_ROOM", params: { roomThreshold } })),
  ...[0.4, 0.5, 0.6, 0.7, 0.8].map(falseBreakoutThreshold => ({ rule: "FALSE_BREAKOUT_RISK", params: { falseBreakoutThreshold } }))
];
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
  if (rule === "OVERSOLD_SHORT") return f.side === "SHORT" && f.rsi !== null && f.rsi <= 100 - num(params.rsiThreshold, 70);
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
  const riskBudget = num(t.riskDetail?.riskBudget ?? t.risk);
  const pnl = num(t.pnl ?? t.realizedPnl);
  const realizedR = num(t.realizedR, riskBudget > 0 && pnl !== null ? pnl / riskBudget : null);
  if (realizedR === null) return null;
  const features = tradeFeatures(t);
  if (!features.raw || !Object.keys(features.raw).length) return null;
  return { tradeId: String(t._id || t.tradeId || t.symbol + ":" + closedAt.getTime()),
    closedAt, realizedR, features };
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
    testMeanR + 1.28 * uncertainty < 0;
  const validatedPositive = testMeanR > 0.03 && upliftR >= 0.08 &&
    testMeanR - 1.28 * uncertainty > 0;
  const hardVeto = values.length >= HARD_VETO_MIN_TEST &&
    testMeanR <= HARD_VETO_MAX_MEAN_R && upliftR <= HARD_VETO_MAX_UPLIFT_R &&
    testMeanR + 1.96 * uncertainty < 0;
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
    for (const candidate of RULE_GRID) {
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
    ruleMatches(f, p.rule) && p.validated);
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
  tradeFeatures, ruleMatches, normalizeTrade, evaluateRule, buildPolicies, assess, initialize, refresh, status };
