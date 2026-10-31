"use strict";
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { rsi, atr, marketStructure, regularDivergence, entryRsiTriggered, marketVeto, coreLogic } = require("./coreLogic");
const { loadSimpleConfig } = require("./simple-config");
const { buildProtection, protectionConfigForDivergence } = require("./tpsl");
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
  const closes=Array.from({length:40},(_,i)=>direction==="LONG"?140-i:60+i);
  return candlesFromCloses(closes,60000);
}

test("loaded strategy settings are valid and drive the strategy",()=>{
  const supported=new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M"]);
  assert.ok(supported.has(C.TREND_TIMEFRAME));
  assert.ok(supported.has(C.ENTRY_TIMEFRAME));
  assert.ok(supported.has(C.DIVERGENCE_TIMEFRAME));
  assert.ok(Number.isInteger(C.TREND_EMA_PERIOD) && C.TREND_EMA_PERIOD>0);
  assert.ok(C.ENTRY_RSI_LONG_MAX>=0 && C.ENTRY_RSI_LONG_MAX<C.ENTRY_RSI_SHORT_MIN);
  assert.ok(C.ENTRY_RSI_SHORT_MIN<=100);
  assert.ok(C.MAX_ABS_FUNDING_RATE>=0);
  assert.ok(C.MAX_SPREAD_BPS>=0);
});


