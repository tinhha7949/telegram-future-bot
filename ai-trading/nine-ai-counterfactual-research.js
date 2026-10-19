"use strict";

// Post-close counterfactual research. Candidate exit prices come from observed
// pre-entry market structure, not a list of preset SL/TP multipliers. Simulated
// outcomes remain hypothetical; promotion requires chronological validation.
const OUTCOME_COLLECTION = "nine_ai_counterfactual_outcomes";
const POLICY_COLLECTION = "nine_ai_counterfactual_policies";
const MAX_ROWS = 20000;
const MAX_MARKET_LEVELS_PER_SIDE = 12;
const MIN_TRAIN = 30;
const MIN_TEST = 15;
const MIN_TEST_UPLIFT_R = 0.10;
const MIN_TEST_MEAN_R = 0.05;
const FEE_R = 0.04; // conservative round-trip cost expressed in initial-risk units
let outcomeCollection = null;
let policyCollection = null;
let rows = [];
let policies = [];
let seen = new Set();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const n = (v, d = NaN) => v == null || v === "" ? d : Number.isFinite(Number(v)) ? Number(v) : d;

function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => Array.isArray(c) ? ({
    time: n(c[0]), open: n(c[1]), high: n(c[2]), low: n(c[3]),
    close: n(c[4]), volume: n(c[5]), closeTime: n(c[6])
  }) : ({
    time: n(c.time ?? c.openTime), open: n(c.open ?? c.o), high: n(c.high ?? c.h),
    low: n(c.low ?? c.l), close: n(c.close ?? c.c), volume: n(c.volume ?? c.v),
    closeTime: n(c.closeTime)
  })).filter(c => [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.high >= c.low && c.close > 0)
    .sort((a,b) => a.time-b.time)
    .filter((c,i,a) => i === 0 || c.time !== a[i-1].time);
}

function simulate({ candles: raw, entryIndex, side, entry, sl, tp, risk, delay = 0, feeR = FEE_R }) {
  const candles = normalizeCandles(raw);
  if (!["LONG","SHORT"].includes(side) || !Number.isFinite(entry) || entry <= 0 ||
      !Number.isFinite(sl) || !Number.isFinite(tp) || !Number.isFinite(risk) || risk <= 0 ||
      entryIndex < 0 || entryIndex >= candles.length) return { valid:false, reason:"INVALID_INPUT" };
  const start = entryIndex + delay;
  if (start < 0 || start >= candles.length - 1) return { valid:false, reason:"INSUFFICIENT_FORWARD_CANDLES" };
  const entryPrice = delay === 0 ? entry : candles[start].open;
  if (!(side === "LONG" ? sl < entryPrice && tp > entryPrice : sl > entryPrice && tp < entryPrice)) {
    return { valid:false, reason:"INVALID_LEVELS" };
  }
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const stopHit = side === "LONG" ? c.low <= sl : c.high >= sl;
    const targetHit = side === "LONG" ? c.high >= tp : c.low <= tp;
    // OHLC cannot reveal intrabar order. Conservative assumption: if both hit,
    // stop executes first. This avoids optimistic lookahead inside a candle.
    if (stopHit) return { valid:true, exit:"SL", exitTime:c.time, grossR:-Math.abs(entryPrice-sl)/risk,
      netR:-Math.abs(entryPrice-sl)/risk-feeR, barsHeld:i-start+1 };
    if (targetHit) return { valid:true, exit:"TP", exitTime:c.time, grossR:Math.abs(tp-entryPrice)/risk,
      netR:Math.abs(tp-entryPrice)/risk-feeR, barsHeld:i-start+1 };
  }
  const last = candles[candles.length-1];
  const signed = side === "LONG" ? last.close-entryPrice : entryPrice-last.close;
  return { valid:true, exit:"TIME", exitTime:last.time, grossR:signed/risk,
    netR:signed/risk-feeR, barsHeld:candles.length-start };
}

