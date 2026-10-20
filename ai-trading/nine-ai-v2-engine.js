"use strict";

// Nine-AI v2: one decision authority, nine explicit analytical roles.
// This module is deterministic and auditable. It does not pretend heuristic
// estimates are trained probabilities: live authorization requires labelled,
// regime-matched closed-trade outcomes and complete point-in-time market data.
const TIMEFRAME_MS = 4 * 60 * 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;
const RISK_FRACTION = 0.0075;
const MAX_HOLD_BARS = 24;
const MIN_LABELS = 30;
const MIN_EDGE_R = 0.10;
const MIN_GAP_EDGE_R = 0.15;
const MAX_SIGNAL_AGE_MS = 5 * 60 * 1000;
const ROLE_NAMES = Object.freeze([
  "Regime", "Structure", "Continuation", "Breakout", "Mean Rev",
  "Flow", "Outcome", "Fill/Slippage", "Meta/Decision"
]);

const finite = value => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sorted = values => values.filter(Number.isFinite).sort((a, b) => a - b);
function percentile(values, q) {
  const xs = sorted(values);
  if (!xs.length) return null;
  const index = (xs.length - 1) * clamp(q, 0, 1);
  const lo = Math.floor(index), hi = Math.ceil(index);
  return xs[lo] + (xs[hi] - xs[lo]) * (index - lo);
}
function parseClosedCandles(raw, timeframeMs = TIMEFRAME_MS, asOf = Date.now()) {
  if (!Array.isArray(raw)) return [];
  return raw.map(row => {
    if (Array.isArray(row)) return {
      openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
      closeTime: Number(row[6])
    };
    return {
      openTime: Number(row?.openTime ?? row?.time), open: Number(row?.open ?? row?.o),
      high: Number(row?.high ?? row?.h), low: Number(row?.low ?? row?.l),
      close: Number(row?.close ?? row?.c), volume: Number(row?.volume ?? row?.v),
      closeTime: Number(row?.closeTime ?? row?.close_time)
    };
  }).filter(c =>
    [c.openTime, c.open, c.high, c.low, c.close, c.volume, c.closeTime].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.closeTime < asOf && c.closeTime >= c.openTime &&
    c.closeTime - c.openTime <= timeframeMs + 1000
  ).sort((a, b) => a.openTime - b.openTime)
    .filter((c, i, xs) => i === 0 || c.openTime > xs[i - 1].openTime);
}
function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const values = [];
  for (let i = candles.length - period; i < candles.length; i++) values.push(trueRange(candles[i], candles[i - 1].close));
  return mean(values);
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function logReturns(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0 && candles[i].close > 0) out.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  return out;
}
function realizedVolatility(candles, bars = 20) {
  const rs = logReturns(candles.slice(-(bars + 1)));
  return rs.length ? Math.sqrt(rs.reduce((sum, r) => sum + r * r, 0)) : null;
}
function estimateRegime(candles4h, dailyCandles) {
  const daily = dailyCandles;
  if (candles4h.length < 60 || daily.length < 90) {
    return { regime: "UNKNOWN", regime_conf: 0, reason: "INSUFFICIENT_4H_OR_90D_DAILY_HISTORY" };
  }
  const closes = candles4h.map(c => c.close);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const momentum20 = closes.at(-1) / closes.at(-21) - 1;
  const momentum60 = closes.at(-1) / closes.at(-61) - 1;
  const trendUp = e20 > e50 && momentum20 > 0 && momentum60 > 0;
  const trendDown = e20 < e50 && momentum20 < 0 && momentum60 < 0;
  const rolling = [];
  for (let end = 20; end <= daily.length; end++) {
    const v = realizedVolatility(daily.slice(0, end), 20);
    if (Number.isFinite(v)) rolling.push(v);
  }
  const currentVol = realizedVolatility(daily, 20);
  const volP80 = percentile(rolling, 0.80);
  const volP20 = percentile(rolling, 0.20);
  if (![currentVol, volP80, volP20, e20, e50].every(Number.isFinite)) {
    return { regime: "UNKNOWN", regime_conf: 0, reason: "REGIME_FEATURES_INVALID" };
  }
  const highVol = currentVol >= volP80;
  const lowVol = currentVol <= volP20;
  const trendStrength = clamp(Math.abs(momentum20) / Math.max(Math.abs(momentum60), 0.002), 0, 1);
  let regime = trendUp ? "TREND_UP" : trendDown ? "TREND_DOWN" : "SIDEWAYS";
  if (highVol) regime = "HIGH_VOL";
  const directionalAgreement = (trendUp || trendDown) && Math.sign(momentum20) === Math.sign(momentum60);
  const confidence = clamp(
    0.45 * (highVol ? 1 : lowVol ? 0.8 : 0.65) +
    0.35 * trendStrength +
    0.20 * (directionalAgreement ? 1 : 0.45), 0, 1
  );
  return {
    regime, regime_conf: Number(confidence.toFixed(4)),
    volatility20d: currentVol, volatilityP20: volP20, volatilityP80: volP80,
    momentum20, momentum60, ema20: e20, ema50: e50,
    trendDirection: trendUp ? "LONG" : trendDown ? "SHORT" : null
  };
}
function findFractalStructure(candles) {
  const rows = candles.slice(-120);
  const highs = [], lows = [];
  for (let i = 2; i < rows.length - 2; i++) {
    const c = rows[i];
    if (c.high > rows[i - 1].high && c.high > rows[i - 2].high &&
        c.high >= rows[i + 1].high && c.high >= rows[i + 2].high) highs.push({ price: c.high, time: c.closeTime });
    if (c.low < rows[i - 1].low && c.low < rows[i - 2].low &&
        c.low <= rows[i + 1].low && c.low <= rows[i + 2].low) lows.push({ price: c.low, time: c.closeTime });
  }
  const last = rows.at(-1);
  if (!last || highs.length < 2 || lows.length < 2) {
    return { structure_bias: "UNKNOWN", support: null, resistance: null, swingHighs: highs, swingLows: lows };
  }
  const recentHighs = highs.slice(-4), recentLows = lows.slice(-4);
  const higherHighs = recentHighs.length >= 2 && recentHighs.at(-1).price > recentHighs[0].price;
  const higherLows = recentLows.length >= 2 && recentLows.at(-1).price > recentLows[0].price;
  const lowerHighs = recentHighs.length >= 2 && recentHighs.at(-1).price < recentHighs[0].price;
  const lowerLows = recentLows.length >= 2 && recentLows.at(-1).price < recentLows[0].price;
  const structure_bias = higherHighs && higherLows ? "LONG" :
    lowerHighs && lowerLows ? "SHORT" : "NEUTRAL";
  const supports = lows.map(x => x.price).filter(price => price < last.close);
  const resistances = highs.map(x => x.price).filter(price => price > last.close);
  return {
    structure_bias, support: supports.length ? Math.max(...supports) : null,
    resistance: resistances.length ? Math.min(...resistances) : null,
    swingHighs: highs, swingLows: lows
  };
}
function computeVWAP(candles) {
  let volume = 0, total = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    total += typical * c.volume; volume += c.volume;
  }
  return volume > 0 ? total / volume : null;
}
function normalizedCost(context, entry, stopDistance, side) {
  const feeRate = finite(context.takerFeeRate) && Number(context.takerFeeRate) >= 0
    ? Number(context.takerFeeRate) : 0.0005;
  const spreadBps = Number(context.spreadBps);
  const depthUsd = Number(context.depthUsd);
  const latencyMs = Number(context.latencyMs);
  if (![spreadBps, depthUsd, latencyMs].every(Number.isFinite) || spreadBps < 0 || depthUsd < 0 || latencyMs < 0) return null;
  const slippageBps = spreadBps / 2 + (depthUsd > 0 ? Math.min(25, 2 / Math.sqrt(depthUsd / 1000)) : 25) + Math.min(10, latencyMs / 1000);
  const fundingRate = Number(context.fundingRate);
  const fundingCost = Number.isFinite(fundingRate) ? fundingRate * 12 * (side === "LONG" ? 1 : -1) : null;
  const priceRiskPct = stopDistance / entry;
  if (!(priceRiskPct > 0)) return null;
  const costPct = 2 * feeRate + slippageBps / 10000 + (fundingCost ?? 0);
  return {
    feeRate, slippageBps, fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
    fundingCostPct: fundingCost, costPct, costR: costPct / priceRiskPct,
    est_slippage: slippageBps / 10000 * entry
  };
}
function buildOutcomeDistribution(outcomes, family, regime, side) {
  const rows = (Array.isArray(outcomes) ? outcomes : []).filter(row =>
    row && row.labelled === true &&
    String(row.setupFamily || row.family || "") === family &&
    String(row.regime || "UNKNOWN") === regime &&
    String(row.side || "").toUpperCase() === side &&
    ["WIN", "LOSS"].includes(String(row.result || "").toUpperCase()) &&
    Number.isFinite(Number(row.netR)) &&
    Number.isFinite(Number(row.maePct)) && Number(row.maePct) >= 0 &&
    Number.isFinite(Number(row.mfePct)) && Number(row.mfePct) >= 0
  );
  const winners = rows.filter(row => String(row.result).toUpperCase() === "WIN");
  if (rows.length < MIN_LABELS || winners.length < Math.max(10, Math.ceil(MIN_LABELS * 0.25))) {
    return { ready: false, samples: rows.length, winningSamples: winners.length, reason: "INSUFFICIENT_LABELLED_OUTCOMES" };
  }
  const mae = winners.map(row => Number(row.maePct));
  const mfe = winners.map(row => Number(row.mfePct));
  const grossRs = winners.map(row => Number.isFinite(Number(row.grossR)) ? Number(row.grossR) : Number(row.netR)).filter(Number.isFinite);
  const pWin = rows.filter(row => String(row.result).toUpperCase() === "WIN").length / rows.length;
  return {
    ready: true, samples: rows.length, winningSamples: winners.length,
    pWin, expectedR: mean(grossRs), dist_MAE: { p80: percentile(mae, 0.80) },
    dist_MFE: { p50: percentile(mfe, 0.50), p90: percentile(mfe, 0.90) },
    maeSamples: mae.length, mfeSamples: mfe.length
  };
}
function buildCandidate(family, side, p, expectedR, costR, uncertaintyPenalty, details) {
  const edge = p * expectedR - costR - uncertaintyPenalty;
  return { family, side, p, expectedR, costR, uncertaintyPenalty, edge: Number(edge.toFixed(6)), ...details };
}
function waitResult(symbol, reason, diagnostics = {}) {
  return {
    symbol, side: null, action: "WAIT", setup: "NINE_AI_4H", authorizedForExecution: false,
    reason, signalAt: null, candles: 0, roles: ROLE_NAMES.map(name => ({ name, status: "WAIT" })),
    rankMetrics: { ...diagnostics }, riskFraction: RISK_FRACTION, maxHoldBars: MAX_HOLD_BARS
  };
}
function analyzeNineAI(raw4h, symbol, context = {}, asOf = Date.now()) {
  const candles = parseClosedCandles(raw4h, TIMEFRAME_MS, asOf);
  const daily = parseClosedCandles(context.dailyCandles, DAILY_MS, asOf);
  if (candles.length < 90) return waitResult(symbol, "INSUFFICIENT_CLOSED_4H_CANDLES", { closed4h: candles.length });
  const last = candles.at(-1), a = atr(candles, 14);
  if (!a || !Number.isFinite(a) || !(last.close > 0)) return waitResult(symbol, "INVALID_ATR_OR_PRICE");
  if (asOf - last.closeTime > MAX_SIGNAL_AGE_MS) return waitResult(symbol, "STALE_LAST_CLOSED_CANDLE", { lastCloseTime: last.closeTime });
  const regime = estimateRegime(candles, daily);
  if (regime.regime === "UNKNOWN") return waitResult(symbol, regime.reason, { regime });
  if (regime.regime_conf < 0.55) return waitResult(symbol, "LOW_REGIME_CONFIDENCE", { regime });
  const structure = findFractalStructure(candles);
  if (structure.structure_bias === "UNKNOWN") return waitResult(symbol, "INSUFFICIENT_FRACTAL_STRUCTURE", { regime, structure });
  const recent = candles.slice(-20);
  const vwap = computeVWAP(recent);
  const deviations = recent.map(c => c.close - vwap).filter(Number.isFinite);
  const sd = deviations.length ? Math.sqrt(mean(deviations.map(x => x * x))) : null;
  const volumeBase = mean(candles.slice(-21, -1).map(c => c.volume));
  const volumeRatio = volumeBase > 0 ? last.volume / volumeBase : 0;
  const priorRange = candles.slice(-21, -1);
  const rangeHigh = Math.max(...priorRange.map(c => c.high));
  const rangeLow = Math.min(...priorRange.map(c => c.low));
  const candleExtensionAtr = Math.abs(last.close - last.open) / a;
  const pullbackAtr = Math.abs(last.close - ema(candles.map(c => c.close), 20)) / a;
  const fundingRate = Number(context.fundingRate);
  const oiChange = Number(context.openInterestChangePct);
  const liquidation = context.liquidationCascade || null;
  const spreadBps = Number(context.spreadBps);
  const depthUsd = Number(context.depthUsd);
  const latencyMs = Number(context.latencyMs);
  if (![fundingRate, oiChange, spreadBps, depthUsd, latencyMs].every(Number.isFinite) ||
      spreadBps < 0 || depthUsd <= 0 || latencyMs < 0) {
    return waitResult(symbol, "MISSING_OR_STALE_FUNDING_OI_SPREAD_DEPTH_LATENCY", { regime, structure });
  }
  const fundingHotLong = fundingRate >= 0.0008;
  const fundingHotShort = fundingRate <= -0.0008;
  const oneBarMomentum = last.close / candles.at(-2).close - 1;
  const confirmsLong = oiChange > 0 && oneBarMomentum > 0 && fundingRate < 0.0008;
  const confirmsShort = oiChange > 0 && oneBarMomentum < 0 && fundingRate > -0.0008;
  const flow = {
    fundingRate, openInterestChangePct: oiChange, oneBarMomentum,
    liquidationCascade: liquidation,
    confirmation: confirmsLong ? "LONG_CONFIRMED" : confirmsShort ? "SHORT_CONFIRMED" : "NO_DIRECTIONAL_CONFIRMATION",
    confirmsLong, confirmsShort,
    blocksLong: fundingHotLong, blocksShort: fundingHotShort
  };
  const setups = [];
  const trendLong = regime.regime === "TREND_UP" && regime.trendDirection === "LONG" && structure.structure_bias === "LONG";
  const trendShort = regime.regime === "TREND_DOWN" && regime.trendDirection === "SHORT" && structure.structure_bias === "SHORT";
  // AI-3: pullback within a confirmed trend, followed by a directional push.
  const pushLong = last.close > last.open && last.close > candles.at(-2).high && last.close > last.open + 0.35 * a;
  const pushShort = last.close < last.open && last.close < candles.at(-2).low && last.close < last.open - 0.35 * a;
  if (trendLong && pullbackAtr <= 1.5 && pushLong && !fundingHotLong && flow.confirmsLong) {
    setups.push({ family: "CONTINUATION", side: "LONG", pPrior: clamp(0.52 + Math.min(0.15, volumeRatio * 0.04) + Math.min(0.08, oiChange * 2), 0.50, 0.72), expectedPriorR: 1.5, detail: { pullbackAtr, volumeRatio } });
  }
  if (trendShort && pullbackAtr <= 1.5 && pushShort && !fundingHotShort && flow.confirmsShort) {
    setups.push({ family: "CONTINUATION", side: "SHORT", pPrior: clamp(0.52 + Math.min(0.15, volumeRatio * 0.04) + Math.min(0.08, oiChange * 2), 0.50, 0.72), expectedPriorR: 1.5, detail: { pullbackAtr, volumeRatio } });
  }
  // AI-4: break and hold, expanding volume, tight spread, and no candle chasing.
  const heldBreakLong = last.close > rangeHigh && last.close - rangeHigh <= 0.35 * a;
  const heldBreakShort = last.close < rangeLow && rangeLow - last.close <= 0.35 * a;
  if (heldBreakLong && volumeRatio >= 1.5 && candleExtensionAtr <= 1.2 && spreadBps <= 12 && flow.confirmsLong && !fundingHotLong) {
    setups.push({ family: "BREAKOUT", side: "LONG", pPrior: clamp(0.52 + Math.min(0.18, (volumeRatio - 1) * 0.08), 0.50, 0.72), expectedPriorR: 1.6, detail: { volumeRatio, candleExtensionAtr, heldBreak: true } });
  }
  if (heldBreakShort && volumeRatio >= 1.5 && candleExtensionAtr <= 1.2 && spreadBps <= 12 && flow.confirmsShort && !fundingHotShort) {
    setups.push({ family: "BREAKOUT", side: "SHORT", pPrior: clamp(0.52 + Math.min(0.18, (volumeRatio - 1) * 0.08), 0.50, 0.72), expectedPriorR: 1.6, detail: { volumeRatio, candleExtensionAtr, heldBreak: true } });
  }
  // AI-5: mean reversion only in sideways/high-vol regimes, never against a trend.
  if (["SIDEWAYS", "HIGH_VOL"].includes(regime.regime) && vwap && sd > 0 && liquidation) {
    const z = (last.close - vwap) / sd;
    if (z <= -1.5 && Number(liquidation.longLiquidationUsd || 0) > 0 && !fundingHotLong && flow.confirmsLong) {
      setups.push({ family: "MEAN_REVERSION", side: "LONG", pPrior: 0.55, expectedPriorR: 1.25, detail: { vwap, deviationZ: z } });
    }
    if (z >= 1.5 && Number(liquidation.shortLiquidationUsd || 0) > 0 && !fundingHotShort && flow.confirmsShort) {
      setups.push({ family: "MEAN_REVERSION", side: "SHORT", pPrior: 0.55, expectedPriorR: 1.25, detail: { vwap, deviationZ: z } });
    }
  }
  if (!setups.length) return waitResult(symbol, "NO_SETUP_PASSED_REGIME_STRUCTURE_FLOW_FILTERS", { regime, structure, flow, volumeRatio, spreadBps });
  const candidates = [];
  const allOutcomes = Array.isArray(context.outcomes) ? context.outcomes : [];
  for (const setup of setups) {
    const outcomes = buildOutcomeDistribution(allOutcomes, setup.family, regime.regime, setup.side);
    if (!outcomes.ready || !Number.isFinite(outcomes.expectedR) || !Number.isFinite(outcomes.pWin)) {
      continue;
    }
    const maeDistance = last.close * outcomes.dist_MAE.p80;
    const structureStopDistance = setup.side === "LONG" && Number.isFinite(structure.support)
      ? last.close - (structure.support - 0.10 * a)
      : setup.side === "SHORT" && Number.isFinite(structure.resistance)
        ? (structure.resistance + 0.10 * a) - last.close : 0;
    const slDistance = Math.max(maeDistance, structureStopDistance);
    if (!(slDistance > 0) || slDistance / last.close > 0.08) continue;
    const cost = normalizedCost(context, last.close, slDistance, setup.side);
    if (!cost) continue;
    const uncertaintyPenalty = clamp(
      (1 - regime.regime_conf) * 0.5 +
      (allOutcomes.length < 60 ? 0.10 : 0) +
      (Math.abs(setups.find(s => s.side !== setup.side)?.pPrior - setup.pPrior) < 0.05 ? 0.10 : 0), 0, 1
    );
    const p = clamp(outcomes.pWin, 0, 1);
    const expectedR = outcomes.expectedR;
    const candidate = buildCandidate(setup.family, setup.side, p, expectedR, cost.costR, uncertaintyPenalty, {
      pPrior: setup.pPrior, outcomeDistribution: outcomes, slippage: cost,
      setupDetail: setup.detail
    });
    candidates.push(candidate);
  }
  if (!candidates.length) {
    return waitResult(symbol, "INSUFFICIENT_LABELLED_OUTCOMES_FOR_CALIBRATED_EDGE", {
      regime, structure, flow, requiredSamples: MIN_LABELS, availableFamilies: setups.map(s => s.family)
    });
  }
  const longs = candidates.filter(c => c.side === "LONG").sort((a, b) => b.edge - a.edge);
  const shorts = candidates.filter(c => c.side === "SHORT").sort((a, b) => b.edge - a.edge);
  const long = longs[0] || { edge: -Infinity };
  const short = shorts[0] || { edge: -Infinity };
  let chosen = null;
  if (long.edge > MIN_EDGE_R && long.edge - short.edge > MIN_GAP_EDGE_R) chosen = long;
  else if (short.edge > MIN_EDGE_R && short.edge - long.edge > MIN_GAP_EDGE_R) chosen = short;
  if (!chosen) return waitResult(symbol, "NET_EDGE_OR_DIRECTION_GAP_BELOW_THRESHOLD", {
    regime, structure, flow, edges: { long: long.edge, short: short.edge },
    minEdgeR: MIN_EDGE_R, gapEdgeR: MIN_GAP_EDGE_R, candidates
  });
  const dist = chosen.outcomeDistribution;
  const maeDistance = last.close * dist.dist_MAE.p80;
  const structureStopDistance = chosen.side === "LONG" && Number.isFinite(structure.support)
    ? last.close - (structure.support - 0.10 * a)
    : chosen.side === "SHORT" && Number.isFinite(structure.resistance)
      ? (structure.resistance + 0.10 * a) - last.close : 0;
  const slDistance = Math.max(maeDistance, structureStopDistance);
  const tp1Distance = last.close * dist.dist_MFE.p50;
  const tp2Distance = last.close * dist.dist_MFE.p90;
  const structuralRoom = chosen.side === "LONG"
    ? (Number.isFinite(structure.resistance) ? structure.resistance - last.close : Infinity)
    : (Number.isFinite(structure.support) ? last.close - structure.support : Infinity);
  if (structuralRoom <= tp1Distance) {
    return waitResult(symbol, "STRUCTURE_BLOCKS_TP1_ROOM", { regime, structure, chosen, structuralRoom });
  }
  if (![slDistance, tp1Distance, tp2Distance].every(Number.isFinite) ||
      slDistance <= 0 || tp1Distance <= 0 || tp2Distance < tp1Distance) {
    return waitResult(symbol, "INVALID_MAE_MFE_DISTRIBUTION", { chosen });
  }
  const entry = last.close;
  const sl = chosen.side === "LONG" ? entry - slDistance : entry + slDistance;
  const tp1 = chosen.side === "LONG" ? entry + tp1Distance : entry - tp1Distance;
  const tp2 = chosen.side === "LONG" ? entry + tp2Distance : entry - tp2Distance;
  if (!(sl > 0) || (chosen.side === "LONG" ? !(sl < entry && tp1 > entry && tp2 >= tp1) : !(sl > entry && tp1 < entry && tp2 <= tp1))) {
    return waitResult(symbol, "INVALID_FINAL_SL_TP_GEOMETRY", { chosen });
  }
  const signalAt = last.closeTime;
  const roleOutputs = [
    { name: "Regime", output: { regime: regime.regime, regime_conf: regime.regime_conf } },
    { name: "Structure", output: { structure_bias: structure.structure_bias, support: structure.support, resistance: structure.resistance } },
    { name: "Continuation", output: { p: chosen.family === "CONTINUATION" ? chosen.p : null, expectedR: chosen.family === "CONTINUATION" ? chosen.expectedR : null } },
    { name: "Breakout", output: { p: chosen.family === "BREAKOUT" ? chosen.p : null } },
    { name: "Mean Rev", output: { p: chosen.family === "MEAN_REVERSION" ? chosen.p : null } },
    { name: "Flow", output: { confirmation: flow.confirmation, ...flow } },
    { name: "Outcome", output: dist },
    { name: "Fill/Slippage", output: { est_slippage: chosen.slippage.est_slippage, costR: chosen.costR } },
    { name: "Meta/Decision", output: { edge: chosen.edge, longEdge: long.edge, shortEdge: short.edge } }
  ];
  return {
    symbol: String(symbol || "").toUpperCase(), side: chosen.side, action: chosen.side,
    setup: "NINE_AI_4H", setupFamily: chosen.family, rankDirectionMode: "NINE_AI_META_EDGE",
    authorizedForExecution: true, signalAt, scannedAt: asOf, candles: candles.length,
    entry, price: entry, sl, tp: tp2, tp1, tp2, tp1CloseFraction: 0.5,
    riskFraction: RISK_FRACTION, maxHoldBars: MAX_HOLD_BARS, maxHoldMs: MAX_HOLD_BARS * TIMEFRAME_MS,
    confidence: Number((chosen.p * 100).toFixed(2)), p: chosen.p, expectedR: chosen.expectedR,
    edge: chosen.edge, edges: { long: long.edge, short: short.edge },
    rr: Math.abs(tp2 - entry) / Math.abs(entry - sl),
    roles: roleOutputs, rankScore: Number((chosen.edge * 100).toFixed(2)),
    qualityScore: Number((chosen.p * 100).toFixed(2)),
    risk: { riskFraction: RISK_FRACTION, stopDistance: Math.abs(entry - sl) },
    rankMetrics: { regime, structure, flow, selectedCandidate: chosen, candidates, features: {
      regime: regime.regime, regimeConfidence: regime.regime_conf,
      structureBias: structure.structure_bias, volumeRatio, atr: a, atrPercent: a / entry,
      vwap, spreadBps, fundingRate, openInterestChangePct: oiChange,
      slippageEstimate: chosen.slippage.est_slippage
    }}
  };
}
function compareNineAICandidates(a, b) {
  const edgeA = Number(a?.edge ?? -Infinity), edgeB = Number(b?.edge ?? -Infinity);
  return edgeB - edgeA;
}
module.exports = {
  TIMEFRAME_MS, DAILY_MS, RISK_FRACTION, MAX_HOLD_BARS, MIN_LABELS, MIN_EDGE_R, MIN_GAP_EDGE_R,
  ROLE_NAMES, percentile, parseClosedCandles, estimateRegime, findFractalStructure,
  buildOutcomeDistribution, normalizedCost, analyzeNineAI, compareNineAICandidates
};
