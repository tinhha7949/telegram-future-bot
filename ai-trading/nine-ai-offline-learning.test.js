"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const l = require("./nine-ai-offline-learning");
const { applyPolicy, DECISION_SCHEMA_VERSION } = require("./nine-ai-policy");
const { CONTRACT } = require("./opportunity-outcome");
const plan = { entry: 100, sl: 99, tp1: 102, tp2: 104 };
const row = (i = 0) => ({
  signalTime: 1700000000000 + i * l.BAR_MS,
  outcomeStatus: "EVALUATED",
  decisionSnapshot: {
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
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
      Array.from({ length: 40 }, () => ({ predictedR: 1, realizedR: -1 })),
    ).status,
    "RED_FLAG_CALIBRATION_DRIFT",
  );
  assert.equal(
    l.calibrationSummary([{ predictedEdgeR: null, realizedR: null }]).samples,
    0,
  );
});

test("empty database has explicit idle learning statuses without blocking initial live decisions", async () => {
  const { memoryDb, fixture } = require("./test-fixtures.cjs"),
    { analyzeNineAI } = require("./nine-ai-pipeline");
  const service = l.createOfflineLearning(memoryDb());
  await service.initialize();
  const report = await service.runDailyCycle();
  assert.equal(report.calibration.status, "NO_REALIZED_PREDICTION_PAIRS");
  assert.equal(report.calibration.samples, 0);
  assert.equal(report.calibration.meanRealizedR, null);
  assert.equal(
    report.candidateResult.status,
    "COLLECTING_MATURED_24_BAR_OPPORTUNITIES",
  );
  assert.equal(report.shadowResult.status, "NO_SHADOW_CANDIDATE");
  const log = l.formatDailyLearningReport(report);
  assert.match(log, /DAILY CALIBRATION NO_REALIZED_PREDICTION_PAIRS samples=0/);
  assert.match(log, /SHADOW NO_SHADOW_CANDIDATE/);
  assert.doesNotMatch(log, /undefined|null/);
  for (const side of ["LONG", "SHORT"]) {
    const decision = analyzeNineAI({
      ...fixture(side),
      outcomes: [],
      config: await service.getChampionConfig(),
    });
    assert.equal(decision.action, side);
    assert.equal(decision.tradePlan.outcomeMode, "AI2_INITIAL");
  }
});

test("a newly qualified candidate reports shadow started on the same daily run", async () => {
  const { memoryDb } = require("./test-fixtures.cjs"),
    db = memoryDb(),
    start = 1700000000000,
    now = start + 100 * l.DAY_MS,
    service = l.createOfflineLearning(db, { now: () => now });
  await service.initialize();
  for (let i = 0; i < 30; i++) {
    const r = row(i);
    r.signalTime = start + i * 3 * l.DAY_MS;
    Object.assign(r.decisionSnapshot.edges.LONG, {
      p: 0.6,
      expectedR: 0.4,
      cost: 0.1,
      baseUncertainty: 0.1,
    });
    r.evaluations[24].longNetR = 0.01;
    await db.collection("nine_ai_decision_journal").insertOne(r);
  }
  const report = await service.runDailyCycle();
  assert.equal(report.candidateResult.status, "SHADOW_STARTED");
  assert.equal(report.shadowResult.status, "SHADOW_STARTED");
  assert.equal(
    report.shadowResult.candidateId,
    report.candidateResult.candidateId,
  );
  assert.doesNotMatch(
    l.formatDailyLearningReport(report),
    /undefined|NO_SHADOW_CANDIDATE/,
  );
  const next = await service.runDailyCycle();
  assert.equal(next.candidateResult.status, "EXISTING_SHADOW_EVALUATED");
  assert.equal(next.shadowResult.status, "SHADOW_CONTINUES");
  assert.doesNotMatch(l.formatDailyLearningReport(next), /undefined/);
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
    policySchemaVersion: DECISION_SCHEMA_VERSION,
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
test("candidate qualification has no 400-row, trade-count or extra .02R-uplift gate", () => {
  const rows = Array.from({ length: 30 }, (_, i) => {
    const r = row(i);
    r.signalTime = 1700000000000 + i * 7 * l.DAY_MS;
    Object.assign(r.decisionSnapshot.edges.LONG, {
      p: 0.6,
      expectedR: 0.4,
      cost: 0.1,
      baseUncertainty: 0.1,
    });
    r.evaluations[24].longNetR = 0.01;
    return r;
  });
  const result = l.trainCandidate(rows, l.DEFAULT_CHAMPION);
  assert.equal(result.status, "SHADOW_PENDING");
  assert.equal(result.uplift, 0.01);
});

test("candidate selection is fit on train and a validation loss cannot be rescued by future test gains", () => {
  const rows = Array.from({ length: 30 }, (_, i) => {
    const r = row(i);
    r.signalTime = 1700000000000 + i * 7 * l.DAY_MS;
    Object.assign(r.decisionSnapshot.edges.LONG, {
      p: 0.6,
      expectedR: 0.4,
      cost: 0.1,
      baseUncertainty: 0.1,
    });
    r.evaluations[24].longNetR = i < 18 || i >= 24 ? 1 : -1;
    return r;
  });
  const result = l.trainCandidate(rows, l.DEFAULT_CHAMPION);
  assert.equal(result.status, "CANDIDATE_DID_NOT_BEAT_CHAMPION_VALIDATION");
  assert.equal(result.candidateTrain.averageNetR, 1);
  assert.equal(result.candidateValidation.averageNetR, -1);
  assert.equal(result.championValidation.averageNetR, 0);
});
test("one realized calibration deviation is reported without a 30-trade prerequisite", () => {
  assert.equal(
    l.calibrationSummary([{ predictedR: 0.5, realizedR: 0.49 }]).status,
    "RED_FLAG_CALIBRATION_DRIFT",
  );
  assert.equal(
    l.calibrationSummary([
      { predictedR: 1, realizedR: 0 },
      { predictedR: 0, realizedR: 1 },
    ]).status,
    "RED_FLAG_CALIBRATION_DRIFT",
  );
});
test("a winning fully matured shadow can promote at 14 days, without a fixed extra timer", async () => {
  const { memoryDb } = require("./test-fixtures.cjs"),
    db = memoryDb(),
    start = 1700000000000;
  let now = start + 14 * l.DAY_MS - 1;
  const service = l.createOfflineLearning(db, { now: () => now });
  await service.initialize();
  await db.collection("nine_ai_policy_candidates").insertOne({
    _id: "small-shadow",
    policySchemaVersion: DECISION_SCHEMA_VERSION,
    status: "SHADOW_PENDING",
    params: { ...l.DEFAULT_CHAMPION, minEdge: 0.025 },
    championParams: { ...l.DEFAULT_CHAMPION },
    shadowStartedAt: start,
  });
  const r = row(0);
  r.signalTime = start;
  Object.assign(r.decisionSnapshot.edges.LONG, {
    p: 0.6,
    expectedR: 0.4,
    cost: 0.1,
    baseUncertainty: 0.1,
  });
  r.evaluations[24].longNetR = 0.01;
  await db.collection("nine_ai_decision_journal").insertOne(r);
  assert.equal(
    (await service.runDailyCycle()).shadowResult.status,
    "SHADOW_CONTINUES",
  );
  now = start + 14 * l.DAY_MS;
  assert.equal(
    (await service.runDailyCycle()).shadowResult.status,
    "PROMOTED_CHAMPION",
  );
});
