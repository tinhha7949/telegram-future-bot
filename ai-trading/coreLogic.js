"use strict";

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + Number(b), 0) / period;
  for (let i = period; i < values.length; i++) value = Number(values[i]) * k + value * (1 - k);
  return Number.isFinite(value) ? value : null;
}

function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = Number(closes[i]) - Number(closes[i - 1]);
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = Number(closes[i]) - Number(closes[i - 1]);
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(
      Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - Number(prev.close)),
      Math.abs(Number(c.low) - Number(prev.close))
    ));
  }
  if (tr.length < period) return null;
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period;
  return Number.isFinite(value) ? value : null;
}

function closed(candles, now = Date.now()) {
  return (Array.isArray(candles) ? candles : [])
    .filter(c => Number(c.closeTime ?? c[6]) < now)
    .map(c => Array.isArray(c)
      ? { high: +c[2], low: +c[3], close: +c[4], closeTime: +c[6] }
      : { high: +c.high, low: +c.low, close: +c.close, closeTime: +(c.closeTime ?? c.time) })
    .filter(c => [c.high, c.low, c.close, c.closeTime].every(Number.isFinite));
}

function isLongRsi(value, config) {
  return Number.isFinite(value) && value >= config.RSI_LONG_MIN && value <= config.RSI_LONG_TRIGGER;
}

function isShortRsi(value, config) {
  return Number.isFinite(value) && value >= config.RSI_SHORT_TRIGGER && value <= config.RSI_SHORT_MAX;
}

function coreLogic({ trendCandles, entryCandles, config, now = Date.now() }) {
  const trend = closed(trendCandles, now), entry = closed(entryCandles, now);
  if (trend.length < config.TREND_EMA_PERIOD ||
      entry.length < Math.max(config.RSI_PERIOD + 1, config.ATR_PERIOD + 1)) {
    return { side: null, reason: "INSUFFICIENT_CLOSED_CANDLES" };
  }
  const trendEma = ema(trend.map(c => c.close), config.TREND_EMA_PERIOD);
  const price = trend.at(-1).close;
  const valueRsi = rsi(entry.map(c => c.close), config.RSI_PERIOD);
  const valueAtr = atr(entry, config.ATR_PERIOD);
  if (!(trendEma > 0 && price > 0 && valueRsi != null && valueAtr > 0)) {
    return { side: null, reason: "INVALID_INDICATORS" };
  }
  const trendSide = price > trendEma ? "UP" : price < trendEma ? "DOWN" : "NEUTRAL";
  if (trendSide === "UP" && isLongRsi(valueRsi, config)) {
    return { side: "LONG", trendSide, trendEma, rsi: valueRsi, atr: valueAtr, signalAt: entry.at(-1).closeTime };
  }
  if (trendSide === "DOWN" && isShortRsi(valueRsi, config)) {
    return { side: "SHORT", trendSide, trendEma, rsi: valueRsi, atr: valueAtr, signalAt: entry.at(-1).closeTime };
  }
  return {
    side: null, trendSide, trendEma, rsi: valueRsi, atr: valueAtr,
    signalAt: entry.at(-1).closeTime, reason: "NO_SIGNAL"
  };
}

module.exports = { ema, rsi, atr, closed, isLongRsi, isShortRsi, coreLogic };
