"use strict";

// Durable journal for every Nine-AI scan decision, including WAIT/abstentions.
// Hypothetical forward outcomes are explicitly separate from actual trade PnL.
// Only robust positive evidence can add a small live ranking bonus; losses never
// veto a trade or trigger a "stand aside" rule.
const COLLECTION = "nine_ai_decision_journal";
const MAX_RECORDS = 5000;
const HORIZONS = [4, 16];
const MIN_SAMPLES = 20;
const MAX_LIVE_BONUS = 3;
const DEFAULT_ROUND_TRIP_COST_RATE = 0.0008;
let collection = null;
let records = [];
const seen = new Set();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = NaN) => v == null || v === "" ? d : Number.isFinite(Number(v)) ? Number(v) : d;
const regimeOf = features => String(features?.marketRegime || features?.regime || "UNKNOWN").toUpperCase();

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

function snapshotDecision({ symbol, decision, signalTime, scannedAt, learningEvidence = null }) {
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
  return {
    symbol: String(symbol || d.symbol || "UNKNOWN"),
    side,
    action: String(d.action || side),
    reason: String(d.reason || (side === "WAIT" ? "NOT_AUTHORIZED" : "AUTHORIZED")),
    authorizedForExecution: d.authorizedForExecution === true,
    signalTime: num(signalTime, Math.floor(scannedAt / 900000) * 900000),
    scannedAt: new Date(scannedAt),
    decisionKey: String(symbol || d.symbol || "UNKNOWN") + ":" + String(num(signalTime, Math.floor(scannedAt / 900000) * 900000)),
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
    marketRegime: regimeOf(features),
    learningEvidence,
    evaluations: {},
    outcomeStatus: "PENDING_HORIZON_EVALUATION",
    actualTrade: false,
    createdAt: new Date(scannedAt)
  };
}

async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_MONGODB_REQUIRED");
  collection = db.collection(COLLECTION);
  await collection.createIndex({ decisionKey: 1 }, { unique: true, name: "uniq_nine_ai_decision_key" });
  await collection.createIndex({ symbol: 1, signalTime: -1 }, { name: "nine_ai_decision_symbol_time" });
  await collection.createIndex({ outcomeStatus: 1, symbol: 1 }, { name: "nine_ai_decision_pending" });
  records = await collection.find({}).sort({ signalTime: -1 }).limit(MAX_RECORDS).toArray();
  records = records.filter(r => r && r.decisionKey && r.symbol);
  records.reverse();
  seen.clear();
  for (const r of records) seen.add(String(r.decisionKey));
  return { samples: records.length, pending: records.filter(r => r.outcomeStatus === "PENDING_HORIZON_EVALUATION").length };
}

async function recordDecision(args) {
  if (!collection) throw new Error("NINE_AI_DECISION_JOURNAL_NOT_INITIALIZED");
  const scannedAt = num(args?.scannedAt, Date.now());
  const snapshot = snapshotDecision({ ...args, scannedAt });
  if (seen.has(snapshot.decisionKey)) return { recorded: false, reason: "DUPLICATE_DECISION", decisionKey: snapshot.decisionKey };
  try {
    await collection.insertOne(snapshot);
  } catch (error) {
    if (error?.code === 11000) {
      seen.add(snapshot.decisionKey);
      return { recorded: false, reason: "DUPLICATE_DECISION", decisionKey: snapshot.decisionKey };
    }
    throw error;
  }
  records.push(snapshot);
  seen.add(snapshot.decisionKey);
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
  return { recorded: true, decisionKey: snapshot.decisionKey, side: snapshot.side };
}

