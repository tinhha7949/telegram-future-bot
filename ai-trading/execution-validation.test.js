"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./test-fixtures.cjs");
const { analyzeNineAI } = require("./nine-ai-pipeline");
const { validateExecution } = require("./execution-validation");
test("cached decisions revalidate current flow, costs, price and snapshot age", () => {
  const f = fixture(),
    d = analyzeNineAI(f),
    now = f.market.now + 1;
  const market = { ...f.market, markPrice: d.entry };
  assert.equal(validateExecution(d, market, now).ok, true);
  for (const patch of [
    { fundingRate: 0.002 },
    { depthNotional: null },
    { roundTripFeePct: 100 },
    { markPrice: d.sl - 1 },
  ])
    assert.equal(
      validateExecution(d, { ...market, ...patch }, now).ok,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    validateExecution(
      d,
      { ...market, snapshotAt: now + 30 * 86400000 },
      now + 120 * 60000,
    ).ok,
    false,
  );
  assert.equal(
    validateExecution({ ...d, featureSnapshot: { ...d.featureSnapshot, snapshotAt: now - 120000 } },
      { ...market, snapshotAt: now - 120000 }, now).reason,
    "MARKET_SNAPSHOT_STALE",
  );
});

test("AI-6 requires valid liquidation data but cannot veto direction by its sign", () => {
  const f = fixture(),
    d = analyzeNineAI(f),
    now = f.market.now + 1,
    market = { ...f.market, markPrice: d.entry };
  assert.equal(
    validateExecution(d, { ...market, liquidationImbalance: 0 }, now).ok,
    true,
  );
  assert.equal(
    validateExecution(d, { ...market, liquidationImbalance: null }, now).ok,
    false,
  );
  assert.equal(
    validateExecution(d, { ...market, liquidationImbalance: -0.5 }, now).ok,
    true,
    "AI-9 must remain the sole direction selector",
  );
});