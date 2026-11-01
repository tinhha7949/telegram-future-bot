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
  return candlesFromCloses(closes,300000);
}
function setConfigValue(source,key,value) {
  const pattern=new RegExp("^"+key+":.*$","m");
  assert.match(source,pattern,"CONFIG.yaml must define "+key);
  const rendered=typeof value==="string"?JSON.stringify(value):String(value);
  return source.replace(pattern,key+": "+rendered);
}

test("loaded strategy settings are valid and drive the strategy",()=>{
  const supported=new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M"]);
  assert.ok(supported.has(C.TREND_TIMEFRAME));
  assert.ok(supported.has(C.ENTRY_TIMEFRAME));
  assert.ok(supported.has(C.DIVERGENCE_TIMEFRAME));
  assert.ok(Number.isInteger(C.TREND_EMA_PERIOD) && C.TREND_EMA_PERIOD>0);
  assert.ok(C.ENTRY_RSI_LONG_MIN>=0 && C.ENTRY_RSI_LONG_MIN<=C.ENTRY_RSI_LONG_MAX && C.ENTRY_RSI_LONG_MAX<=100);
  assert.ok(C.ENTRY_RSI_SHORT_MIN>=0 && C.ENTRY_RSI_SHORT_MIN<=C.ENTRY_RSI_SHORT_MAX && C.ENTRY_RSI_SHORT_MAX<=100);
  assert.ok(C.MAX_ABS_FUNDING_RATE>=0);
  assert.ok(C.MAX_SPREAD_BPS>=0);
});


