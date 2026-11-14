"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../config.json");

test("every configured market ticker has an explicit Vietnamese instrument label", () => {
  for (const asset of config.assets) {
    for (const symbol of asset.marketSymbols || []) {
      assert.equal(typeof config.symbolLabels[symbol], "string", `Missing label for ${symbol} in ${asset.name}`);
      assert.ok(config.symbolLabels[symbol].length > 3);
    }
  }
});

test("commodity ticker labels distinguish gold, crude oil, gasoline and precious metals", () => {
  assert.match(config.symbolLabels["GC=F"], /Vàng/);
  assert.match(config.symbolLabels["CL=F"], /Dầu thô WTI/);
  assert.match(config.symbolLabels["BZ=F"], /Dầu thô Brent/);
  assert.match(config.symbolLabels["RB=F"], /Xăng/);
  assert.match(config.symbolLabels["PL=F"], /Bạch kim/);
  assert.match(config.symbolLabels["SI=F"], /Bạc/);
});

test("provider pacing and market freshness guards are configured", () => {
  assert.ok(config.gdeltRequestGapMs >= 8000);
  assert.ok(config.marketMaxAgeHours >= 72);
  assert.equal(config.marketFetchConcurrency, 2);
});
