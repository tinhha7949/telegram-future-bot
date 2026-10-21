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
    { liquidationImbalance: -0.3 },
    { depthNotional: null },
    { roundTripFeePct: 100 },
    { markPrice: d.sl - 1 },
    { snapshotAt: now - 30001 },
  ])
    assert.equal(
      validateExecution(d, { ...market, ...patch }, now).ok,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    validateExecution(
      d,
      { ...market, snapshotAt: now + 120 * 60000 },
      now + 120 * 60000,
    ).ok,
    false,
  );
});
