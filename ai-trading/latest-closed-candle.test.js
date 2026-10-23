"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadDecisionInput } = require("../index");
const { BAR_MS, DECISION_SCHEMA_VERSION } = require("./nine-ai-policy");

test("a missing latest closed 4h candle does not silently resurrect the previous candle", async () => {
  const now = 2000 * BAR_MS + 5000;
  const expected = Math.floor(now / BAR_MS) * BAR_MS - 1;
  const previous = expected - BAR_MS;
  const oldRow = [previous - BAR_MS + 1, 100, 101, 99, 100, 10, previous];
  const validRow = [expected - BAR_MS + 1, 100, 101, 99, 100, 10, expected];
  const seen = [];
  const journal = {async getDecisionForCandle(symbol, close, version) {
    seen.push({symbol,close,version});
    return null;
  }};
  const exchange = {offset:0,async candles(){return [oldRow]}};
  assert.equal(await loadDecisionInput(exchange,journal,"TESTUSDT",now),null);
  assert.equal(seen.length,1,"never lookup or authorize an older decision");
  assert.equal(seen[0].close,expected);
  exchange.candles = async () => [oldRow,validRow];
  const data = await loadDecisionInput(exchange,journal,"TESTUSDT",now);
  assert.equal(data?.probe?.closeTime,expected);
  const cached = {decisionKey:"current-only"};
  journal.getDecisionForCandle = async (_symbol,close,version) =>
    close===expected && version===DECISION_SCHEMA_VERSION ? cached : null;
  const result=await loadDecisionInput(exchange,journal,"TESTUSDT",now);
  assert.equal(result.prior,cached);
});
