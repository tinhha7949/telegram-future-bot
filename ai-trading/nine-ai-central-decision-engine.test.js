"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./test-fixtures.cjs");
const { analyzeNineAI } = require("./nine-ai-pipeline");
const { finalizeDecision, MIN_CANDLES } = require("./nine-ai-central-decision-engine");
const { CONFIG } = require("./config");
test("central guard rejects corruption, stale signals and incomplete policies", () => {
  const f = fixture(),
    base = analyzeNineAI(f),
    options = { symbol: f.symbol, scannedAt: f.market.now + 1 };
  assert.equal(MIN_CANDLES, CONFIG.N_CANDLES);
  assert.equal(finalizeDecision(base, options).side, "LONG");
  assert.equal(finalizeDecision({ ...base, candles: MIN_CANDLES - 1 }, options).reason, "INSUFFICIENT_CLOSED_CANDLES");
  assert.equal(finalizeDecision({ ...base, action: "WAIT" }, options).reason, "AI9_ACTION_SIDE_MISMATCH");
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

const { uncertaintyFor } = require("./nine-ai-policy");
test("calibration drift contributes uncertainty without changing champion params",()=>{
  const now=1700000000000;
  assert.equal(uncertaintyFor({regime_conf:0.8},now-1,now-1,now,{uncertaintyPenalty:0.15}),0.15);
  assert.equal(uncertaintyFor({regime_conf:0.4},now-1,now-1,now,{uncertaintyPenalty:0.15}),0.3);
});
