"use strict";
function fixture(side = "LONG", now = Date.now()) {
  const bar = 14400000,
    end = now - 1000;
  const candles4h = Array.from({ length: 700 }, (_, i) => {
    const c =
      100 *
      Math.exp(
        0.0007 * i + ((0.025 * (700 - i)) / 700 + 0.0005) * Math.sin(i * 0.7),
      );
    const time = end - (700 - i) * bar + 1;
    return [time, c - 0.05, c + 0.2, c - 0.2, c, 100, time + bar - 1];
  });
  const prev = candles4h.at(-2),
    last = candles4h.at(-1);
  prev[1] = prev[4] + 0.25;
  prev[2] = prev[1] + 0.1;
  prev[3] = prev[4] - 0.5;
  prev[4] -= 0.3;
  last[4] += 0.4;
  last[1] = last[4] - 0.6;
  last[2] = last[4] + 0.1;
  last[3] = last[1] - 0.1;
  last[5] = 180;
  if (side === "SHORT")
    for (const c of candles4h) {
      const [o, h, l, close] = [c[1], c[2], c[3], c[4]];
      c[1] = 500 - o;
      c[2] = 500 - l;
      c[3] = 500 - h;
      c[4] = 500 - close;
    }
  const regime = side === "LONG" ? "UPTREND" : "DOWNTREND",
    outcomes = [];
  for (const setup of ["CONTINUATION", "BREAKOUT"])
    for (let i = 0; i < 120; i++)
      outcomes.push({
        tradeId: side + setup + i,
        symbol: "TESTUSDT",
        setupKey: regime + "_" + setup,
        side,
        maePct: 0.5 + i * 0.005,
        mfePct: 3 + i * 0.03,
        win: i < 90,
        labeled: true,
        source: "REALIZED_CLOSED_TRADE",
        closedAt: now - 60000,
        accountingSchemaVersion: 2,
        featureSnapshot: { snapshotAt: now - 86400000 },
      });
  return {
    symbol: "TESTUSDT",
    candles4h,
    outcomes,
    market: {
      now,
      snapshotAt: now,
      fundingRate: 0.0001,
      openInterestChange: 1,
      spreadPct: 0.01,
      depthNotional: 1000000,
      latencyMs: 100,
      liquidationImbalance: side === "LONG" ? 0.3 : -0.3,
      roundTripFeePct: 0.02,
      expectedFundingCostPctBySide: { LONG: 0.01, SHORT: 0 },
    },
  };
}
module.exports = { fixture };
function memoryDb() {
  const collections = new Map();
  const matches = (d, q) =>
    Object.entries(q).every(([k, v]) => {
      const value = k.split(".").reduce((o, key) => o?.[key], d);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if ("$in" in v) return v.$in.includes(value);
        if ("$ne" in v) return value !== v.$ne;
        if ("$gte" in v && !(value >= v.$gte)) return false;
        if ("$lte" in v && !(value <= v.$lte)) return false;
        if ("$lt" in v && !(value < v.$lt)) return false;
        if ("$gt" in v && !(value > v.$gt)) return false;
        return true;
      }
      return value === v;
    });
  const db = {
    collection(name) {
      if (!collections.has(name)) {
        const rows = [];
        collections.set(name, {
          rows,
          async createIndex() {},
          async dropIndex() {},
          async findOne(q) {
            return structuredClone(rows.find((d) => matches(d, q)) || null);
          },
          find(q = {}) {
            let found = rows.filter((d) => matches(d, q));
            return {
              sort() {
                return this;
              },
              hint() {
                return this;
              },
              limit(n) {
                found = found.slice(0, n);
                return this;
              },
              batchSize() {
                return this;
              },
              async *[Symbol.asyncIterator]() {
                for (const row of found) yield structuredClone(row);
              },
              async toArray() {
                return structuredClone(found);
              },
            };
          },
          async insertOne(d) {
            if (d.signalKey && rows.some((r) => r.signalKey === d.signalKey)) {
              const e = new Error("duplicate");
              e.code = 11000;
              throw e;
            }
            rows.push(structuredClone(d));
            return { insertedId: rows.length };
          },
          async updateOne(q, u, options = {}) {
            let d = rows.find((d) => matches(d, q));
            const matched = !!d;
            if (!d && options.upsert) {
              d = { ...q, ...structuredClone(u.$setOnInsert || {}) };
              rows.push(d);
            }
            if (d) Object.assign(d, structuredClone(u.$set || {}));
            return {
              matchedCount: Number(matched),
              modifiedCount: Number(!!d),
            };
          },
        });
      }
      return collections.get(name);
    },
  };
  return db;
}
module.exports.memoryDb = memoryDb;
