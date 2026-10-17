"use strict";
const assert = require("node:assert/strict");
const research = require("./nine-ai-counterfactual-research");
const candles = [
  [0,100,101,99,100,10,899999],
  [900000,100,102,99,101,12,1799999],
  [1800000,101,103,100,102,13,2699999],
  [2700000,102,104,101,103,14,3599999],
  [3600000,103,104,98,99,15,4499999],
];
const baseline = research.simulate({candles,entryIndex:1,side:"LONG",entry:100,sl:98,tp:103,risk:2});
assert.equal(baseline.valid,true);
assert.equal(baseline.exit,"TP");
const conservative = research.simulate({candles:[[0,100,103,97,100,1,899999]],entryIndex:0,side:"LONG",entry:100,sl:98,tp:102,risk:2});
assert.equal(conservative.valid,true);
assert.equal(conservative.exit,"SL"); // both SL and TP touched, assume stop first
const variants = research.buildVariants({tradeId:"t1",side:"LONG",entry:100,sl:98,tp:104,entryTime:900000,realizedR:-1},candles);
assert.ok(variants.some(v=>v.variant==="BASELINE"));
assert.ok(variants.some(v=>v.variant==="OPPOSITE_SIDE"&&v.side==="SHORT"));
assert.ok(variants.some(v=>v.variant==="DELAY_1_BAR"));
const rows=[];
for(let i=0;i<50;i++){
  const id="trade-"+i;
  const date=Date.UTC(2025,0,1)+i*86400000;
  rows.push({tradeId:id,variant:"BASELINE",side:"LONG",regime:"TREND_UP",netR:-0.1,closedAt:date});
  rows.push({tradeId:id,variant:"DELAY_1_BAR",side:"LONG",regime:"TREND_UP",netR:0.25,closedAt:date});
}
const candidates=research.evaluatePolicy(rows);
assert.ok(candidates.some(p=>p.variant==="DELAY_1_BAR"&&p.testSamples>=15&&p.testUpliftR>=0.1));
console.log("nine-ai-counterfactual-research.test.js: OK");
