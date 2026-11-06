"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {getEligibleSymbols}=require("./getTopSymbol");
test("returns up to MAX_SYMBOLS eligible symbols ranked by 24h quote volume",async()=>{
 const symbols=["AAAUSDT","BBBUSDT","CCCUSDT","DDDUSDT","BADUSDT"];
 const info={symbols:symbols.map((symbol,i)=>({symbol,status:i===4?"BREAK":"TRADING",contractType:"PERPETUAL",quoteAsset:"USDT"}))};
 const volumes=[10_000_000,30_000_000,20_000_000,40_000_000,100_000_000];
 const tickers=symbols.map((symbol,i)=>({symbol,quoteVolume:volumes[i],lastPrice:100,highPrice:103,lowPrice:97}));
 const result=await getEligibleSymbols({request:async(m,p)=>p.endsWith("exchangeInfo")?info:tickers,config:{QUOTE_ASSET:"USDT",MIN_24H_QUOTE_VOLUME_USDT:5_000_000,MIN_24H_RANGE_PCT:2,MAX_SYMBOLS:2}});
 assert.deepEqual(result,["DDDUSDT","BBBUSDT"]);
});
test("does not exceed MAX_SYMBOLS after applying eligibility filters",async()=>{
 const symbols=["AAAUSDT","BBBUSDT","CCCUSDT"];
 const info={symbols:symbols.map(symbol=>({symbol,status:"TRADING",contractType:"PERPETUAL",quoteAsset:"USDT"}))};
 const tickers=symbols.map((symbol,i)=>({symbol,quoteVolume:10_000_000-i*1_000_000,lastPrice:100,highPrice:102,lowPrice:98}));
 const result=await getEligibleSymbols({request:async(m,p)=>p.endsWith("exchangeInfo")?info:tickers,config:{QUOTE_ASSET:"USDT",MIN_24H_QUOTE_VOLUME_USDT:5_000_000,MIN_24H_RANGE_PCT:2,MAX_SYMBOLS:1}});
 assert.deepEqual(result,["AAAUSDT"]);
});
