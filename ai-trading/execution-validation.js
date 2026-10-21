"use strict";
const { finalizeDecision } = require("./nine-ai-central-decision-engine");
const {
  applyPolicy,
  uncertaintyFor,
  fundingIsHot,
} = require("./nine-ai-policy");
function validateExecution(decision, market, now = Date.now()) {
  const approved = finalizeDecision(decision, {
    symbol: decision?.symbol,
    scannedAt: now,
  });
  if (!approved.authorizedForExecution)
    return { ok: false, reason: approved.reason };
  const values = [
    market?.snapshotAt,
    market?.fundingRate,
    market?.openInterestChange,
    market?.spreadPct,
    market?.depthNotional,
    market?.latencyMs,
    market?.roundTripFeePct,
    market?.expectedFundingCostPctBySide?.LONG,
    market?.expectedFundingCostPctBySide?.SHORT,
    market?.markPrice,
  ];
  if (
    !values.every((v) => typeof v === "number" && Number.isFinite(v)) ||
    market.snapshotAt > now ||
    market.depthNotional <= 0 ||
    market.spreadPct < 0 ||
    market.latencyMs < 0 ||
    market.roundTripFeePct < 0 ||
    Object.values(market.expectedFundingCostPctBySide).some((v) => v < 0) ||
    market.markPrice <= 0
  )
    return { ok: false, reason: "EXECUTION_INPUTS_UNAVAILABLE" };
  if (fundingIsHot(market.fundingRate))
    return { ok: false, reason: "CURRENT_FLOW_BLOCKED" };
  const slippage = Math.min(
    2,
    market.spreadPct +
      0.04 / Math.max(market.depthNotional / 100000, 0.1) +
      Math.max(0, market.latencyMs - 100) * 0.00002 +
      Math.abs(market.openInterestChange) * 0.02,
  );
  const refreshed = structuredClone(decision);
  for (const side of ["LONG", "SHORT"]) {
    const c = refreshed.edges[side];
    const riskPct = c.plan
      ? (Math.abs(c.plan.entry - c.plan.sl) / c.plan.entry) * 100
      : null;
    c.cost = c.plan
      ? (market.roundTripFeePct +
          market.expectedFundingCostPctBySide[side] +
          slippage) /
        riskPct
      : 0;
    c.baseUncertainty = uncertaintyFor(
      decision.regime,
      Math.min(decision.featureSnapshot.snapshotAt, market.snapshotAt),
      decision.signalAt,
      now,
      decision.decisionPolicy,
      decision.featureSnapshot,
    );
  }
  if (applyPolicy(refreshed, decision.decisionPolicy).side !== decision.side)
    return { ok: false, reason: "CURRENT_COST_OR_UNCERTAINTY_BLOCKED" };
  // Requote safety: a current mark outside the researched stop/first target is no longer the same entry.
  if (
    decision.side === "LONG"
      ? !(decision.sl < market.markPrice && market.markPrice < decision.tp1)
      : !(decision.tp1 < market.markPrice && market.markPrice < decision.sl)
  )
    return { ok: false, reason: "ENTRY_PLAN_ALREADY_CROSSED" };
  return {
    ok: true,
    reason: "EXECUTION_REVALIDATED",
    validatedAt: now,
    marketSnapshot: market,
    estSlippagePct: slippage,
  };
}
module.exports = { validateExecution };
