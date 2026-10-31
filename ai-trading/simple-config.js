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
    "TREND_TIMEFRAME", "TREND_EMA_PERIOD", "STRUCTURE_LOOKBACK_CANDLES", "ENTRY_TIMEFRAME", "DIVERGENCE_TIMEFRAME",
    "RSI_PERIOD", "ENTRY_RSI_LONG_MAX", "ENTRY_RSI_SHORT_MIN", "DIVERGENCE_LOOKBACK_CANDLES",
    "DIVERGENCE_MAX_PIVOT_DISTANCE", "PIVOT_LEFT_BARS", "PIVOT_RIGHT_BARS", "ATR_PERIOD",
    "SWING_STOP_BUFFER_PCT", "SL_ATR_MULTIPLIER", "SL_MIN_PCT", "SL_MAX_PCT",
    "REWARD_RISK", "TP1_REWARD_RISK", "TP2_REWARD_RISK", "TP1_REWARD_RISK_NO_DIVERGENCE", "TP2_REWARD_RISK_NO_DIVERGENCE", "TP1_CLOSE_PERCENT", "TP2_CLOSE_PERCENT",
    "MAX_ABS_FUNDING_RATE", "MAX_SPREAD_BPS", "MAX_HOLD_HOURS", "MAX_OPEN_POSITIONS", "MAX_TRADES_PER_DAY",
    "RISK_PER_TRADE_PCT", "MAX_POSITION_BALANCE_PCT", "LEVERAGE", "SCAN_INTERVAL_MS", "SYMBOL_REFRESH_MS",
    "BINANCE_RECV_WINDOW_MS", "BINANCE_HTTP_TIMEOUT_MS", "MONGO_DB_NAME", "MONGO_TRADES_COLLECTION",
    "MONGO_STATE_COLLECTION", "DRY_RUN"
  ];
  for (const k of required) if (!Object.hasOwn(out, k)) throw new Error("SIMPLE_CONFIG_MISSING_" + k);
  for (const k of required.filter(k => ![
    "QUOTE_ASSET", "TREND_TIMEFRAME", "ENTRY_TIMEFRAME", "DIVERGENCE_TIMEFRAME",
    "MONGO_DB_NAME", "MONGO_TRADES_COLLECTION", "MONGO_STATE_COLLECTION", "DRY_RUN"
  ].includes(k))) {
    if (!Number.isFinite(out[k]) || out[k] <= 0) throw new Error("SIMPLE_CONFIG_INVALID_" + k);
  }
  const invalid = [];
  const check = (name, failed) => { if (failed) invalid.push(name); };
  check("TREND_TIMEFRAME", out.TREND_TIMEFRAME !== "1h");
  check("ENTRY_TIMEFRAME", out.ENTRY_TIMEFRAME !== "1m");
  check("DIVERGENCE_TIMEFRAME", out.DIVERGENCE_TIMEFRAME !== "5m");
  check("MAX_SYMBOLS", !Number.isInteger(out.MAX_SYMBOLS) || out.MAX_SYMBOLS > 100);
  check("ENTRY_RSI_THRESHOLDS", out.ENTRY_RSI_LONG_MAX >= 50 || out.ENTRY_RSI_SHORT_MIN <= 50 || out.ENTRY_RSI_LONG_MAX >= out.ENTRY_RSI_SHORT_MIN);
  check("STRUCTURE_LOOKBACK_CANDLES", !Number.isInteger(out.STRUCTURE_LOOKBACK_CANDLES) || out.STRUCTURE_LOOKBACK_CANDLES < 20);
  check("DIVERGENCE_LOOKBACK_CANDLES", !Number.isInteger(out.DIVERGENCE_LOOKBACK_CANDLES) || out.DIVERGENCE_LOOKBACK_CANDLES < out.RSI_PERIOD + out.PIVOT_LEFT_BARS + out.PIVOT_RIGHT_BARS + 2);
  check("DIVERGENCE_MAX_PIVOT_DISTANCE", !Number.isInteger(out.DIVERGENCE_MAX_PIVOT_DISTANCE) || out.DIVERGENCE_MAX_PIVOT_DISTANCE < 2 || out.DIVERGENCE_MAX_PIVOT_DISTANCE >= out.DIVERGENCE_LOOKBACK_CANDLES);
  check("PIVOT_BARS", !Number.isInteger(out.PIVOT_LEFT_BARS) || !Number.isInteger(out.PIVOT_RIGHT_BARS));
  check("SWING_STOP_BUFFER_PCT", out.SWING_STOP_BUFFER_PCT >= 5);
  check("MAX_ABS_FUNDING_RATE", out.MAX_ABS_FUNDING_RATE >= 0.1);
  check("SL_RANGE", out.SL_MIN_PCT > out.SL_MAX_PCT);
  check("REWARD_RISK", out.REWARD_RISK < 1);
  check("TP1_REWARD_RISK", out.TP1_REWARD_RISK <= 0);
  check("TP2_REWARD_RISK", out.TP2_REWARD_RISK <= out.TP1_REWARD_RISK);
  check("TP1_REWARD_RISK_NO_DIVERGENCE", out.TP1_REWARD_RISK_NO_DIVERGENCE <= 0);
  check("TP2_REWARD_RISK_NO_DIVERGENCE", out.TP2_REWARD_RISK_NO_DIVERGENCE <= out.TP1_REWARD_RISK_NO_DIVERGENCE);
  check("TP_CLOSE_PERCENT", out.TP1_CLOSE_PERCENT <= 0 || out.TP2_CLOSE_PERCENT <= 0 || out.TP1_CLOSE_PERCENT >= 100 || out.TP2_CLOSE_PERCENT >= 100 || out.TP1_CLOSE_PERCENT + out.TP2_CLOSE_PERCENT !== 100);
  check("RISK_PER_TRADE_PCT", out.RISK_PER_TRADE_PCT >= 1);
  check("MAX_POSITION_BALANCE_PCT", out.MAX_POSITION_BALANCE_PCT > 1);
  for (const k of ["MAX_TRADES_PER_DAY", "MAX_OPEN_POSITIONS", "TREND_EMA_PERIOD", "RSI_PERIOD", "ATR_PERIOD", "LEVERAGE"])
    check(k, !Number.isInteger(out[k]));
  if (invalid.length) throw new Error("SIMPLE_CONFIG_INVARIANT:" + invalid.join(", "));
  return Object.freeze(out);
}

module.exports = { loadSimpleConfig };
