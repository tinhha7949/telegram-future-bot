"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyHeadline, scoreNews, directionFromScore, buildAnalysis } = require("../src/analyzer");
const { localParts } = require("../src/scheduler");
const { hash } = require("../src/storage");
const { fetchYahoo } = require("../src/collectors");

test("asset-specific classifier maps hawkish Fed news against gold and toward USD", () => {
  const title = "Federal Reserve signals a hawkish stance and higher rates for longer";
  const gold = classifyHeadline(title, "gold");
  const usd = classifyHeadline(title, "usd");
  assert.equal(gold.eventType, "fed_hawkish");
  assert.ok(gold.impactScore < 0);
  assert.ok(usd.impactScore > 0);
  assert.ok(gold.importance >= 8);
});

test("supply disruption is bullish for oil but not automatically bullish for stocks", () => {
  const title = "Oil supply disruption after pipeline attack raises crude risk";
  assert.ok(classifyHeadline(title, "energy").impactScore > 0);
  assert.ok(classifyHeadline(title, "stocks").impactScore <= 0);
});

test("unclassified headline does not invent a directional impact", () => {
  const result = classifyHeadline("Markets await company update", "gold");
  assert.equal(result.eventType, "unclassified");
  assert.equal(result.impactScore, 0);
  assert.equal(result.sentiment, "neutral");
});

test("scoreNews remains deterministic", () => {
  const result = scoreNews("Gold ETF inflows rise as central banks increase purchases", "gold");
  assert.equal(result.label, "positive");
  assert.ok(result.score > 0);
});

test("direction thresholds keep weak evidence neutral", () => {
  assert.equal(directionFromScore(1), "BULLISH");
  assert.equal(directionFromScore(-1), "BEARISH");
  assert.equal(directionFromScore(0.2), "NEUTRAL");
});

test("empty evidence produces neutral forecasts at all four horizons", () => {
  const result = buildAnalysis({ id:"gold", name:"GOLD" }, [], [], {});
  assert.deepEqual(result.forecasts.map(item => item.horizon), ["24h", "3d", "7d", "30d"]);
  assert.ok(result.forecasts.every(item => item.direction === "NEUTRAL"));
  assert.ok(result.forecasts.every(item => item.confidence <= 22));
});

test("news and market momentum are calculated per horizon", () => {
  const now = Date.now();
  const news = [{
    title:"Fed signals dovish policy and rate cuts", eventType:"fed_dovish",
    impactScore:1.5, sentiment:"positive", importance:9, relevance:1,
    sourceWeight:1.1, publishedAt:new Date(now - 2 * 3600000)
  }];
  const markets = [
    { assetId:"gold", symbol:"GC=F", changePercent:0.7, momentum:{ "24h":0.7, "3d":1.4, "7d":2, "30d":4.5 }, volatilityPct:0.7 },
    { assetId:"usd", symbol:"DX-Y.NYB", changePercent:0.1, momentum:{ "24h":0.1, "3d":0.2, "7d":0.3, "30d":0.4 }, volatilityPct:0.3 },
    { assetId:"macro", symbol:"^TNX", changePercent:0.02, momentum:{ "24h":0.02, "3d":0.04, "7d":0.06, "30d":0.1 }, volatilityPct:0.02 }
  ];
  const result = buildAnalysis({ id:"gold", name:"GOLD" }, news, markets, {}, now);
  assert.equal(result.analysisMethod, "deterministic-quantitative");
  assert.equal(result.forecasts.length, 4);
  assert.ok(result.forecasts[0].evidenceCount >= 2);
  assert.equal(result.forecasts[0].breakdown.length, 3);
});

test("confidence is explicitly not a win probability", () => {
  const result = buildAnalysis({ id:"energy", name:"OIL" }, [], [], {});
  assert.match(result.caveat, /không phải xác suất thắng/i);
});

test("hash is deterministic", () => {
  assert.equal(hash("same"), hash("same"));
  assert.notEqual(hash("same"), hash("different"));
});

test("timezone formatter uses Vietnam timezone", () => {
  const parts = localParts(new Date("2026-11-14T00:00:00.000Z"), "Asia/Ho_Chi_Minh");
  assert.equal(parts.hour, "07");
});

test("historical quote collector remains exported", () => {
  assert.equal(typeof fetchYahoo, "function");
});
