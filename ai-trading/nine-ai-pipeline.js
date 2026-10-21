"use strict";
const {
  DEFAULT_POLICY,
  applyPolicy,
  DECISION_SCHEMA_VERSION,
  selectDirectionCandidate,
  uncertaintyFor,
  fundingIsHot,
} = require("./nine-ai-policy");
const {
  initialStructurePlan,
  initialProbability,
} = require("./initial-structure-plan");
const BAR_MS = 4 * 60 * 60 * 1000;
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
function swingPoints(cs, radius = 1) {
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
function classifyRegime(cs) {
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
  let regime = "RANGE";
  if (rank !== null && rank >= 0.8) regime = "HIGH_VOL";
  else if (momentum20 > 0 && momentum5 > 0) regime = "UPTREND";
  else if (momentum20 < 0 && momentum5 < 0) regime = "DOWNTREND";
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
  };
}
function validLabels(outcomes, symbol, setupKey, side, now) {
  const seen = new Set();
  return outcomes.filter((o) => {
    if (
      o?.source !== "REALIZED_CLOSED_TRADE" ||
      o.labeled !== true ||
      o.setupKey !== setupKey ||
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
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    ...extra,
  });
  if (!hasContiguousHistory(cs, BAR_MS, 541))
    return wait("INSUFFICIENT_90D_CLOSED_4H_HISTORY");
  const last = cs.at(-1),
    prev = cs.at(-2),
    before = cs.at(-3),
    closes = cs.map((c) => c.close);
  const regime = classifyRegime(cs);
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
  const fundingHot = fundingIsHot(funding);
  const volume = mean(cs.slice(-21, -1).map((c) => c.volume)),
    volumeRatio = volume > 0 ? last.volume / volume : 0;
  // Pullback occurs in prior bars; the current closed bar confirms a renewed push.
  const pullbackLong = prev.close < before.close || prev.low < before.low;
  const pullbackShort = prev.close > before.close || prev.high > before.high;
  const continuationSide = !fundingHot
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
  const rangeBars = cs.slice(-22, -2);
  const rangeHigh = Math.max(...rangeBars.map((c) => c.high)),
    rangeLow = Math.min(...rangeBars.map((c) => c.low));
  const rangeVolume = mean(rangeBars.map((c) => c.volume));
  const breakoutVolumeRatio = rangeVolume > 0 ? prev.volume / rangeVolume : 0;
  const rawBreakout =
    prev.close > rangeHigh ? "LONG" : prev.close < rangeLow ? "SHORT" : null;
  const held =
    rawBreakout === "LONG"
      ? last.low >= rangeHigh
      : rawBreakout === "SHORT"
        ? last.high <= rangeLow
        : false;
  // A closed bar confirms the prior volume breakout. Do not chase a price that
  // has already traversed a complete measured range beyond the broken level.
  const rangeWidth = rangeHigh - rangeLow;
  const extension =
    rangeWidth > 0
      ? Math.abs(last.close - (rawBreakout === "LONG" ? rangeHigh : rangeLow)) /
        rangeWidth
      : Infinity;
  const breakoutSide =
    held &&
    breakoutVolumeRatio > 1 &&
    spread !== null &&
    spread >= 0 &&
    extension < 1
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
    rangeRegime && liq !== null
      ? deviation > 0 && liq < 0
        ? "SHORT"
        : deviation < 0 && liq > 0
          ? "LONG"
          : null
      : null;
  const flowSide =
    liq !== null && liq !== 0 && !fundingHot
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
    trackRecord: market.trackRecord || {},
    candleCutoffAt: now,
    closedOIAt: finite(market.oiObservedAt),
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
      extensionRangeWidths: extension,
      volumeRatio: breakoutVolumeRatio,
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
      enabled: false,
      source: null,
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
    funding === null ||
    fee === null ||
    fee < 0 ||
    Object.values(fundingBySide).some((v) => v === null || v < 0) ||
    slip === null ||
    age < 0
  )
    return wait("EXECUTION_COST_INPUTS_STALE_OR_MISSING", {
      regime,
      agents,
      featureSnapshot,
    });
  const baseUncertainty = uncertaintyFor(
    regime,
    snapshotAt,
    last.closeTime,
    now,
    policy,
    featureSnapshot,
  );
  const models = [
    {
      name: "continuation",
      type: "CONTINUATION",
      side: continuationSide,
    },
    { name: "breakout", type: "BREAKOUT", side: breakoutSide },
    {
      name: "meanReversion",
      type: "MEAN_REVERSION",
      side: revertSide,
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
      let distMAE = wins.length
        ? {
            p80: percentile(
              wins.map((o) => o.maePct),
              0.8,
            ),
            samples: wins.length,
          }
        : null;
      let distMFE = wins.length
        ? {
            p50: percentile(
              wins.map((o) => o.mfePct),
              0.5,
            ),
            p90: percentile(
              wins.map((o) => o.mfePct),
              0.9,
            ),
            samples: wins.length,
          }
        : null;
      // One valid winning label is enough to start AI-7; p50 may equal p90.
      const ai7Ready = wins.length > 0;
      const entry = last.close;
      const stop = ai7Ready
        ? entry * (1 + ((side === "LONG" ? -1 : 1) * distMAE.p80) / 100)
        : null;
      const plan = ai7Ready
        ? {
            entry,
            sl: stop,
            tp1: entry * (1 + ((side === "LONG" ? 1 : -1) * distMFE.p50) / 100),
            tp2: entry * (1 + ((side === "LONG" ? 1 : -1) * distMFE.p90) / 100),
            closePercentAtTP1: 50,
            timeoutCandles: 24,
            stopMethod: "WINNING_MAE_P80",
            targetMethod: "WINNING_MFE_P50_P90",
            maePct: distMAE.p80,
            mfe50Pct: distMFE.p50,
            mfe90Pct: distMFE.p90,
          }
        : initialStructurePlan({
            side,
            entry,
            atr,
            highs: sh,
            lows: slows,
            support,
            resistance,
            channel: agents.structure.channel,
            rangeHigh,
            rangeLow,
          });
      if (!plan || !(plan.sl > 0 && plan.tp1 > 0 && plan.tp2 > 0)) continue;
      if (
        side === "LONG"
          ? !(plan.sl < entry && entry < plan.tp1 && plan.tp1 <= plan.tp2)
          : !(plan.tp2 <= plan.tp1 && plan.tp1 < entry && entry < plan.sl)
      )
        continue;
      if (!ai7Ready) {
        distMAE = null;
        distMFE = null;
      }
      const stopPct = (Math.abs(entry - plan.sl) / entry) * 100;
      const directionalSamples = samples.filter((o) => o.side === side);
      const track = market.trackRecord?.[setupKey + "_" + side] || null;
      const probabilitySamples =
        directionalSamples.length ||
        (Number.isFinite(track?.samples) && track.samples > 0
          ? track.samples
          : 0);
      const probabilityWins = directionalSamples.length
        ? directionalSamples.filter((o) => o.win).length
        : probabilitySamples
          ? track.winningSamples
          : 0;
      const modelP = initialProbability(
        m.type,
        regime.momentum20,
        m.type === "BREAKOUT" ? breakoutVolumeRatio : volumeRatio,
        {
          fundingRate: funding,
          openInterestChange: oi,
          spreadPct: spread,
          deviationAtr: deviation,
          liquidationImbalance: liq,
        },
      );
      // Update the feature model with real outcomes, without a minimum-count gate
      // or forcing the probability to zero/one after a single observed trade.
      const p = (probabilityWins + modelP) / (probabilitySamples + 1);
      // E[R|success] uses the 50/50 exits. AI-9 keeps the specified p*E[R]-cost formula.
      const quantileRewardR =
        ((Math.abs(plan.tp1 - entry) + Math.abs(plan.tp2 - entry)) * 0.5) /
        Math.abs(entry - plan.sl);
      const expectedR = quantileRewardR;
      estimates.push({
        ...m,
        setupKey,
        samples: samples.length,
        probabilitySamples,
        trackRecord: track,
        winningSamples: wins.length,
        outcomeMode: ai7Ready ? "AI7_LABELED" : "AI2_INITIAL",
        probabilitySource: probabilitySamples
          ? "FEATURE_MODEL_UPDATED_WITH_REALIZED_SETUP_OUTCOMES"
          : "FEATURE_SCORE_UNCALIBRATED",
        outcomeSource: ai7Ready
          ? "REALIZED_CLOSED_TRADE"
          : "AI2_STRUCTURE_INITIAL_PLAN",
        p,
        expectedR,
        distMAE,
        distMFE,
        plan,
        cost: totalCostPct / stopPct,
      });
    }
    const chosen = selectDirectionCandidate(estimates, baseUncertainty);
    // A missing/invalid initial structure plan cannot be replaced with invented quantiles.
    if (active.length && !chosen)
      edges[side] = {
        eligible: false,
        p: null,
        expectedR: null,
        cost: null,
        baseUncertainty,
        reason: "NO_VALID_STRUCTURE_OR_LABELED_EXIT_PLAN",
      };
    else if (!chosen)
      edges[side] = {
        eligible: false,
        p: 0,
        expectedR: 0,
        cost: 0,
        baseUncertainty,
        reason: "NO_ACTIVE_SETUP",
        plan: null,
      };
    else {
      edges[side] = {
        ...chosen,
        eligible: true,
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
    enabled: chosen.outcomeMode === "AI7_LABELED",
    mode: chosen.outcomeMode,
    samples: chosen.samples,
    winningSamples: chosen.winningSamples,
    source: chosen.outcomeSource,
  };
  featureSnapshot.outcomeMode = chosen.outcomeMode;
  return {
    symbol,
    side: meta.side,
    action: meta.side,
    authorizedForExecution: true,
    reason: meta.reason,
    setup: "NINE_AI_4H",
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
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
      outcomeMode: chosen.outcomeMode,
      timeoutMs: 24 * BAR_MS,
    },
  };
}
module.exports = {
  BAR_MS,
  percentile,
  closedCandles,
  swingPoints,
  classifyRegime,
  validLabels,
  analyzeNineAI,
};
