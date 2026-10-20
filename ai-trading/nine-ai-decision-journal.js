"use strict";
const crypto = require("crypto");

// Durable journal for every Nine-AI scan decision, including WAIT/abstentions.
// Hypothetical forward outcomes are explicitly separate from actual trade PnL.
// The pre-decision candle window is summarized and compared with matured past
// windows. Its evidence adjusts candidate ranking only; it never bypasses the
// existing execution and capital-protection checks.
const COLLECTION = "nine_ai_decision_journal";
const MAX_RECORDS = 5000;
const MARKET_WINDOW_BARS = 48;
const HORIZONS = [4, 16, 24];
const MIN_SAMPLES = 20;
const MAX_LIVE_BONUS = 3;
const DEFAULT_ROUND_TRIP_COST_RATE = 0.0008;
let collection = null;
let records = [];
const seen = new Set();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = NaN) => v == null || v === "" ? d : Number.isFinite(Number(v)) ? Number(v) : d;
const regimeOf = features => String(features?.marketRegime || features?.regime || "UNKNOWN").toUpperCase();
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const standardDeviation = values => {
  if (!values.length) return null;
  const center = mean(values);
  return Math.sqrt(mean(values.map(value => (value - center) ** 2)));
};

function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => Array.isArray(c) ? ({
    time: num(c[0]), open: num(c[1]), high: num(c[2]), low: num(c[3]),
    close: num(c[4]), closeTime: num(c[6], num(c[0]) + 15 * 60 * 1000 - 1)
  }) : ({
    time: num(c.time ?? c.openTime), open: num(c.open ?? c.o), high: num(c.high ?? c.h),
    low: num(c.low ?? c.l), close: num(c.close ?? c.c),
    closeTime: num(c.closeTime, num(c.time ?? c.openTime) + 15 * 60 * 1000 - 1)
  })).filter(c => [c.time,c.open,c.high,c.low,c.close,c.closeTime].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.high >= c.low && c.close > 0 && c.closeTime >= c.time)
    .sort((a,b) => a.time-b.time)
    .filter((c,i,a) => i === 0 || c.time !== a[i-1].time);
}

function snapshotMarketWindow(raw, limit = MARKET_WINDOW_BARS, availableAt = Infinity) {
  const candles = normalizeCandles(raw);
  const byTime = new Map((Array.isArray(raw) ? raw : []).map(c => Array.isArray(c)
    ? [num(c[0]), c]
    : [num(c?.time ?? c?.openTime), c]));
  const cutoff = num(availableAt, Infinity);
  return candles.filter(c => c.closeTime <= cutoff)
    .slice(-Math.max(1, Number(limit) || MARKET_WINDOW_BARS)).map(c => {
    const source = byTime.get(c.time);
    return { time: c.time, closeTime: c.closeTime, open: c.open, high: c.high,
      low: c.low, close: c.close,
      volume: source ? num(Array.isArray(source) ? source[5] : source.volume, null) : null,
      quoteVolume: source ? num(Array.isArray(source) ? source[7] : source.quoteVolume, null) : null,
      tradeCount: source ? num(Array.isArray(source) ? source[8] : source.tradeCount, null) : null,
      takerBuyBaseVolume: source ? num(Array.isArray(source) ? source[9] : source.takerBuyBaseVolume, null) : null,
      takerBuyQuoteVolume: source ? num(Array.isArray(source) ? source[10] : source.takerBuyQuoteVolume, null) : null };
  });
}

