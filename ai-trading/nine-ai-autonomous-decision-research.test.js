"use strict";
const assert = require("node:assert/strict");
const research = require("./nine-ai-autonomous-decision-research");

assert.equal(research.maxDrawdownR([1, -2, 1]), 2);
const values = Array.from({ length: 100 }, (_, i) => ({
  signalTime: i * 900000,
  side: i % 2 ? "WAIT" : "LONG",
  marketRegime: "TREND_UP",
  researchVariants: {
    now_4: { netR: 0.5 },
    now_16: { netR: 0.4 },
    wait1_4: { netR: 0.1 },
    wait1_16: { netR: 0.1 },
    wait2_4: { netR: -0.1 },
    wait2_16: { netR: -0.1 }
  }
}));
const metrics = research.metrics(values, "now_4");
assert.equal(metrics.n, 100);
assert.equal(metrics.expectancyR, 0.5);
assert.equal(metrics.winRate, 1);
assert.equal(metrics.maxDrawdownR, 0);
const evaluated = research.evaluateGroup(values);
assert.equal(evaluated.split, "chronological_70_30");
assert.equal(evaluated.variants.now_4.train.n, 70);
assert.equal(evaluated.variants.now_4.test.n, 30);
assert.ok(evaluated.candidates.some(candidate => candidate.variant === "now_4" && candidate.validated));
assert.ok(!evaluated.candidates.find(candidate => candidate.variant === "wait2_4").validated);
assert.equal(research.assessLive({ marketRegime: "TREND_UP" }, "LONG").bonus, 0);
(async () => {
  const makeCursor = rows => ({
    sort() { return this; }, hint() { return this; }, limit() { return this; },
    async toArray() { return rows; }
  });
  let journalIndexCreateCalls = 0;
  const journal = {
    listIndexes() { return makeCursor([{ name: "nine_ai_consensus_journal_scan",
      key: { outcomeStatus: 1, signalTime: -1 } }]); },
    async createIndex() { journalIndexCreateCalls++; },
    find() { return makeCursor([]); }
  };
  const reports = { async createIndex() {} };
  const policies = { async createIndex() {}, find() { return makeCursor([]); } };
  const db = { collection(name) {
    if (name === "nine_ai_decision_journal") return journal;
    if (name === "nine_ai_autonomous_decision_reports") return reports;
    if (name === "nine_ai_decision_policies") return policies;
    throw new Error("Unexpected collection: " + name);
  } };
  await research.initialize(db);
  assert.equal(journalIndexCreateCalls, 0,
    "decision research must reuse an equivalent legacy index rather than fail on its name");
})().catch(error => { console.error(error); process.exitCode = 1; });

console.log("nine-ai-autonomous-decision-research.test.js: OK");
