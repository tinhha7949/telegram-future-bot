"use strict";
const fs = require("node:fs");
const path = require("node:path");

function loadSimpleConfig(file = path.join(__dirname, "..", "CONFIG.yaml")) {
  const out = {};
  const source = fs.readFileSync(file, "utf8");
  for (const [i, line0] of source.split(/\r?\n/).entries()) {
    const line = line0.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!match || Object.hasOwn(out, match[1])) throw new Error("SIMPLE_CONFIG_INVALID_LINE_" + (i + 1));
    const [, key, raw] = match;
    let value;
    if (raw.startsWith('"')) value = JSON.parse(raw);
    else if (raw === "true" || raw === "false") value = raw === "true";
    else if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) value = Number(raw);
    else throw new Error("SIMPLE_CONFIG_INVALID_VALUE_" + key);
    out[key] = value;
  }

  const required = [
    "QUOTE_ASSET", "MIN_24H_QUOTE_VOLUME_USDT", "MIN_24H_RANGE_PCT",
    "STRATEGY_TIMEFRAME", "HISTORY_CANDLES", "RSI_PERIOD", "PIVOT_LEFT_BARS", "PIVOT_RIGHT_BARS",
    "MIN_PIVOT_DISTANCE", "MAX_PIVOT_DISTANCE", "SWEEP_MAX_WAIT_BARS", "SWEEP_MIN_ATR",
    "CONFIRMATION_MAX_BARS", "ATR_PERIOD", "EMA50_PERIOD", "USE_EMA50_FILTER",
    "SL_ATR_BUFFER", "SL_MIN_BUFFER_PERCENT", "MAX_SL_ATR",
    "REWARD_RISK", "TP1_REWARD_RISK", "TP2_REWARD_RISK", "TP1_CLOSE_PERCENT", "TP2_CLOSE_PERCENT",
    "BE_TRIGGER_TP1_PROGRESS_PCT", "MAX_ABS_FUNDING_RATE", "MAX_SPREAD_BPS", "MAX_HOLD_HOURS",
    "MAX_TRADES_PER_DAY", "POSITION_MARGIN_PCT", "RISK_PER_TRADE_PCT",
    "MAX_POSITION_BALANCE_PCT", "LEVERAGE", "SCAN_INTERVAL_MS", "SYMBOL_REFRESH_MS",
    "BINANCE_RECV_WINDOW_MS", "BINANCE_HTTP_TIMEOUT_MS", "MONGO_DB_NAME",
    "MONGO_TRADES_COLLECTION", "MONGO_STATE_COLLECTION", "COIN_COOLDOWN_MINUTES", "DRY_RUN"
  ];
  for (const key of required) if (!Object.hasOwn(out, key)) throw new Error("SIMPLE_CONFIG_MISSING_" + key);

  const stringKeys = ["QUOTE_ASSET", "STRATEGY_TIMEFRAME", "MONGO_DB_NAME", "MONGO_TRADES_COLLECTION", "MONGO_STATE_COLLECTION"];
  for (const key of stringKeys) {
    if (typeof out[key] !== "string" || !out[key].trim()) throw new Error("SIMPLE_CONFIG_INVALID_" + key);
  }
  if (typeof out.DRY_RUN !== "boolean" || typeof out.USE_EMA50_FILTER !== "boolean")
    throw new Error("SIMPLE_CONFIG_INVALID_BOOLEAN");

  const nonNegative = new Set([
    "MIN_24H_QUOTE_VOLUME_USDT", "MIN_24H_RANGE_PCT", "MAX_ABS_FUNDING_RATE",
    "MAX_SPREAD_BPS", "COIN_COOLDOWN_MINUTES", "RISK_PER_TRADE_PCT", "MAX_POSITION_BALANCE_PCT"
  ]);
  for (const key of required.filter(key => !stringKeys.includes(key) && key !== "DRY_RUN" && key !== "USE_EMA50_FILTER")) {
    if (!Number.isFinite(out[key]) || (nonNegative.has(key) ? out[key] < 0 : out[key] <= 0))
      throw new Error("SIMPLE_CONFIG_INVALID_" + key);
  }

  const intervals = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);
  const invalid = [];
  const check = (name, failed) => { if (failed) invalid.push(name); };
  check("STRATEGY_TIMEFRAME", !intervals.has(out.STRATEGY_TIMEFRAME));
  for (const key of ["HISTORY_CANDLES", "RSI_PERIOD", "PIVOT_LEFT_BARS", "PIVOT_RIGHT_BARS",
    "MIN_PIVOT_DISTANCE", "MAX_PIVOT_DISTANCE", "SWEEP_MAX_WAIT_BARS", "CONFIRMATION_MAX_BARS",
    "ATR_PERIOD", "EMA50_PERIOD", "MAX_TRADES_PER_DAY", "LEVERAGE",
    "SCAN_INTERVAL_MS", "SYMBOL_REFRESH_MS", "BINANCE_RECV_WINDOW_MS", "BINANCE_HTTP_TIMEOUT_MS",
    "MAX_HOLD_HOURS", "COIN_COOLDOWN_MINUTES"]) check(key, !Number.isInteger(out[key]));
  check("HISTORY_CANDLES", out.HISTORY_CANDLES < Math.max(out.EMA50_PERIOD + out.ATR_PERIOD + 2, out.RSI_PERIOD + out.MAX_PIVOT_DISTANCE + out.PIVOT_LEFT_BARS + out.PIVOT_RIGHT_BARS + 5));
  check("PIVOT_DISTANCE", out.MIN_PIVOT_DISTANCE < 1 || out.MAX_PIVOT_DISTANCE < out.MIN_PIVOT_DISTANCE);
  check("PIVOT_BARS", out.PIVOT_LEFT_BARS < 1 || out.PIVOT_RIGHT_BARS < 1);
  check("WAIT_BARS", out.SWEEP_MAX_WAIT_BARS < 1 || out.CONFIRMATION_MAX_BARS < 1);
  check("ATR_SETTINGS", out.ATR_PERIOD < 2 || out.SWEEP_MIN_ATR < 0);
  check("EMA50_PERIOD", out.EMA50_PERIOD < 2);
  check("STOP_SETTINGS", out.SL_ATR_BUFFER <= 0 || out.SL_MIN_BUFFER_PERCENT <= 0 || out.MAX_SL_ATR <= 0);
  check("TP1_REWARD_RISK", out.TP1_REWARD_RISK <= 0);
  check("TP2_REWARD_RISK", out.TP2_REWARD_RISK <= out.TP1_REWARD_RISK);
  check("TP_CLOSE_PERCENT", out.TP1_CLOSE_PERCENT <= 0 || out.TP2_CLOSE_PERCENT <= 0 ||
    out.TP1_CLOSE_PERCENT >= 100 || out.TP2_CLOSE_PERCENT >= 100 ||
    out.TP1_CLOSE_PERCENT + out.TP2_CLOSE_PERCENT !== 100);
  check("BE_TRIGGER_TP1_PROGRESS_PCT", out.BE_TRIGGER_TP1_PROGRESS_PCT <= 0 || out.BE_TRIGGER_TP1_PROGRESS_PCT > 100);
  check("POSITION_MARGIN_PCT", out.POSITION_MARGIN_PCT > 1);
  check("RISK_PER_TRADE_PCT", out.RISK_PER_TRADE_PCT > 1);
  check("MAX_POSITION_BALANCE_PCT", out.MAX_POSITION_BALANCE_PCT > 1);
  if (invalid.length) throw new Error("SIMPLE_CONFIG_INVARIANT:" + invalid.join(", "));
  return Object.freeze(out);
}

module.exports = { loadSimpleConfig };
