"use strict";

// Closed-loop deployment for counterfactual entry research.
// Research variants are promoted only after paired chronological holdout validation.
// Live results are monitored separately; degrading policies are automatically rolled back.
// This module never changes exchange SL/TP geometry, leverage, or position sizing.
const OUTCOMES = "nine_ai_counterfactual_outcomes";
const POLICIES = "nine_ai_timing_deployment_policies";
const MIN_TRAIN = 30;
const MIN_TEST = 15;
const MIN_UPLIFT_R = 0.10;
const MAX_RANK_ADJUSTMENT = 4;
const MIN_LIVE_MATCHED = 12;
const MIN_LIVE_CONTROL = 12;
const ROLLBACK_UPLIFT_R = -0.05;
const ALLOWED = new Set(["EARLIER_1_BAR", "EARLIER_2_BAR", "DELAY_1_BAR", "DELAY_2_BAR", "OPPOSITE_SIDE"]);
let outcomes = null;
let policies = null;
let active = [];
let running = false;

const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const se = xs => {
  if (!xs.length) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s,v)=>s+(v-m)**2,0)/xs.length/xs.length);
};

function evaluateVariant(rows, variant, side, regime) {
  const grouped = new Map();
  for (const r of rows) {
    if (r.variant !== variant || r.originalSide !== side || String(r.regime || "UNKNOWN") !== regime) continue;
    if (!r.tradeId || n(r.netR) === null) continue;
    if (!grouped.has(String(r.tradeId))) grouped.set(String(r.tradeId), []);
    grouped.get(String(r.tradeId)).push(r);
  }
  const unique = [...grouped.values()].map(xs => xs.sort((a,b)=>new Date(a.closedAt)-new Date(b.closedAt))[0])
    .sort((a,b)=>new Date(a.closedAt)-new Date(b.closedAt));
  const baselineById = new Map(rows.filter(r=>r.variant==="BASELINE" && r.originalSide===side &&
    String(r.regime || "UNKNOWN")===regime).map(r=>[String(r.tradeId),n(r.netR)]));
  const pairs = unique.filter(r=>baselineById.has(String(r.tradeId)) && baselineById.get(String(r.tradeId))!==null)
    .map(r=>({at:new Date(r.closedAt || 0).getTime(), candidate:n(r.netR), baseline:baselineById.get(String(r.tradeId))}))
    .filter(p=>p.candidate!==null);
  const split = Math.floor(pairs.length*0.7);
  const train = pairs.slice(0,split), test = pairs.slice(split);
  const trainUplifts = train.map(p=>p.candidate-p.baseline);
  const testUplifts = test.map(p=>p.candidate-p.baseline);
  const testMean = mean(test.map(p=>p.candidate));
  const uplift = mean(testUplifts);
  const uncertainty = se(testUplifts);
  const baselineMean = mean(test.map(p=>p.baseline));
  const validated = train.length>=MIN_TRAIN && test.length>=MIN_TEST &&
    mean(trainUplifts)>0 && uplift!==null && uplift>=MIN_UPLIFT_R &&
    uncertainty!==null && uplift>1.96*uncertainty &&
    testMean!==null && testMean>0;
  return {variant,side,regime,samples:pairs.length,trainSamples:train.length,testSamples:test.length,
    testUpliftR: uplift===null?null:Number(uplift.toFixed(4)),
    testMeanR:testMean===null?null:Number(testMean.toFixed(4)),
    baselineMeanR:baselineMean===null?null:Number(baselineMean.toFixed(4)),
    standardError:uncertainty===null?null:Number(uncertainty.toFixed(4)),validated};
}

async function initialize(db) {
  if (!db || typeof db.collection!=="function") throw new Error("NINE_AI_AUTONOMOUS_DEPLOYMENT_MONGODB_REQUIRED");
  outcomes=db.collection(OUTCOMES);
  policies=db.collection(POLICIES);
  await policies.createIndex({policyId:1},{unique:true,name:"uniq_nine_ai_timing_deployment_policy"});
  await policies.createIndex({status:1,updatedAt:-1},{name:"nine_ai_timing_deployment_status"});
  active=await policies.find({status:"ACTIVE"}).sort({updatedAt:-1}).toArray();
  return status();
}

