"use strict";

function requiredQtyForNotional(minNotional, price, stepSize) {
  const values = [minNotional, price, stepSize].map(Number);
  if (values.some(v => !Number.isFinite(v) || v <= 0)) return NaN;
  const [notional, entry, step] = values;
  const raw = notional / entry;
  // Small epsilon avoids an extra lot caused solely by floating-point noise.
  return Math.ceil((raw - Number.EPSILON * Math.max(1, raw / step)) / step) * step;
}

function assessMinNotionalRisk({ minNotional, price, stopDistance, stepSize, maxRisk }) {
  const values = [minNotional, price, stopDistance, stepSize, maxRisk].map(Number);
  if (values.some(v => !Number.isFinite(v) || v <= 0)) {
    return { feasible: false, reason: "INVALID_SIZING_INPUT", requiredQty: NaN, requiredRisk: NaN };
  }
  const [notional, entry, distance, step, riskCap] = values;
  const requiredQty = requiredQtyForNotional(notional, entry, step);
  const requiredRisk = requiredQty * distance;
  const tolerance = Math.max(1e-12, riskCap * 1e-9);
  return {
    feasible: Number.isFinite(requiredRisk) && requiredRisk <= riskCap + tolerance,
    reason: requiredRisk <= riskCap + tolerance ? "WITHIN_RISK_BUDGET" : "MIN_NOTIONAL_EXCEEDS_RISK",
    requiredQty,
    requiredRisk,
    maxAllowedRisk: riskCap,
    minNotional: notional,
    estimatedNotional: requiredQty * entry
  };
}

function isRiskWithinBudget(finalRisk, maxRisk) {
  const risk = Number(finalRisk);
  const cap = Number(maxRisk);
  if (!Number.isFinite(risk) || !Number.isFinite(cap) || risk <= 0 || cap <= 0) return false;
  return risk <= cap + Math.max(1e-12, cap * 1e-9);
}

function assessAvailableMargin({ availableBalance, notional, leverage, maxNotional, multiplier }) {
  const values = [availableBalance, notional, leverage, multiplier].map(Number);
  if (values.some(v => !Number.isFinite(v)) || values[1] <= 0 || values[2] <= 0 || values[3] <= 0) {
    return { ok: false, reason: "INVALID_MARGIN_INPUT", requiredMargin: NaN };
  }
  const [available, orderNotional, currentLeverage, safetyMultiplier] = values;
  const tierNotional = Number(maxNotional);
  if (Number.isFinite(tierNotional) && tierNotional > 0 && orderNotional > tierNotional) {
    return { ok: false, reason: "MAX_NOTIONAL_EXCEEDED", requiredMargin: orderNotional / currentLeverage * safetyMultiplier };
  }
  const requiredMargin = orderNotional / currentLeverage * safetyMultiplier;
  return {
    ok: available >= requiredMargin,
    reason: available >= requiredMargin ? "AVAILABLE_MARGIN_OK" : "INSUFFICIENT_AVAILABLE_MARGIN",
    requiredMargin,
  };
}

module.exports = { assessAvailableMargin, requiredQtyForNotional, assessMinNotionalRisk, isRiskWithinBudget };
