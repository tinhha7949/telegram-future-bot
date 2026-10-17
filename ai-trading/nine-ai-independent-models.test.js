"use strict";
const assert = require("node:assert/strict");
const ml = require("./nine-ai-independent-models");

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === "object" && "$ne" in value) return doc[key] !== value.$ne;
    return doc[key] === value;
  });
}

function collection() {
  const docs = new Map();
  let nextId = 1;
  return {
    async createIndex() {},
    async findOne(query) { return [...docs.values()].find(doc => matches(doc, query)) || null; },
    async updateOne(query, update, options = {}) {
      const existing = [...docs.values()].find(doc => matches(doc, query));
      if (!existing && !options.upsert) return { matchedCount: 0 };
      const id = existing?._id ?? query._id ?? nextId++;
      const next = { ...(existing || {}), ...(update.$set || {}) };
      for (const key of Object.keys(update.$unset || {})) delete next[key];
      if (!existing) Object.assign(next, update.$setOnInsert || {});
      next._id = id;
      docs.set(String(id), next);
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
    },
    async insertOne(doc) {
      if ([...docs.values()].some(item => item.tradeId && item.tradeId === doc.tradeId)) {
        const error = new Error("duplicate key"); error.code = 11000; throw error;
      }
      const saved = { ...doc, _id: nextId++ };
      docs.set(String(saved._id), saved);
      return { insertedId: saved._id };
    },
    find(query = {}) {
      let rows = [...docs.values()].filter(doc => matches(doc, query));
      return {
        sort(spec) {
          const [key, direction] = Object.entries(spec)[0] || ["_id", 1];
          rows = rows.sort((a, b) => (new Date(a[key] || 0) - new Date(b[key] || 0)) * direction);
          return this;
        },
        limit(n) { rows = rows.slice(0, n); return this; },
        async toArray() { return rows; }
      };
    },
    docs
  };
}

(async () => {
  const collections = new Map();
  const db = { collection(name) {
    if (!collections.has(name)) collections.set(name, collection());
    return collections.get(name);
  } };
  const legacy = db.collection("nine_ai_learning_outcomes");
  await legacy.insertOne({
    tradeId: "legacy-0", features: { trend: 1, momentum: 0.8, rsi: 62, volume: 1.4, extension: 0.3 },
    side: "LONG", realizedR: 1.2, closed: true, closedAt: new Date("2026-01-01T00:00:00Z"), applied: true
  });
  const init = await ml.initialize(db, legacy);
  assert.equal(ml.MODEL_CONFIGS.length, 9);
  assert.equal(new Set(ml.MODEL_CONFIGS.map(x => x.id)).size, 9);
  assert.equal(init.migratedLegacyTrades, 1);
  assert.equal(ml.status().length, 9);
  assert.ok(ml.MODEL_CONFIGS.every(config => collections.has(`nine_ai_ml_${config.id}_state`)));
  assert.ok(ml.MODEL_CONFIGS.every(config => collections.has(`nine_ai_ml_${config.id}_outcomes`)));
  assert.ok(ml.status().every(model => model.samples === 1));
  assert.ok(ml.status().every(model => model.evaluation.evaluated === 1));

  const features = {
    trend: 1, momentum: 1.1, rsi: 65, volume: 1.5, extension: 0.2,
    candleBody: 0.6, wickImbalance: -0.2, breakoutStrength: 0.7,
    regime: 1, volatilityRegime: 0, structurePosition: 0.8,
    roomToResistance: 1.2, roomToSupport: 2.1,
    falseBreakoutRisk: 0, directionalStreak: 0.67,
    longEntryQuality: 81, shortEntryQuality: 32
  };
  assert.equal(ml.vector(features, ml.MODEL_CONFIGS[0]).length, 18);
  assert.equal(ml.fresh(ml.MODEL_CONFIGS[0]).version, 3);
  assert.equal(Object.hasOwn(ml.fresh(ml.MODEL_CONFIGS[0]), "recent"), false);
  assert.equal(ml.fresh(ml.MODEL_CONFIGS[0]).weights.length, 18);
  for (let i = 0; i < 25; i++) {
    await ml.learnClosedTrade({
      tradeId: `closed-${i}`, features,
      context: { marketRegime: "TREND_UP", entryQuality: 81 },
      side: "LONG", realizedR: i % 4 === 0 ? -1 : 1.1, closed: true
    });
  }
  const models = ml.predictAll(features);
  assert.equal(models.length, 9);
  assert.ok(models.every(model => model.samples === 26));
  assert.ok(models.every(model => model.trained));
  assert.ok(models.every(model => model.evaluation.brierScore !== null));
  assert.ok(models.find(model => model.modelId === "risk").pLoss >= 0 &&
    models.find(model => model.modelId === "risk").pLoss <= 1);
  for (const config of ml.MODEL_CONFIGS) {
    const saved = [...collections.get(`nine_ai_ml_${config.id}_outcomes`).docs.values()]
      .find(item => item.tradeId === "closed-24");
    assert.equal(saved.context.marketRegime, "TREND_UP");
    assert.equal(saved.context.entryQuality, 81);
  }

  const duplicate = await ml.learnClosedTrade({
    tradeId: "closed-24", features, side: "LONG", realizedR: 1, closed: true
  });
  assert.equal(duplicate.updated, false);
  assert.ok(ml.status().every(model => model.samples === 26));

  await assert.rejects(() => ml.learnClosedTrade({
    tradeId: "open-position", features, side: "LONG", realizedR: 1, closed: false
  }), /CLOSED_TRADE_LABEL_REQUIRED/);

  const before = ml.status();
  const separateCollections = ml.MODEL_CONFIGS.map(config => collections.get(`nine_ai_ml_${config.id}_state`));
  assert.equal(new Set(separateCollections).size, 9);
  assert.ok(before.every(model => model.samples === 26));

  // Migrate persisted six-feature states while preserving learned history.
  const migrationCollections = new Map();
  const migrationDb = { collection(name) {
    if (!migrationCollections.has(name)) migrationCollections.set(name, collection());
    return migrationCollections.get(name);
  } };
  for (const config of ml.MODEL_CONFIGS) {
    migrationDb.collection(`nine_ai_ml_${config.id}_state`).docs.set("model", {
      _id: "model", modelId: config.id, version: 1, samples: 4,
      weights: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], recent: [],
      evaluation: { evaluated: 4, correct: 3, brierSum: 1.2 }, updatedAt: null
    });
  }
  await ml.initialize(migrationDb);
  assert.ok(ml.status().every(model => model.samples === 4));
  for (const config of ml.MODEL_CONFIGS) {
    const saved = migrationCollections.get(`nine_ai_ml_${config.id}_state`).docs.get("model");
    assert.equal(saved.version, 3);
    assert.equal(Object.hasOwn(saved, "recent"), false, "persisted model state must not embed outcome history");
    assert.equal(saved.weights.length, 18);
    assert.deepEqual(saved.weights.slice(0, 6), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    assert.ok(saved.weights.slice(6).every(weight => weight === 0));
  }
  console.log("PASS: nine independent contextual models persist context, migrate state, and deduplicate closed outcomes");
})().catch(error => { console.error(error); process.exitCode = 1; });
