"use strict";
const zlib = require("node:zlib");
const { CONFIG } = require("../../config");
const BAR_MS = CONFIG.BAR_HOURS * 60 * 60 * 1000;
const FIELD_COUNT = 5;
// One compressed row per symbol. For statistics/decisions, still use original
// exchange 541-bar history; float32 archive is never used for live signal math.
function encodeRecent(rows, config = CONFIG) {
  if (!Array.isArray(rows)) throw new Error("OHLCV_NOT_ARRAY");
  const selected = rows.slice(-config.N_CANDLES);
  if (!selected.length) throw new Error("OHLCV_EMPTY");
  const raw=Buffer.alloc(selected.length * FIELD_COUNT * 4);
  const prev=[0,0,0,0,0];
  let startTime=null, lastClose=null;
  for(let i=0;i<selected.length;i++) {
    const r=selected[i];
    if(!Array.isArray(r) || r.length < 7) throw new Error("OHLCV_INVALID_ROW");
    const time=Number(r[0]),closeTime=Number(r[6]);
    const values=[1,2,3,4,5].map(k=>Number(r[k]));
    if(![time,closeTime,...values].every(Number.isFinite) ||
       values.some((v,j)=>j!==4 && v<=0) || values[4]<0 ||
       values[1]<Math.max(values[0],values[3]) ||
       values[2]>Math.min(values[0],values[3]) ||
       (i && time!==Number(selected[i-1][0])+BAR_MS) ||
       closeTime!==time+BAR_MS-1) throw new Error("OHLCV_GAP_OR_INVALID");
    if(i===0)startTime=time;
    for(let col=0;col<FIELD_COUNT;col++){
      const v=Math.fround(values[col]);
      raw.writeFloatLE(Math.fround(v-prev[col]),(i*FIELD_COUNT+col)*4);
      prev[col]=v;
    }
    lastClose=closeTime;
  }
  return {codec:"float32-delta-gzip-v1",count:selected.length,
    startTime,lastClose,compressed:zlib.gzipSync(raw,{level:6})};
}
function decodeRecent(snapshot){
  if(snapshot?.codec!=="float32-delta-gzip-v1" ||
     !Number.isSafeInteger(snapshot.count) || snapshot.count<=0 ||
     !Buffer.isBuffer(snapshot.compressed)) throw new Error("OHLCV_ARCHIVE_INVALID");
  const raw=zlib.gunzipSync(snapshot.compressed);
  if(raw.length!==snapshot.count*FIELD_COUNT*4)throw new Error("OHLCV_ARCHIVE_CORRUPT");
  const prev=[0,0,0,0,0],out=[];
  for(let i=0;i<snapshot.count;i++){
    const time=snapshot.startTime+i*BAR_MS;
    const row=[time];
    for(let col=0;col<FIELD_COUNT;col++){
      prev[col]=Math.fround(prev[col]+raw.readFloatLE((i*FIELD_COUNT+col)*4));
      row.push(prev[col]);
    }
    row.push(time+BAR_MS-1);
    out.push(row);
  }
  return out;
}
class RecentOHLCVStore {
  constructor(db,{config=CONFIG}={}){
    if(!db?.collection) throw new Error("OHLCV_DB_REQUIRED");
    this.collection=db.collection("nine_ai_ohlcv_4h");
    this.config=config;
  }
  async store(symbol, rows) {
    if(typeof symbol!=="string"||!symbol.endsWith("USDT"))
      throw new Error("OHLCV_SYMBOL_INVALID");
    const snapshot=encodeRecent(rows,this.config);
    await this.collection.updateOne({_id:symbol},{
      $set:{...snapshot,symbol,timeframe:this.config.TIMEFRAME,updatedAt:Date.now()}
    },{upsert:true});
    return {symbol,count:snapshot.count,lastClose:snapshot.lastClose,bytes:snapshot.compressed.length};
  }
}
module.exports={RecentOHLCVStore,encodeRecent,decodeRecent};