async function runResearchCycle({now=new Date()}={}) {
  if (!outcomes || !policies) throw new Error("NINE_AI_AUTONOMOUS_DEPLOYMENT_NOT_INITIALIZED");
  if (running) return {status:"SKIPPED",reason:"CYCLE_ALREADY_RUNNING"};
  running=true;
  try {
    const rows=await outcomes.find({variant:{$in:[...ALLOWED,"BASELINE"]}}).sort({closedAt:1}).limit(15000).toArray();
    const regimes=new Set(rows.map(r=>String(r.regime||"UNKNOWN")));
    const sides=new Set(rows.map(r=>String(r.originalSide||r.side)).filter(s=>["LONG","SHORT"].includes(s)));
    const candidates=[];
    for (const regime of regimes) for (const side of sides) for (const variant of ALLOWED) {
      const result=evaluateVariant(rows,variant,side,regime);
      if (result.validated) candidates.push({...result,policyId:variant+":"+side+":"+regime,
        status:"ACTIVE",promotedAt:new Date(now),updatedAt:new Date(now),
        deploymentMode:"BOUNDED_LIVE_RANKING_EVIDENCE",
        source:"PAIRED_ACTUAL_BASELINE_VS_COUNTERFACTUAL_OUT_OF_SAMPLE"});
    }
    const validIds=new Set(candidates.map(p=>p.policyId));
    const current=await policies.find({status:"ACTIVE"}).toArray();
    for (const p of current) {
      if (!validIds.has(p.policyId)) await policies.updateOne({_id:p._id},{$set:{status:"ROLLED_BACK",
        deactivatedAt:new Date(now),deactivationReason:"NO_LONGER_PASSES_CHRONOLOGICAL_OUT_OF_SAMPLE_VALIDATION",updatedAt:new Date(now)}});
    }
    for (const p of candidates) await policies.updateOne({policyId:p.policyId},{$set:p},{upsert:true});
    // Roll back policies whose attributed live results are materially worse than controls.
    const activeRows=await policies.find({status:"ACTIVE"}).toArray();
    for (const p of activeRows) {
      const live=await outcomes.find({deploymentPolicyId:p.policyId,liveOutcome:true}).sort({closedAt:1}).limit(500).toArray();
      const matched=live.map(r=>n(r.netR)).filter(v=>v!==null);
      const controls=live.map(r=>n(r.controlNetR)).filter(v=>v!==null);
      if (matched.length>=MIN_LIVE_MATCHED && controls.length>=MIN_LIVE_CONTROL) {
        const uplift=mean(matched)-mean(controls);
        if (uplift<ROLLBACK_UPLIFT_R) await policies.updateOne({policyId:p.policyId,status:"ACTIVE"},
          {$set:{status:"ROLLED_BACK",deactivatedAt:new Date(now),deactivationReason:"LIVE_ATTRIBUTED_PERFORMANCE_DEGRADED",
            liveMatchedSamples:matched.length,liveControlSamples:controls.length,liveUpliftR:Number(uplift.toFixed(4)),updatedAt:new Date(now)}});
      }
    }
    active=await policies.find({status:"ACTIVE"}).sort({updatedAt:-1}).toArray();
    return {status:"COMPLETED",rows:rows.length,candidates:candidates.length,activePolicies:active.length};
  } finally { running=false; }
}

function assess(features={}, side) {
  const wanted=String(side||"").toUpperCase();
  const regime=String(features.marketRegime||features.regime||"UNKNOWN").toUpperCase();
  const matching=active.filter(p=>p.status==="ACTIVE" && p.side===wanted && (p.regime===regime || p.regime==="UNKNOWN"));
  if (!matching.length) return {adjustment:0,policy:null,reason:"NO_VALIDATED_TIMING_POLICY"};
  matching.sort((a,b)=>(Number(b.testUpliftR)||0)-(Number(a.testUpliftR)||0));
  const p=matching[0];
  const confidence=Math.max(0,Math.min(1,(Number(p.testUpliftR)||0)/0.5));
  const adjustment=Number((Math.min(MAX_RANK_ADJUSTMENT,Math.max(0,Number(p.testUpliftR)*8))*confidence).toFixed(2));
  return {adjustment,policy:{policyId:p.policyId,variant:p.variant,side:p.side,regime:p.regime,
    testUpliftR:p.testUpliftR,testMeanR:p.testMeanR,testSamples:p.testSamples},
    reason:"VALIDATED_COUNTERFACTUAL_POLICY_ACTIVE"};
}
function status() {
  return {initialized:Boolean(outcomes&&policies),activePolicies:active.length,
    policies:active.map(p=>({policyId:p.policyId,variant:p.variant,side:p.side,regime:p.regime,
      testUpliftR:p.testUpliftR,testMeanR:p.testMeanR,testSamples:p.testSamples}))};
}
module.exports={ALLOWED,MIN_TRAIN,MIN_TEST,MIN_UPLIFT_R,evaluateVariant,initialize,runResearchCycle,assess,status};
