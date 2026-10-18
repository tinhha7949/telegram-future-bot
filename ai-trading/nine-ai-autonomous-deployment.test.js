"use strict";
const assert=require("node:assert/strict");
const deployment=require("./nine-ai-autonomous-deployment");
const rows=[];
for(let i=0;i<100;i++){
  const closedAt=new Date(1700000000000+i*86400000);
  const tradeId="t"+i;
  rows.push({tradeId,variant:"BASELINE",originalSide:"LONG",side:"LONG",regime:"TREND_UP",netR:0.05,closedAt});
  rows.push({tradeId,variant:"EARLIER_1_BAR",originalSide:"LONG",side:"LONG",regime:"TREND_UP",netR:0.5,closedAt});
  rows.push({tradeId,variant:"DELAY_1_BAR",originalSide:"LONG",side:"LONG",regime:"TREND_UP",netR:-0.1,closedAt});
}
const early=deployment.evaluateVariant(rows,"EARLIER_1_BAR","LONG","TREND_UP");
assert.equal(early.validated,true);
assert.ok(early.testUpliftR>0);
const delay=deployment.evaluateVariant(rows,"DELAY_1_BAR","LONG","TREND_UP");
assert.equal(delay.validated,false);
assert.equal(deployment.evaluateVariant(rows.slice(0,20),"EARLIER_1_BAR","LONG","TREND_UP").validated,false);
console.log("nine-ai-autonomous-deployment.test.js: OK");
