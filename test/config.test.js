"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, BINANCE_TIMEFRAMES } = require("../src/config");
const fs = require("node:fs");
const YAML = require("yaml");

test("default config validates with one 15m strategy timeframe", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  assert.equal(c.strategy.timeframe, "15m");
  assert.equal(validateConfig(c), true);
});
test("one timeframe is freely editable to supported Binance intervals", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  for (const timeframe of ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"]) {
    c.strategy.timeframe = timeframe;
    assert.equal(validateConfig(c), true, timeframe);
  }
  assert.ok(BINANCE_TIMEFRAMES.has("5m"));
});
test("invalid Binance timeframe is rejected clearly", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.strategy.timeframe = "5minutes";
  assert.throws(() => validateConfig(c), /strategy.timeframe/);
});
test("normal editable risk and scanner values remain accepted", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.scanner.maxCoins = 75;
  c.risk.walletPercentPerTrade = 7.5;
  c.strategy.slBufferPct = .1;
  assert.equal(validateConfig(c), true);
});
test("scanner batch size and delay are editable and bounded", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.scanner.batchSize = 5;
  c.scanner.batchDelayMs = 2500;
  assert.equal(validateConfig(c), true);
  c.scanner.batchSize = 0;
  assert.throws(() => validateConfig(c), /scanner.batchSize/);
  c.scanner.batchSize = 10;
  c.scanner.batchDelayMs = 60001;
  assert.throws(() => validateConfig(c), /scanner.batchDelayMs/);
});
test("maximum open positions and signal polling remain editable", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.risk.maxActivePositions = 12;
  c.strategy.signalCheckIntervalSeconds = 30;
  assert.equal(validateConfig(c), true);
  c.strategy.signalCheckIntervalSeconds = 5;
  assert.throws(() => validateConfig(c), /strategy.signalCheckIntervalSeconds/);
});
test("RSI signal zones accept configured boundaries and remain non-overlapping", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  assert.deepEqual(
    [c.strategy.rsiShortMin, c.strategy.rsiShortMax, c.strategy.rsiLongMin, c.strategy.rsiLongMax],
    [65, 70, 30, 35]
  );
  c.strategy.rsiShortMin = 66;
  c.strategy.rsiShortMax = 72;
  c.strategy.rsiLongMin = 28;
  c.strategy.rsiLongMax = 34;
  assert.equal(validateConfig(c), true);
  c.strategy.rsiShortMin = 72;
  c.strategy.rsiShortMax = 66;
  assert.throws(() => validateConfig(c), /RSI short minimum/);
  c.strategy.rsiShortMin = 65;
  c.strategy.rsiShortMax = 70;
  c.strategy.rsiLongMax = 70;
  assert.throws(() => validateConfig(c), /RSI long zone/);
});

test("maximum confirmation candles is editable from 1 to 20", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  assert.equal(c.strategy.maxConfirmationCandles, 3);
  for (const n of [1, 2, 3, 5, 10, 20]) {
    c.strategy.maxConfirmationCandles = n;
    assert.equal(validateConfig(c), true, String(n));
  }
  c.strategy.maxConfirmationCandles = 0;
  assert.throws(() => validateConfig(c), /strategy.maxConfirmationCandles/);
  c.strategy.maxConfirmationCandles = 21;
  assert.throws(() => validateConfig(c), /strategy.maxConfirmationCandles/);
});

test("bias is enabled by default and its timeframe and EMA period are editable", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  assert.deepEqual(c.strategy.bias, { enabled: true, timeframe: "1h", emaPeriod: 100 });
  c.strategy.bias.enabled = false;
  c.strategy.bias.timeframe = "4h";
  c.strategy.bias.emaPeriod = 200;
  assert.equal(validateConfig(c), true);
});
test("invalid bias timeframe and EMA period are rejected", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.strategy.bias.timeframe = "5minutes";
  assert.throws(() => validateConfig(c), /strategy.bias.timeframe/);
  c.strategy.bias.timeframe = "1h";
  c.strategy.bias.emaPeriod = 1;
  assert.throws(() => validateConfig(c), /strategy.bias.emaPeriod/);
});
