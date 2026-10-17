"use strict";

// Contextual online policy for live TPSL management.
// Every confirmed closed trade contributes its final R and the market/management
// context that preceded its last action. No sample-count gate decides whether
// a candidate action is eligible; estimates continuously shrink toward the
// observed global baseline as evidence becomes sparse.
const MAX_OUTCOMES = 5000;
const VALID_ACTIONS = new Set(["EXTEND_TP", "TIGHTEN_TP", "CLOSE_EARLY", "CLOSE_PROFIT", "TRAIL_SL", "HOLD"]);
let outcomesCollection = null;
let cachedStats = { actions: {}, regimes: {}, global: { samples: 0, meanR: 0 }, refreshedAt: 0 };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function featureVector(input = {}) {
  const side = String(input.side || "").toUpperCase();
  const sign = side === "SHORT" ? -1 : 1;
  const f = input.features || input.context || {};
  const direction = String(input.decisionSide || "").toUpperCase();
  return {
    favorableR: clamp(num(input.favorableR), -5, 10),
    targetDistanceR: clamp(num(input.targetDistanceR), -5, 10),
    trendAlignment: num(input.trendAligned === true ? 1 : input.trendAligned === false ? -1 : 0),
    momentumAlignment: num(input.momentumAligned === true ? 1 : input.momentumAligned === false ? -1 : 0),
    opposingDirection: direction && ["LONG", "SHORT"].includes(direction) ? (direction === side ? -1 : 1) : 0,
    reversalStructure: num(f.reversalStrength ?? f.reversalEvidence),
    momentum: clamp(sign * num(f.momentum12 ?? f.momentum), -5, 5),
    atrPct: clamp(num(f.atrPercent ?? f.atrPct), 0, 1),
    extensionAtr: clamp(sign * num(f.extensionAtr), -8, 8),
    body: clamp(sign * num(f.candleBodyRatio), -1, 1),
    wick: clamp(sign * (num(f.lowerWickRatio) - num(f.upperWickRatio)), -1, 1),
    structure: clamp(sign * num(f.structurePosition), -1, 1)
  };
}

function contextKey(context = {}) {
  const f = context.features || context;
  const side = String(context.side || "").toUpperCase();
  const decisionSide = String(context.decisionSide || f.decisionSide || "").toUpperCase();
  const alignment = decisionSide && side ? (decisionSide === side ? "ALIGNED" : "OPPOSED") : "UNKNOWN_SIDE";
  const trend = String(f.trend || "UNKNOWN");
  const structure = String(f.structureTrend || "UNKNOWN");
  const momentum = num(f.momentum12 ?? f.momentum);
  const momentumState = momentum === 0 ? "FLAT" : momentum > 0 ? "POSITIVE" : "NEGATIVE";
  return [String(context.marketRegime || context.regime || "UNKNOWN"), trend, structure, alignment, momentumState].join("|");
}

function summarizeOutcomes(rows) {
  const actions = {}, regimes = {}, contexts = {};
  let globalSum = 0, globalSamples = 0;
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
    if (row.context && typeof row.context === "object") {
      add(contexts, `${contextKey(row.context)}:${action}`, realizedR);
    }
    globalSum += realizedR;
    globalSamples++;
  }
  return { actions, regimes, contexts, global: { samples: globalSamples, meanR: globalSamples ? globalSum / globalSamples : 0 } };
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
  return { ready: true, samples: cachedStats.global.samples };
}

function getPolicyStats() { return cachedStats; }

function expectedR(stats, action, regime, context = null) {
  const contextual = context ? stats?.contexts?.[`${contextKey(context)}:${action}`] : null;
  const local = stats?.regimes?.[`${regime}:${action}`];
  const broad = stats?.actions?.[action];
  const global = stats?.global || { samples: 0, meanR: 0 };
  const selected = contextual?.samples ? contextual : local?.samples ? local : broad?.samples ? broad : null;
  if (!selected) return { meanR: global.meanR || 0, samples: 0, uncertainty: 1 };
  const n = selected.samples;
  const priorN = global.samples ? Math.sqrt(global.samples) : 1;
  const prior = global.meanR || 0;
  const meanR = (selected.sumR + prior * priorN) / (n + priorN);
  return { meanR, samples: n, uncertainty: 1 / Math.sqrt(n + priorN) };
}

