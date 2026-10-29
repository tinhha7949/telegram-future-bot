"use strict";
const { CONFIG } = require("./config");
function phaseForLabelCount(labelCount, config = CONFIG) {
  const n = Number.isFinite(Number(labelCount)) ? Math.max(0, Math.floor(Number(labelCount))) : 0;
  if (n < config.EARLY_PHASE_LABELS) return "EARLY";
  if (n < config.ADAPT_PHASE_LABELS) return "ADAPT";
  return "MATURE";
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
module.exports = { phaseForLabelCount, riskForPhase, weightedPercentile };
