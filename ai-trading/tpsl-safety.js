"use strict";

function reachedProtectionTrigger({ side, price, stopPrices = [], targetPrices = [] }) {
  const normalizedSide = String(side || "").toUpperCase();
  const current = Number(price);
  if (!["LONG", "SHORT"].includes(normalizedSide) || !Number.isFinite(current) || current <= 0) {
    return { reached: false, reason: "INVALID_INPUT" };
  }

  const stops = stopPrices.map(Number).filter(v => Number.isFinite(v) && v > 0);
  const targets = targetPrices.map(Number).filter(v => Number.isFinite(v) && v > 0);

  // When a fast move crosses both levels, prioritize the protective stop.
  if (normalizedSide === "LONG" && stops.length && current <= Math.max(...stops)) {
    return { reached: true, reason: "SL_TRIGGER_REACHED" };
  }
  if (normalizedSide === "SHORT" && stops.length && current >= Math.min(...stops)) {
    return { reached: true, reason: "SL_TRIGGER_REACHED" };
  }
  if (normalizedSide === "LONG" && targets.length && current >= Math.min(...targets)) {
    return { reached: true, reason: "TP_TRIGGER_REACHED" };
  }
  if (normalizedSide === "SHORT" && targets.length && current <= Math.max(...targets)) {
    return { reached: true, reason: "TP_TRIGGER_REACHED" };
  }
  return { reached: false, reason: "NO_TRIGGER_REACHED" };
}

module.exports = { reachedProtectionTrigger };
