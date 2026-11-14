"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { marketMomentumScore, dedupeNewsEvents, buildAnalysis, analyzeAll } = require("../src/analyzer");

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

test("forecast confidence decay follows the configured horizon values", () => {
  const now = Date.now();
  const asset = { id:"energy", name:"DẦU" };
  const news = [{
    title:"Oil supply disruption",
    publishedAt:new Date(now),
    impactScore:1.5,
    sourceWeight:1,
    importance:8,
    relevance:1
  }];
  const result = buildAnalysis(asset, news, [], {
    forecastHorizons:[
      { id:"24h", label:"24 GIỜ", hours:24, confidenceDecay:0 },
      { id:"3d", label:"3 NGÀY", hours:72, confidenceDecay:4 },
      { id:"7d", label:"7 NGÀY", hours:168, confidenceDecay:8 },
      { id:"30d", label:"30 NGÀY", hours:720, confidenceDecay:14 }
    ]
  }, now);
  const confidence = result.forecasts.map(item => item.confidence);
  assert.ok(confidence[0] > confidence[1]);
  assert.ok(confidence[1] > confidence[2]);
  assert.ok(confidence[2] > confidence[3]);
});

test("30-day momentum uses a 30-day volatility scale", () => {
  const quote = { momentum:{ "30d":6 }, volatilityPct:2 };
  const expected = Math.tanh(6 / (2 * Math.sqrt(30))) * 1.8;
  assert.ok(Math.abs(marketMomentumScore(quote, "30d") - expected) < 1e-12);
});

test("syndicated copies of the same event count once while distinct events remain", () => {
  const time = new Date("2026-11-14T10:00:00Z");
  const news = [
    { assetId:"gold", title:"Federal Reserve signals interest rates may stay higher for longer", publishedAt:time, eventType:"fed_hawkish", impactScore:-1.5, source:"Reuters", sourceWeight:1.15, importance:8, relevance:1 },
    { assetId:"gold", title:"Fed indicates rates could remain higher for longer", publishedAt:new Date(time.getTime()+30*60000), eventType:"fed_hawkish", impactScore:-1.5, source:"CNBC", sourceWeight:1.15, importance:8, relevance:1 },
    { assetId:"gold", title:"Central banks increase gold purchases", publishedAt:new Date(time.getTime()+60*60000), eventType:"gold_demand", impactScore:1.5, source:"MarketWatch", sourceWeight:0.95, importance:8, relevance:1 }
  ];
  const unique = dedupeNewsEvents(news);
  assert.equal(unique.length, 2);
  assert.equal(unique.find(item => item.eventType === "fed_hawkish").corroboratingSources.length, 2);
});
