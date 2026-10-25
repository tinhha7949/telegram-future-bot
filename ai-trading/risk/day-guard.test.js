"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RiskGuard } = require("./day-guard");

function ledger() {
  const reservations = new Map([["signal", {
    _id: "signal", day: "UTC:2026-10-25", risk: 10, status: "RESERVED",
  }]]);
  const days = new Map([["UTC:2026-10-25", { _id: "UTC:2026-10-25", usedRisk: 20 }]]);
  const db = { collection(name) {
    if (name === "nine_ai_risk_reservations") return {
      async findOneAndUpdate(query, update) {
        const row = reservations.get(query._id);
        if (!row || row.status !== query.status) return null;
        reservations.set(query._id, { ...row, ...update.$set });
        return { ...row };
      },
      async updateOne(query, update) {
        const row = reservations.get(query._id);
        if (!row || row.status !== query.status) return { matchedCount: 0, modifiedCount: 0 };
        reservations.set(query._id, { ...row, ...update.$set });
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async deleteOne(query) {
        const row = reservations.get(query._id);
        if (row?.status === query.status) reservations.delete(query._id);
      },
    };
    if (name === "nine_ai_daily_risk") return {
      async updateOne(query, update) {
        const row = days.get(query._id);
        if (!row || row.usedRisk < query.usedRisk.$gte) return { matchedCount: 0, modifiedCount: 0 };
        row.usedRisk += update.$inc.usedRisk;
        return { matchedCount: 1, modifiedCount: 1 };
      },
    };
    return { };
  }};
  return { db, reservations, days };
}

test("release returns an unused reservation to the daily risk bucket", async () => {
  const l = ledger(), guard = new RiskGuard(l.db, { now: () => 1 });
  assert.equal(await guard.release("signal"), true);
  assert.equal(l.days.get("UTC:2026-10-25").usedRisk, 10);
  assert.equal(l.reservations.has("signal"), false);
});

test("release is idempotent and refuses to decrement a missing daily charge", async () => {
  const l = ledger(), guard = new RiskGuard(l.db, { now: () => 1 });
  assert.equal(await guard.release("signal"), true);
  assert.equal(await guard.release("signal"), false);
  assert.equal(l.days.get("UTC:2026-10-25").usedRisk, 10);
});
