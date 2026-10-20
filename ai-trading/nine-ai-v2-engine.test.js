"use strict";
const assert = require("node:assert/strict");
const engine = require("./nine-ai-v2-engine");
const decisionGate = require("./nine-ai-central-decision-engine");

const now = Date.UTC(2026, 9, 20, 20, 2, 0);
function candles(count, stepMs, base = 100, trend = 0.001) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const openTime = now - (count - i) * stepMs;
    const open = base * Math.exp(trend * i);
    const close = open * (1 + (i % 2 ? 0.003 : 0.001));
    rows.push([openTime, open, Math.max(open, close) * 1.002, Math.min(open, close) * 0.998,
      close, 1000 + (i % 5) * 10, openTime + stepMs - 1]);
  }
  return rows;
}
const closed = candles(100, engine.TIMEFRAME_MS);
const daily = candles(100, engine.DAILY_MS, 100, 0.0002);

const parsed = engine.parseClosedCandles(closed, engine.TIMEFRAME_MS, now);
assert.equal(parsed.length, 100, "all fully closed candles should be parsed");
const withOpenCandle = [...closed, [now, 200, 202, 199, 201, 100, now + engine.TIMEFRAME_MS - 1]];
assert.equal(engine.parseClosedCandles(withOpenCandle, engine.TIMEFRAME_MS, now).length, 100,
  "forming candle must be excluded");
assert.equal(engine.parseClosedCandles([[1, 0, 0, 0, 0, 1, 2]], engine.TIMEFRAME_MS, now).length, 0,
  "invalid OHLC must be excluded");

const regime = engine.estimateRegime(parsed, engine.parseClosedCandles(daily, engine.DAILY_MS, now));
assert.notEqual(regime.regime, "UNKNOWN");
assert.ok(regime.regime_conf >= 0 && regime.regime_conf <= 1);

const structure = engine.findFractalStructure(parsed);
assert.ok(["LONG", "SHORT", "NEUTRAL", "UNKNOWN"].includes(structure.structure_bias));

const labels = Array.from({ length: 40 }, (_, i) => ({
  labelled: true, setupFamily: "CONTINUATION", regime: "TREND_UP", side: "LONG",
  result: i < 28 ? "WIN" : "LOSS", netR: i < 28 ? 1.1 : -1,
  maePct: 0.004 + i * 0.00001, mfePct: 0.01 + i * 0.0001
}));
const distribution = engine.buildOutcomeDistribution(labels, "CONTINUATION", "TREND_UP", "LONG");
assert.equal(distribution.ready, true);
assert.equal(distribution.samples, 40);
assert.ok(distribution.dist_MAE.p80 > 0);
assert.ok(distribution.dist_MFE.p50 > 0);
assert.ok(distribution.dist_MFE.p90 >= distribution.dist_MFE.p50);
assert.equal(engine.buildOutcomeDistribution(labels.slice(0, 20), "CONTINUATION", "TREND_UP", "LONG").ready, false);

const noLabels = engine.analyzeNineAI(closed, "BTCUSDT", {
  dailyCandles: daily, fundingRate: 0, openInterestChangePct: 1,
  spreadBps: 2, depthUsd: 100000, latencyMs: 100, outcomes: []
}, now);
assert.equal(noLabels.action, "WAIT", "no empirical outcomes must never create a live signal");
assert.equal(noLabels.authorizedForExecution, false);

const wrongSetup = decisionGate.finalizeDecision({
  setup: "NINE_AI_15M", side: "LONG", authorizedForExecution: true
}, { symbol: "BTCUSDT", scannedAt: now });
assert.equal(wrongSetup.action, "WAIT");
assert.equal(wrongSetup.reason, "NON_NINE_AI_SETUP_REJECTED");

const oldSignal = decisionGate.finalizeDecision({
  setup: "NINE_AI_4H", side: "LONG", authorizedForExecution: true,
  symbol: "BTCUSDT", candles: 100, signalAt: now - 60 * 60 * 1000,
  entry: 100, sl: 99, tp1: 101, tp2: 102, tp: 102,
  edge: 0.5, edges: { long: 0.5, short: 0 }, riskFraction: 0.0075,
  roles: decisionGate.REQUIRED_ROLES.map(name => ({ name }))
}, { symbol: "BTCUSDT", scannedAt: now });
assert.equal(oldSignal.action, "WAIT");
assert.equal(oldSignal.reason, "STALE_OR_INVALID_CLOSED_CANDLE_SIGNAL");

const validDecision = {
  setup: "NINE_AI_4H", side: "LONG", authorizedForExecution: true,
  symbol: "BTCUSDT", candles: 100, signalAt: now - 1000,
  entry: 100, sl: 99, tp1: 101, tp2: 102, tp: 102,
  edge: 0.5, edges: { long: 0.5, short: 0.1 }, riskFraction: 0.0075,
  roles: decisionGate.REQUIRED_ROLES.map(name => ({ name }))
};
const approved = decisionGate.finalizeDecision(validDecision, { symbol: "BTCUSDT", scannedAt: now });
assert.equal(approved.action, "LONG");
assert.equal(approved.authorizedForExecution, true);
assert.equal(approved.tp, 102);

const wrongRisk = decisionGate.finalizeDecision({ ...validDecision, riskFraction: 0.05 }, { symbol: "BTCUSDT", scannedAt: now });
assert.equal(wrongRisk.action, "WAIT");
assert.equal(wrongRisk.reason, "RISK_FRACTION_MUST_BE_0_75_PERCENT");

console.log("Nine-AI v2 engine tests passed");