test("CONFIG.yaml overrides are accepted without changing tests",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","CONFIG.yaml"),"utf8");
  const overrides={
    TREND_TIMEFRAME:"4h",ENTRY_TIMEFRAME:"15m",DIVERGENCE_TIMEFRAME:"30m",MAX_SYMBOLS:150,
    ENTRY_RSI_LONG_MIN:28,ENTRY_RSI_LONG_MAX:42,ENTRY_RSI_SHORT_MIN:58,ENTRY_RSI_SHORT_MAX:72,
    TP1_REWARD_RISK:1.1,TP2_REWARD_RISK:1.6,BE_TRIGGER_TP1_PROGRESS_PCT:65,MAX_ABS_FUNDING_RATE:0.001,MAX_SPREAD_BPS:25
  };
  const customized=Object.entries(overrides).reduce((text,[key,value])=>setConfigValue(text,key,value),source);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"simple-config-"));
  const file=path.join(dir,"CONFIG.yaml");
  try {
    fs.writeFileSync(file,customized);
    const custom=loadSimpleConfig(file);
    assert.equal(custom.TREND_TIMEFRAME,"4h");
    assert.equal(custom.ENTRY_TIMEFRAME,"15m");
    assert.equal(custom.DIVERGENCE_TIMEFRAME,"30m");
    assert.equal(custom.MAX_SYMBOLS,150);
    assert.equal(custom.ENTRY_RSI_LONG_MIN,28);
    assert.equal(custom.ENTRY_RSI_LONG_MAX,42);
    assert.equal(custom.ENTRY_RSI_SHORT_MIN,58);
    assert.equal(custom.ENTRY_RSI_SHORT_MAX,72);
    assert.equal(custom.TP1_REWARD_RISK,1.1);
    assert.equal(custom.TP2_REWARD_RISK,1.6);
    assert.equal(custom.BE_TRIGGER_TP1_PROGRESS_PCT,65);
    assert.equal(custom.MAX_ABS_FUNDING_RATE,0.001);
    assert.equal(custom.MAX_SPREAD_BPS,25);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("RSI bands loaded from CONFIG.yaml are inclusive and use their configured boundaries",()=>{
  for(const [side,min,max] of [
    ["LONG",C.ENTRY_RSI_LONG_MIN,C.ENTRY_RSI_LONG_MAX],
    ["SHORT",C.ENTRY_RSI_SHORT_MIN,C.ENTRY_RSI_SHORT_MAX]
  ]) {
    assert.equal(entryRsiTriggered(side,min,C),true);
    assert.equal(entryRsiTriggered(side,max,C),true);
    assert.equal(entryRsiTriggered(side,(min+max)/2,C),true);
    assert.equal(entryRsiTriggered(side,min-0.01,C),false);
    assert.equal(entryRsiTriggered(side,max+0.01,C),false);
    assert.equal(entryRsiTriggered(side,NaN,C),false);
  }
  const custom={...C,ENTRY_RSI_LONG_MIN:21,ENTRY_RSI_LONG_MAX:39,ENTRY_RSI_SHORT_MIN:61,ENTRY_RSI_SHORT_MAX:79};
  assert.equal(entryRsiTriggered("LONG",21,custom),true);
  assert.equal(entryRsiTriggered("LONG",39,custom),true);
  assert.equal(entryRsiTriggered("LONG",20.99,custom),false);
  assert.equal(entryRsiTriggered("LONG",39.01,custom),false);
  assert.equal(entryRsiTriggered("SHORT",61,custom),true);
  assert.equal(entryRsiTriggered("SHORT",79,custom),true);
  assert.equal(entryRsiTriggered("SHORT",60.99,custom),false);
  assert.equal(entryRsiTriggered("SHORT",79.01,custom),false);
});

test("RSI and ATR return valid closed-candle indicators",()=>{
  assert.equal(rsi(Array.from({length:15},(_,i)=>i+1),14),100);
  assert.equal(rsi(Array.from({length:15},(_,i)=>15-i),14),0);
  assert.ok(atr(candlesFromCloses(Array.from({length:30},(_,i)=>100+i)),14)>0);
});


test("coreLogic calculates entry RSI from the configured entry candle stream",()=>{
  const entry=entryCandles("LONG");
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entry,divergenceCandles:bullishDivergenceCandles(),config:{...C,ENTRY_RSI_LONG_MIN:0,ENTRY_RSI_LONG_MAX:100,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50},now:NOW});
  assert.equal(signal.rsi,rsi(entry.map(c=>c.close),C.RSI_PERIOD));
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
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entryCandles("LONG"),divergenceCandles:bullishDivergenceCandles(),config:{...C,ENTRY_RSI_LONG_MIN:0,ENTRY_RSI_LONG_MAX:0,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50},now:NOW});
  assert.equal(signal.side,"LONG");
  assert.equal(signal.trendSide,"UP");
  assert.ok(signal.rsi>=0 && signal.rsi<=0);
  assert.equal(signal.divergence,"REGULAR_BULLISH");
  assert.ok(signal.swingStop<entryCandles("LONG").at(-1).close);
});

test("SHORT enters with regular bearish divergence as an RR bonus",()=>{
  const signal=coreLogic({trendCandles:trendCandles("DOWN"),entryCandles:entryCandles("SHORT"),divergenceCandles:bearishDivergenceCandles(),config:{...C,ENTRY_RSI_SHORT_MIN:100,ENTRY_RSI_SHORT_MAX:100,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50},now:NOW});
  assert.equal(signal.side,"SHORT");
  assert.equal(signal.trendSide,"DOWN");
  assert.ok(signal.rsi>=100 && signal.rsi<=100);
  assert.equal(signal.divergence,"REGULAR_BEARISH");
  assert.ok(signal.swingStop>entryCandles("SHORT").at(-1).close);
});

test("entries without matching regular divergence are allowed at the wider RR tier",()=>{
  const cfg={...C,ENTRY_RSI_LONG_MIN:0,ENTRY_RSI_LONG_MAX:0,ENTRY_RSI_SHORT_MIN:100,ENTRY_RSI_SHORT_MAX:100,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50};
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
  const cfg={...C,ENTRY_RSI_LONG_MIN:0,ENTRY_RSI_LONG_MAX:0,ENTRY_RSI_SHORT_MIN:100,ENTRY_RSI_SHORT_MAX:100,DIVERGENCE_LOOKBACK_CANDLES:60,DIVERGENCE_MAX_PIVOT_DISTANCE:50};
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
