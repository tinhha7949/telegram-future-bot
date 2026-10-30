"use strict";
const crypto = require("node:crypto");
function precision(step){const s=String(step);if(s.includes("e-"))return Number(s.split("e-")[1]);return s.includes(".")?s.length-s.indexOf(".")-1:0}
function floorStep(n,step){if(!(step>0))throw Error("INVALID_LOT_STEP");return Math.floor((n+step*1e-10)/step)*step}
function splitQuantity({quantity,stepSize,minQty,config}){
 const d=precision(stepSize),total=Number(floorStep(Number(quantity),stepSize).toFixed(d));
 const tp1=Number(floorStep(total*config.TP1_CLOSE_PERCENT/100,stepSize).toFixed(d)),tp2=Number((total-tp1).toFixed(d));
 if(!(total>0)||tp1<minQty||tp2<minQty||Math.abs(tp1+tp2-total)>Math.max(1e-12,stepSize*1e-8))throw Error("TP_SPLIT_BELOW_BINANCE_MIN_QTY");
 return{total,tp1,tp2};
}
function buildProtection({side,entryPrice,atr,config,priceTick}){
 if(!["LONG","SHORT"].includes(side)||!Number.isFinite(entryPrice)||!(entryPrice>0)||!Number.isFinite(atr)||!(atr>0)||!Number.isFinite(priceTick)||!(priceTick>0))throw Error("INVALID_PROTECTION_INPUT");
 const distance=Math.min(entryPrice*config.SL_MAX_PCT/100,Math.max(entryPrice*config.SL_MIN_PCT/100,atr*config.SL_ATR_MULTIPLIER));
 const d=precision(priceTick),down=x=>Number((Math.floor(x/priceTick+1e-10)*priceTick).toFixed(d)),up=x=>Number((Math.ceil(x/priceTick-1e-10)*priceTick).toFixed(d));
 let sl=side==="LONG"?down(entryPrice-distance):up(entryPrice+distance);
 let tp1=side==="LONG"?up(entryPrice+distance*config.TP1_REWARD_RISK):down(entryPrice-distance*config.TP1_REWARD_RISK);
 let tp2=side==="LONG"?up(entryPrice+distance*config.TP2_REWARD_RISK):down(entryPrice-distance*config.TP2_REWARD_RISK);
 if(side==="LONG"&&tp2<=tp1)tp2=Number((tp1+priceTick).toFixed(d));
 if(side==="SHORT"&&tp2>=tp1)tp2=Number((tp1-priceTick).toFixed(d));
 if(!(sl>0&&tp1>0&&tp2>0)||(side==="LONG"?!(sl<entryPrice&&tp1>entryPrice&&tp2>tp1):!(sl>entryPrice&&tp1<entryPrice&&tp2<tp1)))throw Error("INVALID_PROTECTION_LEVELS");
 return{sl,tp1,tp2,tp:tp2,stopDistance:Math.abs(entryPrice-sl),tp1RewardRisk:config.TP1_REWARD_RISK,tp2RewardRisk:config.TP2_REWARD_RISK,rewardRisk:config.TP2_REWARD_RISK};
}
function clientAlgoId(kind){
 const id="s"+kind+Date.now().toString(36)+crypto.randomBytes(5).toString("hex");
 if(id.length>=36)throw Error("CLIENT_ALGO_ID_TOO_LONG");
 return id;
}
async function placeProtection({request,symbol,side,sl,tp1,tp2,qty,stepSize,minQty,config}){
 const split=splitQuantity({quantity:qty,stepSize,minQty,config}),closeSide=side==="LONG"?"SELL":"BUY",base={symbol,side:closeSide,workingType:"MARK_PRICE",algoType:"CONDITIONAL"};
 const stop=await request("POST","/fapi/v1/algoOrder",{...base,type:"STOP_MARKET",triggerPrice:String(sl),closePosition:"true",clientAlgoId:clientAlgoId("sl")});
 const first=await request("POST","/fapi/v1/algoOrder",{...base,type:"TAKE_PROFIT_MARKET",triggerPrice:String(tp1),quantity:split.tp1.toFixed(precision(stepSize)),reduceOnly:"true",clientAlgoId:clientAlgoId("1")});
 const second=await request("POST","/fapi/v1/algoOrder",{...base,type:"TAKE_PROFIT_MARKET",triggerPrice:String(tp2),quantity:split.tp2.toFixed(precision(stepSize)),reduceOnly:"true",clientAlgoId:clientAlgoId("2")});
 return{stop,tp1:first,tp2:second,quantities:split};
}
module.exports={buildProtection,splitQuantity,placeProtection};
