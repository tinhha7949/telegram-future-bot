"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./test-fixtures.cjs");
const { analyzeNineAI, swingPoints } = require("./nine-ai-pipeline");
const {
  applyPolicy,
  selectDirectionCandidate,
  netEdge,
  DECISION_SCHEMA_VERSION,
} = require("./nine-ai-policy");
const { finalizeDecision } = require("./nine-ai-central-decision-engine");
const { validateExecution } = require("./execution-validation");
const { sizeTrade } = require("./binance-execution");
const { newTrade, hydrateFill } = require("./trade-lifecycle");
const info = {
  filters: [
    {
      filterType: "LOT_SIZE",
      stepSize: ".001",
      minQty: ".001",
      maxQty: "100000",
    },
    {
      filterType: "MARKET_LOT_SIZE",
      stepSize: ".001",
      minQty: ".001",
      maxQty: "100000",
    },
    { filterType: "PRICE_FILTER", tickSize: ".01" },
    { filterType: "MIN_NOTIONAL", notional: "5" },
  ],
};
for (const side of ["LONG", "SHORT"])
  test(
    side + " AI-7 stop is solely MAE p80 before and after the actual fill",
    () => {
      const f = fixture(side),
        d = analyzeNineAI(f),
        q = d.agents.outcome;
      const sign = side === "LONG" ? 1 : -1;
      assert.equal(d.action, side);
      assert.equal(d.sl, d.entry * (1 - (sign * q.dist_MAE.p80) / 100));
      assert.equal(d.tradePlan.stopMethod, "WINNING_MAE_P80");
      assert.equal(d.tp1, d.entry * (1 + (sign * q.dist_MFE.p50) / 100));
      assert.equal(d.tp2, d.entry * (1 + (sign * q.dist_MFE.p90) / 100));
      const c = d.edges[side],
        cost =
          f.market.roundTripFeePct +
          f.market.expectedFundingCostPctBySide[side] +
          d.agents.fill.est_slippage;
      assert.ok(Math.abs(c.cost - cost / q.dist_MAE.p80) < 1e-10);
      const sizing = sizeTrade(d, 1000, 0.0075, info);
      assert.ok(sizing);
      const t = newTrade(d, sizing),
        actualEntry = d.entry * 1.001;
      hydrateFill(t, {
        executedQty: String(sizing.quantity),
        avgPrice: String(actualEntry),
        time: f.market.now,
        status: "FILLED",
        orderId: 1,
      });
      const raw = actualEntry * (1 - (sign * q.dist_MAE.p80) / 100);
      assert.equal(t.entryExecution.rawQuantileSL, raw);
      assert.ok(sign * (t.sl - raw) >= -1e-10);
      assert.ok(Math.abs(t.sl - raw) < sizing.rules.tick + 1e-10);
      assert.equal(
        t.entryExecution.rawQuantileTP1,
        actualEntry * (1 + (sign * q.dist_MFE.p50) / 100),
      );
    },
  );
