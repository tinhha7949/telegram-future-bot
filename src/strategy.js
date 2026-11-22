"use strict";
const { rsi } = require("./indicators");

function evaluateClosedCandle({ candles, config, adx }) {
  const s = config.strategy;
  const minimumHistory = s.rsiPeriod + 2;
  if (!Array.isArray(candles) || candles.length < minimumHistory) {
    return { action: "WAIT", reason: "INSUFFICIENT_CANDLES" };
  }

  const closes = candles.map(c => c.close);
  const currentRsi = rsi(closes, s.rsiPeriod);
  const previousRsi = rsi(closes.slice(0, -1), s.rsiPeriod);
  const candle = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  if (!Number.isFinite(currentRsi) || !Number.isFinite(previousRsi)) {
    return { action: "WAIT", reason: "RSI_UNAVAILABLE" };
  }

  const adxConfig = s.adx;
  let regime = "DISABLED";
  let requireWeakCandle = adxConfig.requireWeakCandleWhenDisabled;

  if (adxConfig.enabled) {
    if (!Number.isFinite(adx)) return { action: "WAIT", reason: "ADX_UNAVAILABLE", rsi: currentRsi };
    if (adx > adxConfig.mixedMax) {
      return { action: "WAIT", reason: "ADX_MOMENTUM_BLOCK", rsi: currentRsi, adx, regime: "MOMENTUM" };
    }
    if (adx < adxConfig.rangeMax) {
      regime = "RANGE";
      requireWeakCandle = false;
    } else {
      regime = "MIXED";
      requireWeakCandle = true;
    }
  }

  const currentRange = candle.high - candle.low;
  const previousRange = previous.high - previous.low;
  const weakCandle = currentRange < previousRange;
  if (requireWeakCandle && !weakCandle) {
    return { action: "WAIT", reason: "WEAK_CANDLE_REQUIRED", rsi: currentRsi, adx, regime };
  }

  const isShort = currentRsi < s.rsiShortMax
    && previousRsi >= s.rsiShortMin
    && candle.close < candle.open;
  const isLong = currentRsi > s.rsiLongMin
    && previousRsi <= s.rsiLongMax
    && candle.close > candle.open;

  if (!isShort && !isLong) {
    return { action: "WAIT", reason: "NO_TRIGGER", rsi: currentRsi, previousRsi, adx, regime };
  }

  const side = isShort ? "SHORT" : "LONG";
  const entry = candle.close;
  const buffer = entry * s.slBufferPct / 100;
  const structureHigh = Math.max(candle.high, previous.high);
  const structureLow = Math.min(candle.low, previous.low);
  let stop = side === "SHORT"
    ? Math.max(structureHigh + buffer, entry * (1 + s.minStopDistancePct / 100))
    : Math.min(structureLow - buffer, entry * (1 - s.minStopDistancePct / 100));

  const distancePct = Math.abs(stop - entry) / entry * 100;
  if (distancePct > s.maxStopDistancePct) {
    return { action: "WAIT", reason: "STOP_TOO_WIDE", rsi: currentRsi, adx, regime };
  }

  const risk = Math.abs(stop - entry);
  const direction = side === "LONG" ? 1 : -1;
  return {
    action: "ENTRY",
    side,
    entry,
    stop,
    risk,
    tp1: entry + direction * risk * s.rewardRiskTp1,
    tp2: entry + direction * risk * s.rewardRiskTp2,
    rsi: currentRsi,
    previousRsi,
    adx,
    regime,
    weakCandle,
    triggerTime: candle.closeTime,
    confirmationTime: candle.closeTime
  };
}

module.exports = { evaluateClosedCandle };
