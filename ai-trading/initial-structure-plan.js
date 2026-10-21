"use strict";

// The user-authorized initial trades use AI-2 zones, not invented AI-7 quantiles.
// A measured range/channel projection supplies targets when price is beyond old highs/lows.
function initialStructurePlan({
  side,
  entry,
  atr,
  highs,
  lows,
  support,
  resistance,
  channel,
  rangeHigh,
  rangeLow,
}) {
  const sign = side === "LONG" ? 1 : -1;
  const stopZones = (side === "LONG" ? lows : highs)
    .map((p) => p.price)
    .filter((price) => sign * (entry - price) > 0)
    .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));
  const stopZone = stopZones[0] ?? (side === "LONG" ? support : resistance);
  if (!(sign * (entry - stopZone) > 0 && atr > 0)) return null;
  const width = Math.max(
    atr,
    Math.abs(resistance - support),
    Math.abs(rangeHigh - rangeLow),
  );
  const projected = side === "LONG" ? channel.upper.price : channel.lower.price;
  const targetZones = (side === "LONG" ? highs : lows)
    .map((p) => p.price)
    .concat(projected)
    .filter((price) => Number.isFinite(price) && sign * (price - entry) > 0);
  const distances = [
    ...new Set(targetZones.map((price) => sign * (price - entry))),
  ].sort((a, b) => a - b);
  const first = distances[0] ?? width;
  const second = distances.find((d) => d > first) ?? first + width;
  const plan = {
    entry,
    sl: stopZone - sign * atr * 0.1,
    tp1: entry + sign * first,
    tp2: entry + sign * second,
    closePercentAtTP1: 50,
    timeoutCandles: 24,
    stopMethod: "AI2_STRUCTURE_INITIAL_STOP",
    targetMethod: "AI2_RESISTANCE_SUPPORT_AND_CHANNEL_PROJECTION",
  };
  if (![plan.sl, plan.tp1, plan.tp2].every((v) => Number.isFinite(v) && v > 0))
    return null;
  return plan;
}

// Preserve the initial feature-score models from the original repository.
// These are uncalibrated estimates, not probabilities learned from nonexistent trades.
function initialProbability(type, momentum, volumeRatio) {
  const clamp = (v) => Math.max(0.5, Math.min(0.78, v));
  if (type === "CONTINUATION")
    return clamp(
      0.54 +
        Math.min(0.18, Math.abs(momentum) * 3) +
        (volumeRatio > 1 ? 0.05 : 0),
    );
  if (type === "BREAKOUT")
    return clamp(0.55 + Math.min(0.2, (volumeRatio - 1) * 0.1));
  return 0.55;
}

module.exports = { initialStructurePlan, initialProbability };
