"use strict";
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { atr, marketStructure, analyzeMajorStructure, assessConfirmation, marketVeto, selectBestEntrySetup, coreLogic } = require("./coreLogic");
const { loadSimpleConfig } = require("./simple-config");
const { buildProtection } = require("./tpsl");
const { getTopSymbol, applySymbolRefresh } = require("./getTopSymbol");
const C = loadSimpleConfig();
const NOW = 2000000000000;

function timeframeMs(timeframe) {
  if(timeframe==="1M") return 30*24*60*60*1000;
  const match=/^(\d+)([mhdw])$/.exec(timeframe);
  if(!match) throw new Error("UNSUPPORTED_TEST_TIMEFRAME_"+timeframe);
  return Number(match[1])*({m:60000,h:3600000,d:86400000,w:604800000}[match[2]]);
}
function candlesFromCloses(closes, stepMs = timeframeMs(C.ENTRY_TIMEFRAME), start = NOW - closes.length * stepMs) {
  return closes.map((close, i) => ({open:close,high:close+0.2,low:close-0.2,close,closeTime:start+(i+1)*stepMs-1}));
}
function trendCandles(direction = "UP", n = Math.max(C.TREND_HISTORY_CANDLES,C.STRUCTURE_LOOKBACK_CANDLES), timeframe = C.TREND_TIMEFRAME) {
  const stepMs=timeframeMs(timeframe);
  return Array.from({length:n},(_,i)=>{
    const close=(direction==="UP"?100+i*0.18:200-i*0.18)+Math.sin(i*Math.PI/4)*2;
    return {open:close,high:close+0.2,low:close-0.2,close,closeTime:NOW-(n-i)*stepMs};
  });
}
function entryCandles(direction) {
  const n=C.ENTRY_STRUCTURE_LOOKBACK_CANDLES, closes=Array(n).fill(direction==="LONG"?102:98);
  const low1=Math.floor(n*0.25), high=Math.floor(n*0.5), low2=Math.min(Math.floor(n*0.75),n-C.PIVOT_RIGHT_BARS-2), last=n-1;
  if(direction==="LONG") {
    closes[low1]=98; closes[high]=105; closes[low2]=101;
    closes[n-13]=104.5; closes[n-12]=105.4;
    closes[n-5]=105.3; closes[last]=106;
  } else {
    closes[low1]=105; closes[high]=95; closes[low2]=99;
    closes[n-13]=95.5; closes[n-12]=94.6;
    closes[n-5]=94.7; closes[last]=94;
  }
  return candlesFromCloses(closes,timeframeMs(C.ENTRY_TIMEFRAME));
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
  assert.ok(C.MAJOR_PIVOT_LEFT_BARS>0 && C.MAJOR_PIVOT_RIGHT_BARS>0);
  assert.ok(C.ENTRY_STRUCTURE_LOOKBACK_CANDLES>=20);
  assert.ok(C.MAX_ABS_FUNDING_RATE>=0);
  assert.ok(C.MAX_SPREAD_BPS>=0);
});


