"use strict";
const { ema, rsi, atr, findSwing } = require("./indicators");
function evaluateTrend(candles, cfg) {
  const closes = candles.map(c => c.close), value = ema(closes, cfg.emaPeriod);
  if (value == null) return null;
  const close = closes[closes.length - 1];
  return close > value ? "LONG" : close < value ? "SHORT" : null;
}
function evaluateClosedCandle({ trendCandles, entryCandles, setup, config, now = Date.now() }) {
  const s = config.strategy;
  if (trendCandles.length < s.emaPeriod + 2 || entryCandles.length < Math.max(s.rsiPeriod + 2, s.atrPeriod + 2)) return { action: "WAIT", reason: "INSUFFICIENT_CANDLES" };
  const trend = evaluateTrend(trendCandles, s), closes = entryCandles.map(c => c.close);
  const currentRsi = rsi(closes, s.rsiPeriod), previousRsi = rsi(closes.slice(0, -1), s.rsiPeriod);
  const candle = entryCandles[entryCandles.length - 1];
  if (!Number.isFinite(currentRsi)) return { action: "WAIT", reason: "RSI_UNAVAILABLE" };
  if (setup && setup.status === "ARMED") {
    const age = entryCandles.filter(c => c.closeTime > setup.triggerCloseTime).length;
    if (age > s.confirmationCandles) return { action: "CANCEL", reason: "SETUP_EXPIRED" };
    if (trend !== setup.side) return { action: "CANCEL", reason: "TREND_CHANGED" };
    const momentumTurn = setup.side === "SHORT"
      ? previousRsi != null && previousRsi >= s.rsiShortTrigger && currentRsi < s.rsiShortTrigger
      : previousRsi != null && previousRsi <= s.rsiLongTrigger && currentRsi > s.rsiLongTrigger;
    const momentumTurnSeen = Boolean(setup.momentumTurnSeen || momentumTurn);
    const momentumOk = !s.requireRsiMomentumTurn || momentumTurnSeen;
    const broken = setup.side === "SHORT" ? candle.close < setup.triggerLow : candle.close > setup.triggerHigh;
    if (broken && momentumOk) {
      const a = atr(entryCandles, s.atrPeriod);
      const swing = findSwing(entryCandles.slice(0, -1), setup.side, s.swingLeft, s.swingRight, s.swingLookback);
      const buffer = candle.close * s.slBufferPct / 100;
      let stop = setup.side === "SHORT"
        ? (swing != null && swing > candle.close ? swing + buffer : candle.close + (a || candle.close * .01) * s.fallbackAtrMultiple)
        : (swing != null && swing < candle.close ? swing - buffer : candle.close - (a || candle.close * .01) * s.fallbackAtrMultiple);
      const distancePct = Math.abs(stop - candle.close) / candle.close * 100;
      if (distancePct < s.minStopDistancePct) stop = setup.side === "SHORT" ? candle.close * (1 + s.minStopDistancePct / 100) : candle.close * (1 - s.minStopDistancePct / 100);
      if (Math.abs(stop - candle.close) / candle.close * 100 > s.maxStopDistancePct) return { action: "CANCEL", reason: "STOP_TOO_WIDE" };
      const risk = Math.abs(stop - candle.close), direction = setup.side === "LONG" ? 1 : -1;
      return { action: "ENTRY", side: setup.side, entry: candle.close, stop, risk,
        tp1: candle.close + direction * risk * s.rewardRiskTp1,
        tp2: candle.close + direction * risk * s.rewardRiskTp2,
        rsi: currentRsi, triggerTime: setup.triggerCloseTime, confirmationTime: candle.closeTime };
    }
    return { action: "KEEP", setup: { ...setup, momentumTurnSeen, lastCheckedCloseTime: candle.closeTime, confirmationCount: age }, rsi: currentRsi };
  }
  if (!trend) return { action: "WAIT", reason: "NO_TREND" };
  if (trend === "SHORT" && currentRsi >= s.rsiShortTrigger) {
    return { action: "ARM", setup: { side: "SHORT", status: "ARMED", triggerLow: candle.low, triggerHigh: candle.high, triggerCloseTime: candle.closeTime, createdAt: now, confirmationCount: 0 }, rsi: currentRsi };
  }
  if (trend === "LONG" && currentRsi <= s.rsiLongTrigger) {
    return { action: "ARM", setup: { side: "LONG", status: "ARMED", triggerLow: candle.low, triggerHigh: candle.high, triggerCloseTime: candle.closeTime, createdAt: now, confirmationCount: 0 }, rsi: currentRsi };
  }
  return { action: "WAIT", reason: "NO_TRIGGER", rsi: currentRsi, previousRsi };
}
module.exports = { evaluateTrend, evaluateClosedCandle };
