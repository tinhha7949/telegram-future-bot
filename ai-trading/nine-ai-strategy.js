"use strict";

/**
 * Nine-role, zero-paid-API strategy for Binance USD-M Futures 15m.
 * This is an auditable local ensemble, not a hosted LLM. The ML role is a
 * compact logistic scoring model with explicit coefficients; it is not
 * advertised as a trained model. Closed candles only.
 */

const learningMemory = require("./nine-ai-learning-memory");
const independentModels = require("./nine-ai-independent-models");

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

// Explicit rank influence for every role. These sum to 1.00.
// Contrarian has meaningful weight because it checks traps/reversal evidence.
// Risk Manager contributes a soft learned risk penalty; deterministic safety
// rules and confirmed opposing traps remain hard vetoes.
const ROLE_WEIGHTS = Object.freeze({
  "Technical Analyst AI": 0.15,
  "ML Signal AI": 0.15,
  "Learning & Memory AI": 0.10,
  "Bull AI": 0.10,
  "Bear AI": 0.10,
  "Contrarian AI": 0.15,
  "Analyst AI": 0.10,
  "Decision AI": 0.10,
  "Risk Manager AI": 0.05
});

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
  const previous = candles[candles.length - 2];
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
  const candleRange = Math.max(last.h - last.l, Number.EPSILON);
  const candleBody = Math.abs(last.c - last.o);
  const candleBodyRatio = clamp((last.c - last.o) / candleRange, -1, 1);
  const upperWickRatio = clamp((last.h - Math.max(last.o, last.c)) / candleRange, 0, 1);
  const lowerWickRatio = clamp((Math.min(last.o, last.c) - last.l) / candleRange, 0, 1);
  const insideBar = Boolean(previous && last.h <= previous.h && last.l >= previous.l);
  const bullishEngulfing = Boolean(previous && last.c > last.o && previous.c < previous.o &&
    last.o <= previous.c && last.c >= previous.o);
  const bearishEngulfing = Boolean(previous && last.c < last.o && previous.c > previous.o &&
    last.o >= previous.c && last.c <= previous.o);
  const brokeAbove = atr > 0 && last.c > high20 + atr * 0.05;
  const brokeBelow = atr > 0 && last.c < low20 - atr * 0.05;
  const breakoutStrength = atr > 0
    ? brokeAbove ? (last.c - high20) / atr : brokeBelow ? (last.c - low20) / atr : 0
    : 0;
  const falseBreakoutRisk = Number(
    (last.h > high20 && last.c < high20 && upperWickRatio >= 0.35) ||
    (last.l < low20 && last.c > low20 && lowerWickRatio >= 0.35)
  );
  const range20 = Math.max(high20 - low20, Number.EPSILON);
  const structurePosition = clamp((last.c - (high20 + low20) / 2) / (range20 / 2), -1, 1);
  const roomToResistanceAtr = atr > 0 ? (high20 - last.c) / atr : 0;
  const roomToSupportAtr = atr > 0 ? (last.c - low20) / atr : 0;
  const lastSix = candles.slice(-6);
  const earlierThree = lastSix.slice(0, 3);
  const laterThree = lastSix.slice(3);
  const higherHighs = Math.max(...laterThree.map(c => c.h)) > Math.max(...earlierThree.map(c => c.h));
  const higherLows = Math.min(...laterThree.map(c => c.l)) > Math.min(...earlierThree.map(c => c.l));
  const lowerHighs = Math.max(...laterThree.map(c => c.h)) < Math.max(...earlierThree.map(c => c.h));
  const lowerLows = Math.min(...laterThree.map(c => c.l)) < Math.min(...earlierThree.map(c => c.l));
  const structureTrend = higherHighs && higherLows ? "HIGHER_HIGHS_LOWS"
    : lowerHighs && lowerLows ? "LOWER_HIGHS_LOWS" : "MIXED";
  const directionalStreak = clamp(candles.slice(-3).reduce((sum, c) =>
    sum + (c.c > c.o ? 1 : c.c < c.o ? -1 : 0), 0) / 3, -1, 1);
  const trend = e9 > e21 && e21 > e50 ? "UP" : e9 < e21 && e21 < e50 ? "DOWN" : "RANGE";
  const extensionAtr = atr > 0 ? (last.c - e21) / atr : 0;
  const trendStrengthAtr = atr > 0 ? Math.abs(e9 - e21) / atr : 0;
  const momentumStrength = Math.abs(mom12) / Math.max(atrPct, 0.0001);
  const marketRegime = trend !== "RANGE" && trendStrengthAtr >= 0.2 &&
    Math.sign(mom12) === (trend === "UP" ? 1 : -1)
      ? (trend === "UP" ? "TREND_UP" : "TREND_DOWN")
      : trend === "RANGE" && momentumStrength < 0.8 ? "SIDEWAYS" : "TRANSITION";
  const volatilityRegime = atrPct > 0.015 ? "HIGH" : atrPct < 0.004 ? "LOW" : "NORMAL";
  const directionalBreakoutQuality = direction => {
    const aligned = direction === "LONG" ? breakoutStrength > 0 : breakoutStrength < 0;
    if (falseBreakoutRisk) return 15;
    if (aligned) return clamp(55 + Math.abs(breakoutStrength) * 20 +
      (volumeRatio >= 1.1 ? 10 : 0) +
      (Math.abs(candleBodyRatio) >= 0.55 ? 10 : 0), 0, 100);
    return breakoutStrength !== 0 ? 30 : 60;
  };
  const directionalRoomQuality = direction => {
    const room = direction === "LONG" ? roomToResistanceAtr : roomToSupportAtr;
    const alignedBreakout = direction === "LONG" ? brokeAbove : brokeBelow;
    if (room < 0) return alignedBreakout && Math.abs(breakoutStrength) >= 0.1 ? 65 : 20;
    if (room < 0.5) return 25;
    if (room < 1) return 50;
    if (room < 1.5) return 70;
    return 90;
  };
  const longEntryQuality = clamp(
    directionalRoomQuality("LONG") * 0.45 +
    directionalBreakoutQuality("LONG") * 0.35 +
    clamp(100 - Math.max(0, extensionAtr) * 15, 0, 100) * 0.20 -
    (extensionAtr > 2.2 ? 20 : 0), 0, 100
  );
  const shortEntryQuality = clamp(
    directionalRoomQuality("SHORT") * 0.45 +
    directionalBreakoutQuality("SHORT") * 0.35 +
    clamp(100 - Math.max(0, -extensionAtr) * 15, 0, 100) * 0.20 -
    (extensionAtr < -2.2 ? 20 : 0), 0, 100
  );
  return {
    last, e9, e21, e50, rsi: rs, atr, atrPct, mom4, mom12,
    volumeRatio, high20, low20, swingHigh, swingLow, trend, marketRegime,
    volatilityRegime, candleBodyRatio, candleBody, candleRange,
    upperWickRatio, lowerWickRatio, insideBar, bullishEngulfing, bearishEngulfing,
    breakoutStrength, brokeAbove, brokeBelow, falseBreakoutRisk,
    structurePosition, roomToResistanceAtr, roomToSupportAtr, structureTrend,
    directionalStreak, trendStrengthAtr, momentumStrength, extensionAtr,
    longEntryQuality, shortEntryQuality,
    valid: [e9, e21, e50, rs, atr, high20, low20, candleBodyRatio,
      upperWickRatio, lowerWickRatio, breakoutStrength, structurePosition,
      longEntryQuality, shortEntryQuality].every(Number.isFinite) && atr > 0
  };
}

