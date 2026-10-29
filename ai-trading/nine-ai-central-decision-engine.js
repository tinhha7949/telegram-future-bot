"use strict";
const { CONFIG } = require("./config");
const {
  applyPolicy,
  uncertaintyFor,
  DECISION_SCHEMA_VERSION,
  BAR_MS,
} = require("./nine-ai-policy");

// The single authorization boundary for live Nine-AI signals.
// This module never creates a direction: it can only preserve a valid
// Nine-AI decision or convert it to WAIT. Research policies are not consulted.
const REQUIRED_ROLES = Object.freeze([
  "AI-1 Regime",
  "AI-2 Structure",
  "AI-3 Probability",
  "AI-4 Expected Return",
  "AI-5 Confidence",
  "AI-6 Risk Guardian",
  "AI-7 SL/TP Optimizer",
  "AI-8 Execution",
  "AI-9 Decision",
]);
// Use the validated, configured history size. HISTORY_FETCH_CANDLES is not
// a config key; referencing it silently disabled this second-line guard.
const MIN_CANDLES = CONFIG.N_CANDLES;

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
      reason,
    },
  };
}

function finalizeDecision(decision, { symbol, scannedAt = Date.now() } = {}) {
  if (!decision || typeof decision !== "object")
    return wait({}, "NO_NINE_AI_DECISION");
  const side = String(decision.side || "").toUpperCase();
  if (
    decision.authorizedForExecution !== true ||
    !["LONG", "SHORT"].includes(side)
  ) {
    return wait(decision, decision.reason || "NINE_AI_CHOSE_WAIT");
  }
  if (String(decision.action || "").toUpperCase() !== side)
    return wait(decision, "AI9_ACTION_SIDE_MISMATCH");
  if (decision.setup !== "NINE_AI_4H")
    return wait(decision, "NON_CANONICAL_NINE_AI_SETUP_REJECTED");
  if (decision.decisionSchemaVersion !== DECISION_SCHEMA_VERSION)
    return wait(decision, "LEGACY_DECISION_REJECTED");
  // The canonical pipeline exposes exactly eight specialist outputs plus one
  // meta decision. Legacy role-based outputs are not accepted on the live path.
  if (!decision.agents || !decision.regime || !decision.edges) {
    return wait(decision, "CANONICAL_AGENT_OUTPUT_INCOMPLETE");
  }
  if (
    symbol &&
    String(decision.symbol || "").toUpperCase() !== String(symbol).toUpperCase()
  ) {
    return wait(decision, "DECISION_SYMBOL_MISMATCH");
  }
  if (
    !["UPTREND", "DOWNTREND"].includes(
      String(decision.regime?.regime || "").toUpperCase(),
    )
  ) {
    return wait(decision, "REGIME_NOT_TREND");
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
  if (
    ![entry, sl, tp, tp1, rr].every(Number.isFinite) ||
    entry <= 0 ||
    sl <= 0 ||
    tp <= 0 ||
    tp1 <= 0 ||
    entry === sl ||
    Math.abs(tp1 - entry) + Number.EPSILON * Math.max(entry, tp1) < CONFIG.MIN_RR * Math.abs(entry - sl) ||
    (side === "LONG" && !(sl < entry && entry < tp1 && tp1 <= tp)) ||
    (side === "SHORT" && !(tp <= tp1 && tp1 < entry && entry < sl))
  ) {
    return wait(decision, "CENTRAL_ENGINE_INVALID_TRADE_GEOMETRY");
  }
  const signalAt = Number(decision.signalAt);
  const snapshotAt = Number(decision.featureSnapshot?.snapshotAt);
  if (!Number.isFinite(signalAt) || signalAt >= Number(scannedAt)) {
    return wait(decision, "STALE_OR_INVALID_SIGNAL_TIMESTAMP");
  }
  if (!Number.isFinite(snapshotAt) || snapshotAt > scannedAt || Number(scannedAt) - signalAt > BAR_MS || Number(scannedAt) - snapshotAt > BAR_MS) {
    return wait(decision, "STALE_OR_INVALID_EXECUTION_SNAPSHOT");
  }
  if (!decision.decisionPolicy) return wait(decision, "MISSING_META_POLICY");
  const timed = {
    ...decision,
    edges: Object.fromEntries(
      Object.entries(decision.edges).map(([side, c]) => [
        side,
        {
          ...c,
          baseUncertainty: uncertaintyFor(
            decision.regime,
            snapshotAt,
            signalAt,
            Number(scannedAt),
            decision.decisionPolicy,
            decision.featureSnapshot,
          ) + Math.max(0, Number(c.moduleUncertaintyPenalty) || 0),
        },
      ]),
    ),
  };
  const meta = applyPolicy(timed, decision.decisionPolicy);
  if (meta.side !== side)
    return wait(decision, "META_EDGE_POLICY_NOT_SATISFIED");
  const normalizedAgents = {
    ...decision.agents,
    probability: decision.agents.probability || {
      pLong: decision.edges.LONG?.p ?? null,
      pShort: decision.edges.SHORT?.p ?? null,
      sourceBySide: {
        LONG: decision.edges.LONG?.probabilitySource || "CACHED_DIRECTIONAL_ESTIMATE",
        SHORT: decision.edges.SHORT?.probabilitySource || "CACHED_DIRECTIONAL_ESTIMATE",
      },
    },
    expectedReturn: decision.agents.expectedReturn || {
      eRLong: decision.edges.LONG?.expectedR ?? null,
      eRShort: decision.edges.SHORT?.expectedR ?? null,
      unit: "R",
      sourceBySide: {
        LONG: decision.edges.LONG?.expectedRSource || "CACHED_DIRECTIONAL_ESTIMATE",
        SHORT: decision.edges.SHORT?.expectedRSource || "CACHED_DIRECTIONAL_ESTIMATE",
      },
    },
    confidence: decision.agents.confidence || {
      score: decision.regime.regime_conf,
      uncertaintyPenalty: Math.max(
        Number(meta.edges.LONG?.uncertaintyPenalty) || 0,
        Number(meta.edges.SHORT?.uncertaintyPenalty) || 0,
      ),
      dataQuality: "VALIDATED_CACHED_SNAPSHOT",
    },
    riskGuardian: decision.agents.riskGuardian || {
      marketVeto: "PASSED",
      balanceVeto: "REQUIRED_BEFORE_BROKER",
    },
  };
  return {
    ...decision,
    agents: normalizedAgents,
    edges: meta.edges,
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
      rr: Number(rr.toFixed(4)),
    },
  };
}

module.exports = {
  REQUIRED_ROLES,
  MIN_CANDLES,
  finalizeDecision,
};