test("AI7 rejects 100 opposite-side labels and remains ATR fallback", () => {
  const f = fixture();
  const outcomes = f.outcomes.slice(0, 100).map((o,i) =>
    ({...o, tradeId: "opposite-"+i, symbol: "OTHERUSDT", side: "SHORT"}));
  const d = analyzeNineAI({ ...f, outcomes });
  assert.equal(d.action, "LONG");
  assert.equal(d.agents.outcome.enabled, false);
  assert.equal(d.tradePlan.stopMethod, "ATR14_COLD_START_STOP");
});
test("zero measured MAE cannot silently turn into an ATR/structure stop", () => {
  const f = fixture(),
    d = analyzeNineAI({ ...f, outcomes: f.outcomes.slice(0,100).map(o=>({...o, maePct:0})) });
  assert.equal(d.action, "WAIT");
  assert.equal(d.tradePlan, undefined);
});
test("fractal high is the middle of its two adjacent highs", () => {
  const cs = [
    { high: 2, low: 1 },
    { high: 3, low: 1.5 },
    { high: 2.5, low: 1 },
  ];
  assert.deepEqual(swingPoints(cs).highs, [{ index: 1, price: 3 }]);
});
test("neutral, missing or opposite liquidation is confirmation data, not a separate entry veto", () => {
  const f = fixture();
  for (const imbalance of [0, null, -0.8]) {
    const d = analyzeNineAI({
      ...f,
      market: { ...f.market, liquidationImbalance: imbalance },
    });
    assert.equal(d.action, "LONG");
    assert.equal(
      finalizeDecision(d, { symbol: f.symbol, scannedAt: f.market.now + 1 })
        .action,
      "LONG",
    );
    assert.equal(
      validateExecution(
        d,
        { ...f.market, liquidationImbalance: imbalance, markPrice: d.entry },
        f.market.now + 1,
      ).ok,
      true,
    );
  }
  const noSetup = fixture();
  noSetup.candles4h.at(-1)[4] = noSetup.candles4h.at(-2)[4];
  assert.equal(analyzeNineAI(noSetup).action, "WAIT");
});
test("Continuation does not acquire a volume, impulse-size or positive-OI prerequisite", () => {
  const f = fixture();
  f.candles4h.at(-1)[5] = 1;
  f.candles4h.at(-1)[1] = f.candles4h.at(-1)[4] - 0.0001;
  const d = analyzeNineAI({
    ...f,
    market: { ...f.market, openInterestChange: -0.1 },
  });
  assert.equal(d.agents.continuation.side, "LONG");
  assert.equal(d.action, "LONG");
});
test("AI-9 selects setup by its net edge, never a fixed role priority", () => {
  const a = { name: "continuation", p: 0.9, expectedR: 1, cost: 0.2 };
  const b = { name: "breakout", p: 0.8, expectedR: 2, cost: 0.3 };
  assert.equal(selectDirectionCandidate([a, b], 0.1).name, "breakout");
  assert.equal(selectDirectionCandidate([b, a], 0.1).name, "breakout");
  assert.equal(netEdge(b, 0.1), b.p * b.expectedR - b.cost - 0.1);
  const f = fixture(),
    d = analyzeNineAI(f);
  d.agents.structure.structure_bias = "BEARISH";
  d.agents.flow = { confirmation: "NEUTRAL", confirmationSide: null };
  assert.equal(applyPolicy(d, d.decisionPolicy).side, "LONG");
});
test("stale data increases uncertainty without a hidden five-minute cutoff", () => {
  const f = fixture(),
    fresh = analyzeNineAI(f);
  const stale = analyzeNineAI({
    ...f,
    market: { ...f.market, snapshotAt: f.market.now - 300001 },
  });
  assert.equal(stale.action, "LONG");
  assert.equal(stale.edges.LONG.uncertaintyPenalty, fresh.edges.LONG.uncertaintyPenalty);
  assert.equal(
    finalizeDecision(fresh, {
      symbol: f.symbol,
      scannedAt: f.market.now + 300001,
    }).action,
    "LONG",
  );
  const old = analyzeNineAI({
    ...f,
    market: { ...f.market, snapshotAt: f.market.now - 30 * 86400000 },
  });
  assert.equal(old.action, "WAIT");
  const d = analyzeNineAI(f);
  assert.equal(
    validateExecution(
      d,
      {
        ...f.market,
        markPrice: d.entry,
        snapshotAt: f.market.now - 30 * 86400000,
      },
      f.market.now,
    ).ok,
    false,
  );
});
test("universe selection adds no turnover, daily-range, stablecoin or top-80 strategy filter", async () => {
  const { universe } = require("../index");
  const symbols = Array.from({ length: 100 }, (_, i) => ({
    symbol: "COIN" + i + "USDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
  }));
  symbols.push({
    symbol: "USDCUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
  });
  const selected = await universe({
    symbols: async () => symbols,
    request: async () => {
      throw Error("Unrequested ticker filter");
    },
  });
  assert.equal(selected.length, 101);
  assert.ok(selected.includes("USDCUSDT"));
});
test("AI-2 bias does not override a valid AI-3 setup and AI-9 edge", () => {
  const f = fixture(),
    n = f.candles4h.length;
  for (let k = n - 20; k < n - 2; k++) {
    const c = f.candles4h[k],
      v = 162.9 + (n - 3 - k) * 0.002 + 0.03 * Math.sin(k * 0.8);
    c[1] = v - 0.005;
    c[2] = v + 0.01;
    c[3] = v - 0.01;
    c[4] = v;
  }
  const d = analyzeNineAI(f);
  assert.equal(d.agents.structure.structure_bias, "BEARISH");
  assert.equal(d.agents.continuation.side, "LONG");
  assert.equal(d.action, "LONG");
});
test("Breakout uses volume expansion and a held range, with spread priced as cost", () => {
  const f = fixture(),
    bars = f.candles4h.slice(-22, -2),
    hi = Math.max(...bars.map((c) => c[2])),
    lo = Math.min(...bars.map((c) => c[3])),
    width = hi - lo;
  const prev = f.candles4h.at(-2),
    last = f.candles4h.at(-1);
  prev[1] = hi - 0.1 * width;
  prev[2] = hi + 0.15 * width;
  prev[3] = hi - 0.15 * width;
  prev[4] = hi + 0.1 * width;
  prev[5] = 101;
  last[1] = prev[4];
  last[2] = hi + 0.25 * width;
  last[3] = hi + 0.03 * width;
  last[4] = hi + 0.2 * width;
  last[5] = 100;
  const d = analyzeNineAI({ ...f, market: { ...f.market, spreadPct: 0.2 } });
  assert.equal(d.agents.breakout.side, "LONG");
  assert.equal(d.action, "LONG");
  prev[5] = 100;
  assert.equal(analyzeNineAI(f).agents.breakout.side, null);
  prev[5] = 101;
  last[3] = hi - 0.001;
  assert.equal(analyzeNineAI(f).agents.breakout.side, null);
});
test("old cached decisions cannot reintroduce prior stops, gates or timeframe context", async () => {
  const journal = require("./nine-ai-decision-journal"),
    { memoryDb } = require("./test-fixtures.cjs"),
    db = memoryDb();
  const f = fixture(),
    d = analyzeNineAI(f);
  for (const version of [2, 3, 4]) {
    assert.equal(
      finalizeDecision(
        { ...d, decisionSchemaVersion: version },
        { symbol: f.symbol, scannedAt: f.market.now },
      ).reason,
      "LEGACY_DECISION_REJECTED",
    );
  }
  await journal.initialize(db);
  const args = {
    symbol: f.symbol,
    signalTime: d.signalAt,
    scannedAt: f.market.now,
    marketWindow: f.candles4h,
  };
  for (const version of [2, 3, 4]) {
    await journal.recordDecision({
      ...args,
      decision: { ...d, decisionSchemaVersion: version },
    });
  }
  assert.equal(
    await journal.getDecisionForCandle(
      f.symbol,
      d.signalAt,
      DECISION_SCHEMA_VERSION,
    ),
    null,
  );
  await journal.recordDecision({ ...args, decision: d });
  assert.equal(
    (
      await journal.getDecisionForCandle(
        f.symbol,
        d.signalAt,
        DECISION_SCHEMA_VERSION,
      )
    ).decisionSchemaVersion,
    DECISION_SCHEMA_VERSION,
  );
  assert.equal(db.collection(journal.COLLECTION).rows.length, 4);
});
