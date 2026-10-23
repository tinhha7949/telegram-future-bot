"use strict";
const { CONFIG } = require("../config");
const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));
const format = (v, places=4) => Number.isFinite(v) ? v.toFixed(places) : "N/A";

/**
 * UTC session rollup. An incomplete or truncated ledger never produces a
 * deceptive numerical performance claim. This is NOT an execution authority.
 */
async function sessionReport(db, waitControl, {
  config = CONFIG, now = () => Date.now(),
} = {}) {
  if (!db?.collection || !waitControl?.store?.find) throw Error("SESSION_LEDGER_REQUIRED");
  const end = now();
  const start = end - config.SESSION_REPORT_WINDOW_HOURS * 60 * 60 * 1000;
  const [closed, decisions, risk] = await Promise.all([
    db.collection("trades")
      .find({result:{$in:["WIN","LOSS"]},closedAt:{$gte:start,$lte:end}})
      .sort({closedAt:-1}).limit(config.SESSION_REPORT_MAX_TRADES+1).toArray(),
    waitControl.store.find({at:{$gte:start,$lte:end}})
      .sort({at:-1}).limit(config.SESSION_REPORT_MAX_WAIT_RECORDS+1).toArray(),
    db.collection("nine_ai_global_risk").findOne({_id:"GLOBAL"}),
  ]);
  const truncated = closed.length > config.SESSION_REPORT_MAX_TRADES ||
    decisions.length > config.SESSION_REPORT_MAX_WAIT_RECORDS;
  const validActions = decisions.every(d=>["WAIT","LONG","SHORT"].includes(d.action));
  const completeTrades = closed.every(t=>
    finite(t.realizedR) && finite(t.feesUSDT) && finite(t.fundingUSDT));
  const reliable = !truncated && validActions && completeTrades;
  const sum = key => closed.reduce((s,t)=>s+Number(t[key]),0);
  const trades = closed.length;
  const waitRatio = reliable && decisions.length ?
    decisions.filter(d=>d.action==="WAIT").length/decisions.length : null;
  const maxDrawdown = finite(risk?.maxDrawdown) ? Number(risk.maxDrawdown) : null;
  const alerts = [
    ...(waitRatio !== null && waitRatio < config.WAIT_MIN_RATIO ? ["WAIT_RATIO_TOO_LOW"] : []),
    ...(maxDrawdown !== null && maxDrawdown >= config.MAX_DRAWDOWN_CIRCUIT
      ? ["DRAWDOWN_CIRCUIT"] : []),
    ...(!reliable ? ["REPORT_ACCOUNTING_UNCERTAIN"] : []),
  ];
  return {
    startAt:start,endAt:end,
    trades, wins:closed.filter(t=>t.result==="WIN").length,
    winrate:reliable && trades ? closed.filter(t=>t.result==="WIN").length/trades : null,
    meanNetR:reliable && trades ? sum("realizedR")/trades : null,
    feesUSDT:reliable ? sum("feesUSDT") : null,
    fundingUSDT:reliable ? sum("fundingUSDT") : null,
    waitRatio,
    maxDrawdown, alerts,
    complete:reliable,
    reason:!reliable ?
      truncated ? "LEDGER_TRUNCATED" :
      !validActions ? "INVALID_WAIT_ACTION" : "INCOMPLETE_TRADE_ACCOUNTING" : null,
  };
}
function formatSessionReport(s) {
  return [
    "NINE-AI UTC SESSION REPORT",
    "orders="+s.trades,
    "winrate="+(s.winrate===null?"N/A":format(100*s.winrate,2)+"%"),
    "net_E[R]/trade="+format(s.meanNetR),
    "max_DD="+(s.maxDrawdown===null?"N/A":format(s.maxDrawdown*100,2)+"%"),
    "WAIT="+(s.waitRatio===null?"N/A":format(s.waitRatio*100,2)+"%"),
    "fees_USDT="+format(s.feesUSDT),
    "funding_USDT="+format(s.fundingUSDT),
    s.complete ? "ACCOUNTING_COMPLETE" : "INCOMPLETE:"+s.reason,
    s.alerts.length ? "ALERTS="+s.alerts.join(",") : "ALERTS=NONE",
  ].join(" | ");
}
module.exports = { sessionReport, formatSessionReport };
