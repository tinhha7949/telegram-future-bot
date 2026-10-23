"use strict";
const { CONFIG } = require("../config");
class WaitRateControl {
  constructor(db,{ config=CONFIG, now=()=>Date.now() }={}) {
    this.store=db.collection("nine_ai_wait_rate_decisions");
    this.config=config; this.now=now;
  }
  async minimumEdge() {
    try {
      const start=this.now()-this.config.WAIT_WINDOW_DAYS*24*60*60*1000;
      const rows=await this.store.find({at:{$gte:start,$lte:this.now()}})
        .sort({at:-1}).limit(this.config.TRAIN_MAX_OPPORTUNITIES).toArray();
      if(!rows.length) return {ok:true,minEdge:this.config.MIN_EDGE,ratio:null};
      if(rows.some(r=>!["WAIT","LONG","SHORT"].includes(r.action))) return {ok:false,reason:"INVALID_DECISION_AUDIT"};
      const waited=rows.filter(r=>r.action==="WAIT").length;
      const ratio=waited/rows.length;
      const increment=ratio<this.config.WAIT_MIN_RATIO?
        Math.ceil((this.config.WAIT_MIN_RATIO-ratio)/this.config.WAIT_EDGE_INCREMENT)*this.config.WAIT_EDGE_INCREMENT:0;
      return {ok:true,ratio,minEdge:Math.min(this.config.WAIT_EDGE_MAX,this.config.MIN_EDGE+increment)};
    }catch(e){
      console.error("WAIT RATE UNAVAILABLE",e.message);
      return {ok:false,reason:"WAIT_RATE_LEDGER_UNAVAILABLE"};
    }
  }
  async record({symbol,signalAt,action,reason}) {
    if(!symbol||!Number.isFinite(signalAt)||!["WAIT","LONG","SHORT"].includes(action))
      return {ok:false,reason:"INVALID_WAIT_AUDIT"};
    try {
      await this.store.updateOne({_id:symbol+":"+signalAt},
        {$setOnInsert:{symbol,signalAt,at:this.now(),action,reason:reason||null}},
        {upsert:true});
      return {ok:true};
    }catch(e){console.error("WAIT RATE WRITE FAILED",e.message);return {ok:false,reason:"WAIT_RATE_LEDGER_UNAVAILABLE"};}
  }
}
module.exports={WaitRateControl};
