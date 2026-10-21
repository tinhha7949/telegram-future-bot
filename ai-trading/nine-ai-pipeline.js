"use strict";
const { DEFAULT_POLICY, applyPolicy } = require("./nine-ai-policy");
const BAR_MS = 4 * 60 * 60 * 1000,
  MAX_DATA_AGE_MS = 5 * 60 * 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v, fallback = null) =>
  v == null || v === ""
    ? fallback
    : Number.isFinite(Number(v))
      ? Number(v)
      : fallback;
const mean = (xs) =>
  xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
const stdev = (xs) => {
  const m = mean(xs);
  return xs.length < 2 ? 0 : Math.sqrt(mean(xs.map((v) => (v - m) ** 2)));
};
function percentile(values, p) {
  const xs = values
    .filter((v) => v != null)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!xs.length) return null;
  const index = (xs.length - 1) * clamp(p, 0, 1),
    lo = Math.floor(index),
    hi = Math.ceil(index);
  return xs[lo] + (xs[hi] - xs[lo]) * (index - lo);
}
function closedCandles(input, now = Date.now()) {
  if (!Array.isArray(input)) return [];
  return input
    .map((c) =>
      Array.isArray(c)
        ? {
            time: +c[0],
            open: +c[1],
            high: +c[2],
            low: +c[3],
            close: +c[4],
            volume: +c[5],
            closeTime: +c[6],
          }
        : {
            time: +(c?.openTime ?? c?.time),
            open: +c?.open,
            high: +c?.high,
            low: +c?.low,
            close: +c?.close,
            volume: +c?.volume,
            closeTime: +c?.closeTime,
          },
    )
    .filter(
      (c) =>
        Object.values(c).every(Number.isFinite) &&
        c.time <= c.closeTime &&
        c.closeTime < now &&
        c.low > 0 &&
        c.volume >= 0 &&
        c.high >= Math.max(c.open, c.close) &&
        c.low <= Math.min(c.open, c.close),
    )
    .sort((a, b) => a.time - b.time)
    .filter((c, i, all) => !i || c.time !== all[i - 1].time);
}
function hasContiguousHistory(cs, interval, minimum) {
  if (cs.length < minimum) return false;
  return cs
    .slice(-minimum)
    .every((c, i, all) => !i || c.time - all[i - 1].time === interval);
}
function swingPoints(cs, radius = 2) {
  const highs = [],
    lows = [];
  for (let i = radius; i < cs.length - radius; i++) {
    const adjacent = cs
      .slice(i - radius, i + radius + 1)
      .filter((_, j) => j !== radius);
    if (adjacent.every((c) => c.high < cs[i].high))
      highs.push({ index: i, price: cs[i].high });
    if (adjacent.every((c) => c.low > cs[i].low))
      lows.push({ index: i, price: cs[i].low });
  }
  return { highs, lows };
}
function classifyRegime(cs, higher = []) {
  const closes = cs.map((c) => c.close),
    returns = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const scale = Math.sqrt(6 * 365) * 100,
    vols = [];
  for (let i = 120; i <= returns.length; i++)
    vols.push(stdev(returns.slice(i - 120, i)) * scale);
  const realized20 =
    returns.length >= 120 ? stdev(returns.slice(-120)) * scale : null;
  const realized90 =
    returns.length >= 540 ? stdev(returns.slice(-540)) * scale : null;
  const rank = vols.length
    ? vols.filter((v) => v <= realized20).length / vols.length
    : null;
  const momentum20 =
    closes.length > 120 ? closes.at(-1) / closes.at(-121) - 1 : 0;
  const momentum5 = closes.length > 30 ? closes.at(-1) / closes.at(-31) - 1 : 0;
  const contexts = higher.filter(Number.isFinite);
  const agreement = contexts.length
    ? contexts.filter((v) => Math.sign(v) === Math.sign(momentum20)).length /
      contexts.length
    : 0;
  let regime = "RANGE";
  if (rank !== null && rank >= 0.8) regime = "HIGH_VOL";
  else if (momentum20 > 0.012 && momentum5 > 0 && agreement === 1)
    regime = "UPTREND";
  else if (momentum20 < -0.012 && momentum5 < 0 && agreement === 1)
    regime = "DOWNTREND";
  return {
    regime,
    regime_conf: clamp(
      0.45 +
        0.35 * clamp(Math.abs(momentum20) / 0.04, 0, 1) +
        0.2 * Math.abs((rank ?? 0.5) - 0.5) * 2,
      0,
      1,
    ),
    realized_vol_20d: realized20,
    realized_vol_90d: realized90,
    vol_percentile: rank,
    momentum20,
    momentum5,
    trendAgreement: agreement,
  };
}
function validLabels(outcomes, symbol, setupKey, side, now) {
  const seen = new Set();
  return outcomes.filter((o) => {
    if (
      o?.source !== "REALIZED_CLOSED_TRADE" ||
      o.labeled !== true ||
      String(o.symbol).toUpperCase() !== String(symbol).toUpperCase() ||
      o.setupKey !== setupKey ||
      o.side !== side ||
      typeof o.win !== "boolean" ||
      ![o.maePct, o.mfePct].every(
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ) ||
      !(finite(o.closedAt) > 0 && Number(o.closedAt) <= now) ||
      !(
        finite(o.featureSnapshot?.snapshotAt) > 0 &&
        Number(o.featureSnapshot.snapshotAt) <= Number(o.closedAt)
      )
    )
      return false;
    const key = String(o.tradeId || o._id || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function analyzeNineAI({
  symbol,
  candles4h,
  candles1h = [],
  candles1d = [],
  market = {},
  outcomes = [],
  config = {},
} = {}) {
  const now = finite(market.now, Date.now()),
    cs = closedCandles(candles4h, now);
  const wait = (reason, extra = {}) => ({
    symbol,
    setup: "NINE_AI_4H",
    signalAt: cs.at(-1)?.closeTime,
    action: "WAIT",
    side: null,
    authorizedForExecution: false,
    reason,
    agents: null,
    decisionSchemaVersion: 2,
    ...extra,
  });
  if (!hasContiguousHistory(cs, BAR_MS, 541))
    return wait("INSUFFICIENT_90D_CLOSED_4H_HISTORY");
  const h = closedCandles(candles1h, now),
    d = closedCandles(candles1d, now);
  if (
    !hasContiguousHistory(h, 3600000, 25) ||
    !hasContiguousHistory(d, 86400000, 21)
  )
    return wait("MISSING_MULTITIMEFRAME_CLOSED_CANDLES");
  if (
    now - cs.at(-1).closeTime > BAR_MS ||
    now - h.at(-1).closeTime > 3600000 ||
    now - d.at(-1).closeTime > 86400000
  )
    return wait("STALE_CANDLE_CONTEXT");
  const last = cs.at(-1),
    prev = cs.at(-2),
    before = cs.at(-3),
    closes = cs.map((c) => c.close);
  const regime = classifyRegime(cs, [
    h.at(-1).close / h.at(-25).close - 1,
    d.at(-1).close / d.at(-21).close - 1,
  ]);
  const ranges = cs
    .slice(1)
    .map((c, i) =>
      Math.max(
        c.high - c.low,
        Math.abs(c.high - cs[i].close),
        Math.abs(c.low - cs[i].close),
      ),
    );
  const atr = mean(ranges.slice(-14));
  if (!(atr > 0)) return wait("INVALID_VOLATILITY");
  const structure = swingPoints(cs.slice(-120)),
    sh = structure.highs,
    slows = structure.lows;
  const support =
    slows.at(-1)?.price ?? Math.min(...cs.slice(-30, -1).map((c) => c.low));
  const resistance =
    sh.at(-1)?.price ?? Math.max(...cs.slice(-30, -1).map((c) => c.high));
  const structureBias =
    sh.length > 1 &&
    slows.length > 1 &&
    sh.at(-1).price > sh.at(-2).price &&
    slows.at(-1).price > slows.at(-2).price
      ? "BULLISH"
      : sh.length > 1 &&
          slows.length > 1 &&
          sh.at(-1).price < sh.at(-2).price &&
          slows.at(-1).price < slows.at(-2).price
        ? "BEARISH"
        : "NEUTRAL";
  const project = (points) => {
    const a = points.at(-2),
      b = points.at(-1),
      slope = a && b ? (b.price - a.price) / (b.index - a.index) : 0;
    return { slope, price: b ? b.price + slope * (119 - b.index) : null };
  };
  const funding = finite(market.fundingRate),
    oi = finite(market.openInterestChange),
    liq = finite(market.liquidationImbalance);
  const spread = finite(market.spreadPct),
    depth = finite(market.depthNotional),
    latency = finite(market.latencyMs);
  const fundingHot =
    funding !== null &&
    Math.abs(funding) > finite(config.maxAbsFunding, 0.0008);
  const volume = mean(cs.slice(-21, -1).map((c) => c.volume)),
    volumeRatio = volume > 0 ? last.volume / volume : 0;
  const impulse = Math.abs(last.close - last.open) >= atr * 0.2;
  // Pullback occurs in prior bars; the current closed bar confirms a renewed push.
  const pullbackLong = prev.close < before.close || prev.low < before.low;
  const pullbackShort = prev.close > before.close || prev.high > before.high;
  const continuationSide =
    oi > 0 && !fundingHot && volumeRatio >= 1.05 && impulse
      ? regime.regime === "UPTREND" &&
        pullbackLong &&
        last.close > prev.high &&
        last.close > last.open
        ? "LONG"
        : regime.regime === "DOWNTREND" &&
            pullbackShort &&
            last.close < prev.low &&
            last.close < last.open
          ? "SHORT"
          : null
      : null;
  const rangeHigh = Math.max(...cs.slice(-21, -1).map((c) => c.high)),
    rangeLow = Math.min(...cs.slice(-21, -1).map((c) => c.low));
  const rawBreakout =
    last.close > rangeHigh ? "LONG" : last.close < rangeLow ? "SHORT" : null;
  const held =
    rawBreakout === "LONG"
      ? last.low >= rangeHigh - atr * 0.25
      : rawBreakout === "SHORT"
        ? last.high <= rangeLow + atr * 0.25
        : false;
  const extension = Math.abs(last.close - closes.at(-5)) / atr;
  const breakoutSide =
    held &&
    volumeRatio >= 1.25 &&
    spread !== null &&
    spread >= 0 &&
    spread <= 0.15 &&
    extension < 2.5 &&
    (rawBreakout === "LONG"
      ? regime.regime === "UPTREND"
      : regime.regime === "DOWNTREND")
      ? rawBreakout
      : null;
  const vw = cs.slice(-24),
    totalVolume = vw.reduce((s, c) => s + c.volume, 0);
  const vwap =
    totalVolume > 0
      ? vw.reduce(
          (s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume,
          0,
        ) / totalVolume
      : null;
  const deviation = vwap ? (last.close - vwap) / atr : 0,
    rangeRegime = ["RANGE", "HIGH_VOL"].includes(regime.regime);
  const revertSide =
    rangeRegime && liq !== null && Math.abs(deviation) >= 1.25
      ? deviation > 0 && liq < -0.05
        ? "SHORT"
        : deviation < 0 && liq > 0.05
          ? "LONG"
          : null
      : null;
  const flowSide =
    liq !== null && Math.abs(liq) >= 0.05 && !fundingHot
      ? liq > 0
        ? "LONG"
        : "SHORT"
      : null;
  const flow = {
    fundingRate: funding,
    openInterestChange: oi,
    liquidationImbalance: liq,
    confirmationSide: flowSide,
    confirmation:
      funding === null || oi === null || liq === null
        ? "UNAVAILABLE"
        : fundingHot
          ? "BLOCKED_HOT_FUNDING"
          : flowSide
            ? "CONFIRMED"
            : "NEUTRAL",
  };
  const fee = finite(market.roundTripFeePct);
  const fundingBySide = Object.fromEntries(
    ["LONG", "SHORT"].map((side) => [
      side,
      finite(market.expectedFundingCostPctBySide?.[side]),
    ]),
  );
  const snapshotAt = finite(market.snapshotAt),
    age = snapshotAt === null ? Infinity : now - snapshotAt;
  // Round-trip impact is snapshotted once for live/offline comparability.
  const slip =
    spread !== null &&
    spread >= 0 &&
    depth > 0 &&
    oi !== null &&
    latency !== null &&
    latency >= 0
      ? clamp(
          spread +
            0.04 / Math.max(depth / 100000, 0.1) +
            Math.max(0, latency - 100) * 0.00002 +
            Math.abs(oi) * 0.02,
          0,
          2,
        )
      : null;
  const featureSnapshot = {
    snapshotAt,
    closeTime: last.closeTime,
    close: last.close,
    atr,
    volumeRatio,
    funding,
    oiChange: oi,
    spread,
    depth,
    latency,
    feePct: fee,
    fundingCostPctBySide: fundingBySide,
    estSlippagePct: slip,
    regime,
    structureBias,
    observedAt: now,
    candleCutoffAt: now,
  };
  const policy = { ...DEFAULT_POLICY, ...config };
  const agents = {
    regime,
    structure: {
      structure_bias: structureBias,
      support,
      resistance,
      swingHigh: resistance,
      swingLow: support,
      channel: { upper: project(sh), lower: project(slows) },
      validLongSLBelow: support,
      validShortSLAbove: resistance,
    },
    continuation: {
      side: continuationSide,
      p: null,
      expectedR: null,
      pullbackLong,
      pullbackShort,
      volumeRatio,
    },
    breakout: {
      side: breakoutSide,
      p: null,
      held,
      extensionAtr: extension,
      volumeRatio,
    },
    meanReversion: {
      side: revertSide,
      p: null,
      enabled: rangeRegime,
      vwap,
      deviationAtr: deviation,
    },
    flow,
    outcome: {
      dist_MAE: null,
      dist_MFE: null,
      source: "REALIZED_CLOSED_TRADE",
    },
    fill: {
      est_slippage: slip,
      spreadPct: spread,
      depthNotional: depth,
      latencyMs: latency,
      estimatedFillPriceBySide:
        slip === null
          ? null
          : {
              LONG: last.close * (1 + slip / 200),
              SHORT: last.close * (1 - slip / 200),
            },
    },
  };
  if (
    fee === null ||
    fee < 0 ||
    Object.values(fundingBySide).some((v) => v === null || v < 0) ||
    slip === null ||
    age < 0 ||
    age > MAX_DATA_AGE_MS
  )
    return wait("EXECUTION_COST_INPUTS_STALE_OR_MISSING", {
      regime,
      agents,
      featureSnapshot,
    });
  const baseUncertainty =
    (1 - regime.regime_conf) * policy.uncertaintyPenalty +
    (age / MAX_DATA_AGE_MS) * 0.25;
  const models = [
    {
      name: "continuation",
      type: "CONTINUATION",
      side: continuationSide,
      weight: 0.4,
    },
    { name: "breakout", type: "BREAKOUT", side: breakoutSide, weight: 0.35 },
    {
      name: "meanReversion",
      type: "MEAN_REVERSION",
      side: revertSide,
      weight: 0.25,
    },
  ];
  const edges = {};
  for (const side of ["LONG", "SHORT"]) {
    const totalCostPct = fee + fundingBySide[side] + slip;
    const active = models.filter((m) => m.side === side),
      estimates = [];
    for (const m of active) {
      const setupKey = regime.regime + "_" + m.type;
      const samples = validLabels(outcomes, symbol, setupKey, side, now),
        wins = samples.filter((o) => o.win);
      if (samples.length < 30 || wins.length < 30) continue;
      const distMAE = {
        p80: percentile(
          wins.map((o) => o.maePct),
          0.8,
        ),
        samples: wins.length,
      };
      const distMFE = {
        p50: percentile(
          wins.map((o) => o.mfePct),
          0.5,
        ),
        p90: percentile(
          wins.map((o) => o.mfePct),
          0.9,
        ),
        samples: wins.length,
      };
      if (!(distMAE.p80 > 0 && distMFE.p50 > 0 && distMFE.p90 > distMFE.p50))
        continue;
      const entry = last.close;
      const stop =
        side === "LONG"
          ? Math.min(entry * (1 - distMAE.p80 / 100), support - atr * 0.1)
          : Math.max(entry * (1 + distMAE.p80 / 100), resistance + atr * 0.1);
      const stopPct = (Math.abs(entry - stop) / entry) * 100;
      const plan = {
        entry,
        sl: stop,
        tp1: entry * (1 + ((side === "LONG" ? 1 : -1) * distMFE.p50) / 100),
        tp2: entry * (1 + ((side === "LONG" ? 1 : -1) * distMFE.p90) / 100),
        closePercentAtTP1: 50,
        timeoutCandles: 24,
      };
      if (!(plan.sl > 0 && plan.tp1 > 0 && plan.tp2 > 0)) continue;
      const p = (wins.length + 2) / (samples.length + 4);
      // E[R|success] uses the 50/50 exits. AI-9 keeps the specified p*E[R]-cost formula.
      const quantileRewardR = ((distMFE.p50 + distMFE.p90) * 0.5) / stopPct;
      const track = market.trackRecord?.[setupKey + "_" + side];
      const expectedR =
        track?.winningSamples >= 20 && Number.isFinite(track.meanWinGrossR)
          ? 0.5 * quantileRewardR + 0.5 * track.meanWinGrossR
          : quantileRewardR;
      estimates.push({
        ...m,
        setupKey,
        samples: samples.length,
        p,
        expectedR,
        distMAE,
        distMFE,
        plan,
        cost: totalCostPct / stopPct,
      });
    }
    const chosen = estimates.sort((a, b) => b.weight - a.weight)[0];
    // Missing labels for an active setup stay missing; no fabricated quantiles.
    if (active.length && !chosen)
      edges[side] = {
        eligible: false,
        p: null,
        expectedR: null,
        cost: null,
        baseUncertainty,
        reason: "INSUFFICIENT_LABELED_OUTCOMES",
      };
    else if (!chosen)
      edges[side] = {
        eligible: false,
        p: 0,
        expectedR: 0,
        cost: totalCostPct / ((atr / last.close) * 100),
        baseUncertainty,
        reason: "NO_ACTIVE_SETUP",
        plan: null,
      };
    else {
      edges[side] = {
        ...chosen,
        eligible: structureBias !== (side === "LONG" ? "BEARISH" : "BULLISH"),
        baseUncertainty,
        modelEstimates: estimates.map((e) => ({
          name: e.name,
          p: e.p,
          expectedR: e.expectedR,
          samples: e.samples,
        })),
      };
      for (const e of estimates) {
        agents[e.name].p = e.p;
        agents[e.name].expectedR = e.expectedR;
      }
    }
  }
  const meta = applyPolicy({ regime, agents, edges }, policy);
  const extra = {
    regime,
    agents,
    edges: Object.keys(meta.edges).length === 2 ? meta.edges : edges,
    featureSnapshot,
    decisionPolicy: {
      minEdge: policy.minEdge,
      gapEdge: policy.gapEdge,
      uncertaintyPenalty: policy.uncertaintyPenalty,
    },
    candles: cs.length,
  };
  if (meta.side === "WAIT") return wait(meta.reason, extra);
  const chosen = meta.edges[meta.side],
    plan = chosen.plan;
  agents.outcome = {
    dist_MAE: chosen.distMAE,
    dist_MFE: chosen.distMFE,
    setupKey: chosen.setupKey,
    source: "REALIZED_CLOSED_TRADE",
  };
  return {
    symbol,
    side: meta.side,
    action: meta.side,
    authorizedForExecution: true,
    reason: meta.reason,
    setup: "NINE_AI_4H",
    decisionSchemaVersion: 2,
    signalAt: last.closeTime,
    entry: plan.entry,
    price: plan.entry,
    sl: plan.sl,
    tp1: plan.tp1,
    tp: plan.tp2,
    tp2: plan.tp2,
    closePercentAtTP1: 50,
    timeoutCandles: 24,
    timeframe: "4h",
    setupKey: chosen.setupKey,
    ...extra,
    tradePlan: {
      ...plan,
      stopMethod: "WINNING_MAE_P80_WITH_STRUCTURE_BUFFER",
      targetMethod: "WINNING_MFE_P50_P90",
      timeoutMs: 24 * BAR_MS,
    },
  };
}
module.exports = {
  BAR_MS,
  MAX_DATA_AGE_MS,
  percentile,
  closedCandles,
  swingPoints,
  classifyRegime,
  validLabels,
  analyzeNineAI,
};
