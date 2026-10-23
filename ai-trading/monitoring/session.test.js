"use strict";
const {test}=require("node:test"), assert=require("node:assert/strict");
const {memoryDb}=require("../test-fixtures.cjs");
const {sessionReport,formatSessionReport}=require("./session");
const {CONFIG}=require("../config");
const { RUN_RISK_ID } = require("../risk/day-guard");
test("UTC session metrics use realized net R/fees/funding and durable high-water DD",async()=>{
 const db=memoryDb(),now=Date.UTC(2026,9,23,12),wait={store:db.collection("nine_ai_wait_rate_decisions")};
 await db.collection("trades").insertOne({result:"WIN",closedAt:now-1000,realizedR:0.5,feesUSDT:0.6,fundingUSDT:-0.1});
 await db.collection("trades").insertOne({result:"LOSS",closedAt:now-2000,realizedR:-1,feesUSDT:0.6,fundingUSDT:0.2});
 await wait.store.insertOne({at:now-1,action:"WAIT"});
 await wait.store.insertOne({at:now-2,action:"LONG"});
 await db.collection("nine_ai_global_risk").insertOne({_id:"GLOBAL",maxDrawdown:0.992});
 await db.collection("nine_ai_global_risk").insertOne({_id:RUN_RISK_ID,maxDrawdown:0.08,halted:false});
 const s=await sessionReport(db,wait,{now:()=>now});
 assert.equal(s.complete,true);assert.equal(s.trades,2);
 assert.equal(s.winrate,0.5);assert.equal(s.meanNetR,-0.25);
 assert.equal(s.feesUSDT,1.2);assert.ok(Math.abs(s.fundingUSDT-0.1)<1e-10);
 assert.equal(s.waitRatio,0.5);assert.equal(s.maxDrawdown,0.08);
 assert.deepEqual(s.alerts,["WAIT_RATIO_TOO_LOW"]);
 assert.match(formatSessionReport(s),/ALERTS=WAIT_RATIO_TOO_LOW/);
});
test("incomplete fee ledger never reports a made-up net E[R]",async()=>{
 const db=memoryDb(),now=Date.UTC(2026,9,23,12),wait={store:db.collection("nine_ai_wait_rate_decisions")};
 await db.collection("trades").insertOne({result:"WIN",closedAt:now-1000,realizedR:0.5});
 const s=await sessionReport(db,wait,{now:()=>now});
 assert.equal(s.complete,false);assert.equal(s.meanNetR,null);assert.equal(s.feesUSDT,null);
 assert.match(formatSessionReport(s),/INCOMPLETE:INCOMPLETE_TRADE_ACCOUNTING/);
});
test("bounded ledger truncation marks report incomplete",async()=>{
 const db=memoryDb(),now=Date.UTC(2026,9,23,12),wait={store:db.collection("nine_ai_wait_rate_decisions")};
 await wait.store.insertOne({at:now-1,action:"LONG"});
 await wait.store.insertOne({at:now-2,action:"WAIT"});
 const s=await sessionReport(db,wait,{now:()=>now,config:{...CONFIG,SESSION_REPORT_MAX_WAIT_RECORDS:1}});
 assert.equal(s.complete,false);assert.equal(s.reason,"LEDGER_TRUNCATED");
});
