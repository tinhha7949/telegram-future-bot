"use strict";
const crypto = require("node:crypto");

function breakEvenTriggerPrice({side,entryPrice,tp1,progressPct}) {
  if (!["LONG","SHORT"].includes(side) || !Number.isFinite(entryPrice) || !(entryPrice>0) || !Number.isFinite(tp1) || !(tp1>0) || !Number.isFinite(progressPct) || !(progressPct>0&&progressPct<=100)) throw Error("INVALID_BREAK_EVEN_INPUT");
  if (side==="LONG" ? !(tp1>entryPrice) : !(tp1<entryPrice)) throw Error("INVALID_BREAK_EVEN_TP1_SIDE");
  return entryPrice+(tp1-entryPrice)*progressPct/100;
}
function hasReachedBreakEvenTrigger({side,markPrice,entryPrice,tp1,progressPct}) {
  if (!Number.isFinite(markPrice) || !(markPrice>0)) return false;
  const trigger=breakEvenTriggerPrice({side,entryPrice,tp1,progressPct});
  return side==="LONG" ? markPrice>=trigger : markPrice<=trigger;
}
function isClosePositionStop(order,closeSide) {
  return (order.orderType||order.type)==="STOP_MARKET" &&
    String(order.closePosition).toLowerCase()==="true" &&
    order.side===closeSide && order.algoId!==undefined && order.algoId!==null;
}
function samePrice(a,b) {
  const x=Number(a),y=Number(b);
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=Math.max(1e-12,Math.abs(y)*1e-10);
}
function formatBreakevenStopPrice({entryPrice,side,priceTick}) {
  if (!["LONG","SHORT"].includes(side) || !Number.isFinite(entryPrice) || !(entryPrice>0) || typeof priceTick!=="string" || !/^\d+(?:\.\d+)?$/.test(priceTick) || !(Number(priceTick)>0)) throw Error("BREAK_EVEN_PRICE_FILTER_INVALID");
  const decimals=(priceTick.split(".")[1]||"").length;
  const scale=10n**BigInt(decimals+8);
  const tick=BigInt(Number(priceTick).toFixed(decimals+8).replace(".",""));
  const entry=BigInt(entryPrice.toFixed(decimals+8).replace(".",""));
  if (tick<=0n) throw Error("BREAK_EVEN_PRICE_FILTER_INVALID");
  const units=side==="LONG" ? entry/tick : (entry+tick-1n)/tick;
  const value=units*tick;
  const whole=value/scale, fraction=(value%scale).toString().padStart(decimals+8,"0").slice(0,decimals+8);
  const raw=decimals ? (whole.toString()+"."+fraction.slice(0,decimals)).replace(/\.?0+$/,"") : whole.toString();
  const price=Number(raw);
  if (!(Number.isFinite(price)&&price>0)) throw Error("BREAK_EVEN_ROUNDED_STOP_INVALID");
  return raw;
}
function clientAlgoId() {
  return "sbe"+Date.now().toString(36)+crypto.randomBytes(5).toString("hex");
}
async function moveStopToBreakeven({request,symbol,side,entryPrice,markPrice,tp1,progressPct,priceTick}) {
  const triggered=hasReachedBreakEvenTrigger({side,markPrice,entryPrice,tp1,progressPct});
  if (!triggered) return {triggered:false,complete:false,algoId:null};
  const closeSide=side==="LONG"?"SELL":"BUY";
  const stopPrice=formatBreakevenStopPrice({entryPrice,side,priceTick});
  let orders=await request("GET","/fapi/v1/openAlgoOrders",{symbol});
  if (!Array.isArray(orders)) throw Error("BREAK_EVEN_OPEN_ALGO_ORDERS_INVALID");
  let stops=orders.filter(o=>isClosePositionStop(o,closeSide));
  let be=stops.find(o=>samePrice(o.triggerPrice,stopPrice));
  if (!be) {
    // Binance rejects two same-direction closePosition conditional orders.
    // Swap the existing closePosition SL, then restore it if the BE order cannot be confirmed.
    const previousStops=stops.slice();
    for (const old of previousStops) {
      await request("DELETE","/fapi/v1/algoOrder",{symbol,algoId:old.algoId});
    }
    let created;
    try {
      created=await request("POST","/fapi/v1/algoOrder",{
        symbol,side:closeSide,type:"STOP_MARKET",algoType:"CONDITIONAL",
        workingType:"MARK_PRICE",triggerPrice:stopPrice,closePosition:"true",
        clientAlgoId:clientAlgoId()
      });
      if (created?.algoId===undefined||created?.algoId===null) throw Error("BREAK_EVEN_STOP_CREATE_UNCONFIRMED");
      orders=await request("GET","/fapi/v1/openAlgoOrders",{symbol});
      if (!Array.isArray(orders)) throw Error("BREAK_EVEN_VERIFY_ORDERS_INVALID");
      be=orders.find(o=>String(o.algoId)===String(created.algoId)&&isClosePositionStop(o,closeSide)&&samePrice(o.triggerPrice,stopPrice));
      if (!be) throw Error("BREAK_EVEN_STOP_VERIFY_FAILED");
      stops=orders.filter(o=>isClosePositionStop(o,closeSide));
    } catch(error) {
      // Roll back to the original protective stop if the BE replacement failed.
      if (previousStops.length) {
        const restore=previousStops[0];
        try {
          const restored=await request("POST","/fapi/v1/algoOrder",{
            symbol,side:closeSide,type:"STOP_MARKET",algoType:"CONDITIONAL",
            workingType:restore.workingType||"MARK_PRICE",triggerPrice:String(restore.triggerPrice),
            closePosition:"true",clientAlgoId:clientAlgoId()
          });
          if (restored?.algoId===undefined||restored?.algoId===null) throw Error("RESTORE_STOP_CREATE_UNCONFIRMED");
          const restoredOrders=await request("GET","/fapi/v1/openAlgoOrders",{symbol});
          if (!Array.isArray(restoredOrders)||!restoredOrders.some(o=>String(o.algoId)===String(restored.algoId)&&isClosePositionStop(o,closeSide)&&samePrice(o.triggerPrice,restore.triggerPrice))) throw Error("RESTORE_STOP_VERIFY_FAILED");
        } catch(restoreError) {
          throw Error("BREAK_EVEN_REPLACE_FAILED_ORIGINAL_STOP_RESTORE_FAILED:"+error.message+";"+restoreError.message);
        }
      }
      throw error;
    }
  }
  const remaining=await request("GET","/fapi/v1/openAlgoOrders",{symbol});
  if (!Array.isArray(remaining)) throw Error("BREAK_EVEN_FINAL_VERIFY_ORDERS_INVALID");
  const remainingStops=remaining.filter(o=>isClosePositionStop(o,closeSide));
  const complete=remainingStops.length===1&&String(remainingStops[0].algoId)===String(be.algoId)&&samePrice(remainingStops[0].triggerPrice,stopPrice);
  return {triggered:true,complete,algoId:be.algoId,entryPrice,stopPrice:Number(stopPrice),stopPriceText:stopPrice};
}
module.exports={breakEvenTriggerPrice,hasReachedBreakEvenTrigger,formatBreakevenStopPrice,moveStopToBreakeven};
