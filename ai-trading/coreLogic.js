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

function classifyStructure(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return "RANGE";
  const h1 = highs.at(-2).price, h2 = highs.at(-1).price;
  const l1 = lows.at(-2).price, l2 = lows.at(-1).price;
  if (h2 > h1 && l2 > l1) return "UP";
  if (h2 < h1 && l2 < l1) return "DOWN";
  return "RANGE";
}

function marketStructure(candles, config, kind = "major") {
  const { left, right } = swingConfig(config, kind);
  const { highs, lows } = pivots(candles, left, right);
  const side = classifyStructure(highs, lows);
  return {
    side, highs, lows,
    ...(side === "RANGE" ? { reason: highs.length < 2 || lows.length < 2 ? "INSUFFICIENT_SWING_STRUCTURE" : "NO_CLEAR_HH_HL_OR_LH_LL" } : {}),
    kind
  };
}

// Replays confirmed pivots candle-by-candle. A pivot becomes usable only after
// its right-hand confirmation bars have closed; all breaks are close-only.
function analyzeMajorStructure(candles, left, right) {
  const detected = pivots(candles, left, right);
  const highConfirmations = new Map(), lowConfirmations = new Map();
  for (const p of detected.highs) {
    const at = p.index + right;
    if (!highConfirmations.has(at)) highConfirmations.set(at, []);
    highConfirmations.get(at).push(p);
  }
  for (const p of detected.lows) {
    const at = p.index + right;
    if (!lowConfirmations.has(at)) lowConfirmations.set(at, []);
    lowConfirmations.get(at).push(p);
  }

  const highs = [], lows = [];
  let side = null, phase = "NORMAL", transitionFrom = null, transitionAt = -1;
  let event = "NONE", eventAt = null, consumedHigh = -1, consumedLow = -1;
  let transitionLevel = null;

  for (let i = 0; i < candles.length; i++) {
    for (const p of highConfirmations.get(i) || []) highs.push(p);
    for (const p of lowConfirmations.get(i) || []) lows.push(p);
    const close = candles[i].close;
    const inferred = classifyStructure(highs, lows);
    if (!side && inferred !== "RANGE") side = inferred;

    if (phase === "TRANSITION") {
      if (transitionFrom === "UP") {
        const lowerHigh = highs.find((p, index) => {
          if (p.index <= transitionAt) return false;
          const previous = highs.slice(0, index).at(-1);
          return previous && p.price < previous.price;
        });
        if (lowerHigh) {
          const postLowerHighLow = lows.find(p => p.index > lowerHigh.index && p.index + right <= i);
          if (postLowerHighLow && close < postLowerHighLow.price) {
            side = "DOWN";
            phase = "NORMAL";
            transitionFrom = null;
            transitionLevel = null;
            consumedLow = postLowerHighLow.index;
            event = "BOS";
            eventAt = i;
            continue;
          }
        }
      } else if (transitionFrom === "DOWN") {
        const higherLow = lows.find((p, index) => {
          if (p.index <= transitionAt) return false;
          const previous = lows.slice(0, index).at(-1);
          return previous && p.price > previous.price;
        });
        if (higherLow) {
          const postHigherLowHigh = highs.find(p => p.index > higherLow.index && p.index + right <= i);
          if (postHigherLowHigh && close > postHigherLowHigh.price) {
            side = "UP";
            phase = "NORMAL";
            transitionFrom = null;
            transitionLevel = null;
            consumedHigh = postHigherLowHigh.index;
            event = "BOS";
            eventAt = i;
            continue;
          }
        }
      }
      continue;
    }

    if (side === "UP") {
      const lastLow = lows.at(-1), priorLow = lows.at(-2), lastHigh = highs.at(-1);
      const protectedLow = lastLow && priorLow && lastLow.price > priorLow.price ? lastLow : null;
      if (protectedLow && close < protectedLow.price) {
        phase = "TRANSITION";
        transitionFrom = "UP";
        transitionAt = i;
        transitionLevel = protectedLow.price;
        event = "CHoCH";
        eventAt = i;
      } else if (lastHigh && close > lastHigh.price && consumedHigh !== lastHigh.index) {
        consumedHigh = lastHigh.index;
        event = "BOS";
        eventAt = i;
      }
    } else if (side === "DOWN") {
      const lastHigh = highs.at(-1), priorHigh = highs.at(-2), lastLow = lows.at(-1);
      const protectedHigh = lastHigh && priorHigh && lastHigh.price < priorHigh.price ? lastHigh : null;
      if (protectedHigh && close > protectedHigh.price) {
        phase = "TRANSITION";
        transitionFrom = "DOWN";
        transitionAt = i;
        transitionLevel = protectedHigh.price;
        event = "CHoCH";
        eventAt = i;
      } else if (lastLow && close < lastLow.price && consumedLow !== lastLow.index) {
        consumedLow = lastLow.index;
        event = "BOS";
        eventAt = i;
      }
    }
  }

  return {
    side: phase === "TRANSITION" ? transitionFrom : side || "RANGE",
    state: phase,
    event: eventAt === candles.length - 1 ? event : "NONE",
    lastEvent: event,
    eventAt,
    transitionFrom,
    transitionLevel,
    highs,
    lows,
    kind: "major"
  };
}

