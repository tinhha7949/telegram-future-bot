"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rsi, atr, marketStructure, regularDivergence, coreLogic } = require("./coreLogic");
const { loadSimpleConfig } = require("./simple-config");
const { buildProtection } = require("./tpsl");
const { getTopSymbol } = require("./getTopSymbol");
const C = loadSimpleConfig();
const NOW = 2000000000000;

function candlesFromCloses(closes, stepMs = 300000, start = NOW - closes.length * stepMs) {
  return closes.map((close, i) => ({open:close,high:close+0.2,low:close-0.2,close,closeTime:start+(i+1)*stepMs-1}));
}
function trendCandles(direction = "UP", n = 100) {
  return Array.from({length:n},(_,i)=>{
    const close=(direction==="UP"?100+i*0.15:200-i*0.15)+Math.sin(i*Math.PI/4)*2;
    return {open:close,high:close+0.2,low:close-0.2,close,closeTime:NOW-(n-i)*3600000};
  });
}
function bullishDivergenceCandles() {
  const closes=[];
  for(let i=0;i<=20;i++) closes.push(120-i);
  for(let i=1;i<=10;i++) closes.push(100+i);
  for(let i=1;i<=21;i++) closes.push(110-i*0.5);
  for(let i=1;i<=8;i++) closes.push(99.5+i);
  return candlesFromCloses(closes);
}
function bearishDivergenceCandles() {
  const closes=[];
  for(let i=0;i<=20;i++) closes.push(80+i);
  for(let i=1;i<=10;i++) closes.push(100-i);
  for(let i=1;i<=21;i++) closes.push(90+i*0.5);
  for(let i=1;i<=8;i++) closes.push(100.5-i);
  return candlesFromCloses(closes);
}
function entryCandles(direction) {
  const closes=Array.from({length:40},(_,i)=>direction==="LONG"?120-i:80+i);
  return candlesFromCloses(closes,60000);
}

test("configured timeframes, RSI triggers, divergence lookback and veto thresholds are correct",()=>{
  assert.equal(C.TREND_TIMEFRAME,"1h");
  assert.equal(C.TREND_EMA_PERIOD,20);
  assert.equal(C.ENTRY_TIMEFRAME,"1m");
  assert.equal(C.DIVERGENCE_TIMEFRAME,"5m");
  assert.equal(C.ENTRY_RSI_LONG_MAX,30);
  assert.equal(C.ENTRY_RSI_SHORT_MIN,70);
  assert.ok(C.MAX_ABS_FUNDING_RATE>0);
  assert.ok(C.MAX_SPREAD_BPS>0);
});

test("RSI and ATR return valid closed-candle indicators",()=>{
  assert.equal(rsi(Array.from({length:15},(_,i)=>i+1),14),100);
  assert.equal(rsi(Array.from({length:15},(_,i)=>15-i),14),0);
  assert.ok(atr(candlesFromCloses(Array.from({length:30},(_,i)=>100+i)),14)>0);
});

test("1h structure requires both HH/HL or LH/LL",()=>{
  assert.equal(marketStructure(trendCandles("UP"),C).side,"UP");
  assert.equal(marketStructure(trendCandles("DOWN"),C).side,"DOWN");
  const range=Array.from({length:100},(_,i)=>({high:100+(i%2),low:99-(i%2),close:99.5,closeTime:NOW-(100-i)*3600000}));
  assert.equal(marketStructure(range,C).side,"RANGE");
});

test("5m confirms regular bullish and bearish divergence only",()=>{
  const bull=regularDivergence(bullishDivergenceCandles(),C);
  assert.equal(bull.bullish,true);
  assert.equal(bull.bearish,false);
  assert.ok(bull.swingLow>0);
  const bear=regularDivergence(bearishDivergenceCandles(),C);
  assert.equal(bear.bearish,true);
  assert.equal(bear.bullish,false);
  assert.ok(bear.swingHigh>0);
});

test("hidden divergence and incomplete divergence history do not qualify",()=>{
  const hiddenBull=regularDivergence(candlesFromCloses([...Array.from({length:20},(_,i)=>120-i),...Array.from({length:10},(_,i)=>101+i),...Array.from({length:21},(_,i)=>111-i*0.4),...Array.from({length:8},(_,i)=>103+i)]),C);
  assert.equal(hiddenBull.bullish,false);
  assert.equal(regularDivergence([],C).bullish,false);
});

