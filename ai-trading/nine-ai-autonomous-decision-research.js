"use strict";

// Autonomous research over decision-time journal rows. It evaluates taken and
// skipped opportunities separately from realized trades, using chronological
// train/test splits and a conservative live overlay. No execution authorization,
// sizing, or SL/TP is changed by this module.
const JOURNAL_COLLECTION = "nine_ai_decision_journal";
const REPORT_COLLECTION = "nine_ai_autonomous_decision_reports";
const POLICY_COLLECTION = "nine_ai_decision_policies";
const MAX_ROWS = 5000;
const MIN_TOTAL = 80;
const MIN_TRAIN = 40;
const MIN_TEST = 20;
const MAX_BONUS = 2;
let journal = null;
let reports = null;
let policies = null;
let running = false;
let activePolicy = null;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = n => Number.isFinite(Number(n));
const round = n => finite(n) ? Number(Number(n).toFixed(4)) : null;

function outcomeValue(row, variant) {
  const value = row?.researchVariants?.[variant]?.netR;
  return finite(value) ? Number(value) : null;
}
function maxDrawdownR(values) {
  let equity = 0, peak = 0, maxDD = 0;
  for (const raw of values) {
    equity += Number(raw);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return maxDD;
}
function metrics(rows, variant) {
  const ordered = [...rows].sort((a,b) => new Date(a.scannedAt || a.signalTime) - new Date(b.scannedAt || b.signalTime));
  const values = ordered.map(r => outcomeValue(r, variant)).filter(v => v !== null);
  if (!values.length) return { n: 0, expectancyR: null, winRate: null, totalR: 0, maxDrawdownR: 0, standardError: null, lowerBoundR: null };
  const mean = values.reduce((s,v) => s + v, 0) / values.length;
  const variance = values.reduce((s,v) => s + (v-mean)**2, 0) / values.length;
  const se = Math.sqrt(variance / values.length);
  return {
    n: values.length,
    expectancyR: round(mean),
    winRate: round(values.filter(v => v > 0).length / values.length),
    totalR: round(values.reduce((s,v) => s+v, 0)),
    maxDrawdownR: round(maxDrawdownR(values)),
    standardError: round(se),
    lowerBoundR: round(mean - 1.96 * se)
  };
}
function evaluateGroup(rows) {
  const sorted = [...rows].sort((a,b) => Number(a.signalTime) - Number(b.signalTime));
  const split = Math.floor(sorted.length * 0.7);
  const train = sorted.slice(0, split);
  const test = sorted.slice(split);
  const variants = ["now_4", "wait1_4", "wait2_4"];
  const result = {};
  for (const variant of variants) {
    result[variant] = { train: metrics(train, variant), test: metrics(test, variant) };
  }
  const baseline = result.now_4.test;
  const candidates = variants.map(variant => {
    const trainMetrics = result[variant].train;
    const testMetrics = result[variant].test;
    const uplift = baseline.expectancyR == null || testMetrics.expectancyR == null ? null : testMetrics.expectancyR - baseline.expectancyR;
    const enough = trainMetrics.n >= MIN_TRAIN && testMetrics.n >= MIN_TEST;
    const baselineUpper = baseline.expectancyR == null ? -Infinity : baseline.expectancyR + (baseline.standardError || 0) * 1.96;
    const candidateLower = testMetrics.lowerBoundR ?? -Infinity;
    const validated = enough && candidateLower > 0 &&
      (variant === "now_4" || (uplift !== null && uplift > 0 &&
        candidateLower > baselineUpper));
    return { variant, train: trainMetrics, test: testMetrics, upliftVsImmediateR: round(uplift), validated };
  });
  return { split: "chronological_70_30", total: sorted.length, variants: result,
    candidates: candidates.sort((a,b) => Number(b.validated)-Number(a.validated) ||
      Number(b.test.expectancyR ?? -Infinity)-Number(a.test.expectancyR ?? -Infinity)) };
}

async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_AUTONOMOUS_DECISION_RESEARCH_MONGODB_REQUIRED");
  journal = db.collection(JOURNAL_COLLECTION);
  reports = db.collection(REPORT_COLLECTION);
  policies = db.collection(POLICY_COLLECTION);
  await reports.createIndex({ createdAt: -1 }, { name: "nine_ai_decision_report_time" });
  await policies.createIndex({ status: 1, updatedAt: -1 }, { name: "nine_ai_decision_policy_active" });
  activePolicy = await policies.findOne({ status: "ACTIVE" }, { sort: { updatedAt: -1 } });
  return { ready: true, activePolicy: activePolicy?.policyId || null };
}

