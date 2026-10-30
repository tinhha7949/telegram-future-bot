"use strict";
function precision(step) {
  const s=String(step);
  if(s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.length-s.indexOf(".")-1 : 0;
}
function floorStep(value,step) {
  if(!(Number.isFinite(value)&&value>=0&&Number.isFinite(step)&&step>0)) return 0;
  const units=Math.floor((value+step*1e-10)/step);
  return Number((units*step).toFixed(precision(step)));
}
function calculateOrderSizing({wallet,available,mark,stopDistance,rules,config}) {
  const valid=[wallet,available,mark,stopDistance,config.LEVERAGE,config.RISK_PER_TRADE_PCT,config.MAX_POSITION_BALANCE_PCT,rules.stepSize,rules.minQty,rules.minNotional]
    .every(Number.isFinite);
  if(!valid||wallet<=0||available<=0||mark<=0||stopDistance<=0||config.LEVERAGE<=0||config.RISK_PER_TRADE_PCT<=0||config.MAX_POSITION_BALANCE_PCT<=0||rules.stepSize<=0||rules.minQty<0||rules.minNotional<0)
    return {ok:false,reason:"INVALID_SIZING_INPUT",qty:0,notional:0,maxNotional:0,margin:0};
  const riskBudget=available*config.RISK_PER_TRADE_PCT;
  const maxNotional=wallet*config.MAX_POSITION_BALANCE_PCT*config.LEVERAGE;
  const riskQty=riskBudget/stopDistance;
  const positionQty=maxNotional/mark;
  const qty=floorStep(Math.min(riskQty,positionQty),rules.stepSize);
  const notional=qty*mark,margin=notional/config.LEVERAGE;
  if(!(qty>=rules.minQty)) return {ok:false,reason:"MIN_QTY",qty,notional,maxNotional,margin,riskBudget,riskQty,positionQty};
  if(notional+Math.max(1e-10,rules.minNotional*1e-10)<rules.minNotional)
    return {ok:false,reason:"MIN_NOTIONAL",qty,notional,maxNotional,margin,riskBudget,riskQty,positionQty};
  if(margin>available*0.95+1e-10)
    return {ok:false,reason:"MARGIN",qty,notional,maxNotional,margin,riskBudget,riskQty,positionQty};
  return {ok:true,reason:"OK",qty,notional,maxNotional,margin,riskBudget,riskQty,positionQty};
}
module.exports={calculateOrderSizing,floorStep};
