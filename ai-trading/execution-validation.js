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
    market?.liquidationImbalance,
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
    market.markPrice <= 0
  )
    return { ok: false, reason: "EXECUTION_INPUTS_UNAVAILABLE" };
  if (fundingIsHot(market.fundingRate))
    return { ok: false, reason: "CURRENT_FLOW_BLOCKED" };
  // The fresh market reading must still corroborate the same side.
  // Missing/neutral/opposing liquidation makes execution uncertain => WAIT.
  if (market.liquidationImbalance === 0 ||
      (decision.side === "LONG" && market.liquidationImbalance < 0) ||
      (decision.side === "SHORT" && market.liquidationImbalance > 0))
    return { ok: false, reason: "CURRENT_FLOW_UNCONFIRMED" };
  const { CONFIG } = require("./config");
  const slippage = Math.min(
    CONFIG.FILL_MAX_SLIPPAGE_PCT,
    market.spreadPct +
      CONFIG.FILL_BASE_IMPACT_PCT / Math.max(
        market.depthNotional / CONFIG.FILL_DEPTH_REFERENCE_USDT,
        CONFIG.FILL_DEPTH_FLOOR,
      ) +
      Math.max(0, market.latencyMs - CONFIG.FILL_LATENCY_BASE_MS) *
        CONFIG.FILL_LATENCY_IMPACT_PCT_PER_MS +
      Math.abs(market.openInterestChange) * CONFIG.FILL_OI_IMPACT_COEFF,
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