function extractWindowFeatures(raw) {
  const candles = snapshotMarketWindow(raw, MARKET_WINDOW_BARS, Infinity);
  if (candles.length < MARKET_WINDOW_BARS) return null;
  const closes = candles.map(c => c.close);
  const logReturns = closes.slice(1).map((close, i) => Math.log(close / closes[i]));
  const lastClose = closes[closes.length - 1];
  const returnOver = bars => Math.log(lastClose / closes[closes.length - 1 - bars]);
  const volatilityOver = bars => standardDeviation(logReturns.slice(-bars));
  const efficiencyOver = bars => {
    const window = logReturns.slice(-bars);
    const pathLength = window.reduce((sum, value) => sum + Math.abs(value), 0);
    return pathLength > 0 ? window.reduce((sum, value) => sum + value, 0) / pathLength : 0;
  };
  const ranges = candles.map((c, i) => {
    const previousClose = i ? candles[i - 1].close : c.close;
    return Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose));
  });
  const avgRange = values => mean(values);
  const totalRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  const recentVolume = mean(candles.slice(-8).map(c => num(c.volume)).filter(Number.isFinite));
  const priorVolume = mean(candles.slice(0, -8).map(c => num(c.volume)).filter(Number.isFinite));
  const takerRows = candles.filter(c => Number.isFinite(num(c.takerBuyBaseVolume)) && Number.isFinite(num(c.volume)));
  const totalVolume = takerRows.reduce((sum, c) => sum + Number(c.volume), 0);
  const takerBuyRatio = totalVolume > 0
    ? takerRows.reduce((sum, c) => sum + Number(c.takerBuyBaseVolume), 0) / totalVolume : null;
  const bodyRatios = candles.filter(c => c.high > c.low)
    .map(c => Math.abs(c.close - c.open) / (c.high - c.low));
  const wickBias = mean(candles.filter(c => c.high > c.low).map(c => {
    const upper = c.high - Math.max(c.open, c.close);
    const lower = Math.min(c.open, c.close) - c.low;
    return (upper - lower) / (c.high - c.low);
  }));
  const rangePosition = totalRange > 0
    ? (lastClose - Math.min(...candles.map(c => c.low))) / totalRange : 0.5;
  const recentRangeRatio = avgRange(ranges.slice(-16)) / Math.max(avgRange(ranges), 1e-12);
  return {
    return4: returnOver(4), return16: returnOver(16), return32: returnOver(32), return48: returnOver(47),
    volatility16: volatilityOver(16), volatility32: volatilityOver(32), volatility48: volatilityOver(47),
    efficiency16: efficiencyOver(16), efficiency32: efficiencyOver(32), efficiency48: efficiencyOver(47),
    rangePosition, recentRangeRatio,
    volumeRatio: recentVolume != null && priorVolume > 0 ? recentVolume / priorVolume : null,
    takerBuyRatio,
    meanBodyRatio: mean(bodyRatios),
    wickBias,
    greenRate: candles.filter(c => c.close > c.open).length / candles.length
  };
}

