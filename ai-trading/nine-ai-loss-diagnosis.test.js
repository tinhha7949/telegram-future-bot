"use strict";
const assert=require("node:assert/strict"),lab=require("./nine-ai-loss-diagnosis");
const d=lab.diagnoseTrade({tradeId:"x",side:"LONG",realizedR:-1,features:{rsi14:75,extensionAtr:1.8,momentum4:.8,longEntryQuality:45,trend:"UP",marketRegime:"TREND_UP"},context:{entryQuality:45},entry:100,sl:98,tp:101});
assert.equal(d.outcome,"LOSS");assert.ok(d.tags.includes("POSSIBLE_LATE_MOMENTUM_ENTRY"));assert.ok(d.tags.includes("WEAK_ENTRY_QUALITY"));assert.ok(d.tags.includes("LOW_REWARD_TO_RISK"));assert.ok(d.causes.every(x=>x.evidence&&x.alternative));
assert.ok(lab.diagnoseTrade({tradeId:"y",side:"LONG",realizedR:-1,features:{momentum4:-.5,trend:"DOWN",marketRegime:"TREND_DOWN"}}).tags.includes("DIRECTION_TREND_MISMATCH"));
assert.deepEqual(lab.diagnoseTrade({tradeId:"z",side:"SHORT",realizedR:-1,features:{}}).tags,["NO_SINGLE_FEATURE_CAUSE_IDENTIFIED"]);
const base=new Map(),rows=[];for(let i=0;i<50;i++){const tradeId="t"+i;base.set(tradeId,{netR:-.2});rows.push({tradeId,netR:.3,closedAt:i});}
const ev=lab.evaluateVariantGroup(rows,"DELAY_1_BAR",base);assert.equal(ev.status,"VALIDATED_CANDIDATE");assert.equal(ev.testSamples,15);assert.ok(ev.testUpliftR>=.1);assert.equal(lab.evaluateVariantGroup(rows.slice(0,20),"DELAY_1_BAR",base).promotionEligible,false);
console.log("nine-ai-loss-diagnosis.test.js: OK");
