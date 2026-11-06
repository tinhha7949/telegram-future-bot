"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { attemptRankedCandidates, isFatalCandidateError } = require("./candidate-runner");

test("tries the next eligible coin after the highest score is vetoed", async () => {
  const tried = [];
  const candidates = [
    { symbol: "BTCUSDT", score: 95 },
    { symbol: "ETHUSDT", score: 90 },
    { symbol: "SOLUSDT", score: 85 }
  ];
  const result = await attemptRankedCandidates(candidates, async candidate => {
    tried.push(candidate.symbol);
    if (candidate.symbol === "BTCUSDT") return { opened: false, reason: "FUNDING_TOO_HOT" };
    return { opened: true };
  }, { minScore: 70 });
  assert.deepEqual(tried, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(result.opened, true);
  assert.equal(result.candidate.symbol, "ETHUSDT");
});

test("stops immediately after one successful trade and never opens a second", async () => {
  const tried = [];
  const result = await attemptRankedCandidates([
    { symbol: "A", score: 99 }, { symbol: "B", score: 95 }, { symbol: "C", score: 90 }
  ], async candidate => {
    tried.push(candidate.symbol);
    return { opened: true };
  }, { minScore: 70 });
  assert.deepEqual(tried, ["A"]);
  assert.equal(result.attempted, 1);
  assert.equal(result.opened, true);
});

test("skips candidates whose scan score is below the configured minimum", async () => {
  const tried = [];
  const result = await attemptRankedCandidates([
    { symbol: "A", score: 69 }, { symbol: "B", score: 70 }
  ], async candidate => {
    tried.push(candidate.symbol);
    return { opened: true };
  }, { minScore: 70 });
  assert.deepEqual(tried, ["B"]);
  assert.equal(result.opened, true);
});

test("continues after a candidate-specific execution error", async () => {
  const tried = [];
  const result = await attemptRankedCandidates([
    { symbol: "A", score: 90 }, { symbol: "B", score: 80 }
  ], async candidate => {
    tried.push(candidate.symbol);
    if (candidate.symbol === "A") throw new Error("INVALID_SWING_PIVOT_SIDE");
    return { opened: true };
  }, { minScore: 70 });
  assert.deepEqual(tried, ["A", "B"]);
  assert.equal(result.candidate.symbol, "B");
});

test("does not continue after an uncertain market-order submission", async () => {
  const tried = [];
  const error = new Error("request timed out after order submission");
  error.orderMayBeOpen = true;
  const result = await attemptRankedCandidates([
    { symbol: "A", score: 95 }, { symbol: "B", score: 90 }
  ], async candidate => {
    tried.push(candidate.symbol);
    throw error;
  }, { minScore: 70 });
  assert.deepEqual(tried, ["A"]);
  assert.equal(result.fatal, true);
  assert.equal(isFatalCandidateError(error), true);
});

test("continues after a failed protection attempt only when force-close was verified", async () => {
  const tried = [];
  const error = new Error("PROTECTION_FAILED_FORCE_CLOSE");
  error.orderMayBeOpen = false;
  const result = await attemptRankedCandidates([
    { symbol: "A", score: 95 }, { symbol: "B", score: 90 }
  ], async candidate => {
    tried.push(candidate.symbol);
    if (candidate.symbol === "A") throw error;
    return { opened: true };
  }, { minScore: 70 });
  assert.deepEqual(tried, ["A", "B"]);
  assert.equal(result.opened, true);
});

test("stops candidate retries on Binance rate limits and infrastructure timeouts", async () => {
  for (const message of ["BINANCE_429_RATE_LIMIT_COOLDOWN", "TimeoutError: operation timed out"]) {
    const tried = [];
    const result = await attemptRankedCandidates([
      { symbol: "A", score: 95 }, { symbol: "B", score: 90 }
    ], async candidate => {
      tried.push(candidate.symbol);
      throw new Error(message);
    }, { minScore: 70 });
    assert.deepEqual(tried, ["A"]);
    assert.equal(result.fatal, true);
  }
});
