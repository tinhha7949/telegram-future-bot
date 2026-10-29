"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG } = require("./config");
const { fixture } = require("./test-fixtures.cjs");
const { vetoMarketSnapshot, vetoAvailableMargin } = require("./ai6-risk-guardian");

test("AI-6 market guardian blocks stale/missing data, hot funding and wide spread", () => {
  const f = fixture();
  assert.equal(vetoMarketSnapshot(f.market, f.market.now).ok, true);
  const cases = [
    [{ ...f.market, snapshotAt: undefined }, "EXECUTION_COST_INPUTS_MISSING_MARKET_SNAPSHOT_AT"],
    [{ ...f.market, snapshotAt: f.market.now + 1 }, "EXECUTION_COST_INPUTS_FUTURE_MARKET_SNAPSHOT"],
    [{ ...f.market, snapshotAt: f.market.now - 4 * 3600000 - 1 }, "STALE_MARKET_SNAPSHOT"],
    [{ ...f.market, fundingRate: CONFIG.FUNDING_HOT }, "HOT_FUNDING"],
    [{ ...f.market, spreadPct: CONFIG.MAX_SPREAD_PCT + 0.001 }, "SPREAD_TOO_WIDE"],
    [{ ...f.market, openInterestChange: null }, "EXECUTION_COST_INPUTS_MISSING_OPEN_INTEREST_CHANGE"],
    [{ ...f.market, depthNotional: 0 }, "EXECUTION_COST_INPUTS_MISSING_ORDERBOOK_DEPTH"],
    [{ ...f.market, latencyMs: null }, "EXECUTION_COST_INPUTS_MISSING_LATENCY"],
  ];
  for (const [market, reason] of cases) {
    const result = vetoMarketSnapshot(market, f.market.now);
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
  }
});

test("AI-6 balance guardian checks margin before broker submission", () => {
  const sizing = { notional: 50 };
  const account = {
    equity: 8,
    availableBalance: 10,
    leverageBySymbol: { TESTUSDT: { leverage: 10, maxNotional: 1000 } },
  };
  assert.equal(vetoAvailableMargin({ account, sizing, symbol: "TESTUSDT" }).ok, true);
  const low = vetoAvailableMargin({
    account: { ...account, availableBalance: 1 },
    sizing,
    symbol: "TESTUSDT",
  });
  assert.equal(low.ok, false);
  assert.equal(low.reason, "AI6_VETO_INSUFFICIENT_AVAILABLE_MARGIN");
  assert.equal(vetoAvailableMargin({
    account: { ...account, availableBalance: null },
    sizing,
    symbol: "TESTUSDT",
  }).reason, "AI6_VETO_BALANCE_UNAVAILABLE");
});
