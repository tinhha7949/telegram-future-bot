"use strict";
const BAR_MS = 4 * 60 * 60 * 1000;
const DECISION_SCHEMA_VERSION = 3;
const FUNDING_HOT_RATE = 0.0008;
const fundingIsHot = (rate) =>
  Number.isFinite(rate) && Math.abs(rate) > FUNDING_HOT_RATE;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const DEFAULT_POLICY = Object.freeze({
  minEdge: 0.05,
  gapEdge: 0.1,
  uncertaintyPenalty: 0.5,
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
function uncertaintyFor(
  regime,
  snapshotAt,
  signalAt,
  now,
  policy = DEFAULT_POLICY,
  context = {},
) {
  if (
    ![snapshotAt, signalAt, now].every(finite) ||
    snapshotAt > now ||
    signalAt >= now
  )
    return Infinity;
  return (
    (1 - regime.regime_conf) * policy.uncertaintyPenalty +
    Math.max(0, now - snapshotAt) / BAR_MS +
    Math.max(0, now - signalAt) / BAR_MS +
    (finite(context.closed1hAt)
      ? Math.max(0, now - context.closed1hAt - 3600000) / 3600000
      : 0) +
    (finite(context.closed1dAt)
      ? Math.max(0, now - context.closed1dAt - 86400000) / 86400000
      : 0) +
    (finite(context.closedOIAt)
      ? Math.max(0, now - context.closedOIAt - BAR_MS) / BAR_MS
      : 0)
  );
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
      c.p > 1 ||
      c.cost < 0
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
  const gap = Math.abs(result.edges.LONG.edge - result.edges.SHORT.edge),
    proximityPenalty = Math.max(0, params.gapEdge - gap);
  for (const c of Object.values(result.edges)) {
    c.directionalGap = gap;
    c.uncertaintyPenalty += proximityPenalty;
    c.edge = netEdge(c, c.uncertaintyPenalty);
  }
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