function logistic(z) { return 1 / (1 + Math.exp(-clamp(z, -12, 12))); }

// A trained model that is uncertain must not erase a valid rule-based vote.
// A confident learned side still overrides the fallback and changes decisions
// based on closed-trade outcomes.
function resolveModelSide(model, fallback) {
  return model?.trained && ["LONG", "SHORT"].includes(model.side) ? model.side : fallback;
}

// Learned loss probability is evidence for ranking, not a standalone order veto.
// Deterministic market-safety rules below remain in force.
function assessIndependentRiskModel(riskModel) {
  if (!riskModel?.trained || !finite(riskModel.pLoss)) {
    return { veto: false, confidence: 75, reason: "RISK_MODEL_WARMUP_OR_UNAVAILABLE" };
  }
  const pLoss = clamp(Number(riskModel.pLoss), 0, 1);
  return {
    veto: false,
    confidence: clamp(Math.round((1 - pLoss) * 100), 10, 100),
    reason: pLoss >= 0.65 ? "HIGH_LOSS_RISK_SOFT_PENALTY" : "RISK_MODEL_SCORE_APPLIED"
  };
}

function detectContrarianSignal(candles, f) {
  if (!Array.isArray(candles) || candles.length < 6 || !f?.last || !(f.atr > 0)) {
    return { side: null, strength: 0, reason: "INSUFFICIENT_TRAP_CONTEXT" };
  }

  const last = f.last;
  const prior = candles.slice(-6, -1);
  const priorHigh = Math.max(...prior.map(c => c.h));
  const priorLow = Math.min(...prior.map(c => c.l));
  const range = Math.max(last.h - last.l, Number.EPSILON);
  const body = Math.abs(last.c - last.o);
  const upperWick = last.h - Math.max(last.o, last.c);
  const lowerWick = Math.min(last.o, last.c) - last.l;
  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;
  const brokeHigh = last.h > priorHigh + f.atr * 0.05;
  const rejectedHigh = last.c < priorHigh;
  const brokeLow = last.l < priorLow - f.atr * 0.05;
  const reclaimedLow = last.c > priorLow;
  const volumeConfirmation = f.volumeRatio >= 1.05;
  const upperRejection = upperWickRatio >= 0.35 && upperWick >= body * 1.1;
  const lowerRejection = lowerWickRatio >= 0.35 && lowerWick >= body * 1.1;

  // A trap requires price to pierce a recent level and close back through it,
  // plus a meaningful rejection wick. RSI/extension alone is only exhaustion,
  // not proof of a reversal.
  if (brokeHigh && rejectedHigh && upperRejection) {
    return {
      side: "SHORT",
      strength: clamp(60 + (volumeConfirmation ? 10 : 0) +
        (f.rsi >= 68 || f.extensionAtr >= 1.2 ? 10 : 0), 60, 80),
      reason: "BULL_TRAP_REJECTION",
      priorHigh, priorLow, upperWickRatio, lowerWickRatio, volumeConfirmation
    };
  }
  if (brokeLow && reclaimedLow && lowerRejection) {
    return {
      side: "LONG",
      strength: clamp(60 + (volumeConfirmation ? 10 : 0) +
        (f.rsi <= 32 || f.extensionAtr <= -1.2 ? 10 : 0), 60, 80),
      reason: "BEAR_TRAP_RECLAIM",
      priorHigh, priorLow, upperWickRatio, lowerWickRatio, volumeConfirmation
    };
  }

  // Secondary exhaustion warning. This can add contrary evidence, but is
  // deliberately weaker than a confirmed false breakout/breakdown.
  if (f.rsi >= 78 && f.extensionAtr >= 1.8 && upperRejection) {
    return { side: "SHORT", strength: 58, reason: "BULLISH_EXHAUSTION", priorHigh, priorLow, upperWickRatio, lowerWickRatio, volumeConfirmation };
  }
  if (f.rsi <= 22 && f.extensionAtr <= -1.8 && lowerRejection) {
    return { side: "LONG", strength: 58, reason: "BEARISH_EXHAUSTION", priorHigh, priorLow, upperWickRatio, lowerWickRatio, volumeConfirmation };
  }

  return {
    side: null, strength: 0, reason: "NO_CONFIRMED_TRAP",
    priorHigh, priorLow, upperWickRatio, lowerWickRatio, volumeConfirmation
  };
}

