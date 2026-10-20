"use strict";
const assert = require("node:assert/strict");
const engine = require("./nine-ai-central-decision-engine");
const now = Date.now();
function base(overrides = {}) {
  return {
    setup: "NINE_AI_4H", symbol: "BTCUSDT", side: "LONG", action: "LONG",
    authorizedForExecution: true, candles: 100, signalAt: now - 1000,
    entry: 100, price: 100, sl: 99, tp1: 101, tp2: 102, tp: 102,
    edge: 0.5, edges: { long: 0.5, short: 0.1 }, riskFraction: 0.0075,
    roles: engine.REQUIRED_ROLES.map(name => ({ name, output: {} })),
    ...overrides
  };
}
const valid = engine.finalizeDecision(base(), { symbol: "BTCUSDT", scannedAt: now });
assert.equal(valid.authorizedForExecution, true);
assert.equal(valid.action, "LONG");
assert.equal(valid.centralDecisionEngine.authority, "NINE_AI_ONLY");

for (const [overrides, reason] of [
  [{ setup: "NINE_AI_15M" }, "NON_NINE_AI_SETUP_REJECTED"],
  [{ riskFraction: 0.05 }, "RISK_FRACTION_MUST_BE_0_75_PERCENT"],
  [{ candles: 20 }, "INSUFFICIENT_CLOSED_CANDLES"],
  [{ roles: [] }, "NINE_AI_REQUIRED_ROLE_MISSING"],
  [{ edge: 0.05, edges: { long: 0.05, short: 0 } }, "NET_EDGE_BELOW_MINIMUM"],
  [{ edge: 0.2, edges: { long: 0.2, short: 0.1 } }, "DIRECTIONAL_EDGE_GAP_TOO_SMALL"],
  [{ sl: 101 }, "CENTRAL_ENGINE_INVALID_TRADE_GEOMETRY"],
  [{ signalAt: now - 60 * 60 * 1000 }, "STALE_OR_INVALID_CLOSED_CANDLE_SIGNAL"]
]) {
  const denied = engine.finalizeDecision(base(overrides), { symbol: "BTCUSDT", scannedAt: now });
  assert.equal(denied.action, "WAIT", reason);
  assert.equal(denied.authorizedForExecution, false);
  assert.equal(denied.reason, reason);
}
console.log("Nine-AI central decision engine tests passed");
