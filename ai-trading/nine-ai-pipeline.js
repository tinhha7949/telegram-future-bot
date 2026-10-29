"use strict";
const { CONFIG } = require("./config");
const { weightedPercentile, phaseForLabelCount, countRealizedLabels, calibrationPenaltyForState } = require("./online-learning");
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
const BAR_MS = CONFIG.BAR_HOURS * 60 * 60 * 1000;
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
  const closed = input
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
    .sort((a, b) => a.time - b.time);
  // Duplicate valid bars indicate a corrupt feed response; never silently
  // pick one version and risk deriving a point-in-time feature from it.
  if (closed.some((c, i, all) => i > 0 && c.time === all[i - 1].time)) return [];
  return closed;
}
function hasContiguousHistory(cs, interval, minimum) {
  if (cs.length < minimum) return false;
  return cs
    .slice(-minimum)
    .every((c, i, all) => !i || c.time - all[i - 1].time === interval);
}
function swingPoints(cs, radius = CONFIG.STRUCTURE_SWING_RADIUS) {
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
  const scale = Math.sqrt((24 / CONFIG.BAR_HOURS) * CONFIG.VOL_ANNUALIZATION_DAYS) * 100,
    vols = [];
  for (let i = CONFIG.VOL_20D_RETURNS; i <= returns.length; i++)
    vols.push(stdev(returns.slice(i - CONFIG.VOL_20D_RETURNS, i)) * scale);
  const realized20 =
    returns.length >= CONFIG.VOL_20D_RETURNS ? stdev(returns.slice(-CONFIG.VOL_20D_RETURNS)) * scale : null;
  const realizedLong =
    returns.length >= CONFIG.VOL_LONG_RETURNS ? stdev(returns.slice(-CONFIG.VOL_LONG_RETURNS)) * scale : null;
  const rank = vols.length
    ? vols.filter((v) => v <= realized20).length / vols.length
    : null;
  const momentum20 =
    closes.length > CONFIG.VOL_20D_RETURNS ? closes.at(-1) / closes.at(-(CONFIG.VOL_20D_RETURNS + 1)) - 1 : 0;
  const momentum5 = closes.length > CONFIG.MOMENTUM_SHORT_RETURNS ? closes.at(-1) / closes.at(-(CONFIG.MOMENTUM_SHORT_RETURNS + 1)) - 1 : 0;
  let regime = "RANGE";
  if (rank !== null && rank >= CONFIG.HIGH_VOL_PERCENTILE) regime = "HIGH_VOL";
  else if (momentum20 > 0 && momentum5 > 0) regime = "UPTREND";
  else if (momentum20 < 0 && momentum5 < 0) regime = "DOWNTREND";
  return {
    regime,
    regime_conf: clamp(
      CONFIG.REGIME_CONF_BASE +
        CONFIG.REGIME_CONF_MOMENTUM_WEIGHT * clamp(Math.abs(momentum20) / CONFIG.REGIME_CONF_MOMENTUM_SCALE, 0, 1) +
        CONFIG.REGIME_CONF_VOL_WEIGHT * Math.abs((rank ?? CONFIG.REGIME_CONF_VOL_MIDPOINT) - CONFIG.REGIME_CONF_VOL_MIDPOINT) / CONFIG.REGIME_CONF_VOL_MIDPOINT,
      0,
      1,
    ),
    realized_vol_20d: realized20,
    realized_vol_long_window: realizedLong,
    realized_vol_90d: null,
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
      o.accountingSchemaVersion !== 2 ||
      o.setupKey !== setupKey ||
      // Never mix adverse/favorable excursion distributions across direction.
      // Cross-symbol pooling is permitted only for the identical regime/setup/side.
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
  market = {},
  outcomes = [],
  config = {},
} = {}) {
  const now = finite(market.now, Date.now()),
    cs = closedCandles(candles4h, now).slice(-CONFIG.N_CANDLES),
    phase = phaseForLabelCount(countRealizedLabels(outcomes, now));
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
  if (!hasContiguousHistory(cs, BAR_MS, CONFIG.N_CANDLES))
    return wait("INSUFFICIENT_CONFIGURED_CLOSED_4H_HISTORY");
  if (now - cs.at(-1).closeTime > BAR_MS) return wait("STALE_CLOSED_CANDLE");
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
  const atr = mean(ranges.slice(-CONFIG.ATR_BARS));
  if (!(atr > 0)) return wait("INVALID_VOLATILITY");
  const structure = swingPoints(cs.slice(-CONFIG.STRUCTURE_LOOKBACK_BARS)),
    sh = structure.highs,
    slows = structure.lows;
  const support =
    slows.at(-1)?.price ?? Math.min(...cs.slice(-CONFIG.STRUCTURE_FALLBACK_BARS, -1).map((c) => c.low));
  const resistance =
    sh.at(-1)?.price ?? Math.max(...cs.slice(-CONFIG.STRUCTURE_FALLBACK_BARS, -1).map((c) => c.high));
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
    return { slope, price: b ? b.price + slope * (CONFIG.STRUCTURE_LOOKBACK_BARS - 1 - b.index) : null };
  };
  const funding = finite(market.fundingRate),
    oi = finite(market.openInterestChange),
    liq = finite(market.liquidationImbalance);
  const spread = finite(market.spreadPct),
    depth = finite(market.depthNotional),
    latency = finite(market.latencyMs);
  const fundingHot = fundingIsHot(funding);
  const volume = mean(cs.slice(-(CONFIG.VOLUME_LOOKBACK_BARS + 1), -1).map((c) => c.volume)),
    volumeRatio = volume > 0 ? last.volume / volume : 0;
  // Pullback occurs in prior bars; the current closed bar confirms a renewed push.
  const pullbackLong = prev.close < before.close || prev.low < before.low;
  const pullbackShort = prev.close > before.close || prev.high > before.high;
  const continuationSide = !fundingHot
    ? regime.regime === "UPTREND" &&
      (phase !== "EARLY" || structureBias === "BULLISH") &&
      pullbackLong &&
      last.close > prev.high &&
      last.close > last.open
      ? "LONG"
      : regime.regime === "DOWNTREND" &&
          (phase !== "EARLY" || structureBias === "BEARISH") &&
          pullbackShort &&
          last.close < prev.low &&
          last.close < last.open
        ? "SHORT"
        : null
    : null;
  const rangeBars = cs.slice(-(CONFIG.BREAKOUT_RANGE_BARS + 2), -2);
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
    breakoutVolumeRatio > CONFIG.BREAKOUT_MIN_VOLUME_RATIO &&
    spread !== null &&
    spread >= 0 &&
    extension < CONFIG.BREAKOUT_MAX_EXTENSION_RANGES
      ? rawBreakout
      : null;
  const vw = cs.slice(-CONFIG.VWAP_LOOKBACK_BARS),
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
            CONFIG.FILL_BASE_IMPACT_PCT / Math.max(depth / CONFIG.FILL_DEPTH_REFERENCE_USDT, CONFIG.FILL_DEPTH_FLOOR) +
            Math.max(0, latency - CONFIG.FILL_LATENCY_BASE_MS) * CONFIG.FILL_LATENCY_IMPACT_PCT_PER_MS +
            Math.abs(oi) * CONFIG.FILL_OI_IMPACT_COEFF,
          0,
          CONFIG.FILL_MAX_SLIPPAGE_PCT,
        )
      : CONFIG.SLIPPAGE_BPS / 100;
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
  const policy = { ...DEFAULT_POLICY, ...config, earlyPhase: phase === "EARLY", minEdge: Math.max(CONFIG.MIN_EDGE, Number(config.minEdge) || 0), gapEdge: CONFIG.EDGE_GAP };
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
  const costInputFailure =
    snapshotAt === null
      ? "MISSING_MARKET_SNAPSHOT_AT"
      : age < 0
        ? "FUTURE_MARKET_SNAPSHOT"
        : funding === null
          ? "MISSING_FUNDING_RATE"
          : oi === null
            ? "MISSING_OPEN_INTEREST_CHANGE"
            : fee === null
              ? "MISSING_ROUND_TRIP_FEE"
              : fee < 0
                ? "INVALID_ROUND_TRIP_FEE"
                : fundingBySide.LONG === null
                  ? "MISSING_LONG_FUNDING_COST"
                  : fundingBySide.SHORT === null
                    ? "MISSING_SHORT_FUNDING_COST"
                    : slip === null
                      ? "MISSING_SLIPPAGE"
                      : null;
  if (costInputFailure)
    return wait("EXECUTION_COST_INPUTS_" + costInputFailure, {
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
  const allModels = [
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
  // With fewer than 30 valid labels, only the confirmed structure-aligned
  // trend-pullback rule may authorize a trade. Other specialist probabilities
  // remain neutral priors, but their setups cannot open a cold-start position.
  const models = phase === "EARLY"
    ? allModels.filter((m) => m.type === "CONTINUATION")
    : allModels;
  if (phase === "EARLY") {
    agents.breakout.p = 0.5;
    agents.meanReversion.p = 0.5;
    agents.continuation.p = 0.5;
  }
  const edges = {};
  for (const side of ["LONG", "SHORT"]) {
    const totalCostPct = fee + fundingBySide[side] + slip;
    const active = models.filter((m) => m.side === side),
      estimates = [];
    for (const m of active) {
      const setupKey = regime.regime + "_" + m.type;
      const samples = validLabels(outcomes, symbol, setupKey, side, now),
        wins = samples.filter((o) => o.win);
      let distMAE = samples.length
        ? {
            p80: weightedPercentile(samples.map((o) => o.maePct), CONFIG.MAE_PERCENTILE),
            samples: samples.length,
          }
        : null;
      let distMFE = samples.length
        ? {
            p50: weightedPercentile(samples.map((o) => o.mfePct), CONFIG.MFE_TP1_PERCENTILE),
            p90: weightedPercentile(samples.map((o) => o.mfePct), CONFIG.MFE_TP2_PERCENTILE),
            samples: samples.length,
          }
        : null;
      // No quantile SL/TP until sufficient direction-matched realized outcomes.
      const ai7Ready = samples.length >= CONFIG.MIN_LABELS_FOR_ATR7;
      const entry = last.close;
      const stop = ai7Ready
        ? entry * (1 + ((side === "LONG" ? -1 : 1) * distMAE.p80) / 100)
        : null;
      const plan = ai7Ready
        ? {
            entry,
            sl: stop,
            tp1: entry * (1 + ((side === "LONG" ? 1 : -1) * Math.max(distMFE.p50, CONFIG.MIN_RR * distMAE.p80)) / 100),
            tp2: entry * (1 + ((side === "LONG" ? 1 : -1) * Math.max(distMFE.p90, distMFE.p50, CONFIG.MIN_RR * distMAE.p80)) / 100),
            closePercentAtTP1: (CONFIG.TP_BATCHES[0] / (CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1])) * 100,
            timeoutCandles: CONFIG.TIMEOUT_BARS,
            stopMethod: "LABELED_MAE_P80",
            targetMethod: "LABELED_MFE_P50_P90",
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
      const modelP = phase === "EARLY" ? 0.5 : initialProbability(
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
      const moduleUncertaintyPenalty = calibrationPenaltyForState(
        market.calibrationBySetup?.[setupKey],
      );
      const setupUncertainty = baseUncertainty + moduleUncertaintyPenalty;
      // Update the feature model with real outcomes, without a minimum-count gate
      // or forcing the probability to zero/one after a single observed trade.
      const p = phase === "EARLY" ? 0.5 : (probabilityWins + modelP) / (probabilitySamples + 1);
      // Before realized returns exist, AI-2/7 exit geometry supplies the initial
      // payoff estimate. Observed gross R then supplies E[R|a,regime,setup];
      // AI-9 subtracts execution cost once, in the same R unit.
      const quantileRewardR =
        ((Math.abs(plan.tp1 - entry) * CONFIG.TP_BATCHES[0] +
           Math.abs(plan.tp2 - entry) * CONFIG.TP_BATCHES[1]) /
         (CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1])) /
        Math.abs(entry - plan.sl);
      const realizedReturns = directionalSamples
        .filter(
          (o) => typeof o.grossR === "number" && Number.isFinite(o.grossR),
        )
        .map((o) => o.grossR);
      const trackedExpectedR =
        track?.samples > 0 &&
        typeof track.meanGrossR === "number" &&
        Number.isFinite(track.meanGrossR)
          ? track.meanGrossR
          : null;
      const expectedR =
        trackedExpectedR ?? mean(realizedReturns) ?? quantileRewardR;
      estimates.push({
        ...m,
        setupKey,
        baseUncertainty: setupUncertainty,
        moduleUncertaintyPenalty,
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
          : "ATR_COLD_START_EXIT_PLAN",
        p,
        expectedR,
        expectedRSource:
          realizedReturns.length || trackedExpectedR !== null
            ? "REALIZED_GROSS_R_BY_DIRECTION_REGIME_SETUP"
            : "INITIAL_EXIT_GEOMETRY_UNCALIBRATED",
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
        baseUncertainty: chosen.baseUncertainty,
        moduleUncertaintyPenalty: chosen.moduleUncertaintyPenalty,
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
      earlyPhase: phase === "EARLY",
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
    closePercentAtTP1: (CONFIG.TP_BATCHES[0] / (CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1])) * 100,
    timeoutCandles: CONFIG.TIMEOUT_BARS,
    timeframe: CONFIG.TIMEFRAME,
    setupKey: chosen.setupKey,
    ...extra,
    tradePlan: {
      ...plan,
      outcomeMode: chosen.outcomeMode,
      timeoutMs: CONFIG.TIMEOUT_BARS * BAR_MS,
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
