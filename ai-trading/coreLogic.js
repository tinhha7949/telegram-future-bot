"use strict";

function closed(candles, now = Date.now()) {
  return (Array.isArray(candles) ? candles : [])
    .filter(c => Number(c.closeTime ?? c[6]) < now)
    .map(c => Array.isArray(c)
      ? { open: +c[1], high: +c[2], low: +c[3], close: +c[4], closeTime: +c[6] }
      : { open: +c.open, high: +c.high, low: +c.low, close: +c.close, closeTime: +(c.closeTime ?? c.time) })
    .filter(c => [c.open, c.high, c.low, c.close, c.closeTime].every(Number.isFinite));
}

function atrSeries(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  if (!Array.isArray(candles) || !Number.isInteger(period) || period < 1 || candles.length <= period) return out;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  if (tr.length < period) return out;
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + tr[i - 1]) / period;
    out[i] = value;
  }
  return out;
}

function atr(candles, period = 14) {
  const values = atrSeries(candles, period);
  return values.length ? values.at(-1) : null;
}

function rsiSeries(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  if (!Array.isArray(candles) || !Number.isInteger(period) || period < 2 || candles.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  const value = () => avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = value();
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value();
  }
  return out;
}

function emaSeries(candles, period = 50) {
  const out = Array(candles.length).fill(null);
  if (!Array.isArray(candles) || !Number.isInteger(period) || period < 2 || candles.length < period) return out;
  let value = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
  out[period - 1] = value;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < candles.length; i++) {
    value = (candles[i].close - value) * multiplier + value;
    out[i] = value;
  }
  return out;
}

function pivots(candles, left, right) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= c.high) isHigh = false;
      if (candles[i - j].low <= c.low) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high >= c.high) isHigh = false;
      if (candles[i + j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: c.high });
    if (isLow) lows.push({ index: i, price: c.low });
  }
  return { highs, lows };
}