function assessWindowEvidence(rawWindow, side, sourceRecords = records) {
  const current = extractWindowFeatures(rawWindow);
  if (!current || !["LONG", "SHORT"].includes(String(side).toUpperCase())) {
    return { ready: false, adjustment: 0, samples: 0, reason: "NO_COMPLETE_48_BAR_WINDOW" };
  }
  const outcomeKey = String(side).toLowerCase() + "NetR";
  const candidates = sourceRecords.map(record => {
    const features = record.windowFeatureSchemaVersion === 2
      ? record.windowFeatures || null
      : Array.isArray(record.marketWindow) && record.marketWindow.length >= MARKET_WINDOW_BARS
        ? (record.windowFeatures = extractWindowFeatures(record.marketWindow)) : record.windowFeatures || null;
    const outcomes = [record.evaluations?.["4"]?.[outcomeKey], record.evaluations?.["16"]?.[outcomeKey]].map(value => num(value));
    const targetR = outcomes.every(Number.isFinite) ? mean(outcomes) : null;
    return { record, features, targetR };
  }).filter(row => row.features && Number.isFinite(row.targetR) && row.record.outcomeStatus === "EVALUATED");
  const latestByCandle = new Map();
  for (const row of candidates) {
    latestByCandle.set(String(row.record.symbol) + ":" + String(row.record.signalTime), row);
  }
  const uniqueCandidates = [...latestByCandle.values()];
  if (uniqueCandidates.length < MIN_SAMPLES) {
    return { ready: false, adjustment: 0, samples: uniqueCandidates.length, reason: "INSUFFICIENT_MATURED_WINDOWS" };
  }
  const keys = Object.keys(current).filter(key => Number.isFinite(current[key]) &&
    uniqueCandidates.some(row => Number.isFinite(row.features[key])));
  if (keys.length < 8) return { ready: false, adjustment: 0, samples: 0, reason: "INSUFFICIENT_WINDOW_FEATURES" };
  const scales = Object.fromEntries(keys.map(key => {
    const values = uniqueCandidates.map(row => Number(row.features[key])).filter(Number.isFinite);
    return [key, Math.max(standardDeviation(values) || 0, Math.abs(mean(values) || 0) * 0.05, 1e-6)];
  }));
  const neighbors = uniqueCandidates.map(row => {
    const dimensions = keys.filter(key => Number.isFinite(row.features[key]));
    const distance = dimensions.reduce((sum, key) => sum + ((current[key] - row.features[key]) / scales[key]) ** 2, 0) / dimensions.length;
    return { ...row, distance, weight: 1 / (1 + distance) };
  }).filter(row => Number.isFinite(row.distance));
  const weightSum = neighbors.reduce((sum, row) => sum + row.weight, 0);
  const squaredWeightSum = neighbors.reduce((sum, row) => sum + row.weight ** 2, 0);
  const effectiveSamples = squaredWeightSum > 0 ? weightSum ** 2 / squaredWeightSum : 0;
  if (effectiveSamples < MIN_SAMPLES) {
    return { ready: false, adjustment: 0, samples: neighbors.length,
      effectiveSamples: Number(effectiveSamples.toFixed(2)), reason: "SIMILAR_WINDOW_EVIDENCE_TOO_THIN" };
  }
  const meanR = neighbors.reduce((sum, row) => sum + row.weight * row.targetR, 0) / weightSum;
  const variance = neighbors.reduce((sum, row) => sum + row.weight * (row.targetR - meanR) ** 2, 0) / weightSum;
  const standardError = Math.sqrt(variance / effectiveSamples);
  const reliability = Math.sqrt(effectiveSamples / (effectiveSamples + MIN_SAMPLES));
  const similarWinRate = neighbors.reduce((sum, row) => sum + row.weight * Number(row.targetR > 0), 0) / weightSum;
  const baselineWinRate = uniqueCandidates.filter(row => row.targetR > 0).length / uniqueCandidates.length;
  // Express the learned win-rate edge in the existing 0-100 ranking scale.
  // The adjustment has no extra fixed ceiling; its magnitude comes from the
  // observed edge and shrinks toward neutral when effective evidence is thin.
  const adjustment = (similarWinRate - baselineWinRate) * 100 * reliability;
  let nearestDistance = Infinity;
  for (const row of neighbors) nearestDistance = Math.min(nearestDistance, row.distance);
  return { ready: true, adjustment: Number(adjustment.toFixed(3)), samples: neighbors.length,
    effectiveSamples: Number(effectiveSamples.toFixed(2)), meanR: Number(meanR.toFixed(5)),
    standardError: Number(standardError.toFixed(5)),
    similarWinRate: Number(similarWinRate.toFixed(5)), baselineWinRate: Number(baselineWinRate.toFixed(5)),
    nearestDistance: Number(nearestDistance.toFixed(5)),
    horizonBars: [4, 16], source: "SIMILAR_48_BAR_WINDOWS_WITH_MATURED_FORWARD_OUTCOMES" };
}

function signalCandleIndex(candles, signalTime) {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].closeTime <= signalTime) idx = i;
    else break;
  }
  return idx;
}

