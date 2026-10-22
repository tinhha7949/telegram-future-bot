"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, memoryDb } = require("./test-fixtures.cjs");
const { analyzeNineAI, percentile } = require("./nine-ai-pipeline");
const { applyPolicy, DECISION_SCHEMA_VERSION } = require("./nine-ai-policy");
const { validateExecution } = require("./execution-validation");
const { newTrade } = require("./trade-lifecycle");
const {
  createOfflineLearning,
  calibrationSummary,
  DEFAULT_CHAMPION,
} = require("./nine-ai-offline-learning");
const { executeDecisions, marketSnapshot } = require("../index");

test("SL uses winning MAE while TP quantiles include losing labeled trades", () => {
  const f = fixture(),
    base = f.outcomes[0];
  const outcomes = [
    { win: true, maePct: 0.5, mfePct: 8 },
    { win: true, maePct: 0.7, mfePct: 9 },
    { win: true, maePct: 0.9, mfePct: 10 },
    { win: false, maePct: 50, mfePct: 1 },
    { win: false, maePct: 100, mfePct: 2 },
  ].map((o, i) => ({ ...base, ...o, tradeId: "population" + i }));
  const d = analyzeNineAI({ ...f, outcomes });
  assert.equal(d.action, "LONG");
  assert.equal(d.agents.outcome.dist_MAE.samples, 3);
  assert.equal(d.agents.outcome.dist_MFE.samples, 5);
  assert.equal(d.agents.outcome.dist_MAE.p80, percentile([0.5, 0.7, 0.9], 0.8));
  assert.equal(d.agents.outcome.dist_MFE.p50, 8);
  assert.equal(d.agents.outcome.dist_MFE.p90, 9.6);
  assert.equal(d.tradePlan.targetMethod, "LABELED_MFE_P50_P90");
});

test("E[R] uses realized gross R for the direction/regime/setup, including losses", () => {
  const f = fixture(),
    base = f.outcomes[0];
  const outcomes = [
    { ...base, tradeId: "win", grossR: 3, win: true },
    { ...base, tradeId: "loss", grossR: -1, win: false },
    { ...base, tradeId: "other-side", side: "SHORT", grossR: 99 },
    {
      ...base,
      tradeId: "other-regime",
      setupKey: "DOWNTREND_CONTINUATION",
      grossR: 999,
    },
  ];
  const d = analyzeNineAI({ ...f, outcomes });
  assert.equal(d.edges.LONG.expectedR, 1);
  assert.equal(
    d.edges.LONG.expectedRSource,
    "REALIZED_GROSS_R_BY_DIRECTION_REGIME_SETUP",
  );
  const negative = analyzeNineAI({
    ...f,
    outcomes: outcomes
      .slice(0, 2)
      .map((o, i) => ({ ...o, grossR: i ? -3 : 1 })),
  });
  assert.equal(negative.edges.LONG.expectedR, -1);
  assert.equal(negative.action, "WAIT");
});

test("existing complete track record supplies E[R] before gross-R excursion labels exist", () => {
  const f = fixture(),
    first = analyzeNineAI(f),
    key = first.setupKey + "_LONG";
  const d = analyzeNineAI({
    ...f,
    market: {
      ...f.market,
      trackRecord: {
        [key]: { samples: 3, winningSamples: 1, meanGrossR: -0.5 },
      },
    },
  });
  assert.equal(d.edges.LONG.expectedR, -0.5);
  assert.equal(d.action, "WAIT");
  assert.equal(
    d.edges.LONG.expectedRSource,
    "REALIZED_GROSS_R_BY_DIRECTION_REGIME_SETUP",
  );
});