async function runResearchCycle({ now = new Date() } = {}) {
  if (!journal || !reports || !policies) throw new Error("NINE_AI_AUTONOMOUS_DECISION_RESEARCH_NOT_INITIALIZED");
  if (running) return { status: "SKIPPED", reason: "CYCLE_ALREADY_RUNNING" };
  running = true;
  try {
    const rows = await journal.find({ outcomeStatus: "EVALUATED" })
      .sort({ signalTime: 1 }).limit(MAX_ROWS).toArray();
    const usable = rows.filter(row => ["LONG","SHORT","WAIT"].includes(row.side) &&
      row.researchVariants && row.marketRegime);
    const groups = new Map();
    for (const row of usable) {
      for (const side of ["LONG","SHORT"]) {
        const key = side + "|" + String(row.marketRegime || "UNKNOWN");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...row, researchSide: side });
      }
    }
    const results = [];
    const newlyValidated = [];
    for (const [key, group] of groups) {
      const side = key.split("|")[0];
      const regime = key.slice(side.length + 1);
      // Each row contains both sides' counterfactual outcomes. Select that side
      // explicitly before computing chronological train/test metrics.
      const sideRows = group.map(row => {
        const variants = {};
        for (const name of ["now_4","now_16","wait1_4","wait1_16","wait2_4","wait2_16"]) {
          const source = row.researchVariants[name];
          if (source) variants[name] = { ...source, netR: source[side.toLowerCase() + "NetR"] };
        }
        return { ...row, researchVariants: variants };
      });
      if (sideRows.length < MIN_TOTAL) continue;
      const evaluated = evaluateGroup(sideRows);
      const immediate = evaluated.candidates.find(c => c.variant === "now_4");
      // Only immediate-entry evidence can be promoted by this overlay. If waiting
      // looks better, retain it as a research finding instead of pretending the
      // live bot already implements delayed-entry execution.
      if (immediate?.validated) {
        newlyValidated.push({
          policyId: "decision-edge:" + side + ":" + regime,
          side, regime, status: "ACTIVE",
          mode: "OUT_OF_SAMPLE_POSITIVE_IMMEDIATE_ENTRY_EDGE",
          sampleCount: sideRows.length,
          trainExpectancyR: immediate.train.expectancyR,
          testExpectancyR: immediate.test.expectancyR,
          testLowerBoundR: immediate.test.lowerBoundR,
          testWinRate: immediate.test.winRate,
          testMaxDrawdownR: immediate.test.maxDrawdownR,
          validatedAt: new Date(now), updatedAt: new Date(now)
        });
      }
      results.push({ side, regime, ...evaluated });
    }

    const validKeys = new Set(newlyValidated.map(p => p.policyId));
    const existing = await policies.find({ status: "ACTIVE" }).toArray();
    for (const policy of existing) {
      if (!validKeys.has(policy.policyId)) {
        await policies.updateOne({ _id: policy._id }, { $set: {
          status: "SHADOWED_OR_EXPIRED", deactivatedAt: new Date(now),
          deactivationReason: "NO_LONGER_PASSES_CURRENT_OUT_OF_SAMPLE_VALIDATION"
        }});
      }
    }
    for (const policy of newlyValidated) {
      await policies.updateOne({ policyId: policy.policyId }, { $set: policy }, { upsert: true });
    }
    activePolicy = newlyValidated.sort((a,b) => (b.testLowerBoundR || 0) - (a.testLowerBoundR || 0))[0] || null;
    const report = {
      createdAt: new Date(now), status: usable.length < MIN_TOTAL ? "COLLECTING_DECISIONS" : "COMPLETED",
      rowsRead: rows.length, usableRows: usable.length, groupCount: results.length,
      minimumGroupSamples: MIN_TOTAL, minimumTrainSamples: MIN_TRAIN, minimumTestSamples: MIN_TEST,
      results, activatedPolicies: newlyValidated.length,
      dataSemantics: "HYPOTHETICAL_FORWARD_CLOSES_NOT_EXECUTED_PNL",
      safety: "No hard veto, no WAIT-on-loss rule, no sizing or SL/TP changes."
    };
    await reports.insertOne(report);
    return { status: report.status, usableRows: usable.length, groups: results.length,
      activatedPolicies: newlyValidated.length, activePolicy: activePolicy?.policyId || null };
  } finally {
    running = false;
  }
}

function assessLive(features = {}, side) {
  const wantedSide = String(side || "").toUpperCase();
  if (!activePolicy || activePolicy.status !== "ACTIVE" || activePolicy.side !== wantedSide) {
    return { bonus: 0, reason: "NO_VALIDATED_SIDE_REGIME_POLICY" };
  }
  const regime = String(features.marketRegime || features.regime || "UNKNOWN").toUpperCase();
  if (regime !== activePolicy.regime && activePolicy.regime !== "UNKNOWN") {
    return { bonus: 0, reason: "REGIME_MISMATCH", policyId: activePolicy.policyId };
  }
  const evidence = Number(activePolicy.testLowerBoundR);
  if (!(evidence > 0) || Number(activePolicy.sampleCount) < MIN_TOTAL) {
    return { bonus: 0, reason: "POLICY_EVIDENCE_NOT_POSITIVE" };
  }
  const bonus = Number(clamp(evidence * 1.5, 0, MAX_BONUS).toFixed(3));
  return { bonus, reason: "VALIDATED_POSITIVE_OUT_OF_SAMPLE_EDGE", policyId: activePolicy.policyId,
    side: wantedSide, regime, samples: activePolicy.sampleCount,
    testExpectancyR: activePolicy.testExpectancyR, testLowerBoundR: activePolicy.testLowerBoundR };
}
function status() {
  return { initialized: Boolean(journal), activePolicy: activePolicy?.policyId || null,
    activePolicyDetails: activePolicy ? { side: activePolicy.side, regime: activePolicy.regime,
      sampleCount: activePolicy.sampleCount, testExpectancyR: activePolicy.testExpectancyR,
      testLowerBoundR: activePolicy.testLowerBoundR } : null };
}
module.exports = { JOURNAL_COLLECTION, REPORT_COLLECTION, POLICY_COLLECTION, MIN_TOTAL, MIN_TRAIN, MIN_TEST,
  metrics, maxDrawdownR, evaluateGroup, initialize, runResearchCycle, assessLive, status };
