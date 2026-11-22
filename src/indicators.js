"use strict";
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}
function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}
function findSwing(candles, side, left = 2, right = 2, lookback = 50) {
  const end = candles.length - right;
  const start = Math.max(left, end - lookback);
  for (let i = end - 1; i >= start; i--) {
    const value = side === "SHORT" ? candles[i].high : candles[i].low;
    let valid = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (side === "SHORT" ? candles[j].high >= value : candles[j].low <= value) { valid = false; break; }
    }
    if (valid) return value;
  }
  return null;
}
function adxWilder(candles, period = 14) {
  if (!Array.isArray(candles) || !Number.isInteger(period) || period <= 0
    || candles.length < period * 2) return null;

  let trSmooth = 0;
  let plusDmSmooth = 0;
  let minusDmSmooth = 0;
  let adxValue = null;
  let dxCount = 0;

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

    if (i <= period) {
      trSmooth += tr;
      plusDmSmooth += plusDm;
      minusDmSmooth += minusDm;
    } else {
      trSmooth = trSmooth - trSmooth / period + tr;
      plusDmSmooth = plusDmSmooth - plusDmSmooth / period + plusDm;
      minusDmSmooth = minusDmSmooth - minusDmSmooth / period + minusDm;
    }

    if (i < period) continue;

    const plusDi = trSmooth > 0 ? 100 * plusDmSmooth / trSmooth : 0;
    const minusDi = trSmooth > 0 ? 100 * minusDmSmooth / trSmooth : 0;
    const diSum = plusDi + minusDi;
    const dx = diSum > 0 ? 100 * Math.abs(plusDi - minusDi) / diSum : 0;

    dxCount++;
    if (dxCount <= period) {
      adxValue = ((adxValue || 0) * (dxCount - 1) + dx) / dxCount;
    } else {
      adxValue = (adxValue * (period - 1) + dx) / period;
    }
  }

  return Number.isFinite(adxValue) ? adxValue : null;
}

module.exports = { ema, rsi, atr, findSwing, adxWilder };
