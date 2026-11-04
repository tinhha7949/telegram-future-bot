"use strict";

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
  // Re-evaluate direction from the latest confirmed major pivots every scan.
  const { highs, lows } = pivots(candles, left, right);
  const side = classifyStructure(highs, lows);
  return { side, state: side === "RANGE" ? "UNCLEAR" : "NORMAL", event: "NONE", lastEvent: "NONE", eventAt: null, transitionFrom: null, transitionLevel: null, highs, lows, kind: "major" };
}

function assessConfirmation(candles, bias, config) {
  const major = analyzeMajorStructure(candles, config.CONFIRMATION_PIVOT_LEFT_BARS, config.CONFIRMATION_PIVOT_RIGHT_BARS);
  let state = "WEAKENING";
  if (major.side === bias) state = "CONTINUATION";
  else if (major.side !== "RANGE") state = "REVERSAL";
  return { state, event: major.event, side: major.side, major, minor: null };
}

function coreLogic({ trendCandles, entryCandles, confirmationCandles, slCandles, config, now = Date.now() }) {
  const trend = closed(trendCandles, now), entry = closed(entryCandles, now), confirmation = confirmationCandles === undefined ? null : closed(confirmationCandles, now).slice(-config.CONFIRMATION_HISTORY_CANDLES), stopCandles = closed(slCandles, now);
  const minTrend = Math.max(config.STRUCTURE_LOOKBACK_CANDLES, config.TREND_HISTORY_CANDLES || 0);
  const minEntry = Math.max(config.ENTRY_STRUCTURE_LOOKBACK_CANDLES, config.PIVOT_LEFT_BARS + config.PIVOT_RIGHT_BARS + 5);
  const minConfirmation = config.CONFIRMATION_HISTORY_CANDLES;
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
  // Require a confirmed pullback, a close-only BOS, a later level retest,
  // and a prompt continuation. A breakout candle cannot double as retest.
  const entryWindow = entry.slice(-config.ENTRY_STRUCTURE_LOOKBACK_CANDLES);
  const entrySwings = pivots(entryWindow, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const side = trendSide === "UP" ? "LONG" : "SHORT";
  const entryAtr = atr(entryWindow, config.ENTRY_ATR_PERIOD);
  if (!(entryAtr > 0)) return { side: null, reason: "ENTRY_ATR_UNAVAILABLE", trendSide };
  let setup = null;
  if (side === "LONG") {
    for (let li = entrySwings.lows.length - 1; li >= 1 && !setup; li--) {
      const priorLow = entrySwings.lows[li - 1], pullbackLow = entrySwings.lows[li];
      if (!(pullbackLow.price > priorLow.price)) continue;
      const swingHigh = entrySwings.highs.filter(p => p.index > priorLow.index && p.index < pullbackLow.index).at(-1);
      if (!swingHigh) continue;
      let bosIndex = -1;
      for (let i = pullbackLow.index + 1; i < entryWindow.length; i++)
        if (entryWindow[i - 1].close <= swingHigh.price && entryWindow[i].close > swingHigh.price) { bosIndex = i; break; }
      if (bosIndex < 0) continue;
      for (let i = bosIndex + 1; i <= Math.min(entryWindow.length - 2, bosIndex + config.ENTRY_RETEST_MAX_BARS); i++) {
        const c = entryWindow[i];
        if (c.low <= swingHigh.price + entryAtr * config.ENTRY_RETEST_TOLERANCE_ATR &&
            c.close >= swingHigh.price &&
            entryWindow.length - 1 - i <= config.ENTRY_CONTINUATION_MAX_BARS &&
            entryWindow.at(-1).close > c.high) {
          setup = { level: swingHigh.price, pullback: pullbackLow.price, retestIndex: i }; break;
        }
      }
    }
  } else {
    for (let hi = entrySwings.highs.length - 1; hi >= 1 && !setup; hi--) {
      const priorHigh = entrySwings.highs[hi - 1], pullbackHigh = entrySwings.highs[hi];
      if (!(pullbackHigh.price < priorHigh.price)) continue;
      const swingLow = entrySwings.lows.filter(p => p.index > priorHigh.index && p.index < pullbackHigh.index).at(-1);
      if (!swingLow) continue;
      let bosIndex = -1;
      for (let i = pullbackHigh.index + 1; i < entryWindow.length; i++)
        if (entryWindow[i - 1].close >= swingLow.price && entryWindow[i].close < swingLow.price) { bosIndex = i; break; }
      if (bosIndex < 0) continue;
      for (let i = bosIndex + 1; i <= Math.min(entryWindow.length - 2, bosIndex + config.ENTRY_RETEST_MAX_BARS); i++) {
        const c = entryWindow[i];
        if (c.high >= swingLow.price - entryAtr * config.ENTRY_RETEST_TOLERANCE_ATR &&
            c.close <= swingLow.price &&
            entryWindow.length - 1 - i <= config.ENTRY_CONTINUATION_MAX_BARS &&
            entryWindow.at(-1).close < c.low) {
          setup = { level: swingLow.price, pullback: pullbackHigh.price, retestIndex: i }; break;
        }
      }
    }
  }
  if (!setup) return { side: null, reason: "ENTRY_BOS_RETEST_NOT_CONFIRMED", trendSide, entryStructure: "WAIT_BOS_RETEST_CONTINUATION" };
  const extension = side === "LONG" ? entryPrice - setup.level : setup.level - entryPrice;
  if (extension < 0 || extension > entryAtr * config.ENTRY_MAX_EXTENSION_ATR)
    return { side: null, reason: "ENTRY_TOO_EXTENDED_FROM_RETEST", trendSide, entryLevel: setup.level, extensionAtr: extension / entryAtr };
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
    entryStructure: side === "LONG" ? "HL_BOS_RETEST" : "LH_BOS_RETEST",
    entrySwingLevel: setup.level,
    pullbackPivotPrice: setup.pullback,
    entryRetestIndex: setup.retestIndex,
    pivotPrice, slAtr: stopAtr,
    signalAt: entry.at(-1).closeTime
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

module.exports = { atr, closed, pivots, marketStructure, analyzeMajorStructure, assessConfirmation, marketVeto, coreLogic };
