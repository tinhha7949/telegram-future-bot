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