test("predicted R excludes uncertainty; actual closure preserves it for calibration", async () => {
  const f = fixture(),
    d = analyzeNineAI(f),
    c = d.edges.LONG;
  const t = newTrade(d, {
    actualQuantity: 1,
    initialRisk: 1,
    sl: d.sl,
    tp1: d.tp1,
    tp2: d.tp2,
  });
  const predicted = c.p * c.expectedR - c.cost;
  assert.equal(t.nineAiPredictionSnapshot.predictedR, predicted);
  assert.ok(Math.abs(predicted - c.edge - c.uncertaintyPenalty) < 1e-12);
  const db = memoryDb(),
    service = createOfflineLearning(db);
  await service.recordClosedTrade(t, {
    accountingComplete: true,
    pnl: predicted,
    grossRealizedPnl: predicted + 0.1,
  });
  const actual = db.collection("nine_ai_actual_outcomes").rows[0];
  assert.equal(actual.predictedR, predicted);
  assert.equal(calibrationSummary([actual]).status, "CALIBRATION_MATCH");
  assert.equal(
    calibrationSummary([{ predictedEdgeR: predicted, realizedR: predicted }])
      .samples,
    0,
  );
  const legacy = {
    side: "LONG",
    predictedProbability: 0.8,
    predictedExpectedR: 2,
    edges: { LONG: { cost: 0.1 } },
    predictedEdgeR: -99,
    realizedR: 1.5,
  };
  assert.equal(calibrationSummary([legacy]).meanPredictedR, 1.5);
  assert.equal(calibrationSummary([legacy]).status, "CALIBRATION_MATCH");
});

test("track record snapshots exclude future closures, including cache reads", async () => {
  const db = memoryDb(),
    now = 1700000000000,
    service = createOfflineLearning(db, { now: () => now });
  const actuals = db.collection("nine_ai_actual_outcomes");
  const base = {
    setupKey: "UPTREND_CONTINUATION",
    side: "LONG",
    accountingSchemaVersion: 2,
    featureSnapshot: { regime: { regime: "UPTREND" } },
  };
  await actuals.insertOne({ ...base, closedAt: now - 1, grossR: 2, netPnl: 1 });
  await actuals.insertOne({
    ...base,
    closedAt: now + 1,
    grossR: -100,
    netPnl: -1,
  });
  const key = "UPTREND_CONTINUATION_LONG";
  assert.equal((await service.getTrackRecord(now))[key].meanGrossR, 2);
  assert.deepEqual(await service.getTrackRecord(now - 2), {});
});

test("old champions/candidates cannot carry thresholds learned on an older contract into v5", async () => {
  const db = memoryDb(),
    state = db.collection("nine_ai_policy_champion");
  await state.insertOne({
    _id: "active",
    params: { ...DEFAULT_CHAMPION, minEdge: 99 },
    version: 4,
    policySchemaVersion: 4,
  });
  const service = createOfflineLearning(db);
  await service.initialize();
  assert.deepEqual(await service.getChampionConfig(), DEFAULT_CHAMPION);
  const active = await state.findOne({ _id: "active" });
  assert.equal(active.policySchemaVersion, DECISION_SCHEMA_VERSION);
  assert.equal(active.previousChampion.params.minEdge, 99);
  await state.updateOne(
    { _id: "active" },
    { $set: { params: { ...DEFAULT_CHAMPION, minEdge: 0.075 } } },
  );
  await service.initialize();
  assert.equal((await service.getChampionConfig()).minEdge, 0.075);
});

function fakeExchange(markFor = (_, entry) => entry) {
  const f = fixture(),
    entry = analyzeNineAI(f).entry;
  return {
    async fundingInterval() {
      return 8;
    },
    async request(route, { symbol }) {
      if (route.endsWith("premiumIndex"))
        return { lastFundingRate: "0.0001", markPrice: markFor(symbol, entry) };
      if (route.endsWith("openInterestHist"))
        return [
          { timestamp: Date.now() - 14400001, sumOpenInterest: "100" },
          { timestamp: Date.now() - 1, sumOpenInterest: "101" },
        ];
      if (route.endsWith("bookTicker"))
        return { bidPrice: entry - 0.005, askPrice: entry + 0.005 };
      if (route.endsWith("depth"))
        return { bids: [[entry, 10000]], asks: [[entry, 10000]] };
      throw new Error("Unexpected route " + route);
    },
    async equity() {
      return 1000;
    },
    async info() {
      return {
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
          { filterType: "PRICE_FILTER", tickSize: ".001" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ],
      };
    },
  };
}

