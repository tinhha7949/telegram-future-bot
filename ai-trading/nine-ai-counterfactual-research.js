"use strict";

// Post-close counterfactual research. Simulates explicitly bounded alternatives on
// closed OHLCV candles only. These are hypothetical outcomes, never relabelled as
// actual PnL. Promotion requires chronological train/test validation.
const OUTCOME_COLLECTION = "nine_ai_counterfactual_outcomes";
const POLICY_COLLECTION = "nine_ai_counterfactual_policies";
const MAX_ROWS = 5000;
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
const n = (v, d = NaN) => Number.isFinite(Number(v)) ? Number(v) : d;

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
  const add = (variant, side, idx, e, stop, target, delay=0) => {
    const r = simulate({candles,entryIndex:idx,side,entry:e,sl:stop,tp:target,risk:Math.abs(e-stop),delay});
    if (r.valid) result.push({variant,side,entryIndex:idx,entry:e,sl:stop,tp:target,...r});
  };
  // Actual-side baseline uses the real levels and actual entry.
  add("BASELINE", trade.side, entryIndex, entry, sl, tp, 0);
  // Opposite direction is a research hypothesis, not an automatic flip. Mirror
  // the same risk and reward distances around entry and keep the same entry time.
  const opposite = trade.side === "LONG" ? "SHORT" : "LONG";
  const mirrorSl = opposite === "LONG" ? entry-risk : entry+risk;
  const mirrorTp = opposite === "LONG" ? entry+Math.abs(tp-entry) : entry-Math.abs(tp-entry);
  add("OPPOSITE_SIDE", opposite, entryIndex, entry, mirrorSl, mirrorTp, 0);
  // Delayed entries use only the delayed candle open; SL/TP distances remain fixed.
  for (const delay of [1,2]) {
    const idx = entryIndex + delay;
    if (idx >= candles.length-1) continue;
    const e = candles[idx].open;
    const stop = trade.side === "LONG" ? e-risk : e+risk;
    const target = trade.side === "LONG" ? e+Math.abs(tp-entry) : e-Math.abs(tp-entry);
    add("DELAY_"+delay+"_BAR", trade.side, idx, e, stop, target, 0);
  }
  // Tight/loose risk and reward alternatives at the same entry, bounded by the
  // original stop direction and original RR.
  for (const mult of [0.75,1.25]) {
    const r = risk*mult;
    const reward = r*clamp(rr,0.8,2.5);
    const stop = trade.side === "LONG" ? entry-r : entry+r;
    const target = trade.side === "LONG" ? entry+reward : entry-reward;
    add("RISK_SCALE_"+String(mult).replace(".","_"),trade.side,entryIndex,entry,stop,target,0);
  }
  return result;
}

function groupKey(row) { return row.side + "|" + (row.regime || "UNKNOWN"); }
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
    for(const [variant, all] of byVariant){
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

async function initialize(db) {
  if(!db||typeof db.collection!=="function")throw new Error("NINE_AI_MONGODB_REQUIRED");
  outcomeCollection=db.collection(OUTCOME_COLLECTION);
  policyCollection=db.collection(POLICY_COLLECTION);
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
    const doc={tradeId:String(trade.tradeId),symbol:String(trade.symbol||""),side:v.side,
      originalSide:trade.side,variant:v.variant,entry:v.entry,sl:v.sl,tp:v.tp,
      grossR:v.grossR,netR:v.netR,exit:v.exit,exitTime:v.exitTime,barsHeld:v.barsHeld,
      regime:String(trade.regime||"UNKNOWN"),closedAt:trade.closedAt?new Date(trade.closedAt):new Date(),
      hypothetical:true,feesIncluded:true};
    try{await outcomeCollection.insertOne(doc);rows.unshift(doc);seen.add(key);inserted.push(doc);}
    catch(e){if(e?.code===11000){seen.add(key);continue;}throw e;}
  }
  if(rows.length>MAX_ROWS)rows.length=MAX_ROWS;
  const candidates=evaluatePolicy(rows);
  for(const candidate of candidates){
    const key=candidate.key+"|"+candidate.variant;
    const existing=policies.find(p=>p.key+"|"+p.variant===key);
    if(existing)continue;
    await policyCollection.updateOne({key:candidate.key,variant:candidate.variant},
      {$set:{...candidate,status:"VALIDATED_CANDIDATE"}},{upsert:true});
    policies.push(candidate);
  }
  return {variants:inserted.length,samples:rows.length,candidates:candidates.length,results:inserted.map(r=>({variant:r.variant,side:r.side,netR:r.netR,exit:r.exit}))};
}

function advice({side,regime="UNKNOWN"}={}) {
  const matching=policies.filter(p=>p.status==="VALIDATED_CANDIDATE"&&p.key.endsWith("|"+regime));
  const suggestions=matching.filter(p=>p.testUpliftR>=MIN_TEST_UPLIFT_R&&p.testMeanR>0);
  return {side,validatedSuggestions:suggestions.map(p=>({variant:p.variant,side:p.key.split("|")[1],testUpliftR:p.testUpliftR,testMeanR:p.testMeanR,testSamples:p.testSamples})),
    samples:rows.length,mode:"RESEARCH_ONLY_UNTIL_EXPLICIT_EXECUTION_RULE"};
}
function status(){return {samples:rows.length,validatedPolicies:policies.length,minTrain:MIN_TRAIN,minTest:MIN_TEST};}

module.exports={OUTCOME_COLLECTION,POLICY_COLLECTION,MIN_TRAIN,MIN_TEST,normalizeCandles,simulate,buildVariants,evaluatePolicy,initialize,researchClosedTrade,advice,status};
