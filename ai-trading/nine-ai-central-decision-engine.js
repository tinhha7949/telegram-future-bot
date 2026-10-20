"use strict";

const REQUIRED_ROLES = Object.freeze([
  "Regime", "Structure", "Continuation", "Breakout", "Mean Rev",
  "Flow", "Outcome", "Fill/Slippage", "Meta/Decision"
]);
const MIN_CANDLES = 90;
const MAX_SIGNAL_AGE_MS = 5 * 60 * 1000;
const RISK_FRACTION = 0.0075;
const MIN_EDGE_R = 0.10;
const MIN_GAP_EDGE_R = 0.15;

function wait(decision, reason) {
  return {
    ...(decision && typeof decision === "object" ? decision : {}),
    side: null, action: "WAIT", authorizedForExecution: false, reason,
    centralDecisionEngine: { version: 2, authority: "NINE_AI_ONLY", result: "ABSTAIN", reason }
  };
}
function finalizeDecision(decision, { symbol, scannedAt = Date.now() } = {}) {
  if (!decision || typeof decision !== "object") return wait({}, "NO_NINE_AI_DECISION");
  const side = String(decision.side || "").toUpperCase();
  if (decision.authorizedForExecution !== true || !["LONG", "SHORT"].includes(side)) {
    return wait(decision, decision.reason || "NINE_AI_CHOSE_WAIT");
  }
  if (decision.setup !== "NINE_AI_4H") return wait(decision, "NON_NINE_AI_SETUP_REJECTED");
  if (symbol && String(decision.symbol || "").toUpperCase() !== String(symbol).toUpperCase()) {
    return wait(decision, "DECISION_SYMBOL_MISMATCH");
  }
  if (!Array.isArray(decision.roles)) return wait(decision, "NINE_AI_ROLE_OUTPUT_MISSING");
  const roleNames = new Set(decision.roles.map(role => String(role?.name || "")));
  if (REQUIRED_ROLES.some(name => !roleNames.has(name))) return wait(decision, "NINE_AI_REQUIRED_ROLE_MISSING");
  const candleCount = Number(decision.candles);
  if (!Number.isFinite(candleCount) || candleCount < MIN_CANDLES) return wait(decision, "INSUFFICIENT_CLOSED_CANDLES");
  const entry = Number(decision.entry ?? decision.price);
  const sl = Number(decision.sl);
  const tp1 = Number(decision.tp1);
  const tp2 = Number(decision.tp2 ?? decision.tp);
  const signalAt = Number(decision.signalAt);
  const edge = Number(decision.edge);
  const longEdge = Number(decision.edges?.long);
  const shortEdge = Number(decision.edges?.short);
  const riskFraction = Number(decision.riskFraction);
  if (![entry, sl, tp1, tp2, signalAt, edge, riskFraction].every(Number.isFinite) ||
      entry <= 0 || sl <= 0 || tp1 <= 0 || tp2 <= 0 || entry === sl ||
      (side === "LONG" ? !(sl < entry && tp1 > entry && tp2 >= tp1) : !(sl > entry && tp1 < entry && tp2 <= tp1))) {
    return wait(decision, "CENTRAL_ENGINE_INVALID_TRADE_GEOMETRY");
  }
  if (Math.abs(Number(scannedAt) - signalAt) > MAX_SIGNAL_AGE_MS || signalAt > Number(scannedAt) + 1000) {
    return wait(decision, "STALE_OR_INVALID_CLOSED_CANDLE_SIGNAL");
  }
  if (riskFraction !== RISK_FRACTION) return wait(decision, "RISK_FRACTION_MUST_BE_0_75_PERCENT");
  if (!(edge > MIN_EDGE_R)) return wait(decision, "NET_EDGE_BELOW_MINIMUM");
  if (side === "LONG" && !(edge - shortEdge > MIN_GAP_EDGE_R)) return wait(decision, "DIRECTIONAL_EDGE_GAP_TOO_SMALL");
  if (side === "SHORT" && !(edge - longEdge > MIN_GAP_EDGE_R)) return wait(decision, "DIRECTIONAL_EDGE_GAP_TOO_SMALL");
  return {
    ...decision,
    symbol: String(symbol || decision.symbol).toUpperCase(),
    side, action: side, authorizedForExecution: true,
    tp: tp2, tp2,
    centralDecisionEngine: {
      version: 2, authority: "NINE_AI_ONLY", result: "AUTHORIZED",
      reason: "NINE_AI_NET_EDGE_AND_RISK_INVARIANTS_PASSED",
      validatedAt: new Date(Number(scannedAt)).toISOString(),
      roleCount: REQUIRED_ROLES.length, riskFraction: RISK_FRACTION,
      edge: Number(edge.toFixed(6)), edgeGap: Number((edge - (side === "LONG" ? shortEdge : longEdge)).toFixed(6))
    }
  };
}
module.exports = {
  REQUIRED_ROLES, MIN_CANDLES, MAX_SIGNAL_AGE_MS, RISK_FRACTION,
  MIN_EDGE_R, MIN_GAP_EDGE_R, finalizeDecision
};
