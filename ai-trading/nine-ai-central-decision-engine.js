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
const MIN_CANDLES = 60;
const MAX_SIGNAL_AGE_MS = 30 * 60 * 1000;
const MIN_RR = 0.8;

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
  if (decision.setup !== "NINE_AI_15M") return wait(decision, "NON_NINE_AI_SETUP_REJECTED");
  if (symbol && String(decision.symbol || "").toUpperCase() !== String(symbol).toUpperCase()) {
    return wait(decision, "DECISION_SYMBOL_MISMATCH");
  }
  if (!Array.isArray(decision.roles) || decision.roles.length < REQUIRED_ROLES.length) {
    return wait(decision, "NINE_AI_ROLE_OUTPUT_INCOMPLETE");
  }
  const roleNames = new Set(decision.roles.map(role => String(role?.name || "")));
  if (REQUIRED_ROLES.some(name => !roleNames.has(name))) {
    return wait(decision, "NINE_AI_REQUIRED_ROLE_MISSING");
  }
  const candleCount = Number(decision.candles);
  if (!Number.isFinite(candleCount) || candleCount < MIN_CANDLES) {
    return wait(decision, "INSUFFICIENT_CLOSED_CANDLES");
  }
  const entry = Number(decision.entry ?? decision.price);
  const sl = Number(decision.sl);
  const tp = Number(decision.tp);
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (![entry, sl, tp, rr].every(Number.isFinite) || entry <= 0 || sl <= 0 || tp <= 0 ||
      entry === sl || rr < MIN_RR ||
      (side === "LONG" && !(sl < entry && tp > entry)) ||
      (side === "SHORT" && !(tp < entry && sl > entry))) {
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
