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

// Find the most recent close-only break of a confirmed protected HL/LH.
// The event is replayed from candle history on every scan, so a temporary
// reclaim cannot erase a CHoCH while the bot process is running.
function latestProtectedBreak(bars, highs, lows, right) {
  let latest = null;
  const scan = (list, direction) => {
    for (let i = 1; i < list.length; i++) {
      const previous = list[i - 1], pivot = list[i];
      const isProtected = direction === "UP"
        ? pivot.price > previous.price
        : pivot.price < previous.price;
      if (!isProtected) continue;
      const confirmIndex = pivot.index + right;
      for (let j = Math.max(1, confirmIndex + 1); j < bars.length; j++) {
        const before = Number(bars[j - 1].close), close = Number(bars[j].close);
        const crossed = direction === "UP"
          ? before >= pivot.price && close < pivot.price
          : before <= pivot.price && close > pivot.price;
        if (crossed) {
          if (!latest || j > latest.index) {
            latest = {
              from: direction, to: direction === "UP" ? "DOWN" : "UP",
              index: j, eventAt: Number(bars[j].closeTime ?? bars[j].time),
              level: pivot.price, pivotIndex: pivot.index
            };
          }
          break;
        }
      }
    }
  };
  scan(lows, "UP");
  scan(highs, "DOWN");
  return latest;
}

// After CHoCH, require a fresh opposite-side swing structure and a later
// close through its post-CHoCH swing level before declaring reversal.
// The same-side path requires a fresh protected swing and BOS to clear a
// transition after price reclaims the old protected level.
function postBreakBos(bars, highs, lows, breakEvent, direction, right) {
  const after = breakEvent.index;
  if (direction === "DOWN") {
    const lowerHigh = highs.find((p, i) => p.index > after && i > 0 && p.price < highs[i - 1].price);
    if (!lowerHigh || lowerHigh.index + right >= bars.length) return null;
    for (const low of lows) {
      const confirmedAt = low.index + right;
      if (low.index <= after || low.index <= lowerHigh.index + right || confirmedAt >= bars.length - 1) continue;
      for (let i = confirmedAt + 1; i < bars.length; i++) {
        const prev = Number(bars[i - 1].close), close = Number(bars[i].close);
        if (prev >= low.price && close < low.price)
          return { index: i, eventAt: Number(bars[i].closeTime ?? bars[i].time), level: low.price };
      }
    }
    return null;
  }
  const higherLow = lows.find((p, i) => p.index > after && i > 0 && p.price > lows[i - 1].price);
  if (!higherLow || higherLow.index + right >= bars.length) return null;
  for (const high of highs) {
    const confirmedAt = high.index + right;
    if (high.index <= after || high.index <= higherLow.index + right || confirmedAt >= bars.length - 1) continue;
    for (let i = confirmedAt + 1; i < bars.length; i++) {
      const prev = Number(bars[i - 1].close), close = Number(bars[i].close);
      if (prev <= high.price && close > high.price)
        return { index: i, eventAt: Number(bars[i].closeTime ?? bars[i].time), level: high.price };
    }
  }
  return null;
}

