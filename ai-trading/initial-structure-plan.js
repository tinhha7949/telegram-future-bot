"use strict";
const { FUNDING_HOT_RATE } = require("./nine-ai-policy");
const { CONFIG } = require("./config");

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
  if (!(entry > 0 && atr > 0)) return null;
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
  const stopDistance = CONFIG.AI7_ATR_MULTIPLIER * atr;
  const first = Math.max(CONFIG.MIN_RR * stopDistance, distances[0] ?? 0);
  const second = Math.max(CONFIG.FALLBACK_TP2_R * stopDistance, distances.find(d => d > first) ?? 0, first);
  const plan = {
    entry,
    sl: entry - sign * stopDistance,
    tp1: entry + sign * first,
    tp2: entry + sign * second,
    closePercentAtTP1: (CONFIG.TP_BATCHES[0] / (CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1])) * 100,
    timeoutCandles: CONFIG.TIMEOUT_BARS,
    stopMethod: "ATR14_COLD_START_STOP",
    targetMethod: "AI2_ZONES_WITH_MIN_RR_AND_COLD_START_TP2",
  };
  if (![plan.sl, plan.tp1, plan.tp2].every((v) => Number.isFinite(v) && v > 0))
    return null;
  return plan;
}

// Preserve the initial feature-score models from the original repository.
// These are uncalibrated estimates, not probabilities learned from nonexistent trades.
function initialProbability(type, momentum, volumeRatio, market = {}) {
  const sigmoid = (value) => 1 / (1 + Math.exp(-value));
  if (type === "CONTINUATION")
    return sigmoid(
      Math.abs(momentum) * CONFIG.INITIAL_CONTINUATION_MOMENTUM_WEIGHT +
        Math.log1p(Math.max(-CONFIG.INITIAL_OI_LOG_LOWER_MAGNITUDE, Number(market.openInterestChange) / 100)) +
        1 -
        Math.abs(Number(market.fundingRate)) / FUNDING_HOT_RATE,
    );
  if (type === "BREAKOUT")
    return sigmoid(volumeRatio - 1 - Math.max(0, Number(market.spreadPct)));
  return sigmoid(
    Math.abs(Number(market.deviationAtr)) *
      Math.abs(Number(market.liquidationImbalance)),
  );
}

module.exports = { initialStructurePlan, initialProbability };
