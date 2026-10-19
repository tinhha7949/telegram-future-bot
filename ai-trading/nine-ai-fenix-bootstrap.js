"use strict";

// Behaviorally faithful, deterministic Node.js bootstrap port of FenixAI's
// non-LLM signal path: Technical + QABBA-style flow + visual price-action
// evidence, weighted directional fusion, and regime-aware dual-horizon fusion.
//
// Boundaries: NINE-AI currently supplies 15m OHLCV candles, not FenixAI's
// live order book, aggTrades, news feeds, chart-image vision LLM, or Python
// LightGBM pickle artifacts. Therefore QABBA and visual reports below are
// explicit OHLCV proxies; this module does not pretend to recreate unavailable
// external data or trained Python artifacts.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = n => Number.isFinite(Number(n));
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function signSide(value, epsilon = 0) {
  if (!Number.isFinite(value) || Math.abs(value) <= epsilon) return null;
  return value > 0 ? "LONG" : "SHORT";
}

function technicalReport(f) {
  const parts = [];
  const add = (name, score, weight) => {
    if (Number.isFinite(score)) parts.push({ name, score: clamp(score, -1, 1), weight });
  };
  add("ema-trend", f.trend === "UP" ? 1 : f.trend === "DOWN" ? -1 : 0, 1.4);
  add("momentum", Math.tanh((Number(f.mom4) || 0) / Math.max(Number(f.atrPct) || 0, 0.0001)), 1.1);
  add("macd", Math.tanh((Number(f.macdHistogram) || 0) / Math.max(Number(f.atr) || 0, 1e-12) * 8), 0.9);
  add("rsi", clamp(((Number(f.rsi) || 50) - 50) / 25, -1, 1), 0.6);
  add("breakout", Math.tanh((Number(f.breakoutStrength) || 0) * 1.5), 1.0);
  add("candle-structure", Number(f.candleBodyRatio) || 0, 0.45);
  add("swing-structure", f.structureTrend === "HIGHER_HIGHS_LOWS" ? 0.8 :
    f.structureTrend === "LOWER_HIGHS_LOWS" ? -0.8 : 0, 0.65);
  const weight = parts.reduce((sum, p) => sum + p.weight, 0);
  const score = weight ? parts.reduce((sum, p) => sum + p.score * p.weight, 0) / weight : 0;
  const side = signSide(score, 0.12);
  const confidence = clamp(0.35 + Math.abs(score) * 0.5, 0.35, 0.85);
  return { name: "technical", side, score, confidence, evidence: parts };
}

function qabbaProxyReport(candles, f) {
  // Proxy for signed trade flow / CVD / volume imbalance using candle location
  // and volume. True OBI, WDI, OFI, MLOFI and VPIN require order-book/aggTrade
  // streams and must not be fabricated from OHLCV.
  const recent = candles.slice(-12);
  let signedVolume = 0, totalVolume = 0, signedBody = 0;
  for (const c of recent) {
    const range = Math.max(c.h - c.l, Number.EPSILON);
    const closeLocation = clamp(((c.c - c.l) - (c.h - c.c)) / range, -1, 1);
    const bodyDirection = clamp((c.c - c.o) / range, -1, 1);
    const volume = Math.max(0, Number(c.v) || 0);
    signedVolume += closeLocation * volume;
    signedBody += bodyDirection * volume;
    totalVolume += volume;
  }
  const closeFlow = totalVolume > 0 ? signedVolume / totalVolume : 0;
  const bodyFlow = totalVolume > 0 ? signedBody / totalVolume : 0;
  const volumeRatio = clamp((Number(f.volumeRatio) || 1) / 2, 0.25, 1.5);
  const score = clamp((closeFlow * 0.65 + bodyFlow * 0.35) * volumeRatio, -1, 1);
  const side = signSide(score, 0.10);
  const confidence = clamp(0.30 + Math.abs(score) * 0.55 +
    (Number(f.volumeRatio) >= 1.2 ? 0.05 : 0), 0.30, 0.85);
  return { name: "qabba_ohlcv_proxy", side, score, confidence,
    evidence: { closeFlow, bodyFlow, volumeRatio: Number(f.volumeRatio) || 1 } };
}

