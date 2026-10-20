"use strict";
const assert = require("node:assert/strict");
const journal = require("./nine-ai-decision-journal");

assert.equal(journal.MARKET_WINDOW_BARS, 48, "the journal must retain 12 hours of 15-minute candles");

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
    rankMetrics: { features: { close: candles[2].close, atr14: 1, marketRegime: "TREND_UP" },
      dataDerivedConsensus: { ready: true, policyId: "data-consensus:TREND_UP", reason: "VALIDATED_DATA_DERIVED_POLICY_WAIT" } },
    roles: [{ name: "Technical Analyst AI", side: "LONG", confidence: 72, weight: 0.15, reason: "trend aligns" }]
  },
  marketWindow: raw
});
assert.equal(wait.side, "WAIT");
assert.equal(wait.reason, "NO_CONSENSUS");
assert.equal(wait.actualTrade, false);
assert.equal(wait.featureSchemaVersion, 1);
assert.equal(wait.marketDataSchemaVersion, 2);
assert.equal(wait.dataDerivedPolicyEvidence.policyId, "data-consensus:TREND_UP",
  "journal must retain which learned policy authorized or rejected the decision");
assert.equal(wait.marketWindow.length, 3);
assert.equal(wait.marketWindow.at(-1).closeTime, candles[2].closeTime);
assert.deepEqual(wait.marketWindow[0], {
  time: candles[0].time, closeTime: candles[0].closeTime,
  open: candles[0].open, high: candles[0].high, low: candles[0].low,
  close: candles[0].close, volume: 100,
  quoteVolume: null, tradeCount: null, takerBuyBaseVolume: null, takerBuyQuoteVolume: null
});
const extendedRaw = Array.from({ length: journal.MARKET_WINDOW_BARS + 5 }, (_, i) => {
  const time = base + i * 900_000;
  return [time, 100, 102, 99, 101, 200, time + 899_999, 20_000, 42, 90, 9_000];
});
const boundedWindow = journal.snapshotMarketWindow(extendedRaw);
assert.equal(boundedWindow.length, journal.MARKET_WINDOW_BARS);
assert.equal(boundedWindow[0].volume, 200);
assert.equal(boundedWindow[0].quoteVolume, 20_000);
assert.equal(boundedWindow[0].tradeCount, 42);
assert.equal(boundedWindow[0].takerBuyBaseVolume, 90);
assert.equal(boundedWindow[0].takerBuyQuoteVolume, 9_000);
assert.equal(Object.keys(journal.extractWindowFeatures(extendedRaw)).length, 17);
assert.equal(wait.roles[0].reason, "trend aligns");
assert.ok(wait.decisionKey.includes("TESTUSDT"));
const repeatedWait = journal.snapshotDecision({
  symbol: "TESTUSDT",
  signalTime: candles[2].closeTime,
  scannedAt: candles[2].closeTime + 60_000,
  decision: { side: null, action: "WAIT", reason: "DIFFERENT_WAIT_REASON", authorizedForExecution: false },
  marketWindow: raw
});
assert.equal(repeatedWait.decisionKey, wait.decisionKey,
  "WAIT decisions for one symbol/candle must collapse to a single durable journal row");

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

const patternWindow = Array.from({ length: journal.MARKET_WINDOW_BARS }, (_, i) => {
  const time = base + i * 900_000;
  const open = 100 + i * 0.02;
  const close = open + 0.01;
  return [time, open, close + 0.02, open - 0.01, close, 100 + i, time + 899_999,
    10_000 + i, 20 + i, 50 + i, 5_000 + i];
});
const patternFeatures = journal.extractWindowFeatures(patternWindow);
const oppositeFeatures = {
  ...patternFeatures,
  return4: -patternFeatures.return4, return16: -patternFeatures.return16,
  return32: -patternFeatures.return32, return48: -patternFeatures.return48,
  efficiency16: -patternFeatures.efficiency16, efficiency32: -patternFeatures.efficiency32,
  efficiency48: -patternFeatures.efficiency48, rangePosition: 1 - patternFeatures.rangePosition,
  wickBias: -patternFeatures.wickBias, greenRate: 1 - patternFeatures.greenRate
};
const similarWindowRecords = Array.from({ length: 48 }, (_, i) => {
  const positive = i < 24;
  return {
    symbol: `SIM${i}`, signalTime: base + i * 900_000,
    outcomeStatus: "EVALUATED", marketWindow: patternWindow,
    windowFeatures: positive ? patternFeatures : oppositeFeatures,
    evaluations: positive
      ? { "4": { longNetR: 0.5, shortNetR: -0.5 }, "16": { longNetR: 0.3, shortNetR: -0.3 } }
      : { "4": { longNetR: -0.5, shortNetR: 0.5 }, "16": { longNetR: -0.3, shortNetR: 0.3 } }
  };
});
const learnedWinWindow = journal.assessWindowEvidence(patternWindow, "LONG", similarWindowRecords);
assert.equal(learnedWinWindow.ready, true);
assert.ok(learnedWinWindow.adjustment > 0);
assert.ok(learnedWinWindow.effectiveSamples >= journal.MIN_SAMPLES);
const similarLossRecords = similarWindowRecords.map(row => {
  const nearPattern = Number(row.symbol.slice(3)) < 24;
  return { ...row, evaluations: nearPattern
    ? { "4": { longNetR: -0.5, shortNetR: 0.5 }, "16": { longNetR: -0.3, shortNetR: 0.3 } }
    : { "4": { longNetR: 0.5, shortNetR: -0.5 }, "16": { longNetR: 0.3, shortNetR: -0.3 } }
  };
});
const learnedLossWindow = journal.assessWindowEvidence(patternWindow, "LONG", similarLossRecords);
assert.equal(learnedLossWindow.ready, true);
assert.ok(learnedLossWindow.adjustment < 0);

(async () => {
  let attempts = 0;
  const inserted = [];
  const cursor = {
    sort() { return this; }, hint() { return this; }, limit() { return this; },
    async toArray() { return []; }
  };
  const collection = {
    async createIndex() {},
    find() { return cursor; },
    async insertOne(document) {
      attempts++;
      if (attempts < 3) {
        const error = new Error("Socket secureConnect timed out after 10001ms");
        error.name = "MongoNetworkTimeoutError";
        throw error;
      }
      inserted.push(document);
      return { insertedId: "journal-test-id" };
    }
  };
  await journal.initialize({ collection: () => collection });
  const args = {
    symbol: "RETRYTESTUSDT", signalTime: base, scannedAt: base,
    decision: { side: "WAIT", action: "WAIT", reason: "TEST", authorizedForExecution: false,
      rankMetrics: { features: { close: 100, atr14: 1 } }, roles: [] },
    marketWindow: raw
  };
  const result = await journal.recordDecision(args);
  assert.equal(result.recorded, true);
  assert.equal(attempts, 3, "transient network failures should be retried with a fresh insert attempt");
  assert.equal(inserted.length, 1);
  const duplicate = await journal.recordDecision(args);
  assert.equal(duplicate.reason, "DUPLICATE_DECISION");
  assert.equal(attempts, 3, "duplicate decisions must not trigger another database write");
})().catch(error => { console.error(error); process.exitCode = 1; });

console.log("nine-ai-decision-journal.test.js: OK");
