"use strict";

// General online reward model: learns realized net-R as a function of the full
// entry context, separately for each chosen direction. It does not encode
// named scenarios or convert one loss into a permanent rule. Sparse estimates
// are shrunk toward zero and accompanied by uncertainty.
const FEATURE_KEYS = Object.freeze([
  "trend", "momentum", "rsi", "volume", "extension", "candleBody",
  "wickImbalance", "breakoutStrength", "regime", "volatilityRegime",
  "structurePosition", "roomToResistance", "roomToSupport",
  "falseBreakoutRisk", "directionalStreak", "longEntryQuality",
  "shortEntryQuality"
]);
const MAX_OUTCOMES = 5000;
const MAX_WEIGHT = 5;
let stateCollection = null;
let outcomesCollection = null;
let state = freshState();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function freshSide() {
  return { samples: 0, weights: Array(FEATURE_KEYS.length + 1).fill(0), meanR: 0, variance: 1 };
}
function freshState() {
  return { _id: "main", version: 1, sides: { LONG: freshSide(), SHORT: freshSide() }, updatedAt: null };
}
function featureVector(features = {}) {
  const f = features || {};
  return [
    1,
    clamp(finite(f.trend), -1, 1),
    clamp(finite(f.momentum) / 2, -2, 2),
    clamp((finite(f.rsi, 50) - 50) / 30, -2, 2),
    clamp(finite(f.volume, 1) - 1, -1, 3),
    clamp(finite(f.extension), -4, 4),
    clamp(finite(f.candleBody), -1, 1),
    clamp(finite(f.wickImbalance), -1, 1),
    clamp(finite(f.breakoutStrength), -2, 2),
    clamp(finite(f.regime), -1, 1),
    clamp(finite(f.volatilityRegime), -1, 1),
    clamp(finite(f.structurePosition), -1, 1),
    clamp(finite(f.roomToResistance), -3, 3),
    clamp(finite(f.roomToSupport), -3, 3),
    clamp(finite(f.falseBreakoutRisk), 0, 1),
    clamp(finite(f.directionalStreak), -1, 1),
    clamp((finite(f.longEntryQuality, 50) - 50) / 50, -1, 1),
    clamp((finite(f.shortEntryQuality, 50) - 50) / 50, -1, 1)
  ];
}
function predict(features, side, modelState = state) {
  if (!["LONG", "SHORT"].includes(side)) return { expectedR: 0, uncertainty: 1, samples: 0, ready: false };
  const model = modelState?.sides?.[side] || freshSide();
  const x = featureVector(features);
  const raw = x.reduce((sum, v, i) => sum + v * model.weights[i], 0);
  const n = model.samples;
  const reliability = n / (n + Math.sqrt(Math.max(1, n)));
  const uncertainty = Math.sqrt(Math.max(0.05, model.variance) / Math.max(1, n));
  return {
    expectedR: clamp(raw * reliability, -5, 5),
    rawExpectedR: raw,
    uncertainty,
    samples: n,
    reliability,
    ready: n > 0
  };
}
function trainOne(model, x, reward) {
  const oldPrediction = x.reduce((sum, v, i) => sum + v * model.weights[i], 0);
  const error = clamp(reward - oldPrediction, -10, 10);
  const rate = 0.015 / Math.sqrt(1 + model.samples / 100);
  const norm = 1 + x.reduce((sum, v) => sum + v * v, 0);
  model.weights = model.weights.map((w, i) => clamp(w + rate * error * x[i] / Math.sqrt(norm), -MAX_WEIGHT, MAX_WEIGHT));
  const delta = reward - model.meanR;
  model.meanR += delta / (model.samples + 1);
  model.variance = model.samples === 0 ? reward * reward : Math.max(0.05,
    model.variance + (delta * (reward - model.meanR) - model.variance) / (model.samples + 1));
  model.samples += 1;
}
async function persist() {
  if (!stateCollection) return;
  await stateCollection.updateOne({ _id: "main" }, { $set: {
    version: state.version, sides: state.sides, updatedAt: state.updatedAt
  }, $setOnInsert: { _id: "main" } }, { upsert: true });
}
async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_REWARD_MODEL_MONGODB_REQUIRED");
  stateCollection = db.collection("nine_ai_reward_model_state");
  outcomesCollection = db.collection("nine_ai_reward_model_outcomes");
  await outcomesCollection.createIndex({ tradeId: 1 }, { unique: true, name: "uniq_nine_ai_reward_trade" });
  await outcomesCollection.createIndex({ closedAt: -1 }, { name: "nine_ai_reward_closed_at" });
  const stored = await stateCollection.findOne({ _id: "main" });
  state = stored?.version === 1 && stored.sides?.LONG?.weights?.length === FEATURE_KEYS.length + 1 &&
    stored.sides?.SHORT?.weights?.length === FEATURE_KEYS.length + 1 ? stored : freshState();
  // Rebuild the compact model deterministically if state was missing/corrupt or
  // recover any durable events that were inserted before a process interruption.
  const pending = await outcomesCollection.find({ applied: { $ne: true } }).sort({ closedAt: 1 }).limit(MAX_OUTCOMES).toArray();
  for (const row of pending) await applyOutcome(row);
  return status();
}
async function applyOutcome(row) {
  if (!row || row.applied || !["LONG", "SHORT"].includes(row.side) ||
      !Number.isFinite(Number(row.realizedR)) || !row.features) return false;
  trainOne(state.sides[row.side], featureVector(row.features), clamp(Number(row.realizedR), -10, 10));
  state.updatedAt = new Date().toISOString();
  await persist();
  await outcomesCollection.updateOne({ _id: row._id, applied: { $ne: true } },
    { $set: { applied: true, appliedAt: new Date() } });
  return true;
}
async function recordClosedTrade(trade) {
  if (!outcomesCollection) throw new Error("NINE_AI_REWARD_MODEL_NOT_INITIALIZED");
  if (!trade?.closed || !trade.tradeId || !["LONG", "SHORT"].includes(trade.side) ||
      !trade.features || !Number.isFinite(Number(trade.realizedR))) throw new Error("CLOSED_TRADE_LABEL_REQUIRED");
  const doc = {
    tradeId: String(trade.tradeId), side: trade.side, features: trade.features,
    context: trade.context || null, realizedR: clamp(Number(trade.realizedR), -10, 10),
    closed: true, applied: false, closedAt: trade.closedAt ? new Date(trade.closedAt) : new Date()
  };
  try {
    const inserted = await outcomesCollection.insertOne(doc);
    doc._id = inserted.insertedId;
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await outcomesCollection.findOne({ tradeId: doc.tradeId });
      if (existing && !existing.applied) await applyOutcome(existing);
      return { updated: false, reason: "DUPLICATE_TRADE", ...status() };
    }
    throw error;
  }
  const updated = await applyOutcome(doc);
  return { updated, ...status() };
}
function status() {
  return {
    longSamples: state.sides.LONG.samples,
    shortSamples: state.sides.SHORT.samples,
    totalSamples: state.sides.LONG.samples + state.sides.SHORT.samples
  };
}
module.exports = { FEATURE_KEYS, freshState, featureVector, predict, initialize, recordClosedTrade, status };