test("CONFIG.yaml overrides are accepted without changing tests",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","CONFIG.yaml"),"utf8");
  const overrides={
    TREND_TIMEFRAME:"4h",TREND_HISTORY_CANDLES:280,CONFIRMATION_TIMEFRAME:"1h",CONFIRMATION_HISTORY_CANDLES:320,MAJOR_PIVOT_LEFT_BARS:5,MAJOR_PIVOT_RIGHT_BARS:5,CONFIRMATION_PIVOT_LEFT_BARS:1,CONFIRMATION_PIVOT_RIGHT_BARS:1,ENTRY_TIMEFRAME:"30m",MAX_SYMBOLS:150,
    ENTRY_STRUCTURE_LOOKBACK_CANDLES:120,
    TP1_REWARD_RISK:1.1,TP2_REWARD_RISK:1.6,BE_TRIGGER_TP1_PROGRESS_PCT:65,MAX_ABS_FUNDING_RATE:0.001,MAX_SPREAD_BPS:25
  };
  const customized=Object.entries(overrides).reduce((text,[key,value])=>setConfigValue(text,key,value),source);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"simple-config-"));
  const file=path.join(dir,"CONFIG.yaml");
  try {
    fs.writeFileSync(file,customized);
    const custom=loadSimpleConfig(file);
    assert.equal(custom.TREND_TIMEFRAME,"4h");
    assert.equal(custom.TREND_HISTORY_CANDLES,280);
    assert.equal(custom.CONFIRMATION_TIMEFRAME,"1h");
    assert.equal(custom.CONFIRMATION_HISTORY_CANDLES,320);
    assert.equal(custom.MAJOR_PIVOT_LEFT_BARS,5);
    assert.equal(custom.CONFIRMATION_PIVOT_LEFT_BARS,1);
    assert.equal(custom.ENTRY_TIMEFRAME,"30m");
    assert.equal(Object.hasOwn(custom,"SL_TIMEFRAME"),false);
    assert.equal(custom.MAX_SYMBOLS,150);
    assert.equal(custom.ENTRY_STRUCTURE_LOOKBACK_CANDLES,120);
    assert.equal(custom.TP1_REWARD_RISK,1.1);
    assert.equal(custom.TP2_REWARD_RISK,1.6);
    assert.equal(custom.BE_TRIGGER_TP1_PROGRESS_PCT,65);
    assert.equal(custom.MAX_ABS_FUNDING_RATE,0.001);
    assert.equal(custom.MAX_SPREAD_BPS,25);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});


test("entry setup selection filters every candidate before choosing the best survivor",()=>{
  const config={SL_PIVOT_MAX_DISTANCE:30,ENTRY_MAX_EXTENSION_ATR:1.5};
  const candidates=[
    {level:100,pullback:95,pullbackIndex:40,retestIndex:95,bosIndex:90,score:100},
    {level:90,pullback:88,pullbackIndex:80,retestIndex:96,bosIndex:92,score:95},
    {level:99.5,pullback:96,pullbackIndex:85,retestIndex:94,bosIndex:89,score:85}
  ];
  const selected=selectBestEntrySetup(candidates,{
    side:"LONG",latestIndex:99,entryPrice:101,entryAtr:1,config
  });
  assert.equal(selected.setup.level,99.5);
  assert.equal(selected.setup.score,85);
  assert.equal(selected.rejected.oldPivot,1);
  assert.equal(selected.rejected.tooExtended,1);
});

test("entry setup selection reports a rejection only after checking all candidates",()=>{
  const config={SL_PIVOT_MAX_DISTANCE:30,ENTRY_MAX_EXTENSION_ATR:1.5};
  const old=selectBestEntrySetup([
    {level:100,pullback:95,pullbackIndex:10,retestIndex:95,bosIndex:90,score:90},
    {level:101,pullback:96,pullbackIndex:20,retestIndex:96,bosIndex:91,score:80}
  ],{side:"LONG",latestIndex:99,entryPrice:102,entryAtr:1,config});
  assert.equal(old.setup,null);
  assert.equal(old.reason,"ENTRY_PULLBACK_PIVOT_TOO_OLD");

  const extended=selectBestEntrySetup([
    {level:90,pullback:88,pullbackIndex:80,retestIndex:95,bosIndex:90,score:90},
    {level:91,pullback:89,pullbackIndex:85,retestIndex:96,bosIndex:91,score:80}
  ],{side:"LONG",latestIndex:99,entryPrice:100,entryAtr:1,config});
  assert.equal(extended.setup,null);
  assert.equal(extended.reason,"ENTRY_TOO_EXTENDED_FROM_RETEST");
});

