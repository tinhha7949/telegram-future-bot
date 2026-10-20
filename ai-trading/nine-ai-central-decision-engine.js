"use strict";

// The single authorization boundary for live Nine-AI signals.
// This module never creates a direction: it can only preserve a valid
// Nine-AI decision or convert it to WAIT. Research policies are not consulted.
const REQUIRED_ROLES = Object.freeze([
  "Technical Analyst AI",
  "ML Signal AI",
  "Learning & Memory AI",
  "Bull AI",
  "Bear AI",
  "Contrarian AI",
  "Analyst AI",
  "Decision AI",
  "Risk Manager AI"
]);
const MIN_CANDLES = 541;
const MAX_SIGNAL_AGE_MS = 4 * 60 * 60 * 1000;
const MIN_RR = 0; // Edge-based policy owns trade selection; no extra RR gate.

function wait(decision, reason) {
  return {
    ...(decision && typeof decision === "object" ? decision : {}),
    side: null,
    action: "WAIT",
    authorizedForExecution: false,
    reason,
    centralDecisionEngine: {
      version: 1,
      authority: "NINE_AI_ONLY",
      result: "ABSTAIN",
      reason
    }
  };
}

function finalizeDecision(decision, { symbol, scannedAt = Date.now() } = {}) {
  if (!decision || typeof decision !== "object") return wait({}, "NO_NINE_AI_DECISION");
  const side = String(decision.side || "").toUpperCase();
  if (decision.authorizedForExecution !== true || !["LONG", "SHORT"].includes(side)) {
    return wait(decision, decision.reason || "NINE_AI_CHOSE_WAIT");
  }
  if (decision.setup !== "NINE_AI_4H") return wait(decision, "NON_CANONICAL_NINE_AI_SETUP_REJECTED");
  // The canonical pipeline exposes exactly eight specialist outputs plus one
  // meta decision. Legacy role-based outputs are not accepted on the live path.
  if (!decision.agents || !decision.regime || !decision.edges) {
    return wait(decision, "CANONICAL_AGENT_OUTPUT_INCOMPLETE");
  }
  if (symbol && String(decision.symbol || "").toUpperCase() !== String(symbol).toUpperCase()) {
    return wait(decision, "DECISION_SYMBOL_MISMATCH");
  }
  if (!["UPTREND", "DOWNTREND"].includes(String(decision.regime?.regime || "").toUpperCase())) {
    return wait(decision, "REGIME_NOT_TREND");
  }
  if (decision.agents.flow?.confirmation === "BLOCKED_HOT_FUNDING" ||
      decision.agents.flow?.confirmation === "UNAVAILABLE" ||
      decision.agents.flow?.confirmation !== "CONFIRMED" ||
      decision.agents.flow?.confirmationSide !== side) {
    return wait(decision, "FLOW_CONFIRMATION_BLOCKED_OR_MISMATCHED");
  }
  const longEdge = Number(decision.edges?.LONG?.edge);
  const shortEdge = Number(decision.edges?.SHORT?.edge);
  const minEdge = Number(decision.decisionPolicy?.minEdge);
  const gapEdge = Number(decision.decisionPolicy?.gapEdge);
  if (![longEdge, shortEdge, minEdge, gapEdge].every(Number.isFinite) ||
      minEdge < 0 || gapEdge < 0 ||
      (side === "LONG" && !(longEdge > minEdge && longEdge - shortEdge > gapEdge)) ||
      (side === "SHORT" && !(shortEdge > minEdge && shortEdge - longEdge > gapEdge))) {
    return wait(decision, "META_EDGE_POLICY_NOT_SATISFIED");
  }
  const candleCount = Number(decision.candles);
  if (!Number.isFinite(candleCount) || candleCount < MIN_CANDLES) {
    return wait(decision, "INSUFFICIENT_CLOSED_CANDLES");
  }
  const entry = Number(decision.entry ?? decision.price);
  const sl = Number(decision.sl);
  const tp = Number(decision.tp2 ?? decision.tp);
  const tp1 = Number(decision.tp1);
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (![entry, sl, tp, tp1, rr].every(Number.isFinite) || entry <= 0 || sl <= 0 || tp <= 0 || tp1 <= 0 ||
      entry === sl || rr < MIN_RR ||
      (side === "LONG" && !(sl < entry && entry < tp1 && tp1 < tp)) ||
      (side === "SHORT" && !(tp < tp1 && tp1 < entry && entry < sl))) {
    return wait(decision, "CENTRAL_ENGINE_INVALID_TRADE_GEOMETRY");
  }
  const signalAt = Number(decision.signalAt);
  if (!Number.isFinite(signalAt) || signalAt > Number(scannedAt) + 60_000 ||
      Number(scannedAt) - signalAt > MAX_SIGNAL_AGE_MS) {
    return wait(decision, "STALE_OR_INVALID_SIGNAL_TIMESTAMP");
  }
  return {
    ...decision,
    symbol: String(symbol || decision.symbol).toUpperCase(),
    side,
    action: side,
    authorizedForExecution: true,
    centralDecisionEngine: {
      version: 1,
      authority: "NINE_AI_ONLY",
      result: "AUTHORIZED",
      reason: "NINE_AI_DECISION_PASSED_INVARIANTS",
      validatedAt: new Date(Number(scannedAt)).toISOString(),
      roleCount: REQUIRED_ROLES.length,
      rr: Number(rr.toFixed(4))
    }
  };
}

module.exports = { REQUIRED_ROLES, MIN_CANDLES, MAX_SIGNAL_AGE_MS, MIN_RR, finalizeDecision };