test("CONFIG.yaml overrides are accepted without changing tests",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","CONFIG.yaml"),"utf8");
  const customized=source
    .replace('TREND_TIMEFRAME: "1h"','TREND_TIMEFRAME: "4h"')
    .replace('ENTRY_TIMEFRAME: "1m"','ENTRY_TIMEFRAME: "3m"')
    .replace('DIVERGENCE_TIMEFRAME: "5m"','DIVERGENCE_TIMEFRAME: "15m"')
    .replace("MAX_SYMBOLS: 100","MAX_SYMBOLS: 150")
    .replace("ENTRY_RSI_LONG_MAX: 30","ENTRY_RSI_LONG_MAX: 42")
    .replace("ENTRY_RSI_SHORT_MIN: 70","ENTRY_RSI_SHORT_MIN: 58")
    .replace("TP1_REWARD_RISK: 1.2","TP1_REWARD_RISK: 1.1")
    .replace("TP2_REWARD_RISK: 1.5","TP2_REWARD_RISK: 1.6")
    .replace("MAX_ABS_FUNDING_RATE: 0.0005","MAX_ABS_FUNDING_RATE: 0.001")
    .replace("MAX_SPREAD_BPS: 10","MAX_SPREAD_BPS: 25");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"simple-config-"));
  const file=path.join(dir,"CONFIG.yaml");
  try {
    fs.writeFileSync(file,customized);
    const custom=loadSimpleConfig(file);
    assert.equal(custom.TREND_TIMEFRAME,"4h");
    assert.equal(custom.ENTRY_TIMEFRAME,"3m");
    assert.equal(custom.DIVERGENCE_TIMEFRAME,"15m");
    assert.equal(custom.MAX_SYMBOLS,150);
    assert.equal(custom.ENTRY_RSI_LONG_MAX,42);
    assert.equal(custom.ENTRY_RSI_SHORT_MIN,58);
    assert.equal(custom.TP1_REWARD_RISK,1.1);
    assert.equal(custom.TP2_REWARD_RISK,1.6);
    assert.equal(custom.MAX_ABS_FUNDING_RATE,0.001);
    assert.equal(custom.MAX_SPREAD_BPS,25);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("RSI thresholds are inclusive and configurable",()=>{
  assert.equal(entryRsiTriggered("LONG",C.ENTRY_RSI_LONG_MAX,C),true);
  assert.equal(entryRsiTriggered("LONG",C.ENTRY_RSI_LONG_MAX+0.01,C),false);
  assert.equal(entryRsiTriggered("SHORT",C.ENTRY_RSI_SHORT_MIN,C),true);
  assert.equal(entryRsiTriggered("SHORT",C.ENTRY_RSI_SHORT_MIN-0.01,C),false);
  const custom={...C,ENTRY_RSI_LONG_MAX:38,ENTRY_RSI_SHORT_MIN:62};
  assert.equal(entryRsiTriggered("LONG",38,custom),true);
  assert.equal(entryRsiTriggered("SHORT",62,custom),true);
});

test("RSI and ATR return valid closed-candle indicators",()=>{
  assert.equal(rsi(Array.from({length:15},(_,i)=>i+1),14),100);
  assert.equal(rsi(Array.from({length:15},(_,i)=>15-i),14),0);
  assert.ok(atr(candlesFromCloses(Array.from({length:30},(_,i)=>100+i)),14)>0);
});

test("trend structure requires both HH/HL or LH/LL",()=>{
  assert.equal(marketStructure(trendCandles("UP"),C).side,"UP");
  assert.equal(marketStructure(trendCandles("DOWN"),C).side,"DOWN");
  const range=Array.from({length:100},(_,i)=>({high:100+(i%2),low:99-(i%2),close:99.5,closeTime:NOW-(100-i)*3600000}));
  assert.equal(marketStructure(range,C).side,"RANGE");
});

test("5m confirms regular bullish and bearish divergence only",()=>{
  const bull=regularDivergence(bullishDivergenceCandles(),{...C,DIVERGENCE_MAX_PIVOT_DISTANCE:50});
  assert.equal(bull.bullish,true);
  assert.equal(bull.bearish,false);
  assert.ok(bull.swingLow>0);
  const bear=regularDivergence(bearishDivergenceCandles(),{...C,DIVERGENCE_MAX_PIVOT_DISTANCE:50});
  assert.equal(bear.bearish,true);
  assert.equal(bear.bullish,false);
  assert.ok(bear.swingHigh>0);
});

test("hidden divergence and incomplete divergence history do not qualify",()=>{
  const hiddenBull=regularDivergence(candlesFromCloses([...Array.from({length:20},(_,i)=>120-i),...Array.from({length:10},(_,i)=>101+i),...Array.from({length:21},(_,i)=>111-i*0.4),...Array.from({length:8},(_,i)=>103+i)]),C);
  assert.equal(hiddenBull.bullish,false);
  assert.equal(regularDivergence([],C).bullish,false);
});

test("funding and spread vetoes follow CONFIG.yaml thresholds",()=>{
  const market={bidPrice:100,askPrice:100,config:C};
  const hotFunding=C.MAX_ABS_FUNDING_RATE+Math.max(1e-8,C.MAX_ABS_FUNDING_RATE*0.1);
  assert.equal(marketVeto({...market,side:"LONG",fundingRate:hotFunding}).reason,"FUNDING_TOO_HOT");
  assert.equal(marketVeto({...market,side:"SHORT",fundingRate:-hotFunding}).reason,"FUNDING_TOO_HOT");
  assert.equal(marketVeto({...market,side:"LONG",fundingRate:-hotFunding}).allowed,true);
  assert.equal(marketVeto({...market,side:"SHORT",fundingRate:hotFunding}).allowed,true);
  if(C.MAX_SPREAD_BPS<19999) {
    const wideSpread=C.MAX_SPREAD_BPS+Math.max(1,(19999-C.MAX_SPREAD_BPS)/2);
    const wideAsk=100*(20000+wideSpread)/(20000-wideSpread);
    assert.equal(marketVeto({...market,side:"LONG",fundingRate:0,askPrice:wideAsk}).reason,"SPREAD_TOO_WIDE");
  } else assert.equal(marketVeto({...market,side:"LONG",fundingRate:0,askPrice:1000000}).allowed,true);
  assert.equal(marketVeto({...market,side:"LONG",fundingRate:null}).reason,"MARKET_DATA_INVALID");
});

test("LONG enters with regular bullish divergence as an RR bonus",()=>{
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entryCandles("LONG"),divergenceCandles:bullishDivergenceCandles(),config:{...C,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50},now:NOW});
  assert.equal(signal.side,"LONG");
  assert.equal(signal.trendSide,"UP");
  assert.ok(signal.rsi<=C.ENTRY_RSI_LONG_MAX);
  assert.equal(signal.divergence,"REGULAR_BULLISH");
  assert.ok(signal.swingStop<entryCandles("LONG").at(-1).close);
});

