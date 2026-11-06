"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {placeProtection}=require("./tpsl");
const config={TP1_CLOSE_PERCENT:60,TP2_CLOSE_PERCENT:40};
function makeRequest(dropLast=false){
 let id=0;const rows=[];
 return async(method,path,params)=>{
  if(method==="POST"){const row={algoId:++id,clientAlgoId:params.clientAlgoId};rows.push(row);return row;}
  if(method==="GET")return dropLast?rows.slice(0,2):rows;
  throw Error("UNEXPECTED_REQUEST");
 };
}
test("protection is only reported complete after all three algo orders are visible on Binance",async()=>{
 const result=await placeProtection({request:makeRequest(),symbol:"BTCUSDT",side:"LONG",sl:90,tp1:110,tp2:120,qty:1,stepSize:.01,minQty:.01,config});
 assert.equal(result.verified,true);assert.ok(result.stop.algoId);assert.ok(result.tp1.algoId);assert.ok(result.tp2.algoId);
});
test("partial algo protection is treated as a failed protection set",async()=>{
 await assert.rejects(()=>placeProtection({request:makeRequest(true),symbol:"BTCUSDT",side:"LONG",sl:90,tp1:110,tp2:120,qty:1,stepSize:.01,minQty:.01,config}),/ALGO_PROTECTION_NOT_VERIFIED/);
});