function computeEvaluations(record, candles) {
  const idx = signalCandleIndex(candles, num(record.signalTime));
  if (idx < 0) return null;
  const entry = num(record.features?.close, candles[idx].close);
  const atr = num(record.features?.atr14, atrAt(candles, idx));
  if (!(entry > 0 && atr > 0)) return null;
  const configuredCost = num(process.env.NINE_AI_ROUND_TRIP_COST_RATE, DEFAULT_ROUND_TRIP_COST_RATE);
  const costRate = clamp(configuredCost, 0, 0.02);
  const feeR = entry * costRate / atr;
  const evaluations = { ...(record.evaluations || {}) };
  let changed = false;
  for (const horizon of HORIZONS) {
    const key = String(horizon);
    if (evaluations[key]) continue;
    const targetIndex = idx + horizon;
    if (targetIndex >= candles.length) continue;
    const exit = candles[targetIndex].close;
    const moveR = (exit - entry) / atr;
    evaluations[key] = {
      horizonBars: horizon,
      evaluatedAt: new Date(candles[targetIndex].closeTime),
      exitPrice: exit,
      longGrossR: Number(moveR.toFixed(6)),
      shortGrossR: Number((-moveR).toFixed(6)),
      longNetR: Number((moveR - feeR).toFixed(6)),
      shortNetR: Number((-moveR - feeR).toFixed(6)),
      feeR: Number(feeR.toFixed(6)),
      source: "HYPOTHETICAL_FORWARD_CLOSES_NOT_EXECUTED_PNL"
    };
    changed = true;
  }
  if (!changed) return null;
  return { evaluations, outcomeStatus: HORIZONS.every(h => evaluations[String(h)]) ? "EVALUATED" : "PARTIALLY_EVALUATED" };
}

async function settleMatured(symbol, rawCandles) {
  if (!collection) throw new Error("NINE_AI_DECISION_JOURNAL_NOT_INITIALIZED");
  const candles = normalizeCandles(rawCandles);
  if (candles.length < 18) return { evaluated: 0 };
  const pending = records.filter(r => r.symbol === String(symbol) && r.outcomeStatus !== "EVALUATED");
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

function assess(features = {}, side) {
  const wantedSide = String(side || "").toUpperCase();
  if (!["LONG", "SHORT"].includes(wantedSide)) return { ready: false, bonus: 0, reason: "NO_DIRECTION" };
  const regime = regimeOf(features);
  const eligible = records.filter(r => r.outcomeStatus === "EVALUATED" &&
    (r.marketRegime === regime || r.marketRegime === "UNKNOWN") &&
    r.evaluations?.["4"] && Number.isFinite(Number(r.evaluations["4"][wantedSide.toLowerCase() + "NetR"])));
  const sampleCount = eligible.length;
  if (sampleCount < MIN_SAMPLES) return { ready: false, bonus: 0, samples: sampleCount, reason: "INSUFFICIENT_SAMPLE" };
  const values = eligible.map(r => Number(r.evaluations["4"][wantedSide.toLowerCase() + "NetR"]));
  const meanR = values.reduce((s,v) => s + v, 0) / values.length;
  const variance = values.reduce((s,v) => s + (v - meanR) ** 2, 0) / values.length;
  const standardError = Math.sqrt(variance / values.length);
  const lowerConfidenceBound = meanR - standardError;
  // Loss evidence is retained in the journal and existing outcome learners.
  // This layer never penalizes or vetoes entries; only robust positive evidence
  // can modestly improve ranking, preventing a losing streak from forcing WAIT.
  const bonus = lowerConfidenceBound > 0
    ? Number(clamp(lowerConfidenceBound * 1.5 * sampleCount / (sampleCount + MIN_SAMPLES), 0, MAX_LIVE_BONUS).toFixed(3))
    : 0;
  return { ready: true, samples: sampleCount, meanR: Number(meanR.toFixed(4)),
    standardError: Number(standardError.toFixed(4)), lowerConfidenceBound: Number(lowerConfidenceBound.toFixed(4)),
    bonus, regime, side: wantedSide, horizonBars: 4, source: "HYPOTHETICAL_SKIPPED_AND_TAKEN_SIGNALS" };
}

function status() {
  const evaluated = records.filter(r => r.outcomeStatus === "EVALUATED").length;
  return { samples: records.length, evaluated, pending: records.length - evaluated,
    minSamples: MIN_SAMPLES, horizons: [...HORIZONS], maxLiveBonus: MAX_LIVE_BONUS };
}

module.exports = { COLLECTION, MAX_RECORDS, HORIZONS, MIN_SAMPLES, normalizeCandles,
  snapshotDecision, initialize, recordDecision, settleMatured, computeEvaluations, assess, status };
