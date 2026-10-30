"use strict";
function buildProtection({side,entryPrice,atr,config,priceTick}) {
  if (!['LONG','SHORT'].includes(side) || !(entryPrice>0) || !(atr>0)) throw new Error('INVALID_PROTECTION_INPUT');
  const distance=Math.min(entryPrice*config.SL_MAX_PCT/100,Math.max(entryPrice*config.SL_MIN_PCT/100,atr*config.SL_ATR_MULTIPLIER));
  const digits=priceTick>0?(String(priceTick).split('.')[1]||'').length:8;
  const round=x=>priceTick>0?Number((Math.round(x/priceTick)*priceTick).toFixed(digits)):x;
  const sl=round(side==='LONG'?entryPrice-distance:entryPrice+distance);
  const tp=round(side==='LONG'?entryPrice+distance*config.REWARD_RISK:entryPrice-distance*config.REWARD_RISK);
  if (!(sl>0&&tp>0) || (side==='LONG'?!(sl<entryPrice&&tp>entryPrice):!(sl>entryPrice&&tp<entryPrice))) throw new Error('INVALID_PROTECTION_LEVELS');
  return {sl,tp,stopDistance:Math.abs(entryPrice-sl),rewardRisk:config.REWARD_RISK};
}
async function placeProtection({request,symbol,side,sl,tp}) {
  const closeSide=side==='LONG'?'SELL':'BUY';
  const base={symbol,side:closeSide,closePosition:'true',workingType:'MARK_PRICE',algoType:'CONDITIONAL'};
  const stop=await request('POST','/fapi/v1/algoOrder',{...base,type:'STOP_MARKET',triggerPrice:String(sl),clientAlgoId:'simple_sl_'+symbol+'_'+Date.now()});
  const take=await request('POST','/fapi/v1/algoOrder',{...base,type:'TAKE_PROFIT_MARKET',triggerPrice:String(tp),clientAlgoId:'simple_tp_'+symbol+'_'+Date.now()});
  return {stop,take};
}
module.exports={buildProtection,placeProtection};
