"use strict";

// Independent OHLCV price-action quality filter.
// Uses only completed candles supplied by the exchange layer. This is not a port
// of any third-party indicator or proprietary scoring implementation.
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function evaluateMarketBehavior({ candles, side, config }) {
  if (!config?.enabled) return { allowed: true, disabled: true, score: null, reason: "DISABLED" };
  if (!["LONG", "SHORT"].includes(side)) {
    return { allowed: false, score: 0, reason: "INVALID_SIDE" };
  }

  const lookback = Math.floor(config.lookbackCandles);
  const atrPeriod = Math.floor(config.atrPeriod);
  const pressureCandles = Math.floor(config.pressureCandles);
  const volumeLookback = Math.floor(config.volumeLookback);
  const required = Math.max(lookback, atrPeriod + 1, pressureCandles, volumeLookback + 1) + 1;
  if (!Array.isArray(candles) || candles.length < required) {
    return { allowed: false, score: 0, reason: "INSUFFICIENT_CANDLES", required, actual: candles?.length || 0 };
  }

  const current = candles[candles.length - 1];
  const previous = candles.slice(-(lookback + 1), -1);
  const valid = candle => candle && [candle.open, candle.high, candle.low, candle.close, candle.volume]
    .every(value => Number.isFinite(Number(value)))
    && Number(candle.high) >= Number(candle.low);
  if (!valid(current) || previous.some(candle => !valid(candle))) {
    return { allowed: false, score: 0, reason: "INVALID_CANDLE_DATA" };
  }

  const tr = [];
  const atrStart = candles.length - atrPeriod;
  for (let i = Math.max(1, atrStart); i < candles.length; i++) {
    const bar = candles[i], prior = candles[i - 1];
    tr.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prior.close), Math.abs(bar.low - prior.close)));
  }
  const atrValue = average(tr);
  if (!(atrValue > 0)) return { allowed: false, score: 0, reason: "ATR_UNAVAILABLE" };

  const priorLow = Math.min(...previous.map(bar => bar.low));
  const priorHigh = Math.max(...previous.map(bar => bar.high));
  const longSweep = current.low < priorLow && current.close > priorLow;
  const shortSweep = current.high > priorHigh && current.close < priorHigh;
  const direction = side === "LONG" ? 1 : -1;
  const favorableSweep = side === "LONG" ? longSweep : shortSweep;
  const opposingSweep = side === "LONG" ? shortSweep : longSweep;

  const pressureBars = candles.slice(-pressureCandles);
  let pressureNumerator = 0, pressureDenominator = 0;
  for (const bar of pressureBars) {
    const range = Math.max(0, bar.high - bar.low);
    if (range <= 0 || bar.volume <= 0) continue;
    const closePressure = (2 * bar.close - bar.high - bar.low) / range;
    pressureNumerator += closePressure * bar.volume;
    pressureDenominator += bar.volume;
  }
  const pressure = pressureDenominator > 0 ? pressureNumerator / pressureDenominator : 0;
  const directionalPressure = pressure * direction;

  const body = current.close - current.open;
  const bodyAtr = Math.abs(body) / atrValue;
  const directionalBody = body * direction;
  const alignedDisplacement = directionalBody > 0 && bodyAtr >= config.minDisplacementAtr;
  const opposingDisplacement = directionalBody < 0 && bodyAtr >= config.minDisplacementAtr;

  const range = Math.max(current.high - current.low, Number.EPSILON);
  const closeLocation = (current.close - current.low) / range;
  const directionalClose = side === "LONG"
    ? closeLocation >= config.minCloseLocation
    : closeLocation <= 1 - config.minCloseLocation;
  const opposingClose = side === "LONG"
    ? closeLocation <= 1 - config.minCloseLocation
    : closeLocation >= config.minCloseLocation;
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const adverseWickRatio = (side === "LONG" ? upperWick : lowerWick) / range;
  const acceptableWick = adverseWickRatio <= config.maxOpposingWickRatio;

  const priorVolumes = candles.slice(-(volumeLookback + 1), -1).map(bar => bar.volume);
  const averageVolume = average(priorVolumes);
  const volumeExpanded = averageVolume > 0
    && current.volume >= averageVolume * config.volumeExpansionMultiplier;
  const volumeSupportsSide = volumeExpanded && directionalBody > 0;

  let score = 0;
  const components = {};
  components.sweep = favorableSweep ? 24 : opposingSweep ? -20 : 0;
  components.pressure = directionalPressure >= config.pressureThreshold
    ? 20 : directionalPressure <= -config.pressureThreshold ? -15 : 8;
  components.displacement = alignedDisplacement ? 20 : opposingDisplacement ? -18 : 0;
  components.candleClose = directionalClose ? 20 : opposingClose ? -12 : 4;
  components.wickQuality = acceptableWick ? 8 : 0;
  components.volume = volumeSupportsSide ? 8 : 0;
  score = clamp(Object.values(components).reduce((sum, value) => sum + value, 0), 0, 100);

  return {
    allowed: score >= config.minScore,
    score,
    minScore: config.minScore,
    reason: score >= config.minScore ? "PRICE_ACTION_CONFIRMED" : "LOW_DIRECTIONAL_QUALITY",
    side,
    sweep: favorableSweep ? "FAVORABLE" : opposingSweep ? "OPPOSING" : "NONE",
    pressure: Number(pressure.toFixed(4)),
    bodyAtr: Number(bodyAtr.toFixed(4)),
    closeLocation: Number(closeLocation.toFixed(4)),
    adverseWickRatio: Number(adverseWickRatio.toFixed(4)),
    volumeExpanded,
    components
  };
}

module.exports = { evaluateMarketBehavior };
