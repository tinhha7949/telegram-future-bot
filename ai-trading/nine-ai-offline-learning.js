"use strict";
const { applyPolicy } = require("./nine-ai-policy");
const { CONTRACT } = require("./opportunity-outcome");
const { getTradeActualRisk } = require("./trade-accounting");
const { Worker } = require("node:worker_threads");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const BAR_MS = 4 * 60 * 60 * 1000;
const HORIZON_BARS = 24;
const PURGE_EMBARGO_MS = HORIZON_BARS * BAR_MS;
const SHADOW_MS = 14 * DAY_MS;
const MIN_TOTAL_ROWS = 400;
const MIN_TEST_ROWS = 20;
const MIN_SHADOW_ROWS = 30;
const DEFAULT_CHAMPION = Object.freeze({
  minEdge: 0.05,
  gapEdge: 0.1,
  uncertaintyPenalty: 0.5,
});

const finite = (v, d = null) =>
  v == null || v === "" ? d : Number.isFinite(Number(v)) ? Number(v) : d;
const mean = (xs) =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const sortTime = (a, b) =>
  Number(a.signalTime || 0) - Number(b.signalTime || 0);
const OPPORTUNITY_PROJECTION = {
  signalTime: 1,
  decisionKey: 1,
  outcomeStatus: 1,
  "decisionSnapshot.decisionSchemaVersion": 1,
  "decisionSnapshot.setup": 1,
  "decisionSnapshot.regime": 1,
  "decisionSnapshot.agents.flow": 1,
  "decisionSnapshot.edges": 1,
  "evaluations.24": 1,
};
function trainCandidateAsync(rows, champion) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, "nine-ai-learning-worker.js"),
      {
        workerData: { rows, champion },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    let received = false;
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("OFFLINE_TRAINING_TIMEOUT"));
    }, 60000);
    worker.once("message", (message) => {
      received = true;
      clearTimeout(timeout);
      message.error
        ? reject(new Error(message.error))
        : resolve(message.result);
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      if (!received) reject(new Error("OFFLINE_WORKER_EXIT_" + code));
    });
  });
}

function policyAction(row, params) {
  if (row?.decisionSnapshot?.decisionSchemaVersion !== 2) return "WAIT";
  return applyPolicy(row.decisionSnapshot, params).side;
}

function usableOpportunity(row) {
  if (
    row?.decisionSnapshot?.decisionSchemaVersion !== 2 ||
    row.outcomeStatus !== "EVALUATED" ||
    row.evaluations?.["24"]?.contract !== CONTRACT
  )
    return false;
  const eligible = ["LONG", "SHORT"].filter(
    (side) => row.decisionSnapshot.edges?.[side]?.eligible === true,
  );
  return (
    eligible.length > 0 && eligible.every((side) => rowNetR(row, side) !== null)
  );
}

function rowNetR(row, side) {
  return finite(row?.evaluations?.["24"]?.[side.toLowerCase() + "NetR"]);
}

function evaluatePolicy(rows, params) {
  const scored = [];
  for (const row of rows) {
    if (!usableOpportunity(row)) continue;
    const action = policyAction(row, params);
    const outcome = action === "WAIT" ? 0 : rowNetR(row, action);
    if (outcome === null) continue;
    scored.push({
      action,
      netR: outcome,
      signalTime: Number(row.signalTime) || 0,
    });
  }
  return {
    opportunities: scored.length,
    trades: scored.filter((x) => x.action !== "WAIT").length,
    averageNetR: mean(scored.map((x) => x.netR)),
    totalNetR: scored.reduce((sum, x) => sum + x.netR, 0),
    actions: scored,
  };
}