function visualProxyReport(candles, f) {
  let score = 0;
  const evidence = [];
  if (f.bullishEngulfing) { score += 0.65; evidence.push("bullish-engulfing"); }
  if (f.bearishEngulfing) { score -= 0.65; evidence.push("bearish-engulfing"); }
  if (Number(f.lowerWickRatio) >= 0.45 && Number(f.candleBodyRatio) > 0) {
    score += 0.35; evidence.push("lower-wick-rejection");
  }
  if (Number(f.upperWickRatio) >= 0.45 && Number(f.candleBodyRatio) < 0) {
    score -= 0.35; evidence.push("upper-wick-rejection");
  }
  if (Number(f.falseBreakoutRisk) > 0) {
    score += Number(f.lowerWickRatio) > Number(f.upperWickRatio) ? 0.25 : -0.25;
    evidence.push("failed-breakout-wick");
  }
  if (f.insideBar) evidence.push("inside-bar-neutral");
  if (Math.abs(Number(f.breakoutStrength) || 0) >= 0.15) {
    score += Math.sign(Number(f.breakoutStrength)) * 0.25;
    evidence.push("range-breakout");
  }
  score = clamp(score, -1, 1);
  return { name: "visual_price_action_proxy", side: signSide(score, 0.20),
    score, confidence: clamp(0.35 + Math.abs(score) * 0.45, 0.35, 0.80), evidence };
}

function dualHorizonReport(candles, f) {
  const closes = candles.map(c => Number(c.c));
  const ret = bars => {
    if (closes.length <= bars) return 0;
    const base = closes[closes.length - 1 - bars];
    return base > 0 ? closes[closes.length - 1] / base - 1 : 0;
  };
  const shortScore = Math.tanh(ret(4) / Math.max(Number(f.atrPct) || 0, 0.0001));
  const longScore = Math.tanh(ret(16) / Math.max((Number(f.atrPct) || 0) * 2, 0.0002));
  const regime = Number(f.atrPct) > 0.015 ? "VOLATILE" :
    f.trend === "RANGE" && Math.abs(ret(16)) < (Number(f.atrPct) || 0) * 2 ? "CHOP" :
    Number(f.atrPct) < 0.004 ? "DEAD" : "TRENDING";
  const weights = {
    TRENDING: { short: 0.35, long: 0.65 },
    CHOP: { short: 0.70, long: 0.30 },
    DEAD: { short: 0.50, long: 0.50 },
    VOLATILE: { short: 0.60, long: 0.40 }
  }[regime];
  const score = shortScore * weights.short + longScore * weights.long;
  return { side: signSide(score, 0.12), score, regime, weights,
    shortScore, longScore, confidence: clamp(Math.abs(score) * 1.2, 0, 0.95) };
}

function decideFenixBootstrap(candles, features) {
  if (!Array.isArray(candles) || candles.length < 60 || !features?.valid) {
    return { ready: false, side: null, confidence: 0, reason: "FENIX_BOOTSTRAP_INSUFFICIENT_DATA" };
  }
  const technical = technicalReport(features);
  const qabba = qabbaProxyReport(candles, features);
  const visual = visualProxyReport(candles, features);
  const horizons = dualHorizonReport(candles, features);

  // FenixAI's weighted report fusion: confidence-weighted directional score,
  // normalized over reports available on this runtime. No sentiment vote is
  // synthesized because there is no news/social/Fear-and-Greed feed connected.
  const weights = { technical: 0.30, qabba_ohlcv_proxy: 0.30, visual_price_action_proxy: 0.25 };
  const reports = [technical, qabba, visual];
  const totalWeight = reports.reduce((sum, r) => sum + weights[r.name], 0);
  let directionalScore = reports.reduce((sum, r) =>
    sum + (r.side === "LONG" ? 1 : r.side === "SHORT" ? -1 : 0) * r.confidence * weights[r.name], 0
  ) / Math.max(totalWeight, 1e-9);

  // NanoFenix dual-horizon fusion is used as an additional agreement-aware
  // signal. In disagreement, reduce the score rather than inventing certainty.
  const horizonDirection = horizons.side;
  const agentDirection = signSide(directionalScore, 0.10);
  if (horizonDirection && agentDirection && horizonDirection !== agentDirection) {
    directionalScore *= 0.55;
  } else if (horizonDirection && agentDirection === horizonDirection) {
    directionalScore = clamp(directionalScore * 1.12, -1, 1);
  }

  // Preserve the FenixAI adaptive fusion baseline threshold of 0.35.
  const side = Math.abs(directionalScore) >= 0.35
    ? (directionalScore > 0 ? "LONG" : "SHORT") : null;
  return {
    ready: true, source: "FENIXAI_BOOTSTRAP", side,
    confidence: Math.round(clamp(Math.abs(directionalScore) * 100, 0, 95)),
    score: directionalScore,
    reason: side ? "FENIXAI_MULTI_AGENT_FUSION" : "FENIXAI_FUSION_BELOW_THRESHOLD",
    reports: { technical, qabba, visual, dualHorizon: horizons },
    limitations: ["NO_LIVE_ORDERBOOK", "NO_EXTERNAL_SENTIMENT_FEED", "NO_VISION_LLM", "NO_PYTHON_LIGHTGBM_ARTIFACT"]
  };
}

module.exports = { technicalReport, qabbaProxyReport, visualProxyReport, dualHorizonReport, decideFenixBootstrap };