function isContrarianConflict(side, contrarian) {
  return Boolean(["LONG", "SHORT"].includes(side) &&
    ["LONG", "SHORT"].includes(contrarian?.side) &&
    contrarian.side !== side && Number(contrarian.strength) >= 60);
}

function calculateWeightedRoleScore(roleResults, side, adaptiveRoleWeights = ROLE_WEIGHTS) {
  if (!Array.isArray(roleResults) || !["LONG", "SHORT"].includes(side)) return { score: 0, roles: [] };
  let weightedTotal = 0;
  let totalWeight = 0;
  const scoredRoles = roleResults.map(role => {
    const weight = Number(adaptiveRoleWeights?.[role.name] ?? ROLE_WEIGHTS[role.name] ?? 0);
    let score = 50;
    if (role.name === "Risk Manager AI") {
      // Risk quality is separate from direction; only approved candidates reach ranking.
      score = role.side === "VETO" ? 0 : clamp(Number(role.confidence) || 75, 0, 100);
    } else if (role.side === side) {
      score = clamp(Number(role.confidence) || 50, 0, 100);
    } else if (role.side === "LONG" || role.side === "SHORT") {
      score = 100 - clamp(Number(role.confidence) || 50, 0, 100);
    }
    weightedTotal += score * weight;
    totalWeight += weight;
    return { ...role, weight, score: Math.round(score * 100) / 100,
      weightedContribution: Math.round(score * weight * 100) / 100 };
  });
  return {
    score: totalWeight > 0 ? Math.round(weightedTotal / totalWeight * 100) / 100 : 0,
    roles: scoredRoles
  };
}

