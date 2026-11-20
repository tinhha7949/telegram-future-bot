"use strict";
const { rsi, atr, findSwing } = require("./indicators");

function evaluateClosedCandle({ candles, setup, config, now = Date.now() }) {
  const s = config.strategy;
  const minimumHistory = Math.max(s.rsiPeriod + 1, s.atrPeriod + 1, s.swingLeft + s.swingRight + 1);
  if (!Array.isArray(candles) || candles.length < minimumHistory) {
    return { action: "WAIT", reason: "INSUFFICIENT_CANDLES" };
  }

  const closes = candles.map(c => c.close);
  const currentRsi = rsi(closes, s.rsiPeriod);
  const candle = candles[candles.length - 1];
  if (!Number.isFinite(currentRsi)) return { action: "WAIT", reason: "RSI_UNAVAILABLE" };

  if (setup && setup.status === "ARMED") {
    // Discard setups created by the previous multi-timeframe strategy or another timeframe.
    if (setup.strategyVersion !== 3 || setup.timeframe !== s.timeframe) {
      return { action: "CANCEL", reason: "STALE_SETUP_VERSION_OR_TIMEFRAME" };
    }

    const age = candles.filter(c => c.closeTime > setup.triggerCloseTime).length;
    if (age === 0) {
      return { action: "KEEP", setup, rsi: currentRsi };
    }
    if (age > s.maxConfirmationCandles) return { action: "CANCEL", reason: "CONFIRMATION_TIMEOUT" };

    const shortConfirmed = setup.side === "SHORT"
      && currentRsi < s.rsiShortMin
      && candle.close < setup.triggerHigh;
    const longConfirmed = setup.side === "LONG"
      && currentRsi > s.rsiLongMax
      && candle.close > setup.triggerLow;

    // Keep the candidate alive across the configured number of following closed candles.
    // RSI invalidation cancels immediately; otherwise wait for confirmation or timeout.
    if (!shortConfirmed && !longConfirmed) {
      if (setup.side === "SHORT" && currentRsi > s.rsiShortMax) {
        return { action: "CANCEL", reason: "SHORT_RSI_INVALIDATED", rsi: currentRsi };
      }
      if (setup.side === "LONG" && currentRsi < s.rsiLongMin) {
        return { action: "CANCEL", reason: "LONG_RSI_INVALIDATED", rsi: currentRsi };
      }
      if (age >= s.maxConfirmationCandles) {
        return { action: "CANCEL", reason: "CONFIRMATION_TIMEOUT", rsi: currentRsi };
      }
      return { action: "KEEP", setup: { ...setup, confirmationCount: age }, rsi: currentRsi };
    }

    const a = atr(candles, s.atrPeriod);
    const swing = findSwing(candles.slice(0, -1), setup.side, s.swingLeft, s.swingRight, s.swingLookback);
    const buffer = candle.close * s.slBufferPct / 100;
    let stop = setup.side === "SHORT"
      ? (swing != null && swing > candle.close
        ? swing + buffer
        : candle.close + (a || candle.close * .01) * s.fallbackAtrMultiple)
      : (swing != null && swing < candle.close
        ? swing - buffer
        : candle.close - (a || candle.close * .01) * s.fallbackAtrMultiple);

    const distancePct = Math.abs(stop - candle.close) / candle.close * 100;
    if (distancePct < s.minStopDistancePct) {
      stop = setup.side === "SHORT"
        ? candle.close * (1 + s.minStopDistancePct / 100)
        : candle.close * (1 - s.minStopDistancePct / 100);
    }
    if (Math.abs(stop - candle.close) / candle.close * 100 > s.maxStopDistancePct) {
      return { action: "CANCEL", reason: "STOP_TOO_WIDE" };
    }

    const risk = Math.abs(stop - candle.close);
    const direction = setup.side === "LONG" ? 1 : -1;
    return {
      action: "ENTRY",
      side: setup.side,
      entry: candle.close,
      stop,
      risk,
      tp1: candle.close + direction * risk * s.rewardRiskTp1,
      tp2: candle.close + direction * risk * s.rewardRiskTp2,
      rsi: currentRsi,
      triggerTime: setup.triggerCloseTime,
      confirmationTime: candle.closeTime
    };
  }

  if (currentRsi >= s.rsiShortMin && currentRsi <= s.rsiShortMax) {
    return {
      action: "ARM",
      setup: {
        side: "SHORT", status: "ARMED", strategyVersion: 3, timeframe: s.timeframe,
        triggerLow: candle.low, triggerHigh: candle.high, triggerCloseTime: candle.closeTime,
        createdAt: now, confirmationCount: 0
      },
      rsi: currentRsi
    };
  }
  if (currentRsi >= s.rsiLongMin && currentRsi <= s.rsiLongMax) {
    return {
      action: "ARM",
      setup: {
        side: "LONG", status: "ARMED", strategyVersion: 3, timeframe: s.timeframe,
        triggerLow: candle.low, triggerHigh: candle.high, triggerCloseTime: candle.closeTime,
        createdAt: now, confirmationCount: 0
      },
      rsi: currentRsi
    };
  }
  return { action: "WAIT", reason: "NO_TRIGGER", rsi: currentRsi };
}
module.exports = { evaluateClosedCandle };
