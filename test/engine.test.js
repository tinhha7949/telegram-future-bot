"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TradingEngine } = require("../src/engine");

test("entry is blocked when exchange already has the configured 20 open positions", async () => {
  let accountRequested = false;
  const exchange = {
    positions: async () => Array.from({ length: 20 }, (_, i) => ({
      symbol: "COIN" + i + "USDT", positionAmt: "1"
    })),
    account: async () => { accountRequested = true; throw new Error("must not request account at cap"); }
  };
  const store = {
    getPosition: async () => null,
    getOpenPositions: async () => []
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    risk: { maxActivePositions: 20 }
  }, exchange, store, {});
  await engine.openTrade("NEWUSDT", { side: "LONG", entry: 100, stop: 99 });
  assert.equal(accountRequested, false);
});

test("entry cap counts unique positions across Binance and MongoDB", async () => {
  let accountRequested = false;
  const exchange = {
    positions: async () => Array.from({ length: 12 }, (_, i) => ({
      symbol: "COIN" + i + "USDT", positionAmt: "1"
    })),
    account: async () => { accountRequested = true; throw new Error("must not request account at cap"); }
  };
  const store = {
    getPosition: async () => null,
    getOpenPositions: async () => [
      ...Array.from({ length: 12 }, (_, i) => ({ symbol: "COIN" + i + "USDT" })),
      ...Array.from({ length: 8 }, (_, i) => ({ symbol: "DBONLY" + i + "USDT" }))
    ]
  };
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    risk: { maxActivePositions: 20 }
  }, exchange, store, {});
  await engine.openTrade("NEWUSDT", { side: "LONG", entry: 100, stop: 99 });
  assert.equal(accountRequested, false);
});

test("signal scanning processes coins sequentially in configurable batches", async () => {
  const symbols = Array.from({ length: 12 }, (_, i) => "TEST" + i + "USDT");
  const calls = [];
  const engine = new TradingEngine({
    app: { logLevel: "silent" },
    scanner: { batchSize: 10, batchDelayMs: 0 },
    strategy: { entryTimeframe: "5m", trendTimeframe: "15m", historyCandles: 160 }
  }, { positions: async () => [] }, { getPosition: async () => null }, {});
  engine.running = true;
  engine.universe = symbols;
  for (const symbol of symbols) engine.lastCandle.set(symbol, 123);
  engine.candles = async (symbol, interval) => {
    calls.push(symbol + ":" + interval);
    return [{ closeTime: 123 }];
  };

  await engine.checkSignals();

  assert.equal(calls.length, 24);
  for (let i = 0; i < symbols.length; i++) {
    assert.deepEqual(calls.slice(i * 2, i * 2 + 2), [
      symbols[i] + ":15m",
      symbols[i] + ":5m"
    ]);
  }
});
