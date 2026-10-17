"use strict";
const assert = require("node:assert/strict");
const learner = require("./nine-ai-learning-memory");

function makeCollection() {
  const docs = new Map();
  let nextId = 1;
  return {
    async createIndex() {},
    async findOne(query) {
      return [...docs.values()].find(doc =>
        Object.entries(query).every(([key, value]) => doc[key] === value)
      ) || null;
    },
    async updateOne(query, update, options = {}) {
      const old = docs.get(String(query._id));
      if (!old && !options.upsert) return { matchedCount: 0 };
      const next = { ...(old || {}), ...(update.$set || {}) };
      if (!old) Object.assign(next, update.$setOnInsert || {});
      docs.set(String(query._id), next);
      return { matchedCount: old ? 1 : 0, upsertedCount: old ? 0 : 1 };
    },
    async insertOne(doc) {
      if ([...docs.values()].some(x => x.tradeId === doc.tradeId)) {
        const error = new Error("duplicate key"); error.code = 11000; throw error;
      }
      const saved = { ...doc, _id: nextId++ };
      docs.set(String(saved._id), saved);
      return { insertedId: saved._id };
    },
    find(query) {
      const rows = [...docs.values()].filter(x => x.applied !== true);
      return { sort() { return this; }, async toArray() { return rows; } };
    },
    docs
  };
}

(async () => {
  const state = makeCollection();
  const outcomes = makeCollection();
  const db = { collection(name) { return name === "nine_ai_learning_state" ? state : outcomes; } };
  const features = { trend: 1, momentum: 1, rsi: 60, volume: 1.2, extension: 0.2 };

  await learner.initialize(db);
  assert.equal(learner.predict(features).trained, false);
  assert.equal(learner.read().version, 2);
  assert.equal(learner.vector(features).length, 18);

  for (let i = 0; i < 25; i++) {
    const result = await learner.learnClosedTrade({
      tradeId: "closed-" + i, features,
      context: { marketRegime: "TREND_UP", entryQuality: 76 },
      side: "LONG", realizedR: i % 3 === 0 ? -1 : 1, closed: true
    });
    assert.equal(result.updated, true);
  }

  assert.equal(learner.predict(features).trained, true);
  assert.equal(learner.read().samples, 25);
  const savedOutcome = [...outcomes.docs.values()].find(item => item.tradeId === "closed-24");
  assert.equal(savedOutcome.context.marketRegime, "TREND_UP");
  assert.equal(savedOutcome.context.entryQuality, 76);
  const duplicate = await learner.learnClosedTrade({
    tradeId: "closed-24", features, side: "LONG", realizedR: 1, closed: true
  });
  assert.equal(duplicate.reason, "DUPLICATE_TRADE");
  await assert.rejects(() => learner.learnClosedTrade({
    tradeId: "open", features, side: "LONG", realizedR: 1, closed: false
  }), /CLOSED_TRADE_LABEL_REQUIRED/);
  assert.equal(learner.read().samples, 25);

  // Upgrade legacy six-feature state without discarding learned weights or samples.
  const legacyState = makeCollection();
  const legacyOutcomes = makeCollection();
  legacyState.docs.set("main", {
    _id: "main", version: 1, samples: 3,
    weights: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    bias: 0.25, recent: [], updatedAt: null
  });
  await learner.initialize({
    collection(name) { return name === "nine_ai_learning_state" ? legacyState : legacyOutcomes; }
  });
  assert.equal(learner.read().version, 2);
  assert.equal(learner.read().samples, 3);
  assert.equal(learner.read().weights.length, 18);
  assert.deepEqual(learner.read().weights.slice(0, 6), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  assert.ok(learner.read().weights.slice(6).every(weight => weight === 0));
  console.log("PASS: contextual learner stores outcomes, upgrades old state, and deduplicates closed trades");
})().catch(error => { console.error(error); process.exitCode = 1; });
