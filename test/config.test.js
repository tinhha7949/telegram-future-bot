"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, loadConfig, BINANCE_TIMEFRAMES } = require("../src/config");
const fs = require("node:fs");
const YAML = require("yaml");

function readDefaultConfig() {
  return YAML.parse(fs.readFileSync("config.yml", "utf8"));
}

test("the checked-in config validates without asserting fixed strategy defaults", () => {
  const config = readDefaultConfig();
  assert.equal(validateConfig(config), true);
  assert.deepEqual(loadConfig(), config);
});

test("trade and ADX timeframes can be independently selected from supported Binance intervals", () => {
  const config = readDefaultConfig();
  for (const timeframe of BINANCE_TIMEFRAMES) {
    config.strategy.timeframe = timeframe;
    config.strategy.adx.timeframe = timeframe;
    assert.equal(validateConfig(config), true, timeframe);
  }
});

test("strategy, ADX, scanner, risk and execution tuning values are not capped by stale test limits", () => {
  const config = readDefaultConfig();
  config.scanner.maxCoins = 500;
  config.scanner.batchSize = 100;
  config.scanner.errorRetrySeconds = 5;
  config.strategy.rsiPeriod = 120;
  config.strategy.signalCheckIntervalSeconds = 5;
  config.strategy.historyCandles = 1000;
  config.strategy.adx.period = 120;
  config.strategy.adx.historyCandles = 300;
  config.strategy.adx.rangeMax = 19.5;
  config.strategy.adx.mixedMax = 27.5;
  config.risk.walletPercentPerTrade = 125;
  config.risk.maxActivePositions = 250;
  config.binance.leverage = 150;
  config.strategy.rewardRiskTp1 = 2.5;
  config.strategy.rewardRiskTp2 = 4;
  assert.equal(validateConfig(config), true);
});

test("zero is accepted for configurable delay, polling, retry and optional buffer values", () => {
  const config = readDefaultConfig();
  config.app.loopIntervalMs = 0;
  config.scanner.intervalMinutes = 0;
  config.scanner.batchDelayMs = 0;
  config.scanner.errorRetrySeconds = 0;
  config.strategy.signalCheckIntervalSeconds = 0;
  config.strategy.slBufferPct = 0;
  config.strategy.minStopDistancePct = 0;
  config.strategy.breakevenOffsetPct = 0;
  config.risk.walletPercentPerTrade = 0;
  config.risk.maxMarginPerTradeUsdt = 0;
  config.risk.minMarginPerTradeUsdt = 0;
  config.execution.orderPollIntervalMs = 0;
  assert.equal(validateConfig(config), true);
});

test("RSI boundaries remain editable anywhere inside the mathematical RSI range", () => {
  const config = readDefaultConfig();
  config.strategy.rsiShortMin = 72;
  config.strategy.rsiShortMax = 80;
  config.strategy.rsiLongMin = 20;
  config.strategy.rsiLongMax = 28;
  assert.equal(validateConfig(config), true);
  config.strategy.rsiShortMin = 95;
  config.strategy.rsiShortMax = 100;
  config.strategy.rsiLongMin = 0;
  config.strategy.rsiLongMax = 5;
  assert.equal(validateConfig(config), true);
});

test("RSI and breakout switches plus confirmation candle count are editable", () => {
  const config = readDefaultConfig();
  config.strategy.rsiEnabled = false;
  config.strategy.confirmationEnabled = false;
  config.strategy.confirmationCandles = 7;
  config.strategy.rsiLongMin = 22;
  config.strategy.rsiLongMax = 29;
  config.strategy.rsiShortMin = 71;
  config.strategy.rsiShortMax = 79;
  assert.equal(validateConfig(config), true);
});
test("disabled RSI and ADX do not reject unused history settings", () => {
  const config = readDefaultConfig();
  config.strategy.rsiEnabled = false;
  config.strategy.rsiPeriod = 120;
  config.strategy.historyCandles = 10;
  config.strategy.adx.enabled = false;
  config.strategy.adx.period = 120;
  config.strategy.adx.historyCandles = 10;
  assert.equal(validateConfig(config), true);
});

test("ADX enable switch, period, regime thresholds and no-ADX candle requirement are editable", () => {
  const config = readDefaultConfig();
  config.strategy.adx.enabled = false;
  config.strategy.adx.period = 28;
  config.strategy.adx.historyCandles = 80;
  config.strategy.adx.rangeMax = 18;
  config.strategy.adx.mixedMax = 24;
  config.strategy.adx.requireWeakCandleWhenDisabled = false;
  assert.equal(validateConfig(config), true);
});

test("validation rejects malformed types, timeframes and inverted ADX thresholds", () => {
  const config = readDefaultConfig();
  config.strategy.timeframe = "5minutes";
  assert.throws(() => validateConfig(config), /strategy.timeframe/);

  config.strategy.timeframe = "5m";
  config.strategy.rsiPeriod = 0;
  assert.throws(() => validateConfig(config), /strategy.rsiPeriod/);

  config.strategy.rsiPeriod = 14;
  config.strategy.rsiShortMax = 101;
  assert.throws(() => validateConfig(config), /strategy.rsiShortMax/);

  config.strategy.rsiShortMax = 70;
  config.strategy.adx.mixedMax = config.strategy.adx.rangeMax - 1;
  assert.throws(() => validateConfig(config), /strategy.adx.mixedMax/);

  config.strategy.adx.mixedMax = 26;
  config.strategy.adx.enabled = true;
  config.strategy.adx.historyCandles = 27;
  assert.throws(() => validateConfig(config), /strategy.adx.historyCandles/);

  config.strategy.adx.historyCandles = 100;
  config.strategy.adx.enabled = "false";
  assert.throws(() => validateConfig(config), /strategy.adx.enabled/);

  config.strategy.adx.enabled = false;
  config.strategy.rsiLongMin = 40;
  config.strategy.rsiLongMax = 30;
  assert.throws(() => validateConfig(config), /strategy.rsiLongMin/);

  config.strategy.rsiLongMin = 30;
  config.strategy.confirmationEnabled = "false";
  assert.throws(() => validateConfig(config), /strategy.confirmationEnabled/);
});
