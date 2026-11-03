"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {calculateOrderSizing}=require("./simple-sizing");
const config={LEVERAGE:20,POSITION_MARGIN_PCT:0.1,RISK_PER_TRADE_PCT:0.01,MAX_POSITION_BALANCE_PCT:0.35};
const rules={stepSize:0.1,minQty:0.1,minNotional:5};

test("uses the configured percentage of total wallet balance as margin",()=>{
 const r=calculateOrderSizing({wallet:10,available:10,mark:1,rules,config});
 assert.equal(r.ok,true);
 assert.equal(r.targetMargin,1);
 assert.equal(r.qty,20);
 assert.equal(r.notional,20);
 assert.equal(r.margin,1);
});

test("open positions do not reduce sizing because available balance is not the sizing base",()=>{
 const first=calculateOrderSizing({wallet:10,available:9,mark:1,rules,config});
 const fifth=calculateOrderSizing({wallet:10,available:5,mark:1,rules,config});
 assert.equal(first.ok,true);
 assert.equal(fifth.ok,true);
 assert.equal(first.qty,20);
 assert.equal(fifth.qty,20);
 assert.equal(first.targetMargin,1);
 assert.equal(fifth.targetMargin,1);
});

test("recalculates the same percentage from the updated total wallet balance",()=>{
 const r=calculateOrderSizing({wallet:20,available:15,mark:1,rules,config});
 assert.equal(r.ok,true);
 assert.equal(r.targetMargin,2);
 assert.equal(r.qty,40);
 assert.equal(r.margin,2);
});

test("checks actual margin after step-size rounding, not the unrounded target",()=>{
 const r=calculateOrderSizing({
  wallet:10,
  available:0.8,
  mark:0.89,
  rules:{stepSize:1,minQty:1,minNotional:5},
  config:{...config,POSITION_MARGIN_PCT:0.08}
 });
 assert.equal(r.targetMargin,0.8);
 assert.equal(r.qty,17);
 assert.ok(Math.abs(r.margin-0.7565)<1e-12);
 assert.equal(r.ok,true);
 assert.equal(r.reason,"OK");
});

test("does not reduce order size when available balance cannot fund the full target margin",()=>{
 const r=calculateOrderSizing({wallet:10,available:0.8,mark:1,rules,config});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"MARGIN");
 assert.equal(r.targetMargin,1);
 assert.equal(r.qty,20);
});

test("ignores risk percentage, stop distance, and legacy position cap for sizing",()=>{
 const a=calculateOrderSizing({wallet:10,available:10,mark:1,rules,config});
 const b=calculateOrderSizing({wallet:10,available:10,mark:1,rules,config:{...config,RISK_PER_TRADE_PCT:0.9,MAX_POSITION_BALANCE_PCT:0.01}});
 assert.equal(a.ok,true);
 assert.equal(b.ok,true);
 assert.equal(a.qty,b.qty);
 assert.equal(a.margin,b.margin);
});

test("floors to exchange step size without exceeding target margin",()=>{
 const r=calculateOrderSizing({wallet:10,available:10,mark:3,rules,config});
 assert.equal(r.ok,true);
 assert.equal(r.qty,6.6);
 assert.ok(r.margin<=r.targetMargin);
});

test("rejects minimum notional when the configured margin cannot reach it",()=>{
 const fineRules={stepSize:0.0001,minQty:0.0001,minNotional:5};
 const r=calculateOrderSizing({wallet:10,available:10,mark:100,rules:fineRules,config:{...config,POSITION_MARGIN_PCT:0.01}});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"MIN_NOTIONAL");
});

test("rejects invalid or missing sizing inputs",()=>{
 const r=calculateOrderSizing({wallet:10,available:10,mark:0,rules,config});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"INVALID_SIZING_INPUT");
});
