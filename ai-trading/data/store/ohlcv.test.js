"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {RecentOHLCVStore,encodeRecent,decodeRecent}=require("./ohlcv");
const {CONFIG}=require("../../config");
test("archive keeps configured contiguous closed bars and reconstructs without time shift",()=>{
 const end=1700000000000;
 const rows=Array.from({length:600},(_,i)=>{
   const at=end+i*14400000,close=100+i*0.01;
   return [at,close,close+0.1,close-0.1,close,100+i,at+14399999];
 });
 const encoded=encodeRecent(rows);
 const back=decodeRecent(encoded);
 assert.equal(encoded.count,CONFIG.N_CANDLES);
 assert.equal(back.length,CONFIG.N_CANDLES);
 assert.equal(back[0][0],rows[rows.length-CONFIG.N_CANDLES][0]);
 assert.equal(back.at(-1)[6],rows.at(-1)[6]);
 assert.ok(Math.abs(back.at(-1)[4]-rows.at(-1)[4])<0.01);
 assert.ok(encoded.compressed.length<500*5*4);
 const bad=rows.map(r=>[...r]);bad[500][0]+=1;
 assert.throws(()=>encodeRecent(bad),/OHLCV_GAP_OR_INVALID/);
});
test("store writes compressed bounded snapshot once per symbol",async()=>{
 let saved;
 const db={collection(name){assert.equal(name,"nine_ai_ohlcv_4h");
   return {async updateOne(filter,update,options){
      saved={filter,doc:update.$set,options};
   }};}};
 const rows=Array.from({length:500},(_,i)=>{
   const at=1700000000000+i*14400000;
   return [at,100,101,99,100,1,at+14399999];
 });
 const result=await new RecentOHLCVStore(db).store("BTCUSDT",rows);
 assert.equal(result.count,CONFIG.N_CANDLES);
 assert.equal(saved.filter._id,"BTCUSDT");
 assert.equal(saved.doc.compressed instanceof Buffer,true);
 assert.equal(saved.options.upsert,true);
});
