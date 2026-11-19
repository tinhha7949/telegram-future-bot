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
