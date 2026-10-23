"use strict";
const { CONFIG } = require("./config");
const BAR_MS = 4 * 60 * 60 * 1000;
const DECISION_SCHEMA_VERSION = 5;
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
  if (regime.regime_conf < CONFIG.CONF_LOW) return CONFIG.LOW_CONF_PENALTY;
  return 0;
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
  if (
    decision?.agents?.flow?.confirmation === "BLOCKED_HOT_FUNDING" ||
    fundingIsHot(decision?.agents?.flow?.fundingRate)
  )
    return { ...result, reason: "HOT_FUNDING" };
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
      c.plan &&
      c.edge > params.minEdge &&
      c.edge - other.edge > params.gapEdge
    )
      return { ...result, side, reason: side + "_NET_EDGE_WINS" };
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
