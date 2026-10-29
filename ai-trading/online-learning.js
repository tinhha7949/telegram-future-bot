"use strict";
const { CONFIG } = require("./config");
function phaseForLabelCount(labelCount, config = CONFIG) {
  const n = Number.isFinite(Number(labelCount)) ? Math.max(0, Math.floor(Number(labelCount))) : 0;
  if (n < config.EARLY_PHASE_LABELS) return "EARLY";
  if (n < config.ADAPT_PHASE_LABELS) return "ADAPT";
  return "MATURE";
}
function countRealizedLabels(outcomes, now = Date.now()) {
  if (!Array.isArray(outcomes)) return 0;
  const seen = new Set();
  for (const row of outcomes) {
    const id = row?.tradeId == null ? "" : String(row.tradeId);
    const closedAt = Number(row?.closedAt);
    if (!id || seen.has(id) || row?.labeled !== true ||
        row?.source !== "REALIZED_CLOSED_TRADE" || row?.accountingSchemaVersion !== 2 ||
        !Number.isFinite(closedAt) || closedAt > now ||
        !Number.isFinite(Number(row?.maePct)) || Number(row.maePct) < 0 ||
        !Number.isFinite(Number(row?.mfePct)) || Number(row.mfePct) < 0) continue;
    seen.add(id);
  }
  return seen.size;
}
function riskForPhase(labelCount, config = CONFIG) {
  const phase = phaseForLabelCount(labelCount, config);
  if (phase === "EARLY") return config.EARLY_RISK;
  if (phase === "ADAPT") return config.ADAPT_RISK;
  return config.RISK_PER_TRADE;
}
// Values are newest-first. A newly closed trade has weight 1; older samples
// decay geometrically so the distribution adapts immediately to recent outcomes.
function weightedPercentile(values, percentile, decay = CONFIG.RECENCY_DECAY) {
  if (!Array.isArray(values) || !values.length ||
      !Number.isFinite(Number(percentile)) || percentile < 0 || percentile > 1 ||
      !Number.isFinite(Number(decay)) || decay <= 0 || decay > 1) return null;
  const xs = values.map((value, age) => ({
    value: Number(value),
    weight: Math.pow(decay, age),
  })).filter(x => Number.isFinite(x.value) && x.value >= 0 && x.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!xs.length) return null;
  const total = xs.reduce((sum, x) => sum + x.weight, 0);
  const target = percentile * total;
  let cumulative = 0;
  for (const x of xs) {
    cumulative += x.weight;
    if (cumulative + Number.EPSILON >= target) return x.value;
  }
  return xs.at(-1).value;
}
function updateOnlineCalibration(previous, predictedR, realizedR, at = Date.now(), config = CONFIG) {
  if (![predictedR, realizedR].every(v => Number.isFinite(Number(v)))) return null;
  const priorWeight = Number.isFinite(Number(previous?.weight)) ? Math.max(0, Number(previous.weight)) : 0;
  const decayedWeight = priorWeight * config.RECENCY_DECAY;
  const weight = decayedWeight + 1;
  const residual = Number(predictedR) - Number(realizedR);
  const oldBias = Number.isFinite(Number(previous?.biasR)) ? Number(previous.biasR) : 0;
  const oldMae = Number.isFinite(Number(previous?.maeR)) ? Number(previous.maeR) : 0;
  const oldPredicted = Number.isFinite(Number(previous?.meanPredictedR)) ? Number(previous.meanPredictedR) : 0;
  const oldRealized = Number.isFinite(Number(previous?.meanRealizedR)) ? Number(previous.meanRealizedR) : 0;
  return {
    samples: (Number.isSafeInteger(previous?.samples) ? previous.samples : 0) + 1,
    weight,
    meanPredictedR: (oldPredicted * decayedWeight + Number(predictedR)) / weight,
    meanRealizedR: (oldRealized * decayedWeight + Number(realizedR)) / weight,
    biasR: (oldBias * decayedWeight + residual) / weight,
    maeR: (oldMae * decayedWeight + Math.abs(residual)) / weight,
    updatedAt: Number(at) || Date.now(),
  };
}
function calibrationPenaltyForState(state, config = CONFIG) {
  if (!state || !Number.isFinite(Number(state.maeR)) ||
      !Number.isFinite(Number(state.biasR)) || !(Number(state.samples) > 0)) return 0;
  const excessMae = Math.max(0, Number(state.maeR) - config.CALIBRATION_MAX_MAE_R);
  const excessBias = Math.max(0, Math.abs(Number(state.biasR)) - config.CALIBRATION_MAX_ABS_BIAS_R);
  return Math.min(config.LOW_CONF_PENALTY, excessMae + excessBias);
}
module.exports = {
  phaseForLabelCount, countRealizedLabels, riskForPhase, weightedPercentile,
  updateOnlineCalibration, calibrationPenaltyForState,
};
