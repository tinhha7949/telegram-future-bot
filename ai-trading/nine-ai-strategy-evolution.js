"use strict";

// Regime-aware strategy selection. Score is a diagnostic/tie-breaker, not the
// primary selector. This module never creates an executable trade or bypasses
// Nine-AI authorization, Risk Manager vetoes, exchange limits, or TPSL guards.
const MAX_OUTCOMES = 2000;
const MIN_REGIME_SAMPLES = 15;
const MIN_FAMILY_SAMPLES = 25;
const REFRESH_MS = 30 * 60 * 1000;
const FAMILIES = Object.freeze([
  "LIQUIDITY_TRAP_REVERSAL",
  "BREAKOUT_CONTINUATION",
  "TREND_CONTINUATION",
  "MEAN_REVERSION",
  "CONSENSUS_FALLBACK"
]);
let outcomesCollection = null;
let performance = new Map();
let lastRefreshAt = 0;
let refreshRunning = false;

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function getFeatures(candidate) {
  return candidate?.rankMetrics?.features || candidate?.features || {};
}
function getRegime(candidate) {
  const f = getFeatures(candidate);
  return String(f.marketRegime || candidate?.marketState || "UNKNOWN").toUpperCase();
}
function alignedBreakout(side, f) {
  const strength = num(f.breakoutStrength);
  return side === "LONG" ? strength > 0 : side === "SHORT" ? strength < 0 : false;
}
function classifyStrategy(candidate) {
  const f = getFeatures(candidate);
  const side = String(candidate?.side || "").toUpperCase();
  const regime = getRegime(candidate);
  const reason = String(f.contrarianReason || candidate?.rankMetrics?.contrarian?.reason || "").toUpperCase();
  const extension = Math.abs(num(f.extensionAtr));
  const volume = num(f.volumeRatio, 1);
  const momentum = num(f.momentum4);
  const trend = String(f.trend || "").toUpperCase();
  const falseBreakoutRisk = num(f.falseBreakoutRisk);
  const wickRejection = side === "LONG" ? num(f.lowerWickRatio) > num(f.upperWickRatio)
    : side === "SHORT" ? num(f.upperWickRatio) > num(f.lowerWickRatio) : false;

  let family = "CONSENSUS_FALLBACK";
  let fit = 0.5;
  if (/TRAP|RECLAIM|REJECTION/.test(reason) && candidate?.rankMetrics?.contrarian?.side === side) {
    family = "LIQUIDITY_TRAP_REVERSAL";
    fit = clamp(num(candidate.rankMetrics.contrarian.strength, 65) / 100, 0.55, 1);
  } else if (alignedBreakout(side, f) && Math.abs(num(f.breakoutStrength)) >= 0.2 &&
      volume >= 1.05 && falseBreakoutRisk < 0.5) {
    family = "BREAKOUT_CONTINUATION";
    fit = clamp(0.45 + Math.abs(num(f.breakoutStrength)) * 0.35 + Math.max(0, volume - 1) * 0.15, 0, 1);
  } else if ((regime === "TREND_UP" && side === "LONG" || regime === "TREND_DOWN" && side === "SHORT") &&
      (trend === "UP" && side === "LONG" || trend === "DOWN" && side === "SHORT") &&
      (side === "LONG" ? momentum > 0 : momentum < 0)) {
    family = "TREND_CONTINUATION";
    fit = clamp(0.55 + Math.abs(momentum) * 0.15 + Math.min(volume, 2) * 0.1, 0, 1);
  } else if ((regime === "SIDEWAYS" || regime === "TRANSITION") &&
      extension >= 0.75 && wickRejection && falseBreakoutRisk < 0.75) {
    family = "MEAN_REVERSION";
    fit = clamp(0.45 + Math.min(extension, 2) * 0.15 + (wickRejection ? 0.15 : 0), 0, 1);
  }
  return { family, regime, fit: Math.round(fit * 1000) / 1000, side };
}

