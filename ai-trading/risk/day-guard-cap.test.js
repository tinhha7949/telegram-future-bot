"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RiskGuard } = require("./day-guard");
const { CONFIG } = require("../config");
function mockDb() {
  const stores = new Map();
  const collection = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const rows = stores.get(name);
    return {
      rows,
      async findOne({ _id }) { return rows.get(_id) || null; },
      async insertOne(row) {
        if (rows.has(row._id)) throw new Error("duplicate");
        rows.set(row._id, { ...row });
      },
      async deleteOne({ _id }) {
        const deleted = rows.delete(_id);
        return { deletedCount: deleted ? 1 : 0 };
      },
      async countDocuments(query) {
        return [...rows.values()].filter(row => row.day === query.day &&
          ["RESERVED", "RELEASING"].includes(row.status)).length;
      },
      async updateOne(filter, update, opts = {}) {
        let row = rows.get(filter._id);
        if (!row && !opts.upsert) return { matchedCount: 0, modifiedCount: 0 };
        if (row && filter.usedRisk?.$lte != null && row.usedRisk > filter.usedRisk.$lte)
          return { matchedCount: 0, modifiedCount: 0 };
        if (row && filter.usedRisk?.$gte != null && row.usedRisk < filter.usedRisk.$gte)
          return { matchedCount: 0, modifiedCount: 0 };
        if (row && filter.usedTrades?.$lt != null && row.usedTrades >= filter.usedTrades.$lt)
          return { matchedCount: 0, modifiedCount: 0 };
        if (row && filter.usedTrades?.$gte != null && row.usedTrades < filter.usedTrades.$gte)
          return { matchedCount: 0, modifiedCount: 0 };
        const next = row ? { ...row } : { _id: filter._id };
        for (const [key, value] of Object.entries(update.$setOnInsert || {}))
          if (!row) next[key] = value;
        for (const [key, value] of Object.entries(update.$set || {})) next[key] = value;
        for (const [key, value] of Object.entries(update.$inc || {}))
          next[key] = (next[key] || 0) + value;
        for (const [key, value] of Object.entries(update.$max || {}))
          next[key] = Math.max(next[key] ?? -Infinity, value);
        rows.set(filter._id, next);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    };
  };
  return { collection };
}
test("daily risk cap blocks a third mature-phase reservation independently of editable defaults", async () => {
  const db = mockDb();
  // Keep this test focused on daily risk even when CONFIG.yaml changes.
  const config = {
    ...CONFIG,
    MAX_DAILY_RISK: CONFIG.RISK_PER_TRADE * 2.5,
    MAX_TRADES_PER_DAY: Math.max(CONFIG.MAX_TRADES_PER_DAY, 3),
  };
  const guard = new RiskGuard(db, { config, now: () => Date.UTC(2026, 9, 29, 12) });
  assert.equal((await guard.reserve("mature-1", 1000, { labelCount: 150 })).ok, true);
  assert.equal((await guard.reserve("mature-2", 1000, { labelCount: 150 })).ok, true);
  const third = await guard.reserve("mature-3", 1000, { labelCount: 150 });
  assert.equal(third.ok, false);
  assert.equal(third.reason, "MAX_DAILY_RISK_REACHED");
  assert.equal(db.collection("nine_ai_risk_reservations").rows.has("mature-3"), false);
});
test("hard max trades per UTC day blocks entries beyond the configured cap", async () => {
  const db = mockDb();
  const maxTrades = CONFIG.MAX_TRADES_PER_DAY;
  // Ensure daily risk does not become the earlier limit in this test.
  const config = {
    ...CONFIG,
    MAX_DAILY_RISK: CONFIG.EARLY_RISK * (maxTrades + 1) + 1e-9,
  };
  const guard = new RiskGuard(db, { config, now: () => Date.UTC(2026, 9, 29, 12) });
  for (let i = 1; i <= maxTrades; i++) {
    const r = await guard.reserve("trade-" + i, 1000, { labelCount: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const nextTradeKey = "trade-" + (maxTrades + 1);
  const blocked = await guard.reserve(nextTradeKey, 1000, { labelCount: 0 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "MAX_TRADES_PER_DAY_REACHED");
  assert.equal(db.collection("nine_ai_risk_reservations").rows.has(nextTradeKey), false);
});
