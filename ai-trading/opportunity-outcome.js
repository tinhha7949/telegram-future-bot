"use strict";

const CONTRACT = "NINE_AI_EXIT_PLAN_V2";
// Common evaluation for champion/candidate: identical opportunity, exits and costs.
// OHLC cannot establish intrabar ordering, so a bar touching SL and TP uses SL first.
function evaluatePlan(plan, side, future, costs) {
  const { entry, sl, tp1, tp2 } = plan || {};
  if (
    ![entry, sl, tp1, tp2, costs?.totalCostPct].every(Number.isFinite) ||
    entry <= 0 ||
    !future.length ||
    (side === "LONG"
      ? !(sl < entry && entry < tp1 && tp1 <= tp2)
      : !(tp2 <= tp1 && tp1 < entry && entry < sl))
  )
    return null;
  const sign = side === "LONG" ? 1 : -1,
    risk = Math.abs(entry - sl);
  let remaining = 1,
    gross = 0,
    tp1Hit = false,
    exitReason = "TIMEOUT",
    exitPrice;
  for (const c of future) {
    const stopped = side === "LONG" ? c.low <= sl : c.high >= sl;
    if (stopped) {
      exitPrice = side === "LONG" ? Math.min(sl, c.open) : Math.max(sl, c.open);
      gross += remaining * sign * (exitPrice - entry);
      remaining = 0;
      exitReason = "SL";
      break;
    }
    if (!tp1Hit && (side === "LONG" ? c.high >= tp1 : c.low <= tp1)) {
      gross += 0.5 * sign * (tp1 - entry);
      remaining = 0.5;
      tp1Hit = true;
    }
    if (side === "LONG" ? c.high >= tp2 : c.low <= tp2) {
      gross += remaining * sign * (tp2 - entry);
      remaining = 0;
      exitReason = "TP2";
      exitPrice = tp2;
      break;
    }
  }
  if (remaining > 0) {
    exitPrice = future.at(-1).close;
    gross += remaining * sign * (exitPrice - entry);
  }
  const costR = (entry * costs.totalCostPct) / 100 / risk;
  return {
    grossR: gross / risk,
    netR: gross / risk - costR,
    costR,
    tp1Hit,
    exitReason,
    exitPrice,
    contract: CONTRACT,
    source: "HYPOTHETICAL_SL_TP1_TP2_TIMEOUT_SAME_COST_SNAPSHOT",
  };
}
module.exports = { CONTRACT, evaluatePlan };
