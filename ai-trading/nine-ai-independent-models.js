"use strict";

// Nine separate online classifiers. MongoDB stores model state and the full outcome
// ledger; RAM retains only compact coefficients/metrics required for synchronous scoring.
// No outcome history is retained in each runtime. No hosted model or paid API is used.
const MODEL_CONFIGS = Object.freeze([
  { id: "technical", role: "Technical Analyst AI", scales: [1, 1.4, 0.8, 0.5, 0.7, 0.6], rate: 0.020 },
  { id: "signal", role: "ML Signal AI", scales: [1, 1, 1, 1, 1, 1], rate: 0.025 },
  { id: "memory", role: "Learning & Memory AI", scales: [1, 0.8, 1.1, 0.7, 1.2, 0.8], rate: 0.018 },
  { id: "bull", role: "Bull AI", scales: [1, 1.2, 0.7, 0.6, 0.8, 0.6], rate: 0.020 },
  { id: "bear", role: "Bear AI", scales: [1, 1.2, 0.7, 0.6, 0.8, 0.6], rate: 0.020 },
  { id: "contrarian", role: "Contrarian AI", scales: [1, -0.7, -0.8, -0.5, 0.7, -1.2], rate: 0.018 },
  { id: "analyst", role: "Analyst AI", scales: [1, 0.7, 0.8, 0.7, 1.3, 0.7], rate: 0.018 },
  { id: "decision", role: "Decision AI", scales: [1, 1, 1, 0.8, 0.8, 0.8], rate: 0.015 },
  { id: "risk", role: "Risk Manager AI", scales: [1, 0.6, 0.6, 1.0, 1.2, 1.2], rate: 0.020, target: "loss" }
]);

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => Number.isFinite(Number(x));
let dbRef = null;
const runtimes = new Map();

function fresh(config) {
  return {
    _id: "model",
    modelId: config.id,
    version: 3,
    samples: 0,
    weights: Array(18).fill(0),
    lastAppliedTradeId: null,
    evaluation: { evaluated: 0, correct: 0, brierSum: 0 },
    updatedAt: null
  };
}

function validState(state, config) {
  const legacy = state?.version === 1 && Array.isArray(state.weights) && state.weights.length === 6;
  const v2 = state?.version === 2 && Array.isArray(state.weights) && state.weights.length === 18;
  const v3 = state?.version === 3 && Array.isArray(state.weights) && state.weights.length === 18;
  return Boolean(state && state._id === "model" && state.modelId === config.id &&
    (legacy || v2 || v3) && Number.isInteger(state.samples) && state.samples >= 0 &&
    state.weights.every(Number.isFinite) && (state.version >= 3 || Array.isArray(state.recent)) &&
    state.evaluation && Number.isFinite(state.evaluation.evaluated) &&
    Number.isFinite(state.evaluation.correct) && Number.isFinite(state.evaluation.brierSum));
}

function upgradeState(state, config) {
  if (!validState(state, config)) return fresh(config);
  if (state.version === 3) return state;
  const recent = Array.isArray(state.recent) ? state.recent : [];
  const { recent: _recent, ...persistedFields } = state;
  return {
    ...persistedFields,
    version: 3,
    weights: state.weights.length === 6 ? [...state.weights, ...Array(12).fill(0)] : [...state.weights],
    lastAppliedTradeId: recent.length ? String(recent[recent.length - 1].tradeId || "") || null : (state.lastAppliedTradeId || null),
    evaluation: { ...state.evaluation }
  };
}