function analyzeMajorStructure(candles, left, right, previousState = null) {
  const bars = Array.isArray(candles) ? candles : [];
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 1 || right < 1) {
    return { side: "RANGE", state: "UNCLEAR", event: "NONE", lastEvent: "NONE", eventAt: null, transitionFrom: null, transitionLevel: null, highs: [], lows: [], kind: "major" };
  }
  const { highs, lows } = pivots(bars, left, right);
  const rawSide = classifyStructure(highs, lows);
  const last = bars.at(-1);
  const lastClose = Number(last?.close);
  if (!Number.isFinite(lastClose)) {
    return { side: "RANGE", state: "UNCLEAR", event: "NONE", lastEvent: "NONE", eventAt: null, transitionFrom: null, transitionLevel: null, highs, lows, kind: "major" };
  }

  const detectedBreak = latestProtectedBreak(bars, highs, lows, right);
  let broken = detectedBreak;
  if (previousState?.state === "TRANSITION" &&
      ["UP", "DOWN"].includes(previousState.from) &&
      Number.isFinite(Number(previousState.eventAt)) &&
      Number.isFinite(Number(previousState.level))) {
    const previousIndex = bars.findIndex(b => Number(b.closeTime ?? b.time) >= Number(previousState.eventAt));
    const persistedBreak = {
      from: previousState.from,
      to: previousState.from === "UP" ? "DOWN" : "UP",
      index: previousIndex,
      eventAt: Number(previousState.eventAt),
      level: Number(previousState.level),
      pivotIndex: -1
    };
    if (!broken || persistedBreak.eventAt > broken.eventAt) broken = persistedBreak;
  }

  if (!broken) {
    return {
      side: rawSide, state: rawSide === "RANGE" ? "UNCLEAR" : "NORMAL",
      event: "NONE", lastEvent: "NONE", eventAt: null,
      transitionFrom: null, transitionLevel: null, highs, lows, kind: "major"
    };
  }

  const reversalBos = postBreakBos(bars, highs, lows, broken, broken.to, right);
  if (reversalBos && rawSide === broken.to) {
    return {
      side: broken.to, state: "NORMAL", event: "BOS", lastEvent: "BOS",
      eventAt: reversalBos.eventAt, transitionFrom: null, transitionLevel: null,
      highs, lows, kind: "major"
    };
  }

  const recoveryBos = postBreakBos(bars, highs, lows, broken, broken.from, right);
  if (recoveryBos && rawSide === broken.from) {
    return {
      side: broken.from, state: "NORMAL", event: "BOS", lastEvent: "BOS",
      eventAt: recoveryBos.eventAt, transitionFrom: null, transitionLevel: null,
      highs, lows, kind: "major"
    };
  }

  return {
    side: broken.from, state: "TRANSITION", event: "CHoCH", lastEvent: "CHoCH",
    eventAt: broken.eventAt, transitionFrom: broken.from,
    transitionLevel: broken.level, highs, lows, kind: "major"
  };
}
function assessConfirmation(candles, bias, config, previousState = null) {
  const major = analyzeMajorStructure(candles, config.CONFIRMATION_PIVOT_LEFT_BARS, config.CONFIRMATION_PIVOT_RIGHT_BARS, previousState);
  let state = "WEAKENING";
  if (major.state === "TRANSITION") state = "TRANSITION";
  else if (major.side === bias) state = "CONTINUATION";
  else if (major.side !== "RANGE") state = "REVERSAL";
  return { state, event: major.event, side: major.side, major, minor: null };
}

