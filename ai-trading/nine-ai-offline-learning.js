"use strict";
const {CONFIG}=require("./config");
const { applyPolicy, DECISION_SCHEMA_VERSION } = require("./nine-ai-policy");
const { CONTRACT } = require("./opportunity-outcome");
const { getTradeActualRisk } = require("./trade-accounting");
const { Worker } = require("node:worker_threads");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const BAR_MS = 4 * 60 * 60 * 1000;
const HORIZON_BARS = CONFIG.TIMEOUT_BARS;
const PURGE_EMBARGO_MS = HORIZON_BARS * BAR_MS;
const SHADOW_MS = CONFIG.SHADOW_DAYS * DAY_MS;
const DEFAULT_CHAMPION = Object.freeze({
  minEdge: CONFIG.MIN_EDGE,
  gapEdge: CONFIG.EDGE_GAP,
  uncertaintyPenalty: 0,
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
  if (row?.decisionSnapshot?.decisionSchemaVersion !== DECISION_SCHEMA_VERSION)
    return "WAIT";
  return applyPolicy(row.decisionSnapshot, params).side;
}

function usableOpportunity(row) {
  if (
    row?.decisionSnapshot?.decisionSchemaVersion !== DECISION_SCHEMA_VERSION ||
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
  if (sorted.length < 3)
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
    !splits.train.length ||
    !splits.validation.length ||
    !splits.test.length
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
  // The hard floor (MIN_EDGE) and directional gap are not trainable.
  // Candidates may only increase the threshold to abstain more often.
  const edgeValues = [...new Set([
    Math.max(CONFIG.MIN_EDGE, champion.minEdge),
    Math.max(CONFIG.MIN_EDGE, champion.minEdge) + CONFIG.WAIT_EDGE_INCREMENT / 2,
    Math.max(CONFIG.MIN_EDGE, champion.minEdge) + CONFIG.WAIT_EDGE_INCREMENT,
  ])].filter(edge => edge <= CONFIG.WAIT_EDGE_MAX);
  for (const minEdge of edgeValues) {
      const params = { ...champion, minEdge, gapEdge: CONFIG.EDGE_GAP,
        uncertaintyPenalty: 0 };
      const train = evaluatePolicy(splits.train, params);
      const validation = evaluatePolicy(splits.validation, params);
      if (
        Number.isFinite(train.averageNetR) &&
        Number.isFinite(validation.averageNetR)
      ) {
        grid.push({
          params,
          train,
          validation,
          objective: train.averageNetR,
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
  const championValidation = evaluatePolicy(splits.validation, champion);
  if (!(selected.validation.averageNetR > championValidation.averageNetR)) {
    return {
      status: "CANDIDATE_DID_NOT_BEAT_CHAMPION_VALIDATION",
      candidate: selected.params,
      candidateTrain: selected.train,
      candidateValidation: selected.validation,
      championValidation,
      sampleCounts: {
        train: splits.train.length,
        validation: splits.validation.length,
        test: splits.test.length,
      },
      purgeEmbargoMs: splits.purgeEmbargoMs,
    };
  }
  const candidateTest = evaluatePolicy(splits.test, selected.params);
  const championTest = evaluatePolicy(splits.test, champion);
  const uplift = candidateTest.averageNetR - championTest.averageNetR;
  if (!Number.isFinite(uplift) || uplift <= 0) {
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
    candidateTrain: selected.train,
    candidateValidation: selected.validation,
    championValidation,
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

function predictedNetR(row) {
  const direct = finite(row?.predictedR);
  if (direct !== null) return direct;
  // Older complete snapshots can be reconstructed without treating the
  // uncertainty-adjusted decision score as an expected trade result.
  const p = finite(row?.predictedProbability),
    expected = finite(row?.predictedExpectedR),
    cost = finite(row?.predictedCostR ?? row?.edges?.[row?.side]?.cost);
  return p !== null && expected !== null && cost !== null
    ? p * expected - cost
    : null;
}

function calibrationSummary(rows) {
  const usable = rows.filter(
    (r) =>
      predictedNetR(r) !== null &&
      r.realizedR != null &&
      Number.isFinite(Number(r.realizedR)),
  );
  if (!usable.length)
    return {
      status: "NO_REALIZED_PREDICTION_PAIRS",
      samples: 0,
      meanPredictedR: null,
      meanRealizedR: null,
      biasR: null,
      maeR: null,
    };
  const predicted = usable.map(predictedNetR);
  const realized = usable.map((r) => Number(r.realizedR));
  const biasR = mean(predicted.map((v, i) => v - realized[i]));
  const maeR = mean(predicted.map((v, i) => Math.abs(v - realized[i])));
  return {
    samples: usable.length,
    meanPredictedR: mean(predicted),
    meanRealizedR: mean(realized),
    biasR,
    maeR,
    status: maeR > 0 ? "RED_FLAG_CALIBRATION_DRIFT" : "CALIBRATION_MATCH",
  };
}

function formatDailyLearningReport(report) {
  const calibration = report.calibration || {},
    samples = calibration.samples || 0;
  return [
    "DAILY CALIBRATION",
    calibration.status || "NO_REALIZED_PREDICTION_PAIRS",
    "samples=" + samples,
    ...(samples > 0 ? [JSON.stringify(calibration)] : []),
    "| CANDIDATE",
    report.candidateResult?.status || "NO_CANDIDATE_RESULT",
    "| SHADOW",
    report.shadowResult?.status || "NO_SHADOW_CANDIDATE",
  ].join(" ");
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
          policySchemaVersion: DECISION_SCHEMA_VERSION,
          version: 1,
          status: "CHAMPION",
          createdAt: new Date(now()),
        },
      },
      { upsert: true },
    );
    const previous = await championState.findOne({ _id: "active" });
    if (previous?.policySchemaVersion !== DECISION_SCHEMA_VERSION) {
      await championState.updateOne(
        { _id: "active" },
        {
          $set: {
            previousChampion: {
              params: previous?.params || {},
              version: previous?.version || null,
              policySchemaVersion: previous?.policySchemaVersion ?? null,
            },
            params: { ...DEFAULT_CHAMPION },
            policySchemaVersion: DECISION_SCHEMA_VERSION,
            version: Number(previous?.version || 1) + 1,
            updatedAt: new Date(now()),
          },
        },
      );
    }
    return { ready: true, champion: await getChampionConfig() };
  }

  async function getChampionConfig() {
    const state = await championState.findOne({ _id: "active" });
    return state?.policySchemaVersion === DECISION_SCHEMA_VERSION
      ? {
          ...DEFAULT_CHAMPION, ...(state.params || {}),
          minEdge: Math.max(CONFIG.MIN_EDGE, Number(state.params?.minEdge) || CONFIG.MIN_EDGE),
          gapEdge: CONFIG.EDGE_GAP, uncertaintyPenalty: 0,
        }
      : { ...DEFAULT_CHAMPION };
  }

  async function getTrackRecord(asOf = now()) {
    if (
      trackRecordCache &&
      asOf >= trackRecordCacheAt &&
      asOf - trackRecordCacheAt < 5 * 60 * 1000
    )
      return trackRecordCache;
    const rows = await actuals
      .find({ closedAt: { $gte: asOf - 180 * DAY_MS, $lte: asOf } })
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
    trackRecordCacheAt = asOf;
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
      predictedR: predictedNetR({ ...pred, side: trade.side }),
      predictedCostR: finite(
        pred.predictedCostR ?? pred.edges?.[trade.side]?.cost,
      ),
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
      .find({ closedAt: { $gte: runAt - CONFIG.DAILY_TRAIN_LOOKBACK_DAYS * DAY_MS, $lte: runAt } })
      .sort({ closedAt: -1 })
      .limit(5000)
      .toArray();
    const calibration = calibrationSummary(
      actualRows.filter((r) => r.accountingSchemaVersion === 2),
    );
    const activeShadow = await candidates.findOne(
      {
        status: "SHADOW_PENDING",
        policySchemaVersion: DECISION_SCHEMA_VERSION,
      },
      { sort: { createdAt: -1 } },
    );
    let shadowResult = { status: "NO_SHADOW_CANDIDATE" };
    if (activeShadow) {
      const shadowStart = Number(
        activeShadow.shadowStartedAt || activeShadow.createdAt || runAt,
      );
      const rows = await journal
        .find(
          {
            signalTime: { $gte: shadowStart, $lt: shadowStart + SHADOW_MS },
            "decisionSnapshot.decisionSchemaVersion": DECISION_SCHEMA_VERSION,
          },
          { projection: OPPORTUNITY_PROJECTION },
        )
        .sort({ signalTime: 1 })
        .toArray();
      const candidateScore = evaluatePolicy(rows, activeShadow.params);
      const championScore = evaluatePolicy(rows, champion);
      const age = runAt - shadowStart;
      const labelsMature =
        rows.length > 0 &&
        rows.every(
          (row) =>
            Number(row.signalTime) + PURGE_EMBARGO_MS <= runAt &&
            row.outcomeStatus === "EVALUATED" &&
            row.evaluations?.["24"]?.contract === CONTRACT,
        );
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
        Number(activeShadow.params?.minEdge) >= CONFIG.MIN_EDGE &&
        Number(activeShadow.params?.gapEdge) === CONFIG.EDGE_GAP &&
        candidateScore.trades > 0 &&
        age >= SHADOW_MS &&
        labelsMature &&
        candidateScore.opportunities > 0 &&
        Number(candidateScore.averageNetR) > Number(championScore.averageNetR)
      ) {
        const currentChampion = await championState.findOne({ _id: "active" });
        await championState.updateOne(
          { _id: "active" },
          {
            $set: {
              params: activeShadow.params,
              policySchemaVersion: DECISION_SCHEMA_VERSION,
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
      } else if (
        !sameChampion ||
        (age >= SHADOW_MS && (labelsMature || !rows.length))
      ) {
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

    let candidateResult = activeShadow
      ? {
          status: "EXISTING_SHADOW_EVALUATED",
          candidateId: String(activeShadow._id),
        }
      : null;
    if (!activeShadow) {
      const rows = await journal
        .find(
          {
            signalTime: { $gte: runAt - 180 * DAY_MS },
            outcomeStatus: "EVALUATED",
            "decisionSnapshot.setup": "NINE_AI_4H",
            "evaluations.24.contract": CONTRACT,
            "decisionSnapshot.decisionSchemaVersion": DECISION_SCHEMA_VERSION,
          },
          { projection: OPPORTUNITY_PROJECTION },
        )
        .sort({ signalTime: -1 })
        .limit(CONFIG.TRAIN_MAX_OPPORTUNITIES)
        .toArray();
      if (rows.length) {
        candidateResult = await trainCandidateAsync(rows, champion);
        if (candidateResult.status === "SHADOW_PENDING") {
          const insert = await candidates.insertOne({
            status: "SHADOW_PENDING",
            policySchemaVersion: DECISION_SCHEMA_VERSION,
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
              candidateTrain: candidateResult.candidateTrain,
              candidateValidation: candidateResult.candidateValidation,
              championValidation: candidateResult.championValidation,
              candidateTest: candidateResult.candidateTest,
              championTest: candidateResult.championTest,
            },
          });
          candidateResult.candidateId = String(insert.insertedId);
          candidateResult.status = "SHADOW_STARTED";
          shadowResult = {
            status: "SHADOW_STARTED",
            candidateId: String(insert.insertedId),
            ageMs: 0,
            rows: 0,
          };
        }
      } else {
        candidateResult = {
          status: "COLLECTING_MATURED_24_BAR_OPPORTUNITIES",
          samples: rows.length,
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
  formatDailyLearningReport,
  predictedNetR,
  createOfflineLearning,
};
