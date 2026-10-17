"use strict";

// Contextual post-trade learning. This is evidence from trades actually taken,
// not a claim that the unchosen side's counterfactual outcome is known.
// It persists every confirmed close once and exposes shrunk, sample-gated
// expectancy by side and market condition to the synchronous strategy scorer.
const COLLECTION = "nine_ai_contextual_outcomes";
const MAX_OUTCOMES = 2000;
let outcomes = null;
let records = [];
let seen = new Set();

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function contextTags(features = {}) {
  const tags = ["ALL"];
  const regime = String(features.marketRegime || features.regimeName || "UNKNOWN").toUpperCase();
  tags.push("REGIME:" + regime);
  const rsi = num(features.rsi14 ?? features.rsi, 50);
  const extension = Math.abs(num(features.extensionAtr ?? features.extension));
  const momentum = num(features.momentum4 ?? features.momentum);
  const falseBreakout = num(features.falseBreakoutRisk);
  const volume = num(features.volumeRatio ?? features.volume, 1);
  const longQuality = num(features.longEntryQuality, 50);
  const shortQuality = num(features.shortEntryQuality, 50);
  if (extension >= 1.5 && ((rsi >= 65 && momentum > 0) || (rsi <= 35 && momentum < 0))) tags.push("MOMENTUM_EXHAUSTION");
  if (rsi >= 68) tags.push("RSI_OVERBOUGHT");
  if (rsi <= 32) tags.push("RSI_OVERSOLD");
  if (falseBreakout >= 0.5) tags.push("FALSE_BREAKOUT_RISK");
  if (extension >= 1.25) tags.push("EXTENDED_ENTRY");
  if (volume < 0.75) tags.push("LOW_VOLUME");
  if (longQuality - shortQuality >= 15) tags.push("LONG_QUALITY_ADVANTAGE");
  if (shortQuality - longQuality >= 15) tags.push("SHORT_QUALITY_ADVANTAGE");
  if (num(features.breakoutStrength) > 0.15) tags.push("BULLISH_BREAKOUT");
  if (num(features.breakoutStrength) < -0.15) tags.push("BEARISH_BREAKDOWN");
  return [...new Set(tags)];
}

function summarizeSide(side, tags = null) {
  const matched = records.filter(r => r.side === side && (!tags || tags.every(tag => r.tags.includes(tag))));
  const n = matched.length;
  const meanR = n ? matched.reduce((s, r) => s + clamp(num(r.realizedR), -5, 5), 0) / n : 0;
  const wins = matched.filter(r => num(r.realizedR) > 0).length;
  return { samples: n, meanR: Number(meanR.toFixed(4)), winRate: n ? wins / n : 0 };
}

function assess(features = {}) {
  const tags = contextTags(features);
  const result = {};
  for (const side of ["LONG", "SHORT"]) {
    const global = summarizeSide(side);
    // Prefer the most specific condition with enough observations. Never let
    // a tiny bucket override the broad historical result.
    const candidates = tags.slice(2).concat(tags.slice(1, 2)).map(tag => ({ tag, stats: summarizeSide(side, [tag]) }))
      .filter(item => item.stats.samples > 0)
      .sort((a, b) => b.stats.samples - a.stats.samples);
    const selected = candidates[0] || null;
    const usable = selected ? selected.stats : global;
    const ready = usable.samples > 0;
    const priorStrength = Math.sqrt(Math.max(1, records.length));
    const reliability = ready ? usable.samples / (usable.samples + priorStrength) : 0;
    result[side] = {
      ready, samples: usable.samples, context: selected?.tag || "ALL",
      meanR: usable.meanR, winRate: Number(usable.winRate.toFixed(4)),
      edge: ready ? clamp(usable.meanR * 12 * reliability, -18, 18) : 0,
      tags
    };
  }
  return result;
}

async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_MONGODB_REQUIRED");
  outcomes = db.collection(COLLECTION);
  await outcomes.createIndex({ tradeId: 1 }, { unique: true, name: "uniq_nine_ai_contextual_trade" });
  const recent = await outcomes.find({ closed: true }).sort({ closedAt: -1 }).limit(MAX_OUTCOMES).toArray();
  records = recent.filter(r => r && ["LONG", "SHORT"].includes(r.side) &&
    Number.isFinite(Number(r.realizedR)) && Array.isArray(r.tags));
  seen = new Set(records.map(r => String(r.tradeId)));
  return { samples: records.length, uniqueTrades: seen.size };
}

async function recordClosedTrade(trade) {
  if (!outcomes) throw new Error("NINE_AI_CONTEXTUAL_LEARNING_NOT_INITIALIZED");
  if (!trade || !trade.closed || !trade.tradeId || !["LONG", "SHORT"].includes(trade.side) ||
      !trade.features || !Number.isFinite(Number(trade.realizedR))) {
    throw new Error("CLOSED_TRADE_LABEL_REQUIRED");
  }
  const tradeId = String(trade.tradeId);
  if (seen.has(tradeId)) return { updated: false, reason: "DUPLICATE_TRADE", samples: records.length };
  const doc = {
    tradeId, symbol: String(trade.symbol || ""), side: trade.side,
    features: trade.features, context: trade.context || null,
    realizedR: clamp(Number(trade.realizedR), -20, 20),
    tags: contextTags(trade.features), closed: true,
    closedAt: trade.closedAt ? new Date(trade.closedAt) : new Date()
  };
  try {
    await outcomes.insertOne(doc);
  } catch (error) {
    if (error?.code === 11000) {
      seen.add(tradeId);
      return { updated: false, reason: "DUPLICATE_TRADE", samples: records.length };
    }
    throw error;
  }
  records.unshift(doc);
  seen.add(tradeId);
  if (records.length > MAX_OUTCOMES) records.length = MAX_OUTCOMES;
  if (seen.size > MAX_OUTCOMES * 2) seen = new Set(records.map(r => String(r.tradeId)));
  return { updated: true, samples: records.length, tags: doc.tags };
}

function status() {
  return {
    samples: records.length,
    long: summarizeSide("LONG"),
    short: summarizeSide("SHORT"),
    contextSamplePolicy: "CONTINUOUS_SHRINKAGE_NO_MINIMUM_SAMPLE_GATE"
  };
}

module.exports = { COLLECTION, MAX_OUTCOMES, contextTags, assess,
  initialize, recordClosedTrade, status };