test("funding credits retain their sign in snapshots, live edge and execution validation", async () => {
  const market = await marketSnapshot(fakeExchange(), "TESTUSDT");
  assert.ok(Math.abs(market.expectedFundingCostPctBySide.LONG - 0.12) < 1e-12);
  assert.ok(Math.abs(market.expectedFundingCostPctBySide.SHORT + 0.12) < 1e-12);
  const f = fixture(),
    d = analyzeNineAI({
      ...f,
      market: {
        ...f.market,
        fundingRate: -0.0001,
        expectedFundingCostPctBySide: { LONG: -0.5, SHORT: 0.5 },
      },
    });
  assert.equal(d.action, "LONG");
  assert.ok(d.edges.LONG.cost < 0);
  const fresh = {
    ...f.market,
    fundingRate: -0.0001,
    expectedFundingCostPctBySide: { LONG: -0.5, SHORT: 0.5 },
    markPrice: d.entry,
  };
  assert.equal(validateExecution(d, fresh, f.market.now + 1).ok, true);
});

test("runtime tries all approved signals beyond ten and permits multiple entries in one scan", async () => {
  const f = fixture(),
    base = analyzeNineAI(f),
    signals = Array.from({ length: 12 }, (_, i) => ({
      ...structuredClone(base),
      symbol: "TEST" + i + "USDT",
    }));
  const entered = [],
    lifecycle = {
      uncertain: false,
      untracked: new Set(),
      active: new Map(
        Array.from({ length: 20 }, (_, i) => [i, { symbol: "EXISTING" + i }]),
      ),
      claims: {
        async findOne() {
          return null;
        },
      },
      async enter(t) {
        entered.push(t);
        return true;
      },
    };
  await executeDecisions(signals, {
    exchange: fakeExchange((symbol, entry) =>
      Number(symbol.match(/\d+/)[0]) < 10 ? base.sl - 1 : entry,
    ),
    lifecycle,
    async report() {},
  });
  assert.deepEqual(
    entered.map((t) => t.symbol),
    ["TEST10USDT", "TEST11USDT"],
  );
  entered.length = 0;
  await executeDecisions(signals, {
    exchange: fakeExchange(),
    lifecycle,
    async report() {},
  });
  assert.equal(entered.length, 12);
});

test("one symbol's API failure does not discard the remaining approved signals", async () => {
  const base = analyzeNineAI(fixture()), entered = [];
  const signals = ["FIRSTUSDT", "SECONDUSDT"].map((symbol) => ({ ...structuredClone(base), symbol }));
  const exchange = fakeExchange(), request = exchange.request;
  exchange.request = async (route, params) => {
    if (params.symbol === "FIRSTUSDT") throw new Error("temporary symbol outage");
    return request(route, params);
  };
  const lifecycle = { uncertain: false, untracked: new Set(), active: new Map(),
    claims: { findOne: async () => null }, enter: async (t) => entered.push(t.symbol) };
  await executeDecisions(signals, { exchange, lifecycle });
  assert.deepEqual(entered, ["SECONDUSDT"]);
});

test("a pause arriving during awaited preparation prevents the market submission", async () => {
  const base = analyzeNineAI(fixture()), exchange = fakeExchange();
  let paused = false, entries = 0;
  const info = exchange.info;
  exchange.info = async () => { paused = true; return info(); };
  const lifecycle = { uncertain: false, untracked: new Set(), active: new Map(),
    claims: { findOne: async () => null }, enter: async () => { entries++; } };
  await executeDecisions([base], { exchange, lifecycle, entriesPaused: () => paused });
  assert.equal(entries, 0);
});

test("AI-9 edge and gap comparisons are strict and WAIT remains the default", () => {
  const base = {
    regime: { regime: "UPTREND" },
    agents: { flow: { fundingRate: 0 } },
    edges: {
      LONG: {
        p: 1,
        expectedR: 0.5,
        cost: 0,
        baseUncertainty: 0,
        eligible: true,
        plan: {},
      },
      SHORT: {
        p: 1,
        expectedR: 0.25,
        cost: 0,
        baseUncertainty: 0,
        eligible: true,
        plan: {},
      },
    },
  };
  assert.equal(
    applyPolicy(base, { minEdge: 0.5, gapEdge: 0.125 }).side,
    "WAIT",
  );
  assert.equal(applyPolicy(base, { minEdge: 0, gapEdge: 0.25 }).side, "WAIT");
  assert.equal(
    applyPolicy(base, { minEdge: 0.25, gapEdge: 0.125 }).side,
    "LONG",
  );
  const reversed = {
    ...base,
    edges: { LONG: base.edges.SHORT, SHORT: base.edges.LONG },
  };
  assert.equal(
    applyPolicy(reversed, { minEdge: 0.25, gapEdge: 0.125 }).side,
    "SHORT",
  );
});
