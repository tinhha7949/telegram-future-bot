"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { evaluatePlan, CONTRACT } = require("./opportunity-outcome");
const { DECISION_SCHEMA_VERSION } = require("./nine-ai-policy");
const {
  computeEvaluations,
  normalizeCandles,
} = require("./nine-ai-decision-journal");
const plan = { entry: 100, sl: 99, tp1: 102, tp2: 104 };
test("funding credits use the identical signed cost in offline evaluation", () => {
  const start = 1700000000000,
    bar = 14400000;
  const candles = Array.from({ length: 25 }, (_, i) => ({
    time: start + i * bar,
    closeTime: start + (i + 1) * bar - 1,
    open: 100,
    high: 100.1,
    low: 99.9,
    close: 100,
  }));
  const record = {
    signalTime: candles[0].closeTime,
    decisionSnapshot: {
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      featureSnapshot: {
        feePct: 0.1,
        estSlippagePct: 0.1,
        fundingCostPctBySide: { LONG: -0.5, SHORT: 0.5 },
      },
      edges: {
        LONG: { eligible: true, plan },
        SHORT: { eligible: false, plan: null },
      },
    },
  };
  const evaluated = computeEvaluations(record, candles, start + 26 * bar);
  assert.equal(evaluated.outcomeStatus, "EVALUATED");
  assert.ok(
    Math.abs(evaluated.evaluations[24].costPctBySide.LONG + 0.3) < 1e-12,
  );
  assert.ok(Math.abs(evaluated.evaluations[24].longNetR - 0.3) < 1e-12);
  assert.ok(evaluated.evaluations[24].longOutcome.costR < 0);
});
test("same exit contract handles 60% TP1, remaining stop, TP2 and timeout conservatively", () => {
  const costs = { totalCostPct: 0.1 };
  let r = evaluatePlan(
    plan,
    "LONG",
    [
      { open: 100, low: 99.5, high: 102.5, close: 102 },
      { open: 102, low: 101, high: 104, close: 104 },
    ],
    costs,
  );
  assert.equal(r.grossR, 2.8);
  assert.ok(Math.abs(r.netR - 2.7) < 1e-12);
  assert.equal(r.exitReason, "TP2");
  r = evaluatePlan(
    plan,
    "LONG",
    [
      { open: 100, low: 99.5, high: 102.5, close: 102 },
      { open: 101, low: 98, high: 103, close: 99 },
    ],
    costs,
  );
  assert.equal(r.grossR, 0.8);
  assert.equal(r.exitReason, "SL");
  r = evaluatePlan(
    plan,
    "LONG",
    [{ open: 100, low: 98, high: 105, close: 104 }],
    costs,
  );
  assert.equal(r.grossR, -1);
  assert.equal(r.tp1Hit, false);
  r = evaluatePlan(
    plan,
    "LONG",
    [{ open: 100, low: 99.5, high: 101, close: 100.5 }],
    costs,
  );
  assert.equal(r.exitReason, "TIMEOUT");
  assert.equal(r.grossR, 0.5);
});
test("the shared live/offline contract accepts coincident p50/p90 targets", () => {
  const r = evaluatePlan(
    { ...plan, tp2: plan.tp1 },
    "LONG",
    [{ open: 100, low: 99.5, high: 103, close: 102 }],
    { totalCostPct: 0.1 },
  );
  assert.equal(r.tp1Hit, true);
  assert.equal(r.grossR, 2);
  assert.equal(r.netR, 1.9);
  assert.equal(r.exitReason, "TP2");
});

test("24-bar evaluation waits for the final closed bar and freezes only the matured outcome", () => {
  const now = Date.now(),
    bar = 14400000;
  const candles = normalizeCandles(
    Array.from({ length: 30 }, (_, i) => {
      const time = now - (30 - i) * bar + 1;
      return [time, 100, 100.8, 99.5, 100.5, 100, time + bar - 1];
    }),
  );
  const record = {
    signalTime: candles[5].closeTime,
    decisionSnapshot: {
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      edges: { LONG: { eligible: true, plan }, SHORT: { eligible: false } },
      featureSnapshot: {
        feePct: 0.1,
        fundingCostPctBySide: { LONG: 0, SHORT: 0 },
        estSlippagePct: 0,
      },
    },
  };
  const finalClose = candles[29].closeTime;
  assert.equal(computeEvaluations(record, candles, finalClose), null);
  const result = computeEvaluations(record, candles, finalClose + 1);
  assert.equal(result.evaluations[24].contract, CONTRACT);
  assert.equal(result.evaluations[24].shortNetR, null);
  assert.equal(result.outcomeStatus, "EVALUATED");
  assert.equal(
    computeEvaluations({ ...record, ...result }, candles, finalClose + 10000),
    null,
  );
});
