"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreNews, directionFromScore, buildAnalysis } = require("../src/analyzer");
const { localParts } = require("../src/scheduler");
const { hash } = require("../src/storage");

test("news scoring identifies directional language and importance", () => {
  const bullish = scoreNews("Gold surges as safe haven demand rises");
  const bearish = scoreNews("Oil prices fall amid oversupply");
  assert.equal(bullish.label, "positive");
  assert.equal(bearish.label, "negative");
  assert.ok(bullish.importance >= 3);
});

test("direction thresholds avoid forced bullish or bearish calls", () => {
  assert.equal(directionFromScore(2), "BULLISH");
  assert.equal(directionFromScore(-2), "BEARISH");
  assert.equal(directionFromScore(0.5), "NEUTRAL");
});

test("analysis reports neutral when there is no evidence", () => {
  const result = buildAnalysis({ id: "gold", name: "GOLD" }, [], []);
  assert.equal(result.direction, "NEUTRAL");
  assert.ok(result.confidence <= 50);
});

test("analysis generates four separate forecast horizons", () => {
  const result = buildAnalysis({ id: "gold", name: "GOLD" }, [], [], {});
  assert.deepEqual(result.forecasts.map(x => x.horizon), ["24h", "3d", "7d", "30d"]);
  assert.ok(result.forecasts[3].confidence <= result.forecasts[0].confidence);
  assert.equal(result.forecasts[0].direction, "NEUTRAL");
});

test("hash is deterministic", () => {
  assert.equal(hash("same"), hash("same"));
  assert.notEqual(hash("same"), hash("different"));
});

test("timezone formatter uses the configured timezone", () => {
  const parts = localParts(new Date("2026-11-14T00:00:00.000Z"), "Asia/Ho_Chi_Minh");
  assert.equal(parts.hour, "07");
});