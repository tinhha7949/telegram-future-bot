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

function oscillatorPivots(values, left, right, direction) {
  const out = [];
  for (let i = left; i < values.length - right; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    let valid = true, prominence = Infinity;
    for (let j = 1; j <= left; j++) {
      const other = values[i - j];
      if (!Number.isFinite(other) || (direction === "low" ? other <= value : other >= value)) { valid = false; break; }
      prominence = Math.min(prominence, Math.abs(other - value));
    }
    if (!valid) continue;
    for (let j = 1; j <= right; j++) {
      const other = values[i + j];
      if (!Number.isFinite(other) || (direction === "low" ? other <= value : other >= value)) { valid = false; break; }
      prominence = Math.min(prominence, Math.abs(other - value));
    }
    if (valid) out.push({ index: i, value, prominence: Number.isFinite(prominence) ? prominence : 0 });
  }
  return out;
}

function detectDivergence(candles, config, rsiOverride = null) {
  const price = pivots(candles, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const rsi = Array.isArray(rsiOverride) ? rsiOverride : rsiSeries(candles, config.RSI_PERIOD);
  const left = config.RSI_PIVOT_LEFT_BARS ?? config.PIVOT_LEFT_BARS;
  const right = config.RSI_PIVOT_RIGHT_BARS ?? config.PIVOT_RIGHT_BARS;
  const tolerance = config.RSI_PIVOT_MATCH_TOLERANCE ?? 2;
  const minRsiDelta = config.MIN_DIVERGENCE_RSI_DELTA ?? 3;
  const minPricePct = config.MIN_DIVERGENCE_PRICE_PCT ?? 0.15;
  const minRsiProminence = config.MIN_RSI_PIVOT_PROMINENCE ?? 0;
  const confirmedThrough = candles.length - 1, candidates = [];

  // Match each confirmed price swing to the nearest independently confirmed RSI swing.
  const match = (pricePivot, oscillatorList) => oscillatorList
    .filter(p => Math.abs(p.index - pricePivot.index) <= tolerance && p.index + right <= confirmedThrough)
    .sort((a, b) => Math.abs(a.index - pricePivot.index) - Math.abs(b.index - pricePivot.index) ||
      b.prominence - a.prominence)[0] || null;

  const inspect = (priceList, oscillatorList, direction) => {
    const matched = priceList
      .filter(p => p.index + config.PIVOT_RIGHT_BARS <= confirmedThrough)
      .map(p => ({ price: p, oscillator: match(p, oscillatorList) }))
      .filter(x => x.oscillator && x.oscillator.prominence >= minRsiProminence)
      .sort((a, b) => a.price.index - b.price.index);

    if (matched.length < 2) return;
    const current = matched[matched.length - 1];
    // Evaluate multiple earlier reference swings for the newest confirmed price swing.
    for (let j = matched.length - 2; j >= 0; j--) {
      const previous = matched[j];
      const distance = current.price.index - previous.price.index;
      if (distance < config.MIN_PIVOT_DISTANCE || distance > config.MAX_PIVOT_DISTANCE) continue;
      const priceBefore = previous.price.price, priceNow = current.price.price;
      const rsiBefore = previous.oscillator.value, rsiNow = current.oscillator.value;
      const priceDeltaPct = Math.abs(priceNow - priceBefore) / Math.max(Math.abs(priceBefore), 1e-12) * 100;
      if (priceDeltaPct < minPricePct || Math.abs(rsiNow - rsiBefore) < minRsiDelta) continue;
      let type = null;
      if (direction === 1) {
        if (priceNow < priceBefore && rsiNow > rsiBefore) type = "REGULAR_BULLISH";
        else if (priceNow > priceBefore && rsiNow < rsiBefore) type = "HIDDEN_BULLISH";
      } else {
        if (priceNow > priceBefore && rsiNow < rsiBefore) type = "REGULAR_BEARISH";
        else if (priceNow < priceBefore && rsiNow > rsiBefore) type = "HIDDEN_BEARISH";
      }
      if (!type) continue;
      const confirmIndex = Math.max(
        current.price.index + config.PIVOT_RIGHT_BARS,
        current.oscillator.index + right
      );
      if (confirmIndex > confirmedThrough) continue;
      candidates.push({
        direction, type, pivotIndex: current.price.index, confirmIndex,
        pivotTime: candles[current.price.index].closeTime,
        referencePrice: previous.price.price, divergencePrice: current.price.price
      });
      break;
    }
  };

  inspect(price.lows, oscillatorPivots(rsi, left, right, "low"), 1);
  inspect(price.highs, oscillatorPivots(rsi, left, right, "high"), -1);
  candidates.sort((a, b) => b.pivotIndex - a.pivotIndex || a.confirmIndex - b.confirmIndex);
  return candidates[0] || null;
}

function findSweepAndConfirmation(candles, divergence, config, atrValues) {
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
    config.ATR_PERIOD + 2
  );
  if (candles.length < minimum) return { side: null, reason: "INSUFFICIENT_CLOSED_CANDLES" };
  const divergence = detectDivergence(candles, config);
  if (!divergence) return { side: null, reason: "NO_NEW_CONFIRMED_DIVERGENCE" };
  const atrValues = atrSeries(candles, config.ATR_PERIOD);
  const sequence = findSweepAndConfirmation(candles, divergence, config, atrValues);
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

module.exports = { closed, atr, atrSeries, rsiSeries, pivots, detectDivergence, findSweepAndConfirmation, marketVeto, coreLogic };
