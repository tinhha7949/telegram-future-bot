"use strict";
const assert = require("node:assert/strict");
const learner = require("./nine-ai-learning-memory");

function makeCollection() {
  const docs = new Map();
  let nextId = 1;
  return {
    async createIndex() {},
    async findOne(query) { return docs.get(query._id) || null; },
    async updateOne(query, update, options = {}) {
      const old = docs.get(query._id);
      if (!old && !options.upsert) return { matchedCount: 0 };
      const next = { ...(old || {}), ...(update.$set || {}) };
      if (!old) Object.assign(next, update.$setOnInsert || {});
      docs.set(query._id, next);
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

  for (let i = 0; i < 25; i++) {
    const result = await learner.learnClosedTrade({
      tradeId: "closed-" + i, features, side: "LONG",
      realizedR: i % 3 === 0 ? -1 : 1, closed: true
    });
    assert.equal(result.updated, true);
  }

  assert.equal(learner.predict(features).trained, true);
  assert.equal(learner.read().samples, 25);
  const duplicate = await learner.learnClosedTrade({
    tradeId: "closed-24", features, side: "LONG", realizedR: 1, closed: true
  });
  assert.equal(duplicate.reason, "DUPLICATE_TRADE");
  assert.throws(() => learner.learnClosedTrade({
    tradeId: "open", features, side: "LONG", realizedR: 1, closed: false
  }), /CLOSED_TRADE_LABEL_REQUIRED/);
  assert.equal(learner.read().samples, 25);
  console.log("PASS: MongoDB-backed learner trains only once per confirmed closed trade");
})().catch(error => { console.error(error); process.exitCode = 1; });
