"use strict";
function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const result = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  result[period - 1] = value;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    result[i] = value;
  }
  return result;
}
function evaluateClosedCandle({ candles, config, adx }) {
  const s = config.strategy;
  const period = Math.max(1, Math.floor(Number(s.pullbackEmaPeriod) || 9));
  const lookback = Math.max(1, Math.floor(Number(s.pullbackLookbackCandles) || 5));
  const tolerancePct = Math.max(0, Number(s.pullbackEmaTolerancePct) || 0);
  if (!Array.isArray(candles) || candles.length < period + 2) return { action: "WAIT", reason: "INSUFFICIENT_CANDLES" };
  const emaValues = emaSeries(candles.map(c => c.close), period);
  const index = candles.length - 1;
  const candle = candles[index], previous = candles[index - 1], currentEma = emaValues[index];
  if (!Number.isFinite(currentEma)) return { action: "WAIT", reason: "EMA_UNAVAILABLE" };

  const adxConfig = s.adx;
  let regime = "DISABLED", requireWeakCandle = adxConfig.requireWeakCandleWhenDisabled;
  if (adxConfig.enabled) {
    if (!Number.isFinite(adx)) return { action: "WAIT", reason: "ADX_UNAVAILABLE", adx };
    if (adx > adxConfig.mixedMax) return { action: "WAIT", reason: "ADX_MOMENTUM_BLOCK", adx, regime: "MOMENTUM" };
    if (adx < adxConfig.rangeMax) { regime = "RANGE"; requireWeakCandle = false; }
    else { regime = "MIXED"; requireWeakCandle = true; }
  }
  const weakCandle = candle.high - candle.low < previous.high - previous.low;
  if (requireWeakCandle && !weakCandle) return { action: "WAIT", reason: "WEAK_CANDLE_REQUIRED", adx, regime };

  // A prior opposite-color candle must touch/approach EMA9; the latest closed
  // candle must turn back in the intended direction and close on the EMA trend side.
  const start = Math.max(period - 1, index - lookback);
  let bullishPullback = false, bearishPullback = false;
  for (let i = start; i < index; i++) {
    const bar = candles[i], barEma = emaValues[i];
    if (!Number.isFinite(barEma)) continue;
    if (bar.close < bar.open && bar.low <= barEma * (1 + tolerancePct / 100)) bullishPullback = true;
    if (bar.close > bar.open && bar.high >= barEma * (1 - tolerancePct / 100)) bearishPullback = true;
  }
  const bullishRecovery = candle.close > candle.open && candle.close > currentEma;
  const bearishRecovery = candle.close < candle.open && candle.close < currentEma;
  const isLong = bullishPullback && bullishRecovery, isShort = bearishPullback && bearishRecovery;
  if (!isLong && !isShort) return {
    action: "WAIT", reason: "NO_EMA_PULLBACK_TRIGGER", ema: currentEma, pullbackEmaPeriod: period, adx, regime
  };
  const side = isLong ? "LONG" : "SHORT";
  return {
    action: "SIGNAL", side,
    signalOpenTime: candle.openTime, signalTime: candle.closeTime,
    signalHigh: candle.high, signalLow: candle.low,
    structureHigh: Math.max(candle.high, previous.high),
    structureLow: Math.min(candle.low, previous.low),
    rsi: null, previousRsi: null, adx, regime, weakCandle,
    ema: currentEma, pullbackEmaPeriod: period, triggerTime: candle.closeTime
  };
}
function buildConfirmedEntry({ signal, candle, config }) {
  const s = config.strategy, side = signal.side, entry = candle.close;
  const buffer = entry * s.slBufferPct / 100;
  const stop = side === "SHORT"
    ? Math.max(signal.structureHigh + buffer, entry * (1 + s.minStopDistancePct / 100))
    : Math.min(signal.structureLow - buffer, entry * (1 - s.minStopDistancePct / 100));
  const distancePct = Math.abs(stop - entry) / entry * 100;
  if (distancePct > s.maxStopDistancePct) return { action: "WAIT", reason: "STOP_TOO_WIDE", rsi: null, adx: signal.adx, regime: signal.regime };
  const risk = Math.abs(stop - entry), direction = side === "LONG" ? 1 : -1;
  return {
    action: "ENTRY", side, entry, stop, risk,
    tp1: entry + direction * risk * s.rewardRiskTp1,
    tp2: entry + direction * risk * s.rewardRiskTp2,
    rsi: null, previousRsi: null, adx: signal.adx,
    regime: signal.regime, weakCandle: signal.weakCandle,
    triggerTime: signal.signalTime, confirmationTime: candle.closeTime
  };
}
function checkBreakoutConfirmation({ signal, candle, elapsedCandles, maxWaitCandles }) {
  if (elapsedCandles <= 0) return { status: "WAIT", reason: "NOT_AFTER_SIGNAL" };
  if (elapsedCandles > maxWaitCandles) return { status: "EXPIRED", reason: "CONFIRMATION_TIMEOUT" };
  const confirmed = signal.side === "LONG" ? candle.close > Number(signal.signalHigh) : candle.close < Number(signal.signalLow);
  return confirmed ? { status: "CONFIRMED" } : { status: "WAIT", reason: "BREAKOUT_NOT_CLOSED" };
}
module.exports = { evaluateClosedCandle, buildConfirmedEntry, checkBreakoutConfirmation, emaSeries };
