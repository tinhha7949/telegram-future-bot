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

test("multiple free news providers cover every asset and have independent fallback identities", () => {
  assert.ok(config.newsSources.length >= 12);
  const ids = config.newsSources.map(source => source.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const asset of config.assets) {
    assert.ok(config.newsSources.some(source => source.kind === "google-news" && source.assetId === asset.id), "Missing Google News fallback for " + asset.id);
  }
  assert.ok(config.newsSources.some(source => source.url && source.url.includes("federalreserve.gov")));
  assert.ok(config.newsSources.some(source => source.url && source.url.includes("eia.gov")));
  assert.ok(config.marketMaxAgeHours >= 72);
  assert.equal(config.marketFetchConcurrency, 2);
});

test("news feeds and automatic headline translation have Vietnamese display settings", () => {
  assert.equal(config.translationTimeoutMs, 6000);
  assert.ok(config.translationConcurrency >= 1);
  const untranslatedNames = new Set(["CNBC Markets", "MarketWatch", "Federal Reserve", "US Energy Information Administration", "European Central Bank", "BBC Business", "Deutsche Welle"]);
  for (const source of config.newsSources) {
    if (source.name) assert.ok(!untranslatedNames.has(source.name), "Source name should be Vietnamese: " + source.id);
  }
});