function walkForwardSplits(rows, purgeEmbargoMs = PURGE_EMBARGO_MS) {
  const sorted = [...rows].sort(sortTime);
  if (sorted.length < 5)
    return { train: [], validation: [], test: [], purgeEmbargoMs };
  const n = sorted.length;
  const trainEnd = Math.floor(n * 0.6);
  const validationEnd = Math.floor(n * 0.8);
  const trainCut = Number(sorted[Math.max(0, trainEnd - 1)].signalTime) || 0;
  const validationCut =
    Number(sorted[Math.max(trainEnd, validationEnd - 1)]?.signalTime) || 0;
  return {
    train: sorted
      .slice(0, trainEnd)
      .filter((r) => Number(r.signalTime) <= trainCut - purgeEmbargoMs),
    validation: sorted
      .slice(trainEnd, validationEnd)
      .filter(
        (r) =>
          Number(r.signalTime) >= trainCut + purgeEmbargoMs &&
          Number(r.signalTime) <= validationCut - purgeEmbargoMs,
      ),
    test: sorted
      .slice(validationEnd)
      .filter((r) => Number(r.signalTime) >= validationCut + purgeEmbargoMs),
    purgeEmbargoMs,
  };
}

function trainCandidate(rows, champion = DEFAULT_CHAMPION) {
  const splits = walkForwardSplits(rows.filter(usableOpportunity));
  if (
    splits.train.length < 30 ||
    splits.validation.length < 15 ||
    splits.test.length < MIN_TEST_ROWS
  ) {
    return {
      status: "INSUFFICIENT_WALK_FORWARD_SAMPLES",
      sampleCounts: {
        train: splits.train.length,
        validation: splits.validation.length,
        test: splits.test.length,
      },
    };
  }
  const grid = [];
  const edgeValues = [
    ...new Set([
      Math.max(0.01, champion.minEdge - 0.025),
      champion.minEdge,
      champion.minEdge + 0.025,
      champion.minEdge + 0.05,
    ]),
  ];
  const gapValues = [
    ...new Set([
      Math.max(0.025, champion.gapEdge - 0.05),
      champion.gapEdge,
      champion.gapEdge + 0.05,
      champion.gapEdge + 0.1,
    ]),
  ];
  for (const minEdge of edgeValues)
    for (const gapEdge of gapValues) {
      const params = { ...champion, minEdge, gapEdge };
      const train = evaluatePolicy(splits.train, params);
      const validation = evaluatePolicy(splits.validation, params);
      if (
        train.trades >= 10 &&
        validation.trades >= 5 &&
        Number.isFinite(train.averageNetR) &&
        Number.isFinite(validation.averageNetR)
      ) {
        grid.push({
          params,
          train,
          validation,
          objective: validation.averageNetR * 0.7 + train.averageNetR * 0.3,
        });
      }
    }
  grid.sort((a, b) => b.objective - a.objective);
  if (!grid.length)
    return {
      status: "NO_VALID_CANDIDATE",
      sampleCounts: {
        train: splits.train.length,
        validation: splits.validation.length,
        test: splits.test.length,
      },
    };
  const selected = grid[0];
  const candidateTest = evaluatePolicy(splits.test, selected.params);
  const championTest = evaluatePolicy(splits.test, champion);
  const uplift = candidateTest.averageNetR - championTest.averageNetR;
  if (
    candidateTest.trades < MIN_TEST_ROWS ||
    !Number.isFinite(uplift) ||
    uplift <= 0.02
  ) {
    return {
      status: "CANDIDATE_DID_NOT_BEAT_CHAMPION",
      sampleCounts: {
        train: splits.train.length,
        validation: splits.validation.length,
        test: splits.test.length,
      },
      candidate: selected.params,
      candidateTest,
      championTest,
      uplift,
    };
  }
  return {
    status: "SHADOW_PENDING",
    candidate: selected.params,
    candidateTest,
    championTest,
    uplift,
    sampleCounts: {
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length,
    },
    purgeEmbargoMs: splits.purgeEmbargoMs,
  };
}

