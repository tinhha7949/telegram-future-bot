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
    if (adx < adxConfig.rangeMax) { regime = "RANGE"; requireWeakCandle = false; }
    else { regime = "MIXED"; requireWeakCandle = true; }
  }

  const currentRange = candle.high - candle.low;
  const previousRange = previous.high - previous.low;
  const weakCandle = currentRange < previousRange;
  if (requireWeakCandle && !weakCandle) {
    return { action: "WAIT", reason: "WEAK_CANDLE_REQUIRED", rsi: currentRsi, adx, regime };
  }

  // A signal candle must satisfy both the RSI rule and its required candle color.
  // Wrong-color candles are discarded immediately and never become pending setups.
  const isShort = currentRsi < s.rsiShortMax && previousRsi >= s.rsiShortMin && candle.close < candle.open;
  const isLong = currentRsi > s.rsiLongMin && previousRsi <= s.rsiLongMax && candle.close > candle.open;
  if (!isShort && !isLong) {
    return { action: "WAIT", reason: "NO_TRIGGER", rsi: currentRsi, previousRsi, adx, regime };
  }

  const side = isShort ? "SHORT" : "LONG";
  return {
    action: "SIGNAL", side,
    signalOpenTime: candle.openTime, signalTime: candle.closeTime,
    signalHigh: candle.high, signalLow: candle.low,
    structureHigh: Math.max(candle.high, previous.high),
    structureLow: Math.min(candle.low, previous.low),
    rsi: currentRsi, previousRsi, adx, regime, weakCandle,
    triggerTime: candle.closeTime
  };
}

function buildConfirmedEntry({ signal, candle, config }) {
  const s = config.strategy;
  const side = signal.side;
  const entry = candle.close;
  const buffer = entry * s.slBufferPct / 100;
  const stop = side === "SHORT"
    ? Math.max(signal.structureHigh + buffer, entry * (1 + s.minStopDistancePct / 100))
    : Math.min(signal.structureLow - buffer, entry * (1 - s.minStopDistancePct / 100));
  const distancePct = Math.abs(stop - entry) / entry * 100;
  if (distancePct > s.maxStopDistancePct) {
    return { action: "WAIT", reason: "STOP_TOO_WIDE", rsi: signal.rsi, adx: signal.adx, regime: signal.regime };
  }
  const risk = Math.abs(stop - entry);
  const direction = side === "LONG" ? 1 : -1;
  return {
    action: "ENTRY", side, entry, stop, risk,
    tp1: entry + direction * risk * s.rewardRiskTp1,
    tp2: entry + direction * risk * s.rewardRiskTp2,
    rsi: signal.rsi, previousRsi: signal.previousRsi, adx: signal.adx,
    regime: signal.regime, weakCandle: signal.weakCandle,
    triggerTime: signal.signalTime, confirmationTime: candle.closeTime
  };
}

function checkBreakoutConfirmation({ signal, candle, elapsedCandles, maxWaitCandles }) {
  if (elapsedCandles <= 0) return { status: "WAIT", reason: "NOT_AFTER_SIGNAL" };
  if (elapsedCandles > maxWaitCandles) return { status: "EXPIRED", reason: "CONFIRMATION_TIMEOUT" };
  const confirmed = signal.side === "LONG"
    ? candle.close > Number(signal.signalHigh)
    : candle.close < Number(signal.signalLow);
  return confirmed ? { status: "CONFIRMED" } : { status: "WAIT", reason: "BREAKOUT_NOT_CLOSED" };
}

module.exports = { evaluateClosedCandle, buildConfirmedEntry, checkBreakoutConfirmation };
