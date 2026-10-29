"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./test-fixtures.cjs");
const { analyzeNineAI } = require("./nine-ai-pipeline");
const { finalizeDecision, MIN_CANDLES, REQUIRED_ROLES } = require("./nine-ai-central-decision-engine");
const { CONFIG } = require("./config");
test("central guard rejects corruption, stale signals and incomplete policies", () => {
  const f = fixture(),
    base = analyzeNineAI(f),
    options = { symbol: f.symbol, scannedAt: f.market.now + 1 };
  assert.equal(finalizeDecision(base, options).side, "LONG");
  for (const patch of [
    { symbol: "OTHER" },
    { agents: null },
    { sl: base.entry + 1 },
    { tp1: base.entry },
    { decisionSchemaVersion: 1 },
    { featureSnapshot: { snapshotAt: f.market.now + 2 } },
    { signalAt: f.market.now + 1 },
    { decisionPolicy: null },
    { candles: CONFIG.N_CANDLES - 1 },
    { agents: { ...base.agents, probability: undefined } },
    { agents: { ...base.agents, confidence: { ...base.agents.confidence, confidenceScore: 0 } } },
    { agents: { ...base.agents, execution: { ...base.agents.execution, estimatedSlippagePct: 99 } } },
    { agents: { ...base.agents, slTp: { ...base.agents.slTp, closePercentAtTP1: 50 } } },
    { agents: { ...base.agents, riskGuardian: { ...base.agents.riskGuardian, vetoed: true } } },
    { agents: { ...base.agents, decision: { ...base.agents.decision, side: "SHORT" } } },
    {
      agents: { ...base.agents, flow: { confirmation: "BLOCKED_HOT_FUNDING" } },
    },
    { edges: { ...base.edges, LONG: { ...base.edges.LONG, p: null } } },
  ])
    assert.equal(
      finalizeDecision({ ...base, ...patch }, options).authorizedForExecution,
      false,
      JSON.stringify(patch),
    );
});

const { uncertaintyFor } = require("./nine-ai-policy");
test("calibration drift contributes uncertainty without changing champion params",()=>{
  const now=1700000000000;
  assert.equal(uncertaintyFor({regime_conf:0.8},now-1,now-1,now,{uncertaintyPenalty:0.15}),0.15);
  assert.equal(uncertaintyFor({regime_conf:0.4},now-1,now-1,now,{uncertaintyPenalty:0.15}),0.3);
});


test("central engine exposes the exact nine required responsibilities and configured history floor", () => {
  assert.deepEqual(REQUIRED_ROLES, [
    "AI-1 Regime", "AI-2 Structure", "AI-3 Probability",
    "AI-4 Expected Return", "AI-5 Confidence", "AI-6 Risk Guardian",
    "AI-7 SL/TP Optimizer", "AI-8 Execution", "AI-9 Decision",
  ]);
  assert.equal(MIN_CANDLES, CONFIG.N_CANDLES);
});

test("broker signal gate requires explicit central AI-9 authorization", () => {
  const { isNineAiAuthorizedSignal } = require("../index");
  const f = fixture();
  const raw = analyzeNineAI(f);
  const approved = finalizeDecision(raw, { symbol: f.symbol, scannedAt: f.market.now + 1 });
  assert.equal(isNineAiAuthorizedSignal(approved), true);
  assert.equal(isNineAiAuthorizedSignal({ ...approved, centralDecisionEngine: undefined }), false);
});
