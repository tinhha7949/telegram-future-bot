"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG } = require("./config");
const { fixture } = require("./test-fixtures.cjs");
const { analyzeNineAI } = require("./nine-ai-pipeline");
const { sizeTrade } = require("./binance-execution");
const { newTrade, hydrateFill } = require("./trade-lifecycle");
const info = { filters: [
  { filterType: "LOT_SIZE", stepSize: ".001", minQty: ".001", maxQty: "100000" },
  { filterType: "MARKET_LOT_SIZE", stepSize: ".001", minQty: ".001", maxQty: "100000" },
  { filterType: "PRICE_FILTER", tickSize: ".01" },
  { filterType: "MIN_NOTIONAL", notional: "5" },
] };
for(const side of ["LONG","SHORT"]) test(side+" AI7 floors low MFE to MIN_RR even after slipped fill",()=>{
  const f=fixture(side);
  const outcomes=Array.from({length:CONFIG.AI7_ACTIVATION_SAMPLES},(_,i)=>({
    ...f.outcomes[0],tradeId:"rr-floor-"+side+i,maePct:2,mfePct:0.2,win:true,
  }));
  const d=analyzeNineAI({...f,outcomes}),sign=side==="LONG"?1:-1;
  assert.equal(d.action,side);
  assert.equal(d.tradePlan.outcomeMode,"AI7_LABELED");
  assert.ok(Math.abs(d.tp1-d.entry)/Math.abs(d.entry-d.sl)>=CONFIG.MIN_RR-1e-12);
  const sized=sizeTrade(d,10000,CONFIG.RISK_PER_TRADE,info);
  assert.ok(sized,"tick rounding must not erase MIN_RR");
  const t=newTrade(d,sized,f.market.now),fill=d.entry*(1+sign*0.0001);
  hydrateFill(t,{orderId:1,executedQty:String(sized.quantity),
    avgPrice:String(fill),time:f.market.now,status:"FILLED"});
  assert.ok(Math.abs(t.tp1-t.entry)+1e-10>=CONFIG.MIN_RR*Math.abs(t.entry-t.sl));
  assert.ok(sign*(t.tp2-t.tp1)>=-1e-10);
  assert.ok(Math.abs(t.entryExecution.rawQuantileTP1-fill*(1+sign*0.002))<1e-10);
});

test("AI7 ignores opposite-side excursion labels even after cold start",()=>{
  const f=fixture("LONG"),setup=f.outcomes[0];
  const longs=Array.from({length:CONFIG.AI7_ACTIVATION_SAMPLES},(_,i)=>({
    ...setup,tradeId:"own-long-"+i,side:"LONG",maePct:1,mfePct:3,win:true,
  }));
  const shorts=Array.from({length:CONFIG.AI7_ACTIVATION_SAMPLES},(_,i)=>({
    ...setup,tradeId:"opposite-short-"+i,side:"SHORT",maePct:99,mfePct:99,win:true,
  }));
  const result=analyzeNineAI({...f,outcomes:[...longs,...shorts]});
  assert.equal(result.action,"LONG");
  assert.equal(result.agents.outcome.dist_MAE.samples,CONFIG.AI7_ACTIVATION_SAMPLES);
  assert.equal(result.agents.outcome.dist_MAE.p80,1);
  assert.equal(result.agents.outcome.dist_MFE.p50,3);
});