function coreLogic({ trendCandles, entryCandles, confirmationCandles, slCandles, config, structureState = null, now = Date.now() }) {
  const trend = closed(trendCandles, now), entry = closed(entryCandles, now), confirmation = confirmationCandles === undefined ? null : closed(confirmationCandles, now).slice(-config.CONFIRMATION_HISTORY_CANDLES), stopCandles = closed(slCandles, now);
  const minTrend = Math.max(config.STRUCTURE_LOOKBACK_CANDLES, config.TREND_HISTORY_CANDLES || 0);
  const minEntry = Math.max(config.ENTRY_STRUCTURE_LOOKBACK_CANDLES, config.PIVOT_LEFT_BARS + config.PIVOT_RIGHT_BARS + 5);
  const minConfirmation = config.CONFIRMATION_HISTORY_CANDLES;
  if (trend.length < minTrend || entry.length < minEntry || (confirmation && confirmation.length < minConfirmation))
    return { side: null, reason: "INSUFFICIENT_CLOSED_CANDLES", structureState };
  const price = trend.at(-1).close, entryPrice = entry.at(-1).close;
  if (!(price > 0 && entryPrice > 0))
    return { side: null, reason: "INVALID_PRICE_DATA", structureState };
  const trendWindow = trend.slice(-config.STRUCTURE_LOOKBACK_CANDLES);
  const trendStructure = analyzeMajorStructure(trendWindow, config.MAJOR_PIVOT_LEFT_BARS, config.MAJOR_PIVOT_RIGHT_BARS, structureState?.trend);
  const structure = marketStructure(trendWindow, config);
  const trendSide = trendStructure.side;
  const trendTransition = trendStructure.state === "TRANSITION"
    ? { state: "TRANSITION", from: trendStructure.transitionFrom, level: trendStructure.transitionLevel, eventAt: trendStructure.eventAt }
    : null;
  if (trendStructure.state === "TRANSITION")
    return { side: null, reason: "4H_STRUCTURE_TRANSITION", trendSide, trendEvent: trendStructure.event, transitionFrom: trendStructure.transitionFrom, transitionLevel: trendStructure.transitionLevel, structureState: { trend: trendTransition, confirmation: structureState?.confirmation || null } };
  if (trendSide === "RANGE")
    return { side: null, reason: "TREND_STRUCTURE_NOT_CONFIRMED", trendSide, trendEvent: trendStructure.event, structureState: null };
  let confirmationState = null;
  if (confirmation) {
    confirmationState = assessConfirmation(confirmation, trendSide, config, structureState?.confirmation);
    const confirmationTransition = confirmationState.major.state === "TRANSITION"
      ? { state: "TRANSITION", from: confirmationState.major.transitionFrom, level: confirmationState.major.transitionLevel, eventAt: confirmationState.major.eventAt }
      : null;
    if (confirmationState.state !== "CONTINUATION")
      return { side: null, reason: confirmationState.state === "TRANSITION" ? "1H_STRUCTURE_TRANSITION" : confirmationState.state === "REVERSAL" ? "1H_MAJOR_STRUCTURE_REVERSAL" : "1H_STRUCTURE_WEAKENING", trendSide, trendEvent: trendStructure.event, confirmationState: confirmationState.state, confirmationEvent: confirmationState.event, confirmationSide: confirmationState.side, structureState: confirmationTransition ? { trend: null, confirmation: confirmationTransition } : null };
  }
  const nextStructureState = null;
  // Require a confirmed pullback, a close-only BOS, a later level retest,
  // and a prompt continuation. A breakout candle cannot double as retest.
  const entryWindow = entry.slice(-config.ENTRY_STRUCTURE_LOOKBACK_CANDLES);
  const entrySwings = pivots(entryWindow, config.PIVOT_LEFT_BARS, config.PIVOT_RIGHT_BARS);
  const side = trendSide === "UP" ? "LONG" : "SHORT";
  const entryAtr = atr(entryWindow, config.ENTRY_ATR_PERIOD);
  if (!(entryAtr > 0)) return { side: null, reason: "ENTRY_ATR_UNAVAILABLE", trendSide, structureState: nextStructureState };
  let setup = null;
  if (side === "LONG") {
    for (let li = entrySwings.lows.length - 1; li >= 1 && !setup; li--) {
      const priorLow = entrySwings.lows[li - 1], pullbackLow = entrySwings.lows[li];
      if (!(pullbackLow.price > priorLow.price)) continue;
      const swingHigh = entrySwings.highs.filter(p => p.index > priorLow.index && p.index < pullbackLow.index).at(-1);
      if (!swingHigh) continue;
      // Both the pullback HL and the BOS reference high must be confirmed
      // before the breakout candle; do not use pivots that were unknowable then.
      const bosReadyIndex = Math.max(
        pullbackLow.index + config.PIVOT_RIGHT_BARS,
        swingHigh.index + config.PIVOT_RIGHT_BARS
      );
      let bosIndex = -1;
      for (let i = bosReadyIndex + 1; i < entryWindow.length; i++) {
        if (entryWindow[i - 1].close <= swingHigh.price && entryWindow[i].close > swingHigh.price) {
          bosIndex = i;
          break;
        }
      }
      if (bosIndex < 0) continue;
      for (let i = bosIndex + 1; i <= Math.min(entryWindow.length - 2, bosIndex + config.ENTRY_RETEST_MAX_BARS); i++) {
        const c = entryWindow[i];
        const maxPenetration = entryAtr * config.ENTRY_RETEST_MAX_PENETRATION_ATR;
        if (c.low <= swingHigh.price + entryAtr * config.ENTRY_RETEST_TOLERANCE_ATR &&
            c.low >= swingHigh.price - maxPenetration &&
            c.close >= swingHigh.price &&
            entryWindow.length - 1 - i <= config.ENTRY_CONTINUATION_MAX_BARS &&
            entryWindow.at(-1).close > c.high) {
          setup = { level: swingHigh.price, pullback: pullbackLow.price, retestIndex: i, bosIndex }; break;
        }
      }
    }
  } else {
    for (let hi = entrySwings.highs.length - 1; hi >= 1 && !setup; hi--) {
      const priorHigh = entrySwings.highs[hi - 1], pullbackHigh = entrySwings.highs[hi];
      if (!(pullbackHigh.price < priorHigh.price)) continue;
      const swingLow = entrySwings.lows.filter(p => p.index > priorHigh.index && p.index < pullbackHigh.index).at(-1);
      if (!swingLow) continue;
      // Symmetric SHORT rule: confirmed LH and reference low before BOS.
      const bosReadyIndex = Math.max(
        pullbackHigh.index + config.PIVOT_RIGHT_BARS,
        swingLow.index + config.PIVOT_RIGHT_BARS
      );
      let bosIndex = -1;
      for (let i = bosReadyIndex + 1; i < entryWindow.length; i++) {
        if (entryWindow[i - 1].close >= swingLow.price && entryWindow[i].close < swingLow.price) {
          bosIndex = i;
          break;
        }
      }
      if (bosIndex < 0) continue;
      for (let i = bosIndex + 1; i <= Math.min(entryWindow.length - 2, bosIndex + config.ENTRY_RETEST_MAX_BARS); i++) {
        const c = entryWindow[i];
        const maxPenetration = entryAtr * config.ENTRY_RETEST_MAX_PENETRATION_ATR;
        if (c.high >= swingLow.price - entryAtr * config.ENTRY_RETEST_TOLERANCE_ATR &&
            c.high <= swingLow.price + maxPenetration &&
            c.close <= swingLow.price &&
            entryWindow.length - 1 - i <= config.ENTRY_CONTINUATION_MAX_BARS &&
            entryWindow.at(-1).close < c.low) {
          setup = { level: swingLow.price, pullback: pullbackHigh.price, retestIndex: i, bosIndex }; break;
        }
      }
    }
  }
  if (!setup) return { side: null, reason: "ENTRY_BOS_RETEST_NOT_CONFIRMED", trendSide, entryStructure: "WAIT_BOS_RETEST_CONTINUATION", structureState: nextStructureState };
  const extension = side === "LONG" ? entryPrice - setup.level : setup.level - entryPrice;
  if (extension < 0 || extension > entryAtr * config.ENTRY_MAX_EXTENSION_ATR)
    return { side: null, reason: "ENTRY_TOO_EXTENDED_FROM_RETEST", trendSide, entryLevel: setup.level, extensionAtr: extension / entryAtr, structureState: nextStructureState };
  if (stopCandles.length < config.SL_ATR_PERIOD + 1)
    return { side: null, reason: "SL_CANDLE_HISTORY_REQUIRED", trendSide, structureState: nextStructureState };
  const stopAtr = atr(stopCandles, config.SL_ATR_PERIOD);
  if (!(stopAtr > 0))
    return { side: null, reason: "SL_ATR_UNAVAILABLE", trendSide, structureState: nextStructureState };
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
    signalAt: entry.at(-1).closeTime,
    structureState: nextStructureState
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
