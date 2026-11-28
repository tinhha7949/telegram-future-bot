"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, loadConfig, BINANCE_TIMEFRAMES } = require("../src/config");
const fs = require("node:fs");
const YAML = require("yaml");
function readDefaultConfig() { return YAML.parse(fs.readFileSync("config.yml", "utf8")); }

test("checked-in config validates and loads unchanged", () => {
  const config = readDefaultConfig();
  assert.equal(validateConfig(config), true);
  assert.deepEqual(loadConfig(), config);
  assert.equal(config.strategy.timeframe, "15m");
  assert.equal(config.strategy.pullbackEmaPeriod, 9);
  assert.equal(config.strategy.emaBias.enabled, true);
  assert.equal(config.strategy.emaBias.timeframe, "1h");
  assert.equal(config.strategy.emaBias.period, 9);
});
test("trade and EMA bias timeframes remain independently configurable", () => {
  const config = readDefaultConfig();
  for (const timeframe of BINANCE_TIMEFRAMES) {
    config.strategy.timeframe = timeframe;
    config.strategy.emaBias.timeframe = timeframe;
    assert.equal(validateConfig(config), true, timeframe);
  }
});
test("pullback EMA period, lookback, tolerance and other strategy tuning remain editable", () => {
  const config = readDefaultConfig();
  config.strategy.pullbackEmaPeriod = 21;
  config.strategy.pullbackLookbackCandles = 12;
  config.strategy.pullbackEmaTolerancePct = 0.4;
  config.strategy.historyCandles = 500;
  config.strategy.signalCheckIntervalSeconds = 5;
  config.strategy.adx.period = 120;
  config.strategy.adx.historyCandles = 300;
  config.risk.walletPercentPerTrade = 125;
  config.risk.maxActivePositions = 250;
  config.binance.leverage = 150;
  config.strategy.rewardRiskTp1 = 2.5;
  config.strategy.rewardRiskTp2 = 4;
  assert.equal(validateConfig(config), true);
});
test("zero is accepted for configurable delays, polling and optional buffers", () => {
  const config = readDefaultConfig();
  config.app.loopIntervalMs = 0;
  config.scanner.intervalMinutes = 0;
  config.scanner.batchDelayMs = 0;
  config.scanner.errorRetrySeconds = 0;
  config.strategy.signalCheckIntervalSeconds = 0;
  config.strategy.pullbackEmaTolerancePct = 0;
  config.strategy.slBufferPct = 0;
  config.strategy.minStopDistancePct = 0;
  config.strategy.breakevenOffsetPct = 0;
  config.risk.walletPercentPerTrade = 0;
  config.risk.maxMarginPerTradeUsdt = 0;
  config.risk.minMarginPerTradeUsdt = 0;
  config.execution.orderPollIntervalMs = 0;
  assert.equal(validateConfig(config), true);
});
test("EMA bias period and timeframe can be changed without hardcoded defaults", () => {
  const config = readDefaultConfig();
  config.strategy.emaBias.period = 50;
  config.strategy.emaBias.historyCandles = 600;
  config.strategy.emaBias.timeframe = "4h";
  assert.equal(validateConfig(config), true);
  config.strategy.emaBias.enabled = false;
  assert.equal(validateConfig(config), true);
});
test("validation rejects invalid timeframes and malformed pullback settings", () => {
  const config = readDefaultConfig();
  config.strategy.timeframe = "5minutes";
  assert.throws(() => validateConfig(config), /strategy.timeframe/);
  config.strategy.timeframe = "15m";
  config.strategy.pullbackEmaPeriod = 0;
  assert.throws(() => validateConfig(config), /strategy.pullbackEmaPeriod/);
  config.strategy.pullbackEmaPeriod = 9;
  config.strategy.pullbackLookbackCandles = 0;
  assert.throws(() => validateConfig(config), /strategy.pullbackLookbackCandles/);
  config.strategy.pullbackLookbackCandles = 5;
  config.strategy.adx.mixedMax = config.strategy.adx.rangeMax - 1;
  assert.throws(() => validateConfig(config), /strategy.adx.mixedMax/);
});

test("market-behavior filter settings are fully configurable and validated", () => {
  const config = readDefaultConfig();
  config.strategy.marketBehavior.lookbackCandles = 30;
  config.strategy.marketBehavior.historyCandles = 100;
  config.strategy.marketBehavior.minScore = 60;
  config.strategy.marketBehavior.enabled = false;
  assert.equal(validateConfig(config), true);
  config.strategy.marketBehavior.minScore = 101;
  assert.throws(() => validateConfig(config), /strategy.marketBehavior.minScore/);
});
