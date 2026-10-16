"use strict";
const assert = require("node:assert/strict");
const { reachedProtectionTrigger } = require("./tpsl-safety");

assert.deepEqual(reachedProtectionTrigger({side:"LONG",price:98,stopPrices:[99,98.5],targetPrices:[105]}),
  {reached:true,reason:"SL_TRIGGER_REACHED"});
assert.deepEqual(reachedProtectionTrigger({side:"LONG",price:105.1,stopPrices:[98],targetPrices:[105,110]}),
  {reached:true,reason:"TP_TRIGGER_REACHED"});
assert.deepEqual(reachedProtectionTrigger({side:"LONG",price:101,stopPrices:[98],targetPrices:[105]}),
  {reached:false,reason:"NO_TRIGGER_REACHED"});
assert.deepEqual(reachedProtectionTrigger({side:"SHORT",price:102,stopPrices:[105,101],targetPrices:[95]}),
  {reached:true,reason:"SL_TRIGGER_REACHED"});
assert.deepEqual(reachedProtectionTrigger({side:"SHORT",price:94.9,stopPrices:[105],targetPrices:[95,90]}),
  {reached:true,reason:"TP_TRIGGER_REACHED"});
assert.deepEqual(reachedProtectionTrigger({side:"SHORT",price:99,stopPrices:[105],targetPrices:[95]}),
  {reached:false,reason:"NO_TRIGGER_REACHED"});
assert.deepEqual(reachedProtectionTrigger({side:"LONG",price:98,stopPrices:[99],targetPrices:[98]}),
  {reached:true,reason:"SL_TRIGGER_REACHED"}, "stop is the conservative priority if both triggers crossed");
assert.equal(reachedProtectionTrigger({side:"LONG",price:0,stopPrices:[99]}).reached,false);
console.log("PASS: TPSL trigger-crossing guard handles LONG/SHORT, stop priority, and invalid prices");
