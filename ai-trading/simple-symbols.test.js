"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {getEligibleSymbols}=require("./getTopSymbol");
test("returns all eligible symbols alphabetically without top-N ranking",async()=>{
 const info={symbols:["AAAUSDT","BBBUSDT","CCCUSDT","BADUSDT"].map((symbol,i)=>({symbol,status:i===3?"BREAK":"TRADING",contractType:"PERPETUAL",quoteAsset:"USDT"}))};
 const tickers=["AAAUSDT","BBBUSDT","CCCUSDT","BADUSDT"].map((symbol,i)=>({symbol,quoteVolume:10_000_000,lastPrice:100,highPrice:102+i,lowPrice:98}));
 const result=await getEligibleSymbols({request:async(m,p)=>p.endsWith("exchangeInfo")?info:tickers,config:{QUOTE_ASSET:"USDT",MIN_24H_QUOTE_VOLUME_USDT:5_000_000,MIN_24H_RANGE_PCT:2}});
 assert.deepEqual(result,["AAAUSDT","BBBUSDT","CCCUSDT"]);
});