function detectDivergence(candles, config) {
  const { highs, lows } = pivots(candles, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const rsi = rsiSeries(candles, config.RSI_PERIOD);
  const confirmedThrough = candles.length - 1;
  const candidates = [];

  const inspect = (list, direction) => {
    for (let i = list.length - 1; i >= 1; i--) {
      const current = list[i], previous = list[i - 1];
      const confirmIndex = current.index + config.PIVOT_RIGHT_BARS;
      if (confirmIndex > confirmedThrough || !Number.isFinite(rsi[current.index]) || !Number.isFinite(rsi[previous.index])) continue;
      // MT5 only arms a pivot when it is the newest confirmed pivot of its side.
      if (list.slice(i + 1).some(p => p.index <= confirmIndex)) continue;
      const distance = current.index - previous.index;
      if (distance < config.MIN_PIVOT_DISTANCE || distance > config.MAX_PIVOT_DISTANCE) continue;
      const priceNow = current.price, priceBefore = previous.price;
      const rsiNow = rsi[current.index], rsiBefore = rsi[previous.index];
      let type = null;
      if (direction === 1) {
        if (priceNow < priceBefore && rsiNow > rsiBefore) type = "REGULAR_BULLISH";
        else if (priceNow > priceBefore && rsiNow < rsiBefore) type = "HIDDEN_BULLISH";
      } else {
        if (priceNow > priceBefore && rsiNow < rsiBefore) type = "REGULAR_BEARISH";
        else if (priceNow < priceBefore && rsiNow > rsiBefore) type = "HIDDEN_BEARISH";
      }
      if (type) candidates.push({
        direction, type, pivotIndex: current.index, confirmIndex,
        pivotTime: candles[current.index].closeTime,
        referencePrice: direction === 1 ? previous.price : previous.price,
        divergencePrice: current.price
      });
      break;
    }
  };

  inspect(lows, 1);
  inspect(highs, -1);
  candidates.sort((a, b) => b.pivotIndex - a.pivotIndex);
  return candidates[0] || null;
}

function findSweepAndConfirmation(candles, divergence, config, atrValues, emaValues) {
  const sweepEnd = Math.min(candles.length - 1, divergence.confirmIndex + config.SWEEP_MAX_WAIT_BARS - 1);
  let sweep = null;
  for (let i = divergence.confirmIndex; i <= sweepEnd; i++) {
    const a = atrValues[i], candle = candles[i];
    if (!(a > 0)) continue;
    if (divergence.direction === 1) {
      const swept = candle.low < divergence.referencePrice - a * config.SWEEP_MIN_ATR;
      const returnedInside = candle.close > divergence.referencePrice;
      if (swept && returnedInside) {
        sweep = { index: i, high: candle.high, low: candle.low, time: candle.closeTime };
        break;
      }
    } else {
      const swept = candle.high > divergence.referencePrice + a * config.SWEEP_MIN_ATR;
      const returnedInside = candle.close < divergence.referencePrice;
      if (swept && returnedInside) {
        sweep = { index: i, high: candle.high, low: candle.low, time: candle.closeTime };
        break;
      }
    }
  }
  if (!sweep) {
    if (candles.length - 1 >= divergence.confirmIndex + config.SWEEP_MAX_WAIT_BARS)
      return { expired: true, reason: "DIVERGENCE_EXPIRED_WAITING_SWEEP" };
    return { pending: true, reason: "WAITING_LIQUIDITY_SWEEP" };
  }

  const confirmationEnd = Math.min(candles.length - 1, sweep.index + config.CONFIRMATION_MAX_BARS);
  for (let i = sweep.index + 1; i <= confirmationEnd; i++) {
    const candle = candles[i];
    const bullish = candle.close > candle.open;
    const bearish = candle.close < candle.open;
    const confirmed = divergence.direction === 1
      ? bullish && candle.close > sweep.high
      : bearish && candle.close < sweep.low;
    if (!confirmed) continue;
    if (i !== candles.length - 1) return { expired: true, reason: "CONFIRMATION_NOT_CURRENT_CLOSED_CANDLE" };
    const ema = emaValues[i];
    if (config.USE_EMA50_FILTER && !(Number.isFinite(ema) && (divergence.direction === 1 ? candle.close > ema : candle.close < ema)))
      return { expired: true, reason: divergence.direction === 1 ? "BLOCKED_EMA50_TREND_BULLISH_FAIL" : "BLOCKED_EMA50_TREND_BEARISH_FAIL" };
    return { sweep, confirmation: candle, confirmationIndex: i, confirmed: true };
  }
  if (candles.length - 1 > sweep.index + config.CONFIRMATION_MAX_BARS)
    return { expired: true, reason: "CONFIRMATION_EXPIRED" };
  return { pending: true, reason: "WAITING_CONFIRMATION" };
}

function coreLogic({ candles: rawCandles, config, now = Date.now() }) {
  const candles = closed(rawCandles, now).slice(-config.HISTORY_CANDLES);
  const minimum = Math.max(
    config.HISTORY_CANDLES > 0 ? 60 : 0,
    config.RSI_PERIOD + config.PIVOT_LEFT_BARS + config.PIVOT_RIGHT_BARS + config.MAX_PIVOT_DISTANCE + 5,
    config.EMA50_PERIOD + config.ATR_PERIOD + 2
  );
  if (candles.length < minimum) return { side: null, reason: "INSUFFICIENT_CLOSED_CANDLES" };
  const divergence = detectDivergence(candles, config);
  if (!divergence) return { side: null, reason: "NO_NEW_CONFIRMED_DIVERGENCE" };
  const atrValues = atrSeries(candles, config.ATR_PERIOD);
  const emaValues = emaSeries(candles, config.EMA50_PERIOD);
  const sequence = findSweepAndConfirmation(candles, divergence, config, atrValues, emaValues);
  if (!sequence.confirmed) return { side: null, reason: sequence.reason || "SIGNAL_NOT_CONFIRMED" };
  const latestIndex = sequence.confirmationIndex;
  const stopReference = divergence.direction === 1 ? sequence.sweep.low : sequence.sweep.high;
  const stopAtr = atrValues[latestIndex];
  if (!(stopAtr > 0)) return { side: null, reason: "ATR_UNAVAILABLE" };
  return {
    side: divergence.direction === 1 ? "LONG" : "SHORT",
    divergenceType: divergence.type,
    referencePrice: divergence.referencePrice,
    divergencePrice: divergence.divergencePrice,
    pivotTime: divergence.pivotTime,
    sweepTime: sequence.sweep.time,
    sweepHigh: sequence.sweep.high,
    sweepLow: sequence.sweep.low,
    pivotPrice: stopReference,
    slAtr: stopAtr,
    ema50: emaValues[latestIndex],
    ema50Side: divergence.direction === 1 ? "ABOVE_EMA50" : "BELOW_EMA50",
    score: 100,
    signalAt: sequence.confirmation.closeTime
  };
}

function marketVeto({ side, fundingRate, bidPrice, askPrice, config }) {
  const funding = Number(fundingRate), bid = Number(bidPrice), ask = Number(askPrice);
  if (!["LONG", "SHORT"].includes(side) || fundingRate === null || fundingRate === undefined || bidPrice === null || bidPrice === undefined || askPrice === null || askPrice === undefined || !(Number.isFinite(funding) && bid > 0 && ask >= bid && ask > 0)) return { allowed: false, reason: "MARKET_DATA_INVALID" };
  const spreadBps = (ask - bid) / ((ask + bid) / 2) * 10000;
  const adverseFunding = side === "LONG" ? funding > config.MAX_ABS_FUNDING_RATE : funding < -config.MAX_ABS_FUNDING_RATE;
  if (adverseFunding) return { allowed: false, reason: "FUNDING_TOO_HOT", fundingRate: funding, spreadBps };
  if (!Number.isFinite(spreadBps) || spreadBps > config.MAX_SPREAD_BPS) return { allowed: false, reason: "SPREAD_TOO_WIDE", fundingRate: funding, spreadBps };
  return { allowed: true, reason: "OK", fundingRate: funding, spreadBps };
}

module.exports = { closed, atr, atrSeries, rsiSeries, emaSeries, pivots, detectDivergence, findSweepAndConfirmation, marketVeto, coreLogic };
