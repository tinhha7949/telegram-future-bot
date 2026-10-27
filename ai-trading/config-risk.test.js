"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG, parseConfig } = require("./config");
const { RiskGuard } = require("./risk/day-guard");

test("single validated config with no strategy env overrides", () => {
  assert.equal(CONFIG.RISK_PER_TRADE, 0.1);
  assert.equal(CONFIG.MAX_DAILY_RISK, 0.25);
  assert.deepEqual(CONFIG.TP_BATCHES, [3, 2]);
  assert.equal(CONFIG.AI7_ACTIVATION_SAMPLES, 100);
  assert.equal(CONFIG.HISTORY_FETCH_CANDLES, CONFIG.VOL_90D_RETURNS + 1);
  assert.throws(() => parseConfig("RISK_PER_TRADE: 0.02"), /CONFIG_MISSING/);
  assert.throws(() => parseConfig(require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "CONFIG.yaml"), "utf8"
  ).replace("MAX_DAILY_RISK: 0.25", "MAX_DAILY_RISK: 0.005")),
  /CONFIG_CROSS_FIELD_INVARIANT/);
});
test("risk guard refuses unknown equity, durable drawdown, and duplicate signals", async () => {
  const tables = new Map();
  const db = { collection(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    const store = tables.get(name);
    return {
      async findOne({ _id }) { return store.get(_id) || null; },
      async insertOne(row) {
        if (store.has(row._id)) throw new Error("duplicate");
        store.set(row._id, { ...row });
      },
      async updateOne(filter, op, opts = {}) {
        const row = store.get(filter._id);
        if (!row && !opts.upsert) return { matchedCount: 0, modifiedCount: 0 };
        if (row && filter.usedRisk?.$lte < row.usedRisk)
          return { matchedCount: 0, modifiedCount: 0 };
        const next = row ? { ...row } : { _id: filter._id };
        for (const [key, val] of Object.entries(op.$setOnInsert || {}))
          if (!row) next[key] = val;
        for (const [key, val] of Object.entries(op.$max || {}))
          next[key] = Math.max(next[key] ?? -Infinity, val);
        for (const [key, val] of Object.entries(op.$inc || {}))
          next[key] = (next[key] || 0) + val;
        Object.assign(next, op.$set || {});
        store.set(filter._id, next);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    };
  }};
  const g = new RiskGuard(db, { now: () => Date.UTC(2026, 9, 23) });
  assert.equal((await g.reserve("bad", NaN)).ok, false);
  assert.equal((await g.reserve("a", 1000)).ok, true);
  assert.equal((await g.reserve("a", 1000)).ok, false);
  assert.equal((await g.reserve("b", 1000)).ok, true);
  assert.equal((await g.reserve("c", 1000)).reason, "MAX_DAILY_RISK_REACHED");
  assert.equal((await g.assess(849)).reason, "DRAWDOWN_CIRCUIT_LATCHED");
  assert.equal(g.config.EQUITY_START,1000);
  assert.equal((await new RiskGuard(db).assess(1000)).reason, "DRAWDOWN_CIRCUIT_LATCHED");
});
