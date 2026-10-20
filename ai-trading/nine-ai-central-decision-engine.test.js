"use strict";
const assert = require("node:assert/strict");
const engine = require("./nine-ai-central-decision-engine");

const roles = engine.REQUIRED_ROLES.map(name => ({ name, side: "LONG", confidence: 75 }));
const base = {
  symbol: "BTCUSDT", side: "LONG", action: "LONG", setup: "NINE_AI_15M",
  authorizedForExecution: true, candles: 96, signalAt: 1_000_000,
  entry: 100, sl: 98, tp: 104, rr: 2, roles
};
const valid = engine.finalizeDecision(base, { symbol: "BTCUSDT", scannedAt: 1_000_100 });
assert.equal(valid.authorizedForExecution, true);
assert.equal(valid.side, "LONG");
assert.equal(valid.centralDecisionEngine.authority, "NINE_AI_ONLY");

assert.equal(engine.finalizeDecision({ ...base, symbol: "ETHUSDT" },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).side, null);
assert.equal(engine.finalizeDecision({ ...base, roles: roles.slice(0, 8) },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).reason, "NINE_AI_ROLE_OUTPUT_INCOMPLETE");
assert.equal(engine.finalizeDecision({ ...base, sl: 101 },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).reason, "CENTRAL_ENGINE_INVALID_TRADE_GEOMETRY");
assert.equal(engine.finalizeDecision({ ...base, signalAt: 1 },
  { symbol: "BTCUSDT", scannedAt: 40 * 60 * 1000 }).reason, "STALE_OR_INVALID_SIGNAL_TIMESTAMP");
assert.equal(engine.finalizeDecision({ ...base, side: "WAIT", authorizedForExecution: false },
  { symbol: "BTCUSDT", scannedAt: 1_000_100 }).side, null);
console.log("nine-ai-central-decision-engine.test.js: OK");
