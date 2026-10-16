"use strict";

// MongoDB-backed online learner. RAM holds only the compact model currently
// needed for prediction; decisions/outcomes and model state persist in MongoDB.
// No local JSON state file and no hosted AI/API are used.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
let stateCollection = null;
let outcomesCollection = null;
let stateCache = fresh();

function fresh() {
  return {
    _id: "main",
    version: 1,
    samples: 0,
    weights: [0, 0.35, 0.25, 0.15, 0.1, -0.1],
    bias: 0,
    recent: [],
    updatedAt: null
  };
}

function validState(state) {
  return Boolean(state && state.version === 1 &&
    Number.isInteger(state.samples) && state.samples >= 0 &&
    Array.isArray(state.weights) && state.weights.length === 6 &&
    state.weights.every(Number.isFinite) &&
    Number.isFinite(state.bias) && Array.isArray(state.recent));
}

function vector(features) {
  const f = features || {};
  return [
    1,
    clamp(Number(f.trend) || 0, -1, 1),
    clamp(Number(f.momentum) || 0, -3, 3),
    clamp(((Number(f.rsi) || 50) - 50) / 30, -2, 2),
    clamp((Number(f.volume) || 1) - 1, -2, 3),
    clamp(Number(f.extension) || 0, -3, 3)
  ];
}

function predict(features, state = stateCache) {
  const model = validState(state) ? state : fresh();
  const x = vector(features);
  const z = clamp(x.reduce((sum, value, i) => sum + value * model.weights[i], model.bias), -12, 12);
  const pLong = 1 / (1 + Math.exp(-z));
  return {
    pLong,
    samples: model.samples,
    trained: model.samples >= 20,
    side: model.samples < 20 ? null : pLong >= 0.58 ? "LONG" : pLong <= 0.42 ? "SHORT" : null
  };
}

function read() {
  return stateCache;
}

async function persistState(state) {
  if (!stateCollection) throw new Error("NINE_AI_MONGODB_NOT_INITIALIZED");
  const { _id, ...fields } = state;
  await stateCollection.updateOne(
    { _id: "main" },
    { $set: fields, $setOnInsert: { _id: "main" } },
    { upsert: true }
  );
  stateCache = state;
}

async function applyOutcome(outcome) {
  if (outcome.applied) return false;
  // If the model was saved but marking the event applied was interrupted,
  // the recent model ledger prevents replaying the same outcome twice.
  if (stateCache.recent.some(item => item.tradeId === String(outcome.tradeId))) {
    await outcomesCollection.updateOne(
      { _id: outcome._id, applied: { $ne: true } },
      { $set: { applied: true, appliedAt: new Date() } }
    );
    return false;
  }
  const state = { ...stateCache, weights: [...stateCache.weights], recent: [...stateCache.recent] };
  const x = vector(outcome.features);
  const reward = clamp(Number(outcome.realizedR), -5, 5);
  const sideLabel = outcome.side === "LONG" ? 1 : 0;
  const label = reward > 0 ? sideLabel : reward < 0 ? 1 - sideLabel : 0.5;
  const z = clamp(x.reduce((sum, value, i) => sum + value * state.weights[i], state.bias), -12, 12);
  const p = 1 / (1 + Math.exp(-z));
  const learningRate = 0.025 / Math.sqrt(1 + state.samples / 100);
  const error = clamp(label - p, -1, 1);

  for (let i = 0; i < state.weights.length; i++) {
    state.weights[i] = clamp(state.weights[i] + learningRate * error * x[i], -4, 4);
  }
  state.bias = clamp(state.bias + learningRate * error, -4, 4);
  state.samples++;
  state.recent.push({
    tradeId: String(outcome.tradeId),
    realizedR: reward,
    side: outcome.side,
    closedAt: Number(outcome.closedAt || Date.now())
  });
  state.recent = state.recent.slice(-100);
  state.updatedAt = new Date().toISOString();

  await persistState(state);
  await outcomesCollection.updateOne(
    { _id: outcome._id, applied: { $ne: true } },
    { $set: { applied: true, appliedAt: new Date() } }
  );
  return true;
}

async function initialize(db) {
  if (!db || typeof db.collection !== "function") {
    throw new Error("NINE_AI_MONGODB_REQUIRED");
  }
  stateCollection = db.collection("nine_ai_learning_state");
  outcomesCollection = db.collection("nine_ai_learning_outcomes");
  await outcomesCollection.createIndex({ tradeId: 1 }, { unique: true, name: "uniq_nine_ai_trade_outcome" });

  const stored = await stateCollection.findOne({ _id: "main" });
  stateCache = validState(stored) ? stored : fresh();
  if (!stored || !validState(stored)) await persistState(stateCache);

  // Recover outcomes recorded before a process interruption but not yet applied.
  const pending = await outcomesCollection.find({ applied: { $ne: true } }).sort({ closedAt: 1 }).toArray();
  for (const outcome of pending) await applyOutcome(outcome);
  return { samples: stateCache.samples, trained: stateCache.samples >= 20 };
}

// Train only from confirmed closed trades. Unique MongoDB tradeId prevents
// duplicate learning; unapplied events are replayed safely after a restart.
async function learnClosedTrade({ tradeId, features, side, realizedR, closed }) {
  if (!stateCollection || !outcomesCollection) throw new Error("NINE_AI_MONGODB_NOT_INITIALIZED");
  if (!closed || !tradeId || !features || !["LONG", "SHORT"].includes(side) ||
      !Number.isFinite(Number(realizedR))) {
    throw new Error("CLOSED_TRADE_LABEL_REQUIRED");
  }

  const outcome = {
    tradeId: String(tradeId),
    features,
    side,
    realizedR: Number(realizedR),
    closed: true,
    closedAt: new Date(),
    applied: false
  };
  try {
    const result = await outcomesCollection.insertOne(outcome);
    outcome._id = result.insertedId;
  } catch (error) {
    if (error?.code === 11000) {
      return { updated: false, reason: "DUPLICATE_TRADE", samples: stateCache.samples };
    }
    throw error;
  }

  await applyOutcome(outcome);
  return { updated: true, samples: stateCache.samples };
}

module.exports = { fresh, validState, vector, predict, read, initialize, learnClosedTrade };
