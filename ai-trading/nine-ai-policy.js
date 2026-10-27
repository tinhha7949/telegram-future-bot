"use strict";
const { CONFIG } = require("./config");
const BAR_MS = CONFIG.BAR_HOURS * 60 * 60 * 1000;
const DECISION_SCHEMA_VERSION = 7; // Invalidates decisions made with the old 90-day candle window.
const FUNDING_HOT_RATE = CONFIG.FUNDING_HOT_RATE;
const fundingIsHot = (rate) =>
  Number.isFinite(rate) && Math.abs(rate) > FUNDING_HOT_RATE;
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
        (a, b) => netEdge(b, baseUncertainty) - netEdge(a, baseUncertainty),
      )[0] || null
  );
}
function uncertaintyFor(regime, snapshotAt, signalAt, now, policy = DEFAULT_POLICY) {
  if (![snapshotAt, signalAt, now].every(finite) ||
      !finite(regime?.regime_conf) || snapshotAt > now || signalAt >= now)
    return Infinity;
  if (now - signalAt > BAR_MS || now - snapshotAt > BAR_MS)
    return Infinity;
  const penalty=Number(policy?.uncertaintyPenalty);
  if (!Number.isFinite(penalty) || penalty < 0) return Infinity;
  return (regime.regime_conf < CONFIG.CONF_LOW ? CONFIG.LOW_CONF_PENALTY : 0) + penalty;
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
  if (flow?.confirmation === "BLOCKED_HOT_FUNDING" ||
      fundingIsHot(flow?.fundingRate))
    return { ...result, reason: "HOT_FUNDING" };
  // A live, zero liquidation imbalance is neutral flow, not missing data.
  // AI-6 may confirm a direction when a cascade exists and may veto an opposing
  // side; in neutral conditions AI-9 remains the sole direction selector.
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
      (neutralFlow || side === flow.confirmationSide) &&
      c.plan &&
      c.edge > params.minEdge &&
      c.edge - other.edge > params.gapEdge
    )
      return { ...result, side, reason: side + "_NET_EDGE_WINS" };
  }
  // Audit the more attractive setup when flow points against that side.
  // Never authorize a competing direction by bypassing the flow gate.
  for (const side of ["LONG", "SHORT"]) {
    const c = result.edges[side], other = result.edges[side === "LONG" ? "SHORT" : "LONG"];
    if (directionalFlow && side !== flow.confirmationSide &&
        c?.eligible && c.plan && c.edge > params.minEdge &&
        c.edge - other.edge > params.gapEdge)
      return { ...result, reason: "FLOW_DIRECTION_CONFLICT" };
  }
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
