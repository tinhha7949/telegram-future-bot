"use strict";
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const BINANCE_TIMEFRAMES = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "1M"
]);

function loadConfig(file = path.join(process.cwd(), "config.yml")) {
  const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  validateConfig(parsed);
  return parsed;
}

function validateConfig(config) {
  const fail = (name, expected) => {
    throw new Error("Invalid config value " + name + ": expected " + expected);
  };
  const object = (name, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(name, "an object");
  };
  const number = (name, value, options = {}) => {
    const { min = -Infinity, minExclusive = false, max = Infinity, maxExclusive = false, integer = false } = options;
    if (typeof value !== "number" || !Number.isFinite(value)
      || (integer && !Number.isInteger(value))
      || (minExclusive ? value <= min : value < min)
      || (maxExclusive ? value >= max : value > max)) {
      const lower = minExclusive ? ">" : ">=";
      const upper = maxExclusive ? "<" : "<=";
      fail(name, (integer ? "an integer " : "a finite number ") + lower + " " + min + " and " + upper + " " + max);
    }
  };
  const string = (name, value) => {
    if (typeof value !== "string" || value.trim() === "") fail(name, "a non-empty string");
  };
  const boolean = (name, value) => {
    if (typeof value !== "boolean") fail(name, "true or false");
  };
  const timeframe = (name, value) => {
    if (!BINANCE_TIMEFRAMES.has(value)) fail(name, "a supported Binance kline interval");
  };
  const url = (name, value) => {
    string(name, value);
    let parsed;
    try { parsed = new URL(value); } catch { fail(name, "a valid HTTP(S) URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail(name, "a valid HTTP(S) URL");
  };

  object("root", config);
  for (const name of ["app", "binance", "scanner", "strategy", "risk", "execution", "storage", "telegram"]) {
    object(name, config[name]);
  }

  string("app.logLevel", config.app.logLevel);
  number("app.loopIntervalMs", config.app.loopIntervalMs, { min: 0, integer: true });
  boolean("app.startupReconcile", config.app.startupReconcile);

  url("binance.baseUrl", config.binance.baseUrl);
  url("binance.testnetBaseUrl", config.binance.testnetBaseUrl);
  number("binance.recvWindow", config.binance.recvWindow, { min: 0, minExclusive: true, integer: true });
  number("binance.requestTimeoutMs", config.binance.requestTimeoutMs, { min: 0, minExclusive: true, integer: true });
  number("binance.maxRetries", config.binance.maxRetries, { min: 0, integer: true });
  number("binance.leverage", config.binance.leverage, { min: 0, minExclusive: true, integer: true });
  if (config.binance.autoAdjustLeverageToBinanceLimit !== undefined) {
    boolean("binance.autoAdjustLeverageToBinanceLimit", config.binance.autoAdjustLeverageToBinanceLimit);
  }
  if (!["ISOLATED", "CROSSED"].includes(config.binance.marginType)) fail("binance.marginType", "ISOLATED or CROSSED");
  if (!["MARK_PRICE", "CONTRACT_PRICE"].includes(config.binance.workingType)) fail("binance.workingType", "MARK_PRICE or CONTRACT_PRICE");

  number("scanner.intervalMinutes", config.scanner.intervalMinutes, { min: 0, integer: true });
  number("scanner.maxCoins", config.scanner.maxCoins, { min: 0, integer: true });
  number("scanner.batchSize", config.scanner.batchSize, { min: 0, minExclusive: true, integer: true });
  number("scanner.batchDelayMs", config.scanner.batchDelayMs, { min: 0, integer: true });
  number("scanner.errorRetrySeconds", config.scanner.errorRetrySeconds, { min: 0, integer: true });
  string("scanner.quoteAsset", config.scanner.quoteAsset);
  number("scanner.minQuoteVolume", config.scanner.minQuoteVolume, { min: 0 });
  number("scanner.minAbsPriceChangePct", config.scanner.minAbsPriceChangePct, { min: 0 });
  if (!Array.isArray(config.scanner.excludeSymbols)
    || config.scanner.excludeSymbols.some(symbol => typeof symbol !== "string" || !symbol.trim())) {
    fail("scanner.excludeSymbols", "an array of non-empty symbol strings");
  }

  const s = config.strategy;
  timeframe("strategy.timeframe", s.timeframe);
  boolean("strategy.rsiEnabled", s.rsiEnabled);
  boolean("strategy.confirmationEnabled", s.confirmationEnabled);
  number("strategy.signalCheckIntervalSeconds", s.signalCheckIntervalSeconds, { min: 0 });
  number("strategy.confirmationCandles", s.confirmationCandles, { min: 1, max: 100, integer: true });
  number("strategy.rsiPeriod", s.rsiPeriod, { min: 1, minExclusive: true, integer: true });
  for (const key of ["rsiShortMin", "rsiShortMax", "rsiLongMin", "rsiLongMax"]) {
    number("strategy." + key, s[key], { min: 0, max: 100 });
  }
  if (s.rsiLongMin > s.rsiLongMax) fail("strategy.rsiLongMin", "less than or equal to strategy.rsiLongMax");
  if (s.rsiShortMin > s.rsiShortMax) fail("strategy.rsiShortMin", "less than or equal to strategy.rsiShortMax");
  number("strategy.historyCandles", s.historyCandles, { min: 0, minExclusive: true, integer: true });
  if (s.rsiEnabled && s.historyCandles < s.rsiPeriod + 2) {
    fail("strategy.historyCandles", "at least strategy.rsiPeriod + 2 candles when RSI is enabled");
  }
  number("strategy.atrPeriod", s.atrPeriod, { min: 0, minExclusive: true, integer: true });
  number("strategy.fallbackAtrMultiple", s.fallbackAtrMultiple, { min: 0, minExclusive: true });
  number("strategy.slBufferPct", s.slBufferPct, { min: 0 });
  number("strategy.minStopDistancePct", s.minStopDistancePct, { min: 0 });
  number("strategy.maxStopDistancePct", s.maxStopDistancePct, { min: 0 });
  number("strategy.rewardRiskTp1", s.rewardRiskTp1, { min: 0, minExclusive: true });
  number("strategy.rewardRiskTp2", s.rewardRiskTp2, { min: 0, minExclusive: true });
  number("strategy.tp1ClosePct", s.tp1ClosePct, { min: 0, minExclusive: true, max: 100, maxExclusive: true });
  number("strategy.breakevenOffsetPct", s.breakevenOffsetPct, { min: 0 });

  const emaBias = s.emaBias || { enabled: false, timeframe: "4h", fastPeriod: 20, slowPeriod: 50, historyCandles: 300 };
  if (s.emaBias !== undefined) object("strategy.emaBias", s.emaBias);
  boolean("strategy.emaBias.enabled", emaBias.enabled);
  timeframe("strategy.emaBias.timeframe", emaBias.timeframe);
  number("strategy.emaBias.fastPeriod", emaBias.fastPeriod, { min: 0, minExclusive: true, integer: true });
  number("strategy.emaBias.slowPeriod", emaBias.slowPeriod, { min: 0, minExclusive: true, integer: true });
  number("strategy.emaBias.historyCandles", emaBias.historyCandles, { min: 0, minExclusive: true, integer: true });

  object("strategy.adx", s.adx);
  boolean("strategy.adx.enabled", s.adx.enabled);
  timeframe("strategy.adx.timeframe", s.adx.timeframe);
  number("strategy.adx.period", s.adx.period, { min: 0, minExclusive: true, integer: true });
  number("strategy.adx.historyCandles", s.adx.historyCandles, { min: 1, integer: true });
  if (s.adx.enabled && s.adx.historyCandles < s.adx.period * 2) {
    fail("strategy.adx.historyCandles", "at least strategy.adx.period * 2 candles when ADX is enabled");
  }
  number("strategy.adx.rangeMax", s.adx.rangeMax, { min: 0 });
  number("strategy.adx.mixedMax", s.adx.mixedMax, { min: 0 });
  if (s.adx.mixedMax < s.adx.rangeMax) fail("strategy.adx.mixedMax", "greater than or equal to strategy.adx.rangeMax");
  boolean("strategy.adx.requireWeakCandleWhenDisabled", s.adx.requireWeakCandleWhenDisabled);

  number("risk.walletPercentPerTrade", config.risk.walletPercentPerTrade, { min: 0 });
  number("risk.maxActivePositions", config.risk.maxActivePositions, { min: 0, minExclusive: true, integer: true });
  number("risk.maxMarginPerTradeUsdt", config.risk.maxMarginPerTradeUsdt, { min: 0 });
  number("risk.minMarginPerTradeUsdt", config.risk.minMarginPerTradeUsdt, { min: 0 });

  number("execution.orderPollIntervalMs", config.execution.orderPollIntervalMs, { min: 0 });
  boolean("execution.priceProtect", config.execution.priceProtect);

  string("storage.databaseName", config.storage.databaseName);
  object("storage.collections", config.storage.collections);
  for (const key of ["positions", "setups", "events", "scanner"]) {
    string("storage.collections." + key, config.storage.collections[key]);
  }
  number("storage.eventRetentionDays", config.storage.eventRetentionDays, { min: 0, minExclusive: true, integer: true });

  boolean("telegram.sendStartupMessage", config.telegram.sendStartupMessage);
  return true;
}

module.exports = { loadConfig, validateConfig, BINANCE_TIMEFRAMES };
