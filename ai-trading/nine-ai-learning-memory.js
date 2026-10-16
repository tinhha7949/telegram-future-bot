"use strict";

// Dependency-free online logistic learner. All model state stays on this VPS.
// Only confirmed, closed trades may update weights; no hosted AI/API is used.
const fs = require("fs");
const path = require("path");
const DEFAULT_FILE = path.join(
  process.env.NINE_AI_DATA_DIR || path.join(__dirname, "..", "data"),
  "nine-ai-learning.json"
);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function fresh() {
  return { version: 1, samples: 0, weights: [0, 0.35, 0.25, 0.15, 0.1, -0.1], bias: 0, recent: [], updatedAt: null };
}

function read(file = DEFAULT_FILE) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      state.version === 1 &&
      Number.isInteger(state.samples) && state.samples >= 0 &&
      Array.isArray(state.weights) && state.weights.length === 6 &&
      state.weights.every(Number.isFinite) &&
      Number.isFinite(state.bias) &&
      Array.isArray(state.recent)
    ) return state;
  } catch (_) {}
  return fresh();
}

function writeAtomic(state, file = DEFAULT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
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

function predict(features, state = read()) {
  const x = vector(features);
  const z = clamp(x.reduce((sum, value, i) => sum + value * state.weights[i], state.bias), -12, 12);
  const pLong = 1 / (1 + Math.exp(-z));
  return {
    pLong,
    samples: state.samples,
    trained: state.samples >= 20,
    side: state.samples < 20 ? null : pLong >= 0.58 ? "LONG" : pLong <= 0.42 ? "SHORT" : null
  };
}

// One SGD update per closed trade. realizedR = realized PnL / budgeted monetary risk.
// An open, unresolved, malformed, or already-trained trade is never used twice.
function learnClosedTrade({ tradeId, features, side, realizedR, closed }, file = DEFAULT_FILE) {
  if (
    !closed || !tradeId || !features || !["LONG", "SHORT"].includes(side) ||
    !Number.isFinite(Number(realizedR)) || !Number.isFinite(Number(realizedR))
  ) throw new Error("CLOSED_TRADE_LABEL_REQUIRED");

  const state = read(file);
  const id = String(tradeId);
  if (state.recent.some(item => item.tradeId === id && Number.isFinite(item.realizedR))) {
    return { updated: false, reason: "DUPLICATE_TRADE", samples: state.samples };
  }

  const x = vector(features);
  const reward = clamp(Number(realizedR), -5, 5);
  const sideLabel = side === "LONG" ? 1 : 0;
  // Positive PnL reinforces the traded direction; negative PnL reinforces its opposite.
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
  state.recent = state.recent.filter(item => item.tradeId !== id);
  state.recent.push({
    type: "outcome",
    tradeId: id,
    realizedR: reward,
    side,
    closedAt: Date.now()
  });
  state.recent = state.recent.slice(-500);
  state.updatedAt = new Date().toISOString();
  writeAtomic(state, file);
  return { updated: true, samples: state.samples };
}

function rememberDecision(entry, file = DEFAULT_FILE) {
  if (!entry || !entry.id || !entry.features || !["LONG", "SHORT", "WAIT"].includes(entry.action)) {
    throw new Error("INVALID_DECISION_MEMORY");
  }
  const state = read(file);
  const id = String(entry.id);
  if (state.recent.some(item => item.tradeId === id && item.pendingOutcome)) return state.recent.length;
  state.recent.push({
    type: "decision",
    tradeId: id,
    action: entry.action,
    features: entry.features,
    rememberedAt: Date.now(),
    pendingOutcome: true
  });
  state.recent = state.recent.slice(-500);
  writeAtomic(state, file);
  return state.recent.length;
}

module.exports = { DEFAULT_FILE, fresh, read, writeAtomic, vector, predict, learnClosedTrade, rememberDecision };
