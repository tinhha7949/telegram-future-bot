"use strict";

const MIN_ACTION_SAMPLES = 20;
const MAX_OUTCOMES = 5000;
const VALID_ACTIONS = new Set(["EXTEND_TP", "TIGHTEN_TP", "CLOSE_EARLY", "CLOSE_PROFIT"]);

let outcomesCollection = null;
let cachedStats = { actions: {}, regimes: {}, refreshedAt: 0 };

function summarizeOutcomes(rows) {
  const actions = {};
  const regimes = {};
  const add = (bucket, key, realizedR) => {
    if (!bucket[key]) bucket[key] = { samples: 0, sumR: 0, meanR: 0 };
    bucket[key].samples += 1;
    bucket[key].sumR += realizedR;
    bucket[key].meanR = bucket[key].sumR / bucket[key].samples;
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const action = String(row?.action || "");
    const regime = String(row?.regime || "UNKNOWN");
    const realizedR = Number(row?.realizedR);
    if (!VALID_ACTIONS.has(action) || !Number.isFinite(realizedR)) continue;
    add(actions, action, realizedR);
    add(regimes, `${regime}:${action}`, realizedR);
  }
  return { actions, regimes };
}

async function refreshStats() {
  if (!outcomesCollection) return cachedStats;
  const rows = await outcomesCollection.find({ action: { $in: [...VALID_ACTIONS] } })
    .sort({ closedAt: -1 }).limit(MAX_OUTCOMES).toArray();
  cachedStats = { ...summarizeOutcomes(rows), refreshedAt: Date.now() };
  return cachedStats;
}

async function initialize(collection) {
  outcomesCollection = collection || null;
  if (!outcomesCollection) return { ready: false, samples: 0 };
  await outcomesCollection.createIndex({ tradeId: 1 }, { unique: true, name: "uniq_nine_ai_tpsl_trade" });
  await outcomesCollection.createIndex({ closedAt: -1 }, { name: "nine_ai_tpsl_closed_at" });
  await refreshStats();
  return {
    ready: true,
    samples: Object.values(cachedStats.actions).reduce((sum, x) => sum + x.samples, 0)
  };
}

function getPolicyStats() {
  return cachedStats;
}

function chooseManagementAction(input, policyStats = cachedStats) {
  const side = String(input?.side || "").toUpperCase();
  const entry = Number(input?.entry);
  const current = Number(input?.current);
  const oldTP = Number(input?.oldTP);
  const initialRisk = Number(input?.initialRisk);
  const tickSize = Math.max(Number(input?.tickSize) || 0, Number.EPSILON);
  const maxRR = Math.max(0.8, Number(input?.maxRR) || 1.8);
  const score = Math.max(0, Math.min(100, Number(input?.score) || 0));
  const decisionSide = String(input?.decisionSide || "").toUpperCase();
  const regime = String(input?.regime || "UNKNOWN");
  if (!["LONG", "SHORT"].includes(side) ||
      ![entry, current, oldTP, initialRisk].every(Number.isFinite) ||
      entry <= 0 || current <= 0 || oldTP <= 0 || initialRisk <= 0) {
    return { action: "HOLD", reason: "INVALID_INPUT" };
  }

  const direction = side === "LONG" ? 1 : -1;
  const favorableR = direction * (current - entry) / initialRisk;
  const targetDistanceR = direction * (oldTP - current) / initialRisk;
  const targetReached = targetDistanceR <= 0;
  const targetNear = targetDistanceR > 0 && targetDistanceR <= 0.30;
  const aligned = decisionSide === side && score >= 72 &&
    input?.trendAligned === true && input?.momentumAligned === true;
  const cap = entry + direction * initialRisk * maxRR;
  const capRemaining = direction * (cap - current);
  const extendStats = policyStats?.regimes?.[`${regime}:EXTEND_TP`] || policyStats?.actions?.EXTEND_TP;
  const closeStats = policyStats?.regimes?.[`${regime}:CLOSE_PROFIT`] || policyStats?.actions?.CLOSE_PROFIT;
  const learnedSupportsExtension = extendStats?.samples >= MIN_ACTION_SAMPLES &&
    closeStats?.samples >= MIN_ACTION_SAMPLES &&
    Number(extendStats.meanR) > Number(closeStats.meanR) + 0.05;

  if (targetReached) {
    // Never assume an exchange TP can be moved after it has triggered. If the
    // position still exists, lock in profit rather than race a stale order.
    return { action: "CLOSE_PROFIT", reason: "TP_REACHED_WHILE_POSITION_OPEN", favorableR };
  }

  if (decisionSide && decisionSide !== side && score >= 72 && favorableR > 0) {
    return { action: "CLOSE_EARLY", reason: "STRONG_OPPOSITE_SIGNAL_IN_PROFIT", favorableR };
  }

  if (targetNear && aligned && capRemaining > tickSize * 3 &&
      (score >= 80 || learnedSupportsExtension)) {
    const extension = Math.min(initialRisk * 0.25, capRemaining);
    const tp = current + direction * Math.max(extension, tickSize * 3);
    if (direction * (tp - current) > tickSize &&
        direction * (cap - tp) >= -tickSize) {
      return { action: "EXTEND_TP", reason: learnedSupportsExtension
        ? "LEARNED_EXTENSION_EDGE" : "STRONG_CONTINUATION_NEAR_TP", tp, favorableR };
    }
  }

  if (favorableR >= 0.5 && score < 48) {
    const distance = Math.max(tickSize * 3, initialRisk * 0.15);
    const tp = current + direction * distance;
    if (direction * (tp - current) > tickSize &&
        direction * (oldTP - tp) > 0) {
      return { action: "TIGHTEN_TP", reason: "WEAKENING_SIGNAL_LOCK_PROFIT", tp, favorableR };
    }
  }

  return { action: "HOLD", reason: "NO_TPSL_POLICY_CHANGE", favorableR };
}

async function recordClosedTrade({ tradeId, action, regime, realizedR, closedAt }) {
  if (!outcomesCollection || !tradeId || !VALID_ACTIONS.has(String(action || "")) ||
      !Number.isFinite(Number(realizedR))) return { updated: false, reason: "INSUFFICIENT_OUTCOME" };
  try {
    const result = await outcomesCollection.updateOne(
      { tradeId: String(tradeId) },
      { $setOnInsert: {
        tradeId: String(tradeId),
        action: String(action),
        regime: String(regime || "UNKNOWN"),
        realizedR: Number(realizedR),
        closedAt: Number(closedAt) || Date.now()
      } },
      { upsert: true }
    );
    if (result.upsertedCount) {
      await refreshStats();
      return { updated: true };
    }
    return { updated: false, reason: "DUPLICATE_TRADE" };
  } catch (error) {
    return { updated: false, reason: error?.message || "PERSIST_FAILED" };
  }
}

module.exports = {
  MIN_ACTION_SAMPLES, summarizeOutcomes, chooseManagementAction,
  initialize, refreshStats, getPolicyStats, recordClosedTrade
};
