"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {breakEvenTriggerPrice,hasReachedBreakEvenTrigger,moveStopToBreakeven}=require("./break-even");

test("80% trigger is calculated correctly for LONG and SHORT",()=>{
 assert.equal(breakEvenTriggerPrice({side:"LONG",entryPrice:100,tp1:110,progressPct:80}),108);
 assert.equal(breakEvenTriggerPrice({side:"SHORT",entryPrice:100,tp1:90,progressPct:80}),92);
 assert.equal(hasReachedBreakEvenTrigger({side:"LONG",entryPrice:100,tp1:110,markPrice:107.99,progressPct:80}),false);
 assert.equal(hasReachedBreakEvenTrigger({side:"LONG",entryPrice:100,tp1:110,markPrice:108,progressPct:80}),true);
 assert.equal(hasReachedBreakEvenTrigger({side:"SHORT",entryPrice:100,tp1:90,markPrice:92,progressPct:80}),true);
 assert.equal(hasReachedBreakEvenTrigger({side:"SHORT",entryPrice:100,tp1:90,markPrice:92.01,progressPct:80}),false);
});
test("invalid direction and progress are rejected",()=>{
 assert.throws(()=>breakEvenTriggerPrice({side:"LONG",entryPrice:100,tp1:90,progressPct:80}),/INVALID_BREAK_EVEN_TP1_SIDE/);
 assert.throws(()=>breakEvenTriggerPrice({side:"LONG",entryPrice:100,tp1:110,progressPct:0}),/INVALID_BREAK_EVEN_INPUT/);
 assert.throws(()=>breakEvenTriggerPrice({side:"LONG",entryPrice:100,tp1:110,progressPct:101}),/INVALID_BREAK_EVEN_INPUT/);
});
test("new entry stop is verified before old stop is cancelled and TP orders are untouched",async()=>{
 let orders=[
  {algoId:1,orderType:"STOP_MARKET",side:"SELL",closePosition:true,triggerPrice:"95"},
  {algoId:2,orderType:"TAKE_PROFIT_MARKET",side:"SELL",closePosition:false,triggerPrice:"110"}
 ];
 const calls=[];
 const request=async(method,path,params)=>{
  calls.push({method,path,params});
  if(method==="GET")return orders.filter(o=>o.orderType==="STOP_MARKET"||o.orderType==="TAKE_PROFIT_MARKET");
  if(method==="POST"){orders.push({algoId:3,orderType:"STOP_MARKET",side:params.side,closePosition:true,triggerPrice:params.triggerPrice});return{algoId:3};}
  if(method==="DELETE"){orders=orders.filter(o=>String(o.algoId)!==String(params.algoId));return{algoId:params.algoId};}
  throw Error("unexpected request");
 };
 const result=await moveStopToBreakeven({request,symbol:"BTCUSDT",side:"LONG",entryPrice:100,markPrice:108,tp1:110,progressPct:80});
 assert.equal(result.complete,true);
 assert.equal(result.algoId,3);
 assert.ok(calls.findIndex(c=>c.method==="POST")<calls.findIndex(c=>c.method==="DELETE"));
 assert.deepEqual(orders.filter(o=>o.orderType==="STOP_MARKET").map(o=>o.triggerPrice),["100"]);
 assert.equal(orders.some(o=>o.orderType==="TAKE_PROFIT_MARKET"),true);
});
test("restart retry reuses an existing entry stop and only removes the old stop",async()=>{
 let orders=[
  {algoId:1,orderType:"STOP_MARKET",side:"BUY",closePosition:true,triggerPrice:"105"},
  {algoId:2,orderType:"STOP_MARKET",side:"BUY",closePosition:true,triggerPrice:"100"}
 ];
 let creates=0;
 const request=async(method,path,params)=>{
  if(method==="GET")return orders;
  if(method==="POST"){creates++;throw Error("must not create duplicate");}
  if(method==="DELETE"){orders=orders.filter(o=>o.algoId!==params.algoId);return{};}
 };
 const result=await moveStopToBreakeven({request,symbol:"ETHUSDT",side:"SHORT",entryPrice:100,markPrice:92,tp1:90,progressPct:80});
 assert.equal(result.complete,true);
 assert.equal(creates,0);
 assert.deepEqual(orders.map(o=>o.algoId),[2]);
});
test("price before trigger does not touch exchange orders",async()=>{
 let calls=0;
 const result=await moveStopToBreakeven({request:async()=>{calls++;},symbol:"BTCUSDT",side:"LONG",entryPrice:100,markPrice:107,tp1:110,progressPct:80});
 assert.equal(result.triggered,false);
 assert.equal(calls,0);
});
