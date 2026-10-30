"use strict";
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");
const { loadSimpleConfig } = require("./ai-trading/simple-config");
const { coreLogic } = require("./ai-trading/coreLogic");
const { getTopSymbol } = require("./ai-trading/getTopSymbol");
const { buildProtection, splitQuantity, placeProtection } = require("./ai-trading/tpsl");
const { calculateOrderSizing } = require("./ai-trading/simple-sizing");
const C = loadSimpleConfig();
const BASE = "https://fapi.binance.com";
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
    if (!this.key || !this.secret) throw new Error("BINANCE_KEY_AND_SECRET_REQUIRED");
  }
  async request(method,path,params={},signed=false) {
    const p={...params};
    if (signed) { p.timestamp=Date.now(); p.recvWindow=C.BINANCE_RECV_WINDOW_MS; }
    const query=new URLSearchParams(Object.entries(p).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)])).toString();
    const sig=signed?crypto.createHmac("sha256",this.secret).update(query).digest("hex"):"";
    const url=BASE+path+(query?"?"+query+(signed?"&signature="+sig:""):"");
    const res=await fetch(url,{method,headers:{"X-MBX-APIKEY":this.key},signal:AbortSignal.timeout(C.BINANCE_HTTP_TIMEOUT_MS)});
    const body=await res.text(); let data;
    try { data=JSON.parse(body); } catch { throw new Error("BINANCE_BAD_JSON_"+res.status); }
    if (!res.ok) throw new Error("BINANCE_"+res.status+"_"+(data.msg||data.code||"REQUEST_FAILED"));
    return data;
  }
  get(path,params={}) { return this.request("GET",path,params,false); }
  signed(method,path,params={}) { return this.request(method,path,params,true); }
}
function toCandles(raw) { return raw.map(k=>({high:+k[2],low:+k[3],close:+k[4],closeTime:+k[6]})); }
async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  const binance=new Binance(), mongo=new MongoClient(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000,maxPoolSize:5});
  await mongo.connect();
  const db=mongo.db(C.MONGO_DB_NAME), trades=db.collection(C.MONGO_TRADES_COLLECTION), state=db.collection(C.MONGO_STATE_COLLECTION);
  await trades.createIndex({symbol:1,status:1},{name:"simple_active_symbol",partialFilterExpression:{status:"OPEN"}});
  await trades.createIndex({openedAt:1},{name:"simple_opened_at"});
  await trades.createIndex({symbol:1,signalAt:1},{name:"simple_signal_once",unique:true});
  await state.updateOne({_id:"runtime"},{$set:{lastStartedAt:new Date(),strategy:"EMA100_RSI14"}},{upsert:true});
  const info=await binance.get("/fapi/v1/exchangeInfo");
  const rules=new Map();
  for(const s of info.symbols||[]) {
    const f=Object.fromEntries((s.filters||[]).map(x=>[x.filterType,x]));
    const lot=f.LOT_SIZE||{}, marketLot=f.MARKET_LOT_SIZE||lot, notionalFilter=f.NOTIONAL||f.MIN_NOTIONAL||{};
    rules.set(s.symbol,{status:s.status,contractType:s.contractType,quoteAsset:s.quoteAsset,
      tickSize:Number(f.PRICE_FILTER?.tickSize||0.00000001),stepSize:Number(lot.stepSize||0),
      minQty:Number(lot.minQty||0),marketStepSize:Number(marketLot.stepSize||0),
      marketMinQty:Number(marketLot.minQty||0),minNotional:Number(notionalFilter.minNotional||notionalFilter.notional||5)});
  }
  const mode=await binance.signed("GET","/fapi/v1/positionSide/dual");
  if (mode.dualSidePosition===true) throw new Error("HEDGE_MODE_UNSUPPORTED_SWITCH_TO_ONE_WAY_BEFORE_START");
  let stopped=false, busy=false, symbols=[], lastSymbolRefresh=0;
  async function positions() { return (await binance.signed("GET","/fapi/v2/positionRisk")).filter(p=>Math.abs(Number(p.positionAmt))>0); }
  async function account() { return binance.signed("GET","/fapi/v2/account"); }
  async function notifyPendingResults() {
    const pendingResults=await trades.find({resultNotificationPending:true}).toArray();
    for(const t of pendingResults) {
      try {
        const startTime=new Date(t.openedAt).getTime(), endTime=new Date(t.closedAt||Date.now()).getTime();
        const income=await binance.signed("GET","/fapi/v1/income",{symbol:t.symbol,startTime,endTime,limit:1000});
        const rows=Array.isArray(income)?income.filter(x=>["REALIZED_PNL","COMMISSION","FUNDING_FEE"].includes(x.incomeType)):[];
        if(!rows.length) continue;
        const net=rows.reduce((sum,x)=>sum+Number(x.income||0),0), acct=await account(), wallet=Number(acct.totalWalletBalance);
        if(!Number.isFinite(net)||!Number.isFinite(wallet)) continue;
        const sent=await telegramResult((net>=0?"WIN":"LOSS")+" "+t.side+" "+t.symbol+"\nNet PnL: "+net.toFixed(8)+" USDT\nWallet balance: "+wallet.toFixed(8)+" USDT");
        if(sent) await trades.updateOne({_id:t._id,resultNotificationPending:true},{$set:{resultNotificationPending:false,resultNotifiedAt:new Date(),realizedNetPnl:net,walletBalanceAtClose:wallet}});
      } catch(e) { console.error("TRADE_RESULT_NOTIFICATION_FAILED",t.symbol,e.message); }
    }
  }
  async function reconcileAndManage() {
    const live=await positions(), liveMap=new Map(live.map(p=>[p.symbol,p]));
    await notifyPendingResults();
    const pending=await trades.find({status:"ENTRY_PENDING"}).toArray();
    for(const t of pending) {
      const p=liveMap.get(t.symbol);
      if(p) {
        try {
          try { await binance.signed("DELETE","/fapi/v1/algoOpenOrders",{symbol:t.symbol}); } catch(e) { console.error("RECOVERY_ALGO_CANCEL_WARN",t.symbol,e.message); }
          const recovered=buildProtection({side:t.side,entryPrice:Number(p.entryPrice)||Number(p.markPrice),atr:Number(t.atr),config:C,priceTick:rules.get(t.symbol)?.tickSize||0.00000001});
          await placeProtection({request:(method,path,params)=>binance.signed(method,path,params),symbol:t.symbol,side:t.side,sl:t.sl||recovered.sl,tp1:t.tp1||recovered.tp1,tp2:t.tp2||recovered.tp2,qty:Math.abs(Number(p.positionAmt)),stepSize:rules.get(t.symbol)?.stepSize||0,minQty:rules.get(t.symbol)?.minQty||0,config:C});
          await trades.updateOne({_id:t._id,status:"ENTRY_PENDING"},{$set:{status:"OPEN",openedAt:new Date(p.updateTime||Date.now()),recoveredAfterRestart:true}});
          
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
        await trades.updateOne({_id:t._id,status:"OPEN"},{$set:{status:"CLOSED_EXTERNAL_OR_TPSL",closedAt:new Date(),closeReason:"POSITION_NOT_ON_EXCHANGE"}});
        await trades.updateOne({_id:t._id,status:"CLOSED_EXTERNAL_OR_TPSL"},{$set:{resultNotificationPending:true}});
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
      binance.get("/fapi/v1/klines",{symbol,interval:"4h",limit:C.TREND_EMA_PERIOD+3}),
      binance.get("/fapi/v1/klines",{symbol,interval:"1m",limit:Math.max(C.RSI_PERIOD,C.ATR_PERIOD)+5})
    ]);
    const signal=coreLogic({trendCandles:toCandles(trendRaw),entryCandles:toCandles(entryRaw),config:C});
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
    const mark=Number((await binance.get("/fapi/v1/premiumIndex",{symbol})).markPrice);
    if(!(mark>0)) return;
    const protection=buildProtection({side:signal.side,entryPrice:mark,atr:signal.atr,config:C,priceTick:r.tickSize});
    const sizing=calculateOrderSizing({wallet,available,mark,stopDistance:protection.stopDistance,rules:r,config:C});
    if(!sizing.ok) {
      console.log("ENTRY_SKIP_"+sizing.reason,symbol,"qty="+sizing.qty,"notional="+sizing.notional,"minNotional="+r.minNotional,"maxNotional="+sizing.maxNotional);
      return;
    }
    const qty=sizing.qty;
    try { splitQuantity({quantity:qty,stepSize:r.stepSize,minQty:r.minQty,config:C}); } catch(e) { console.log("ENTRY_SKIP_TP_SPLIT",symbol,e.message,"qty="+qty); return; }
    if(sizing.margin>available*0.95) { console.log("ENTRY_SKIP_MARGIN",symbol,"required="+sizing.margin,"available="+available); return; }
    const record={symbol,side:signal.side,status:"ENTRY_PENDING",signalAt,trendSide:signal.trendSide,trendEma:signal.trendEma,rsi:signal.rsi,atr:signal.atr,requestedPrice:mark,sl:protection.sl,tp1:protection.tp1,tp2:protection.tp2,qty,openedAt:new Date(),createdAt:new Date(),maxHoldHours:C.MAX_HOLD_HOURS};
    if(C.DRY_RUN) { await trades.insertOne({...record,status:"DRY_RUN"}); console.log("DRY_RUN_SIGNAL",symbol,signal.side); return; }
    let inserted;
    try { inserted=await trades.insertOne(record); } catch(e) { if(e.code===11000) return; throw e; }
    try {
      await binance.signed("POST","/fapi/v1/leverage",{symbol,leverage:C.LEVERAGE});
      const order=await binance.signed("POST","/fapi/v1/order",{symbol,side:signal.side==="LONG"?"BUY":"SELL",type:"MARKET",quantity:qty.toFixed(precision(r.stepSize)),newOrderRespType:"RESULT"});
      const filled=Number(order.avgPrice)||mark;
      const actual=buildProtection({side:signal.side,entryPrice:filled,atr:signal.atr,config:C,priceTick:r.tickSize});
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
        if(verified&&!after) await trades.updateOne({_id:inserted.insertedId},{$set:{status:"PROTECTION_FAILED_CLOSED",closedAt:new Date(),error:e.message}});
        else await trades.updateOne({_id:inserted.insertedId},{$set:{status:"OPEN",protectionError:e.message,closeRequestedAt:new Date(),error:e.message}});
        throw e;
      }
      await telegramEntry("ENTRY "+signal.side+" "+symbol+"\nEntry: "+filled+"\nSL: "+actual.sl+"\nTP1: "+actual.tp1+" ("+C.TP1_CLOSE_PERCENT+"% @ "+C.TP1_REWARD_RISK+"R)\nTP2: "+actual.tp2+" ("+C.TP2_CLOSE_PERCENT+"% @ "+C.TP2_REWARD_RISK+"R)\nRSI14: "+signal.rsi.toFixed(2)+"\nTrend 4H: "+signal.trendSide);
      console.log("ENTRY_OK",symbol,signal.side,"qty="+qty,"sl="+actual.sl,"tp1="+actual.tp1,"tp2="+actual.tp2);
    } catch(e) {
      const current=await trades.findOne({_id:inserted.insertedId});
      if(current?.status==="ENTRY_PENDING") await trades.updateOne({_id:inserted.insertedId},{$set:{lastError:e.message,lastAttemptAt:new Date()}});
      throw e;
    }
  }
  async function cycle() {
    if(busy||stopped) return; busy=true;
    try {
      await reconcileAndManage();
      if(Date.now()-lastSymbolRefresh>=C.SYMBOL_REFRESH_MS) {
        symbols=await getTopSymbol({request:(method,path,params)=>binance.request(method,path,params,false),config:C});
        lastSymbolRefresh=Date.now(); console.log("TOP_SYMBOLS",symbols.length);
      }
      const live=await positions(), liveSet=new Set(live.map(p=>p.symbol));
      const open=await trades.find({status:"OPEN"}).toArray();
      const tracked=new Set(open.map(t=>t.symbol));
      for(const symbol of symbols) {
        if(stopped) break;
        if(liveSet.has(symbol)||tracked.has(symbol)) continue;
        try { await tryEntry(symbol); } catch(e) { console.error("SYMBOL_SCAN_ERROR",symbol,e.message); }
      }
    } catch(e) { console.error("CYCLE_ERROR",e.stack||e.message); }
    finally { busy=false; }
  }
  const status=async()=> {
    const live=await positions(), open=await trades.countDocuments({status:"OPEN"});
    return "SIMPLE BOT OK\nTracked open trades: "+open+"\nExchange positions: "+live.length+"\nTop symbols: "+symbols.length+"\nRR: "+C.REWARD_RISK;
  };
  console.log("SIMPLE EMA100/RSI14 BOT STARTED", "RR="+C.REWARD_RISK, "MAX_SYMBOLS="+C.MAX_SYMBOLS);
  await cycle();
  const timer=setInterval(()=>void cycle(),C.SCAN_INTERVAL_MS);
  const shutdown=async()=>{ if(stopped)return; stopped=true; clearInterval(timer); await mongo.close(); process.exit(0); };
  process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);
}
main().catch(async e=>{ console.error("FATAL",e.stack||e.message);  process.exitCode=1; });
