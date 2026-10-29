"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./test-fixtures.cjs");
const { analyzeNineAI } = require("./nine-ai-pipeline");
const { finalizeDecision } = require("./nine-ai-central-decision-engine");
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

const { isNineAiAuthorizedSignal } = require("../index");
test("only an explicitly authorized AI-9 decision can reach the broker", () => {
  const base = {
    symbol: "TESTUSDT", setup: "NINE_AI_4H", side: "LONG", action: "LONG",
    authorizedForExecution: true, decisionSchemaVersion: require("./nine-ai-policy").DECISION_SCHEMA_VERSION,
    centralDecisionEngine: { authority: "NINE_AI_ONLY", result: "AUTHORIZED" },
    edges: { LONG: { eligible: true, edge: 0.5 }, SHORT: { eligible: false, edge: 0.1 } },
  };
  assert.equal(isNineAiAuthorizedSignal(base), true);
  for (const patch of [
    { authorizedForExecution: false },
    { setup: "LEGACY_SETUP" },
    { action: "SHORT" },
    { decisionSchemaVersion: 1 },
    { centralDecisionEngine: { authority: "OTHER", result: "AUTHORIZED" } },
    { centralDecisionEngine: { authority: "NINE_AI_ONLY", result: "ABSTAIN" } },
    { edges: { LONG: { eligible: false, edge: 0.5 } } },
    { edges: { LONG: { eligible: true, edge: null } } },
  ]) assert.equal(isNineAiAuthorizedSignal({ ...base, ...patch }), false);
});
const { uncertaintyFor } = require("./nine-ai-policy");
test("calibration drift contributes uncertainty without changing champion params",()=>{
  const now=1700000000000;
  assert.equal(uncertaintyFor({regime_conf:0.8},now-1,now-1,now,{uncertaintyPenalty:0.15}),0.15);
  assert.equal(uncertaintyFor({regime_conf:0.4},now-1,now-1,now,{uncertaintyPenalty:0.15}),0.3);
});
