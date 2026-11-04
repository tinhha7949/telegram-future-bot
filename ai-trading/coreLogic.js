"use strict";

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

function rsiSeries(closes, period = 14) {
  return closes.map((_, i) => i < period ? null : rsi(closes.slice(0, i + 1), period));
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(Number(c.high) - Number(c.low), Math.abs(Number(c.high) - Number(prev.close)), Math.abs(Number(c.low) - Number(prev.close))));
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
      ? { open: +c[1], high: +c[2], low: +c[3], close: +c[4], closeTime: +c[6] }
      : { open: +c.open, high: +c.high, low: +c.low, close: +c.close, closeTime: +(c.closeTime ?? c.time) })
    .filter(c => [c.high, c.low, c.close, c.closeTime].every(Number.isFinite));
}

function pivots(candles, left, right) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: c.high });
    if (isLow) lows.push({ index: i, price: c.low });
  }
  return { highs, lows };
}

function swingConfig(config, kind = "major") {
  const major = kind === "major";
  return {
    left: config[major ? "MAJOR_PIVOT_LEFT_BARS" : "MINOR_PIVOT_LEFT_BARS"] ?? config.PIVOT_LEFT_BARS,
    right: config[major ? "MAJOR_PIVOT_RIGHT_BARS" : "MINOR_PIVOT_RIGHT_BARS"] ?? config.PIVOT_RIGHT_BARS
  };
}

function marketStructure(candles, config, kind = "major") {
  const { left, right } = swingConfig(config, kind);
  const { highs, lows } = pivots(candles, left, right);
  if (highs.length < 2 || lows.length < 2) return { side: "RANGE", highs, lows, reason: "INSUFFICIENT_SWING_STRUCTURE", kind };
  const h1 = highs.at(-2).price, h2 = highs.at(-1).price;
  const l1 = lows.at(-2).price, l2 = lows.at(-1).price;
  if (h2 > h1 && l2 > l1) return { side: "UP", highs, lows, kind };
  if (h2 < h1 && l2 < l1) return { side: "DOWN", highs, lows, kind };
  return { side: "RANGE", highs, lows, reason: "NO_CLEAR_HH_HL_OR_LH_LL", kind };
}

function assessConfirmation(candles, bias, config) {
  const major = marketStructure(candles, config, "major");
  const minor = marketStructure(candles, config, "minor");
  const last = candles.at(-1);
  const lastHigh = major.highs?.at(-1), lastLow = major.lows?.at(-1);
  let state = "WEAKENING", event = "NONE";
  if (major.side === bias) {
    const priorHigh = major.highs.at(-2), priorLow = major.lows.at(-2);
    if (minor.side !== "RANGE" && minor.side !== bias) {
      state = "WEAKENING";
      event = "MINOR_COUNTER_STRUCTURE";
    } else {
      state = "CONTINUATION";
      if (bias === "UP" && last.close > priorHigh.price) event = "BOS";
      if (bias === "DOWN" && last.close < priorLow.price) event = "BOS";
    }
  } else if (major.side === (bias === "UP" ? "DOWN" : "UP")) {
    state = "REVERSAL";
    event = "CHoCH";
    if (bias === "UP" && last.close < lastLow.price) event = "BOS";
    if (bias === "DOWN" && last.close > lastHigh.price) event = "BOS";
  } else if (minor.side !== "RANGE" && minor.side !== bias) {
    state = "WEAKENING";
    event = "MINOR_COUNTER_STRUCTURE";
  }
  return { state, event, side: major.side, major, minor };
}

