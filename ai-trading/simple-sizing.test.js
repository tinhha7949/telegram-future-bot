"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {sizePosition}=require("./simple-sizing");

test("raises a floored quantity to the smallest lot meeting min notional when caps allow",()=>{
  const r=sizePosition({riskBudget:1,stopDistance:0.2,maxNotional:5.6,price:1,stepSize:0.1,minQty:0.1,minNotional:5});
  assert.equal(r.ok,true);
  assert.equal(r.qty,5);
  assert.equal(r.notional,5);
});
test("does not raise quantity beyond the configured position cap",()=>{
  const r=sizePosition({riskBudget:10,stopDistance:0.1,maxNotional:4.99,price:1,stepSize:0.1,minQty:0.1,minNotional:5});
  assert.equal(r.ok,false);
  assert.equal(r.reason,"MIN_NOTIONAL_ABOVE_RISK_OR_POSITION_CAP");
});
test("does not raise quantity beyond the risk budget",()=>{
  const r=sizePosition({riskBudget:0.49,stopDistance:0.1,maxNotional:10,price:1,stepSize:0.1,minQty:0.1,minNotional:5});
  assert.equal(r.ok,false);
  assert.equal(r.reason,"MIN_NOTIONAL_ABOVE_RISK_OR_POSITION_CAP");
});
test("keeps existing floor sizing when the minimum is already met",()=>{
  const r=sizePosition({riskBudget:1,maxNotional:10,stopDistance:0.1,price:1,stepSize:0.1,minQty:0.1,minNotional:5});
  assert.equal(r.ok,true);
  assert.equal(r.qty,10);
});
test("rejects invalid sizing inputs",()=>{
  const r=sizePosition({riskBudget:1,stopDistance:0,maxNotional:10,price:1,stepSize:0.1,minQty:0.1,minNotional:5});
  assert.equal(r.ok,false);
  assert.equal(r.reason,"INVALID_SIZING_INPUT");
});
