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
test("invalid or simulated labels never masquerade as an AI-7 model", () => {
  const f = fixture();
  for (const outcomes of [
    [],
    f.outcomes.map((o) => ({
      ...o,
      source: "CLOSED_HISTORICAL_4H_SIMULATION",
    })),
    f.outcomes.map((o) => ({ ...o, closedAt: f.market.now + 1 })),
  ]) {
    const d = p.analyzeNineAI({ ...f, outcomes });
    assert.equal(d.action, "LONG");
    assert.equal(d.agents.outcome.enabled, false);
    assert.equal(d.agents.outcome.mode, "AI2_INITIAL");
    assert.equal(d.agents.outcome.dist_MAE, null);
    assert.equal(d.agents.outcome.dist_MFE, null);
  }
  const deduplicated = p.analyzeNineAI({
    ...f,
    outcomes: Array(60).fill(f.outcomes[0]),
  });
  assert.equal(deduplicated.agents.outcome.dist_MAE.samples, 1);
});
test("initial trades require cost inputs and block hot funding", () => {
  const f = { ...fixture(), outcomes: [] };
  for (const field of [
    "fundingRate",
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
for (const side of ["LONG", "SHORT"]) {
  test(
    "empty history can authorize " +
      side +
      " using AI-2, without bypassing AI-9",
    () => {
      const f = { ...fixture(side), outcomes: [] };
      const d = p.analyzeNineAI(f);
      assert.equal(d.action, side);
      assert.equal(d.agents.outcome.enabled, false);
      assert.equal(d.agents.outcome.source, "AI2_STRUCTURE_INITIAL_PLAN");
      assert.equal(d.tradePlan.outcomeMode, "AI2_INITIAL");
      assert.equal(d.tradePlan.stopMethod, "AI2_STRUCTURE_INITIAL_STOP");
      assert.equal(
        d.edges[side].probabilitySource,
        "FEATURE_SCORE_UNCALIBRATED",
      );
      assert.equal(d.closePercentAtTP1, 50);
      assert.equal(d.timeoutCandles, 24);
      assert.equal(
        central.finalizeDecision(d, {
          symbol: f.symbol,
          scannedAt: f.market.now + 1,
        }).action,
        side,
      );
      const c = d.edges[side];
      assert.ok(
        Math.abs(c.edge - (c.p * c.expectedR - c.cost - c.uncertaintyPenalty)) <
          1e-12,
      );
      assert.equal(
        p.analyzeNineAI({ ...f, config: { minEdge: 100 } }).action,
        "WAIT",
      );
    },
  );
  test(
    "first winning " +
      side +
      " label switches directly to AI-7 even if targets coincide",
    () => {
      const f = fixture(side);
      for (const count of [1, 2]) {
        const outcomes = f.outcomes.slice(0, count);
        const d = p.analyzeNineAI({ ...f, outcomes });
        assert.equal(d.action, side);
        assert.equal(d.agents.outcome.enabled, true);
        assert.equal(d.tradePlan.outcomeMode, "AI7_LABELED");
        assert.equal(
          d.agents.outcome.dist_MAE.p80,
          p.percentile(
            outcomes.map((o) => o.maePct),
            0.8,
          ),
        );
        assert.equal(
          d.agents.outcome.dist_MFE.p50,
          p.percentile(
            outcomes.map((o) => o.mfePct),
            0.5,
          ),
        );
        assert.equal(
          d.agents.outcome.dist_MFE.p90,
          p.percentile(
            outcomes.map((o) => o.mfePct),
            0.9,
          ),
        );
        if (count === 1) assert.equal(d.tp1, d.tp2);
        assert.equal(
          central.finalizeDecision(d, {
            symbol: f.symbol,
            scannedAt: f.market.now + 1,
          }).action,
          side,
        );
      }
    },
  );
}
test("a losing first label contributes to probability but cannot invent winning quantiles", () => {
  const f = fixture();
  const d = p.analyzeNineAI({
    ...f,
    outcomes: [{ ...f.outcomes[0], win: false }],
  });
  assert.equal(d.agents.outcome.mode, "AI2_INITIAL");
  assert.equal(d.edges.LONG.samples, 1);
  assert.ok(d.edges.LONG.p > 0 && d.edges.LONG.p < 0.5);
  assert.equal(d.agents.outcome.dist_MAE, null);
  assert.equal(d.agents.outcome.dist_MFE, null);
});
test("labeled outcome quantiles do not require 30 winning live trades", () => {
  for (const side of ["LONG", "SHORT"]) {
    const f = fixture(side);
    const outcomes = f.outcomes
      .filter((o) => o.setupKey.endsWith("CONTINUATION"))
      .slice(0, 3);
    const d = p.analyzeNineAI({ ...f, outcomes });
    assert.equal(d.action, side);
    assert.equal(d.agents.outcome.dist_MAE.samples, 3);
    assert.equal(d.agents.outcome.dist_MFE.samples, 3);
    assert.equal(
      d.agents.outcome.dist_MAE.p80,
      p.percentile(
        outcomes.map((o) => o.maePct),
        0.8,
      ),
    );
    assert.equal(
      d.tp1,
      d.entry *
        (1 +
          ((side === "LONG" ? 1 : -1) *
            p.percentile(
              outcomes.map((o) => o.mfePct),
              0.5,
            )) /
            100),
    );
    assert.equal(
      d.tp2,
      d.entry *
        (1 +
          ((side === "LONG" ? 1 : -1) *
            p.percentile(
              outcomes.map((o) => o.mfePct),
              0.9,
            )) /
            100),
    );
  }
});
test("stale/future data and a gap in 90d closed 4h history abstain", () => {
  const f = fixture();
  for (const snapshotAt of [f.market.now - 30 * 86400000, f.market.now + 1])
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
});
test("unclosed candles never change point-in-time features", () => {
  const f = fixture(),
    before = p.analyzeNineAI(f),
    time = f.market.now;
  f.candles4h.push([time, 100, 999, 1, 900, 999, time + 14399999]);
  assert.deepEqual(p.analyzeNineAI(f), before);
  assert.equal(p.percentile([1, 2, 3, 4, 5], 0.5), 3);
});

test("20/90-day realized volatility and momentum use only closed 4h returns", () => {
  for (const side of ["LONG", "SHORT"]) {
    const f = fixture(side),
      d = p.analyzeNineAI(f),
      cs = p.closedCandles(f.candles4h, f.market.now),
      closes = cs.map((c) => c.close),
      returns = closes.slice(1).map((close, i) => Math.log(close / closes[i]));
    const realized = (bars) => {
      const xs = returns.slice(-bars),
        avg = xs.reduce((sum, v) => sum + v, 0) / xs.length;
      return (
        Math.sqrt(xs.reduce((sum, v) => sum + (v - avg) ** 2, 0) / xs.length) *
        Math.sqrt(6 * 365) *
        100
      );
    };
    assert.equal(d.action, side);
    assert.equal(d.timeframe, "4h");
    assert.ok(Math.abs(d.regime.realized_vol_20d - realized(120)) < 1e-12);
    assert.ok(Math.abs(d.regime.realized_vol_90d - realized(540)) < 1e-12);
    assert.equal(d.regime.momentum5, closes.at(-1) / closes.at(-31) - 1);
    assert.equal(d.regime.momentum20, closes.at(-1) / closes.at(-121) - 1);
  }
});

test("opposing momentum within 4h history cannot classify an uptrend", () => {
  const f = fixture(),
    cs = p.closedCandles(f.candles4h, f.market.now);
  cs.at(-1).close = cs.at(-31).close * 0.999;
  const regime = p.classifyRegime(cs);
  assert.ok(regime.momentum20 > 0);
  assert.ok(regime.momentum5 < 0);
  assert.notEqual(regime.regime, "UPTREND");
});