function analyzeNineAI(raw, symbol, now = Date.now()) {
  const candles = parseClosedCandles(raw, now);
  const abstain = { symbol, side: null, action: "WAIT", confidence: 0, reason: "INSUFFICIENT_CLOSED_CANDLES", roles: [], candles: candles.length };
  if (candles.length < 60) return abstain;

  const f = buildFeatures(candles);
  if (!f.valid) return { ...abstain, reason: "INVALID_MARKET_FEATURES" };
  const longVotes = [], shortVotes = [];
  const roleResults = [];
  const vote = (name, side, confidence, reason) => {
    roleResults.push({ name, side: side || "NEUTRAL", confidence: Math.round(confidence), reason,
      weight: ROLE_WEIGHTS[name] || 0 });
    if (side === "LONG") longVotes.push({ name, confidence });
    if (side === "SHORT") shortVotes.push({ name, confidence });
  };
  const trendSide = f.trend === "UP" ? "LONG" : f.trend === "DOWN" ? "SHORT" : null;
  const learnedFeatures = {
    trend: f.trend === "UP" ? 1 : f.trend === "DOWN" ? -1 : 0,
    momentum: f.mom4 / Math.max(f.atrPct, 0.0001), rsi: f.rsi,
    volume: f.volumeRatio, extension: f.extensionAtr,
    candleBody: f.candleBodyRatio,
    wickImbalance: f.lowerWickRatio - f.upperWickRatio,
    breakoutStrength: f.breakoutStrength,
    regime: f.marketRegime === "TREND_UP" ? 1 : f.marketRegime === "TREND_DOWN" ? -1 :
      f.marketRegime === "SIDEWAYS" ? -0.5 : 0,
    volatilityRegime: f.volatilityRegime === "HIGH" ? 1 : f.volatilityRegime === "LOW" ? -1 : 0,
    structurePosition: f.structurePosition,
    roomToResistance: f.roomToResistanceAtr,
    roomToSupport: f.roomToSupportAtr,
    falseBreakoutRisk: f.falseBreakoutRisk,
    directionalStreak: f.directionalStreak,
    longEntryQuality: f.longEntryQuality,
    shortEntryQuality: f.shortEntryQuality
  };
  const learned = learningMemory.predict(learnedFeatures);
  const independent = new Map(independentModels.predictAll(learnedFeatures)
    .map(model => [model.modelId, model]));
  const modelSide = (id, fallback) => resolveModelSide(independent.get(id), fallback);
  const modelConfidence = id => {
    const model = independent.get(id);
    return model?.trained ? Math.round(Math.max(model.probability, 1 - model.probability) * 100) : null;
  };

  // 1. Technical Analyst AI: multi-EMA trend plus momentum confirmation.
  const legacyTechSide = trendSide && (trendSide === "LONG" ? f.mom4 > 0 : f.mom4 < 0) ? trendSide : null;
  const techSide = modelSide("technical", legacyTechSide);
  vote(ROLE_NAMES[0], techSide, modelConfidence("technical") ?? (techSide ? 68 : 35),
    independent.get("technical")?.trained
      ? `independentModelP(long)=${independent.get("technical").pLong}; samples=${independent.get("technical").samples}`
      : `warmupFallback=technical-rules; trend=${f.trend}; mom4=${(f.mom4 * 100).toFixed(2)}%`);

  // 2. ML Signal AI: online logistic model trained only from closed-trade outcomes.
  const z = 1.25 * clamp((f.e9 - f.e21) / f.atr, -2, 2) +
    0.85 * clamp(f.mom4 / Math.max(f.atrPct, 0.0001), -2, 2) +
    0.45 * clamp(f.mom12 / Math.max(f.atrPct * 2, 0.0002), -2, 2) +
    0.25 * clamp((f.rsi - 50) / 20, -2, 2);
  const baselineP = logistic(z);
  const pLong = learned.trained ? 0.35 * baselineP + 0.65 * learned.pLong : baselineP;
  const legacyMlSide = pLong >= 0.62 ? "LONG" : pLong <= 0.38 ? "SHORT" : null;
  const mlModel = independent.get("signal");
  const mlSide = modelSide("signal", legacyMlSide);
  const mlConfidence = modelConfidence("signal") ?? Math.round(Math.max(pLong, 1 - pLong) * 100);
  vote(ROLE_NAMES[1], mlSide, mlConfidence,
    mlModel?.trained
      ? `independentModelP(long)=${mlModel.pLong}; samples=${mlModel.samples}`
      : `warmupFallback=legacy-online; samples=${mlModel?.samples || 0}; legacySamples=${learned.samples}`);

  // 3. Learning & Memory AI: persistent memory is distinct from model prediction.
  const memoryState = learningMemory.read();
  const legacyMemSide = learned.trained && learned.side &&
    Math.sign(f.mom4) === Math.sign(f.mom12) &&
    Math.abs(f.mom12) > f.atrPct * 0.25 ? learned.side : null;
  const memModel = independent.get("memory");
  const memSide = modelSide("memory", legacyMemSide);
  vote(ROLE_NAMES[2], memSide, modelConfidence("memory") ?? (memSide ? 60 : 25),
    memModel?.trained
      ? `independentMemoryModelP(long)=${memModel.pLong}; samples=${memModel.samples}`
      : `warmupFallback=legacy-memory; samples=${memoryState.samples}; momentumPersistence=${(f.mom12 * 100).toFixed(2)}%`);

  // 4. Bull AI.
  const legacyBullSide = f.rsi >= 52 && f.mom4 > 0 && f.last.c > f.e21 ? "LONG" : null;
  const bullModel = independent.get("bull");
  const bullSide = resolveModelSide(bullModel, legacyBullSide);
  vote(ROLE_NAMES[3], bullSide, modelConfidence("bull") ?? (bullSide ? 60 : 25),
    bullModel?.trained ? `independentBullModelP(long)=${bullModel.pLong}` : `warmupFallback=bull-rules; RSI=${f.rsi.toFixed(1)}`);

  // 5. Bear AI.
  const legacyBearSide = f.rsi <= 48 && f.mom4 < 0 && f.last.c < f.e21 ? "SHORT" : null;
  const bearModel = independent.get("bear");
  const bearSide = resolveModelSide(bearModel, legacyBearSide);
  vote(ROLE_NAMES[4], bearSide, modelConfidence("bear") ?? (bearSide ? 60 : 25),
    bearModel?.trained ? `independentBearModelP(long)=${bearModel.pLong}` : `warmupFallback=bear-rules; RSI=${f.rsi.toFixed(1)}`);

  // 6. Contrarian AI: detect false breakouts/breakdowns and rejection wicks.
  const contrarian = detectContrarianSignal(candles, f);
  const contraModel = independent.get("contrarian");
  // A confirmed trap remains the stronger signal and retains its hard-veto semantics.
  const contraSide = contrarian.side || modelSide("contrarian", null);
  vote(ROLE_NAMES[5], contraSide, contrarian.side ? contrarian.strength :
    (modelConfidence("contrarian") ?? 50),
    contrarian.side
      ? `${contrarian.reason}; extension=${f.extensionAtr.toFixed(2)} ATR; RSI=${f.rsi.toFixed(1)}; wickUp=${(contrarian.upperWickRatio || 0).toFixed(2)}; wickDown=${(contrarian.lowerWickRatio || 0).toFixed(2)}`
      : contraModel?.trained ? `independentContrarianModelP(long)=${contraModel.pLong}; no-confirmed-trap`
      : `warmupFallback=no-confirmed-trap; extension=${f.extensionAtr.toFixed(2)} ATR`);

  // 7. Analyst/Auditor AI: independent quality and data integrity check.
  const candle = f.last;
  const candleRange = candle.h - candle.l;
  const candleBody = Math.abs(candle.c - candle.o);
  const legacyAuditorSide = f.volumeRatio >= 0.65 && candleRange > 0 &&
    candleBody / candleRange >= 0.2 ? techSide : null;
  const analystModel = independent.get("analyst");
  const auditorSide = modelSide("analyst", legacyAuditorSide);
  vote(ROLE_NAMES[6], auditorSide, modelConfidence("analyst") ?? (auditorSide ? 58 : 20),
    analystModel?.trained
      ? `independentAnalystModelP(long)=${analystModel.pLong}; volumeRatio=${f.volumeRatio.toFixed(2)}`
      : `warmupFallback=market-quality-check; volumeRatio=${f.volumeRatio.toFixed(2)}; body/range=${(candleRange ? candleBody / candleRange : 0).toFixed(2)}`);

  // 8. Decision AI: consensus from roles 1-7. The risk role can still veto.
  const longCount = longVotes.length, shortCount = shortVotes.length;
  const consensusSide = longCount >= 4 && longCount - shortCount >= 2 ? "LONG" :
    shortCount >= 4 && shortCount - longCount >= 2 ? "SHORT" : null;
  const decisionModel = independent.get("decision");
  const side = decisionModel?.trained && ["LONG", "SHORT"].includes(decisionModel.side)
    ? (consensusSide && decisionModel.side === consensusSide ? consensusSide : null)
    : consensusSide;
  const chosenVotes = side === "LONG" ? longVotes : side === "SHORT" ? shortVotes : [];
  const confidence = chosenVotes.length
    ? Math.round(avg(chosenVotes.map(v => v.confidence)) * Math.min(1, chosenVotes.length / 5))
    : 0;
  const decisionConfidence = modelConfidence("decision");
  roleResults.push({ name: ROLE_NAMES[7], side: side || "WAIT",
    confidence: decisionConfidence == null ? confidence : Math.min(confidence || decisionConfidence, decisionConfidence),
    weight: ROLE_WEIGHTS[ROLE_NAMES[7]],
    reason: decisionModel?.trained
      ? `independentDecisionP(long)=${decisionModel.pLong}; consensus=${consensusSide || "WAIT"}; samples=${decisionModel.samples}`
      : `warmupFallback=consensus; longVotes=${longCount}; shortVotes=${shortCount}; minConsensus=4` });

  // 9. Risk Manager AI: risk veto for volatility, poor location, weak consensus.
  const riskReasons = [];
  const riskModel = independent.get("risk");
  const learnedRisk = assessIndependentRiskModel(riskModel);
  // pLoss is deliberately not a hard veto. Its inverse lowers this role's
  // ranking contribution, while deterministic safety checks still veto.
  if (f.atrPct < 0.001 || f.atrPct > 0.04) riskReasons.push("ATR_PERCENT_OUT_OF_RANGE");
  if (f.rsi > 86 && side === "LONG") riskReasons.push("LONG_OVERBOUGHT");
  if (f.rsi < 14 && side === "SHORT") riskReasons.push("SHORT_OVERSOLD");
  if (confidence < 55) riskReasons.push("CONFIDENCE_BELOW_55");
  if (side && side === "LONG" && f.last.c <= f.e21) riskReasons.push("LONG_BELOW_EMA21");
  if (side && side === "SHORT" && f.last.c >= f.e21) riskReasons.push("SHORT_ABOVE_EMA21");
  // A confirmed trap opposing the proposed entry is a hard safety veto, not
  // merely a small score penalty. If consensus aligns with the reversal side,
  // the trap supports that trade instead.
  if (isContrarianConflict(side, contrarian)) {
    riskReasons.push("CONTRARIAN_TRAP_OPPOSES_SIGNAL");
  }
  const riskAllowed = Boolean(side) && riskReasons.length === 0;
  roleResults.push({ name: ROLE_NAMES[8], side: riskAllowed ? side : "VETO",
    confidence: riskAllowed ? learnedRisk.confidence : 100,
    weight: ROLE_WEIGHTS[ROLE_NAMES[8]],
    reason: riskAllowed
      ? `RISK_CHECKS_PASSED; ${learnedRisk.reason}; independentPLoss=${riskModel?.pLoss ?? "unavailable"}`
      : (riskReasons.join(",") || "NO_DECISION") });

  if (!riskAllowed) return { ...abstain, reason: riskReasons.join(",") || "NO_CONSENSUS",
    roles: roleResults, candles: candles.length, features: summarize(f) };

  // All nine roles vote on the initial risk plan. Technical structure and
  // ATR supply price anchors, while weighted role evidence selects stop room
  // and the target RR. The hard RR ceiling is always 1.80.
  const entry = f.last.c;
  const weightedPlan = calculateWeightedRoleScore(roleResults, side);
  const rolePlanScore = weightedPlan.score;
  const opposingRolePressure = roleResults
    .filter(role => role.name !== "Decision AI" && role.name !== "Risk Manager AI" &&
      (role.side === "LONG" || role.side === "SHORT") && role.side !== side)
    .reduce((sum, role) => sum + (ROLE_WEIGHTS[role.name] || 0) * role.confidence, 0);
  const riskRole = roleResults.find(role => role.name === "Risk Manager AI");
  const contrarianRole = roleResults.find(role => role.name === "Contrarian AI");
  const riskPressure = clamp(
    ((Number(riskRole?.confidence) || 50) - 50) / 50 +
    opposingRolePressure / 100 +
    ((contrarianRole?.side && contrarianRole.side !== side) ? (Number(contrarianRole.confidence) || 0) / 200 : 0),
    0, 1
  );
  const minimumStop = Math.max(f.atr * 0.8, entry * 0.0008);
  const structureStop = side === "LONG"
    ? Math.max(entry - f.swingLow + f.atr * 0.1, 0)
    : Math.max(f.swingHigh - entry + f.atr * 0.1, 0);
  const baseStopDistance = Math.max(minimumStop, structureStop);
  const stopDistance = baseStopDistance * (1 - 0.18 * riskPressure);
  const targetRR = Math.round(clamp(0.8 + rolePlanScore / 100 * 1.0, 0.8, 1.8) * 100) / 100;
  const targetDistance = stopDistance * targetRR;
  const sl = side === "LONG" ? entry - stopDistance : entry + stopDistance;
  const tp = side === "LONG" ? entry + targetDistance : entry - targetDistance;
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (![entry, sl, tp, rr, targetRR].every(Number.isFinite) || entry <= 0 || sl <= 0 ||
      (side === "LONG" ? !(sl < entry && tp > entry) : !(tp < entry && sl > entry)) ||
      rr < 0.79 || rr > 1.8 + 1e-9) {
    return { ...abstain, reason: "FINAL_TRADE_GEOMETRY_INVALID", roles: roleResults, candles: candles.length };
  }

  // All nine roles contribute through explicit weights. A role agreeing with
  // the chosen side adds its conviction; an opposing role subtracts it; a
  // neutral role contributes 50 rather than an arbitrary fixed penalty.
  // Market setup quality is only a 15% secondary factor, never a replacement
  // for the nine-role score. Contrarian is weighted at 15% and its trap result
  // is visible in the role audit trail.
  const opposingVotes = side === "LONG" ? shortVotes.length : longVotes.length;
  const directionalVotes = chosenVotes.length;
  const consensusMargin = directionalVotes - opposingVotes;
  const consensusCoverage = clamp(directionalVotes / 7 * 100, 0, 100);
  const marginQuality = clamp((consensusMargin + 7) / 14 * 100, 0, 100);
  const trendAlignment = trendSide === side ? 100 : 0;
  const momentumMatches = [
    Math.sign(f.mom4) === (side === "LONG" ? 1 : -1),
    Math.sign(f.mom12) === (side === "LONG" ? 1 : -1)
  ].filter(Boolean).length;
  const momentumAlignment = momentumMatches * 50;
  const volumeQuality = clamp(f.volumeRatio / 1.5 * 100, 0, 100);
  const extensionQuality = clamp(100 - Math.abs(f.extensionAtr) * 15, 0, 100);
  const alignedBreakout = side === "LONG" ? f.breakoutStrength > 0 : f.breakoutStrength < 0;
  const breakoutQuality = f.falseBreakoutRisk
    ? 15
    : alignedBreakout
      ? clamp(55 + Math.abs(f.breakoutStrength) * 20 + (f.volumeRatio >= 1.1 ? 10 : 0) +
          (Math.abs(f.candleBodyRatio) >= 0.55 ? 10 : 0), 0, 100)
      : f.breakoutStrength !== 0 ? 30 : 60;
  const roomToOpposingStructure = side === "LONG" ? f.roomToResistanceAtr : f.roomToSupportAtr;
  const roomQuality = roomToOpposingStructure < 0
    ? (alignedBreakout && Math.abs(f.breakoutStrength) >= 0.1 ? 65 : 20)
    : roomToOpposingStructure < 0.5 ? 25
      : roomToOpposingStructure < 1 ? 50
        : roomToOpposingStructure < 1.5 ? 70 : 90;
  const configuredCostRate = Number(process.env.NINE_AI_ROUND_TRIP_COST_RATE);
  const hasCostModel = process.env.NINE_AI_ROUND_TRIP_COST_RATE != null &&
    String(process.env.NINE_AI_ROUND_TRIP_COST_RATE).trim() !== "" &&
    Number.isFinite(configuredCostRate) && configuredCostRate >= 0;
  const estimatedRoundTripCost = hasCostModel ? entry * configuredCostRate : null;
  const netRR = hasCostModel
    ? Math.max(0, Math.abs(tp - entry) - estimatedRoundTripCost) /
      Math.max(Math.abs(entry - sl) + estimatedRoundTripCost, Number.EPSILON)
    : null;
  const rewardQuality = clamp(
    (hasCostModel ? netRR : rr) / MAX_NINE_AI_RR * 100, 0, 100
  );
  const directionalEntryQuality = side === "LONG" ? f.longEntryQuality : f.shortEntryQuality;
  const entryQuality = Math.round(clamp(
    directionalEntryQuality * 0.75 + rewardQuality * 0.25, 0, 100
  ));
  const setupQuality = Math.round(
    consensusCoverage * 0.25 +
    marginQuality * 0.15 +
    trendAlignment * 0.15 +
    momentumAlignment * 0.10 +
    volumeQuality * 0.10 +
    extensionQuality * 0.05 +
    breakoutQuality * 0.10 +
    roomQuality * 0.10
  );
  const policy = learningMemory.decisionPolicy();
  const adaptiveDecisionWeights = policy.decisionWeights;
  const weighted = calculateWeightedRoleScore(roleResults, side, policy.roleWeights);
  const roleScore = weighted.score;
  const rankScore = Math.round(clamp(
    roleScore * adaptiveDecisionWeights.role + setupQuality * adaptiveDecisionWeights.setup +
    entryQuality * adaptiveDecisionWeights.entry, 0, 100
  ) * 100) / 100;
  const rankedRoles = weighted.roles;
  const rankMetrics = {
    score: rankScore, roleScore,
    roleWeight: adaptiveDecisionWeights.role, setupWeight: adaptiveDecisionWeights.setup,
    entryQualityWeight: adaptiveDecisionWeights.entry, adaptivePolicySamples: policy.samples,
    roleWeights: policy.roleWeights,
    desiredRR: targetRR,
    maxRiskReward: 1.8,
    riskPressure,
    grossRR: rr,
    netRR,
    netRRStatus: hasCostModel ? "ESTIMATED_WITH_CONFIGURED_ROUND_TRIP_COST" : "NOT_CONFIGURED",
    entryQuality,
    rewardQuality: Math.round(rewardQuality),
    breakoutQuality: Math.round(breakoutQuality),
    roomQuality: Math.round(roomQuality),
    roleContributions: rankedRoles.map(role => ({
      name: role.name, weight: role.weight, score: role.score,
      weightedContribution: role.weightedContribution, side: role.side
    })),
    contrarian: { side: contrarian.side, strength: contrarian.strength, reason: contrarian.reason },
    setupQuality,
    directionalVotes,
    opposingVotes,
    consensusMargin,
    consensusCoverage: Math.round(consensusCoverage),
    trendAlignment,
    momentumAlignment,
    volumeQuality: Math.round(volumeQuality),
    extensionQuality: Math.round(extensionQuality),
    phase: f.trend,
    impulseSide: side,
    energyRatio: f.volumeRatio,
    early: false,
    roles: rankedRoles,
    features: summarize(f)
  };

  return {
    symbol, side, action: side, confidence, price: entry, entry, sl, tp, rr,
    tradePlan: {
      timeframe: "15m",
      entryMethod: "LATEST_CLOSED_CANDLE",
      stopMethod: "ATR_AND_RECENT_STRUCTURE",
      targetMethod: "NINE_AI_WEIGHTED_RR",
      stopDistance,
      targetDistance,
      desiredRR: targetRR,
      rolePlanScore,
      riskPressure,
      riskReward: rr,
      maxRiskReward: 1.8
    },
    signalAt: f.last.closeTime, setup: "NINE_AI_15M",
    marketState: f.marketRegime,
    volatility: f.volatilityRegime,
    qualityScore: rankScore, score: rankScore, rankScore,
    rankMetrics,
    roles: rankedRoles, candles: candles.length,
    // A non-WAIT decision that passed all nine-role checks is the only
    // signal the scanner may consider; deterministic execution risk guards
    // and position limits still have final veto authority.
    authorizedForExecution: true
  };
}

