"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { evaluatePlan, CONTRACT } = require("./opportunity-outcome");
const {
  computeEvaluations,
  normalizeCandles,
} = require("./nine-ai-decision-journal");
const plan = { entry: 100, sl: 99, tp1: 102, tp2: 104 };
test("same exit contract handles 50% TP1, remaining stop, TP2 and timeout conservatively", () => {
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
  assert.equal(r.grossR, 3);
  assert.equal(r.netR, 2.9);
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
  assert.equal(r.grossR, 0.5);
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
      decisionSchemaVersion: 3,
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
