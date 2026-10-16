"use strict";

/**
 * Nine-role, zero-paid-API strategy for Binance USD-M Futures 15m.
 * This is an auditable local ensemble, not a hosted LLM. The ML role is a
 * compact logistic scoring model with explicit coefficients; it is not
 * advertised as a trained model. Closed candles only.
 */

const learningMemory = require("./nine-ai-learning-memory");

const ROLE_NAMES = [
  "Technical Analyst AI",
  "ML Signal AI",
  "Learning & Memory AI",
  "Bull AI",
  "Bear AI",
  "Contrarian AI",
  "Analyst AI",
  "Decision AI",
  "Risk Manager AI"
];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = n => Number.isFinite(Number(n));
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function parseClosedCandles(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter(r => Array.isArray(r) && r.length >= 6)
    .map(r => ({
      openTime: Number(r[0]), o: Number(r[1]), h: Number(r[2]),
      l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
      closeTime: Number(r[6])
    }))
    .filter(c => [c.openTime, c.o, c.h, c.l, c.c, c.v].every(finite) &&
      c.o > 0 && c.h >= c.l && c.l > 0 && c.c > 0 && c.v >= 0)
    .sort((a, b) => a.openTime - b.openTime);
  // Binance includes the still-forming final candle in the klines response.
  return rows.filter(c => finite(c.closeTime) && c.closeTime < now);
}

function ema(values, period) {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let value = avg(values.slice(0, period));
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  return 100 - 100 / (1 + gains / losses);
}

function buildFeatures(candles) {
  const closes = candles.map(c => c.c);
  const last = candles[candles.length - 1];
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const rs = rsi(closes, 14);
  const trueRanges = [];
  for (let i = Math.max(1, candles.length - 15); i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1].c;
    trueRanges.push(Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev)));
  }
  const atr = avg(trueRanges);
  const prior = closes[Math.max(0, closes.length - 5)];
  const mom4 = prior > 0 ? last.c / prior - 1 : 0;
  const prior12 = closes[Math.max(0, closes.length - 13)];
  const mom12 = prior12 > 0 ? last.c / prior12 - 1 : 0;
  const volBase = avg(candles.slice(-21, -1).map(c => c.v));
  const volumeRatio = volBase > 0 ? last.v / volBase : 1;
  const prior20 = candles.slice(-21, -1);
  const high20 = Math.max(...prior20.map(c => c.h));
  const low20 = Math.min(...prior20.map(c => c.l));
  const structure = candles.slice(-9);
  const swingHigh = Math.max(...structure.map(c => c.h));
  const swingLow = Math.min(...structure.map(c => c.l));
  const atrPct = last.c > 0 ? atr / last.c : 0;
  return {
    last, e9, e21, e50, rsi: rs, atr, atrPct, mom4, mom12,
    volumeRatio, high20, low20, swingHigh, swingLow,
    trend: e9 > e21 && e21 > e50 ? "UP" : e9 < e21 && e21 < e50 ? "DOWN" : "RANGE",
    extensionAtr: atr > 0 ? (last.c - e21) / atr : 0,
    valid: [e9, e21, e50, rs, atr, high20, low20].every(Number.isFinite) && atr > 0
  };
}

function logistic(z) { return 1 / (1 + Math.exp(-clamp(z, -12, 12))); }