function vector(features, config) {
  const f = features || {};
  const base = [
    1,
    clamp(Number(f.trend) || 0, -1, 1),
    clamp((Number(f.momentum) || 0) / 2, -1.5, 1.5),
    clamp(((Number(f.rsi) || 50) - 50) / 30, -1.7, 1.7),
    clamp((Number(f.volume) || 1) - 1, -1, 3),
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
  return base.map((value, i) => value * (config.scales[i] ?? 1));
}

function sigmoid(z) {
  const bounded = clamp(z, -12, 12);
  return 1 / (1 + Math.exp(-bounded));
}

function predictOne(config, state, features) {
  const model = validState(state, config) ? state : fresh(config);
  const x = vector(features, config);
  const probability = sigmoid(x.reduce((sum, value, i) => sum + value * model.weights[i], 0));
  return {
    modelId: config.id,
    role: config.role,
    samples: model.samples,
    trained: model.samples > 0,
    probability: Number(probability.toFixed(6)),
    pLong: config.target === "loss" ? null : Number(probability.toFixed(6)),
    pLoss: config.target === "loss" ? Number(probability.toFixed(6)) : null,
    side: model.samples === 0 ? null :
      config.target === "loss" ? null :
      probability > 0.5 ? "LONG" : probability < 0.5 ? "SHORT" : null,
    evaluation: {
      evaluated: model.evaluation.evaluated,
      accuracy: model.evaluation.evaluated
        ? Number((model.evaluation.correct / model.evaluation.evaluated).toFixed(4)) : null,
      brierScore: model.evaluation.evaluated
        ? Number((model.evaluation.brierSum / model.evaluation.evaluated).toFixed(4)) : null
    }
  };
}

function predictAll(features) {
  return MODEL_CONFIGS.map(config => {
    const runtime = runtimes.get(config.id);
    return predictOne(config, runtime?.state || fresh(config), features);
  });
}

async function persistState(runtime, state) {
  const { stateCollection } = runtime;
  const { _id, ...fields } = state;
  await stateCollection.updateOne(
    { _id: "model" },
    { $set: fields, $unset: { recent: "" }, $setOnInsert: { _id: "model" } },
    { upsert: true }
  );
  runtime.state = state;
}

function directionalLabel(outcome) {
  const reward = Number(outcome.realizedR);
  if (reward === 0) return 0.5;
  const chosenSideIsLong = outcome.side === "LONG";
  const correctSideIsLong = reward > 0 ? chosenSideIsLong : !chosenSideIsLong;
  return correctSideIsLong ? 1 : 0;
}

async function applyOutcome(runtime, outcome) {
  if (outcome.applied) return false;
  const state = runtime.state;
  if (state.lastAppliedTradeId === String(outcome.tradeId)) {
    await runtime.outcomesCollection.updateOne(
      { _id: outcome._id, applied: { $ne: true } },
      { $set: { applied: true, appliedAt: new Date() } }
    );
    return false;
  }

  const config = runtime.config;
  const x = vector(outcome.features, config);
  const z = x.reduce((sum, value, i) => sum + value * state.weights[i], 0);
  const p = sigmoid(z);
  const label = config.target === "loss"
    ? (Number(outcome.realizedR) <= 0 ? 1 : 0)
    : directionalLabel(outcome);
  const lr = config.rate / Math.sqrt(1 + state.samples / 100);
  const error = clamp(label - p, -1, 1);
  const next = {
    ...state,
    weights: state.weights.map((weight, i) => clamp(weight + lr * error * x[i], -4, 4)),
    lastAppliedTradeId: String(outcome.tradeId),
    evaluation: { ...state.evaluation }
  };

  next.samples++;
  next.evaluation.evaluated++;
  if ((p >= 0.5 && label >= 0.5) || (p < 0.5 && label < 0.5)) next.evaluation.correct++;
  next.evaluation.brierSum += (p - label) ** 2;
  next.updatedAt = new Date().toISOString();

  await persistState(runtime, next);
  await runtime.outcomesCollection.updateOne(
    { _id: outcome._id, applied: { $ne: true } },
    { $set: { applied: true, appliedAt: new Date() } }
  );
  return true;
}

async function recordForModel(runtime, trade) {
  const doc = {
    tradeId: String(trade.tradeId),
    features: trade.features,
    context: trade.context && typeof trade.context === "object" ? trade.context : null,
    side: trade.side,
    realizedR: Number(trade.realizedR),
    closed: true,
    closedAt: trade.closedAt || new Date(),
    applied: false
  };
  try {
    const result = await runtime.outcomesCollection.insertOne(doc);
    doc._id = result.insertedId;
  } catch (error) {
    if (error?.code === 11000) {
      // Retry a durable outcome that was inserted by an earlier attempt but
      // not yet applied to this model's persisted weights.
      const existing = await runtime.outcomesCollection.findOne({ tradeId: String(trade.tradeId) });
      if (existing && existing.applied !== true) await applyOutcome(runtime, existing);
      return false;
    }
    throw error;
  }
  await applyOutcome(runtime, doc);
  return true;
}

async function learnClosedTrade(trade) {
  if (!dbRef) throw new Error("NINE_AI_MODELS_NOT_INITIALIZED");
  if (!trade || !trade.closed || !trade.tradeId || !trade.features ||
      !["LONG", "SHORT"].includes(trade.side) || !finite(trade.realizedR)) {
    throw new Error("CLOSED_TRADE_LABEL_REQUIRED");
  }
  const results = [];
  for (const config of MODEL_CONFIGS) {
    const runtime = runtimes.get(config.id);
    results.push(await recordForModel(runtime, trade));
  }
  return { updated: results.some(Boolean), updatedModels: results.filter(Boolean).length,
    models: predictAll(trade.features) };
}

async function initialize(db, legacyOutcomesCollection = null) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_MONGODB_REQUIRED");
  dbRef = db;
  runtimes.clear();

  for (const config of MODEL_CONFIGS) {
    const runtime = {
      config,
      stateCollection: db.collection(`nine_ai_ml_${config.id}_state`),
      outcomesCollection: db.collection(`nine_ai_ml_${config.id}_outcomes`),
      state: fresh(config)
    };
    await runtime.outcomesCollection.createIndex(
      { tradeId: 1 }, { unique: true, name: `uniq_nine_ai_ml_${config.id}_trade` }
    );
    const stored = await runtime.stateCollection.findOne({ _id: "model" });
    runtime.state = validState(stored, config) ? upgradeState(stored, config) : fresh(config);
    if (!stored || !validState(stored, config) || stored.version !== runtime.state.version) {
      await persistState(runtime, runtime.state);
    }
    runtimes.set(config.id, runtime);

    // Bounded recovery prevents a large historical backlog from being loaded at once.
    while (true) {
      const pending = await runtime.outcomesCollection.find({ applied: { $ne: true } })
        .sort({ closedAt: 1 }).limit(100).toArray();
      if (!pending.length) break;
      for (const outcome of pending) await applyOutcome(runtime, outcome);
    }
  }

  // Warm-start the nine separate models from legacy confirmed closed-trade
  // records. Each model receives its own copy in its own outcome ledger.
  let migrated = 0;
  if (legacyOutcomesCollection) {
    while (true) {
      const legacy = await legacyOutcomesCollection.find({
        closed: true, independentModelsMigrated: { $ne: true }
      }).sort({ closedAt: 1 }).limit(100).toArray();
      if (!legacy.length) break;
      for (const outcome of legacy) {
        if (!outcome.tradeId || !outcome.features || !["LONG", "SHORT"].includes(outcome.side) ||
            !finite(outcome.realizedR)) {
          await legacyOutcomesCollection.updateOne({ _id: outcome._id }, { $set: { independentModelsMigrated: true } });
          continue;
        }
      for (const config of MODEL_CONFIGS) {
        await recordForModel(runtimes.get(config.id), {
          tradeId: String(outcome.tradeId), features: outcome.features,
          side: outcome.side, realizedR: Number(outcome.realizedR), closed: true,
          closedAt: outcome.closedAt
        });
      }
      await legacyOutcomesCollection.updateOne(
        { _id: outcome._id },
        { $set: { independentModelsMigrated: true } }
      );
        migrated++;
      }
    }
  }

  return {
    models: predictAll({}),
    migratedLegacyTrades: migrated,
    allTrained: MODEL_CONFIGS.every(config => runtimes.get(config.id).state.samples > 0)
  };
}

function status() {
  return MODEL_CONFIGS.map(config => {
    const runtime = runtimes.get(config.id);
    return predictOne(config, runtime?.state || fresh(config), {});
  });
}

module.exports = {
  MODEL_CONFIGS, MIN_TRAINING_SAMPLES, fresh, validState, upgradeState, vector,
  predictAll, learnClosedTrade, initialize, status
};
