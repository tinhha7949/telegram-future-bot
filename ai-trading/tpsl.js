"use strict";
function precision(step){const s=String(step);if(s.includes("e-"))return Number(s.split("e-")[1]);return s.includes(".")?s.length-s.indexOf(".")-1:0}
function floorStep(n,step){if(!(step>0))throw Error("INVALID_LOT_STEP");return Math.floor((n+step*1e-10)/step)*step}
function splitQuantity({quantity,stepSize,minQty,config}){
 const d=precision(stepSize),total=Number(floorStep(Number(quantity),stepSize).toFixed(d));
 const tp1=Number(floorStep(total*config.TP1_CLOSE_PERCENT/100,stepSize).toFixed(d)),tp2=Number((total-tp1).toFixed(d));
 if(!(total>0)||tp1<minQty||tp2<minQty||Math.abs(tp1+tp2-total)>Math.max(1e-12,stepSize*1e-8))throw Error("TP_SPLIT_BELOW_BINANCE_MIN_QTY");
 return{total,tp1,tp2};
}
function buildProtection({side,entryPrice,atr,config,priceTick}){
 if(!["LONG","SHORT"].includes(side)||!(entryPrice>0)||!(atr>0))throw Error("INVALID_PROTECTION_INPUT");
 const distance=Math.min(entryPrice*config.SL_MAX_PCT/100,Math.max(entryPrice*config.SL_MIN_PCT/100,atr*config.SL_ATR_MULTIPLIER));
 const d=precision(priceTick),round=x=>priceTick>0?Number((Math.round(x/priceTick)*priceTick).toFixed(d)):x;
 const sl=round(side==="LONG"?entryPrice-distance:entryPrice+distance);
 const tp1=round(side==="LONG"?entryPrice+distance*config.TP1_REWARD_RISK:entryPrice-distance*config.TP1_REWARD_RISK);
 const tp2=round(side==="LONG"?entryPrice+distance*config.TP2_REWARD_RISK:entryPrice-distance*config.TP2_REWARD_RISK);
 if(!(sl>0&&tp1>0&&tp2>0)||(side==="LONG"?!(sl<entryPrice&&tp1>entryPrice&&tp2>tp1):!(sl>entryPrice&&tp1<entryPrice&&tp2<tp1)))throw Error("INVALID_PROTECTION_LEVELS");
 return{sl,tp1,tp2,tp:tp2,stopDistance:Math.abs(entryPrice-sl),tp1RewardRisk:config.TP1_REWARD_RISK,tp2RewardRisk:config.TP2_REWARD_RISK,rewardRisk:config.TP2_REWARD_RISK};
}
async function placeProtection({request,symbol,side,sl,tp1,tp2,qty,stepSize,minQty,config}){
 const split=splitQuantity({quantity:qty,stepSize,minQty,config}),closeSide=side==="LONG"?"SELL":"BUY",base={symbol,side:closeSide,workingType:"MARK_PRICE",algoType:"CONDITIONAL"},stamp=Date.now();
 const stop=await request("POST","/fapi/v1/algoOrder",{...base,type:"STOP_MARKET",triggerPrice:String(sl),closePosition:"true",clientAlgoId:"simple_sl_"+symbol+"_"+stamp});
 const first=await request("POST","/fapi/v1/algoOrder",{...base,type:"TAKE_PROFIT_MARKET",triggerPrice:String(tp1),quantity:split.tp1.toFixed(precision(stepSize)),reduceOnly:"true",clientAlgoId:"simple_tp1_"+symbol+"_"+stamp});
 const second=await request("POST","/fapi/v1/algoOrder",{...base,type:"TAKE_PROFIT_MARKET",triggerPrice:String(tp2),quantity:split.tp2.toFixed(precision(stepSize)),reduceOnly:"true",clientAlgoId:"simple_tp2_"+symbol+"_"+stamp});
 return{stop,tp1:first,tp2:second,quantities:split};
}
module.exports={buildProtection,splitQuantity,placeProtection};
