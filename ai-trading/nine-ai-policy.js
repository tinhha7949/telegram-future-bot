"use strict";
const { CONFIG } = require("./config");
const BAR_MS = CONFIG.BAR_HOURS * 60 * 60 * 1000;
const DECISION_SCHEMA_VERSION = 7; // Invalidates decisions made with the old 90-day candle window.
const FUNDING_HOT_RATE = CONFIG.FUNDING_HOT;
const fundingIsHot = (rate) =>
  Number.isFinite(rate) && Math.abs(rate) >= FUNDING_HOT_RATE;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const DEFAULT_POLICY = Object.freeze({
  minEdge: CONFIG.MIN_EDGE,
  gapEdge: CONFIG.EDGE_GAP,
  uncertaintyPenalty: 0,
});
// One formula for setup selection, direction selection, execution and offline evaluation.
function netEdge(c, penalty = c.baseUncertainty) {
  return c.p * c.expectedR - c.cost - penalty;
}
function selectDirectionCandidate(estimates, baseUncertainty) {
  return (
    estimates
      .filter((c) => [c.p, c.expectedR, c.cost].every(finite))
      .sort(
        (a, b) =>
          netEdge(b, finite(b.baseUncertainty) ? b.baseUncertainty : baseUncertainty) -
          netEdge(a, finite(a.baseUncertainty) ? a.baseUncertainty : baseUncertainty),
      )[0] || null
  );
}
function uncertaintyFor(regime, snapshotAt, signalAt, now, policy = DEFAULT_POLICY) {
  if (![snapshotAt, signalAt, now].every(finite) ||
      !finite(regime?.regime_conf) || snapshotAt > now || signalAt >= now)
    return Infinity;
  if (now - signalAt > BAR_MS || now - snapshotAt > BAR_MS)
    return Infinity;
  const penalty = Number(policy?.uncertaintyPenalty);
  if (!Number.isFinite(penalty) || penalty < 0) return Infinity;
  const confidence = regime.regime_conf;
  const confidencePenalty = confidence < CONFIG.CONF_LOW
    ? CONFIG.LOW_CONF_PENALTY
    : confidence >= CONFIG.CONF_HIGH
      ? 0
      : CONFIG.LOW_CONF_PENALTY *
        ((CONFIG.CONF_HIGH - confidence) / (CONFIG.CONF_HIGH - CONFIG.CONF_LOW));
  return confidencePenalty +
    (policy?.earlyPhase === true ? CONFIG.EARLY_UNCERTAINTY_PENALTY : 0) + penalty;
}
function applyPolicy(decision, policy = DEFAULT_POLICY) {
  const params = { ...DEFAULT_POLICY, ...policy },
    result = { side: "WAIT", reason: "EDGE_BELOW_THRESHOLD", edges: {} };
  if (
    ![params.minEdge, params.gapEdge, params.uncertaintyPenalty].every(
      (v) => finite(v) && v >= 0,
    )
  )
    return { ...result, reason: "INVALID_META_POLICY" };
  if (!["UPTREND", "DOWNTREND"].includes(decision?.regime?.regime))
    return { ...result, reason: "REGIME_NOT_TREND" };
  const flow = decision?.agents?.flow;
  const guardian = decision?.agents?.riskGuardian;
  if (guardian?.marketVeto === "BLOCKED")
    return { ...result, reason: guardian.reason || "AI6_MARKET_VETO" };
  let allowedSides;
  if (Array.isArray(guardian?.allowedSides)) {
    const guardianInputs = [
      guardian.fundingRate,
      guardian.openInterestChange,
      guardian.liquidationImbalance,
      guardian.spreadPct,
      guardian.depthNotional,
      guardian.latencyMs,
      guardian.roundTripFeePct,
      guardian.markPrice,
      guardian.fundingCostPctBySide?.LONG,
      guardian.fundingCostPctBySide?.SHORT,
      guardian.snapshotAgeMs,
    ];
    if (guardian.marketVeto !== "PASSED" ||
        !guardianInputs.every(finite) ||
        fundingIsHot(guardian.fundingRate) ||
        guardian.spreadPct > CONFIG.MAX_SPREAD_PCT ||
        guardian.depthNotional <= 0 ||
        guardian.snapshotAgeMs < 0 || guardian.snapshotAgeMs > BAR_MS ||
        !guardian.allowedSides.length ||
        guardian.allowedSides.some(side => !["LONG", "SHORT"].includes(side)) ||
        new Set(guardian.allowedSides).size !== guardian.allowedSides.length)
      return { ...result, reason: "AI6_GUARDIAN_OUTPUT_INVALID" };
    const expectedAllowedSides = guardian.liquidationImbalance === 0
      ? ["LONG", "SHORT"]
      : guardian.liquidationImbalance > 0 ? ["LONG"] : ["SHORT"];
    if (expectedAllowedSides.some(side => !guardian.allowedSides.includes(side)) ||
        guardian.allowedSides.some(side => !expectedAllowedSides.includes(side)))
      return { ...result, reason: "AI6_GUARDIAN_OUTPUT_INVALID" };
    allowedSides = guardian.allowedSides;
  } else {
    // Backward-compatible interpretation for historical journal snapshots
    // written before the explicit AI-6 direction contract existed.
    if (fundingIsHot(flow?.fundingRate))
      return { ...result, reason: "HOT_FUNDING" };
    const validFlowInputs = [
      flow?.fundingRate,
      flow?.openInterestChange,
      flow?.liquidationImbalance,
    ].every(finite);
    const neutralFlow =
      flow?.confirmation === "NEUTRAL" &&
      flow.confirmationSide == null &&
      flow.liquidationImbalance === 0;
    const directionalFlow =
      flow?.confirmation === "CONFIRMED" &&
      ["LONG", "SHORT"].includes(flow.confirmationSide) &&
      flow.liquidationImbalance !== 0 &&
      flow.confirmationSide ===
        (flow.liquidationImbalance > 0 ? "LONG" : "SHORT");
    if (!validFlowInputs || (!neutralFlow && !directionalFlow))
      return { ...result, reason: "FLOW_UNAVAILABLE_OR_UNCERTAIN" };
    allowedSides = neutralFlow ? ["LONG", "SHORT"] : [flow.confirmationSide];
  }
  for (const side of ["LONG", "SHORT"]) {
    const c = decision?.edges?.[side];
    if (
      !c ||
      ![c.p, c.expectedR, c.cost, c.baseUncertainty].every(finite) ||
      c.p < 0 ||
      c.p > 1
    )
      return { ...result, reason: "MISSING_DIRECTIONAL_ESTIMATE" };
    const baseEdge = netEdge(c);
    result.edges[side] = {
      ...c,
      baseEdge,
      edge: baseEdge,
      uncertaintyPenalty: c.baseUncertainty,
    };
  }
  const gap = Math.abs(result.edges.LONG.edge - result.edges.SHORT.edge);
  for (const c of Object.values(result.edges)) c.directionalGap = gap;
  for (const side of ["LONG", "SHORT"]) {
    const c = result.edges[side],
      other = result.edges[side === "LONG" ? "SHORT" : "LONG"];
    if (
      c.eligible === true &&
      allowedSides.includes(side) &&
      c.plan &&
      c.edge > params.minEdge &&
      c.edge - other.edge > params.gapEdge
    )
      return { ...result, side, reason: side + "_NET_EDGE_WINS" };
  }
  // The AI-6 guardian supplies the permitted direction set. AI-9 may only
  // choose within that set; an otherwise-qualified blocked side must WAIT.
  const directionVetoed = ["LONG", "SHORT"].some(side => {
    const c = result.edges[side], other = result.edges[side === "LONG" ? "SHORT" : "LONG"];
    return c?.eligible === true && !allowedSides.includes(side) && c.plan &&
      c.edge > params.minEdge && c.edge - other.edge > params.gapEdge;
  });
  if (directionVetoed) return { ...result, reason: "AI6_DIRECTION_VETO" };
  return result;
}
module.exports = {
  BAR_MS,
  DECISION_SCHEMA_VERSION,
  FUNDING_HOT_RATE,
  fundingIsHot,
  DEFAULT_POLICY,
  netEdge,
  selectDirectionCandidate,
  uncertaintyFor,
  applyPolicy,
};
