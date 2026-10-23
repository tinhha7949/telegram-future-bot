"use strict";
const assert=require("node:assert/strict");
const {test}=require("node:test");
const {WaitRateControl}=require("./wait-rate");
const {CONFIG}=require("../config");
test("30-day overtrading raises decision edge; empty record stays baseline",async()=>{
  const data=[];
  const store={find(){return {sort(){return this},limit(){return this},async toArray(){return data}}}};
  const db={collection(){return store}};
  const rate=new WaitRateControl(db,{now:()=>Date.UTC(2026,9,23)});
  assert.equal((await rate.minimumEdge()).minEdge,CONFIG.MIN_EDGE);
  data.push({action:"LONG"},{action:"LONG"},{action:"WAIT"});
  const r=await rate.minimumEdge();
  assert.equal(r.ok,true);
  assert.ok(r.minEdge>CONFIG.MIN_EDGE);
  data.push({action:"WAIT"},{action:"WAIT"},{action:"WAIT"});
  assert.equal((await rate.minimumEdge()).minEdge,CONFIG.MIN_EDGE);
});
test("unavailable wait history blocks entries",async()=>{
 const c=new WaitRateControl({collection(){return {find(){throw Error("down")}}}});
 assert.equal((await c.minimumEdge()).ok,false);
});