function chooseManagementAction(input, policyStats = cachedStats) {
  const side = String(input?.side || "").toUpperCase();
  const entry = Number(input?.entry), current = Number(input?.current), oldTP = Number(input?.oldTP);
  const initialRisk = Number(input?.initialRisk);
  const tickSize = Math.max(Number(input?.tickSize) || 0, Number.EPSILON);
  const maxRR = Math.max(0.8, Number(input?.maxRR) || 1.8);
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
  const continuation = input?.trendAligned === true && input?.momentumAligned === true &&
    String(input?.decisionSide || "").toUpperCase() === side;
  const opposition = ["LONG", "SHORT"].includes(String(input?.decisionSide || "").toUpperCase()) &&
    String(input.decisionSide).toUpperCase() !== side;
  const cap = entry + direction * initialRisk * maxRR;
  const capRemaining = direction * (cap - current);
  const features = featureVector({ ...input, favorableR, targetDistanceR });
  const actionContext = {
    ...input,
    marketRegime: regime,
    features: input.features || input.context || {}
  };
  const actionValues = Object.fromEntries([...VALID_ACTIONS].map(action => [
    action, expectedR(policyStats, action, regime, actionContext)
  ]));
  const baseline = expectedR(policyStats, "HOLD", regime, actionContext);
  const choose = (action, reason, extra = {}) => ({
    action, reason, expectedR: actionValues[action]?.meanR ?? baseline.meanR,
    baselineExpectedR: baseline.meanR, samples: actionValues[action]?.samples ?? 0,
    context: features, ...extra
  });

  if (targetReached) return choose("CLOSE_PROFIT", "TARGET_REACHED", { favorableR });

  // Opposing direction and reversal evidence are features, not fixed score gates.
  if (opposition && actionValues.CLOSE_EARLY.meanR > baseline.meanR) {
    return choose("CLOSE_EARLY", "LEARNED_OPPOSITION_EDGE", { favorableR });
  }

  const f = input.features || input.context || {};
  const directionSign = side === "LONG" ? 1 : -1;
  const adverseEvidence = [
    opposition,
    input?.trendAligned === false,
    input?.momentumAligned === false,
    f.structureTrend === (side === "LONG" ? "LOWER_HIGHS_LOWS" : "HIGHER_HIGHS_LOWS"),
    side === "LONG" ? f.bearishEngulfing === true : f.bullishEngulfing === true,
    num(f.falseBreakoutRisk) > 0
  ].filter(Boolean).length;
  const oldSL = Number(input?.oldSL);
  const atr = num(f.atr14, initialRisk);
  if (favorableR > 0 && adverseEvidence > 0 && oldSL > 0 &&
      actionValues.TRAIL_SL.meanR >= baseline.meanR) {
    const distance = Math.max(tickSize * 2, atr / (1 + adverseEvidence));
    const proposedSL = side === "LONG"
      ? Math.max(oldSL, current - distance)
      : Math.min(oldSL, current + distance);
    if ((side === "LONG" && proposedSL < current - tickSize && proposedSL > oldSL) ||
        (side === "SHORT" && proposedSL > current + tickSize && proposedSL < oldSL)) {
      return choose("TRAIL_SL", "REVERSAL_EVIDENCE_PROTECTS_OPEN_PROFIT", {
        favorableR, sl: proposedSL, adverseEvidence
      });
    }
  }

  if (targetDistanceR > 0 && continuation && capRemaining > tickSize &&
      actionValues.EXTEND_TP.meanR > baseline.meanR) {
    const learnedRoom = Math.max(tickSize * 2, initialRisk * (1 + actionValues.EXTEND_TP.uncertainty));
    const extension = Math.min(learnedRoom, capRemaining);
    const tp = current + direction * extension;
    if (direction * (tp - current) > tickSize && direction * (tp - oldTP) > tickSize &&
        direction * (cap - tp) >= -tickSize) {
      return choose("EXTEND_TP", "LEARNED_CONTINUATION_EDGE", { tp, favorableR });
    }
  }

  if (favorableR > 0 && !continuation && actionValues.TIGHTEN_TP.meanR > baseline.meanR) {
    const distance = Math.max(tickSize * 2, initialRisk * actionValues.TIGHTEN_TP.uncertainty);
    const tp = current + direction * distance;
    if (direction * (tp - current) > tickSize && direction * (oldTP - tp) > 0 &&
        direction * (tp - entry) <= initialRisk * maxRR + tickSize) {
      return choose("TIGHTEN_TP", "LEARNED_PROFIT_REALIZATION_EDGE", { tp, favorableR });
    }
  }

  return choose("HOLD", "NO_LEARNED_ACTION_EDGE", { favorableR });
}

async function recordClosedTrade({ tradeId, action, regime, realizedR, closedAt, context = null }) {
  if (!outcomesCollection || !tradeId || !VALID_ACTIONS.has(String(action || "")) ||
      !Number.isFinite(Number(realizedR))) return { updated: false, reason: "INSUFFICIENT_OUTCOME" };
  try {
    const result = await outcomesCollection.updateOne(
      { tradeId: String(tradeId) },
      { $setOnInsert: {
        tradeId: String(tradeId), action: String(action),
        regime: String(regime || "UNKNOWN"), realizedR: Number(realizedR),
        context: context && typeof context === "object" ? context : null,
        closedAt: Number(closedAt) || Date.now()
      } },
      { upsert: true }
    );
    if (result.upsertedCount) {
      await refreshStats();
      return { updated: true, samples: cachedStats.global.samples };
    }
    return { updated: false, reason: "DUPLICATE_TRADE" };
  } catch (error) {
    return { updated: false, reason: error?.message || "PERSIST_FAILED" };
  }
}

module.exports = {
  MAX_OUTCOMES, VALID_ACTIONS, featureVector, contextKey, summarizeOutcomes, chooseManagementAction,
  initialize, refreshStats, getPolicyStats, recordClosedTrade
};
