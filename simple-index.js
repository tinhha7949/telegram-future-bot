"use strict";
const path = require("node:path");
const envFile = path.join(__dirname, ".env");
try {
  process.loadEnvFile(envFile);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");
const { loadSimpleConfig } = require("./ai-trading/simple-config");
const { coreLogic, marketVeto } = require("./ai-trading/coreLogic");
const { getTopSymbol } = require("./ai-trading/getTopSymbol");
const { buildProtection, protectionConfigForDivergence, splitQuantity, placeProtection } = require("./ai-trading/tpsl");
const { calculateOrderSizing } = require("./ai-trading/simple-sizing");
const C = loadSimpleConfig();
const BASE = "https://fapi.binance.com";
const RSI_HISTORY_CANDLES = 100
const sleep = ms => new Promise(r => setTimeout(r, ms));
function floorStep(n, step) { if (!(step > 0)) return n; return Math.floor((n + step*1e-10)/step)*step; }
function precision(step) { const s=String(step); return s.includes(".") ? s.length-s.indexOf(".")-1 : 0; }
async function sendTelegram(token,chat,text,label){
  if(!token||!chat){console.error(label+"_NOT_CONFIGURED");return false;}
  try{
    const res=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text,disable_web_page_preview:true}),signal:AbortSignal.timeout(8000)});
    const data=await res.json();
    if(!res.ok||!data.ok)throw Error(data.description||("HTTP_"+res.status));
    return true;
  }catch(e){console.error(label+"_FAILED",e.message);return false;}
}
const telegramEntry=text=>sendTelegram(process.env.BOT_TOKEN,process.env.CHAT_ID,text,"TELE1_ENTRY_NOTIFICATION");
const telegramResult=text=>sendTelegram(process.env.BOT_TOKEN_2,process.env.AI_CHAT_ID,text,"TELE2_RESULT_NOTIFICATION");
class Binance {
  constructor() {
    this.key=process.env.BINANCE_KEY; this.secret=process.env.BINANCE_SECRET;
    this.timeOffsetMs=0;
    this.rateLimitUntil=0;
    if (!this.key || !this.secret) throw new Error("BINANCE_KEY_AND_SECRET_REQUIRED");
  }
  async request(method,path,params={},signed=false,retryTimestamp=true) {
    const p={...params};
    if (signed) { p.timestamp=Date.now()+this.timeOffsetMs; p.recvWindow=C.BINANCE_RECV_WINDOW_MS; }
    const query=new URLSearchParams(Object.entries(p).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)])).toString();
    const sig=signed?crypto.createHmac("sha256",this.secret).update(query).digest("hex"):"";
    const url=BASE+path+(query?"?"+query+(signed?"&signature="+sig:""):"");
    const res=await fetch(url,{method,headers:{"X-MBX-APIKEY":this.key},signal:AbortSignal.timeout(C.BINANCE_HTTP_TIMEOUT_MS)});
    const body=await res.text(); let data;
    try { data=JSON.parse(body); } catch { throw new Error("BINANCE_BAD_JSON_"+res.status); }
    if (res.status===429 || res.status===418) {
      const retryAfter=Number(res.headers.get("retry-after"));
      this.rateLimitUntil=Date.now()+Math.max(60000,Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:0);
      throw new Error("BINANCE_"+res.status+"_RATE_LIMIT_COOLDOWN");
    }
    if (!res.ok && signed && retryTimestamp && Number(data.code)===-1021) {
      await this.syncTime();
      return this.request(method,path,params,true,false);
    }
    if (!res.ok) throw new Error("BINANCE_"+res.status+"_"+(data.msg||data.code||"REQUEST_FAILED"));
    return data;
  }
  async syncTime() {
    const data=await this.get("/fapi/v1/time");
    const serverTime=Number(data.serverTime);
    if(!Number.isFinite(serverTime)||serverTime<=0)throw new Error("BINANCE_SERVER_TIME_INVALID");
    this.timeOffsetMs=serverTime-Date.now();
    return this.timeOffsetMs;
  }
  get(path,params={}) { return this.request("GET",path,params,false); }
  signed(method,path,params={}) { return this.request(method,path,params,true); }
}
function toCandles(raw) { return raw.map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],closeTime:+k[6]})); }
async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  const binance=new Binance(), mongo=new MongoClient(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000,maxPoolSize:5});
  await mongo.connect();
  await binance.syncTime();
  const db=mongo.db(C.MONGO_DB_NAME), trades=db.collection(C.MONGO_TRADES_COLLECTION), state=db.collection(C.MONGO_STATE_COLLECTION);
  await trades.createIndex({symbol:1,status:1},{name:"simple_active_symbol",partialFilterExpression:{status:"OPEN"}});
  await trades.createIndex({openedAt:1},{name:"simple_opened_at"});
  await trades.createIndex({symbol:1,signalAt:1},{name:"simple_signal_once",unique:true});
  await state.updateOne({_id:"runtime"},{$set:{lastStartedAt:new Date(),strategy:"1H_STRUCTURE_"+C.DIVERGENCE_TIMEFRAME+"_DIVERGENCE_BONUS_"+C.ENTRY_TIMEFRAME+"_RSI_ENTRY"}},{upsert:true});
  const info=await binance.get("/fapi/v1/exchangeInfo");
  const rules=new Map();
  for(const s of info.symbols||[]) {
    const f=Object.fromEntries((s.filters||[]).map(x=>[x.filterType,x]));
    const lot=f.LOT_SIZE||{}, notionalFilter=f.NOTIONAL||f.MIN_NOTIONAL||{};
    rules.set(s.symbol,{status:s.status,contractType:s.contractType,quoteAsset:s.quoteAsset,
      tickSize:Number(f.PRICE_FILTER?.tickSize||0.00000001),stepSize:Number(lot.stepSize||0),
      minQty:Number(lot.minQty||0),minNotional:Number(notionalFilter.minNotional||notionalFilter.notional||5)});
  }
  const leverageCaps=new Map();
  try {
    const brackets=await binance.signed("GET","/fapi/v1/leverageBracket");
    for(const item of Array.isArray(brackets)?brackets:[]) {
      const cap=Number(item.brackets?.[0]?.initialLeverage);
      if(item.symbol&&Number.isFinite(cap)&&cap>0)leverageCaps.set(item.symbol,cap);
    }
  } catch(e) { console.error("LEVERAGE_BRACKET_PREFETCH_FAILED",e.message); }
  const mode=await binance.signed("GET","/fapi/v1/positionSide/dual");
  if (mode.dualSidePosition===true) throw new Error("HEDGE_MODE_UNSUPPORTED_SWITCH_TO_ONE_WAY_BEFORE_START");
  let stopped=false, busy=false, symbols=[], lastSymbolRefresh=0, rateLimitLoggedUntil=0;
  async function positions() { return (await binance.signed("GET","/fapi/v2/positionRisk")).filter(p=>Math.abs(Number(p.positionAmt))>0); }
  async function account() { return binance.signed("GET","/fapi/v2/account"); }
  async function notifyPendingResults() {
    const now=new Date();
    const pendingResults=await trades.find({resultNotificationPending:true,$or:[{resultNotificationNextAttemptAt:{$exists:false}},{resultNotificationNextAttemptAt:{$lte:now}}]}).toArray();
    for(const t of pendingResults) {
      try {
        await trades.updateOne({_id:t._id,resultNotificationPending:true},{$set:{resultNotificationLastAttemptAt:new Date(),resultNotificationNextAttemptAt:new Date(Date.now()+60000)},$inc:{resultNotificationAttempts:1}});
        let net=Number(t.realizedNetPnl), wallet=Number(t.walletBalanceAtClose);
        if(!Number.isFinite(net)) {
          const startTime=new Date(t.openedAt).getTime(), endTime=new Date(t.closedAt||Date.now()).getTime();
          const income=await binance.signed("GET","/fapi/v1/income",{symbol:t.symbol,startTime,endTime,limit:1000});
          const rows=Array.isArray(income)?income.filter(x=>["REALIZED_PNL","COMMISSION","FUNDING_FEE"].includes(x.incomeType)):[], realized=rows.filter(x=>x.incomeType==="REALIZED_PNL");
          if(!realized.length) continue;
          net=rows.reduce((sum,x)=>sum+Number(x.income||0),0);
          const acct=await account(); wallet=Number(acct.totalWalletBalance);
          if(!Number.isFinite(net)||!Number.isFinite(wallet)) continue;
          await trades.updateOne({_id:t._id,resultNotificationPending:true},{$set:{realizedNetPnl:net,pnl:net,walletBalanceAtClose:wallet,pnlCalculatedAt:new Date()}});
        }
        const sent=await telegramResult((net>0?"WIN":net<0?"LOSS":"BREAKEVEN")+" "+t.side+" "+t.symbol+"\nNet PnL: "+net.toFixed(8)+" USDT\nWallet balance: "+(Number.isFinite(wallet)?wallet.toFixed(8):"N/A")+" USDT\nTrade ID: "+String(t._id));
        if(sent) await trades.updateOne({_id:t._id,resultNotificationPending:true},{$set:{resultNotificationPending:false,resultNotifiedAt:new Date()},$unset:{resultNotificationNextAttemptAt:""}});
      } catch(e) { console.error("TRADE_RESULT_NOTIFICATION_FAILED",t.symbol,e.message); }
    }
  }
  async function notifyPendingEntries() {
    const now=new Date(), pending=await trades.find({status:"OPEN",entryNotificationPending:true,$or:[{entryNotificationNextAttemptAt:{$exists:false}},{entryNotificationNextAttemptAt:{$lte:now}}]}).toArray();
    for(const t of pending) {
      const msg="ENTRY "+t.side+" "+t.symbol+"\nEntry: "+t.entryPrice+"\nSL: "+t.sl+"\nTP1: "+t.tp1+"\nTP2: "+t.tp2+"\nRSI: "+Number(t.rsi).toFixed(2)+"\nTrend "+C.TREND_TIMEFRAME+": "+t.trendSide+"\nTrade ID: "+String(t._id);
      await trades.updateOne({_id:t._id,entryNotificationPending:true},{$set:{entryNotificationLastAttemptAt:new Date(),entryNotificationNextAttemptAt:new Date(Date.now()+60000)},$inc:{entryNotificationAttempts:1}});
      const sent=await telegramEntry(msg);
      if(sent)await trades.updateOne({_id:t._id,entryNotificationPending:true},{$set:{entryNotificationPending:false,entryNotifiedAt:new Date()},$unset:{entryNotificationNextAttemptAt:""}});
    }
  }
  async function reconcileAndManage() {
    const live=await positions(), liveMap=new Map(live.map(p=>[p.symbol,p]));
    await notifyPendingResults();
    await notifyPendingEntries();
    const pending=await trades.find({status:"ENTRY_PENDING"}).toArray();
    for(const t of pending) {
      const p=liveMap.get(t.symbol);
      if(p) {
        try {
          try { await binance.signed("DELETE","/fapi/v1/algoOpenOrders",{symbol:t.symbol}); } catch(e) { console.error("RECOVERY_ALGO_CANCEL_WARN",t.symbol,e.message); }
          const recovered=buildProtection({side:t.side,entryPrice:Number(p.entryPrice)||Number(p.markPrice),atr:Number(t.atr),config:protectionConfigForDivergence(C,t.divergence),priceTick:rules.get(t.symbol)?.tickSize||0.00000001});
          await placeProtection({request:(method,path,params)=>binance.signed(method,path,params),symbol:t.symbol,side:t.side,sl:t.sl||recovered.sl,tp1:t.tp1||recovered.tp1,tp2:t.tp2||recovered.tp2,qty:Math.abs(Number(p.positionAmt)),stepSize:rules.get(t.symbol)?.stepSize||0,minQty:rules.get(t.symbol)?.minQty||0,config:C});
          await trades.updateOne({_id:t._id,status:"ENTRY_PENDING"},{$set:{status:"OPEN",openedAt:new Date(p.updateTime||Date.now()),recoveredAfterRestart:true,entryNotificationPending:true,entryNotificationNextAttemptAt:new Date(0)}});
          
        } catch(e) { console.error("PENDING_POSITION_PROTECTION_RECOVERY_FAILED",t.symbol,e.message); }
      } else if(Date.now()-new Date(t.createdAt||t.openedAt).getTime()>60000) {
        await trades.updateOne({_id:t._id,status:"ENTRY_PENDING"},{$set:{status:"ENTRY_FAILED",closedAt:new Date(),error:"NO_EXCHANGE_POSITION_AFTER_RECOVERY_WINDOW"}});
      }
    }
    const open=await trades.find({status:"OPEN"}).toArray();
    for(const t of open) {
      const p=liveMap.get(t.symbol);
      if(!p) {
        try { await binance.signed("DELETE","/fapi/v1/algoOpenOrders",{symbol:t.symbol}); } catch(e) { console.error("CLOSED_POSITION_ALGO_CLEANUP_WARN",t.symbol,e.message); }
        await trades.updateOne({_id:t._id,status:"OPEN"},{$set:{status:"CLOSED_EXTERNAL_OR_TPSL",closedAt:new Date(),closeReason:"POSITION_NOT_ON_EXCHANGE",resultNotificationPending:true,resultNotificationNextAttemptAt:new Date(0)}});
        continue;
      }
      if(t.protectionError) {
        if(t.closeRequestedAt && Date.now()-new Date(t.closeRequestedAt).getTime()<30000) continue;
        try {
          try { await binance.signed("DELETE","/fapi/v1/algoOpenOrders",{symbol:t.symbol}); } catch(e) { console.error("PROTECTION_RETRY_CANCEL_WARN",t.symbol,e.message); }
          await placeProtection({request:(method,path,params)=>binance.signed(method,path,params),symbol:t.symbol,side:t.side,sl:t.sl,tp1:t.tp1,tp2:t.tp2,qty:Math.abs(Number(p.positionAmt)),stepSize:rules.get(t.symbol)?.stepSize||0,minQty:rules.get(t.symbol)?.minQty||0,config:C});
          await trades.updateOne({_id:t._id,status:"OPEN"},{$unset:{protectionError:"",closeRequestedAt:""},$set:{protectionRestoredAt:new Date()}});
          
        } catch(e) {
          console.error("PROTECTION_RETRY_FAILED_CLOSE_ATTEMPT",t.symbol,e.message);
          try { await binance.signed("POST","/fapi/v1/order",{symbol:t.symbol,side:Number(p.positionAmt)>0?"SELL":"BUY",type:"MARKET",quantity:Math.abs(Number(p.positionAmt)).toFixed(precision(rules.get(t.symbol)?.stepSize||0.001)),reduceOnly:"true",newOrderRespType:"RESULT"}); } catch(closeError) { console.error("UNPROTECTED_POSITION_CLOSE_FAILED",t.symbol,closeError.message); }
          await trades.updateOne({_id:t._id,status:"OPEN"},{$set:{closeRequestedAt:new Date(),protectionError:e.message}});
          continue;
        }
      }
      if(Date.now()-new Date(t.openedAt).getTime()>=C.MAX_HOLD_HOURS*3600000 && (!t.closeRequestedAt || Date.now()-new Date(t.closeRequestedAt).getTime()>=30000)) {
        const amt=Number(p.positionAmt), side=amt>0?"SELL":"BUY", qty=Math.abs(amt);
        await binance.signed("POST","/fapi/v1/order",{symbol:t.symbol,side,type:"MARKET",quantity:qty.toFixed(precision(rules.get(t.symbol)?.stepSize||0.001)),reduceOnly:"true",newOrderRespType:"RESULT"});
        await binance.signed("DELETE","/fapi/v1/allOpenOrders",{symbol:t.symbol});
        try { await binance.signed("DELETE","/fapi/v1/algoOpenOrders",{symbol:t.symbol}); } catch(e) { console.error("ALGO_CANCEL_WARN",t.symbol,e.message); }
        await trades.updateOne({_id:t._id,status:"OPEN"},{$set:{closeRequestedAt:new Date(),closeReason:"MAX_HOLD_24H"}});
        
      }
    }
    const tracked=new Set(open.map(t=>t.symbol));
    for(const p of live) if(!tracked.has(p.symbol)) console.error("UNTRACKED_EXCHANGE_POSITION_SKIP_ENTRY",p.symbol,p.positionAmt);
  }
  async function tryEntry(symbol) {
    const r=rules.get(symbol);
    if(!r||r.status!=="TRADING"||r.contractType!=="PERPETUAL"||r.quoteAsset!==C.QUOTE_ASSET) return;
    const [trendRaw,entryRaw]=await Promise.all([
      binance.get("/fapi/v1/klines",{symbol,interval:C.TREND_TIMEFRAME,limit:Math.max(RSI_HISTORY_CANDLES,C.STRUCTURE_LOOKBACK_CANDLES+C.PIVOT_LEFT_BARS+C.PIVOT_RIGHT_BARS,C.TREND_EMA_PERIOD+1)}),
      binance.get("/fapi/v1/klines",{symbol,interval:C.ENTRY_TIMEFRAME,limit:Math.max(RSI_HISTORY_CANDLES,C.RSI_PERIOD+1,C.ATR_PERIOD+1)})
    ]);
    const now=Date.now()+binance.timeOffsetMs;
    const baseSignal=coreLogic({trendCandles:toCandles(trendRaw),entryCandles:toCandles(entryRaw),config:C,now});
    if(baseSignal.reason!=="DIVERGENCE_HISTORY_REQUIRED") return;
    const divergenceRaw=await binance.get("/fapi/v1/klines",{symbol,interval:C.DIVERGENCE_TIMEFRAME,limit:Math.max(RSI_HISTORY_CANDLES,C.DIVERGENCE_LOOKBACK_CANDLES+C.PIVOT_LEFT_BARS+C.PIVOT_RIGHT_BARS)});
    const signal=coreLogic({trendCandles:toCandles(trendRaw),entryCandles:toCandles(entryRaw),divergenceCandles:toCandles(divergenceRaw),config:C,now});
    if(!signal.side) return;
    const signalAt=new Date(signal.signalAt);
    if(!Number.isFinite(signalAt.getTime())) return;
    const existing=await trades.findOne({symbol,status:"OPEN"});
    if(existing) return;
    if(await trades.findOne({symbol,signalAt})) return;
    const live=await positions();
    if(live.some(p=>p.symbol===symbol)) { console.log("ENTRY_SKIP_EXCHANGE_POSITION",symbol); return; }
    const [algo,regularOrders]=await Promise.all([binance.signed("GET","/fapi/v1/openAlgoOrders",{symbol}),binance.signed("GET","/fapi/v1/openOrders",{symbol})]);
    if((Array.isArray(algo)&&algo.length)||(Array.isArray(regularOrders)&&regularOrders.length)) { console.log("ENTRY_SKIP_EXISTING_EXCHANGE_ORDER",symbol); return; }
    const utcStart=new Date(); utcStart.setUTCHours(0,0,0,0);
    const today=await trades.countDocuments({openedAt:{$gte:utcStart},status:{$nin:["ENTRY_FAILED","DRY_RUN"]}});
    if(today>=C.MAX_TRADES_PER_DAY) return;
    if((await trades.countDocuments({status:"OPEN"}))>=C.MAX_OPEN_POSITIONS) return;
    const acct=await account(), wallet=Number(acct.totalWalletBalance), available=Number(acct.availableBalance);
    if(!(wallet>0&&available>0)) { console.log("ENTRY_SKIP_NO_BALANCE",symbol); return; }
    const [premium,book]=await Promise.all([
      binance.get("/fapi/v1/premiumIndex",{symbol}),
      binance.get("/fapi/v1/ticker/bookTicker",{symbol})
    ]);
    const mark=Number(premium.markPrice);
    const veto=marketVeto({side:signal.side,fundingRate:premium.lastFundingRate,bidPrice:book.bidPrice,askPrice:book.askPrice,config:C});
    if(!(mark>0)||!veto.allowed) {
      console.log("ENTRY_VETO_"+(veto.reason==="OK"?"MARKET_DATA_INVALID":veto.reason),symbol);
      return;
    }
    const funding=veto.fundingRate, spreadBps=veto.spreadBps;
    let symbolMaxLeverage=leverageCaps.get(symbol);
    if(!symbolMaxLeverage) {
      try {
        const rows=await binance.signed("GET","/fapi/v1/leverageBracket",{symbol});
        const item=Array.isArray(rows)?rows[0]:rows, cap=Number(item?.brackets?.[0]?.initialLeverage);
        if(!(Number.isFinite(cap)&&cap>0))throw new Error("LEVERAGE_BRACKET_MISSING");
        symbolMaxLeverage=cap; leverageCaps.set(symbol,cap);
      } catch(e) { console.error("LEVERAGE_CAP_UNAVAILABLE",symbol,e.message); return; }
    }
    const symbolLeverage=Math.min(C.LEVERAGE,symbolMaxLeverage), sizingConfig={...C,LEVERAGE:symbolLeverage};
    const protection=buildProtection({side:signal.side,entryPrice:mark,atr:signal.atr,stopPrice:signal.swingStop,config:protectionConfigForDivergence(C,signal.divergence),priceTick:r.tickSize});
    const sizing=calculateOrderSizing({wallet,available,mark,stopDistance:protection.stopDistance,rules:r,config:sizingConfig});
    if(!sizing.ok) {
      console.log("ENTRY_SKIP_"+sizing.reason,symbol,"qty="+sizing.qty,"notional="+sizing.notional,"minNotional="+r.minNotional,"maxNotional="+sizing.maxNotional);
      return;
    }
    const qty=sizing.qty;
    try { splitQuantity({quantity:qty,stepSize:r.stepSize,minQty:r.minQty,config:C}); } catch(e) { console.log("ENTRY_SKIP_TP_SPLIT",symbol,e.message,"qty="+qty); return; }
    if(sizing.margin>available*0.95) { console.log("ENTRY_SKIP_MARGIN",symbol,"required="+sizing.margin,"available="+available); return; }
    const record={symbol,side:signal.side,status:"ENTRY_PENDING",signalAt,trendSide:signal.trendSide,trendEma:signal.trendEma,rsi:signal.rsi,atr:signal.atr,swingStop:signal.swingStop,divergence:signal.divergence,tp1RewardRisk:protection.tp1RewardRisk,tp2RewardRisk:protection.tp2RewardRisk,fundingRate:funding,spreadBps,requestedPrice:mark,sl:protection.sl,tp1:protection.tp1,tp2:protection.tp2,qty,openedAt:new Date(),createdAt:new Date(),maxHoldHours:C.MAX_HOLD_HOURS};
    if(C.DRY_RUN) { await trades.insertOne({...record,status:"DRY_RUN"}); console.log("DRY_RUN_SIGNAL",symbol,signal.side); return; }
    let inserted;
    try { inserted=await trades.insertOne(record); } catch(e) { if(e.code===11000) return; throw e; }
    try {
      await binance.signed("POST","/fapi/v1/leverage",{symbol,leverage:symbolLeverage});
      const order=await binance.signed("POST","/fapi/v1/order",{symbol,side:signal.side==="LONG"?"BUY":"SELL",type:"MARKET",quantity:qty.toFixed(precision(r.stepSize)),newOrderRespType:"RESULT"});
      const filled=Number(order.avgPrice)||mark;
      const actual=buildProtection({side:signal.side,entryPrice:filled,atr:signal.atr,stopPrice:signal.swingStop,config:protectionConfigForDivergence(C,signal.divergence),priceTick:r.tickSize});
      await trades.updateOne({_id:inserted.insertedId},{$set:{status:"OPEN",exchangeOrderId:order.orderId,entryPrice:filled,sl:actual.sl,tp1:actual.tp1,tp2:actual.tp2,qty:Number(order.executedQty)||qty,openedAt:new Date(order.updateTime||Date.now())}});
      try {
        await placeProtection({request:(method,path,params)=>binance.signed(method,path,params),symbol,side:signal.side,sl:actual.sl,tp1:actual.tp1,tp2:actual.tp2,qty:Number(order.executedQty)||qty,stepSize:r.stepSize,minQty:r.minQty,config:C});
      } catch(e) {
        console.error("TPSL_PLACEMENT_FAILED_FORCE_CLOSE",symbol,e.message);
        let pos=null;
        try { pos=(await positions()).find(p=>p.symbol===symbol)||null; } catch(positionError) { console.error("TPSL_FAILURE_POSITION_CHECK",symbol,positionError.message); }
        if(pos) {
          try { await binance.signed("POST","/fapi/v1/order",{symbol,side:Number(pos.positionAmt)>0?"SELL":"BUY",type:"MARKET",quantity:Math.abs(Number(pos.positionAmt)).toFixed(precision(r.stepSize)),reduceOnly:"true",newOrderRespType:"RESULT"}); } catch(closeError) { console.error("TPSL_FAILURE_FORCE_CLOSE",symbol,closeError.message); }
        }
        try { await binance.signed("DELETE","/fapi/v1/algoOpenOrders",{symbol}); } catch(cancelError) { console.error("TPSL_CLEANUP_WARN",symbol,cancelError.message); }
        let after=null, verified=false;
        try { after=(await positions()).find(p=>p.symbol===symbol)||null; verified=true; } catch(positionError) { console.error("TPSL_FAILURE_VERIFY_CLOSE",symbol,positionError.message); }
        if(verified&&!after) await trades.updateOne({_id:inserted.insertedId},{$set:{status:"PROTECTION_FAILED_CLOSED",closedAt:new Date(),closeReason:"PROTECTION_FAILED_FORCE_CLOSE",resultNotificationPending:true,resultNotificationNextAttemptAt:new Date(0),error:e.message}});
        else await trades.updateOne({_id:inserted.insertedId},{$set:{status:"OPEN",protectionError:e.message,closeRequestedAt:new Date(),error:e.message}});
        throw e;
      }
      await trades.updateOne({_id:inserted.insertedId,status:"OPEN"},{$set:{entryNotificationPending:true,entryNotificationNextAttemptAt:new Date(0),entryNotificationAttempts:0}});
      await notifyPendingEntries();
      console.log("ENTRY_OK",symbol,signal.side,"qty="+qty,"sl="+actual.sl,"tp1="+actual.tp1,"tp2="+actual.tp2);
    } catch(e) {
      const current=await trades.findOne({_id:inserted.insertedId});
      if(current?.status==="ENTRY_PENDING") await trades.updateOne({_id:inserted.insertedId},{$set:{lastError:e.message,lastAttemptAt:new Date()}});
      throw e;
    }
  }
  async function cycle() {
    if(busy||stopped) return;
    if(binance.rateLimitUntil>Date.now()) {
      if(rateLimitLoggedUntil!==binance.rateLimitUntil) {
        rateLimitLoggedUntil=binance.rateLimitUntil;
        console.error("BINANCE_RATE_LIMIT_COOLDOWN", "until="+new Date(binance.rateLimitUntil).toISOString());
      }
      return;
    }
    rateLimitLoggedUntil=0;
    busy=true;
    try {
      await reconcileAndManage();
      if(Date.now()-lastSymbolRefresh>=C.SYMBOL_REFRESH_MS) {
        symbols=await getTopSymbol({request:(method,path,params)=>binance.request(method,path,params,false),config:C});
        lastSymbolRefresh=Date.now(); console.log("TOP_SYMBOLS",symbols.length);
      }
      const live=await positions(), liveSet=new Set(live.map(p=>p.symbol));
      const open=await trades.find({status:"OPEN"}).toArray();
      const tracked=new Set(open.map(t=>t.symbol));
      const scanStartedAt=Date.now();
      let scanned=0, eligible=0, skipped=0, errors=0, rateLimited=false;
      const batchSize=10, batchCount=Math.ceil(symbols.length/batchSize);
      console.log("SCAN_CYCLE_START", "symbols="+symbols.length, "batchSize="+batchSize, "live="+liveSet.size, "tracked="+tracked.size);
      for(let batchStart=0;batchStart<symbols.length;batchStart+=batchSize) {
        if(stopped||rateLimited) break;
        const batchIndex=Math.floor(batchStart/batchSize)+1;
        const batchEnd=Math.min(batchStart+batchSize,symbols.length);
        const batchStartedAt=Date.now();
        let batchScanned=0, batchEligible=0, batchSkipped=0, batchErrors=0;
        for(let i=batchStart;i<batchEnd;i++) {
          if(stopped) break;
          const symbol=symbols[i];
          scanned++; batchScanned++;
          if(liveSet.has(symbol)||tracked.has(symbol)) {
            skipped++; batchSkipped++;
          } else {
            eligible++; batchEligible++;
            try { await tryEntry(symbol); }
            catch(e) {
              errors++; batchErrors++;
              console.error("SYMBOL_SCAN_ERROR",symbol,e.message);
              if(/BINANCE_(?:429|418)_/.test(e.message)) { rateLimited=true; break; }
            }
          }
        }
        console.log("SCAN_BATCH_COMPLETE", "batch="+batchIndex+"/"+batchCount,
          "scanned="+batchScanned, "range="+(batchStart+1)+"-"+batchEnd,
          "eligible="+batchEligible, "skipped="+batchSkipped, "errors="+batchErrors,
          "elapsedSec="+((Date.now()-batchStartedAt)/1000).toFixed(1));
        if(rateLimited||stopped||batchEnd>=symbols.length) break;
        await sleep(3000);
      }
      console.log("SCAN_CYCLE_COMPLETE", "scanned="+scanned+"/"+symbols.length,
        "eligible="+eligible, "skipped="+skipped, "errors="+errors,
        "rateLimited="+rateLimited, "elapsedSec="+((Date.now()-scanStartedAt)/1000).toFixed(1));
    } catch(e) { console.error("CYCLE_ERROR",e.stack||e.message); }
    finally { busy=false; }
  }
  const status=async()=> {
    const live=await positions(), open=await trades.countDocuments({status:"OPEN"});
    return "SIMPLE BOT OK\nTracked open trades: "+open+"\nExchange positions: "+live.length+"\nTop symbols: "+symbols.length+"\nRR: "+C.REWARD_RISK;
  };
  console.log("MULTI-TIMEFRAME DIVERGENCE BOT STARTED", "RR="+C.REWARD_RISK, "MAX_SYMBOLS="+C.MAX_SYMBOLS);
  await cycle();
  const timer=setInterval(()=>void cycle(),C.SCAN_INTERVAL_MS);
  const shutdown=async()=>{ if(stopped)return; stopped=true; clearInterval(timer); await mongo.close(); process.exit(0); };
  process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);
}
main().catch(async e=>{ console.error("FATAL",e.stack||e.message);  process.exitCode=1; });