function analyzeNineAI(raw, symbol, now = Date.now()) {
  const candles = parseClosedCandles(raw, now);
  const abstain = { symbol, side: null, action: "WAIT", confidence: 0, reason: "INSUFFICIENT_CLOSED_CANDLES", roles: [], candles: candles.length };
  if (candles.length < 60) return abstain;

  const f = buildFeatures(candles);
  if (!f.valid) return { ...abstain, reason: "INVALID_MARKET_FEATURES" };
  const longVotes = [], shortVotes = [];
  const roleResults = [];
  const vote = (name, side, confidence, reason) => {
    roleResults.push({ name, side: side || "NEUTRAL", confidence: Math.round(confidence), reason });
    if (side === "LONG") longVotes.push({ name, confidence });
    if (side === "SHORT") shortVotes.push({ name, confidence });
  };
  const trendSide = f.trend === "UP" ? "LONG" : f.trend === "DOWN" ? "SHORT" : null;

  // 1. Technical Analyst AI: multi-EMA trend plus momentum confirmation.
  const techSide = trendSide && (trendSide === "LONG" ? f.mom4 > 0 : f.mom4 < 0) ? trendSide : null;
  vote(ROLE_NAMES[0], techSide, techSide ? 68 : 35, `trend=${f.trend}; mom4=${(f.mom4 * 100).toFixed(2)}%`);

  // 2. ML Signal AI: online logistic model trained only from closed-trade outcomes.
  const learnedFeatures = { trend: f.trend === "UP" ? 1 : f.trend === "DOWN" ? -1 : 0,
    momentum: f.mom4 / Math.max(f.atrPct, 0.0001), rsi: f.rsi,
    volume: f.volumeRatio, extension: f.extensionAtr };
  const learned = learningMemory.predict(learnedFeatures);
  const z = 1.25 * clamp((f.e9 - f.e21) / f.atr, -2, 2) +
    0.85 * clamp(f.mom4 / Math.max(f.atrPct, 0.0001), -2, 2) +
    0.45 * clamp(f.mom12 / Math.max(f.atrPct * 2, 0.0002), -2, 2) +
    0.25 * clamp((f.rsi - 50) / 20, -2, 2);
  const baselineP = logistic(z);
  const pLong = learned.trained ? 0.35 * baselineP + 0.65 * learned.pLong : baselineP;
  const mlSide = pLong >= 0.62 ? "LONG" : pLong <= 0.38 ? "SHORT" : null;
  vote(ROLE_NAMES[1], mlSide, Math.round(Math.max(pLong, 1 - pLong) * 100),
    `onlineP(long)=${pLong.toFixed(3)}; trainedSamples=${learned.samples}`);

  // 3. Learning & Memory AI: persistent memory is distinct from model prediction.
  const memoryState = learningMemory.read();
  const memSide = learned.trained && learned.side &&
    Math.sign(f.mom4) === Math.sign(f.mom12) &&
    Math.abs(f.mom12) > f.atrPct * 0.25 ? learned.side : null;
  vote(ROLE_NAMES[2], memSide, memSide ? 60 : 25,
    `persistentClosedTradeSamples=${memoryState.samples}; momentumPersistence=${(f.mom12 * 100).toFixed(2)}%`);

  // 4. Bull AI.
  const bullSide = f.rsi >= 52 && f.mom4 > 0 && f.last.c > f.e21 ? "LONG" : null;
  vote(ROLE_NAMES[3], bullSide, bullSide ? 60 : 25, `RSI=${f.rsi.toFixed(1)}; close-vs-EMA21`);

  // 5. Bear AI.
  const bearSide = f.rsi <= 48 && f.mom4 < 0 && f.last.c < f.e21 ? "SHORT" : null;
  vote(ROLE_NAMES[4], bearSide, bearSide ? 60 : 25, `RSI=${f.rsi.toFixed(1)}; close-vs-EMA21`);

  // 6. Contrarian AI: only countertrend at statistically stretched RSI/price.
  const contraSide = f.rsi >= 78 && f.extensionAtr > 1.8 ? "SHORT" :
    f.rsi <= 22 && f.extensionAtr < -1.8 ? "LONG" : null;
  vote(ROLE_NAMES[5], contraSide, contraSide ? 64 : 30, `extension=${f.extensionAtr.toFixed(2)} ATR`);

  // 7. Analyst/Auditor AI: independent quality and data integrity check.
  const candle = f.last;
  const candleRange = candle.h - candle.l;
  const candleBody = Math.abs(candle.c - candle.o);
  const auditorSide = f.volumeRatio >= 0.65 && candleRange > 0 &&
    candleBody / candleRange >= 0.2 ? techSide : null;
  vote(ROLE_NAMES[6], auditorSide, auditorSide ? 58 : 20,
    `volumeRatio=${f.volumeRatio.toFixed(2)}; body/range=${(candleRange ? candleBody / candleRange : 0).toFixed(2)}`);

  // 8. Decision AI: consensus from roles 1-7. The risk role can still veto.
  const longCount = longVotes.length, shortCount = shortVotes.length;
  let side = longCount >= 4 && longCount - shortCount >= 2 ? "LONG" :
    shortCount >= 4 && shortCount - longCount >= 2 ? "SHORT" : null;
  const chosenVotes = side === "LONG" ? longVotes : side === "SHORT" ? shortVotes : [];
  const confidence = chosenVotes.length
    ? Math.round(avg(chosenVotes.map(v => v.confidence)) * Math.min(1, chosenVotes.length / 5))
    : 0;
  roleResults.push({ name: ROLE_NAMES[7], side: side || "WAIT", confidence,
    reason: `longVotes=${longCount}; shortVotes=${shortCount}; minConsensus=4` });

  // 9. Risk Manager AI: risk veto for volatility, poor location, weak consensus.
  const riskReasons = [];
  if (f.atrPct < 0.001 || f.atrPct > 0.04) riskReasons.push("ATR_PERCENT_OUT_OF_RANGE");
  if (f.rsi > 86 && side === "LONG") riskReasons.push("LONG_OVERBOUGHT");
  if (f.rsi < 14 && side === "SHORT") riskReasons.push("SHORT_OVERSOLD");
  if (confidence < 55) riskReasons.push("CONFIDENCE_BELOW_55");
  if (side && side === "LONG" && f.last.c <= f.e21) riskReasons.push("LONG_BELOW_EMA21");
  if (side && side === "SHORT" && f.last.c >= f.e21) riskReasons.push("SHORT_ABOVE_EMA21");
  const riskAllowed = Boolean(side) && riskReasons.length === 0;
  roleResults.push({ name: ROLE_NAMES[8], side: riskAllowed ? side : "VETO",
    confidence: riskAllowed ? 75 : 100, reason: riskAllowed ? "RISK_CHECKS_PASSED" : (riskReasons.join(",") || "NO_DECISION") });

  if (!riskAllowed) return { ...abstain, reason: riskReasons.join(",") || "NO_CONSENSUS",
    roles: roleResults, candles: candles.length, features: summarize(f) };

  // Nine-AI owns the complete trade plan. Entry uses the latest CLOSED 15m
  // candle; SL combines ATR volatility with recent market structure; TP is
  // derived from the resulting risk distance. No legacy scanner rewrites it.
  const entry = f.last.c;
  const minimumStop = Math.max(f.atr * 1.5, entry * 0.001);
  const structureStop = side === "LONG"
    ? entry - f.swingLow + f.atr * 0.2
    : f.swingHigh - entry + f.atr * 0.2;
  const stopDistance = Math.max(minimumStop, structureStop);
  const targetDistance = stopDistance * 1.8;
  const sl = side === "LONG" ? entry - stopDistance : entry + stopDistance;
  const tp = side === "LONG" ? entry + targetDistance : entry - targetDistance;
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (![entry, sl, tp, rr].every(Number.isFinite) || entry <= 0 || sl <= 0 ||
      (side === "LONG" ? !(sl < entry && tp > entry) : !(tp < entry && sl > entry)) || rr < 1.7) {
    return { ...abstain, reason: "FINAL_TRADE_GEOMETRY_INVALID", roles: roleResults, candles: candles.length };
  }

  return {
    symbol, side, action: side, confidence, price: entry, entry, sl, tp, rr,
    tradePlan: {
      timeframe: "15m",
      entryMethod: "LATEST_CLOSED_CANDLE",
      stopMethod: "ATR_AND_RECENT_STRUCTURE",
      targetMethod: "RISK_MULTIPLE",
      stopDistance,
      targetDistance,
      riskReward: rr
    },
    signalAt: f.last.closeTime, setup: "NINE_AI_15M",
    marketState: f.trend === "RANGE" ? "RANGE" : "TREND_STRONG",
    volatility: f.atrPct > 0.015 ? "HIGH" : f.atrPct < 0.004 ? "LOW" : "NORMAL",
    qualityScore: confidence, score: confidence, rankScore: Math.max(60, confidence),
    rankMetrics: { score: confidence, adjustment: 0, phase: f.trend,
      impulseSide: side, energyRatio: f.volumeRatio, early: false,
      roles: roleResults, features: summarize(f) },
    roles: roleResults, candles: candles.length,
    // A non-WAIT decision that passed all nine-role checks is the only
    // signal the scanner may consider; deterministic execution risk guards
    // and position limits still have final veto authority.
    authorizedForExecution: true
  };
}

function summarize(f) {
  return { close: f.last.c, ema9: f.e9, ema21: f.e21, ema50: f.e50,
    rsi14: f.rsi, atr14: f.atr, atrPercent: f.atrPct, momentum4: f.mom4,
    momentum12: f.mom12, volumeRatio: f.volumeRatio, trend: f.trend,
    extensionAtr: f.extensionAtr, swingHigh: f.swingHigh, swingLow: f.swingLow };
}

module.exports = { ROLE_NAMES, parseClosedCandles, buildFeatures, analyzeNineAI };