const MAX_NINE_AI_RR = 1.8;
const MIN_NINE_AI_FAVORABLE_R_FOR_TPSL_UPDATE = 0.5;
const NINE_AI_STRONG_OPPOSITE_EXIT_SCORE = 72;

function shouldNineAIExitPosition(decision, heldSide) {
  if (!decision || decision.authorizedForExecution !== true || !["LONG", "SHORT"].includes(heldSide)) return false;
  const side = decision.side;
  const score = Number(decision?.rankMetrics?.roleScore ?? decision?.rankScore ?? decision?.confidence ?? 0);
  return ["LONG", "SHORT"].includes(side) && side !== heldSide && Number.isFinite(score) && score >= NINE_AI_STRONG_OPPOSITE_EXIT_SCORE;
}

function canNineAIDynamicallyAdjust({ side, entry, current, initialRisk }) {
  if (!["LONG", "SHORT"].includes(side)) return false;
  const values = [entry, current, initialRisk].map(Number);
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return false;
  const [e, c, risk] = values;
  const favorableMove = side === "LONG" ? c - e : e - c;
  return favorableMove / risk >= MIN_NINE_AI_FAVORABLE_R_FOR_TPSL_UPDATE;
}

function deriveNineAIDynamicPlan({
  decision, side, entry, current, oldSL, oldTP, tickSize
}) {
  const validSide = side === "LONG" || side === "SHORT";
  const values = [entry, current, oldSL, oldTP, tickSize].map(Number);
  if (!validSide || values.some(v => !Number.isFinite(v) || v <= 0)) return null;
  [entry, current, oldSL, oldTP, tickSize] = values;

  const features = decision?.rankMetrics?.features || decision?.features || {};
  const roles = Array.isArray(decision?.roles) ? decision.roles : [];
  const roleScore = Number(decision?.rankMetrics?.roleScore ?? decision?.rankScore ?? decision?.confidence ?? 50);
  const score = clamp(Number.isFinite(roleScore) ? roleScore : 50, 0, 100);
  const authorized = decision?.authorizedForExecution === true;
  const supports = authorized && decision?.side === side && score >= 65;
  const stronglyOpposes = authorized && ["LONG", "SHORT"].includes(decision?.side) &&
    decision.side !== side && score >= 72;
  const atr = Number(features.atr14 ?? decision?.tradePlan?.stopDistance);
  if (!(atr > 0) || !Number.isFinite(atr)) return null;

  // 9AI role consensus chooses how much room remains. Technical features only
  // anchor prices; they do not override the role decision or safety invariants.
  const contrarian = roles.find(role => role.name === "Contrarian AI");
  const riskRole = roles.find(role => role.name === "Risk Manager AI");
  const contraOpposes = contrarian?.side && contrarian.side !== side &&
    Number(contrarian.confidence) >= 60;
  const riskWeak = !riskRole || riskRole.side === "VETO" || Number(riskRole.confidence) >= 90;
  let stopRoom = supports ? (score >= 82 ? 1.25 : 0.8) : 0.35;
  if (stronglyOpposes || contraOpposes || riskWeak) stopRoom = 0.2;
  const proposedSL = side === "LONG"
    ? current - Math.max(tickSize * 2, atr * stopRoom)
    : current + Math.max(tickSize * 2, atr * stopRoom);

  // Monotonic protection: a long stop can only rise; a short stop can only fall.
  let sl = side === "LONG" ? Math.max(oldSL, proposedSL) : Math.min(oldSL, proposedSL);
  if (side === "LONG" && sl >= current - tickSize) sl = oldSL;
  if (side === "SHORT" && sl <= current + tickSize) sl = oldSL;

  // The original TP is the confirmed plan. Dynamic management may extend
  // it when aligned evidence supports a farther target, but must never pull
  // it inward merely because a later score is weaker. Opposite signals are
  // handled by the live-position exit policy in index.js.
  let desiredRR = supports
    ? clamp(0.8 + score / 100 * 1.1, 0.8, MAX_NINE_AI_RR)
    : clamp(0.8 + (100 - score) / 100 * 0.35, 0.8, 1.15);
  if (stronglyOpposes || contraOpposes || riskWeak) desiredRR = Math.min(desiredRR, 0.9);
  const riskDistance = Math.abs(entry - sl);
  if (!(riskDistance > 0)) return null;

  const rrCapPrice = side === "LONG"
    ? entry + riskDistance * MAX_NINE_AI_RR
    : entry - riskDistance * MAX_NINE_AI_RR;
  // If live price has already passed the highest allowed RR target, close
  // rather than retain a target that violates the 1.8 ceiling.
  if ((side === "LONG" && rrCapPrice <= current + tickSize) ||
      (side === "SHORT" && rrCapPrice >= current - tickSize)) {
    return {
      sl, tp: oldTP, rr: Math.abs(oldTP - entry) / riskDistance,
      desiredRR, roleScore: score, supports, stronglyOpposes,
      action: "CLOSE_TARGET_REACHED", reason: "MAX_RR_TARGET_ALREADY_CROSSED"
    };
  }
  const targetPrice = side === "LONG"
    ? entry + riskDistance * desiredRR
    : entry - riskDistance * desiredRR;
  const proposedTP = side === "LONG"
    ? Math.min(targetPrice, rrCapPrice)
    : Math.max(targetPrice, rrCapPrice);
  // Never reduce the original reward target. If the old target now conflicts
  // with live geometry or the 1.8R cap, reject this update instead of pulling
  // TP close to the market.
  let tp = side === "LONG"
    ? Math.max(oldTP, proposedTP)
    : Math.min(oldTP, proposedTP);

  // TP is allowed to move closer or farther, but it must remain on the
  // profitable side of the live market and RR must never exceed 1.8.
  if (side === "LONG" && tp <= current + tickSize) {
    const safeTP = Math.min(rrCapPrice, current + tickSize * 2);
    if (safeTP <= current + tickSize || safeTP <= entry) return null;
    tp = safeTP;
  }
  if (side === "SHORT" && tp >= current - tickSize) {
    const safeTP = Math.max(rrCapPrice, current - tickSize * 2);
    if (safeTP >= current - tickSize || safeTP >= entry) return null;
    tp = safeTP;
  }

  const precision = Math.max(0, String(tickSize).split(".")[1]?.length || 0);
  sl = Number((side === "LONG"
    ? Math.ceil(sl / tickSize) * tickSize
    : Math.floor(sl / tickSize) * tickSize).toFixed(precision));
  tp = Number((side === "LONG"
    ? Math.floor(tp / tickSize) * tickSize
    : Math.ceil(tp / tickSize) * tickSize).toFixed(precision));

  if (side === "LONG" && (sl < oldSL || sl >= current || tp <= current || tp <= entry)) return null;
  if (side === "SHORT" && (sl > oldSL || sl <= current || tp >= current || tp >= entry)) return null;
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (!Number.isFinite(rr) || rr > MAX_NINE_AI_RR + 1e-9) return null;

  return {
    sl, tp, rr, desiredRR, roleScore: score, supports, stronglyOpposes,
    action: stronglyOpposes ? "CLOSE_EARLY" : "UPDATE_TPSL",
    reason: stronglyOpposes ? "STRONG_OPPOSITE_NINE_AI" :
      supports ? "NINE_AI_ALIGNED" : "NINE_AI_RISK_TIGHTEN"
  };
}

