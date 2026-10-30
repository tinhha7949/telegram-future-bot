"use strict";

function precision(step) {
  const value=String(step).toLowerCase();
  if(value.includes("e-")) return Number(value.split("e-")[1]);
  return value.includes(".")?value.length-value.indexOf(".")-1:0;
}
function floorStep(value,step) {
  return Math.floor((value+step*1e-10)/step)*step;
}
function ceilStep(value,step) {
  return Math.ceil((value-step*1e-10)/step)*step;
}

/**
 * Size a market entry without violating either the configured risk budget or
 * the wallet-based notional cap. If flooring falls just below Binance's
 * market minimum, raise by the smallest lot step only when both caps permit it.
 */
function sizePosition({riskBudget,stopDistance,maxNotional,price,stepSize,minQty,minNotional=0}) {
  const values=[riskBudget,stopDistance,maxNotional,price,stepSize,minQty,minNotional];
  if(values.some(v=>!Number.isFinite(Number(v))) ||
     !(riskBudget>0&&stopDistance>0&&maxNotional>0&&price>0&&stepSize>0&&minQty>=0&&minNotional>=0)) {
    return {ok:false,reason:"INVALID_SIZING_INPUT",qty:0,notional:0,riskQtyMax:0,maxQty:0};
  }
  const riskQtyMax=riskBudget/stopDistance;
  const capQty=maxNotional/price;
  const maxQty=Math.min(riskQtyMax,capQty);
  let qty=floorStep(maxQty,stepSize);
  const round=n=>Number(n.toFixed(precision(stepSize)));
  qty=round(qty);
  if(qty<minQty) return {ok:false,reason:"MIN_QTY_ABOVE_ALLOWED_SIZE",qty,notional:qty*price,riskQtyMax,maxQty};
  let notional=qty*price;
  if(minNotional>0&&notional+Math.max(1e-10,minNotional*1e-10)<minNotional) {
    qty=round(ceilStep(minNotional/price,stepSize));
    notional=qty*price;
    const tolerance=Math.max(stepSize*1e-8,1e-12);
    if(qty>maxQty+tolerance) {
      return {ok:false,reason:"MIN_NOTIONAL_ABOVE_RISK_OR_POSITION_CAP",qty,notional,riskQtyMax,maxQty};
    }
  }
  if(qty<minQty) return {ok:false,reason:"MIN_QTY_ABOVE_ALLOWED_SIZE",qty,notional,riskQtyMax,maxQty};
  if(qty*stopDistance>riskBudget+Math.max(1e-10,riskBudget*1e-10)) {
    return {ok:false,reason:"RISK_BUDGET_EXCEEDED",qty,notional,riskQtyMax,maxQty};
  }
  if(notional>maxNotional+Math.max(1e-10,maxNotional*1e-10)) {
    return {ok:false,reason:"MAX_POSITION_NOTIONAL_EXCEEDED",qty,notional,riskQtyMax,maxQty};
  }
  return {ok:true,reason:"OK",qty,notional,riskQtyMax,maxQty};
}

module.exports={sizePosition};