function assessConfirmation(candles, bias, config) {
  const left = config.CONFIRMATION_PIVOT_LEFT_BARS;
  const right = config.CONFIRMATION_PIVOT_RIGHT_BARS;
  const major = analyzeMajorStructure(candles, left, right);
  let state = "WEAKENING";
  if (major.state === "TRANSITION") state = "TRANSITION";
  else if (major.side === bias) state = "CONTINUATION";
  else if (major.side === (bias === "UP" ? "DOWN" : "UP")) state = "REVERSAL";
  return { state, event: major.event, side: major.side, major, minor: null };
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

function coreLogic({ trendCandles, entryCandles, divergenceCandles, confirmationCandles, slCandles, config, now = Date.now() }) {
  const trend = closed(trendCandles, now), entry = closed(entryCandles, now), divergence = closed(divergenceCandles, now), confirmation = confirmationCandles === undefined ? null : closed(confirmationCandles, now).slice(-config.CONFIRMATION_HISTORY_CANDLES), stopCandles = closed(slCandles, now);
  const minTrend = Math.max(config.STRUCTURE_LOOKBACK_CANDLES, config.TREND_HISTORY_CANDLES || 0);
  const minEntry = Math.max(config.ENTRY_STRUCTURE_LOOKBACK_CANDLES, config.PIVOT_LEFT_BARS + config.PIVOT_RIGHT_BARS + 5);
  const minConfirmation = config.CONFIRMATION_HISTORY_CANDLES;
  const minDivergence = Math.max(config.RSI_PERIOD + config.PIVOT_LEFT_BARS + config.PIVOT_RIGHT_BARS + 2, config.DIVERGENCE_LOOKBACK_CANDLES);
  if (trend.length < minTrend || entry.length < minEntry || (confirmation && confirmation.length < minConfirmation))
    return { side: null, reason: "INSUFFICIENT_CLOSED_CANDLES" };
  const price = trend.at(-1).close, entryPrice = entry.at(-1).close;
  if (!(price > 0 && entryPrice > 0))
    return { side: null, reason: "INVALID_PRICE_DATA" };
  const trendWindow = trend.slice(-config.STRUCTURE_LOOKBACK_CANDLES);
  const trendStructure = analyzeMajorStructure(trendWindow, config.MAJOR_PIVOT_LEFT_BARS, config.MAJOR_PIVOT_RIGHT_BARS);
  const structure = marketStructure(trendWindow, config);
  const trendSide = trendStructure.side;
  if (trendStructure.state === "TRANSITION")
    return { side: null, reason: "4H_STRUCTURE_TRANSITION", trendSide, trendEvent: trendStructure.event, transitionFrom: trendStructure.transitionFrom, transitionLevel: trendStructure.transitionLevel };
  if (trendSide === "RANGE")
    return { side: null, reason: "TREND_STRUCTURE_NOT_CONFIRMED", trendSide, trendEvent: trendStructure.event };
  let confirmationState = null;
  if (confirmation) {
    confirmationState = assessConfirmation(confirmation, trendSide, config);
    if (confirmationState.state !== "CONTINUATION")
      return { side: null, reason: confirmationState.state === "TRANSITION" ? "1H_STRUCTURE_TRANSITION" : confirmationState.state === "REVERSAL" ? "1H_MAJOR_STRUCTURE_REVERSAL" : "1H_STRUCTURE_WEAKENING", trendSide, trendEvent: trendStructure.event, confirmationState: confirmationState.state, confirmationEvent: confirmationState.event, confirmationSide: confirmationState.side };
  }
  // Entry is entirely price-structure based: a confirmed HL/LH pullback followed by a close-only break of the prior swing.
  const entryWindow = entry.slice(-config.ENTRY_STRUCTURE_LOOKBACK_CANDLES);
  const entrySwings = pivots(entryWindow, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const lastEntryHigh = entrySwings.highs.at(-1), priorEntryHigh = entrySwings.highs.at(-2);
  const lastEntryLow = entrySwings.lows.at(-1), priorEntryLow = entrySwings.lows.at(-2);
  const longStructure = !!(priorEntryLow && lastEntryHigh && lastEntryLow &&
    priorEntryLow.index < lastEntryHigh.index && lastEntryHigh.index < lastEntryLow.index &&
    lastEntryLow.price > priorEntryLow.price && entryPrice > lastEntryHigh.price);
  const shortStructure = !!(priorEntryHigh && lastEntryLow && lastEntryHigh &&
    priorEntryHigh.index < lastEntryLow.index && lastEntryLow.index < lastEntryHigh.index &&
    lastEntryHigh.price < priorEntryHigh.price && entryPrice < lastEntryLow.price);
  const side = trendSide === "UP" ? "LONG" : "SHORT";
  if (side === "LONG" && !longStructure) return { side: null, reason: "ENTRY_STRUCTURE_NOT_CONFIRMED", trendSide, entryStructure: "WAIT_HL_AND_BOS" };
  if (side === "SHORT" && !shortStructure) return { side: null, reason: "ENTRY_STRUCTURE_NOT_CONFIRMED", trendSide, entryStructure: "WAIT_LH_AND_BOS" };
  if (divergence.length < minDivergence)
    return { side: null, reason: "DIVERGENCE_HISTORY_REQUIRED", trendSide, entryStructure: side === "LONG" ? "HL_BOS" : "LH_BOS" };
  const div = regularDivergence(divergence.slice(-config.DIVERGENCE_LOOKBACK_CANDLES), config);
  const bullishBonus = trendSide === "UP" && div.bullish && div.swingLow > 0 && div.swingLow < entryPrice;
  const bearishBonus = trendSide === "DOWN" && div.bearish && div.swingHigh > entryPrice;
  if (stopCandles.length < config.SL_ATR_PERIOD + 1)
    return { side: null, reason: "SL_CANDLE_HISTORY_REQUIRED", trendSide };
  const stopAtr = atr(stopCandles, config.SL_ATR_PERIOD);
  if (!(stopAtr > 0))
    return { side: null, reason: "SL_ATR_UNAVAILABLE", trendSide };
  const stopSwings = pivots(stopCandles, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const validPivots = (side === "LONG" ? stopSwings.lows : stopSwings.highs)
    .filter(p => stopCandles.length - 1 - p.index <= config.SL_PIVOT_MAX_DISTANCE)
    .filter(p => side === "LONG" ? p.price < entryPrice : p.price > entryPrice);
  const pivotPrice = validPivots.at(-1)?.price ?? null;
  return {
    side, trendSide,
    entryStructure: side === "LONG" ? "HL_BOS" : "LH_BOS",
    entrySwingLevel: side === "LONG" ? lastEntryHigh.price : lastEntryLow.price,
    pullbackPivotPrice: side === "LONG" ? lastEntryLow.price : lastEntryHigh.price,
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

module.exports = { rsi, rsiSeries, atr, closed, pivots, marketStructure, analyzeMajorStructure, assessConfirmation, regularDivergence, marketVeto, coreLogic };