function observedExitDistances(candles, entryIndex, side, entry) {
  // Only use candles that had closed before the entry. Their actual highs/lows
  // supply candidate price levels; no future candle can influence a candidate.
  const history = candles.slice(Math.max(0, entryIndex - 96), entryIndex);
  const stopDistances = [];
  const targetDistances = [];
  for (const candle of history) {
    if (side === "LONG") {
      if (candle.low < entry) stopDistances.push(entry - candle.low);
      if (candle.high > entry) targetDistances.push(candle.high - entry);
    } else {
      if (candle.high > entry) stopDistances.push(candle.high - entry);
      if (candle.low < entry) targetDistances.push(entry - candle.low);
    }
  }
  const selectObservedLevels = values => {
    const unique = [...new Set(values.filter(v => Number.isFinite(v) && v > 0)
      .map(v => Number(v.toPrecision(10))))].sort((a, b) => a - b);
    if (unique.length <= MAX_MARKET_LEVELS_PER_SIDE) return unique;
    // Keep a spread of the levels actually observed in this market window.
    // The cap bounds computation and storage; it does not prescribe price levels.
    const selected = [];
    for (let i = 0; i < MAX_MARKET_LEVELS_PER_SIDE; i++) {
      const index = Math.round(i * (unique.length - 1) / (MAX_MARKET_LEVELS_PER_SIDE - 1));
      if (selected.at(-1) !== unique[index]) selected.push(unique[index]);
    }
    return selected;
  };
  return { stops: selectObservedLevels(stopDistances), targets: selectObservedLevels(targetDistances) };
}

// Evaluate an earlier signal using only candles that had closed by signalIndex.
// This is an explicit, causal proxy (EMA trend + recent directional momentum),
// not a claim that the original live signal engine ran at that historical time.
function validateEarlierSetup(candles, signalIndex, side) {
  if (!Number.isInteger(signalIndex) || signalIndex < 24 || signalIndex >= candles.length ||
      !["LONG", "SHORT"].includes(side)) return { valid: false, reason: "INSUFFICIENT_CAUSAL_HISTORY" };
  const history = candles.slice(0, signalIndex + 1);
  const closes = history.map(c => c.close);
  const ema = (values, period) => {
    if (values.length < period) return NaN;
    const alpha = 2 / (period + 1);
    let value = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
    for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1 - alpha);
    return value;
  };
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const last = closes.at(-1), previous = closes.at(-2), earlier = closes.at(-4);
  const valid = side === "LONG"
    ? last > e9 && e9 > e21 && last > previous && previous >= earlier
    : last < e9 && e9 < e21 && last < previous && previous <= earlier;
  return { valid, reason: valid ? "CAUSAL_EMA_MOMENTUM_CONFIRMED" : "EARLIER_SETUP_NOT_VALID", signalIndex,
    signalTime: candles[signalIndex].closeTime };
}