function atrAt(candles, idx) {
  const start = Math.max(1, idx - 13);
  const ranges = [];
  for (let i = start; i <= idx; i++) {
    const c = candles[i], prev = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return ranges.length ? ranges.reduce((s,v) => s + v, 0) / ranges.length : NaN;
}

function snapshotDecision({ symbol, decision, signalTime, scannedAt, learningEvidence = null, marketWindow = null }) {
  const d = decision || {};
  const metrics = d.rankMetrics || {};
  const features = metrics.features || d.features || null;
  const side = ["LONG", "SHORT"].includes(String(d.side || "").toUpperCase())
    && d.authorizedForExecution === true ? String(d.side).toUpperCase() : "WAIT";
  const roles = Array.isArray(d.roles) ? d.roles.map(role => ({
    name: String(role?.name || "UNKNOWN"),
    side: String(role?.side || "NEUTRAL"),
    confidence: num(role?.confidence, 0),
    weight: num(role?.weight, 0),
    score: num(role?.score, null),
    weightedContribution: num(role?.weightedContribution, null),
    reason: String(role?.reason || "")
  })) : [];
  const window = snapshotMarketWindow(marketWindow, MARKET_WINDOW_BARS, num(signalTime, Infinity));
  const snapshot = {
    decisionSnapshot: d && typeof d === "object" ? {
      setup: d.setup || null,
      side,
      edges: d.edges || null,
      regime: d.regime || null,
      agents: d.agents || null,
      featureSnapshot: d.featureSnapshot || null,
      tradePlan: d.tradePlan || null,
      predictedEdgeR: num(d.edges?.[side]?.edge, null),
      predictedProbability: num(d.edges?.[side]?.p, null),
      predictedExpectedR: num(d.edges?.[side]?.expectedR, null)
    } : null,
    symbol: String(symbol || d.symbol || "UNKNOWN"),
    side,
    action: String(d.action || side),
    reason: String(d.reason || (side === "WAIT" ? "NOT_AUTHORIZED" : "AUTHORIZED")),
    authorizedForExecution: d.authorizedForExecution === true,
    signalTime: num(signalTime, Math.floor(scannedAt / 900000) * 900000),
    scannedAt: new Date(scannedAt),
    decisionKey: "",
    rankScore: num(d.rankScore ?? metrics.score, null),
    originalRankScore: num(d.originalRankScore ?? d.rankScore ?? metrics.score, null),
    confidence: num(d.confidence, null),
    roleScore: num(metrics.roleScore, null),
    setupQuality: num(metrics.setupQuality, null),
    entryQuality: num(metrics.entryQuality, null),
    roleWeights: metrics.roleWeights || null,
    roleContributions: metrics.roleContributions || null,
    roles,
    features: features && typeof features === "object" ? { ...features } : null,
    dataDerivedPolicyEvidence: metrics.dataDerivedConsensus || null,
    featureSchemaVersion: 1,
    marketDataSchemaVersion: 2,
    marketWindow: window,
    windowFeatureSchemaVersion: 2,
    windowFeatures: extractWindowFeatures(window),
    marketRegime: regimeOf(features),
    learningEvidence,
    evaluations: {},
    outcomeStatus: "PENDING_HORIZON_EVALUATION",
    actualTrade: false,
    createdAt: new Date(scannedAt)
  };
  const signature = JSON.stringify({
    side: snapshot.side, reason: snapshot.reason, rankScore: snapshot.rankScore,
    confidence: snapshot.confidence, roles: snapshot.roles, features: snapshot.features,
    dataDerivedPolicyEvidence: snapshot.dataDerivedPolicyEvidence,
    learningEvidence: snapshot.learningEvidence
  });
  const digest = crypto.createHash("sha256").update(signature).digest("hex").slice(0, 12);
  // Repeated WAIT scans inside the same 15-minute candle add little value.
  // Collapse them to one WAIT row per symbol/candle while retaining the richer
  // signature-based key for authorized directional decisions.
  snapshot.decisionKey = side === "WAIT"
    ? snapshot.symbol + ":" + String(snapshot.signalTime) + ":WAIT"
    : snapshot.symbol + ":" + String(snapshot.signalTime) + ":" + digest;
  return snapshot;
}

async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_MONGODB_REQUIRED");
  collection = db.collection(COLLECTION);
  await collection.createIndex({ decisionKey: 1 }, { unique: true, name: "uniq_nine_ai_decision_key" });
  await collection.createIndex({ symbol: 1, signalTime: -1 }, { name: "nine_ai_decision_symbol_time" });
  // Supports the global newest-record scan below. The symbol-prefixed index
  // cannot serve a sort over the entire collection and caused Mongo's 32 MB
  // in-memory sort limit to abort startup on a large journal.
  await collection.createIndex({ signalTime: -1, scannedAt: -1 }, { name: "nine_ai_decision_global_time" });
  await collection.createIndex({ outcomeStatus: 1, symbol: 1 }, { name: "nine_ai_decision_pending" });
  records = await collection.find({}).sort({ signalTime: -1, scannedAt: -1 })
    .hint({ signalTime: -1, scannedAt: -1 }).limit(MAX_RECORDS).toArray();
  records = records.filter(r => r && r.decisionKey && r.symbol);
  records.reverse();
  seen.clear();
  for (const r of records) seen.add(String(r.decisionKey));
  return { samples: records.length, pending: records.filter(r => r.outcomeStatus === "PENDING_HORIZON_EVALUATION").length,
    windowSnapshots: records.filter(r => Array.isArray(r.marketWindow) && r.marketWindow.length === MARKET_WINDOW_BARS).length,
    maturedWindowSamples: records.filter(r => r.outcomeStatus === "EVALUATED" &&
      Array.isArray(r.marketWindow) && r.marketWindow.length === MARKET_WINDOW_BARS &&
      Number.isFinite(Number(r.evaluations?.["4"]?.longNetR)) &&
       Number.isFinite(Number(r.evaluations?.["16"]?.longNetR)) &&
       Number.isFinite(Number(r.evaluations?.["24"]?.longNetR))).length,
    minWindowSamples: MIN_SAMPLES };
}

