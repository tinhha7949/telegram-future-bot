"use strict";
const fs = require("node:fs");
const path = require("node:path");

function loadSimpleConfig(file = path.join(__dirname, "..", "CONFIG.yaml")) {
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
    "QUOTE_ASSET", "MAX_SYMBOLS", "MIN_24H_QUOTE_VOLUME_USDT", "MIN_24H_RANGE_PCT",
    "TREND_TIMEFRAME", "TREND_EMA_PERIOD", "ENTRY_TIMEFRAME", "RSI_PERIOD", "RSI_LONG_MIN", "RSI_LONG_TRIGGER", "RSI_SHORT_TRIGGER", "RSI_SHORT_MAX",
    "ATR_PERIOD", "SL_ATR_MULTIPLIER", "SL_MIN_PCT", "SL_MAX_PCT", "REWARD_RISK", "TP1_REWARD_RISK", "TP2_REWARD_RISK", "TP1_CLOSE_PERCENT", "TP2_CLOSE_PERCENT", "MAX_HOLD_HOURS",
    "MAX_OPEN_POSITIONS", "MAX_TRADES_PER_DAY", "RISK_PER_TRADE_PCT", "MAX_POSITION_BALANCE_PCT", "LEVERAGE",
    "SCAN_INTERVAL_MS", "SYMBOL_REFRESH_MS", "BINANCE_RECV_WINDOW_MS", "BINANCE_HTTP_TIMEOUT_MS",
    "MONGO_DB_NAME", "MONGO_TRADES_COLLECTION", "MONGO_STATE_COLLECTION", "DRY_RUN"
  ];
  for (const k of required) if (!Object.hasOwn(out, k)) throw new Error("SIMPLE_CONFIG_MISSING_" + k);
  for (const k of required.filter(k => ![
    "QUOTE_ASSET", "TREND_TIMEFRAME", "ENTRY_TIMEFRAME", "MONGO_DB_NAME",
    "MONGO_TRADES_COLLECTION", "MONGO_STATE_COLLECTION", "DRY_RUN"
  ].includes(k))) {
    if (!Number.isFinite(out[k]) || out[k] <= 0) throw new Error("SIMPLE_CONFIG_INVALID_" + k);
  }
  const invalid = [];
  const check = (name, failed) => { if (failed) invalid.push(name); };
  check("TREND_TIMEFRAME", out.TREND_TIMEFRAME !== "4h");
  check("ENTRY_TIMEFRAME", out.ENTRY_TIMEFRAME !== "1m");
  check("MAX_SYMBOLS", !Number.isInteger(out.MAX_SYMBOLS) || out.MAX_SYMBOLS > 100);
  check("RSI_LONG_RANGE", out.RSI_LONG_MIN <= 0 || out.RSI_LONG_MIN >= out.RSI_LONG_TRIGGER || out.RSI_LONG_TRIGGER >= 100);
  check("RSI_SHORT_RANGE", out.RSI_SHORT_TRIGGER <= 0 || out.RSI_SHORT_TRIGGER >= out.RSI_SHORT_MAX || out.RSI_SHORT_MAX >= 100);
  check("RSI_RANGE_ORDER", out.RSI_SHORT_MAX >= out.RSI_LONG_MIN);
  check("SL_RANGE", out.SL_MIN_PCT > out.SL_MAX_PCT);
  check("REWARD_RISK", out.REWARD_RISK < 1);
  check("TP1_REWARD_RISK", out.TP1_REWARD_RISK <= 0);
  check("TP2_REWARD_RISK", out.TP2_REWARD_RISK <= out.TP1_REWARD_RISK);
  check("TP_CLOSE_PERCENT", out.TP1_CLOSE_PERCENT <= 0 || out.TP2_CLOSE_PERCENT <= 0 || out.TP1_CLOSE_PERCENT >= 100 || out.TP2_CLOSE_PERCENT >= 100 || out.TP1_CLOSE_PERCENT + out.TP2_CLOSE_PERCENT !== 100);
  check("RISK_PER_TRADE_PCT", out.RISK_PER_TRADE_PCT >= 1);
  check("MAX_POSITION_BALANCE_PCT", out.MAX_POSITION_BALANCE_PCT > 1);
  check("MAX_TRADES_PER_DAY", !Number.isInteger(out.MAX_TRADES_PER_DAY));
  check("MAX_OPEN_POSITIONS", !Number.isInteger(out.MAX_OPEN_POSITIONS));
  check("TREND_EMA_PERIOD", !Number.isInteger(out.TREND_EMA_PERIOD));
  check("RSI_PERIOD", !Number.isInteger(out.RSI_PERIOD));
  check("ATR_PERIOD", !Number.isInteger(out.ATR_PERIOD));
  check("LEVERAGE", !Number.isInteger(out.LEVERAGE));
  if (invalid.length) throw new Error("SIMPLE_CONFIG_INVARIANT:" + invalid.join(", "));
  return Object.freeze(out);
}

module.exports = { loadSimpleConfig };