function outcomeR(row) {
  return clamp(num(row?.realizedR), -5, 5);
}
function summarize(rows) {
  if (!rows.length) return { n: 0, meanR: 0, standardDeviation: 0, winRate: 0, totalR: 0 };
  const values = rows.map(outcomeR);
  const totalR = values.reduce((sum, value) => sum + value, 0);
  const meanR = totalR / values.length;
  const variance = values.reduce((sum, value) => sum + (value - meanR) ** 2, 0) / values.length;
  return {
    n: values.length,
    meanR,
    standardDeviation: Math.sqrt(variance),
    winRate: values.filter(value => value > 0).length / values.length,
    totalR
  };
}
function key(family, regime) {
  return `${family}|${regime}`;
}
function buildPerformance(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (row?.closed !== true || row?.applied !== true || !Number.isFinite(Number(row.realizedR))) continue;
    const family = String(row?.context?.strategyFamily || "");
    const regime = String(row?.context?.marketRegime || "UNKNOWN");
    if (!FAMILIES.includes(family)) continue;
    for (const groupKey of [key(family, regime), key(family, "*")]) {
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(row);
    }
  }
  return new Map([...grouped.entries()].map(([groupKey, groupRows]) => [groupKey, summarize(groupRows)]));
}
function estimateEdge(candidate, metrics = performance) {
  const classification = candidate?.strategyClassification || classifyStrategy(candidate);
  const regimeStats = metrics.get(key(classification.family, classification.regime));
  const familyStats = metrics.get(key(classification.family, "*"));
  let selected = { n: 0, meanR: 0, standardDeviation: 0, winRate: 0, totalR: 0 };
  let source = "COLD_START";
  if (regimeStats?.n >= MIN_REGIME_SAMPLES) {
    selected = regimeStats;
    source = "REGIME";
  } else if (familyStats?.n >= MIN_FAMILY_SAMPLES) {
    selected = familyStats;
    source = "FAMILY";
  }
  // A conservative lower-confidence estimate discourages overreacting to a
  // tiny winning streak. With no family evidence, rule-fit drives selection.
  const uncertainty = selected.n > 0 ? 1.28 * selected.standardDeviation / Math.sqrt(selected.n) : 0;
  return {
    ...classification,
    samples: selected.n,
    meanR: selected.meanR,
    winRate: selected.winRate,
    edgeLowerBoundR: selected.meanR - uncertainty,
    edgeSource: source,
    selectionValue: selected.n > 0 ? selected.meanR - uncertainty : classification.fit * 0.01
  };
}
function compareCandidates(a, b) {
  const ea = a?.strategyEdge || estimateEdge(a);
  const eb = b?.strategyEdge || estimateEdge(b);
  // Realized, regime-aware edge first. During cold start, the strategy's
  // pattern fit is used. Nine-AI score is intentionally only a late tie-break.
  return num(eb.selectionValue) - num(ea.selectionValue) ||
    num(eb.fit) - num(ea.fit) ||
    num(b?.rankMetrics?.entryQuality) - num(a?.rankMetrics?.entryQuality) ||
    num(b?.rankScore, num(b?.confidence)) - num(a?.rankScore, num(a?.confidence)) ||
    String(a?.symbol || "").localeCompare(String(b?.symbol || ""));
}
function rankCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map(candidate => {
    const strategyClassification = classifyStrategy(candidate);
    return {
      ...candidate,
      strategyClassification,
      strategyEdge: estimateEdge({ ...candidate, strategyClassification })
    };
  }).sort(compareCandidates);
}
async function refreshPerformance({ force = false, now = Date.now() } = {}) {
  if (!outcomesCollection) return { ready: false, families: performance.size };
  if (refreshRunning || (!force && now - lastRefreshAt < REFRESH_MS)) {
    return { ready: true, cached: true, families: performance.size };
  }
  refreshRunning = true;
  try {
    const rows = await outcomesCollection.find({ closed: true, applied: true })
      .sort({ closedAt: -1 }).limit(MAX_OUTCOMES).toArray();
    performance = buildPerformance(rows);
    lastRefreshAt = now;
    return { ready: true, cached: false, outcomes: rows.length, families: performance.size };
  } finally {
    refreshRunning = false;
  }
}
async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_EVOLUTION_MONGODB_REQUIRED");
  outcomesCollection = db.collection("nine_ai_learning_outcomes");
  await outcomesCollection.createIndex({ closed: 1, applied: 1, closedAt: -1 },
    { name: "nine_ai_strategy_evolution_outcomes" });
  await refreshPerformance({ force: true });
  return { ready: true, familyGroups: performance.size, families: [...FAMILIES] };
}
function getStatus() {
  return [...performance.entries()].map(([group, stats]) => ({ group, ...stats }));
}

module.exports = {
  FAMILIES, MIN_REGIME_SAMPLES, MIN_FAMILY_SAMPLES, classifyStrategy, summarize,
  buildPerformance, estimateEdge, compareCandidates, rankCandidates, initialize,
  refreshPerformance, getStatus
};
