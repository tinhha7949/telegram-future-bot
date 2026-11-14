"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { marketMomentumScore, buildAnalysis, analyzeAll } = require("../src/analyzer");

test("missing momentum stays unavailable instead of becoming a false zero", () => {
  assert.equal(marketMomentumScore({
    momentum:{ "3d":null },
    changePercent:2,
    volatilityPct:1
  }, "3d"), null);
});

test("configured analysis weights control the relative contribution of news and momentum", () => {
  const asset = { id:"energy", name:"DẦU" };
  const now = Date.now();
  const news = [{
    title:"Oil supply disruption",
    publishedAt:new Date(now),
    impactScore:1.5,
    sourceWeight:1,
    importance:8,
    relevance:1,
    eventType:"supply_disruption"
  }];
  const markets = [{
    assetId:"energy",
    symbol:"CL=F",
    momentum:{ "24h":-2 },
    changePercent:-2,
    volatilityPct:1
  }];
  const newsWeighted = buildAnalysis(asset, news, markets, {
    analysis:{ directionThreshold:0.55, newsWeight:1, momentumWeight:0, crossMarketWeight:0 }
  }, now);
  const momentumWeighted = buildAnalysis(asset, news, markets, {
    analysis:{ directionThreshold:0.55, newsWeight:0, momentumWeight:1, crossMarketWeight:0 }
  }, now);

  assert.equal(newsWeighted.direction, "BULLISH");
  assert.equal(momentumWeighted.direction, "BEARISH");
});

test("analyzeAll excludes stale market snapshots", async () => {
  const now = Date.now();
  const config = {
    marketMaxAgeHours:96,
    assets:[{ id:"energy", name:"DẦU" }],
    analysis:{ directionThreshold:0.55 }
  };
  const storage = {
    getLatestMarkets:async () => [{
      assetId:"energy",
      symbol:"CL=F",
      marketTime:new Date(now - 200 * 3600000),
      momentum:{ "24h":4 },
      changePercent:4,
      volatilityPct:1
    }],
    getRecentNews:async () => []
  };
  const result = await analyzeAll(config, storage);
  assert.equal(result[0].direction, "NEUTRAL");
  assert.equal(result[0].evidenceCount, 0);
});