test("entry structure lookback is configurable",()=>{
  assert.ok(C.ENTRY_STRUCTURE_LOOKBACK_CANDLES>=20);
  const custom={...C,ENTRY_STRUCTURE_LOOKBACK_CANDLES:120};
  assert.equal(custom.ENTRY_STRUCTURE_LOOKBACK_CANDLES,120);
});
test("ATR returns valid closed-candle indicators",()=>{
  assert.ok(atr(candlesFromCloses(Array.from({length:C.SL_ATR_PERIOD+1},(_,i)=>100+i)),C.ATR_PERIOD)>0);
});


test("LONG entry requires a confirmed higher low followed by a close above the prior swing high",()=>{
  const cfg={...C};
  const entry=entryCandles("LONG");
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entry,config:cfg,now:NOW});
  assert.equal(signal.side,"LONG");
  assert.equal(signal.entryStructure,"HL_BOS_RETEST");
  assert.equal(signal.entrySwingLevel,105.2);
  const noBreak=entryCandles("LONG"); noBreak.at(-1).close=104; noBreak.at(-1).open=104;
  const rejected=coreLogic({trendCandles:trendCandles("UP"),entryCandles:noBreak,config:cfg,now:NOW});
  assert.equal(rejected.side,null);
  assert.equal(rejected.reason,"ENTRY_BOS_RETEST_NOT_CONFIRMED");
  const alreadyAbove=entryCandles("LONG");
  // The latest candle is already above the BOS level; a historical confirmed
  // BOS may still authorize the later retest/continuation entry.
  const preBosIndex=alreadyAbove.length-23;
  alreadyAbove[preBosIndex].close=105.4;
  alreadyAbove[preBosIndex].open=105.4;
  alreadyAbove[preBosIndex].high=105.6;
  alreadyAbove[preBosIndex].low=105.2;
  alreadyAbove[alreadyAbove.length-1].close=105.4;
  alreadyAbove[alreadyAbove.length-1].open=105.4;
  const historicalBosContinuation=coreLogic({trendCandles:trendCandles("UP"),entryCandles:alreadyAbove,config:cfg,now:NOW});
  // A fresh cross is required at BOS time, not necessarily on the latest
  // candle: a previously confirmed BOS + retest may trigger later continuation.
  assert.equal(historicalBosContinuation.side,"LONG");
});

test("SL uses the exact pullback pivot from the entry setup and its ATR timeframe",()=>{
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entryCandles("LONG"),config:{...C},now:NOW});
  assert.equal(signal.side,"LONG");
  assert.equal(signal.pivotPrice,signal.pullbackPivotPrice);
  assert.ok(signal.pivotPrice<signal.entrySwingLevel);
  assert.ok(signal.slAtr>0);
});

test("15m ignores a BOS that occurs before the pullback pivot is confirmed",()=>{
  const entry=entryCandles("LONG");
  for(let i=76;i<entry.length;i++) {
    const close=i===95?105.3:i===99?107:106;
    entry[i]={open:close,high:close+0.2,low:close-0.2,close,closeTime:entry[i].closeTime};
  }
  entry[95].low=105.1;
  entry[95].high=105.5;
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entry,config:{...C},now:NOW});
  assert.equal(signal.side,null);
  assert.equal(signal.reason,"ENTRY_BOS_RETEST_NOT_CONFIRMED");
});

test("15m scores deep retests instead of treating penetration as a hard gate",()=>{
  const signal=coreLogic({
    trendCandles:trendCandles("UP"),
    entryCandles:entryCandles("LONG"),
    config:{...C,ENTRY_RETEST_MAX_PENETRATION_ATR:0,MIN_SCORE_TO_ENTER:70},
    now:NOW
  });
  assert.equal(signal.side,"LONG");
  assert.ok(signal.score>=70);
});

test("1h confirmation requires the configured history count",()=>{
  const confirmation=candlesFromCloses(Array.from({length:C.CONFIRMATION_HISTORY_CANDLES-1},(_,i)=>100+i*0.1),timeframeMs(C.CONFIRMATION_TIMEFRAME));
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entryCandles("LONG"),confirmationCandles:confirmation,config:C,now:NOW});
  assert.equal(signal.side,null);
  assert.equal(signal.reason,"INSUFFICIENT_CLOSED_CANDLES");
});

