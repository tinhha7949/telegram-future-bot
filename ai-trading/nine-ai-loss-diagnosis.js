"use strict";
const MAX=5000,TRAIN=30,TEST=15,UPLIFT=.1,MEAN=.05;
let diagnoses=null,reports=null,variants=null,running=false;
const n=(v,d=NaN)=>v==null||v===""?d:Number.isFinite(Number(v))?Number(v):d;
const up=v=>String(v??"UNKNOWN").toUpperCase();
function diagnoseTrade(t={}){
 const f=t.features||{},c=t.context||{},side=up(t.side),regime=up(f.marketRegime||c.marketRegime||t.regime),trend=up(f.trend||c.trend);
 const rsi=n(f.rsi14??f.rsi,50),ext=Math.abs(n(f.extensionAtr??f.extension,0)),mom=n(f.momentum4??f.momentum,0),vol=n(f.volumeRatio??f.volume,1),fb=n(f.falseBreakoutRisk,0);
 const lq=n(f.longEntryQuality,50),sq=n(f.shortEntryQuality,50),eq=n(c.entryQuality??f.entryQuality,side==="LONG"?lq:sq),causes=[];
 const add=(code,confidence,evidence,alternative)=>causes.push({code,confidence,evidence,alternative});
 if(ext>=1.5&&((side==="LONG"&&rsi>=65&&mom>0)||(side==="SHORT"&&rsi<=35&&mom<0)))add("POSSIBLE_LATE_MOMENTUM_ENTRY",.72,{ext,rsi,mom},"Test earlier causal entry and pullback; never reverse automatically.");
 if((side==="LONG"&&(mom<0||trend==="DOWN"||regime==="TREND_DOWN"))||(side==="SHORT"&&(mom>0||trend==="UP"||regime==="TREND_UP")))add("DIRECTION_TREND_MISMATCH",.68,{side,trend,regime,mom},"Compare independently valid trend and reversal setups.");
 if(fb>=.5)add("FALSE_BREAKOUT_RISK",.7,{fb,vol},"Test breakout confirmation and retest out of sample.");
 if(vol<.75)add("LOW_VOLUME_CONFIRMATION",.62,{vol},"Test low-volume exclusion out of sample.");
 if(eq<50)add("WEAK_ENTRY_QUALITY",.6,{eq,lq,sq},"Test stricter entry-quality thresholds.");
 if((side==="LONG"&&rsi>=72)||(side==="SHORT"&&rsi<=28))add("RSI_EXTREME_AGAINST_ENTRY",.6,{rsi,side},"Test pullback or exhaustion-aware entry timing.");
 const entry=n(t.entry),sl=n(t.sl),tp=n(t.tp),risk=Math.abs(entry-sl),rr=risk>0?Math.abs(tp-entry)/risk:NaN;
 if([entry,sl,tp].every(Number.isFinite)&&entry>0&&Number.isFinite(rr)&&rr<1)add("LOW_REWARD_TO_RISK",.85,{rr,entry,sl,tp},"Test bounded SL/TP alternatives without weakening hard risk guards.");
 if(!causes.length)add("NO_SINGLE_FEATURE_CAUSE_IDENTIFIED",.25,{regime,trend,rsi,ext,mom,vol,fb,eq},"Gather more context; a single cause is not established.");
 causes.sort((a,b)=>b.confidence-a.confidence);const r=n(t.realizedR,0);
 return {tradeId:String(t.tradeId||""),symbol:String(t.symbol||""),side,realizedR:r,outcome:r>0?"WIN":r<0?"LOSS":"BREAKEVEN",regime,tags:causes.map(x=>x.code),causes,featuresSnapshot:{rsi,ext,mom,vol,fb,eq,trend,regime},diagnosedAt:new Date()};
}
function evaluateVariantGroup(rows,variant,baselines){
 const seen=new Set(),a=[];for(const r of rows.slice().sort((x,y)=>n(x.closedAt,0)-n(y.closedAt,0))){const id=String(r.tradeId);if(!id||seen.has(id)||!baselines.has(id))continue;seen.add(id);a.push({...r,baseR:n(baselines.get(id).netR,0)});}
 const split=Math.floor(a.length*.7),tr=a.slice(0,split),te=a.slice(split),uplift=x=>x.length?x.reduce((s,r)=>s+n(r.netR,0)-r.baseR,0)/x.length:0;
 const trainUpliftR=uplift(tr),testUpliftR=uplift(te),testMeanR=te.length?te.reduce((s,r)=>s+n(r.netR,0),0)/te.length:0,ok=tr.length>=TRAIN&&te.length>=TEST&&trainUpliftR>=0&&testUpliftR>=UPLIFT&&testMeanR>=MEAN;
 return {variant,trainSamples:tr.length,testSamples:te.length,trainUpliftR:+trainUpliftR.toFixed(4),testUpliftR:+testUpliftR.toFixed(4),testMeanR,status:ok?"VALIDATED_CANDIDATE":a.length<TRAIN+TEST?"INSUFFICIENT_SAMPLE":"REJECTED",promotionEligible:ok,note:"Simulated OHLC, not actual PnL; costs and intrabar order are approximate."};
}
async function initialize(db){
 if(!db||typeof db.collection!=="function")throw Error("NINE_AI_LAB_MONGODB_REQUIRED");
 diagnoses=db.collection("nine_ai_loss_diagnoses");reports=db.collection("nine_ai_strategy_lab_reports");variants=db.collection("nine_ai_counterfactual_outcomes");
 await diagnoses.createIndex({tradeId:1},{unique:true,name:"uniq_nine_ai_loss_diagnosis_trade"});await diagnoses.createIndex({diagnosedAt:-1},{name:"nine_ai_diagnosis_recent"});await reports.createIndex({createdAt:-1},{name:"nine_ai_strategy_lab_recent"});
 return {ready:true};
}
async function recordClosedTrade(t){
 if(!diagnoses)throw Error("NINE_AI_LAB_NOT_INITIALIZED");if(!t||!t.tradeId||!["LONG","SHORT"].includes(up(t.side))||!Number.isFinite(Number(t.realizedR)))throw Error("CLOSED_TRADE_WITH_REALIZED_R_REQUIRED");
 const d=diagnoseTrade(t);try{await diagnoses.updateOne({tradeId:d.tradeId},{$setOnInsert:d},{upsert:true});return {recorded:true,diagnosis:d};}catch(e){if(e?.code===11000)return {recorded:false,reason:"DUPLICATE_TRADE",diagnosis:d};throw e;}
}
async function runResearchCycle({now=new Date()}={}){
 if(!diagnoses||!reports||!variants)throw Error("NINE_AI_LAB_NOT_INITIALIZED");if(running)return {status:"SKIPPED"};running=true;
 try{
 const [ds,vs]=await Promise.all([diagnoses.find({}).sort({diagnosedAt:-1}).limit(MAX).toArray(),variants.find({}).sort({closedAt:-1}).limit(MAX*8).toArray()]);
 const base=new Map(vs.filter(x=>x.variant==="BASELINE").map(x=>[String(x.tradeId),x])),losses=ds.filter(x=>x.outcome==="LOSS"),groups=new Map();
 for(const d of ds)for(const c of d.causes||[]){if(!groups.has(c.code))groups.set(c.code,[]);groups.get(c.code).push(d);}
 const hypotheses=[];
 for(const [cause,affected] of groups){const bad=affected.filter(x=>x.outcome==="LOSS");if(!bad.length)continue;const ids=new Set(bad.map(x=>String(x.tradeId))),matched=vs.filter(x=>ids.has(String(x.tradeId))&&x.variant!=="BASELINE"&&base.has(String(x.tradeId))),by=new Map();
 for(const v of matched){if(!by.has(v.variant))by.set(v.variant,[]);by.get(v.variant).push(v);}
 const alternatives=Array.from(by,([name,rows])=>evaluateVariantGroup(rows,name,base)),best=alternatives.filter(x=>x.promotionEligible).sort((a,b)=>b.testUpliftR-a.testUpliftR)[0]||null,s=affected[0],detail=(s.causes||[]).find(x=>x.code===cause);
 hypotheses.push({hypothesisId:cause+":"+up(s.regime),cause,regime:up(s.regime),affectedTrades:affected.length,lossTrades:bad.length,lossRate:bad.length/affected.length,evidence:detail?.evidence||{},proposedChange:detail?.alternative||"Collect more evidence.",alternatives,bestValidatedAlternative:best,status:best?"VALIDATED_CANDIDATE":alternatives.length?"TESTING_OR_REJECTED":"NEEDS_COUNTERFACTUAL_DATA"});}
 hypotheses.sort((a,b)=>b.lossTrades-a.lossTrades);await reports.insertOne({createdAt:new Date(now),status:"COMPLETED",closedTradesAnalyzed:ds.length,lossesAnalyzed:losses.length,hypotheses,safety:{automaticExecution:false,note:"Never bypasses Nine-AI authorization or hard risk guards."}});
 return {status:"COMPLETED",closedTradesAnalyzed:ds.length,lossesAnalyzed:losses.length,hypotheses:hypotheses.length,validatedCandidates:hypotheses.filter(x=>x.bestValidatedAlternative).length};
 }finally{running=false;}
}
module.exports={diagnoseTrade,evaluateVariantGroup,initialize,recordClosedTrade,runResearchCycle};
