"use strict";
const fs = require("node:fs");
const path = require("node:path");
function loadSimpleConfig(file = path.join(__dirname, "..", "SIMPLE_CONFIG.yaml")) {
  const out = {};
  const text = fs.readFileSync(file, "utf8");
  for (const [i, line0] of text.split(/\r?\n/).entries()) {
    const line = line0.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!m || Object.hasOwn(out, m[1])) throw new Error("SIMPLE_CONFIG_INVALID_LINE_" + (i + 1));
    const [, key, raw] = m;
    let v;
    if (raw.startsWith('"')) v = JSON.parse(raw);
    else if (raw === "true" || raw === "false") v = raw === "true";
    else if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) v = Number(raw);
    else throw new Error("SIMPLE_CONFIG_INVALID_VALUE_" + key);
    out[key] = v;
  }
  const required = [
    "QUOTE_ASSET","MAX_SYMBOLS","MIN_5M_QUOTE_VOLUME_USDT","MIN_24H_QUOTE_VOLUME_USDT","MIN_24H_RANGE_PCT",
    "TREND_TIMEFRAME","TREND_EMA_PERIOD","ENTRY_TIMEFRAME","RSI_PERIOD","RSI_LONG_MAX","RSI_SHORT_MIN",
    "ATR_PERIOD","SL_ATR_MULTIPLIER","SL_MIN_PCT","SL_MAX_PCT","REWARD_RISK","MAX_HOLD_HOURS",
    "MAX_OPEN_POSITIONS","MAX_TRADES_PER_DAY","RISK_PER_TRADE_PCT","MAX_POSITION_BALANCE_PCT","LEVERAGE",
    "SCAN_INTERVAL_MS","SYMBOL_REFRESH_MS","POSITION_SYNC_INTERVAL_MS","BINANCE_RECV_WINDOW_MS","BINANCE_HTTP_TIMEOUT_MS",
    "MONGO_DB_NAME","MONGO_TRADES_COLLECTION","MONGO_STATE_COLLECTION","DRY_RUN"
  ];
  for (const k of required) if (!Object.hasOwn(out, k)) throw new Error("SIMPLE_CONFIG_MISSING_" + k);
  for (const k of required.filter(k => !["QUOTE_ASSET","TREND_TIMEFRAME","ENTRY_TIMEFRAME","MONGO_DB_NAME","MONGO_TRADES_COLLECTION","MONGO_STATE_COLLECTION","DRY_RUN"].includes(k))) {
    if (!Number.isFinite(out[k]) || out[k] <= 0) throw new Error("SIMPLE_CONFIG_INVALID_" + k);
  }
  if (out.TREND_TIMEFRAME !== "4h" || out.ENTRY_TIMEFRAME !== "1m" ||
      !Number.isInteger(out.MAX_SYMBOLS) || out.MAX_SYMBOLS > 100 ||
      out.RSI_LONG_MAX >= out.RSI_SHORT_MIN || out.RSI_LONG_MAX >= 50 || out.RSI_SHORT_MIN <= 50 ||
      out.SL_MIN_PCT > out.SL_MAX_PCT || out.REWARD_RISK < 1 ||
      out.RISK_PER_TRADE_PCT >= 1 || out.MAX_POSITION_BALANCE_PCT > 1 ||
      !Number.isInteger(out.MAX_TRADES_PER_DAY) || !Number.isInteger(out.MAX_OPEN_POSITIONS) ||
      !Number.isInteger(out.TREND_EMA_PERIOD) || !Number.isInteger(out.RSI_PERIOD) ||
      !Number.isInteger(out.ATR_PERIOD) || !Number.isInteger(out.LEVERAGE)) throw new Error("SIMPLE_CONFIG_INVARIANT");
  return Object.freeze(out);
}
module.exports = { loadSimpleConfig };
