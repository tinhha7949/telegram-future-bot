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
function calculateOrderSizing({wallet,available,mark,rules,config}) {
  const valid=[wallet,available,mark,config.LEVERAGE,config.POSITION_MARGIN_PCT,rules.stepSize,rules.minQty,rules.minNotional]
    .every(Number.isFinite);
  if(!valid||wallet<=0||available<=0||mark<=0||config.LEVERAGE<=0||config.POSITION_MARGIN_PCT<=0||config.POSITION_MARGIN_PCT>1||rules.stepSize<=0||rules.minQty<0||rules.minNotional<0)
    return {ok:false,reason:"INVALID_SIZING_INPUT",qty:0,notional:0,maxNotional:0,margin:0,targetMargin:0};
  // Always size from the full Futures wallet balance. Never use available balance
  // or subtract margin committed to other open positions from this target.
  const targetMargin=wallet*config.POSITION_MARGIN_PCT;
  const maxNotional=targetMargin*config.LEVERAGE;
  const targetQty=maxNotional/mark;
  const qty=floorStep(targetQty,rules.stepSize);
  const notional=qty*mark,margin=notional/config.LEVERAGE;
  const result={qty,notional,maxNotional,margin,targetMargin,targetQty};
  if(targetMargin>available*0.95+1e-10)
    return {ok:false,reason:"MARGIN",...result};
  if(!(qty>=rules.minQty))
    return {ok:false,reason:"MIN_QTY",...result};
  if(notional+Math.max(1e-10,rules.minNotional*1e-10)<rules.minNotional)
    return {ok:false,reason:"MIN_NOTIONAL",...result};
  return {ok:true,reason:"OK",...result};
}
module.exports={calculateOrderSizing,floorStep};
