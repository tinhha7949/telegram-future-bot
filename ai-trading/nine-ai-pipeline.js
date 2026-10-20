"use strict";

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
    Number.isFinite(c.closeTime) && c.closeTime < now);
}
function percentileRank(history, value) {
  if (!history.length || !Number.isFinite(value)) return null;
  return history.filter(x => Number.isFinite(x) && x <= value).length / history.length;
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
  // Four-hour bars: 120 returns ~= 20 days; 540 ~= 90 days.
  const annualizer=Math.sqrt(6*365)*100;
  const realized20=logReturns.length>=120 ? stdev(logReturns.slice(-120))*annualizer : null;
  const realized90=logReturns.length>=540 ? stdev(logReturns.slice(-540))*annualizer : null;
  const volHistory=[];
  for(let end=120;end<=logReturns.length;end++) volHistory.push(stdev(logReturns.slice(end-120,end))*annualizer);
  const volRank=percentileRank(volHistory, realized20);
  const mom20=closes.length>=121 ? closes.at(-1)/closes.at(-121)-1 : 0;
  const mom5=closes.length>=31 ? closes.at(-1)/closes.at(-31)-1 : 0;
  const availableHigher=higher.filter(Number.isFinite);
  const trendAgreement=availableHigher.length ? availableHigher.filter(x=>x>0?mom20>0:x<0?mom20<0:true).length/availableHigher.length : 1;
  let regime="RANGE";
  if(volRank!==null && volRank>=0.8) regime="HIGH_VOL";
  else if(mom20>0.012 && mom5>0 && trendAgreement>=0.5) regime="UPTREND";
  else if(mom20< -0.012 && mom5<0 && trendAgreement>=0.5) regime="DOWNTREND";
  const strength=clamp(Math.abs(mom20)/0.04,0,1);
  const regimeConf=clamp(0.45+0.35*strength+0.2*Math.abs((volRank??0.5)-0.5)*2,0,1);
  return {regime,regime_conf:regimeConf,realized_vol_20d:realized20,realized_vol_90d:realized90,realized_vol_20_90d:realized90??realized20,vol_percentile:volRank,momentum20:mom20,momentum5:mom5,trendAgreement};
}

