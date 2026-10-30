"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {calculateOrderSizing}=require("./simple-sizing");
const config={LEVERAGE:20,RISK_PER_TRADE_PCT:0.1,MAX_POSITION_BALANCE_PCT:0.35};
const rules={stepSize:0.1,minQty:0.1,minNotional:5};
test("20x permits a 5 USDT notional position with 0.25 USDT margin",()=>{
 const r=calculateOrderSizing({wallet:8,available:8,mark:1,stopDistance:0.16,rules,config});
 assert.equal(r.ok,true);assert.equal(r.qty,5);assert.equal(r.notional,5);assert.equal(r.margin,0.25);
});
test("uses one floored quantity for notional and margin checks",()=>{
 const r=calculateOrderSizing({wallet:8,available:8,mark:10,stopDistance:0.2,rules,config});
 assert.equal(r.ok,true);assert.equal(r.qty,4);assert.equal(r.notional,40);assert.equal(r.margin,2); 
});
test("rejects minimum notional when risk or position cap cannot reach it",()=>{
 const r=calculateOrderSizing({wallet:8,available:8,mark:10,stopDistance:1.6326530612244898,rules,config});
 assert.equal(r.ok,false);assert.equal(r.reason,"MIN_NOTIONAL");
});
test("rejects invalid or missing sizing inputs",()=>{
 const r=calculateOrderSizing({wallet:8,available:8,mark:0,stopDistance:1,rules,config});
 assert.equal(r.ok,false);assert.equal(r.reason,"INVALID_SIZING_INPUT");
});