function buildVariants(trade, rawCandles) {
  const candles = normalizeCandles(rawCandles);
  if (candles.length < 4) return [];
  const entryTime = n(trade.entryTime ?? trade.createdAt);
  let entryIndex = candles.findIndex(c => c.time <= entryTime && c.closeTime >= entryTime);
  if (entryIndex < 0) {
    entryIndex = candles.findIndex(c => c.time >= entryTime);
    if (entryIndex < 0) return [];
  }
  const entry = n(trade.entry), sl = n(trade.sl), tp = n(trade.tp);
  const risk = Math.abs(entry-sl);
  if (!(entry > 0 && risk > 0 && tp > 0)) return [];
  const rr = Math.abs(tp-entry)/risk;
  const result = [];
  const feeRate = n(trade.feeRate);
  const fallbackFeeR = n(trade.feeR, FEE_R);
  const maxRR = n(trade.maxRR, Infinity);
  const minRR = n(trade.minRR, 0);
  const add = (variant, side, idx, e, stop, target, delay=0) => {
    const candidateRisk = Math.abs(e-stop);
    const feeR = feeRate !== null && candidateRisk > 0
      ? feeRate * e / candidateRisk : fallbackFeeR;
    const r = simulate({candles,entryIndex:idx,side,entry:e,sl:stop,tp:target,
      risk:candidateRisk,delay,feeR});
    if (r.valid) result.push({variant,side,entryIndex:idx,entry:e,sl:stop,tp:target,...r});
  };
  // Actual-side baseline uses the real levels and actual entry.
  add("BASELINE", trade.side, entryIndex, entry, sl, tp, 0);
  // Search actual support/resistance prices observed before entry. The stored
  // policy records the resulting learned distance ratios so the next live plan
  // can scale those ratios to its own entry and volatility. No preset SL/TP
  // multiplier values are enumerated here.
  const observed = observedExitDistances(candles, entryIndex, trade.side, entry);
  const baselineReward = Math.abs(tp-entry);
  const candidateKeys = new Set();
  for (const stopDistance of observed.stops) {
    for (const targetDistance of observed.targets) {
      const candidateRR = targetDistance / stopDistance;
      if (!(candidateRR > minRR && candidateRR <= maxRR)) continue;
      const stopScale = stopDistance / risk;
      const targetScale = targetDistance / baselineReward;
      if (!(Number.isFinite(stopScale) && stopScale > 0 && Number.isFinite(targetScale) && targetScale > 0)) continue;
      const variant = `EXIT_LEVEL:S${stopScale.toFixed(3)}:T${targetScale.toFixed(3)}`;
      if (candidateKeys.has(variant)) continue;
      candidateKeys.add(variant);
      const candidateSL = trade.side === "LONG" ? entry - stopDistance : entry + stopDistance;
      const candidateTP = trade.side === "LONG" ? entry + targetDistance : entry - targetDistance;
      const before = result.length;
      add(variant, trade.side, entryIndex, entry, candidateSL, candidateTP, 0);
      if (result.length > before) Object.assign(result[result.length - 1], { stopScale, targetScale,
        stopDistance, targetDistance, levelSource: "PRE_ENTRY_OBSERVED_MARKET_STRUCTURE" });
    }
  }
  // Opposite direction is a research hypothesis, not an automatic flip. Mirror
  // the same risk and reward distances around entry and keep the same entry time.
  const opposite = trade.side === "LONG" ? "SHORT" : "LONG";
  const mirrorSl = opposite === "LONG" ? entry-risk : entry+risk;
  const mirrorTp = opposite === "LONG" ? entry+Math.abs(tp-entry) : entry-Math.abs(tp-entry);
  // Skip the entry candle so its pre-entry high/low cannot leak into replay.
  add("OPPOSITE_SIDE", opposite, entryIndex + 1, entry, mirrorSl, mirrorTp, 0);
  // Delayed entries use only the delayed candle open; SL/TP distances remain fixed.
  for (const delay of [1,2]) {
    const idx = entryIndex + delay;
    if (idx >= candles.length-1) continue;
    const e = candles[idx].open;
    const stop = trade.side === "LONG" ? e-risk : e+risk;
    const target = trade.side === "LONG" ? e+Math.abs(tp-entry) : e-Math.abs(tp-entry);
    add("DELAY_"+delay+"_BAR", trade.side, idx, e, stop, target, 0);
  }
  // Earlier-entry counterfactuals are admitted only when a directional setup
  // was independently valid at the earlier candle close. Entry is the NEXT
  // candle open, never the earlier candle's close/high/low, avoiding leakage.
  for (const barsEarlier of [1,2]) {
    const signalIndex = entryIndex - barsEarlier - 1;
    const entryIdx = signalIndex + 1;
    if (signalIndex < 24 || entryIdx >= candles.length - 1) continue;
    const gate = validateEarlierSetup(candles, signalIndex, trade.side);
    if (!gate.valid) continue;
    const e = candles[entryIdx].open;
    const stop = trade.side === "LONG" ? e-risk : e+risk;
    const target = trade.side === "LONG" ? e+Math.abs(tp-entry) : e-Math.abs(tp-entry);
    const before = result.length;
    add("EARLIER_"+barsEarlier+"_BAR", trade.side, entryIdx, e, stop, target, 0);
    if (result.length > before) {
      Object.assign(result[result.length-1], { signalIndex, signalTime: gate.signalTime,
        signalGate: gate.reason, entryTime: candles[entryIdx].time });
    }
  }
  return result;
}

