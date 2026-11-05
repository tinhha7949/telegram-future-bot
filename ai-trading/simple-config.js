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
    "TREND_TIMEFRAME", "TREND_HISTORY_CANDLES", "STRUCTURE_LOOKBACK_CANDLES", "CONFIRMATION_TIMEFRAME", "CONFIRMATION_HISTORY_CANDLES", "MAJOR_PIVOT_LEFT_BARS", "MAJOR_PIVOT_RIGHT_BARS", "CONFIRMATION_PIVOT_LEFT_BARS", "CONFIRMATION_PIVOT_RIGHT_BARS", "ENTRY_TIMEFRAME", "ENTRY_STRUCTURE_LOOKBACK_CANDLES",
    "PIVOT_LEFT_BARS", "PIVOT_RIGHT_BARS", "ENTRY_RETEST_TOLERANCE_ATR", "ENTRY_RETEST_MAX_PENETRATION_ATR", "ENTRY_MAX_EXTENSION_ATR", "ENTRY_RETEST_MAX_BARS", "ENTRY_CONTINUATION_MAX_BARS", "ENTRY_ATR_PERIOD",
    "SL_TIMEFRAME", "SL_ATR_PERIOD", "SL_PIVOT_MAX_DISTANCE", "SL_PIVOT_BUFFER_ATR", "SL_PIVOT_BUFFER_MIN_PCT",
    "SL_MIN_R_MULTIPLE", "SL_MAX_R_MULTIPLE", "SL_FALLBACK_ATR_MULTIPLIER", "SL_FALLBACK_MIN_PCT", "SL_FALLBACK_MAX_PCT",
    "REWARD_RISK", "TP1_REWARD_RISK", "TP2_REWARD_RISK", "TP1_CLOSE_PERCENT", "TP2_CLOSE_PERCENT", "BE_TRIGGER_TP1_PROGRESS_PCT",
    "MAX_ABS_FUNDING_RATE", "MAX_SPREAD_BPS", "MAX_HOLD_HOURS", "MAX_OPEN_POSITIONS", "MAX_TRADES_PER_DAY",
    "POSITION_MARGIN_PCT", "RISK_PER_TRADE_PCT", "MAX_POSITION_BALANCE_PCT", "LEVERAGE", "SCAN_INTERVAL_MS", "SYMBOL_REFRESH_MS",
    "BINANCE_RECV_WINDOW_MS", "BINANCE_HTTP_TIMEOUT_MS", "MONGO_DB_NAME", "MONGO_TRADES_COLLECTION",
    "MONGO_STATE_COLLECTION", "COIN_COOLDOWN_MINUTES", "DRY_RUN"
  ];
  for (const k of required) if (!Object.hasOwn(out, k)) throw new Error("SIMPLE_CONFIG_MISSING_" + k);
  const stringKeys = [
    "QUOTE_ASSET", "TREND_TIMEFRAME", "CONFIRMATION_TIMEFRAME", "ENTRY_TIMEFRAME", "SL_TIMEFRAME",
    "MONGO_DB_NAME", "MONGO_TRADES_COLLECTION", "MONGO_STATE_COLLECTION"
  ];
  for (const k of stringKeys) {
    if (typeof out[k] !== "string" || !out[k].trim()) throw new Error("SIMPLE_CONFIG_INVALID_" + k);
  }
  if (typeof out.DRY_RUN !== "boolean") throw new Error("SIMPLE_CONFIG_INVALID_DRY_RUN");

  const numericKeys = required.filter(k => !stringKeys.includes(k) && k !== "DRY_RUN");
  const nonNegativeKeys = new Set([
    "MAX_SYMBOLS", "MIN_24H_QUOTE_VOLUME_USDT", "MIN_24H_RANGE_PCT",
    "SL_PIVOT_BUFFER_MIN_PCT", "SL_FALLBACK_MIN_PCT",
    "MAX_ABS_FUNDING_RATE", "MAX_SPREAD_BPS", "MAX_OPEN_POSITIONS",
    "MAX_TRADES_PER_DAY", "RISK_PER_TRADE_PCT", "MAX_POSITION_BALANCE_PCT", "COIN_COOLDOWN_MINUTES"
  ]);
  for (const k of numericKeys) {
    if (!Number.isFinite(out[k]) || (nonNegativeKeys.has(k) ? out[k] < 0 : out[k] <= 0))
      throw new Error("SIMPLE_CONFIG_INVALID_" + k);
  }

  const invalid = [];
  const check = (name, failed) => { if (failed) invalid.push(name); };
  const supportedIntervals = new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M"]);
  check("TREND_TIMEFRAME", !supportedIntervals.has(out.TREND_TIMEFRAME));
  check("CONFIRMATION_TIMEFRAME", !supportedIntervals.has(out.CONFIRMATION_TIMEFRAME));
  check("ENTRY_TIMEFRAME", !supportedIntervals.has(out.ENTRY_TIMEFRAME));
  check("SL_TIMEFRAME", !supportedIntervals.has(out.SL_TIMEFRAME));
  check("MAX_SYMBOLS", !Number.isInteger(out.MAX_SYMBOLS));
  check("ENTRY_STRUCTURE_LOOKBACK_CANDLES", !Number.isInteger(out.ENTRY_STRUCTURE_LOOKBACK_CANDLES) || out.ENTRY_STRUCTURE_LOOKBACK_CANDLES < out.PIVOT_LEFT_BARS + out.PIVOT_RIGHT_BARS + 5);
  check("STRUCTURE_LOOKBACK_CANDLES", !Number.isInteger(out.STRUCTURE_LOOKBACK_CANDLES) || out.STRUCTURE_LOOKBACK_CANDLES < out.MAJOR_PIVOT_LEFT_BARS + out.MAJOR_PIVOT_RIGHT_BARS + 5);
  check("TREND_HISTORY_CANDLES", !Number.isInteger(out.TREND_HISTORY_CANDLES) || out.TREND_HISTORY_CANDLES < out.MAJOR_PIVOT_LEFT_BARS + out.MAJOR_PIVOT_RIGHT_BARS + 3);
  check("CONFIRMATION_HISTORY_CANDLES", !Number.isInteger(out.CONFIRMATION_HISTORY_CANDLES) || out.CONFIRMATION_HISTORY_CANDLES < out.CONFIRMATION_PIVOT_LEFT_BARS + out.CONFIRMATION_PIVOT_RIGHT_BARS + 5);
  check("MAJOR_PIVOT_BARS", !Number.isInteger(out.MAJOR_PIVOT_LEFT_BARS) || !Number.isInteger(out.MAJOR_PIVOT_RIGHT_BARS));
  check("CONFIRMATION_PIVOT_BARS", !Number.isInteger(out.CONFIRMATION_PIVOT_LEFT_BARS) || !Number.isInteger(out.CONFIRMATION_PIVOT_RIGHT_BARS));
  check("PIVOT_BARS", !Number.isInteger(out.PIVOT_LEFT_BARS) || !Number.isInteger(out.PIVOT_RIGHT_BARS));
  check("ENTRY_RETEST_PARAMS", out.ENTRY_RETEST_TOLERANCE_ATR <= 0 || out.ENTRY_RETEST_MAX_PENETRATION_ATR < 0 || out.ENTRY_MAX_EXTENSION_ATR <= 0 || out.ENTRY_RETEST_MAX_BARS < 1 || out.ENTRY_CONTINUATION_MAX_BARS < 1);
  check("SL_FALLBACK_RANGE", out.SL_FALLBACK_MIN_PCT > out.SL_FALLBACK_MAX_PCT);
  check("SL_R_RANGE", out.SL_MIN_R_MULTIPLE >= out.SL_MAX_R_MULTIPLE);
  check("SL_ATR_PERIOD", !Number.isInteger(out.SL_ATR_PERIOD));
  check("SL_PIVOT_MAX_DISTANCE", !Number.isInteger(out.SL_PIVOT_MAX_DISTANCE) || out.SL_PIVOT_MAX_DISTANCE < 1);
  check("REWARD_RISK", out.REWARD_RISK <= 0);
  check("TP1_REWARD_RISK", out.TP1_REWARD_RISK <= 0);
  check("TP2_REWARD_RISK", out.TP2_REWARD_RISK <= out.TP1_REWARD_RISK);
  check("TP_CLOSE_PERCENT", out.TP1_CLOSE_PERCENT <= 0 || out.TP2_CLOSE_PERCENT <= 0 || out.TP1_CLOSE_PERCENT >= 100 || out.TP2_CLOSE_PERCENT >= 100 || out.TP1_CLOSE_PERCENT + out.TP2_CLOSE_PERCENT !== 100);
  check("BE_TRIGGER_TP1_PROGRESS_PCT", out.BE_TRIGGER_TP1_PROGRESS_PCT <= 0 || out.BE_TRIGGER_TP1_PROGRESS_PCT > 100);
  check("RISK_PER_TRADE_PCT", out.RISK_PER_TRADE_PCT > 1);
  check("MAX_POSITION_BALANCE_PCT", out.MAX_POSITION_BALANCE_PCT > 1);
  check("POSITION_MARGIN_PCT", out.POSITION_MARGIN_PCT > 1);
  for (const k of ["MAX_TRADES_PER_DAY", "MAX_OPEN_POSITIONS", "MAX_SYMBOLS", "TREND_HISTORY_CANDLES", "CONFIRMATION_HISTORY_CANDLES", "MAJOR_PIVOT_LEFT_BARS", "MAJOR_PIVOT_RIGHT_BARS", "CONFIRMATION_PIVOT_LEFT_BARS", "CONFIRMATION_PIVOT_RIGHT_BARS", "ENTRY_STRUCTURE_LOOKBACK_CANDLES", "ENTRY_RETEST_MAX_BARS", "ENTRY_CONTINUATION_MAX_BARS", "ENTRY_ATR_PERIOD", "LEVERAGE", "STRUCTURE_LOOKBACK_CANDLES", "PIVOT_LEFT_BARS", "PIVOT_RIGHT_BARS", "SL_ATR_PERIOD", "SL_PIVOT_MAX_DISTANCE", "SCAN_INTERVAL_MS", "SYMBOL_REFRESH_MS", "BINANCE_RECV_WINDOW_MS", "BINANCE_HTTP_TIMEOUT_MS", "COIN_COOLDOWN_MINUTES"])
    check(k, !Number.isInteger(out[k]));
  if (invalid.length) throw new Error("SIMPLE_CONFIG_INVARIANT:" + invalid.join(", "));
  return Object.freeze(out);
}

module.exports = { loadSimpleConfig };
