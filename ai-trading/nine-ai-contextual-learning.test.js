"use strict";
const assert = require("node:assert/strict");
const learning = require("./nine-ai-contextual-learning");
function makeDb() {
 const docs = new Map();
 return { collection() { return {
  async createIndex() {},
  find(q = {}) { let a = [...docs.values()].filter(d => !q.closed || d.closed === q.closed); return { sort() { a.sort((x,y) => new Date(y.closedAt)-new Date(x.closedAt)); return this; }, limit(n) { a=a.slice(0,n); return this; }, async toArray() { return a; } }; },
  async insertOne(d) { if(docs.has(d.tradeId)){const e=new Error("duplicate");e.code=11000;throw e;} docs.set(d.tradeId,{...d});return {insertedId:d.tradeId}; }
 }; } };
}
(async()=>{
 const db=makeDb(); await learning.initialize(db);
 const f={rsi:74,rsi14:74,extension:1.8,extensionAtr:1.8,momentum:2,momentum4:2,volume:1.2,volumeRatio:1.2,falseBreakoutRisk:0.2,longEntryQuality:72,shortEntryQuality:35,marketRegime:"TREND_UP",breakoutStrength:0.2};
 assert.ok(learning.contextTags(f).includes("MOMENTUM_EXHAUSTION"));
 for(let i=0;i<8;i++) await learning.recordClosedTrade({tradeId:"L"+i,side:"LONG",features:f,realizedR:-1,closed:true});
 const a=learning.assess(f); assert.equal(a.LONG.ready,true); assert.ok(a.LONG.meanR<0); assert.ok(a.LONG.edge<0);
 const d=await learning.recordClosedTrade({tradeId:"L0",side:"LONG",features:f,realizedR:1,closed:true}); assert.equal(d.reason,"DUPLICATE_TRADE");
 for(let i=0;i<8;i++) await learning.recordClosedTrade({tradeId:"S"+i,side:"SHORT",features:f,realizedR:0.5,closed:true});
 assert.ok(learning.assess(f).SHORT.meanR>0); assert.equal(learning.status().samples,16);
 console.log("nine-ai-contextual-learning.test.js: OK");
})().catch(e=>{console.error(e);process.exitCode=1;});