function regularDivergence(candles, config) {
  const { highs, lows } = pivots(candles, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const values = rsiSeries(candles.map(c => c.close), config.RSI_PERIOD);
  const within = p => candles.length - 1 - p.index <= config.DIVERGENCE_MAX_PIVOT_DISTANCE;
  const lowPairs = lows.filter(within).slice(-2);
  const highPairs = highs.filter(within).slice(-2);
  let bullish = false, bearish = false;
  if (lowPairs.length === 2) {
    const [a, b] = lowPairs, ra = values[a.index], rb = values[b.index];
    bullish = Number.isFinite(ra) && Number.isFinite(rb) && b.price < a.price && rb > ra;
  }
  if (highPairs.length === 2) {
    const [a, b] = highPairs, ra = values[a.index], rb = values[b.index];
    bearish = Number.isFinite(ra) && Number.isFinite(rb) && b.price > a.price && rb < ra;
  }
  return {
    bullish, bearish,
    swingLow: lows.filter(within).at(-1)?.price ?? null,
    swingHigh: highs.filter(within).at(-1)?.price ?? null
  };
}

function entryRsiTriggered(side, value, config) {
  if (!Number.isFinite(value)) return false;
  if (side === "LONG") return value >= config.ENTRY_RSI_LONG_MIN && value <= config.ENTRY_RSI_LONG_MAX;
  if (side === "SHORT") return value >= config.ENTRY_RSI_SHORT_MIN && value <= config.ENTRY_RSI_SHORT_MAX;
  return false;
}

function coreLogic({ trendCandles, entryCandles, divergenceCandles, confirmationCandles, slCandles, config, now = Date.now() }) {
  const trend = closed(trendCandles, now), entry = closed(entryCandles, now), divergence = closed(divergenceCandles, now), confirmation = confirmationCandles === undefined ? null : closed(confirmationCandles, now).slice(-config.CONFIRMATION_HISTORY_CANDLES), stopCandles = closed(slCandles, now);
  const minTrend = Math.max(config.STRUCTURE_LOOKBACK_CANDLES, config.TREND_HISTORY_CANDLES || 0);
  const minEntry = Math.max(config.RSI_PERIOD + 1, config.ATR_PERIOD + 1);
  const minConfirmation = config.CONFIRMATION_HISTORY_CANDLES;
  const minDivergence = Math.max(config.RSI_PERIOD + config.PIVOT_LEFT_BARS + config.PIVOT_RIGHT_BARS + 2, config.DIVERGENCE_LOOKBACK_CANDLES);
  if (trend.length < minTrend || entry.length < minEntry || (confirmation && confirmation.length < minConfirmation))
    return { side: null, reason: "INSUFFICIENT_CLOSED_CANDLES" };
  const price = trend.at(-1).close, entryPrice = entry.at(-1).close, valueRsi = rsi(entry.map(c => c.close), config.RSI_PERIOD), valueAtr = atr(entry, config.ATR_PERIOD);
  if (!(price > 0 && valueRsi != null && valueAtr > 0))
    return { side: null, reason: "INVALID_INDICATORS" };
  const structure = marketStructure(trend.slice(-config.STRUCTURE_LOOKBACK_CANDLES), config);
  const trendSide = structure.side;
  if (trendSide === "RANGE")
    return { side: null, reason: "TREND_STRUCTURE_NOT_CONFIRMED", trendSide, rsi: valueRsi, atr: valueAtr };
  let confirmationState = null;
  if (confirmation) {
    confirmationState = assessConfirmation(confirmation, trendSide, config);
    if (confirmationState.state !== "CONTINUATION")
      return { side: null, reason: confirmationState.state === "REVERSAL" ? "1H_MAJOR_STRUCTURE_REVERSAL" : "1H_STRUCTURE_WEAKENING", trendSide, confirmationState: confirmationState.state, confirmationEvent: confirmationState.event, confirmationSide: confirmationState.side, rsi: valueRsi, atr: valueAtr };
  }
  const side = trendSide === "UP" ? "LONG" : "SHORT";
  if (!entryRsiTriggered(side, valueRsi, config)) return { side: null, reason: "ENTRY_RSI_NOT_TRIGGERED", trendSide, rsi: valueRsi, atr: valueAtr };
  if (divergence.length < minDivergence)
    return { side: null, reason: "DIVERGENCE_HISTORY_REQUIRED", trendSide, rsi: valueRsi, atr: valueAtr };
  const div = regularDivergence(divergence.slice(-config.DIVERGENCE_LOOKBACK_CANDLES), config);
  const bullishBonus = trendSide === "UP" && div.bullish && div.swingLow > 0 && div.swingLow < entryPrice;
  const bearishBonus = trendSide === "DOWN" && div.bearish && div.swingHigh > entryPrice;
  if (stopCandles.length < config.SL_ATR_PERIOD + 1)
    return { side: null, reason: "SL_15M_HISTORY_REQUIRED", trendSide, rsi: valueRsi, atr: valueAtr };
  const stopAtr = atr(stopCandles, config.SL_ATR_PERIOD);
  if (!(stopAtr > 0))
    return { side: null, reason: "SL_ATR15_UNAVAILABLE", trendSide, rsi: valueRsi, atr: valueAtr };
  const stopSwings = pivots(stopCandles, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const validPivots = (side === "LONG" ? stopSwings.lows : stopSwings.highs)
    .filter(p => stopCandles.length - 1 - p.index <= config.SL_PIVOT_MAX_DISTANCE)
    .filter(p => side === "LONG" ? p.price < entryPrice : p.price > entryPrice);
  const pivotPrice = validPivots.at(-1)?.price ?? null;
  return {
    side, trendSide, rsi: valueRsi, atr: valueAtr,
    pivotPrice, slAtr15: stopAtr,
    signalAt: entry.at(-1).closeTime,
    divergence: bullishBonus ? "REGULAR_BULLISH" : bearishBonus ? "REGULAR_BEARISH" : null
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

module.exports = { rsi, rsiSeries, atr, closed, pivots, marketStructure, assessConfirmation, regularDivergence, entryRsiTriggered, marketVeto, coreLogic };