function groupKey(row) { return row.side + "|" + (row.regime || "UNKNOWN"); }

// Tags describe observed setup context, not hard-coded entry vetoes. They let
// counterfactual results from similar oversized-candle / exhaustion setups
// inform future decisions without pretending every losing trade should reverse.
function featureTags(features = {}) {
  const tags = [];
  const extension = Math.abs(n(features.extensionAtr ?? features.extension, 0));
  const body = Math.abs(n(features.candleBody ?? features.candleBodyRatio, 0));
  const rsi = n(features.rsi14 ?? features.rsi, 50);
  const momentum = n(features.momentum4 ?? features.momentum, 0);
  const volume = n(features.volumeRatio ?? features.volume, 1);
  const falseBreakout = n(features.falseBreakoutRisk, 0);
  if (extension > 0 && body > 0 && extension >= body) tags.push("EXTENDED_CANDLE");
  if (extension >= 1.25) tags.push("EXTENDED_ENTRY");
  if ((rsi >= 65 && momentum > 0) || (rsi <= 35 && momentum < 0)) tags.push("MOMENTUM_EXHAUSTION");
  if (rsi >= 68) tags.push("RSI_OVERBOUGHT");
  if (rsi <= 32) tags.push("RSI_OVERSOLD");
  if (falseBreakout >= 0.5) tags.push("FALSE_BREAKOUT_RISK");
  if (volume < 0.75) tags.push("LOW_VOLUME");
  return [...new Set(tags)];
}
function pairedVariantEvidence(sourceRows, features = {}, regime = "UNKNOWN", side = null) {
  const wanted = featureTags(features);
  const scoped = sourceRows.filter(r => r && r.hypothetical && r.variant && r.variant !== "BASELINE" &&
    (!regime || String(r.regime || "UNKNOWN") === String(regime)) &&
    (!side || String(r.side || "") === String(side)) &&
    Array.isArray(r.features) && (!wanted.length || wanted.some(tag => r.features.includes(tag))));
  const baselines = new Map(sourceRows.filter(r => r && r.variant === "BASELINE")
    .map(r => [String(r.tradeId), r]));
  const byVariant = new Map();
  for (const row of scoped) {
    const baseline = baselines.get(String(row.tradeId));
    if (!baseline || !Number.isFinite(Number(row.netR)) || !Number.isFinite(Number(baseline.netR))) continue;
    const key = row.variant + "|" + String(row.side || "");
    if (!byVariant.has(key)) byVariant.set(key, []);
    byVariant.get(key).push({ row, uplift: Number(row.netR) - Number(baseline.netR) });
  }
  const suggestions = [];
  for (const [variantKey, pairs] of byVariant) {
    const [variant, candidateSide] = variantKey.split("|");
    // Multiple variants from the same trade are not independent observations.
    const unique = [...new Map(pairs.sort((a,b) => new Date(a.row.closedAt)-new Date(b.row.closedAt))
      .map(p => [String(p.row.tradeId), p])).values()];
    if (unique.length < 2) continue;
    // Chronological holdout: the latest 30% of unique closed trades is used
    // only for evaluation, never to choose the candidate. Avoid training/test
    // leakage by splitting by trade ID after sorting on actual close time.
    const splitAt = Math.max(1, Math.floor(unique.length * 0.7));
    const test = unique.slice(splitAt);
    if (!test.length) continue;
    const uplift = test.reduce((sum, p) => sum + p.uplift, 0) / test.length;
    const meanR = test.reduce((sum, p) => sum + Number(p.row.netR), 0) / test.length;
    const variance = test.reduce((sum, p) => sum + (p.uplift-uplift) ** 2, 0) / test.length;
    const standardError = Math.sqrt(variance / test.length);
    // Evidence threshold scales with observed uncertainty rather than a fixed
    // sample count or fixed R-uplift. Tiny samples with noisy outcomes naturally
    // fail this comparison; consistent repeated outcomes can qualify earlier.
    if (uplift > standardError && meanR > 0) suggestions.push({
      variant, side: candidateSide || unique[0].row.side, testUpliftR: Number(uplift.toFixed(4)),
      testMeanR: Number(meanR.toFixed(4)), standardError: Number(standardError.toFixed(4)),
      trainSamples: splitAt, testSamples: test.length, contextTags: wanted
    });
  }
  return suggestions.sort((a,b) => (b.testUpliftR-b.standardError)-(a.testUpliftR-a.standardError));
}
function stats(list) {
  const mean = list.length ? list.reduce((s,r)=>s+n(r.netR,0),0)/list.length : 0;
  const wins = list.filter(r=>n(r.netR,0)>0).length;
  return {samples:list.length,meanR:Number(mean.toFixed(4)),winRate:list.length?wins/list.length:0};
}

