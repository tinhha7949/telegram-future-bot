"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG, parseConfig } = require("./config");
const { RiskGuard } = require("./risk/day-guard");

test("single validated config with no strategy env overrides", () => {
  assert.ok(CONFIG.RISK_PER_TRADE > 0);
  assert.ok(CONFIG.MAX_DAILY_RISK >= CONFIG.RISK_PER_TRADE);
  assert.ok(Array.isArray(CONFIG.TP_BATCHES) && CONFIG.TP_BATCHES.length === 2);
  assert.ok(CONFIG.AI7_ACTIVATION_SAMPLES >= CONFIG.COLD_START_SAMPLES);
  assert.ok(CONFIG.N_CANDLES > CONFIG.VOL_LONG_RETURNS);
  assert.equal(Object.hasOwn(CONFIG, "HISTORY_FETCH_CANDLES"), false);
  const yaml = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "CONFIG.yaml"), "utf8");
  assert.equal(parseConfig(yaml).N_CANDLES, CONFIG.N_CANDLES);
  const nextN = Math.min(CONFIG.BINANCE_CANDLE_REQUEST_LIMIT - 1,
    Math.max(CONFIG.VOL_LONG_RETURNS + 1, CONFIG.N_CANDLES + 1));
  assert.equal(parseConfig(yaml.replace(/^N_CANDLES: \d+$/m, "N_CANDLES: " + nextN)).N_CANDLES, nextN);
  assert.throws(() => parseConfig(yaml.replace(/^N_CANDLES: \d+$/m, "N_CANDLES: " + CONFIG.VOL_LONG_RETURNS)),
    /CONFIG_CROSS_FIELD_INVARIANT/);
  assert.throws(() => parseConfig(yaml.replace(/^MAX_DAILY_RISK: [^\n]*$/m,
    "MAX_DAILY_RISK: " + (CONFIG.RISK_PER_TRADE / 2))),
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
  // Isolate daily-risk behavior from editable production defaults such as
  // MAX_TRADES_PER_DAY. These values are test fixtures, not strategy defaults.
  const testConfig = {
    ...CONFIG,
    MAX_DAILY_RISK: CONFIG.RISK_PER_TRADE * 2.5,
    MAX_TRADES_PER_DAY: Math.max(CONFIG.MAX_TRADES_PER_DAY, 10),
  };
  const g = new RiskGuard(db, { config: testConfig, now: () => Date.UTC(2026, 9, 23) });
  assert.equal((await g.reserve("bad", NaN)).ok, false);
  const allowed = Math.floor(testConfig.MAX_DAILY_RISK / testConfig.RISK_PER_TRADE + 1e-9);
  assert.ok(allowed >= 1);
  assert.equal((await g.reserve("a", 1000, { labelCount: 150 })).ok, true);
  assert.equal((await g.reserve("a", 1000, { labelCount: 150 })).ok, false);
  for (let i = 1; i < allowed; i++)
    assert.equal((await g.reserve("risk-" + i, 1000, { labelCount: 150 })).ok, true);
  assert.equal((await g.reserve("over-capacity", 1000, { labelCount: 150 })).reason, "MAX_DAILY_RISK_REACHED");

  // The strategy cap is hard: configuration may lower it, never raise it above 3.
  g.now = () => Date.UTC(2026, 9, 24);
  g.config.MAX_DAILY_RISK = 0.9;
  g.config.MAX_TRADES_PER_DAY = 10;
  for (let i = 1; i <= 3; i++)
    assert.equal((await g.reserve("hard-cap-" + i, 1000, { labelCount: 150 })).ok, true);
  assert.equal((await g.reserve("hard-cap-4", 1000, { labelCount: 150 })).reason, "MAX_TRADES_PER_DAY_REACHED");

  const belowCircuit = Math.max(1, 1000 * (1 - testConfig.MAX_DRAWDOWN_CIRCUIT - 0.01));
  assert.equal((await g.assess(belowCircuit)).reason, "DRAWDOWN_CIRCUIT_LATCHED");
  assert.equal(g.config.EQUITY_START, CONFIG.EQUITY_START);
  assert.equal((await new RiskGuard(db, { config: testConfig }).assess(1000)).reason, "DRAWDOWN_CIRCUIT_LATCHED");
});