function summarize(f) {
  return {
    close: f.last.c, ema9: f.e9, ema21: f.e21, ema50: f.e50,
    rsi14: f.rsi, atr14: f.atr, atrPercent: f.atrPct, momentum4: f.mom4,
    momentum12: f.mom12, volumeRatio: f.volumeRatio, trend: f.trend,
    marketRegime: f.marketRegime, volatilityRegime: f.volatilityRegime,
    extensionAtr: f.extensionAtr, swingHigh: f.swingHigh, swingLow: f.swingLow,
    high20: f.high20, low20: f.low20, candleBodyRatio: f.candleBodyRatio,
    upperWickRatio: f.upperWickRatio, lowerWickRatio: f.lowerWickRatio,
    insideBar: f.insideBar, bullishEngulfing: f.bullishEngulfing,
    bearishEngulfing: f.bearishEngulfing, breakoutStrength: f.breakoutStrength,
    falseBreakoutRisk: f.falseBreakoutRisk, structurePosition: f.structurePosition,
    structureTrend: f.structureTrend, roomToResistanceAtr: f.roomToResistanceAtr,
    roomToSupportAtr: f.roomToSupportAtr, directionalStreak: f.directionalStreak,
    longEntryQuality: Math.round(f.longEntryQuality),
    shortEntryQuality: Math.round(f.shortEntryQuality)
  };
}