function calibrationSummary(rows) {
  const usable = rows.filter(
    (r) =>
      r.predictedEdgeR != null &&
      r.realizedR != null &&
      Number.isFinite(Number(r.predictedEdgeR)) &&
      Number.isFinite(Number(r.realizedR)),
  );
  if (!usable.length)
    return {
      samples: 0,
      meanPredictedR: null,
      meanRealizedR: null,
      biasR: null,
      maeR: null,
    };
  const predicted = usable.map((r) => Number(r.predictedEdgeR));
  const realized = usable.map((r) => Number(r.realizedR));
  const biasR = mean(predicted.map((v, i) => v - realized[i]));
  const maeR = mean(predicted.map((v, i) => Math.abs(v - realized[i])));
  return {
    samples: usable.length,
    meanPredictedR: mean(predicted),
    meanRealizedR: mean(realized),
    biasR,
    maeR,
    status:
      usable.length < 30
        ? "COLLECTING"
        : Math.abs(biasR) > 0.25 || maeR > 0.75
          ? "RED_FLAG_CALIBRATION_DRIFT"
          : "CALIBRATION_WITHIN_GUARDRAILS",
  };
}

function createOfflineLearning(db, options = {}) {
  if (!db || typeof db.collection !== "function")
    throw new Error("NINE_AI_OFFLINE_LEARNING_DB_REQUIRED");
  const actuals = db.collection("nine_ai_actual_outcomes");
  const journal = db.collection("nine_ai_decision_journal");
  const reports = db.collection("nine_ai_daily_learning_reports");
  const candidates = db.collection("nine_ai_policy_candidates");
  const championState = db.collection("nine_ai_policy_champion");
  const now = options.now || (() => Date.now());
  let trackRecordCache = null;
  let trackRecordCacheAt = 0;

  async function initialize() {
    await actuals.createIndex(
      { tradeId: 1 },
      { unique: true, name: "uniq_nine_ai_actual_trade" },
    );
    await actuals.createIndex(
      { closedAt: -1 },
      { name: "nine_ai_actual_closed_at" },
    );
    await reports.createIndex(
      { runDate: 1 },
      { unique: true, name: "uniq_nine_ai_daily_report_date" },
    );
    await candidates.createIndex(
      { status: 1, createdAt: -1 },
      { name: "nine_ai_candidate_status" },
    );
    await championState.updateOne(
      { _id: "active" },
      {
        $setOnInsert: {
          params: { ...DEFAULT_CHAMPION },
          version: 1,
          status: "CHAMPION",
          createdAt: new Date(now()),
        },
      },
      { upsert: true },
    );
    return { ready: true, champion: await getChampionConfig() };
  }

  async function getChampionConfig() {
    const state = await championState.findOne({ _id: "active" });
    return { ...DEFAULT_CHAMPION, ...(state?.params || {}) };
  }

  async function getTrackRecord() {
    if (trackRecordCache && now() - trackRecordCacheAt < 5 * 60 * 1000)
      return trackRecordCache;
    const rows = await actuals
      .find({ closedAt: { $gte: now() - 180 * DAY_MS } })
      .sort({ closedAt: -1 })
      .limit(5000)
      .toArray();
    const buckets = {};
    for (const row of rows) {
      const regime = String(
        row.featureSnapshot?.regime?.regime || "",
      ).toUpperCase();
      const side = String(row.side || "").toUpperCase();
      const grossR =
        row.accountingSchemaVersion === 2 ? finite(row.grossR) : null;
      if (
        !["UPTREND", "DOWNTREND"].includes(regime) ||
        !["LONG", "SHORT"].includes(side) ||
        grossR === null
      )
        continue;
      const key = String(row.setupKey || regime) + "_" + side;
      (buckets[key] ||= []).push({ grossR, win: Number(row.netPnl) > 0 });
    }
    trackRecordCache = Object.fromEntries(
      Object.entries(buckets).map(([key, values]) => [
        key,
        {
          samples: values.length,
          meanGrossR: mean(values.map((v) => v.grossR)),
          winningSamples: values.filter((v) => v.win).length,
          meanWinGrossR: mean(values.filter((v) => v.win).map((v) => v.grossR)),
          medianGrossR: values.map((v) => v.grossR).sort((a, b) => a - b)[
            Math.floor(values.length / 2)
          ],
        },
      ]),
    );
    trackRecordCacheAt = now();
    return trackRecordCache;
  }

  async function recordClosedTrade(trade, closed) {
    const riskBudget = getTradeActualRisk(trade);
    const netPnl = finite(closed?.pnl);
    const realizedR =
      riskBudget > 0 && netPnl !== null ? netPnl / riskBudget : null;
    if (
      !trade ||
      !closed ||
      closed.accountingComplete !== true ||
      realizedR === null
    )
      return { recorded: false, reason: "MISSING_REALIZED_R" };
    const tradeId = String(
      trade.signalKey ||
        trade.tradeId ||
        trade._id ||
        trade.symbol + ":" + trade.createdAt,
    );
    const pred = trade.nineAiPredictionSnapshot || {};
    const grossPnl = finite(closed.grossRealizedPnl);
    const row = {
      tradeId,
      symbol: String(trade.symbol || ""),
      side: String(trade.side || ""),
      setup: String(trade.setup || ""),
      setupKey: trade.nineAiSetupKey || null,
      signalAt: Number(trade.signalAt) || null,
      accountingSchemaVersion: 2,
      actualInitialRiskUSDT: riskBudget,
      requestedRiskBudget: finite(trade.risk),
      closedAt: Number(closed.closedAt) || now(),
      predictedEdgeR: finite(pred.predictedEdgeR),
      predictedProbability: finite(pred.predictedProbability),
      predictedExpectedR: finite(pred.predictedExpectedR),
      realizedR,
      netPnl,
      grossPnl,
      grossR:
        riskBudget > 0 && grossPnl !== null ? grossPnl / riskBudget : null,
      fees: finite(closed.feesUSDT),
      funding: finite(closed.fundingUSDT),
      estimatedSlippagePct: finite(trade.nineAiFeatureSnapshot?.estSlippagePct),
      actualEntrySlippage: finite(trade.entryExecution?.entrySlippage),
      actualEntrySlippageUSDT: finite(closed.entrySlippageUSDT),
      actualExitSlippageUSDT: finite(closed.exitSlippageUSDT),
      exitSlippageComplete: closed.exitSlippageComplete === true,
      mae: finite(trade.maxAdverseMove),
      mfe: finite(trade.maxFavorableMove),
      featureSnapshot: trade.nineAiFeatureSnapshot || null,
      edges: pred.edges || null,
      source: "REALIZED_CLOSED_TRADE",
      createdAt: new Date(now()),
    };
    await actuals.updateOne({ tradeId }, { $set: row }, { upsert: true });
    trackRecordCache = null;
    return { recorded: true, tradeId, realizedR };
  }

  async function runDailyCycle() {
    const runAt = now();
    const runDate = new Date(runAt).toISOString().slice(0, 10);
    const champion = await getChampionConfig();
    const actualRows = await actuals
      .find({ closedAt: { $gte: runAt - 180 * DAY_MS } })
      .sort({ closedAt: -1 })
      .limit(5000)
      .toArray();
    const calibration = calibrationSummary(
      actualRows.filter((r) => r.accountingSchemaVersion === 2),
    );
    const activeShadow = await candidates.findOne(
      { status: "SHADOW_PENDING" },
      { sort: { createdAt: -1 } },
    );
    let shadowResult = null;
    if (activeShadow) {
      const shadowStart = Number(
        activeShadow.shadowStartedAt || activeShadow.createdAt || runAt,
      );
      const rows = await journal
        .find(
          {
            signalTime: { $gte: shadowStart, $lt: shadowStart + SHADOW_MS },
            outcomeStatus: "EVALUATED",
            "evaluations.24.contract": CONTRACT,
            "decisionSnapshot.decisionSchemaVersion": 2,
          },
          { projection: OPPORTUNITY_PROJECTION },
        )
        .sort({ signalTime: 1 })
        .limit(20000)
        .toArray();
      const candidateScore = evaluatePolicy(rows, activeShadow.params);
      const championScore = evaluatePolicy(rows, champion);
      const age = runAt - shadowStart;
      shadowResult = {
        ageMs: age,
        rows: candidateScore.opportunities,
        candidateScore,
        championScore,
      };
      const sameChampion = Object.keys(DEFAULT_CHAMPION).every(
        (key) => champion[key] === activeShadow.championParams?.[key],
      );
      if (
        sameChampion &&
        age >= SHADOW_MS + PURGE_EMBARGO_MS &&
        rows.length < 20000 &&
        candidateScore.opportunities >= MIN_SHADOW_ROWS &&
        candidateScore.trades >= MIN_TEST_ROWS &&
        Number(candidateScore.averageNetR) >
          Number(championScore.averageNetR) + 0.02
      ) {
        const currentChampion = await championState.findOne({ _id: "active" });
        await championState.updateOne(
          { _id: "active" },
          {
            $set: {
              params: activeShadow.params,
              version: Number(currentChampion?.version || 1) + 1,
              promotedCandidateId: activeShadow._id,
              promotedAt: new Date(runAt),
              updatedAt: new Date(runAt),
            },
          },
          { upsert: true },
        );
        await candidates.updateOne(
          { _id: activeShadow._id },
          {
            $set: {
              status: "PROMOTED_CHAMPION",
              shadowCompletedAt: new Date(runAt),
              shadowResult,
            },
          },
        );
        shadowResult.status = "PROMOTED_CHAMPION";
      } else if (!sameChampion || age >= 21 * DAY_MS) {
        await candidates.updateOne(
          { _id: activeShadow._id },
          {
            $set: {
              status: "SHADOW_REJECTED",
              shadowCompletedAt: new Date(runAt),
              shadowResult,
            },
          },
        );
        shadowResult.status = "SHADOW_REJECTED";
      } else {
        shadowResult.status = "SHADOW_CONTINUES";
      }
    }

    let candidateResult = null;
    if (!activeShadow) {
      const rows = await journal
        .find(
          {
            signalTime: { $gte: runAt - 180 * DAY_MS },
            outcomeStatus: "EVALUATED",
            "decisionSnapshot.setup": "NINE_AI_4H",
            "evaluations.24.contract": CONTRACT,
            "decisionSnapshot.decisionSchemaVersion": 2,
          },
          { projection: OPPORTUNITY_PROJECTION },
        )
        .sort({ signalTime: -1 })
        .limit(50000)
        .toArray();
      if (rows.length >= MIN_TOTAL_ROWS) {
        candidateResult = await trainCandidateAsync(rows, champion);
        if (candidateResult.status === "SHADOW_PENDING") {
          const insert = await candidates.insertOne({
            status: "SHADOW_PENDING",
            params: candidateResult.candidate,
            championParams: champion,
            createdAt: new Date(runAt),
            shadowStartedAt: runAt,
            walkForward: {
              sampleCounts: candidateResult.sampleCounts,
              purgeEmbargoMs: candidateResult.purgeEmbargoMs,
            },
            trainValidationTest: {
              uplift: candidateResult.uplift,
              candidateTest: candidateResult.candidateTest,
              championTest: candidateResult.championTest,
            },
          });
          candidateResult.candidateId = String(insert.insertedId);
          candidateResult.status = "SHADOW_STARTED";
        }
      } else {
        candidateResult = {
          status: "COLLECTING_MATURED_24_BAR_OPPORTUNITIES",
          samples: rows.length,
          required: MIN_TOTAL_ROWS,
        };
      }
    }

    const report = {
      runDate,
      runAt: new Date(runAt),
      calibration,
      champion,
      candidateResult,
      shadowResult,
      actualTradeSamples: actualRows.length,
      createdAt: new Date(runAt),
    };
    await reports.updateOne({ runDate }, { $set: report }, { upsert: true });
    return report;
  }

  return {
    initialize,
    getChampionConfig,
    getTrackRecord,
    recordClosedTrade,
    runDailyCycle,
    calibrationSummary,
    trainCandidate,
    evaluatePolicy,
    walkForwardSplits,
  };
}

module.exports = {
  DAY_MS,
  BAR_MS,
  HORIZON_BARS,
  PURGE_EMBARGO_MS,
  SHADOW_MS,
  DEFAULT_CHAMPION,
  policyAction,
  rowNetR,
  usableOpportunity,
  evaluatePolicy,
  walkForwardSplits,
  trainCandidate,
  trainCandidateAsync,
  calibrationSummary,
  createOfflineLearning,
};
