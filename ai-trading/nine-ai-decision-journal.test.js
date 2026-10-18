"use strict";
const assert = require("node:assert/strict");
const journal = require("./nine-ai-decision-journal");

const raw = [];
const base = 1_800_000_000_000;
for (let i = 0; i < 24; i++) {
  const close = 100 + i * 0.2;
  raw.push([base + i * 900_000, close - 0.1, close + 0.5, close - 0.5, close, 100, base + (i + 1) * 900_000 - 1]);
}
const candles = journal.normalizeCandles(raw);
assert.equal(candles.length, 24);

const wait = journal.snapshotDecision({
  symbol: "TESTUSDT",
  signalTime: candles[2].closeTime,
  scannedAt: candles[2].closeTime,
  decision: {
    side: null, action: "WAIT", reason: "NO_CONSENSUS", authorizedForExecution: false,
    rankMetrics: { features: { close: candles[2].close, atr14: 1, marketRegime: "TREND_UP" } },
    roles: [{ name: "Technical Analyst AI", side: "LONG", confidence: 72, weight: 0.15, reason: "trend aligns" }]
  }
});
assert.equal(wait.side, "WAIT");
assert.equal(wait.reason, "NO_CONSENSUS");
assert.equal(wait.actualTrade, false);
assert.equal(wait.roles[0].reason, "trend aligns");
assert.ok(wait.decisionKey.includes("TESTUSDT"));

const evaluations = journal.computeEvaluations(wait, candles);
assert.ok(evaluations);
assert.ok(evaluations.evaluations["4"]);
assert.ok(evaluations.evaluations["16"]);
assert.equal(evaluations.evaluations["4"].source, "HYPOTHETICAL_FORWARD_CLOSES_NOT_EXECUTED_PNL");
assert.ok(Number.isFinite(evaluations.evaluations["4"].longNetR));
assert.ok(Number.isFinite(evaluations.evaluations["4"].shortNetR));
assert.ok(evaluations.evaluations["4"].feeR >= 0);
assert.ok(evaluations.researchVariants.now_4);
assert.ok(evaluations.researchVariants.wait1_4);
assert.ok(evaluations.researchVariants.wait2_16);
assert.equal(evaluations.researchVariants.wait1_4.source, "HYPOTHETICAL_ENTRY_TIMING_RESEARCH_NOT_EXECUTED_PNL");

// A losing context must never create a negative bonus or veto the next entry.
assert.equal(journal.positiveEvidenceBonus(-1, 0.1, 100), 0);
assert.equal(journal.positiveEvidenceBonus(0.05, 0.1, 100), 0);
assert.equal(journal.positiveEvidenceBonus(1, 0.1, 10), 0);
assert.ok(journal.positiveEvidenceBonus(0.8, 0.1, 100) > 0);
assert.ok(journal.positiveEvidenceBonus(100, 0, 100) <= 3);
assert.equal(journal.assess({}, "WAIT").bonus, 0);

console.log("nine-ai-decision-journal.test.js: OK");