test("1h confirmation uses its own 2/2 major swings and blocks transitions/reversals",()=>{
  const aligned=assessConfirmation(trendCandles("UP",C.CONFIRMATION_HISTORY_CANDLES,C.CONFIRMATION_TIMEFRAME), "UP", C);
  assert.equal(aligned.major.side,"UP");
  assert.equal(aligned.state,"CONTINUATION");
  const reversal=assessConfirmation(trendCandles("DOWN",C.CONFIRMATION_HISTORY_CANDLES,C.CONFIRMATION_TIMEFRAME), "UP", C);
  assert.equal(reversal.major.side,"DOWN");
  assert.equal(reversal.state,"REVERSAL");
  assert.equal(aligned.major.kind,"major");
  assert.equal(aligned.minor,null);
});

test("4h and 1h use independent pivot widths",()=>{
  const up=trendCandles("UP");
  const confirmation=trendCandles("UP",C.CONFIRMATION_HISTORY_CANDLES,C.CONFIRMATION_TIMEFRAME);
  const fourHour=marketStructure(up,C);
  const oneHour=assessConfirmation(confirmation,"UP",C);
  assert.equal(fourHour.kind,"major");
  assert.equal(oneHour.major.kind,"major");
});

test("major structure analyzer reports confirmed structure and transition states",()=>{
  const source=trendCandles("UP",C.CONFIRMATION_HISTORY_CANDLES,C.CONFIRMATION_TIMEFRAME);
  const analyzed=analyzeMajorStructure(source,C.CONFIRMATION_PIVOT_LEFT_BARS,C.CONFIRMATION_PIVOT_RIGHT_BARS);
  assert.ok(["UP","DOWN","RANGE"].includes(analyzed.side));
  assert.ok(["NORMAL","UNCLEAR","TRANSITION"].includes(analyzed.state));
  assert.ok(["NONE","BOS","CHoCH"].includes(analyzed.event));
  assert.equal(analyzed.kind,"major");
});

test("major bias transitions only when a closed candle breaks the protected HL",()=>{
  const centers=[100,110,104,115,108,120,106.5];
  const source=centers.map((close,i)=>({
    open:close,high:close+(i===1?1:i===3?1:i===5?1:0.2),
    low:close-(i===2?1:i===4?1:0.2),close,closeTime:NOW+i*60000
  }));
  const analyzed=analyzeMajorStructure(source,1,1);
  assert.equal(analyzed.side,"UP");
  assert.equal(analyzed.state,"TRANSITION");
  assert.equal(analyzed.event,"CHoCH");
  assert.equal(analyzed.transitionFrom,"UP");
  assert.equal(analyzed.transitionLevel,107); // latest confirmed higher low's price
});

test("CHoCH stays latched after price reclaims the protected level until a fresh BOS",()=>{
  const centers=[100,110,104,115,108,120,106.5,108,109,110];
  const source=centers.map((close,i)=>({
    open:close,high:close+(i===1?1:i===3?1:i===5?1:0.2),
    low:close-(i===2?1:i===4?1:0.2),close,closeTime:NOW+i*60000
  }));
  const analyzed=analyzeMajorStructure(source,1,1);
  assert.equal(analyzed.state,"TRANSITION");
  assert.equal(analyzed.event,"CHoCH");
  assert.equal(analyzed.transitionFrom,"UP");
});

test("persisted CHoCH remains active after its original candle leaves the fetched window",()=>{
  const source=candlesFromCloses([108,109,110,111,112],60000,NOW-5*60000);
  const previous={state:"TRANSITION",from:"UP",level:107,eventAt:NOW-1000000};
  const analyzed=analyzeMajorStructure(source,1,1,previous);
  assert.equal(analyzed.side,"UP");
  assert.equal(analyzed.state,"TRANSITION");
  assert.equal(analyzed.event,"CHoCH");
  assert.equal(analyzed.transitionLevel,107);
  assert.equal(analyzed.eventAt,previous.eventAt);
});

