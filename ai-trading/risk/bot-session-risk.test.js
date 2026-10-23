"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RiskGuard, RUN_RISK_ID } = require("./day-guard");

// Exercise the Mongo update contract including $setOnInsert and $max.
function riskDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
      const documents = collections.get(name);
      return {
        async findOne({ _id }) { return documents.get(_id) || null; },
        async insertOne(doc) {
          if (documents.has(doc._id)) throw Error("duplicate");
          documents.set(doc._id, { ...doc });
        },
        async updateOne(filter, op, options = {}) {
          const old = documents.get(filter._id);
          if (!old && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };
          if (old && filter.halted !== undefined && filter.halted !== old.halted)
            return { matchedCount: 0, modifiedCount: 0 };
          if (old && filter.usedRisk?.$lte < old.usedRisk)
            return { matchedCount: 0, modifiedCount: 0 };
          const row = old ? { ...old } : { _id: filter._id, ...op.$setOnInsert };
          for (const [k, v] of Object.entries(op.$max || {}))
            row[k] = Math.max(row[k] ?? -Infinity, v);
          for (const [k, v] of Object.entries(op.$inc || {}))
            row[k] = (row[k] || 0) + v;
          Object.assign(row, op.$set || {});
          documents.set(filter._id, row);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  };
}

test("new bot session ignores historical 99.2% drawdown and configured starting equity", async () => {
  const db = riskDb();
  await db.collection("nine_ai_global_risk").insertOne({
    _id: "GLOBAL", peakEquity: 100000, maxDrawdown: 0.992, halted: true,
  });
  const guard = new RiskGuard(db, { now: () => 42 });
  const first = await guard.assess(100);
  assert.equal(first.ok, true);
  assert.equal(first.drawdown, 0);
  assert.equal(first.startEquity, 100);
  assert.equal(first.peakEquity, 100);
  const state = await db.collection("nine_ai_global_risk").findOne({ _id: RUN_RISK_ID });
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.startedAt, 42);
  assert.equal(state.maxDrawdown, 0);
});

test("bot high-water and drawdown latch survive restart, never auto-reset", async () => {
  const db = riskDb();
  const guard = new RiskGuard(db);
  assert.equal((await guard.assess(100)).ok, true);
  assert.equal((await guard.assess(110)).drawdown, 0);
  const restarted = new RiskGuard(db);
  const next = await restarted.assess(104);
  assert.ok(Math.abs(next.drawdown - 6 / 110) < 1e-12);
  assert.equal(next.startEquity, 100);
  assert.equal(next.peakEquity, 110);
  assert.equal((await restarted.assess(92)).reason, "DRAWDOWN_CIRCUIT_LATCHED");
  assert.equal((await new RiskGuard(db).assess(120)).reason, "DRAWDOWN_CIRCUIT_LATCHED");
  assert.ok((await db.collection("nine_ai_global_risk").findOne({ _id: RUN_RISK_ID })).maxDrawdown >= 0.15);
});

test("unknown equity always blocks entries instead of resetting peak", async () => {
  const db = riskDb();
  const guard = new RiskGuard(db);
  assert.equal((await guard.assess(100)).ok, true);
  assert.equal((await guard.assess(NaN)).reason, "EQUITY_UNCERTAIN");
  assert.equal((await guard.assess(0)).reason, "EQUITY_UNCERTAIN");
  assert.equal((await guard.assess(99)).peakEquity, 100);
});
