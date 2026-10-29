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
  const priorAuthorization = decision.centralDecisionEngine;
  if (priorAuthorization?.authority === "NINE_AI_ONLY" &&
      priorAuthorization?.result === "AUTHORIZED" &&
      (String(priorAuthorization.symbol || "").toUpperCase() !==
        String(decision.symbol || "").toUpperCase() ||
       String(priorAuthorization.side || "").toUpperCase() !== side ||
       Number(priorAuthorization.signalAt) !== Number(decision.signalAt) ||
       priorAuthorization.decisionSchemaVersion !== decision.decisionSchemaVersion))
    return wait(decision, "CENTRAL_AUTHORIZATION_BINDING_MISMATCH");
  if (decision.setup !== "NINE_AI_4H")
    return wait(decision, "NON_CANONICAL_NINE_AI_SETUP_REJECTED");
  if (decision.decisionSchemaVersion !== DECISION_SCHEMA_VERSION)
    return wait(decision, "LEGACY_DECISION_REJECTED");
  // The canonical pipeline exposes exactly eight specialist outputs plus one
  // meta decision. Legacy role-based outputs are not accepted on the live path.
  if (!decision.agents || !decision.regime || !decision.edges) {
    return wait(decision, "CANONICAL_AGENT_OUTPUT_INCOMPLETE");
  }
  const requiredOutputs = [
    "regime", "structure", "probability", "expectedReturn", "confidence",
    "riskGuardian", "slTp", "execution", "decision",
  ];
  if (requiredOutputs.some((name) =>
    !decision.agents[name] || typeof decision.agents[name] !== "object"
  )) return wait(decision, "CANONICAL_AGENT_OUTPUT_INCOMPLETE");
  const guardian = decision.agents.riskGuardian;
  if (guardian.vetoed !== false || guardian.status !== "PASS" ||
      guardian.fundingHot === true ||
      !Number.isFinite(guardian.fundingRate) ||
      !Number.isFinite(guardian.spreadPct) || guardian.spreadPct < 0 ||
      !Number.isFinite(guardian.maxSpreadPct) ||
      guardian.spreadPct > guardian.maxSpreadPct ||
      !Number.isFinite(guardian.snapshotAgeMs) ||
      guardian.snapshotAgeMs < 0 || guardian.snapshotAgeMs > BAR_MS ||
      !Number.isFinite(guardian.openInterestChange) ||
      !Number.isFinite(guardian.depthNotional) || guardian.depthNotional <= 0 ||
      !Number.isFinite(guardian.latencyMs) || guardian.latencyMs < 0)
    return wait(decision, "AI6_RISK_GUARDIAN_VETO");
  if (String(decision.agents.decision.side || "").toUpperCase() !== side ||
      decision.agents.decision.authorizedForExecution !== true ||
      Number(decision.agents.decision.minEdge) !== Number(decision.decisionPolicy?.minEdge) ||
      Number(decision.agents.decision.gapEdge) !== Number(decision.decisionPolicy?.gapEdge))
    return wait(decision, "AI9_DECISION_OUTPUT_MISMATCH");
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
  if (!Number.isFinite(decision.regime.regime_conf) ||
      !Number.isFinite(decision.agents.confidence.confidenceScore) ||
      Math.abs(decision.regime.regime_conf - decision.agents.confidence.confidenceScore) > 1e-12)
    return wait(decision, "AI5_CONFIDENCE_OUTPUT_MISMATCH");
  const execution = decision.agents.execution;
  if (!Number.isFinite(execution.estimatedSlippagePct) ||
      execution.estimatedSlippagePct < 0 ||
      !Number.isFinite(decision.featureSnapshot?.estSlippagePct) ||
      Math.abs(execution.estimatedSlippagePct - decision.featureSnapshot.estSlippagePct) > 1e-12 ||
      execution.entryOrderType !== "MARKET" ||
      execution.stopOrderType !== "STOP_MARKET" ||
      execution.takeProfitOrderType !== "TAKE_PROFIT_MARKET")
    return wait(decision, "AI8_EXECUTION_OUTPUT_MISMATCH");
  const selectedPlan = decision.agents.slTp.planBySide?.[side];
  const tpBatchTotal = CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1];
  const expectedTp1Percent = CONFIG.TP_BATCHES[0] / tpBatchTotal * 100;
  const expectedTp2Percent = CONFIG.TP_BATCHES[1] / tpBatchTotal * 100;
  if (!selectedPlan ||
      Number(selectedPlan.entry) !== Number(decision.entry) ||
      Number(selectedPlan.sl) !== Number(decision.sl) ||
      Number(selectedPlan.tp1) !== Number(decision.tp1) ||
      Number(selectedPlan.tp2) !== Number(decision.tp2) ||
      Number(decision.agents.slTp.timeoutCandles) !== CONFIG.TIMEOUT_BARS ||
      Math.abs(Number(decision.agents.slTp.closePercentAtTP1) - expectedTp1Percent) > 1e-9 ||
      Math.abs(Number(decision.agents.slTp.closePercentAtTP2) - expectedTp2Percent) > 1e-9)
    return wait(decision, "AI7_SLTP_OUTPUT_MISMATCH");
  for (const direction of ["LONG", "SHORT"]) {
    const edge = decision.edges[direction];
    const penalty = decision.agents.confidence.uncertaintyPenaltyBySide?.[direction];
    if (!edge || typeof edge.p !== "number" || !Number.isFinite(edge.p) ||
        typeof edge.expectedR !== "number" || !Number.isFinite(edge.expectedR) ||
        typeof edge.cost !== "number" || !Number.isFinite(edge.cost) ||
        Number(decision.agents.probability[direction]) !== edge.p ||
        Number(decision.agents.expectedReturn[direction]) !== edge.expectedR ||
        !Number.isFinite(penalty) || Math.abs(penalty - Number(edge.baseUncertainty)) > 1e-12 ||
        !Number.isFinite(execution.costRBySide?.[direction]) ||
        Math.abs(execution.costRBySide[direction] - edge.cost) > 1e-12)
      return wait(decision, "AI3_AI4_AI5_AI8_OUTPUT_MISMATCH");
  }
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
  return {
    ...decision,
    edges: meta.edges,
    symbol: String(symbol || decision.symbol).toUpperCase(),
    side,
    action: side,
    authorizedForExecution: true,
    centralDecisionEngine: {
      version: 1,
      authority: "NINE_AI_ONLY",
      result: "AUTHORIZED",
      symbol: String(symbol || decision.symbol).toUpperCase(),
      side,
      signalAt,
      decisionSchemaVersion: decision.decisionSchemaVersion,
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