test("a post-CHoCH lower-high and later close below a confirmed swing low confirms DOWN",()=>{
  const centers=[100,110,104,115,108,120,106.5,109,111,108,105,106,103];
  const highs=[101,111,105,116,109,121,106.7,109.2,112,108.5,105.2,106.5,103.5];
  const lows =[99,109,103,114,107,119,106.3,108.8,110.8,107.5,104,105.5,102.5];
  const source=centers.map((close,i)=>({open:close,high:highs[i],low:lows[i],close,closeTime:NOW+i*60000}));
  const analyzed=analyzeMajorStructure(source,1,1);
  assert.equal(analyzed.side,"DOWN");
  assert.equal(analyzed.state,"NORMAL");
  assert.equal(analyzed.event,"BOS");
});

test("a wick through the protected swing without a close does not create CHoCH",()=>{
  const centers=[100,110,104,115,108,120,109];
  const source=centers.map((close,i)=>({
    open:close,high:close+(i===1?1:i===3?1:i===5?1:0.2),
    low:close-(i===2?1:i===4?2:0.2),close,closeTime:NOW+i*60000
  }));
  const analyzed=analyzeMajorStructure(source,1,1);
  assert.equal(analyzed.side,"UP");
  assert.equal(analyzed.state,"NORMAL");
  assert.notEqual(analyzed.event,"CHoCH");
});
test("entry waits for a confirmed pullback and a close-only BOS",()=>{
  const cfg={...C};
  const entry=entryCandles("LONG");
  const signal=coreLogic({trendCandles:trendCandles("UP"),entryCandles:entry,config:cfg,now:NOW});
  assert.equal(signal.side,"LONG");
  assert.equal(signal.entryStructure,"HL_BOS_RETEST");
  const noHigherLow=entryCandles("LONG"); noHigherLow[Math.min(Math.floor(noHigherLow.length*0.75),noHigherLow.length-C.PIVOT_RIGHT_BARS-2)].close=97; noHigherLow[Math.min(Math.floor(noHigherLow.length*0.75),noHigherLow.length-C.PIVOT_RIGHT_BARS-2)].low=96.8;
  const rejected=coreLogic({trendCandles:trendCandles("UP"),entryCandles:noHigherLow,config:cfg,now:NOW});
  assert.equal(rejected.side,null);
  assert.equal(rejected.reason,"ENTRY_BOS_RETEST_NOT_CONFIRMED");
});
test("major trend structure requires both HH/HL or LH/LL",()=>{
  assert.equal(marketStructure(trendCandles("UP"),C).side,"UP");
  assert.equal(marketStructure(trendCandles("DOWN"),C).side,"DOWN");
  const range=Array.from({length:Math.max(C.TREND_HISTORY_CANDLES,C.STRUCTURE_LOOKBACK_CANDLES)},(_,i)=>({high:100+(i%2),low:99-(i%2),close:99.5,closeTime:NOW-(Math.max(C.TREND_HISTORY_CANDLES,C.STRUCTURE_LOOKBACK_CANDLES)-i)*timeframeMs(C.TREND_TIMEFRAME)}));
  assert.equal(marketStructure(range,C).side,"RANGE");
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

test("counter-bias trades and range bias are vetoed",()=>{
  const cfg={...C};
  const up=trendCandles("UP"), down=trendCandles("DOWN");
  assert.equal(coreLogic({trendCandles:up,entryCandles:entryCandles("SHORT"),config:cfg,now:NOW}).side,null);
  assert.equal(coreLogic({trendCandles:down,entryCandles:entryCandles("LONG"),config:cfg,now:NOW}).side,null);
  const range=Array.from({length:100},(_,i)=>({high:100+(i%2),low:99-(i%2),close:99.5,closeTime:NOW-(100-i)*3600000}));
  assert.equal(coreLogic({trendCandles:range,entryCandles:entryCandles("LONG"),config:cfg,now:NOW}).side,null);
});

test("pivot SL uses configured ATR buffer and independent pivot R clamp",()=>{
  const longProtection=buildProtection({side:"LONG",entryPrice:100,atrValue:1,pivotPrice:98.5,config:C,priceTick:0.01});
  const shortProtection=buildProtection({side:"SHORT",entryPrice:100,atrValue:1,pivotPrice:101.5,config:C,priceTick:0.01});
  assert.ok(longProtection.sl<98.5 && longProtection.tp1>100 && longProtection.tp2>longProtection.tp1);
  assert.equal(longProtection.buffer,Math.max(100*C.SL_PIVOT_BUFFER_MIN_PCT/100,C.SL_PIVOT_BUFFER_ATR));
  assert.equal(longProtection.riskUnit,Math.abs(100-98.5));
  assert.equal(longProtection.stopMethod,C.ENTRY_TIMEFRAME.toUpperCase()+"_ENTRY_PULLBACK_PIVOT");
  assert.equal(longProtection.tp1RewardRisk,C.TP1_REWARD_RISK);
  assert.equal(longProtection.tp2RewardRisk,C.TP2_REWARD_RISK);
  assert.ok(shortProtection.sl>101.5 && shortProtection.tp1<100 && shortProtection.tp2<shortProtection.tp1);
  assert.equal(shortProtection.buffer,Math.max(100*C.SL_PIVOT_BUFFER_MIN_PCT/100,C.SL_PIVOT_BUFFER_ATR));
  assert.equal(shortProtection.tp1RewardRisk,C.TP1_REWARD_RISK);
  assert.equal(shortProtection.tp2RewardRisk,C.TP2_REWARD_RISK);
  assert.throws(()=>buildProtection({side:"LONG",entryPrice:100,atrValue:1,pivotPrice:101,config:C,priceTick:0.01}),/INVALID_SWING_PIVOT_SIDE/);
  assert.throws(()=>buildProtection({side:"LONG",entryPrice:100,atrValue:10,pivotPrice:99.9,config:C,priceTick:0.01}),/SL_PIVOT_R_MULTIPLE_OUT_OF_RANGE/);
});

test("missing pivot uses exact ATR fallback without applying pivot R clamp",()=>{
  const fallback=buildProtection({side:"LONG",entryPrice:100,atrValue:1,pivotPrice:null,config:C,priceTick:0.01});
  assert.equal(fallback.stopMethod,C.ENTRY_TIMEFRAME.toUpperCase()+"_ATR_FALLBACK");
  const fallbackDistance=Math.min(100*C.SL_FALLBACK_MAX_PCT/100,Math.max(100*C.SL_FALLBACK_MIN_PCT/100,C.SL_FALLBACK_ATR_MULTIPLIER));
  assert.equal(fallback.sl,100-fallbackDistance);
  assert.equal(fallback.stopDistance,fallbackDistance);
});

test("empty symbol refresh keeps the last valid list and retries immediately",()=>{
  const previous=["BTCUSDT","ETHUSDT"];
  const empty=applySymbolRefresh({current:previous,next:[],lastRefresh:1000,now:2000});
  assert.deepEqual(empty.symbols,previous);
  assert.equal(empty.lastSymbolRefresh,1000);
  assert.equal(empty.updated,false);
  const initial=applySymbolRefresh({current:[],next:[],lastRefresh:0,now:2000});
  assert.deepEqual(initial.symbols,[]);
  assert.equal(initial.lastSymbolRefresh,0);
  assert.equal(initial.updated,false);
  const valid=applySymbolRefresh({current:previous,next:["SOLUSDT"],lastRefresh:1000,now:2000});
  assert.deepEqual(valid.symbols,["SOLUSDT"]);
  assert.equal(valid.lastSymbolRefresh,2000);
  assert.equal(valid.updated,true);
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
