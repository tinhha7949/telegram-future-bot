"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isNineAiAuthorizedSignal } = require("../index");
const { DECISION_SCHEMA_VERSION } = require("./nine-ai-policy");

function authorizedSignal() {
  return {
    symbol: "TESTUSDT",
    setup: "NINE_AI_4H",
    side: "LONG",
    action: "LONG",
    authorizedForExecution: true,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    centralDecisionEngine: {
      authority: "NINE_AI_ONLY",
      result: "AUTHORIZED",
    },
    edges: {
      LONG: { eligible: true, edge: 0.5 },
      SHORT: { eligible: false, edge: 0.1 },
    },
  };
}

test("only an explicitly authorized AI-9 decision can reach the broker", () => {
  assert.equal(isNineAiAuthorizedSignal(authorizedSignal()), true);
  const mutations = [
    { authorizedForExecution: false },
    { setup: "LEGACY_SETUP" },
    { action: "SHORT" },
    { decisionSchemaVersion: DECISION_SCHEMA_VERSION - 1 },
    { centralDecisionEngine: { authority: "OTHER", result: "AUTHORIZED" } },
    { centralDecisionEngine: { authority: "NINE_AI_ONLY", result: "ABSTAIN" } },
    { edges: { LONG: { eligible: false, edge: 0.5 } } },
    { edges: { LONG: { eligible: true, edge: null } } },
  ];
  for (const mutation of mutations)
    assert.equal(isNineAiAuthorizedSignal({ ...authorizedSignal(), ...mutation }), false);
});
