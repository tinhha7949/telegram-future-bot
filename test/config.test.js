"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../src/config");
const fs = require("node:fs");
const YAML = require("yaml");
test("default config validates", () => validateConfig(YAML.parse(fs.readFileSync("config.yml","utf8"))));
test("normal editable values are accepted", () => {
  const c = YAML.parse(fs.readFileSync("config.yml","utf8"));
  c.scanner.maxCoins = 75; c.risk.walletPercentPerTrade = 7.5; c.strategy.slBufferPct = .1;
  c.strategy.rsiShortMin = 71; c.strategy.rsiShortMax = 76;
  c.strategy.rsiLongMin = 24; c.strategy.rsiLongMax = 29;
  assert.equal(validateConfig(c), true);
});
test("zero cooldown is not a config field and does not affect validation", () => {
  const c = YAML.parse(fs.readFileSync("config.yml","utf8"));
  c.risk.walletPercentPerTrade = 10;
  assert.equal(validateConfig(c), true);
});

test("scanner batch size and delay are editable", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.scanner.batchSize = 5;
  c.scanner.batchDelayMs = 2500;
  assert.equal(validateConfig(c), true);
});
test("scanner batch settings reject unsafe ranges", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.scanner.batchSize = 0;
  assert.throws(() => validateConfig(c), /scanner.batchSize/);
  c.scanner.batchSize = 10;
  c.scanner.batchDelayMs = 60001;
  assert.throws(() => validateConfig(c), /scanner.batchDelayMs/);
});
test("maximum open positions defaults to 20 and remains editable", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  assert.equal(c.risk.maxActivePositions, 20);
  c.risk.maxActivePositions = 12;
  assert.equal(validateConfig(c), true);
});

test("signal polling defaults to one minute and remains configurable", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  assert.equal(c.strategy.signalCheckIntervalSeconds, 60);
  c.strategy.signalCheckIntervalSeconds = 30;
  assert.equal(validateConfig(c), true);
});

test("signal polling interval rejects values outside safe range", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.strategy.signalCheckIntervalSeconds = 5;
  assert.throws(() => validateConfig(c), /strategy.signalCheckIntervalSeconds/);
  c.strategy.signalCheckIntervalSeconds = 301;
  assert.throws(() => validateConfig(c), /strategy.signalCheckIntervalSeconds/);
});

test("RSI zones use inclusive lower and upper bounds and remain editable", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  assert.equal(c.strategy.rsiShortMin, 70);
  assert.equal(c.strategy.rsiShortMax, 75);
  assert.equal(c.strategy.rsiLongMin, 25);
  assert.equal(c.strategy.rsiLongMax, 30);
  c.strategy.rsiShortMin = 72;
  c.strategy.rsiShortMax = 78;
  c.strategy.rsiLongMin = 22;
  c.strategy.rsiLongMax = 28;
  assert.equal(validateConfig(c), true);
});

test("RSI zone boundaries reject reversed or overlapping ranges", () => {
  const c = YAML.parse(fs.readFileSync("config.yml", "utf8"));
  c.strategy.rsiShortMin = 76;
  assert.throws(() => validateConfig(c), /RSI short minimum/);
  c.strategy.rsiShortMin = 70;
  c.strategy.rsiLongMax = 70;
  assert.throws(() => validateConfig(c), /RSI long zone/);
});
