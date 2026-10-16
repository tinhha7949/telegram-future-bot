"use strict";

// Local, dependency-free online logistic learner and durable trade-outcome memory.
// Labels are only accepted for closed trades with finite, non-zero risk-normalized outcomes.
const fs = require("fs");
const path = require("path");
const DEFAULT_FILE = path.join(process.env.NINE_AI_DATA_DIR || path.join(process.cwd(), "data"), "nine-ai-learning.json");
const FEATURES = ["trend", "momentum", "rsi", "volume", "extension"];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function fresh() { return { version: 1, samples: 0, weights: [0, 0.35, 0.25, 0.15, 0.1, -0.1], bias: 0, recent: [], updatedAt: null }; }
function read(file = DEFAULT_FILE) {
  try {
    const x = JSON.parse(fs.readFileSync(file, "utf8"));
    if (x.version === 1 && Array.isArray(x.weights) && x.weights.length === 6 && Array.isArray(x.recent)) return x;
  } catch (_) {}
  return fresh();
}
function writeAtomic(state, file = DEFAULT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function vector(f) {
  return [1, clamp(Number(f.trend) || 0, -1, 1), clamp(Number(f.momentum) || 0, -3, 3),
    clamp(((Number(f.rsi) || 50) - 50) / 30, -2, 2), clamp((Number(f.volume) || 1) - 1, -2, 3),
    clamp(Number(f.extension) || 0, -3, 3)];
}
function predict(features, state = read()) {
  const x = vector(features);
  const z = clamp(x.reduce((s, v, i) => s + v * state.weights[i], state.bias), -12, 12);
  const pLong = 1 / (1 + Math.exp(-z));
  return { pLong, samples: state.samples, trained: state.samples >= 20,
    side: state.samples < 20 ? null : pLong >= 0.58 ? "LONG" : pLong <= 0.42 ? "SHORT" : null };
}
// One SGD update for a fully closed trade. Outcome is net realized PnL / initial risk.
// Never train on open/unresolved trades or duplicate trade IDs.
function learnClosedTrade({ tradeId, features, side, realizedR, closed }, file = DEFAULT_FILE) {
  if (!closed || !tradeId || !features || !["LONG", "SHORT"].includes(side) ||
      !Number.isFinite(realizedR) || !Number.isFinite(Number(realizedR))) throw new Error("CLOSED_TRADE_LABEL_REQUIRED");
  const state = read(file);
  if (state.recent.some(t => t.tradeId === String(tradeId))) return { updated: false, reason: "DUPLICATE_TRADE" };
  const x = vector(features), y = (side === "LONG" ? 1 : 0);
  const reward = clamp(Number(realizedR), -5, 5);
  // Down-weight tiny/noisy outcomes; direction label comes from realized result, not planned side.
  const label = reward > 0 ? y : reward < 0 ? 1 - y : 0.5;
  const z = clamp(x.reduce((s, v, i) => s + v * state.weights[i], state.bias), -12, 12);
  const p = 1 / (1 + Math.exp(-z));
  const lr = 0.025 / Math.sqrt(1 + state.samples / 100);
  const error = clamp(label - p, -1, 1);
  for (let i = 0; i < state.weights.length; i++) state.weights[i] = clamp(state.weights[i] + lr * error * x[i], -4, 4);
  state.bias = clamp(state.bias + lr * error, -4, 4);
  state.samples++;
  state.recent.push({ tradeId: String(tradeId), realizedR: reward, side, closedAt: Date.now() });
  state.recent = state.recent.slice(-500);
  state.updatedAt = new Date().toISOString();
  writeAtomic(state, file);
  return { updated: true, samples: state.samples };
}
function rememberDecision(entry, file = DEFAULT_FILE) {
  if (!entry || !entry.id || !entry.features || !["LONG", "SHORT", "WAIT"].includes(entry.action)) throw new Error("INVALID_DECISION_MEMORY");
  const state = read(file);
  state.recent.push({ tradeId: String(entry.id), action: entry.action, features: entry.features, rememberedAt: Date.now(), pendingOutcome: true });
  state.recent = state.recent.slice(-500);
  writeAtomic(state, file);
  return state.recent.length;
}
module.exports = { DEFAULT_FILE, fresh, read, writeAtomic, vector, predict, learnClosedTrade, rememberDecision };
