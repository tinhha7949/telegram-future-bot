"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Deliberately tiny parser for this repository's restricted flat YAML syntax.
// Invalid/unexpected values abort startup: never guess trading parameters.
const KEYS = Object.freeze([
  "N_CANDLES", "TIMEFRAME", "EQUITY_START", "RISK_PER_TRADE",
  "MAX_DAILY_RISK", "MAX_DRAWDOWN_CIRCUIT", "MIN_RR", "MIN_EDGE",
  "TP_BATCHES", "TIMEOUT_BARS", "COLD_START_SAMPLES", "WAIT_MIN_RATIO",
  "MEMORY_LIMIT_MB", "FEE_TAKER", "SLIPPAGE_BPS", "AI7_ACTIVATION_SAMPLES",
  "AI7_ATR_MULTIPLIER", "FALLBACK_TP2_R", "EDGE_GAP", "CONF_HIGH",
  "CONF_LOW", "LOW_CONF_PENALTY", "STALE_PENALTY", "VOL_20D_RETURNS",
  "VOL_90D_RETURNS", "HISTORY_FETCH_CANDLES", "ATR_BARS",
  "FUNDING_HOT_RATE", "HIGH_VOL_PERCENTILE",
  "WAIT_WINDOW_DAYS", "WAIT_EDGE_INCREMENT", "WAIT_EDGE_MAX", "MIN_TP2_R",
  "SHADOW_DAYS", "TRAIN_WINDOW_CANDLES", "DAILY_TRAIN_LOOKBACK_DAYS",
  "TRAIN_MAX_OPPORTUNITIES", "RISK_RESERVATION_MIN_MARGIN_MULTIPLIER",
]);
function parseConfig(text) {
  if (typeof text !== "string") throw new Error("CONFIG_MISSING");
  const out = {};
  for (const [i, source] of text.split(/\r?\n/).entries()) {
    const line = source.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error("CONFIG_INVALID_LINE_" + (i + 1));
    const [, key, raw] = match;
    if (!KEYS.includes(key) || Object.hasOwn(out, key))
      throw new Error("CONFIG_UNEXPECTED_OR_DUPLICATE_" + key);
    let value;
    if (raw.startsWith('"') || raw.startsWith("[")) {
      try { value = JSON.parse(raw); }
      catch { throw new Error("CONFIG_INVALID_VALUE_" + key); }
    } else if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) {
      value = Number(raw);
    } else {
      throw new Error("CONFIG_INVALID_VALUE_" + key);
    }
    out[key] = value;
  }
  for (const key of KEYS)
    if (!Object.hasOwn(out, key)) throw new Error("CONFIG_MISSING_" + key);
  for (const [key, v] of Object.entries(out)) {
    if (["TIMEFRAME", "TP_BATCHES"].includes(key)) continue;
    if (!Number.isFinite(v) || v <= 0)
      throw new Error("CONFIG_INVALID_NUMBER_" + key);
  }
  if (out.TIMEFRAME !== "4h" ||
      !Array.isArray(out.TP_BATCHES) ||
      out.TP_BATCHES.length !== 2 ||
      out.TP_BATCHES.some(v => !Number.isSafeInteger(v) || v <= 0) ||
      out.RISK_PER_TRADE > out.MAX_DAILY_RISK ||
      out.MAX_DAILY_RISK >= 1 ||
      out.MAX_DRAWDOWN_CIRCUIT >= 1 ||
      out.WAIT_MIN_RATIO >= 1 ||
      out.CONF_LOW >= out.CONF_HIGH ||
      out.CONF_HIGH > 1 ||
      out.HIGH_VOL_PERCENTILE >= 1 ||
      out.HISTORY_FETCH_CANDLES < out.VOL_90D_RETURNS + 1 ||
      out.N_CANDLES > out.HISTORY_FETCH_CANDLES ||
      out.AI7_ACTIVATION_SAMPLES < out.COLD_START_SAMPLES ||
      out.FALLBACK_TP2_R < out.MIN_RR)
    throw new Error("CONFIG_CROSS_FIELD_INVARIANT");
  for (const key of ["N_CANDLES", "TIMEOUT_BARS", "COLD_START_SAMPLES",
      "AI7_ACTIVATION_SAMPLES", "HISTORY_FETCH_CANDLES", "ATR_BARS",
      "VOL_20D_RETURNS", "VOL_90D_RETURNS"]) {
    if (!Number.isSafeInteger(out[key]))
      throw new Error("CONFIG_NOT_INTEGER_" + key);
  }
  out.TP_BATCHES = Object.freeze(out.TP_BATCHES);
  return Object.freeze(out);
}
const CONFIG = parseConfig(fs.readFileSync(path.join(__dirname, "..", "CONFIG.yaml"), "utf8"));
module.exports = { CONFIG, parseConfig };