function isTransientJournalWriteError(error) {
  if (typeof error?.hasErrorLabel === "function" && error.hasErrorLabel("RetryableWriteError")) return true;
  const code = Number(error?.code);
  if ([6, 7, 89, 91, 11600, 11602, 13435, 13436].includes(code)) return true;
  const detail = [error?.name, error?.message, error?.cause?.name, error?.cause?.message]
    .filter(Boolean).join(" ");
  return /MongoNetwork|MongoServerSelection|MongoOperationTimeout|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|network error/i.test(detail);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hasDecisionForCandle(symbol, signalTime) {
  const key = String(symbol || "").toUpperCase();
  const time = num(signalTime);
  if (!key || !Number.isFinite(time)) return false;
  if (records.some(row => String(row.symbol).toUpperCase() === key && Number(row.signalTime) === time)) return true;
  if (!collection) return false;
  const found = await collection.findOne({ symbol: key, signalTime: time }, { projection: { _id: 1 } });
  return Boolean(found);
}

async function recordDecision(args) {
  if (!collection) throw new Error("NINE_AI_DECISION_JOURNAL_NOT_INITIALIZED");
  const scannedAt = num(args?.scannedAt, Date.now());
  const snapshot = snapshotDecision({ ...args, scannedAt });
  if (seen.has(snapshot.decisionKey)) return { recorded: false, reason: "DUPLICATE_DECISION", decisionKey: snapshot.decisionKey };
  let lastError = null;
  // The unique decisionKey index makes retrying an ambiguous network failure
  // idempotent: if MongoDB committed the first insert but its reply was lost,
  // the retry becomes a duplicate rather than a second journal row.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await collection.insertOne(snapshot);
      lastError = null;
      break;
    } catch (error) {
      if (error?.code === 11000) {
        seen.add(snapshot.decisionKey);
        return { recorded: false, reason: "DUPLICATE_DECISION", decisionKey: snapshot.decisionKey };
      }
      lastError = error;
      if (!isTransientJournalWriteError(error) || attempt === 2) throw error;
      await wait(200 * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
  records.push(snapshot);
  seen.add(snapshot.decisionKey);
  if (records.length > MAX_RECORDS) {
    records = records.slice(-MAX_RECORDS);
    seen.clear();
    for (const row of records) seen.add(String(row.decisionKey));
  }
  return { recorded: true, decisionKey: snapshot.decisionKey, side: snapshot.side };
}

function computeEvaluations(record, candles) {
  const idx = signalCandleIndex(candles, num(record.signalTime));
  if (idx < 0) return null;
  const baseEntry = num(record.features?.close, candles[idx].close);
  const atr = num(record.features?.atr14, atrAt(candles, idx));
  if (!(baseEntry > 0 && atr > 0)) return null;
  const configuredCost = num(process.env.NINE_AI_ROUND_TRIP_COST_RATE, DEFAULT_ROUND_TRIP_COST_RATE);
  const snapCosts = record.decisionSnapshot?.featureSnapshot || {};
  const explicitCostPct = [snapCosts.feePct, snapCosts.fundingCostPct, snapCosts.estSlippagePct].map(value => num(value));
  const costRate = explicitCostPct.every(Number.isFinite)
    ? clamp(explicitCostPct.reduce((sum, value) => sum + value, 0) / 100, 0, 0.05)
    : clamp(configuredCost, 0, 0.02);
  const evaluations = { ...(record.evaluations || {}) };
  const researchVariants = { ...(record.researchVariants || {}) };
  let changed = false;

  // Fixed risk scale is the ATR known at signal time. Entry delays use only
  // candles that close after the original decision; no future data leaks into
  // features, and every result is explicitly hypothetical.
  for (const horizon of HORIZONS) {
    const key = String(horizon);
    if (evaluations[key]) continue;
    const targetIndex = idx + horizon;
    if (targetIndex >= candles.length) continue;
    const exit = candles[targetIndex].close;
    const moveR = (exit - baseEntry) / atr;
    const feeR = baseEntry * costRate / atr;
    evaluations[key] = {
      horizonBars: horizon, evaluatedAt: new Date(candles[targetIndex].closeTime),
      exitPrice: exit, longGrossR: Number(moveR.toFixed(6)),
      shortGrossR: Number((-moveR).toFixed(6)),
      longNetR: Number((moveR - feeR).toFixed(6)),
      shortNetR: Number((-moveR - feeR).toFixed(6)),
      feeR: Number(feeR.toFixed(6)),
      source: "HYPOTHETICAL_FORWARD_CLOSES_NOT_EXECUTED_PNL"
    };
    changed = true;
  }

  for (const delayBars of [0, 1, 2]) {
    for (const horizon of HORIZONS) {
      const key = (delayBars === 0 ? "now" : "wait" + delayBars) + "_" + horizon;
      if (researchVariants[key]) continue;
      const entryIndex = idx + delayBars;
      const exitIndex = entryIndex + horizon;
      if (exitIndex >= candles.length) continue;
      const entryPrice = delayBars === 0 ? baseEntry : candles[entryIndex].close;
      const exitPrice = candles[exitIndex].close;
      if (!(entryPrice > 0 && exitPrice > 0)) continue;
      const moveR = (exitPrice - entryPrice) / atr;
      const feeR = entryPrice * costRate / atr;
      researchVariants[key] = {
        entryDelayBars: delayBars, horizonBars: horizon,
        entryPrice, exitPrice, evaluatedAt: new Date(candles[exitIndex].closeTime),
        longGrossR: Number(moveR.toFixed(6)), shortGrossR: Number((-moveR).toFixed(6)),
        longNetR: Number((moveR - feeR).toFixed(6)),
        shortNetR: Number((-moveR - feeR).toFixed(6)), feeR: Number(feeR.toFixed(6)),
        source: "HYPOTHETICAL_ENTRY_TIMING_RESEARCH_NOT_EXECUTED_PNL"
      };
      changed = true;
    }
  }

  if (!changed) return null;
  const allHorizonsMature = HORIZONS.every(h => evaluations[String(h)]);
  const allResearchMature = [0,1,2].every(delay => HORIZONS.every(h =>
    researchVariants[(delay === 0 ? "now" : "wait" + delay) + "_" + h]));
  return {
    evaluations, researchVariants,
    outcomeStatus: allHorizonsMature && allResearchMature ? "EVALUATED" :
      Object.keys(evaluations).length || Object.keys(researchVariants).length ? "PARTIALLY_EVALUATED" : "PENDING_HORIZON_EVALUATION"
  };
}
async function settleMatured(symbol, rawCandles) {
  if (!collection) throw new Error("NINE_AI_DECISION_JOURNAL_NOT_INITIALIZED");
  const candles = normalizeCandles(rawCandles);
  if (candles.length < 18) return { evaluated: 0 };
  const pending = records.filter(r => r.symbol === String(symbol) && (r.outcomeStatus !== "EVALUATED" || !r.researchVariants?.now_4 || !r.researchVariants?.wait1_4 || !r.researchVariants?.wait2_16));
  let evaluated = 0;
  for (const record of pending) {
    const result = computeEvaluations(record, candles);
    if (!result) continue;
    await collection.updateOne({ decisionKey: record.decisionKey }, { $set: result });
    Object.assign(record, result);
    evaluated++;
  }
  return { evaluated };
}

function positiveEvidenceBonus(meanR, standardError, sampleCount) {
  if (!Number.isFinite(meanR) || !Number.isFinite(standardError) ||
      !Number.isFinite(sampleCount) || sampleCount < MIN_SAMPLES) return 0;
  const lowerConfidenceBound = meanR - standardError;
  if (lowerConfidenceBound <= 0) return 0;
  return Number(clamp(lowerConfidenceBound * 1.5 * sampleCount / (sampleCount + MIN_SAMPLES), 0, MAX_LIVE_BONUS).toFixed(3));
}

async function recordActualOutcome({ decisionKey, tradeId, realizedR, pnl, closedAt,
  symbol = null, side = null, entryExecution = null, exit = null, accounting = null }) {
  if (!collection) throw new Error("NINE_AI_DECISION_JOURNAL_NOT_INITIALIZED");
  if (!decisionKey || !Number.isFinite(Number(realizedR))) return { updated: false, reason: "INVALID_ACTUAL_OUTCOME" };
  const actualOutcome = {
    tradeId: String(tradeId || ""),
    realizedR: Number(realizedR),
    pnl: Number.isFinite(Number(pnl)) ? Number(pnl) : null,
    closedAt: closedAt ? new Date(closedAt) : new Date(),
    source: "CONFIRMED_CLOSED_EXCHANGE_TRADE",
    symbol: symbol ? String(symbol) : null,
    side: side && ["LONG", "SHORT"].includes(side) ? side : null,
    entryExecution: entryExecution && typeof entryExecution === "object" ? entryExecution : null,
    exit: exit && typeof exit === "object" ? exit : null,
    accounting: accounting && typeof accounting === "object" ? accounting : null
  };
  const result = await collection.updateOne({ decisionKey: String(decisionKey) }, {
    $set: { actualTrade: true, actualOutcome, actualOutcomeRecordedAt: new Date() }
  });
  const record = records.find(r => r.decisionKey === String(decisionKey));
  if (record) { record.actualTrade = true; record.actualOutcome = actualOutcome; }
  return { updated: result.modifiedCount > 0, matched: result.matchedCount > 0 };
}

function assess(features = {}, side, { marketWindow = null, signalTime = Infinity } = {}) {
  const wantedSide = String(side || "").toUpperCase();
  if (!["LONG", "SHORT"].includes(wantedSide)) return { ready: false, bonus: 0, reason: "NO_DIRECTION" };
  const liveWindow = snapshotMarketWindow(marketWindow, MARKET_WINDOW_BARS, num(signalTime, Infinity));
  const windowEvidence = assessWindowEvidence(liveWindow, wantedSide);
  const regime = regimeOf(features);
  // Multiple snapshots can exist for one symbol/candle if learning changed
  // the decision during that scan window. Keep the latest snapshot per candle
  // for statistical evaluation so correlated repeats cannot inflate samples.
  const latestByCandle = new Map();
  for (const row of records) {
    if (row.outcomeStatus !== "EVALUATED" || !row.evaluations?.["4"] ||
        !Number.isFinite(Number(row.evaluations["4"][wantedSide.toLowerCase() + "NetR"]))) continue;
    const key = String(row.symbol) + ":" + String(row.signalTime);
    latestByCandle.set(key, row);
  }
  const eligible = [...latestByCandle.values()].filter(r =>
    (r.marketRegime === regime || r.marketRegime === "UNKNOWN"));
  const sampleCount = eligible.length;
  let meanR = null, standardError = null, lowerConfidenceBound = null, broadBonus = 0;
  if (sampleCount >= MIN_SAMPLES) {
    const values = eligible.map(r => Number(r.evaluations["4"][wantedSide.toLowerCase() + "NetR"]));
    meanR = values.reduce((s,v) => s + v, 0) / values.length;
    const variance = values.reduce((s,v) => s + (v - meanR) ** 2, 0) / values.length;
    standardError = Math.sqrt(variance / values.length);
    lowerConfidenceBound = meanR - standardError;
    broadBonus = positiveEvidenceBonus(meanR, standardError, sampleCount);
  }
  // Similar 48-bar windows contribute evidence from wins and losses. This is
  // a soft ranking adjustment: it cannot authorize or veto an entry.
  const bonus = Number((broadBonus + Number(windowEvidence.adjustment || 0)).toFixed(3));
  const ready = sampleCount >= MIN_SAMPLES || windowEvidence.ready;
  return { ready, samples: sampleCount, meanR: meanR == null ? null : Number(meanR.toFixed(4)),
    standardError: standardError == null ? null : Number(standardError.toFixed(4)),
    lowerConfidenceBound: lowerConfidenceBound == null ? null : Number(lowerConfidenceBound.toFixed(4)),
    bonus, regime, side: wantedSide, horizonBars: 4,
    source: windowEvidence.ready ? "REGIME_AND_SIMILAR_48_BAR_WINDOWS" : "HYPOTHETICAL_SKIPPED_AND_TAKEN_SIGNALS",
    windowLearning: windowEvidence,
    reason: ready ? null : windowEvidence.reason || "INSUFFICIENT_SAMPLE" };
}

function status() {
  const evaluated = records.filter(r => r.outcomeStatus === "EVALUATED").length;
  const windowSnapshots = records.filter(r => Array.isArray(r.marketWindow) && r.marketWindow.length === MARKET_WINDOW_BARS).length;
  const maturedWindowSamples = records.filter(r => r.outcomeStatus === "EVALUATED" &&
    Array.isArray(r.marketWindow) && r.marketWindow.length === MARKET_WINDOW_BARS &&
    Number.isFinite(Number(r.evaluations?.["4"]?.longNetR)) &&
       Number.isFinite(Number(r.evaluations?.["16"]?.longNetR)) &&
       Number.isFinite(Number(r.evaluations?.["24"]?.longNetR))).length;
  return { samples: records.length, evaluated, pending: records.length - evaluated,
    windowSnapshots, maturedWindowSamples, windowResearchReady: maturedWindowSamples >= MIN_SAMPLES,
    minSamples: MIN_SAMPLES, horizons: [...HORIZONS], maxLiveBonus: MAX_LIVE_BONUS };
}

module.exports = { COLLECTION, MAX_RECORDS, HORIZONS, MIN_SAMPLES, MARKET_WINDOW_BARS, normalizeCandles, snapshotMarketWindow,
  extractWindowFeatures, assessWindowEvidence, snapshotDecision, initialize, hasDecisionForCandle, recordDecision, settleMatured,
  computeEvaluations, positiveEvidenceBonus, recordActualOutcome, assess, status };