// Higher composite rank wins. The nine-AI confidence remains the first
// meaningful tie-breaker, followed by role consensus and market confirmation.
// Symbol order is only the final deterministic fallback.
function compareNineAICandidates(a, b) {
  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return (
    num(b?.rankScore, num(b?.confidence)) - num(a?.rankScore, num(a?.confidence)) ||
    num(b?.confidence) - num(a?.confidence) ||
    num(b?.rankMetrics?.consensusMargin) - num(a?.rankMetrics?.consensusMargin) ||
    num(b?.rankMetrics?.directionalVotes) - num(a?.rankMetrics?.directionalVotes) ||
    num(b?.rankMetrics?.setupQuality) - num(a?.rankMetrics?.setupQuality) ||
    num(b?.rankMetrics?.volumeQuality) - num(a?.rankMetrics?.volumeQuality) ||
    String(a?.symbol || "").localeCompare(String(b?.symbol || ""))
  );
}

module.exports = {
  ROLE_NAMES, ROLE_WEIGHTS, parseClosedCandles, buildFeatures,
  resolveModelSide, assessIndependentRiskModel,
  detectContrarianSignal, isContrarianConflict, calculateWeightedRoleScore,
  analyzeNineAI, compareNineAICandidates, deriveNineAIDynamicPlan,
  shouldNineAIExitPosition, canNineAIDynamicallyAdjust, MAX_NINE_AI_RR, MIN_NINE_AI_FAVORABLE_R_FOR_TPSL_UPDATE, NINE_AI_STRONG_OPPOSITE_EXIT_SCORE
};
