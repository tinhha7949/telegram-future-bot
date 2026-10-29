"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, memoryDb } = require("./test-fixtures.cjs");
const { CONFIG } = require("./config");
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

test("AI7 uses recency-weighted realized excursions, including losses, for MAE/MFE and TP1 RR floor", () => {
  const f = fixture(), base = f.outcomes[0];
  const outcomes = Array.from({length:100},(_,i)=>({
    ...base, tradeId:"population-"+i, win:i<75,
    maePct:0.5+(i%5)*0.1,
    mfePct:i<75?8+(i%3):1+(i%2)
  }));
  const d=analyzeNineAI({...f,outcomes});
  assert.equal(d.action,"LONG");
  assert.equal(d.agents.outcome.enabled,true);
  assert.equal(d.agents.outcome.dist_MAE.samples,100);
  assert.equal(d.agents.outcome.dist_MFE.samples,100);
  const weightedPercentile = require("./online-learning").weightedPercentile;
  assert.equal(d.agents.outcome.dist_MAE.p80,weightedPercentile(outcomes.map(o=>o.maePct),0.8));
  assert.equal(d.agents.outcome.dist_MFE.p50,weightedPercentile(outcomes.map(o=>o.mfePct),0.5));
  assert.equal(d.agents.outcome.dist_MFE.p90,weightedPercentile(outcomes.map(o=>o.mfePct),0.9));
  assert.equal(d.tradePlan.targetMethod,"LABELED_MFE_P50_P90");
  assert.ok((d.tp1-d.entry)/(d.entry-d.sl)>=0.8-1e-12);
});

test("AI-4 uses realized gross R after the EARLY phase, including losses and excluding other groups", () => {
  const f = fixture(),
    base = f.outcomes[0];
  const outcomes = Array.from({ length: 30 }, (_, i) => ({
    ...base,
    tradeId: "same-setup-" + i,
    grossR: i < 15 ? 3 : -1,
    win: i < 15,
  })).concat([
    { ...base, tradeId: "other-side", side: "SHORT", grossR: 99 },
    { ...base, tradeId: "other-regime", setupKey: "DOWNTREND_CONTINUATION", grossR: 999 },
  ]);
  const d = analyzeNineAI({ ...f, outcomes });
  assert.equal(d.edges.LONG.expectedR, 1);
  assert.equal(d.edges.LONG.expectedRSource, "REALIZED_GROSS_R_BY_DIRECTION_REGIME_SETUP");
  const negative = analyzeNineAI({
    ...f,
    outcomes: Array.from({ length: 30 }, (_, i) => ({
      ...base,
      tradeId: "negative-" + i,
      grossR: i < 15 ? 1 : -3,
      win: i < 15,
    })),
  });
  assert.equal(negative.edges.LONG.expectedR, -1);
  assert.equal(negative.action, "WAIT");
});

test("MATURE track record supplies E[R] after the configured label threshold", () => {
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
  assert.equal(calibrationSummary([actual]).status, "INSUFFICIENT_CALIBRATION_SAMPLES");
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
  assert.equal(calibrationSummary([legacy]).status, "INSUFFICIENT_CALIBRATION_SAMPLES");
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
  assert.equal((await service.getChampionConfig()).minEdge, CONFIG.MIN_EDGE);
});

function fakeExchange(markFor = (_, entry) => entry) {
  const f = fixture(),
    entry = analyzeNineAI(f).entry;
  return {
    // Test-only explicit liquidation feed. Production uses its live feed.
    getLiquidationImbalance() { return 0.3; },
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
    async equity() { return 1000; },
    async accountState(symbol) { return { equity: 1000, availableBalance: 10000, leverageBySymbol: { [symbol]: { leverage: 20, maxNotional: 250000 } } }; },
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

// Explicit mock: production must require a durable risk ledger, never a missing guard.
const permitRisk = { assess: async()=>({ok:true}), reserve: async()=>({ok:true}) };
test("runtime tries all approved signals beyond ten and permits multiple entries in one scan", async () => {
  const f = fixture(),
    base = require("./nine-ai-central-decision-engine").finalizeDecision(
      analyzeNineAI(f), { symbol: f.symbol, scannedAt: f.market.now + 1 },
    ),
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
    riskGuard: permitRisk,
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
    riskGuard: permitRisk,
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
  await executeDecisions(signals, { exchange, lifecycle, riskGuard: permitRisk });
  assert.deepEqual(entered, ["SECONDUSDT"]);
});

test("a pause arriving during awaited preparation prevents the market submission", async () => {
  const base = analyzeNineAI(fixture()), exchange = fakeExchange();
  let paused = false, entries = 0;
  const info = exchange.info;
  exchange.info = async () => { paused = true; return info(); };
  const lifecycle = { uncertain: false, untracked: new Set(), active: new Map(),
    claims: { findOne: async () => null }, enter: async () => { entries++; } };
  await executeDecisions([base], { exchange, lifecycle, riskGuard: permitRisk, entriesPaused: () => paused });
  assert.equal(entries, 0);
});

test("AI-9 edge and gap comparisons are strict and WAIT remains the default", () => {
  const base = {
    regime: { regime: "UPTREND" },
    agents: { flow: { fundingRate: 0, openInterestChange: 0,
      liquidationImbalance: 1, confirmation: "CONFIRMED", confirmationSide: "LONG" } },
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
    agents: { flow: { ...base.agents.flow, liquidationImbalance: -1, confirmationSide: "SHORT" } },
    edges: { LONG: base.edges.SHORT, SHORT: base.edges.LONG },
  };
  assert.equal(
    applyPolicy(reversed, { minEdge: 0.25, gapEdge: 0.125 }).side,
    "SHORT",
  );
});

test("stale historical open interest cannot confirm a new AI3/AI6 signal",async()=>{
  const exchange=fakeExchange();
  const request=exchange.request;
  exchange.request=async(route,params)=>{
    if(route.endsWith("openInterestHist")){
      const at=Date.now()-3*14400000;
      return [{timestamp:at-14400000,sumOpenInterest:"100"},
        {timestamp:at,sumOpenInterest:"101"}];
    }
    return request(route,params);
  };
  const market=await marketSnapshot(exchange,"TESTUSDT");
  assert.equal(market.openInterestChange,null);
  assert.equal(market.oiObservedAt,null);
  const f=fixture(), d=analyzeNineAI({
    ...f,market:{...f.market,openInterestChange:market.openInterestChange},
  });
  assert.equal(d.action,"WAIT");
  assert.equal(d.reason,"EXECUTION_COST_INPUTS_MISSING_OPEN_INTEREST_CHANGE");
});
