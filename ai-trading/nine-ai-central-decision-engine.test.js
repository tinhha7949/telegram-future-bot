"use strict";
const assert = require("node:assert/strict");
const engine = require("./nine-ai-central-decision-engine");
const base = {
  symbol: "BTCUSDT", side: "LONG", action: "LONG", setup: "NINE_AI_4H",
  authorizedForExecution: true, candles: 120, signalAt: 1_000_000,
  entry: 100, sl: 98, tp: 105, tp1: 102, tp2: 105, rr: 2.5,
  regime: { regime: "UPTREND", regime_conf: 0.9 },
  agents: { flow: { confirmation: "CONFIRMED" } },
  edges: { LONG: { edge: 0.4 }, SHORT: { edge: 0.1 } }
};
const valid = engine.finalizeDecision(base, { symbol: "BTCUSDT", scannedAt: 1_000_100 });
assert.equal(valid.authorizedForExecution, true);
assert.equal(valid.side, "LONG");
assert.equal(valid.centralDecisionEngine.authority, "NINE_AI_ONLY");
assert.equal(engine.finalizeDecision({ ...base, symbol: "ETHUSDT" },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).side, null);
assert.equal(engine.finalizeDecision({ ...base, agents: null },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).reason, "CANONICAL_AGENT_OUTPUT_INCOMPLETE");
assert.equal(engine.finalizeDecision({ ...base, sl: 101 },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).reason, "CENTRAL_ENGINE_INVALID_TRADE_GEOMETRY");
assert.equal(engine.finalizeDecision({ ...base, signalAt: 1 },
  { symbol: "BTCUSDT", scannedAt: 5 * 60 * 60 * 1000 }).reason, "STALE_OR_INVALID_SIGNAL_TIMESTAMP");
assert.equal(engine.finalizeDecision({ ...base, side: "WAIT", authorizedForExecution: false },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).side, null);
assert.equal(engine.finalizeDecision({ ...base, agents: { flow: { confirmation: "BLOCKED_HOT_FUNDING" } } },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).reason, "FLOW_CONFIRMATION_BLOCKED");
console.log("nine-ai-central-decision-engine.test.js: OK");
