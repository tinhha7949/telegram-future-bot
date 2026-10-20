"use strict";

// Canonical Nine-AI pipeline. This module is the only place that may choose
// LONG, SHORT or WAIT. It consumes closed-candle snapshots and never places orders.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n, fallback = null) => n === null || n === undefined || n === "" ? fallback : (Number.isFinite(Number(n)) ? Number(n) : fallback);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const stdev = xs => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)) || 0);
};
function percentile(values, p) {
  const xs = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = (xs.length - 1) * clamp(Number(p), 0, 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
}
function candle(c) {
  if (Array.isArray(c)) return { time:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5], closeTime:+c[6] };
  return { time:+(c?.openTime ?? c?.time), open:+c?.open, high:+c?.high, low:+c?.low, close:+c?.close, volume:+c?.volume, closeTime:+(c?.closeTime ?? c?.time) };
}
function closedCandles(input, now = Date.now()) {
  if (!Array.isArray(input)) return [];
  return input.map(candle).filter(c => [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.high >= c.low && c.close > 0 && c.volume >= 0 &&
    (!Number.isFinite(c.closeTime) || c.closeTime < now));
}
function percentileRank(history, value) {
  if (!history.length || !Number.isFinite(value)) return null;
  return history.filter(x => x <= value).length / history.length;
}
function trueRanges(cs) {
  return cs.slice(1).map((c, i) => Math.max(c.high-c.low, Math.abs(c.high-cs[i].close), Math.abs(c.low-cs[i].close)));
}
function vwap(cs) {
  const vol = cs.reduce((s,c)=>s+c.volume,0);
  return vol > 0 ? cs.reduce((s,c)=>s+((c.high+c.low+c.close)/3)*c.volume,0)/vol : null;
}
function swingPoints(cs, radius = 2) {
  const highs=[], lows=[];
  for(let i=radius;i<cs.length-radius;i++){
    let hi=true, lo=true;
    for(let j=i-radius;j<=i+radius;j++){
      if(j===i) continue;
      if(cs[j].high >= cs[i].high) hi=false;
      if(cs[j].low <= cs[i].low) lo=false;
    }
    if(hi) highs.push({index:i,price:cs[i].high});
    if(lo) lows.push({index:i,price:cs[i].low});
  }
  return {highs,lows};
}
function classifyRegime(cs, higher = []) {
  const closes=cs.map(c=>c.close), logReturns=[];
  for(let i=1;i<closes.length;i++) logReturns.push(Math.log(closes[i]/closes[i-1]));
  // Four-hour bars: 120 observations ~= 20 days; 540 ~= 90 days.
  const annualizer=Math.sqrt(6*365)*100;
  const realized20=logReturns.length>=120 ? stdev(logReturns.slice(-120))*annualizer : null;
  const realized90=logReturns.length>=540 ? stdev(logReturns.slice(-540))*annualizer : null;
  const realized=realized90 ?? realized20;
  const volHistory=[];
  for(let end=120;end<=logReturns.length;end++) volHistory.push(stdev(logReturns.slice(end-120,end))*annualizer);
  const volRank=percentileRank(volHistory, realized20);
  const mom20=closes.length>=121 ? closes.at(-1)/closes.at(-121)-1 : 0;
  const mom5=closes.length>=31 ? closes.at(-1)/closes.at(-31)-1 : 0;
  const trendAgreement=higher.length ? higher.filter(x=>x>0?mom20>0:x<0?mom20<0:true).length/higher.length : 1;
  let regime="RANGE";
  if(volRank!==null && volRank>=0.8) regime="HIGH_VOL";
  else if(mom20>0.012 && mom5>0 && trendAgreement>=0.5) regime="UPTREND";
  else if(mom20< -0.012 && mom5<0 && trendAgreement>=0.5) regime="DOWNTREND";
  const strength=clamp(Math.abs(mom20)/0.04,0,1);
  const regimeConf=clamp(0.45+0.35*strength+0.2*Math.abs((volRank??0.5)-0.5)*2,0,1);
  return {regime,regime_conf:regimeConf,realized_vol_20d:realized20,realized_vol_90d:realized90,realized_vol_20_90d:realized,vol_percentile:volRank,momentum20:mom20,momentum5:mom5,trendAgreement};
}
function buildHistoricalOutcomeLabels(input, now = Date.now(), horizon = 24, symbol = null) {
  const cs = closedCandles(input, now);
  const labels = [];
  // Historical bootstrap samples use the same trend-pullback or confirmed
  // range-breakout entry conditions as the live strategy. Every outcome window
  // is fully matured before it can enter AI-7 distributions.
  for (let i = 540; i + horizon < cs.length; i++) {
    const prefix = cs.slice(0, i + 1);
    const regime = classifyRegime(prefix);
    if (!["UPTREND", "DOWNTREND"].includes(regime.regime)) continue;
    const last = cs[i], prev = cs[i - 1];
    const atr = mean(trueRanges(prefix).slice(-14));
    if (!(atr > 0)) continue;
    const averageVolume = mean(prefix.slice(-21, -1).map(c => c.volume)) || 0;
    const volumeRatio = averageVolume > 0 ? last.volume / averageVolume : 0;
    const rangeHigh = Math.max(...prefix.slice(-21, -1).map(c => c.high));
    const rangeLow = Math.min(...prefix.slice(-21, -1).map(c => c.low));
    const extension = Math.abs(last.close - prefix.at(-5).close) / Math.max(atr, 1e-12);
    const pullbackLong = regime.regime === "UPTREND" && last.close < prev.close &&
      last.close > last.open && last.close > prefix.at(-4).close;
    const pullbackShort = regime.regime === "DOWNTREND" && last.close > prev.close &&
      last.close < last.open && last.close < prefix.at(-4).close;
    const breakoutLong = last.close > rangeHigh && last.close > prev.close &&
      last.low > rangeHigh - atr * 0.25 && volumeRatio >= 1.25 && extension < 2.5;
    const breakoutShort = last.close < rangeLow && last.close < prev.close &&
      last.high < rangeLow + atr * 0.25 && volumeRatio >= 1.25 && extension < 2.5;
    const side = pullbackLong || breakoutLong ? "LONG" :
      pullbackShort || breakoutShort ? "SHORT" : null;
    if (!side) continue;
    const entry = last.close;
    const future = cs.slice(i + 1, i + horizon + 1);
    if (future.length !== horizon) continue;
    const adverse = side === "LONG"
      ? Math.max(0, entry - Math.min(...future.map(c => c.low)))
      : Math.max(0, Math.max(...future.map(c => c.high)) - entry);
    const favorable = side === "LONG"
      ? Math.max(0, Math.max(...future.map(c => c.high)) - entry)
      : Math.max(0, entry - Math.min(...future.map(c => c.low)));
    if (favorable <= adverse || favorable <= 0) continue;
    labels.push({
      symbol: symbol ? String(symbol).toUpperCase() : null,
      setupKey: regime.regime, side, entryPrice: entry,
      mae: adverse, mfe: favorable, maePct: adverse / entry * 100, mfePct: favorable / entry * 100,
      labeled: true, source: "CLOSED_HISTORICAL_4H_SIMULATION",
      signalAt: cs[i].closeTime, outcomeClosedAt: future.at(-1).closeTime
    });
  }
  return labels;
}
function analyzeNineAI({symbol,candles4h,candles1h=[],candles1d=[],market={},outcomes=[],equity=0,config={}}={}) {
  const now=finite(market.now,Date.now()), cs=closedCandles(candles4h,now);
  const wait=(reason,extra={})=>({symbol,setup:"NINE_AI_4H",signalAt:cs.at(-1)?.closeTime,action:"WAIT",side:null,authorizedForExecution:false,reason,agents:null,...extra});
  if(cs.length<541) return wait("INSUFFICIENT_90D_CLOSED_4H_HISTORY",{candles:cs.length,required:541});
  const cs1h=closedCandles(candles1h,now), cs1d=closedCandles(candles1d,now);
  if(cs1h.length<=24||cs1d.length<=20)
    return wait("MISSING_MULTITIMEFRAME_CLOSED_CANDLES",{candles1h:cs1h.length,candles1d:cs1d.length});
  const last=cs.at(-1), prev=cs.at(-2), closes=cs.map(c=>c.close);
  const higherMomentum = [cs1h, cs1d].map((x, index) => {
    const lookback = index === 0 ? 24 : 20;
    return x.length > lookback ? x.at(-1).close / x.at(-1 - lookback).close - 1 : null;
  }).filter(Number.isFinite);
  const regime=classifyRegime(cs, higherMomentum);
  const atrs=trueRanges(cs), atr=mean(atrs.slice(-14)), atrPct=atr/last.close;
  const structure=swingPoints(cs.slice(-120),2);
  const swingHigh=structure.highs.at(-1)?.price ?? Math.max(...cs.slice(-30).map(c=>c.high));
  const swingLow=structure.lows.at(-1)?.price ?? Math.min(...cs.slice(-30).map(c=>c.low));
  const structureBias=last.close>swingHigh ? "BULLISH" : last.close<swingLow ? "BEARISH" :
    (structure.highs.length>=2 && structure.lows.length>=2 &&
    structure.highs.at(-1).price>structure.highs.at(-2).price && structure.lows.at(-1).price>structure.lows.at(-2).price) ? "BULLISH" :
    (structure.highs.length>=2 && structure.lows.length>=2 &&
    structure.highs.at(-1).price<structure.highs.at(-2).price && structure.lows.at(-1).price<structure.lows.at(-2).price) ? "BEARISH" : "NEUTRAL";
  const support=swingLow, resistance=swingHigh;
  const funding=finite(market.fundingRate), oiChange=finite(market.openInterestChange), spread=finite(market.spreadPct), depth=finite(market.depthNotional), latency=finite(market.latencyMs);
  const fundingHot=funding===null || Math.abs(funding)>finite(config.maxAbsFunding,0.0008);
  const avgVol=mean(cs.slice(-21,-1).map(c=>c.volume)) || 0;
  const volumeRatio=avgVol>0?last.volume/avgVol:0;
  const rangeHigh=Math.max(...cs.slice(-21,-1).map(c=>c.high)), rangeLow=Math.min(...cs.slice(-21,-1).map(c=>c.low));
  const breakoutSide=last.close>rangeHigh && last.close>prev.close ? "LONG" : last.close<rangeLow && last.close<prev.close ? "SHORT" : null;
  const breakoutHeld=breakoutSide==="LONG" ? (last.low>rangeHigh-atr*0.25) : breakoutSide==="SHORT" ? (last.high<rangeLow+atr*0.25) : false;
  const extension=Math.abs(last.close-(closes.at(-5)||last.close))/Math.max(atr,1e-12);
  const trendLong=regime.regime==="UPTREND", trendShort=regime.regime==="DOWNTREND";
  const pullbackLong=trendLong && last.close<prev.close && last.close>last.open && last.close>closes.at(-4);
  const pullbackShort=trendShort && last.close>prev.close && last.close<last.open && last.close<closes.at(-4);
  const continuationSide=pullbackLong?"LONG":pullbackShort?"SHORT":null;
  const continuationP=continuationSide ? clamp(0.54+Math.min(0.18,Math.abs(regime.momentum20)*3)+(volumeRatio>1?0.05:0),0.5,0.78):0.5;
  const breakoutP=breakoutSide&&breakoutHeld&&volumeRatio>=1.25&&spread!==null&&spread<=finite(config.maxSpreadPct,0.15)&&extension<2.5 ? clamp(0.55+Math.min(0.2,(volumeRatio-1)*0.1),0.5,0.78):0.5;
  const vwapValue=vwap(cs.slice(-24)), deviation=vwapValue?(last.close-vwapValue)/Math.max(atr,1e-12):0;
  const rangeRegime=["RANGE","HIGH_VOL"].includes(regime.regime);
  // Positive liquidationImbalance is short-liquidation notional minus long-liquidation notional.
  // Missing liquidation data is never treated as zero and cannot confirm a direction.
  const liq=finite(market.liquidationImbalance);
  const revertSide=rangeRegime && liq!==null && Math.abs(deviation)>=1.25
    ? (deviation>0 && liq<=0 ? "SHORT" : deviation<0 && liq>=0 ? "LONG" : null) : null;
  const revertP=revertSide?clamp(0.53+Math.min(0.15,Math.abs(deviation)*0.04),0.5,0.72):0.5;
  const flowConfirmationSide = oiChange!==null && oiChange>0 && liq!==null && !fundingHot
    ? (liq>0 && funding<=0 ? "LONG" : liq<0 && funding>=0 ? "SHORT" : null)
    : null;
  const flow={fundingRate:funding,openInterestChange:oiChange,liquidationImbalance:liq,
    confirmationSide:flowConfirmationSide,
    confirmation: funding===null || oiChange===null || liq===null ? "UNAVAILABLE" :
      (fundingHot?"BLOCKED_HOT_FUNDING":(flowConfirmationSide?"CONFIRMED":"NEUTRAL"))};
  const historicalLabels = buildHistoricalOutcomeLabels(cs, now, 24, symbol);
  const labeled=[...outcomes,...historicalLabels].filter(o=>o&&o.setupKey&&Number.isFinite(Number(o.maePct))&&Number.isFinite(Number(o.mfePct)));
  // Percent-normalized movement distributions can be pooled across symbols
  // without mixing a low-priced coin's raw distance with BTC's.
  const setupKey=regime.regime;
  const matched=labeled.filter(o=>o.setupKey===setupKey&&o.side&&(o.source==="CLOSED_HISTORICAL_4H_SIMULATION"||(o.symbol&&String(o.symbol).toUpperCase()===String(symbol).toUpperCase())));
  const maes=matched.map(o=>Math.abs(Number(o.maePct))), mfes=matched.map(o=>Math.abs(Number(o.mfePct)));
  const distMAE={p50:percentile(maes,.5),p80:percentile(maes,.8),p90:percentile(maes,.9),samples:maes.length};
  const distMFE={p50:percentile(mfes,.5),p90:percentile(mfes,.9),samples:mfes.length};
  // No fabricated MAE/MFE quantiles. Insufficient labels means no live trade.
  if(matched.length<30 || distMAE.p80===null || distMFE.p50===null || distMFE.p90===null)
    return wait("INSUFFICIENT_LABELED_OUTCOMES_FOR_QUANTILES",{regime,structure:{structure_bias:structureBias,support,resistance},dist_MAE:distMAE,dist_MFE:distMFE,setupKey});
  const fee=finite(market.roundTripFeePct,finite(config.roundTripFeePct,0.1));
  const fundingCost=finite(market.expectedFundingCostPct, funding===null?null:Math.abs(funding)*100);
  const slippage=spread===null||depth===null||oiChange===null||latency===null?null:
    clamp(spread*0.5 + 0.02/Math.max(depth/100000,0.1)+Math.max(0,latency-100)*0.00001+Math.abs(oiChange)*0.01,0,1);
  const estimatedSlippage=slippage===null?null:slippage;
  if(estimatedSlippage===null||fundingCost===null||fee===null) return wait("EXECUTION_COST_INPUTS_STALE_OR_MISSING",{regime,flow});
  const agents={
    regime,structure:{structure_bias:structureBias,swingHigh,swingLow,support,resistance},
    continuation:{side:continuationSide,p:continuationP,expectedR:continuationSide?Math.max(0.1,distMFE.p50/Math.max(distMAE.p80,1e-12)):0},
    breakout:{side:breakoutSide,p:breakoutP,held:breakoutHeld,volumeRatio,extensionAtr:extension},
    meanReversion:{side:revertSide,p:revertP,vwap:vwapValue,deviationAtr:deviation},
    flow,outcome:{dist_MAE:distMAE,dist_MFE:distMFE,setupKey},
    fill:{est_slippage:estimatedSlippage,spreadPct:spread,depthNotional:depth,latencyMs:latency}
  };
  const candidates=["LONG","SHORT"].map(side=>{
    const evidence=[
      {name:"continuation",side:continuationSide,p:continuationP,er:agents.continuation.expectedR,weight:0.4},
      {name:"breakout",side:breakoutSide,p:breakoutP,er:Math.max(.1,distMFE.p50/Math.max(distMAE.p80,1e-12)),weight:.35},
      {name:"mean_reversion",side:revertSide,p:revertP,er:Math.max(.1,distMFE.p50/Math.max(distMAE.p80,1e-12)),weight:.25}
    ];
    const applicable=evidence.filter(e=>e.side===side);
    const p=applicable.length?applicable.reduce((s,e)=>s+e.p*e.weight,0)/applicable.reduce((s,e)=>s+e.weight,0):0.5;
    const modelER=applicable.length?applicable.reduce((s,e)=>s+e.er*e.weight,0)/applicable.reduce((s,e)=>s+e.weight,0):0;
    const track = market.trackRecord?.[regime.regime + "_" + side];
    const trackSamples = finite(track?.samples, 0);
    const trackGrossR = finite(track?.meanGrossR);
    const er = trackSamples >= 20 && trackGrossR !== null ? 0.5 * modelER + 0.5 * trackGrossR : modelER;
    const cost=(fee+fundingCost+estimatedSlippage)/Math.max(distMAE.p80,1e-12);
    const uncertainty=(1-regime.regime_conf)*finite(config.uncertaintyPenalty,0.5)+
      (Date.now()-finite(market.snapshotAt,now)>finite(config.maxDataAgeMs,5*60*1000)?1:0);
    return {side,p,expectedR:er,cost,uncertaintyPenalty:uncertainty,edge:p*er-cost-uncertainty,applicableModels:applicable.map(e=>e.name)};
  });
  const [long,short]=candidates;
  const minEdge=finite(config.minEdge,0.05), gapEdge=finite(config.gapEdge,0.1);
  let side="WAIT",reason="EDGE_BELOW_THRESHOLD";
  if(!["UPTREND","DOWNTREND"].includes(regime.regime)) reason="REGIME_NOT_TREND";
  else if(flow.confirmation==="BLOCKED_HOT_FUNDING"||flow.confirmation==="UNAVAILABLE") reason="FLOW_BLOCKED_OR_UNAVAILABLE";
  else if(long.edge>minEdge && long.edge-short.edge>gapEdge && (!flow.confirmationSide||flow.confirmationSide==="LONG") && (trendLong?structureBias!=="BEARISH":true)) {side="LONG";reason="LONG_NET_EDGE_WINS";}
  else if(short.edge>minEdge && short.edge-long.edge>gapEdge && (!flow.confirmationSide||flow.confirmationSide==="SHORT") && (trendShort?structureBias!=="BULLISH":true)) {side="SHORT";reason="SHORT_NET_EDGE_WINS";}
  if(side==="WAIT") return wait(reason,{regime,agents,edges:{LONG:long,SHORT:short},setupKey});
  const entry=last.close;
  const stopDistance=distMAE.p80*entry/100, tp1Distance=distMFE.p50*entry/100, tp2Distance=distMFE.p90*entry/100;
  const sl=side==="LONG"?Math.min(entry-stopDistance,support-atr*.1):Math.max(entry+stopDistance,resistance+atr*.1);
  const tp1=side==="LONG"?entry+tp1Distance:entry-tp1Distance, tp2=side==="LONG"?entry+tp2Distance:entry-tp2Distance;
  if(!(stopDistance>0&&tp1Distance>0&&tp2Distance>=tp1Distance&&Number.isFinite(sl)&&Number.isFinite(tp1)&&Number.isFinite(tp2)))
    return wait("INVALID_OUTCOME_DERIVED_EXIT_PLAN",{regime,agents,edges:{LONG:long,SHORT:short}});
  return {symbol,side,action:side,authorizedForExecution:true,reason,setup:"NINE_AI_4H",signalAt:last.closeTime,
    entry,price:entry,sl,tp:tp2,tp1,tp2,closePercentAtTP1:50,timeoutCandles:24,timeframe:"4h",
    riskPerTradePct:0.0075,riskEquity:finite(equity,0)*0.0075,
    edges:{LONG:long,SHORT:short},regime,agents,setupKey,featureSnapshot:{snapshotAt:finite(market.snapshotAt,now),closeTime:last.closeTime,close:entry,atr,atrPct,volumeRatio,funding,oiChange,spread,depth,latency,feePct:fee,fundingCostPct:fundingCost,estSlippagePct:estimatedSlippage,regime,structureBias},
    tradePlan:{stopMethod:"LABELED_MAE_P80_WITH_STRUCTURE_BUFFER",targetMethod:"LABELED_MFE_P50_P90",tp1,tp2,closePercentAtTP1:50,timeoutCandles:24,timeoutMs:96*60*60*1000},
    candles:cs.length};
}
module.exports={percentile,closedCandles,swingPoints,classifyRegime,buildHistoricalOutcomeLabels,analyzeNineAI};
