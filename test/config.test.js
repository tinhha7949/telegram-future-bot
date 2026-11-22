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

test("all supported Binance strategy intervals can be selected without changing tests", () => {
  const config = readDefaultConfig();
  for (const timeframe of BINANCE_TIMEFRAMES) {
    config.strategy.timeframe = timeframe;
    config.strategy.bias.timeframe = timeframe;
    assert.equal(validateConfig(config), true, timeframe);
  }
});

test("strategy, scanner, risk and execution tuning values are not capped by stale test limits", () => {
  const config = readDefaultConfig();
  config.scanner.maxCoins = 500;
  config.scanner.batchSize = 100;
  config.scanner.errorRetrySeconds = 5;
  config.strategy.rsiPeriod = 120;
  config.strategy.signalCheckIntervalSeconds = 5;
  config.strategy.maxConfirmationCandles = 25;
  config.strategy.historyCandles = 1000;
  config.strategy.swingLookback = 250;
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
  config.strategy.maxConfirmationCandles = 0;
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

test("validation rejects malformed types and values that cannot be used safely", () => {
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
  config.strategy.tp1ClosePct = 100;
  assert.throws(() => validateConfig(config), /strategy.tp1ClosePct/);

  config.strategy.tp1ClosePct = 60;
  config.scanner.batchDelayMs = -1;
  assert.throws(() => validateConfig(config), /scanner.batchDelayMs/);

  config.scanner.batchDelayMs = 0;
  config.execution.priceProtect = "false";
  assert.throws(() => validateConfig(config), /execution.priceProtect/);
});

test("bias parameters are independently editable and bias can be disabled", () => {
  const config = readDefaultConfig();
  config.strategy.bias.enabled = false;
  config.strategy.bias.timeframe = "5m";
  config.strategy.bias.emaPeriod = 250;
  assert.equal(validateConfig(config), true);
});