test("SHORT enters with regular bearish divergence as an RR bonus",()=>{
  const signal=coreLogic({trendCandles:trendCandles("DOWN"),entryCandles:entryCandles("SHORT"),divergenceCandles:bearishDivergenceCandles(),config:{...C,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50},now:NOW});
  assert.equal(signal.side,"SHORT");
  assert.equal(signal.trendSide,"DOWN");
  assert.ok(signal.rsi>=C.ENTRY_RSI_SHORT_MIN);
  assert.equal(signal.divergence,"REGULAR_BEARISH");
  assert.ok(signal.swingStop>entryCandles("SHORT").at(-1).close);
});

test("entries without matching regular divergence are allowed at the wider RR tier",()=>{
  const cfg={...C,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50};
  const noDiv=candlesFromCloses(Array.from({length:100},(_,i)=>100+i*0.01));
  const long=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entryCandles("LONG"),divergenceCandles:noDiv,config:cfg,now:NOW});
  const short=coreLogic({trendCandles:trendCandles("DOWN"),entryCandles:entryCandles("SHORT"),divergenceCandles:noDiv,config:cfg,now:NOW});
  assert.equal(long.side,"LONG");
  assert.equal(long.divergence,null);
  assert.equal(short.side,"SHORT");
  assert.equal(short.divergence,null);
  const noDivConfig=protectionConfigForDivergence(C,long.divergence);
  const divConfig=protectionConfigForDivergence(C,"REGULAR_BULLISH");
  assert.equal(noDivConfig.TP1_REWARD_RISK,C.TP1_REWARD_RISK_NO_DIVERGENCE);
  assert.equal(noDivConfig.TP2_REWARD_RISK,C.TP2_REWARD_RISK_NO_DIVERGENCE);
  assert.equal(divConfig.TP1_REWARD_RISK,C.TP1_REWARD_RISK);
  assert.equal(divConfig.TP2_REWARD_RISK,C.TP2_REWARD_RISK);
});

test("counter-bias trades, RSI outside trigger, and range bias are vetoed",()=>{
  const cfg={...C,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50};
  const up=trendCandles("UP"), down=trendCandles("DOWN");
  assert.equal(coreLogic({trendCandles:up,entryCandles:entryCandles("SHORT"),divergenceCandles:bearishDivergenceCandles(),config:cfg,now:NOW}).side,null);
  assert.equal(coreLogic({trendCandles:down,entryCandles:entryCandles("LONG"),divergenceCandles:bullishDivergenceCandles(),config:cfg,now:NOW}).side,null);
  const range=Array.from({length:100},(_,i)=>({high:100+(i%2),low:99-(i%2),close:99.5,closeTime:NOW-(100-i)*3600000}));
  assert.equal(coreLogic({trendCandles:range,entryCandles:entryCandles("LONG"),divergenceCandles:bullishDivergenceCandles(),config:cfg,now:NOW}).side,null);
});

test("SL stays beyond swing and both divergence RR tiers drive the two TP levels",()=>{
  const withDiv=buildProtection({side:"LONG",entryPrice:100,atr:1,stopPrice:98.5,config:protectionConfigForDivergence(C,"REGULAR_BULLISH"),priceTick:0.01});
  const withoutDiv=buildProtection({side:"SHORT",entryPrice:100,atr:1,stopPrice:101.5,config:protectionConfigForDivergence(C,null),priceTick:0.01});
  assert.ok(withDiv.sl<=98.5 && withDiv.tp1>100 && withDiv.tp2>withDiv.tp1);
  assert.equal(withDiv.tp1RewardRisk,C.TP1_REWARD_RISK);
  assert.equal(withDiv.tp2RewardRisk,C.TP2_REWARD_RISK);
  assert.ok(withoutDiv.sl>=101.5 && withoutDiv.tp1<100 && withoutDiv.tp2<withoutDiv.tp1);
  assert.equal(withoutDiv.tp1RewardRisk,C.TP1_REWARD_RISK_NO_DIVERGENCE);
  assert.equal(withoutDiv.tp2RewardRisk,C.TP2_REWARD_RISK_NO_DIVERGENCE);
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
