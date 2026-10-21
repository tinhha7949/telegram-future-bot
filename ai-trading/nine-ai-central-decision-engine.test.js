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
    { tp1: base.tp2 },
    { decisionSchemaVersion: 1 },
    { featureSnapshot: { snapshotAt: f.market.now - 300001 } },
    { signalAt: f.market.now - 300001 },
    { decisionPolicy: null },
    { agents: { ...base.agents, flow: { confirmation: "NEUTRAL" } } },
    { edges: { ...base.edges, LONG: { ...base.edges.LONG, p: null } } },
  ])
    assert.equal(
      finalizeDecision({ ...base, ...patch }, options).authorizedForExecution,
      false,
      JSON.stringify(patch),
    );
});