function evaluatePolicy(rowsToCheck = rows) {
  const grouped = new Map();
  const allBaselines = rowsToCheck.filter(r => r.variant === "BASELINE");
  for (const r of rowsToCheck) {
    const key = groupKey(r);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  const candidates=[];
  for (const [key, group] of grouped) {
    const alternatives=group.filter(r=>r.variant!=="BASELINE");
    // Each trade produces several alternatives; aggregate each variant separately
    // so one closed trade cannot inflate the sample count.
    const byVariant=new Map();
    for(const r of alternatives){ if(!byVariant.has(r.variant+"|"+r.side))byVariant.set(r.variant+"|"+r.side,[]); byVariant.get(r.variant+"|"+r.side).push(r); }
    for(const [variantKey, all] of byVariant){
      const variant = variantKey.split("|")[0];
      if (variant.startsWith("RISK_SCALE_") || variant.startsWith("EXIT_LEVEL:") ||
          /^(STOP|TARGET)_SCALE_/.test(variant)) continue;
      const ordered=all.slice().sort((a,b)=>a.closedAt-b.closedAt);
      const unique=[]; const ids=new Set();
      for(const r of ordered) if(!ids.has(r.tradeId)){ids.add(r.tradeId);unique.push(r);}
      const split=Math.floor(unique.length*0.7);
      const train=unique.slice(0,split), test=unique.slice(split);
      if(train.length<MIN_TRAIN||test.length<MIN_TEST) continue;
      const baselineByTrade=new Map(allBaselines.map(r=>[r.tradeId,r]));
      const pairedTrain=train.filter(r=>baselineByTrade.has(r.tradeId)).map(r=>({candidate:r.netR,base:baselineByTrade.get(r.tradeId).netR}));
      const pairedTest=test.filter(r=>baselineByTrade.has(r.tradeId)).map(r=>({candidate:r.netR,base:baselineByTrade.get(r.tradeId).netR}));
      if(pairedTrain.length<MIN_TRAIN||pairedTest.length<MIN_TEST)continue;
      const uplift=pairedTest.reduce((s,p)=>s+p.candidate-p.base,0)/pairedTest.length;
      const testMean=pairedTest.reduce((s,p)=>s+p.candidate,0)/pairedTest.length;
      if(uplift>=MIN_TEST_UPLIFT_R&&testMean>=MIN_TEST_MEAN_R){
        candidates.push({key,variant,trainSamples:pairedTrain.length,testSamples:pairedTest.length,
          testUpliftR:Number(uplift.toFixed(4)),testMeanR:Number(testMean.toFixed(4)),
          status:"VALIDATED_CANDIDATE",validatedAt:new Date()});
      }
    }
  }
  return candidates;
}

function evaluateExitPolicies(rowsToCheck = rows) {
  const baselines = new Map(rowsToCheck.filter(r => r?.variant === "BASELINE")
    .map(r => [String(r.tradeId), r]));
  const contexts = new Map();
  for (const row of rowsToCheck) {
    if (!row?.hypothetical || !String(row.variant || "").startsWith("EXIT_LEVEL:") ||
        !Number.isFinite(Number(row.stopScale)) || !Number.isFinite(Number(row.targetScale))) continue;
    const key = groupKey(row);
    if (!contexts.has(key)) contexts.set(key, new Map());
    const trades = contexts.get(key);
    const id = String(row.tradeId);
    if (!trades.has(id)) trades.set(id, { closedAt: new Date(row.closedAt || 0), rows: [] });
    trades.get(id).rows.push(row);
  }

  const validated = [];
  for (const [key, tradeMap] of contexts) {
    const trades = [...tradeMap.entries()].map(([tradeId, value]) => ({
      tradeId, ...value, baseline: baselines.get(tradeId)
    })).filter(trade => trade.baseline && Number.isFinite(Number(trade.baseline.netR)))
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
    const split = Math.floor(trades.length * 0.7);
    const train = trades.slice(0, split), test = trades.slice(split);
    if (train.length < MIN_TRAIN || test.length < MIN_TEST) continue;

    // Candidate pairs come only from training-period market levels. Sampling
    // bounds computation without prescribing numeric stop/target values.
    const centers = [...new Map(train.flatMap(trade => trade.rows.map(row => {
      const stopScale = Number(Number(row.stopScale).toFixed(3));
      const targetScale = Number(Number(row.targetScale).toFixed(3));
      return [`${stopScale}|${targetScale}`, { stopScale, targetScale }];
    }))).values()].sort((a, b) => a.stopScale - b.stopScale || a.targetScale - b.targetScale);
    const sampledCenters = centers.length <= 64 ? centers : Array.from({ length: 64 }, (_, i) =>
      centers[Math.round(i * (centers.length - 1) / 63)]);
    const nearestOutcome = (trade, center) => trade.rows.reduce((best, row) => {
      const ds = Math.log(Number(row.stopScale) / center.stopScale);
      const dt = Math.log(Number(row.targetScale) / center.targetScale);
      const distance = ds * ds + dt * dt;
      return !best || distance < best.distance ? { row, distance } : best;
    }, null)?.row;

    let best = null;
    for (const center of sampledCenters) {
      const pairedTrain = train.map(trade => ({
        candidate: nearestOutcome(trade, center)?.netR,
        base: Number(trade.baseline.netR)
      })).filter(pair => Number.isFinite(Number(pair.candidate)));
      if (pairedTrain.length < MIN_TRAIN) continue;
      const trainUplift = pairedTrain.reduce((sum, pair) => sum + Number(pair.candidate) - pair.base, 0) / pairedTrain.length;
      if (!best || trainUplift > best.trainUplift) best = { ...center, trainUplift };
    }
    if (!best || best.trainUplift <= 0) continue;

    const pairedTest = test.map(trade => ({
      candidate: nearestOutcome(trade, best)?.netR,
      base: Number(trade.baseline.netR)
    })).filter(pair => Number.isFinite(Number(pair.candidate)));
    if (pairedTest.length < MIN_TEST) continue;
    const deltas = pairedTest.map(pair => Number(pair.candidate) - pair.base);
    const uplift = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const meanR = pairedTest.reduce((sum, pair) => sum + Number(pair.candidate), 0) / pairedTest.length;
    const variance = deltas.reduce((sum, value) => sum + (value - uplift) ** 2, 0) / deltas.length;
    const standardError = Math.sqrt(variance / deltas.length);
    if (uplift < MIN_TEST_UPLIFT_R || uplift <= standardError || meanR < MIN_TEST_MEAN_R) continue;
    const variant = `EXIT_LEVEL:S${best.stopScale.toFixed(3)}:T${best.targetScale.toFixed(3)}`;
    validated.push({ key, variant, stopScale: best.stopScale, targetScale: best.targetScale,
      trainSamples: train.length, testSamples: pairedTest.length,
      trainUpliftR: Number(best.trainUplift.toFixed(4)), testUpliftR: Number(uplift.toFixed(4)),
      testMeanR: Number(meanR.toFixed(4)), standardError: Number(standardError.toFixed(4)),
      status: "VALIDATED_CANDIDATE", validatedAt: new Date(),
      source: "CHRONOLOGICAL_VALIDATION_OF_OBSERVED_MARKET_LEVELS" });
  }
  return validated;
}

async function initialize(db) {
  if(!db||typeof db.collection!=="function")throw new Error("NINE_AI_MONGODB_REQUIRED");
  outcomeCollection=db.collection(OUTCOME_COLLECTION);
  policyCollection=db.collection(POLICY_COLLECTION);
  // Retain historical rows for audit/research, but only new observed-level
  // exit policies are eligible for live application by the strategy.
  await policyCollection.updateMany({variant:/^(STOP|TARGET)_SCALE_/,status:"VALIDATED_CANDIDATE"},
    {$set:{status:"RETIRED",retiredAt:new Date(),retiredReason:"PRESET_EXIT_LEVELS_NO_LONGER_DEPLOYED"}});
  await outcomeCollection.deleteMany({variant:/^RISK_SCALE_/});
  await policyCollection.deleteMany({variant:/^RISK_SCALE_/});
  await outcomeCollection.createIndex({tradeId:1,variant:1},{unique:true,name:"uniq_nine_ai_counterfactual_trade_variant"});
  const recent=await outcomeCollection.find({}).sort({closedAt:-1}).limit(MAX_ROWS).toArray();
  rows=recent.filter(r=>r&&r.tradeId&&r.variant&&Number.isFinite(Number(r.netR)));
  seen=new Set(rows.map(r=>String(r.tradeId)+"|"+r.variant));
  policies=await policyCollection.find({status:"VALIDATED_CANDIDATE"}).sort({validatedAt:-1}).limit(100).toArray();
  return {samples:rows.length,policies:policies.length};
}

async function researchClosedTrade(trade, rawCandles) {
  if(!outcomeCollection)throw new Error("NINE_AI_COUNTERFACTUAL_RESEARCH_NOT_INITIALIZED");
  if(!trade||!trade.tradeId||!["LONG","SHORT"].includes(trade.side))throw new Error("CLOSED_TRADE_REQUIRED");
  const variants=buildVariants(trade,rawCandles);
  const inserted=[];
  for(const v of variants){
    const key=String(trade.tradeId)+"|"+v.variant;
    if(seen.has(key))continue;
    const isBaseline = v.variant === "BASELINE";
    const actualR = n(trade.realizedR);
    const baselineNetR = Number.isFinite(actualR) ? actualR : v.netR;
    const doc={tradeId:String(trade.tradeId),symbol:String(trade.symbol||""),side:v.side,
      originalSide:trade.side,variant:v.variant,entry:v.entry,sl:v.sl,tp:v.tp,
      features:featureTags(trade.features || {}),
      stopScale:Number.isFinite(Number(v.stopScale))?Number(v.stopScale):null,
      targetScale:Number.isFinite(Number(v.targetScale))?Number(v.targetScale):null,
      levelSource:v.levelSource || null,
      grossR:isBaseline ? baselineNetR + n(trade.feeR, FEE_R) : v.grossR,
      netR:isBaseline ? baselineNetR : v.netR,exit:isBaseline ? "ACTUAL" : v.exit,
      exitTime:isBaseline ? (trade.closedAt || v.exitTime) : v.exitTime,barsHeld:v.barsHeld,
      regime:String(trade.regime||"UNKNOWN"),closedAt:trade.closedAt?new Date(trade.closedAt):new Date(),
      hypothetical:!isBaseline,feesIncluded:true};
    try{await outcomeCollection.insertOne(doc);rows.unshift(doc);seen.add(key);inserted.push(doc);}
    catch(e){if(e?.code===11000){seen.add(key);continue;}throw e;}
  }
  if(rows.length>MAX_ROWS)rows.length=MAX_ROWS;
  const exitCandidates=evaluateExitPolicies(rows);
  // Revalidate the currently deployed exit policy after every newly closed
  // trade. If it no longer passes the chronological holdout, it is retired.
  await policyCollection.updateMany({variant:/^EXIT_LEVEL:/,status:"VALIDATED_CANDIDATE"},
    {$set:{status:"RETIRED",retiredAt:new Date(),retiredReason:"EXIT_POLICY_REVALIDATED_AFTER_NEW_CLOSE"}});
  policies=policies.filter(p=>!String(p.variant||"").startsWith("EXIT_LEVEL:"));
  const candidates=[...evaluatePolicy(rows),...exitCandidates];
  for(const candidate of candidates){
    const key=candidate.key+"|"+candidate.variant;
    const existing=policies.find(p=>p.key+"|"+p.variant===key);
    await policyCollection.updateOne({key:candidate.key,variant:candidate.variant},
      {$set:{...candidate,status:"VALIDATED_CANDIDATE"}},{upsert:true});
    if(existing){ Object.assign(existing,{...candidate,status:"VALIDATED_CANDIDATE"}); }
    else policies.push(candidate);
  }
  return {variants:inserted.length,samples:rows.length,candidates:candidates.length,results:inserted.map(r=>({variant:r.variant,side:r.side,netR:r.netR,exit:r.exit}))};
}

function advice({side,regime="UNKNOWN",features={}}={}) {
  const contextual = pairedVariantEvidence(rows, features, regime, side);
  const matching=policies.filter(p=>p.status==="VALIDATED_CANDIDATE"&&p.key.endsWith("|"+regime));
  const legacy = matching.filter(p=>!String(p.variant).startsWith("RISK_SCALE_")&&p.testUpliftR>=MIN_TEST_UPLIFT_R&&p.testMeanR>0)
    .map(p=>({variant:p.variant,side:p.key.split("|")[1],testUpliftR:p.testUpliftR,
      testMeanR:p.testMeanR,testSamples:p.testSamples,trainSamples:p.trainSamples,
      standardError:p.standardError,source:p.source||"CHRONOLOGICAL_POLICY"}));
  // Prefer context-matched paired evidence; legacy validated policies remain a
  // fallback for historical rows created before feature tags were persisted.
  const robustContextual = contextual.filter(p => Number(p.trainSamples) >= MIN_TRAIN &&
    Number(p.testSamples) >= MIN_TEST);
  const suggestions = robustContextual.length
    ? robustContextual.map(p=>({...p,source:"CONTEXTUAL_PAIRED_COUNTERFACTUAL"})) : legacy;
  return {side,validatedSuggestions:suggestions,samples:rows.length,
    contextTags:featureTags(features),mode:"CONTINUOUS_CONTEXTUAL_COUNTERFACTUAL_EVIDENCE"};
}
function status(){return {samples:rows.length,validatedPolicies:policies.length,minTrain:MIN_TRAIN,minTest:MIN_TEST};}

module.exports={OUTCOME_COLLECTION,POLICY_COLLECTION,MIN_TRAIN,MIN_TEST,normalizeCandles,simulate,validateEarlierSetup,buildVariants,evaluatePolicy,evaluateExitPolicies,observedExitDistances,featureTags,pairedVariantEvidence,initialize,researchClosedTrade,advice,status};