// Bootstrap labels are simulations from fully closed historical windows, not realized trades.
// All triggered setups are kept, including losing outcomes, to avoid winner-only MAE/MFE bias.
function buildHistoricalOutcomeLabels(input, now = Date.now(), horizon = 24, symbol = null) {
  const cs = closedCandles(input, now);
  const labels = [];
  if (cs.length < 541 + horizon) return labels;
  const closes = cs.map(c=>c.close);
  const returns = closes.slice(1).map((close,i)=>Math.log(close/closes[i]));
  const annualizer=Math.sqrt(6*365)*100;
  const rollingVol = new Array(cs.length).fill(null);
  const volHistory = [];
  for(let i=120;i<=returns.length;i++){
    const value=stdev(returns.slice(i-120,i))*annualizer;
    rollingVol[i]=value;
    volHistory.push(value);
  }
  const atrByIndex = new Array(cs.length).fill(null);
  const tr = trueRanges(cs);
  for(let i=14;i<cs.length;i++) atrByIndex[i]=mean(tr.slice(i-14,i));
  for (let i = 540; i + horizon < cs.length; i++) {
    const last = cs[i], prev = cs[i - 1], atr = atrByIndex[i];
    if (!(atr > 0)) continue;
    const vol = rollingVol[i];
    const rank = percentileRank(volHistory.slice(0, Math.max(0, i-119)), vol);
    const mom20 = closes[i] / closes[i-120] - 1;
    const mom5 = closes[i] / closes[i-30] - 1;
    let regime = "RANGE";
    if(rank!==null && rank>=0.8) regime="HIGH_VOL";
    else if(mom20>0.012 && mom5>0) regime="UPTREND";
    else if(mom20< -0.012 && mom5<0) regime="DOWNTREND";
    if (!["UPTREND","DOWNTREND"].includes(regime)) continue;
    const averageVolume = mean(cs.slice(i-21, i).map(c => c.volume)) || 0;
    const volumeRatio = averageVolume > 0 ? last.volume / averageVolume : 0;
    const rangeHigh = Math.max(...cs.slice(i-21, i).map(c => c.high));
    const rangeLow = Math.min(...cs.slice(i-21, i).map(c => c.low));
    const extension = Math.abs(last.close - closes[i-4]) / Math.max(atr, 1e-12);
    const impulse = Math.abs(last.close-last.open)/Math.max(atr,1e-12)>=0.2;
    const continuationLong = regime==="UPTREND" && last.close<prev.close && last.close>last.open && last.close>closes[i-3] && impulse;
    const continuationShort = regime==="DOWNTREND" && last.close>prev.close && last.close<last.open && last.close<closes[i-3] && impulse;
    const breakoutLong = last.close>rangeHigh && last.close>prev.close && last.low>rangeHigh-atr*0.25 && volumeRatio>=1.25 && extension<2.5;
    const breakoutShort = last.close<rangeLow && last.close<prev.close && last.high<rangeLow+atr*0.25 && volumeRatio>=1.25 && extension<2.5;
    const setupType = continuationLong || continuationShort ? "CONTINUATION" :
      breakoutLong || breakoutShort ? "BREAKOUT" : null;
    const side = continuationLong || breakoutLong ? "LONG" : continuationShort || breakoutShort ? "SHORT" : null;
    if (!side || !setupType) continue;
    const entry = last.close, future = cs.slice(i+1, i+horizon+1);
    if (future.length !== horizon) continue;
    const adverse = side==="LONG" ? Math.max(0,entry-Math.min(...future.map(c=>c.low))) :
      Math.max(0,Math.max(...future.map(c=>c.high))-entry);
    const favorable = side==="LONG" ? Math.max(0,Math.max(...future.map(c=>c.high))-entry) :
      Math.max(0,entry-Math.min(...future.map(c=>c.low)));
    labels.push({
      symbol:symbol?String(symbol).toUpperCase():null,
      setupKey:regime+"_"+setupType, setupType, regime, side, entryPrice:entry,
      mae:adverse,mfe:favorable,maePct:adverse/entry*100,mfePct:favorable/entry*100,
      win:favorable>adverse,labeled:true,source:"CLOSED_HISTORICAL_4H_SIMULATION",
      signalAt:cs[i].closeTime,outcomeClosedAt:future.at(-1).closeTime
    });
  }
  return labels;
}
function analyzeNineAI({symbol,candles4h,candles1h=[],candles1d=[],market={},outcomes=[],equity=0,config={}}={}) {
  const now=finite(market.now,Date.now()), cs=closedCandles(candles4h,now);
  const wait=(reason,extra={})=>({symbol,setup:"NINE_AI_4H",signalAt:cs.at(-1)?.closeTime,action:"WAIT",side:null,authorizedForExecution:false,reason,agents:null,...extra});
  if(cs.length<541) return wait("INSUFFICIENT_90D_CLOSED_4H_HISTORY",{candles:cs.length,required:541});
  const cs1h=closedCandles(candles1h,now), cs1d=closedCandles(candles1d,now);
  if(cs1h.length<=24||cs1d.length<=20) return wait("MISSING_MULTITIMEFRAME_CLOSED_CANDLES",{candles1h:cs1h.length,candles1d:cs1d.length});
  const last=cs.at(-1), prev=cs.at(-2), closes=cs.map(c=>c.close);
  const higherMomentum=[cs1h,cs1d].map((x,index)=>{const lookback=index===0?24:20;return x.length>lookback?x.at(-1).close/x.at(-1-lookback).close-1:null;}).filter(Number.isFinite);
  const regime=classifyRegime(cs,higherMomentum);
  const atr=mean(trueRanges(cs).slice(-14)), atrPct=atr/last.close;
  const structure=swingPoints(cs.slice(-120),2);
  const swingHigh=structure.highs.at(-1)?.price??Math.max(...cs.slice(-30).map(c=>c.high));
  const swingLow=structure.lows.at(-1)?.price??Math.min(...cs.slice(-30).map(c=>c.low));
  const structureBias=structure.highs.length>=2&&structure.lows.length>=2&&structure.highs.at(-1).price>structure.highs.at(-2).price&&structure.lows.at(-1).price>structure.lows.at(-2).price?"BULLISH":
    structure.highs.length>=2&&structure.lows.length>=2&&structure.highs.at(-1).price<structure.highs.at(-2).price&&structure.lows.at(-1).price<structure.lows.at(-2).price?"BEARISH":
    last.close>swingHigh?"BULLISH":last.close<swingLow?"BEARISH":"NEUTRAL";
  const support=swingLow,resistance=swingHigh;
  const funding=finite(market.fundingRate), oiChange=finite(market.openInterestChange), spread=finite(market.spreadPct), depth=finite(market.depthNotional), latency=finite(market.latencyMs);
  const fundingHot=funding===null||Math.abs(funding)>finite(config.maxAbsFunding,0.0008);
  const avgVol=mean(cs.slice(-21,-1).map(c=>c.volume))||0, volumeRatio=avgVol>0?last.volume/avgVol:0;
  const rangeHigh=Math.max(...cs.slice(-21,-1).map(c=>c.high)), rangeLow=Math.min(...cs.slice(-21,-1).map(c=>c.low));
  const extension=Math.abs(last.close-closes.at(-5))/Math.max(atr,1e-12);
  const impulse=Math.abs(last.close-last.open)/Math.max(atr,1e-12)>=0.2;
  // AI-3: pullback + impulse + increasing OI + non-hot funding inside a matching trend.
  const continuationLong=regime.regime==="UPTREND"&&!fundingHot&&oiChange!==null&&oiChange>0&&volumeRatio>=1.05&&impulse&&last.close<prev.close&&last.close>last.open&&last.close>closes.at(-4);
  const continuationShort=regime.regime==="DOWNTREND"&&!fundingHot&&oiChange!==null&&oiChange>0&&volumeRatio>=1.05&&impulse&&last.close>prev.close&&last.close<last.open&&last.close<closes.at(-4);
  const continuationSide=continuationLong?"LONG":continuationShort?"SHORT":null;
  // AI-4: volume expansion, held breakout, acceptable spread, and no late chase.
  const rawBreakoutSide=last.close>rangeHigh&&last.close>prev.close?"LONG":last.close<rangeLow&&last.close<prev.close?"SHORT":null;
  const breakoutHeld=rawBreakoutSide==="LONG"?last.low>rangeHigh-atr*0.25:rawBreakoutSide==="SHORT"?last.high<rangeLow+atr*0.25:false;
  const breakoutEligible=!!rawBreakoutSide&&breakoutHeld&&volumeRatio>=1.25&&spread!==null&&spread<=finite(config.maxSpreadPct,0.15)&&extension<2.5;
  const breakoutSide=breakoutEligible?rawBreakoutSide:null;
  const vwapValue=vwap(cs.slice(-24)), deviation=vwapValue?(last.close-vwapValue)/Math.max(atr,1e-12):0;
  const rangeRegime=["RANGE","HIGH_VOL"].includes(regime.regime);
  const liq=finite(market.liquidationImbalance);
  const revertSide=rangeRegime&&liq!==null&&Math.abs(deviation)>=1.25?(deviation>0&&liq<=0?"SHORT":deviation<0&&liq>=0?"LONG":null):null;
  const flowConfirmationSide=oiChange!==null&&oiChange>0&&liq!==null&&!fundingHot?(liq>0&&funding<=0?"LONG":liq<0&&funding>=0?"SHORT":null):null;
  const flow={fundingRate:funding,openInterestChange:oiChange,liquidationImbalance:liq,confirmationSide:flowConfirmationSide,
    confirmation:funding===null||oiChange===null||liq===null?"UNAVAILABLE":fundingHot?"BLOCKED_HOT_FUNDING":flowConfirmationSide?"CONFIRMED":"NEUTRAL"};
  const historical=buildHistoricalOutcomeLabels(cs,now,24,symbol);
  const labeled=[...outcomes,...historical].filter(o=>o&&o.setupKey&&Number.isFinite(Number(o.maePct))&&Number.isFinite(Number(o.mfePct))&&o.side);
  const fee=finite(market.roundTripFeePct,finite(config.roundTripFeePct,0.1));
  const fundingCost=finite(market.expectedFundingCostPct,funding===null?null:Math.abs(funding)*100*12);
  const slippage=spread===null||depth===null||oiChange===null||latency===null?null:
    clamp(spread*0.5+0.02/Math.max(depth/100000,0.1)+Math.max(0,latency-100)*0.00001+Math.abs(oiChange)*0.01,0,1);
  const snapshotAt=finite(market.snapshotAt);
  if(fee===null||fundingCost===null||slippage===null||snapshotAt===null||Date.now()-snapshotAt>finite(config.maxDataAgeMs,5*60*1000))
    return wait("EXECUTION_COST_INPUTS_STALE_OR_MISSING",{regime,flow});
  const agents={
    regime,
    structure:{structure_bias:structureBias,swingHigh,swingLow,support,resistance,validLongSLBelow:support,validShortSLAbove:resistance},
    continuation:{side:continuationSide,p:continuationSide?0.6:0.5,expectedR:null,volumeRatio,oiChange,fundingHot},
    breakout:{side:breakoutSide,p:breakoutSide?0.6:0.5,held:breakoutHeld,volumeRatio,extensionAtr:extension,spreadPct:spread},
    meanReversion:{side:revertSide,p:revertSide?0.55:0.5,vwap:vwapValue,deviationAtr:deviation,enabled:rangeRegime},
    flow,outcome:{dist_MAE:null,dist_MFE:null},fill:{est_slippage:slippage,spreadPct:spread,depthNotional:depth,latencyMs:latency}
  };
  const candidates=["LONG","SHORT"].map(side=>{
    const modelList=[
      {name:"continuation",type:"CONTINUATION",side:continuationSide,p:agents.continuation.p,weight:0.4},
      {name:"breakout",type:"BREAKOUT",side:breakoutSide,p:agents.breakout.p,weight:0.35},
      {name:"mean_reversion",type:"MEAN_REVERSION",side:revertSide,p:agents.meanReversion.p,weight:0.25}
    ].filter(m=>m.side===side);
    const applicable=[];
    for(const model of modelList){
      const setupKey=regime.regime+"_"+model.type;
      const samples=labeled.filter(o=>o.setupKey===setupKey&&String(o.side).toUpperCase()===side&&
        (o.source==="CLOSED_HISTORICAL_4H_SIMULATION"||String(o.symbol||"").toUpperCase()===String(symbol).toUpperCase()));
      if(samples.length<30) continue;
      const mae=percentile(samples.map(o=>Math.abs(Number(o.maePct))),0.8);
      const mfe50=percentile(samples.map(o=>Math.abs(Number(o.mfePct))),0.5);
      const mfe90=percentile(samples.map(o=>Math.abs(Number(o.mfePct))),0.9);
      if(!(mae>0&&mfe50>0&&mfe90>=mfe50)) continue;
      const wins=samples.filter(o=>o.win===true||(o.win==null&&Number(o.mfePct)>Number(o.maePct))).length;
      const p=clamp((wins+2)/(samples.length+4),0.01,0.99);
      const er=mfe50/mae;
      applicable.push({...model,setupKey,samples:samples.length,distMAE:{p80:mae,samples:samples.length},distMFE:{p50:mfe50,p90:mfe90,samples:samples.length},p,er});
    }
    const weightSum=applicable.reduce((s,m)=>s+m.weight,0);
    const p=weightSum?applicable.reduce((s,m)=>s+m.p*m.weight,0)/weightSum:0.5;
    const er=weightSum?applicable.reduce((s,m)=>s+m.er*m.weight,0)/weightSum:0;
    const distSource=applicable.slice().sort((a,b)=>b.weight-a.weight)[0]||null;
    const cost=distSource?(fee+fundingCost+slippage)/Math.max(distSource.distMAE.p80,1e-12):null;
    const uncertainty=(1-regime.regime_conf)*finite(config.uncertaintyPenalty,0.5);
    const track=market.trackRecord?.[regime.regime+"_"+side], trackSamples=finite(track?.samples,0), trackGrossR=finite(track?.meanGrossR);
    const expectedR=trackSamples>=20&&trackGrossR!==null?0.5*er+0.5*trackGrossR:er;
    const edge=distSource?p*expectedR-cost-uncertainty:null;
    return {side,p,expectedR,cost,uncertaintyPenalty:uncertainty,edge,applicableModels:applicable.map(m=>m.name),setupKey:distSource?.setupKey||null,distMAE:distSource?.distMAE||null,distMFE:distSource?.distMFE||null,samples:distSource?.samples||0};
  });
  const [long,short]=candidates;
  const minEdge=finite(config.minEdge,0.05), gapEdge=finite(config.gapEdge,0.1);
  let side="WAIT",reason="EDGE_BELOW_THRESHOLD";
  if(!["UPTREND","DOWNTREND"].includes(regime.regime)) reason="REGIME_NOT_TREND";
  else if(flow.confirmation==="BLOCKED_HOT_FUNDING"||flow.confirmation==="UNAVAILABLE") reason="FLOW_BLOCKED_OR_UNAVAILABLE";
  else if(!Number.isFinite(long.edge)||!Number.isFinite(short.edge)) reason="INSUFFICIENT_DIRECTIONAL_OUTCOME_DISTRIBUTION";
  else if(long.edge>minEdge&&long.edge-short.edge>gapEdge&&flow.confirmationSide==="LONG"&&
    (regime.regime!=="UPTREND"||structureBias!=="BEARISH")){side="LONG";reason="LONG_NET_EDGE_WINS";}
  else if(short.edge>minEdge&&short.edge-long.edge>gapEdge&&flow.confirmationSide==="SHORT"&&
    (regime.regime!=="DOWNTREND"||structureBias!=="BULLISH")){side="SHORT";reason="SHORT_NET_EDGE_WINS";}
  agents.continuation.expectedR=continuationSide==="LONG"?long.expectedR:continuationSide==="SHORT"?short.expectedR:null;
  agents.outcome={dist_MAE:side==="LONG"?long.distMAE:side==="SHORT"?short.distMAE:null,
    dist_MFE:side==="LONG"?long.distMFE:side==="SHORT"?short.distMFE:null,
    setupKey:side==="LONG"?long.setupKey:side==="SHORT"?short.setupKey:null,
    source:"CLOSED_HISTORICAL_4H_SIMULATION_AND_REALIZED_LABELS"};
  if(side==="WAIT") return wait(reason,{regime,agents,edges:{LONG:long,SHORT:short}});
  const chosen=side==="LONG"?long:short;
  const entry=last.close, stopDistance=chosen.distMAE.p80*entry/100, tp1Distance=chosen.distMFE.p50*entry/100, tp2Distance=chosen.distMFE.p90*entry/100;
  const sl=side==="LONG"?Math.min(entry-stopDistance,support-atr*0.1):Math.max(entry+stopDistance,resistance+atr*0.1);
  const tp1=side==="LONG"?entry+tp1Distance:entry-tp1Distance, tp2=side==="LONG"?entry+tp2Distance:entry-tp2Distance;
  if(!(stopDistance>0&&tp1Distance>0&&tp2Distance>=tp1Distance&&Number.isFinite(sl)&&Number.isFinite(tp1)&&Number.isFinite(tp2)))
    return wait("INVALID_OUTCOME_DERIVED_EXIT_PLAN",{regime,agents,edges:{LONG:long,SHORT:short}});
  return {symbol,side,action:side,authorizedForExecution:true,reason,setup:"NINE_AI_4H",signalAt:last.closeTime,
    entry,price:entry,sl,tp:tp2,tp1,tp2,closePercentAtTP1:50,timeoutCandles:24,timeframe:"4h",
    riskPerTradePct:0.0075,riskEquity:finite(equity,0)*0.0075,decisionPolicy:{minEdge,gapEdge},
    edges:{LONG:long,SHORT:short},regime,agents,setupKey:chosen.setupKey,
    featureSnapshot:{snapshotAt,closeTime:last.closeTime,close:entry,atr,atrPct,volumeRatio,funding,oiChange,spread,depth,latency,feePct:fee,fundingCostPct:fundingCost,estSlippagePct:slippage,regime,structureBias},
    tradePlan:{stopMethod:"LABELED_MAE_P80_WITH_STRUCTURE_BUFFER",targetMethod:"LABELED_MFE_P50_P90",tp1,tp2,closePercentAtTP1:50,timeoutCandles:24,timeoutMs:96*60*60*1000},
    candles:cs.length};
}
module.exports={percentile,closedCandles,swingPoints,classifyRegime,buildHistoricalOutcomeLabels,analyzeNineAI};
