"use strict";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const DEFAULT_POLICY = Object.freeze({
  minEdge: 0.05,
  gapEdge: 0.1,
  uncertaintyPenalty: 0.5,
});

// Live, cached, walk-forward and shadow decisions use this same boundary.
// An inactive setup has p=0 (the setup event did not occur), not missing labels.
function applyPolicy(decision, policy = DEFAULT_POLICY) {
  const params = { ...DEFAULT_POLICY, ...policy };
  const result = { side: "WAIT", reason: "EDGE_BELOW_THRESHOLD", edges: {} };
  if (
    ![params.minEdge, params.gapEdge, params.uncertaintyPenalty].every(
      (v) => finite(v) && v >= 0,
    )
  ) {
    return { ...result, reason: "INVALID_META_POLICY" };
  }
  for (const side of ["LONG", "SHORT"]) {
    const c = decision?.edges?.[side];
    if (
      !c ||
      ![c.p, c.expectedR, c.cost, c.baseUncertainty].every(finite) ||
      c.p < 0 ||
      c.p > 1 ||
      c.cost < 0
    ) {
      return { ...result, reason: "MISSING_DIRECTIONAL_ESTIMATE" };
    }
    const baseEdge = c.p * c.expectedR - c.cost - c.baseUncertainty;
    result.edges[side] = {
      ...c,
      baseEdge,
      edge: baseEdge,
      uncertaintyPenalty: c.baseUncertainty,
    };
  }
  const gap = Math.abs(result.edges.LONG.edge - result.edges.SHORT.edge);
  const proximityPenalty = Math.max(0, params.gapEdge - gap);
  for (const c of Object.values(result.edges)) {
    c.directionalGap = gap;
    c.uncertaintyPenalty += proximityPenalty;
    c.edge -= proximityPenalty;
  }
  if (!["UPTREND", "DOWNTREND"].includes(decision?.regime?.regime)) {
    return { ...result, reason: "REGIME_NOT_TREND" };
  }
  const flow = decision?.agents?.flow;
  if (flow?.confirmation !== "CONFIRMED")
    return { ...result, reason: "FLOW_BLOCKED_OR_UNAVAILABLE" };
  for (const side of ["LONG", "SHORT"]) {
    const c = result.edges[side],
      other = result.edges[side === "LONG" ? "SHORT" : "LONG"];
    if (
      c.eligible === true &&
      c.plan &&
      flow.confirmationSide === side &&
      (side === "LONG"
        ? decision.regime.regime === "UPTREND"
        : decision.regime.regime === "DOWNTREND") &&
      c.edge > params.minEdge &&
      c.edge - other.edge > params.gapEdge
    ) {
      return { ...result, side, reason: side + "_NET_EDGE_WINS" };
    }
  }
  return result;
}

module.exports = { DEFAULT_POLICY, applyPolicy };
