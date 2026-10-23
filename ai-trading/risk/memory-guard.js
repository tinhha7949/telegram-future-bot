"use strict";
const { CONFIG }=require("../config");
// Only new entries are blocked. Existing exchange SL/TP & timeout loops continue.
class MemoryGuard {
 constructor(retention,{config=CONFIG,alert=async()=>{}}={}){
  if(!retention?.readUsage||!retention?.runCleanup)throw Error("MEMORY_RETENTION_REQUIRED");
  Object.assign(this,{retention,config,alert});
 }
 async assess(){
  try {
   let s=await this.retention.readUsage();
   if(s.statsErrors?.length||!Number.isFinite(s.usageMB))
    return {ok:false,reason:"MEMORY_SIZE_UNVERIFIED"};
   if(s.usageMB<this.config.MEMORY_LIMIT_MB)return {ok:true,usageMB:s.usageMB};
   const cleaned=await this.retention.runCleanup({force:true});
   if(cleaned.statsErrors?.length||cleaned.status==="MEASUREMENT_INCOMPLETE")
    return {ok:false,reason:"MEMORY_RETENTION_UNVERIFIED"};
   s=await this.retention.readUsage();
   if(s.statsErrors?.length||!Number.isFinite(s.usageMB))
    return {ok:false,reason:"MEMORY_SIZE_UNVERIFIED"};
   if(s.usageMB>=this.config.MEMORY_LIMIT_MB){
    try{await this.alert("MEMORY CAPACITY CIRCUIT: "+s.usageMB+" MB");}
    catch(e){console.error("MEMORY ALERT FAILED",e.message);}
    return {ok:false,reason:"MEMORY_CAPACITY_CIRCUIT",usageMB:s.usageMB};
   }
   return {ok:true,usageMB:s.usageMB};
  }catch(e){console.error("MEMORY GUARD FAILED",e.message);
   return {ok:false,reason:"MEMORY_LEDGER_UNAVAILABLE"};}
 }
}
module.exports={MemoryGuard};
