"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const l = require("./nine-ai-offline-learning");
const { applyPolicy } = require("./nine-ai-policy");
const { CONTRACT } = require("./opportunity-outcome");
const plan = { entry: 100, sl: 99, tp1: 102, tp2: 104 };
const row = (i = 0) => ({
  signalTime: 1700000000000 + i * l.BAR_MS,
  outcomeStatus: "EVALUATED",
  decisionSnapshot: {
    decisionSchemaVersion: 2,
    setup: "NINE_AI_4H",
    regime: { regime: "UPTREND" },
    agents: { flow: { confirmation: "CONFIRMED", confirmationSide: "LONG" } },
    edges: {
      LONG: {
        eligible: true,
        p: 0.8,
        expectedR: 1,
        cost: 0.1,
        baseUncertainty: 0.1,
        plan,
      },
      SHORT: {
        eligible: false,
        p: 0,
        expectedR: 0,
        cost: 0.1,
        baseUncertainty: 0.1,
        plan: null,
      },
    },
  },
  evaluations: { 24: { contract: CONTRACT, longNetR: 0.4, shortNetR: null } },
});
test("live/offline action and opportunity cohort are identical", () => {
  const rows = Array.from({ length: 600 }, (_, i) => row(i));
  for (const params of [l.DEFAULT_CHAMPION, { minEdge: 0.7, gapEdge: 0.1 }])
    assert.equal(
      l.policyAction(rows[0], params),
      applyPolicy(rows[0].decisionSnapshot, params).side,
    );
  assert.equal(
    l.evaluatePolicy(
      [...rows, { ...row(), evaluations: {} }],
      l.DEFAULT_CHAMPION,
    ).opportunities,
    600,
  );
  assert.equal(l.evaluatePolicy(rows, l.DEFAULT_CHAMPION).trades, 600);
  const s = l.walkForwardSplits(rows);
  assert.ok(
    s.validation[0].signalTime - s.train.at(-1).signalTime >=
      2 * l.PURGE_EMBARGO_MS,
  );
  assert.ok(
    s.test[0].signalTime - s.validation.at(-1).signalTime >=
      2 * l.PURGE_EMBARGO_MS,
  );
  assert.notEqual(l.trainCandidate(rows).status, "SHADOW_PENDING");
});
test("realized R uses actual initial position risk and accounting must be complete", async () => {
  let saved;
  const service = l.createOfflineLearning({
    collection: () => ({
      updateOne: async (_, u) => {
        saved = u.$set;
      },
    }),
  });
  const trade = {
    symbol: "TEST",
    side: "LONG",
    createdAt: 1,
    risk: 7.5,
    actualQuantity: 10,
    initialRisk: 0.1,
  };
  assert.equal(
    (await service.recordClosedTrade(trade, { pnl: -1 })).recorded,
    false,
  );
  const result = await service.recordClosedTrade(trade, {
    pnl: -1,
    grossRealizedPnl: -1,
    accountingComplete: true,
  });
  assert.equal(result.realizedR, -1);
  assert.equal(saved.actualInitialRiskUSDT, 1);
});
test("calibration flags drift without changing champion parameters", () => {
  assert.equal(
    l.calibrationSummary(
      Array.from({ length: 40 }, () => ({ predictedEdgeR: 1, realizedR: -1 })),
    ).status,
    "RED_FLAG_CALIBRATION_DRIFT",
  );
  assert.equal(
    l.calibrationSummary([{ predictedEdgeR: null, realizedR: null }]).samples,
    0,
  );
});
test("offline worker evaluates policy without blocking the runtime event loop", async () => {
  const rows = Array.from({ length: 600 }, (_, i) => row(i));
  const result = await l.trainCandidateAsync(rows, l.DEFAULT_CHAMPION);
  assert.equal(
    result.status,
    l.trainCandidate(rows, l.DEFAULT_CHAMPION).status,
  );
});
test("shadow cannot promote before 14 complete days plus 24-bar outcome maturity", async () => {
  const { memoryDb } = require("./test-fixtures.cjs");
  const db = memoryDb(),
    start = 1700000000000;
  let now = start + 14 * l.DAY_MS;
  const service = l.createOfflineLearning(db, { now: () => now });
  await service.initialize();
  await db.collection("nine_ai_policy_candidates").insertOne({
    _id: "shadow",
    status: "SHADOW_PENDING",
    params: { ...l.DEFAULT_CHAMPION, minEdge: 0.025 },
    championParams: { ...l.DEFAULT_CHAMPION },
    shadowStartedAt: start,
    createdAt: new Date(start),
  });
  for (let i = 0; i < 84; i++) {
    const r = row(i);
    r.signalTime = start + i * l.BAR_MS;
    r.decisionSnapshot.edges.LONG = {
      ...r.decisionSnapshot.edges.LONG,
      p: 0.6,
      expectedR: 0.4,
      cost: 0.1,
      baseUncertainty: 0.1,
    };
    await db.collection("nine_ai_decision_journal").insertOne(r);
  }
  assert.equal(
    (await service.runDailyCycle()).shadowResult.status,
    "SHADOW_CONTINUES",
  );
  now = start + 18 * l.DAY_MS;
  assert.equal(
    (await service.runDailyCycle()).shadowResult.status,
    "PROMOTED_CHAMPION",
  );
  assert.equal((await service.getChampionConfig()).minEdge, 0.025);
});
test("accounting retries use the stable trade key even when Mongo IDs appear after restart", async () => {
  const { memoryDb } = require("./test-fixtures.cjs"),
    db = memoryDb(),
    service = l.createOfflineLearning(db);
  const trade = {
    signalKey: "TEST:1",
    tradeId: "TEST:1",
    symbol: "TEST",
    side: "LONG",
    createdAt: 1,
    actualQuantity: 2,
    initialRisk: 1,
  };
  const closed = { accountingComplete: true, pnl: 2, grossRealizedPnl: 2 };
  await service.recordClosedTrade(trade, closed);
  await service.recordClosedTrade(
    { ...trade, _id: "mongo-generated-id" },
    closed,
  );
  assert.equal(db.collection("nine_ai_actual_outcomes").rows.length, 1);
  assert.equal(
    db.collection("nine_ai_actual_outcomes").rows[0].tradeId,
    "TEST:1",
  );
});
