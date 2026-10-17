"use strict";

// MongoDB-backed online learner. RAM holds only the compact model currently
// needed for prediction; decisions/outcomes and model state persist in MongoDB.
// No local JSON state file and no hosted AI/API are used.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
let stateCollection = null;
let outcomesCollection = null;
let stateCache = null;

const BASE_DECISION_WEIGHTS = Object.freeze({ role: 0.80, setup: 0.10, entry: 0.10 });
const BASE_ROLE_WEIGHTS = Object.freeze({
  "Technical Analyst AI": 0.15, "ML Signal AI": 0.15, "Learning & Memory AI": 0.10,
  "Bull AI": 0.10, "Bear AI": 0.10, "Contrarian AI": 0.15, "Analyst AI": 0.10,
  "Decision AI": 0.10, "Risk Manager AI": 0.05
});
const ADAPTIVE_ROLE_NAMES = Object.keys(BASE_ROLE_WEIGHTS).filter(name => name !== "Risk Manager AI");
function normalizeDecisionWeights(weights) {
  const role = clamp(Number(weights?.role) || BASE_DECISION_WEIGHTS.role, 0.45, 0.90);
  const nonRole = 1 - role;
  const rawSetup = Math.max(0.001, Number(weights?.setup) || BASE_DECISION_WEIGHTS.setup);
  const rawEntry = Math.max(0.001, Number(weights?.entry) || BASE_DECISION_WEIGHTS.entry);
  const setupMin = Math.max(0.03, nonRole - 0.35);
  const setupMax = Math.min(0.35, nonRole - 0.03);
  const setup = clamp(nonRole * rawSetup / (rawSetup + rawEntry), setupMin, setupMax);
  return { role, setup, entry: nonRole - setup };
}
function normalizeRoleWeights(weights) {
  const result = {};
  let total = 0;
  for (const name of ADAPTIVE_ROLE_NAMES) {
    result[name] = clamp(Number(weights?.[name]) || BASE_ROLE_WEIGHTS[name], BASE_ROLE_WEIGHTS[name] * 0.5, BASE_ROLE_WEIGHTS[name] * 1.5);
    total += result[name];
  }
  result["Risk Manager AI"] = BASE_ROLE_WEIGHTS["Risk Manager AI"];
  for (const name of ADAPTIVE_ROLE_NAMES) result[name] *= 0.95 / total;
  return result;
}
function fresh() {
  return {
    _id: "main", version: 3, samples: 0,
    weights: [0, 0.35, 0.25, 0.15, 0.1, -0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bias: 0, decisionWeights: { ...BASE_DECISION_WEIGHTS },
    roleWeights: { ...BASE_ROLE_WEIGHTS }, recent: [], updatedAt: null
  };
}

stateCache = fresh();

function validState(state) {
  const v1 = state?.version === 1 && Array.isArray(state.weights) && state.weights.length === 6;
  const v2 = state?.version === 2 && Array.isArray(state.weights) && state.weights.length === 18;
  const v3 = state?.version === 3 && Array.isArray(state.weights) && state.weights.length === 18;
  return Boolean(state && (v1 || v2 || v3) && Number.isInteger(state.samples) && state.samples >= 0 &&
    state.weights.every(Number.isFinite) && Number.isFinite(state.bias) && Array.isArray(state.recent) &&
    (state.version < 3 || (state.decisionWeights && state.roleWeights)));
}
function upgradeState(state) {
  if (!validState(state)) return fresh();
  if (state.version === 3) return state;
  return {
    ...state, version: 3,
    weights: state.version === 1 ? [...state.weights, ...Array(12).fill(0)] : [...state.weights],
    decisionWeights: normalizeDecisionWeights(state.decisionWeights || BASE_DECISION_WEIGHTS),
    roleWeights: normalizeRoleWeights(state.roleWeights || BASE_ROLE_WEIGHTS),
    recent: [...state.recent]
  };
}
function decisionPolicy(state = stateCache) {
  const model = validState(state) ? upgradeState(state) : fresh();
  return { decisionWeights: normalizeDecisionWeights(model.decisionWeights),
    roleWeights: normalizeRoleWeights(model.roleWeights), samples: model.samples, updatedAt: model.updatedAt };
}
function adaptDecisionPolicy(state, outcome) {
  const context = outcome.context || {};
  const reward = clamp(Number(outcome.realizedR), -5, 5);
  if (!Number.isFinite(reward) || reward === 0) return;
  const label = reward > 0 ? 1 : 0;
  const lr = 0.01 / Math.sqrt(1 + state.samples / 50);
  const components = [["role", Number(context.roleScore)], ["setup", Number(context.setupQuality)], ["entry", Number(context.entryQuality)]];
  const weights = normalizeDecisionWeights(state.decisionWeights);
  const predicted = clamp(components.reduce((sum, [key, score]) =>
    sum + (Number.isFinite(score) ? clamp(score, 0, 100) / 100 : 0.5) * weights[key], 0), 0.05, 0.95);
  const error = label - predicted;
  const nextWeights = { ...weights };
  for (const [key, score] of components) {
    if (!Number.isFinite(score)) continue;
    nextWeights[key] = clamp(nextWeights[key] + lr * error * ((clamp(score, 0, 100) - 50) / 50),
      0.03, key === "role" ? 0.90 : 0.35);
  }
  state.decisionWeights = normalizeDecisionWeights(nextWeights);
  const votes = Array.isArray(context.roleVotes) ? context.roleVotes : [];
  const roleWeights = normalizeRoleWeights(state.roleWeights);
  for (const vote of votes) {
    const name = String(vote?.name || "");
    if (!ADAPTIVE_ROLE_NAMES.includes(name)) continue;
    const side = String(vote?.side || "NEUTRAL");
    const confidence = clamp(Number(vote?.confidence) || 50, 0, 100);
    const voteQuality = side === outcome.side ? confidence :
      (side === "LONG" || side === "SHORT" ? 100 - confidence : 50);
    const evidence = (voteQuality - 50) / 50;
    roleWeights[name] = clamp(roleWeights[name] + lr * Math.sign(reward) * evidence,
      BASE_ROLE_WEIGHTS[name] * 0.5, BASE_ROLE_WEIGHTS[name] * 1.5);
  }
  state.roleWeights = normalizeRoleWeights(roleWeights);
}

function vector(features) {
  const f = features || {};
  return [
    1,
    clamp(Number(f.trend) || 0, -1, 1),
    clamp(Number(f.momentum) || 0, -3, 3),
    clamp(((Number(f.rsi) || 50) - 50) / 30, -2, 2),
    clamp((Number(f.volume) || 1) - 1, -2, 3),
    clamp(Number(f.extension) || 0, -3, 3),
    clamp(Number(f.candleBody) || 0, -1, 1),
    clamp(Number(f.wickImbalance) || 0, -1, 1),
    clamp((Number(f.breakoutStrength) || 0) / 2, -1.5, 1.5),
    clamp(Number(f.regime) || 0, -1, 1),
    clamp(Number(f.volatilityRegime) || 0, -1, 1),
    clamp(Number(f.structurePosition) || 0, -1, 1),
    clamp((Number(f.roomToResistance) || 0) / 3, -1, 1),
    clamp((Number(f.roomToSupport) || 0) / 3, -1, 1),
    clamp(Number(f.falseBreakoutRisk) || 0, 0, 1),
    clamp(Number(f.directionalStreak) || 0, -1, 1),
    clamp(((Number.isFinite(Number(f.longEntryQuality)) ? Number(f.longEntryQuality) : 50) - 50) / 50, -1, 1),
    clamp(((Number.isFinite(Number(f.shortEntryQuality)) ? Number(f.shortEntryQuality) : 50) - 50) / 50, -1, 1)
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
  const state = { ...stateCache, weights: [...stateCache.weights],
    decisionWeights: { ...stateCache.decisionWeights }, roleWeights: { ...stateCache.roleWeights },
    recent: [...stateCache.recent] };
  adaptDecisionPolicy(state, outcome);
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
    context: outcome.context || null,
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
  stateCache = validState(stored) ? upgradeState(stored) : fresh();
  if (!stored || !validState(stored) || stored.version !== stateCache.version) {
    await persistState(stateCache);
  }

  // Recover outcomes recorded before a process interruption but not yet applied.
  const pending = await outcomesCollection.find({ applied: { $ne: true } }).sort({ closedAt: 1 }).toArray();
  for (const outcome of pending) await applyOutcome(outcome);
  return { samples: stateCache.samples, trained: stateCache.samples >= 20 };
}

// Train only from confirmed closed trades. Unique MongoDB tradeId prevents
// duplicate learning; unapplied events are replayed safely after a restart.
async function learnClosedTrade({ tradeId, features, context = null, side, realizedR, closed }) {
  if (!stateCollection || !outcomesCollection) throw new Error("NINE_AI_MONGODB_NOT_INITIALIZED");
  if (!closed || !tradeId || !features || !["LONG", "SHORT"].includes(side) ||
      !Number.isFinite(Number(realizedR))) {
    throw new Error("CLOSED_TRADE_LABEL_REQUIRED");
  }

  const outcome = {
    tradeId: String(tradeId),
    features,
    context: context && typeof context === "object" ? context : null,
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
      // A previous attempt may have inserted the event but failed before
      // applying it. Retry that durable pending event instead of waiting for
      // the next process restart to recover learning.
      const existing = await outcomesCollection.findOne({ tradeId: String(tradeId) });
      if (existing && existing.applied !== true) await applyOutcome(existing);
      return { updated: false, reason: "DUPLICATE_TRADE", samples: stateCache.samples };
    }
    throw error;
  }

  await applyOutcome(outcome);
  return { updated: true, samples: stateCache.samples };
}

module.exports = { BASE_DECISION_WEIGHTS, BASE_ROLE_WEIGHTS, fresh, validState, upgradeState,
  normalizeDecisionWeights, normalizeRoleWeights, decisionPolicy, vector, predict, read, initialize, learnClosedTrade };
