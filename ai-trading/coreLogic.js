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

  // Match pivots one-to-one. Reusing one RSI swing for two price swings can
  // manufacture a divergence that does not exist, so reserve each RSI pivot once.
  const matchPivots = (priceList, oscillatorList) => {
    const edges = [];
    for (const pricePivot of priceList) {
      if (pricePivot.index + config.PIVOT_RIGHT_BARS > confirmedThrough) continue;
      for (const oscillator of oscillatorList) {
        const distance = Math.abs(oscillator.index - pricePivot.index);
        if (distance <= tolerance && oscillator.index + right <= confirmedThrough) {
          edges.push({ pricePivot, oscillator, distance });
        }
      }
    }
    edges.sort((a, b) => a.distance - b.distance ||
      b.oscillator.prominence - a.oscillator.prominence ||
      a.pricePivot.index - b.pricePivot.index ||
      a.oscillator.index - b.oscillator.index);
    const usedPrices = new Set(), usedOscillators = new Set(), matched = new Map();
    for (const edge of edges) {
      if (usedPrices.has(edge.pricePivot.index) || usedOscillators.has(edge.oscillator.index)) continue;
      usedPrices.add(edge.pricePivot.index);
      usedOscillators.add(edge.oscillator.index);
      matched.set(edge.pricePivot.index, edge.oscillator);
    }
    return matched;
  };

  const inspect = (priceList, oscillatorList, direction) => {
    const matches = matchPivots(priceList, oscillatorList);
    const matched = priceList
      .map(p => ({ price: p, oscillator: matches.get(p.index) }))
      .filter(x => x.oscillator && x.oscillator.prominence >= minRsiProminence)
      .sort((a, b) => a.price.index - b.price.index);

    if (matched.length < 2) return;
    const current = matched[matched.length - 1];
    // Only compare the newest two matched swings; never recycle a stale older setup.
    const previous = matched[matched.length - 2];
    const distance = current.price.index - previous.price.index;
    if (distance < config.MIN_PIVOT_DISTANCE || distance > config.MAX_PIVOT_DISTANCE) return;
    const priceBefore = previous.price.price, priceNow = current.price.price;
    const rsiBefore = previous.oscillator.value, rsiNow = current.oscillator.value;
    const priceDeltaPct = Math.abs(priceNow - priceBefore) / Math.max(Math.abs(priceBefore), 1e-12) * 100;
    if (priceDeltaPct < minPricePct || Math.abs(rsiNow - rsiBefore) < minRsiDelta) return;
    let type = null;
    if (direction === 1) {
      if (priceNow < priceBefore && rsiNow > rsiBefore) type = "REGULAR_BULLISH";
      else if (priceNow > priceBefore && rsiNow < rsiBefore) type = "HIDDEN_BULLISH";
    } else {
      if (priceNow > priceBefore && rsiNow < rsiBefore) type = "REGULAR_BEARISH";
      else if (priceNow < priceBefore && rsiNow > rsiBefore) type = "HIDDEN_BEARISH";
    }
    if (!type) return;
    const confirmIndex = Math.max(
      current.price.index + config.PIVOT_RIGHT_BARS,
      current.oscillator.index + right
    );
    if (confirmIndex > confirmedThrough) return;
    candidates.push({
      direction, type, pivotIndex: current.price.index, confirmIndex,
      pivotTime: candles[current.price.index].closeTime,
      referencePrice: previous.price.price,
      divergencePrice: current.price.price,
      // Regular divergence sweeps the prior swing liquidity. Hidden divergence
      // sweeps the current continuation pivot, which is the protected HL/LH.
      sweepReferencePrice: type.startsWith("HIDDEN_") ? current.price.price : previous.price.price
    });
  };

  inspect(price.lows, oscillatorPivots(rsi, left, right, "low"), 1);
  inspect(price.highs, oscillatorPivots(rsi, left, right, "high"), -1);
  candidates.sort((a, b) => b.pivotIndex - a.pivotIndex || a.confirmIndex - b.confirmIndex);
  return candidates[0] || null;
}

function findSweepAndConfirmation(candles, divergence, config, atrValues) {
  // A valid sweep can happen on the divergence pivot candle or while its
  // price/RSI pivots are waiting for right-side confirmation candles.
  // Start at pivotIndex, not confirmIndex, so that event is not discarded.
  const sweepStart = Math.max(0, divergence.pivotIndex ?? divergence.confirmIndex);
  const sweepEnd = Math.min(candles.length - 1, divergence.confirmIndex + config.SWEEP_MAX_WAIT_BARS - 1);
  const sweepReferencePrice = Number.isFinite(divergence.sweepReferencePrice)
    ? divergence.sweepReferencePrice
    : divergence.referencePrice;
  let sweep = null;
  for (let i = sweepStart; i <= sweepEnd; i++) {
    const a = atrValues[i], candle = candles[i];
    if (!(a > 0)) continue;
    if (divergence.direction === 1) {
      const swept = candle.low < sweepReferencePrice - a * config.SWEEP_MIN_ATR;
      const returnedInside = candle.close > sweepReferencePrice;
      if (swept && returnedInside) {
        sweep = { index: i, high: candle.high, low: candle.low, time: candle.closeTime };
        break;
      }
    } else {
      const swept = candle.high > sweepReferencePrice + a * config.SWEEP_MIN_ATR;
      const returnedInside = candle.close < sweepReferencePrice;
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

  // Never use a confirmation candle that closed before the divergence itself
  // became confirmed. If the sweep happened earlier, wait for a fresh candle
  // after confirmIndex instead of demanding another sweep of the same level.
  const confirmationStart = Math.max(sweep.index + 1, divergence.confirmIndex + 1);
  const confirmationEnd = Math.min(
    candles.length - 1,
    confirmationStart + config.CONFIRMATION_MAX_BARS - 1
  );
  for (let i = confirmationStart; i <= confirmationEnd; i++) {
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
  if (candles.length - 1 >= confirmationStart + config.CONFIRMATION_MAX_BARS)
    return { expired: true, reason: "CONFIRMATION_EXPIRED" };
  return { pending: true, reason: "WAITING_CONFIRMATION" };
}

function coreLogic({ candles: rawCandles, config, now = Date.now(), rsiOverride = null }) {
  const candles = closed(rawCandles, now).slice(-config.HISTORY_CANDLES);
  const minimum = Math.max(
    config.HISTORY_CANDLES > 0 ? 60 : 0,
    config.RSI_PERIOD + config.PIVOT_LEFT_BARS + config.PIVOT_RIGHT_BARS + config.MAX_PIVOT_DISTANCE + 5,
    config.ATR_PERIOD + 2
  );
  if (candles.length < minimum) return { side: null, reason: "INSUFFICIENT_CLOSED_CANDLES" };
  const divergence = detectDivergence(candles, config, rsiOverride);
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
    sweepReferencePrice: divergence.sweepReferencePrice,
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
