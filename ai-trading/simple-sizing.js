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
function gcd(a,b) {
  while(b){const t=b;b=a%b;a=t;}
  return a;
}
function commonStepSize(a,b) {
  if(!(Number.isFinite(a)&&a>0&&Number.isFinite(b)&&b>0)) return 0;
  const places=Math.max(precision(a),precision(b)),scale=10**places;
  const ai=Math.round(a*scale),bi=Math.round(b*scale);
  if(!(ai>0&&bi>0)) return 0;
  return Number((Math.abs(ai*bi)/gcd(ai,bi)/scale).toFixed(places));
}
function selectLeverageForNotional({wallet,config,brackets}) {
  const targetMargin=Number(wallet)*Number(config?.POSITION_MARGIN_PCT),requested=Number(config?.LEVERAGE);
  if(!(targetMargin>0&&requested>0&&Array.isArray(brackets)&&brackets.length))
    return{ok:false,reason:"LEVERAGE_BRACKET_INVALID"};
  const valid=[];
  for(const b of brackets) {
    const initial=Number(b.initialLeverage),floor=Number(b.notionalFloor||0),cap=Number(b.notionalCap);
    if(!(initial>0&&cap>0&&floor>=0&&cap>=floor))continue;
    const leverage=Math.min(requested,initial,cap/targetMargin),notional=targetMargin*leverage;
    if(leverage>0&&notional+1e-8>=floor&&notional<=cap+1e-8)
      valid.push({leverage,notionalCap:cap,notionalFloor:floor,initialLeverage:initial});
  }
  valid.sort((a,b)=>b.leverage-a.leverage||b.notionalCap-a.notionalCap);
  if(!valid.length)return{ok:false,reason:"NO_VALID_LEVERAGE_BRACKET",targetMargin};
  return{ok:true,...valid[0],targetMargin};
}
function calculateOrderSizing({wallet,available,mark,rules,config}) {
  const valid=[wallet,available,mark,config.LEVERAGE,config.POSITION_MARGIN_PCT,rules.stepSize,rules.minQty,rules.minNotional].every(Number.isFinite);
  if(!valid||wallet<=0||available<=0||mark<=0||config.LEVERAGE<=0||config.POSITION_MARGIN_PCT<=0||config.POSITION_MARGIN_PCT>1||rules.stepSize<=0||rules.minQty<0||rules.minNotional<0)
    return{ok:false,reason:"INVALID_SIZING_INPUT",qty:0,notional:0,maxNotional:0,margin:0,targetMargin:0};
  const targetMargin=wallet*config.POSITION_MARGIN_PCT;
  const tierCap=Number.isFinite(rules.maxNotional)&&rules.maxNotional>0?rules.maxNotional:Infinity;
  const maxNotional=Math.min(targetMargin*config.LEVERAGE,tierCap);
  const maxQty=Number.isFinite(rules.maxQty)&&rules.maxQty>0?rules.maxQty:Infinity;
  const targetQty=Math.min(maxNotional/mark,maxQty),qty=floorStep(targetQty,rules.stepSize);
  const notional=qty*mark,margin=notional/config.LEVERAGE,result={qty,notional,maxNotional,margin,targetMargin,targetQty};
  if(margin>available*.95+1e-10)return{ok:false,reason:"MARGIN",...result};
  if(!(qty>=rules.minQty))return{ok:false,reason:"MIN_QTY",...result};
  if(qty>maxQty+1e-10)return{ok:false,reason:"MAX_QTY",...result};
  if(notional+Math.max(1e-10,rules.minNotional*1e-10)<rules.minNotional)return{ok:false,reason:"MIN_NOTIONAL",...result};
  return{ok:true,reason:"OK",...result};
}
module.exports={calculateOrderSizing,floorStep,commonStepSize,selectLeverageForNotional};