test("LONG requires 1h up structure, 1m RSI <=30 and regular bullish 5m divergence",()=>{
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entryCandles("LONG"),divergenceCandles:bullishDivergenceCandles(),config:C,now:NOW});
  assert.equal(signal.side,"LONG");
  assert.equal(signal.trendSide,"UP");
  assert.ok(signal.rsi<=30);
  assert.equal(signal.divergence,"REGULAR_BULLISH");
  assert.ok(signal.swingStop<entryCandles("LONG").at(-1).close);
});

test("SHORT requires 1h down structure, 1m RSI >=70 and regular bearish 5m divergence",()=>{
  const signal=coreLogic({trendCandles:trendCandles("DOWN"),entryCandles:entryCandles("SHORT"),divergenceCandles:bearishDivergenceCandles(),config:C,now:NOW});
  assert.equal(signal.side,"SHORT");
  assert.equal(signal.trendSide,"DOWN");
  assert.ok(signal.rsi>=70);
  assert.equal(signal.divergence,"REGULAR_BEARISH");
  assert.ok(signal.swingStop>entryCandles("SHORT").at(-1).close);
});

test("counter-bias trades, RSI outside trigger, and range bias are vetoed",()=>{
  const up=trendCandles("UP"), down=trendCandles("DOWN");
  assert.equal(coreLogic({trendCandles:up,entryCandles:entryCandles("SHORT"),divergenceCandles:bearishDivergenceCandles(),config:C,now:NOW}).side,null);
  assert.equal(coreLogic({trendCandles:down,entryCandles:entryCandles("LONG"),divergenceCandles:bullishDivergenceCandles(),config:C,now:NOW}).side,null);
  const range=Array.from({length:100},(_,i)=>({high:100+(i%2),low:99-(i%2),close:99.5,closeTime:NOW-(100-i)*3600000}));
  assert.equal(coreLogic({trendCandles:range,entryCandles:entryCandles("LONG"),divergenceCandles:bullishDivergenceCandles(),config:C,now:NOW}).side,null);
});

test("SL is placed beyond swing low/high and TP keeps configured RR",()=>{
  const long=buildProtection({side:"LONG",entryPrice:100,atr:1,stopPrice:98.5,config:C,priceTick:0.01});
  const short=buildProtection({side:"SHORT",entryPrice:100,atr:1,stopPrice:101.5,config:C,priceTick:0.01});
  assert.ok(long.sl<=98.5 && long.tp1>100 && long.tp2>long.tp1);
  assert.ok(short.sl>=101.5 && short.tp1<100 && short.tp2<short.tp1);
  assert.throws(()=>buildProtection({side:"LONG",entryPrice:100,atr:1,stopPrice:101,config:C,priceTick:0.01}),/INVALID_SWING_STOP_SIDE/);
});

test("coin selection keeps existing liquidity and symbol filters",async()=>{
  const symbols=["AAAUSDT","BBBUSDT","CCCUSDT","NOTPERPUSDT"];
  const exchangeInfo={symbols:symbols.map((symbol,i)=>({symbol,status:"TRADING",contractType:i===3?"CURRENT_QUARTER":"PERPETUAL",quoteAsset:"USDT"}))};
  const tickers=[
    {symbol:"AAAUSDT",quoteVolume:"9000000",highPrice:"120",lowPrice:"90",lastPrice:"100"},
    {symbol:"BBBUSDT",quoteVolume:"8000000",highPrice:"115",lowPrice:"90",lastPrice:"100"},
    {symbol:"CCCUSDT",quoteVolume:"7000000",highPrice:"110",lowPrice:"90",lastPrice:"100"},
    {symbol:"NOTPERPUSDT",quoteVolume:"99999999",highPrice:"150",lowPrice:"80",lastPrice:"100"}
  ];
  const calls=[];
  const request=async(method,path)=>{calls.push(path);if(path==="/fapi/v1/exchangeInfo")return exchangeInfo;if(path==="/fapi/v1/ticker/24hr")return tickers;throw Error("Unexpected endpoint "+path)};
  const result=await getTopSymbol({request,config:{...C,MAX_SYMBOLS:2}});
  assert.equal(result.length,2);
  assert.deepEqual(new Set(result),new Set(["AAAUSDT","BBBUSDT"]));
  assert.deepEqual(calls.sort(),["/fapi/v1/exchangeInfo","/fapi/v1/ticker/24hr"]);
});
