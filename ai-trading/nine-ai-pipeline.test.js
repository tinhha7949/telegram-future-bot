"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const p = require("./nine-ai-pipeline");
const central = require("./nine-ai-central-decision-engine");
const { fixture } = require("./test-fixtures.cjs");
for (const side of ["LONG", "SHORT"])
  test(
    "closed-candle " + side + " reaches the sole authorization boundary",
    () => {
      const f = fixture(side),
        d = p.analyzeNineAI(f);
      assert.equal(d.side, side);
      assert.equal(d.agents.continuation.side, side);
      assert.equal(d.agents.meanReversion.enabled, false);
      assert.equal(d.edges[side].distMAE.samples, 45);
      assert.equal(d.tradePlan.closePercentAtTP1, 50);
      assert.equal(d.tradePlan.timeoutMs, 96 * 3600000);
      assert.equal(
        central.finalizeDecision(d, {
          symbol: f.symbol,
          scannedAt: f.market.now + 1,
        }).authorizedForExecution,
        true,
      );
      const c = d.edges[side];
      assert.ok(
        Math.abs(c.edge - (c.p * c.expectedR - c.cost - c.uncertaintyPenalty)) <
          1e-12,
      );
      const other = d.edges[side === "LONG" ? "SHORT" : "LONG"];
      assert.equal(other.eligible, false);
      assert.equal(other.p, 0);
    },
  );
test("cold start, simulated labels, duplicates, future labels and missing flow cannot authorize", () => {
  const f = fixture();
  for (const outcomes of [
    [],
    f.outcomes.map((o) => ({
      ...o,
      source: "CLOSED_HISTORICAL_4H_SIMULATION",
    })),
    Array(60).fill(f.outcomes[0]),
    f.outcomes.map((o) => ({ ...o, closedAt: f.market.now + 1 })),
  ])
    assert.equal(p.analyzeNineAI({ ...f, outcomes }).action, "WAIT");
  for (const field of [
    "fundingRate",
    "liquidationImbalance",
    "openInterestChange",
    "depthNotional",
    "spreadPct",
  ])
    assert.equal(
      p.analyzeNineAI({ ...f, market: { ...f.market, [field]: null } }).action,
      "WAIT",
    );
  assert.equal(
    p.analyzeNineAI({ ...f, market: { ...f.market, fundingRate: 0.002 } })
      .action,
    "WAIT",
  );
});
test("stale/future data, a gap in 90d history and contradictory higher timeframes abstain", () => {
  const f = fixture();
  for (const snapshotAt of [f.market.now - 300001, f.market.now + 1])
    assert.equal(
      p.analyzeNineAI({ ...f, market: { ...f.market, snapshotAt } }).action,
      "WAIT",
    );
  assert.equal(
    p.analyzeNineAI({
      ...f,
      candles4h: f.candles4h.filter((_, i) => i !== 300),
    }).action,
    "WAIT",
  );
  const reversed = f.candles1d.map((c) => [
    c[0],
    500 - c[1],
    500 - c[3],
    500 - c[2],
    500 - c[4],
    c[5],
    c[6],
  ]);
  assert.equal(p.analyzeNineAI({ ...f, candles1d: reversed }).action, "WAIT");
});
test("unclosed candles never change point-in-time features", () => {
  const f = fixture(),
    before = p.analyzeNineAI(f),
    time = f.market.now;
  f.candles4h.push([time, 100, 999, 1, 900, 999, time + 14399999]);
  assert.deepEqual(p.analyzeNineAI(f), before);
  assert.equal(p.percentile([1, 2, 3, 4, 5], 0.5), 3);
});
