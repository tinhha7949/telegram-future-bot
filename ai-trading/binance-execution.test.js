"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { BinanceExchange, sizeTrade } = require("./binance-execution");
test("fractional clock offsets and persisted times serialize as integer milliseconds", async () => {
  const queries = [];
  const e = new BinanceExchange({
    key: "fake", secret: "fake", now: () => 1792628533640,
    budget: { async acquire() {}, observe() {} },
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams;
      for (const key of ["timestamp", "startTime", "endTime", "recvWindow"])
        if (query.has(key)) assert.match(query.get(key), /^\d+$/);
      queries.push(query);
      return { ok: true, json: async () => [] };
    },
  });
  e.offset = 0.5;
  await e.fills({ symbol: "TEST", submittedAt: 1792628433640.5, enteredAt: 1792628433650 });
  await e.funding("TEST", 1792628433640.5, 1792628533640.5);
  await e.rawCandles("TEST", "1m", 1, { startTime: 1792628433640.5 });
  assert.equal(queries[0].get("startTime"), "1792628428640");
  assert.equal(queries[0].get("endTime"), "1792628533640");
  assert.equal(queries[0].get("timestamp"), "1792628533640");
});
test("invalid fill history times fail locally without requesting Infinity", async () => {
  const e = new BinanceExchange();
  e.request = async () => assert.fail("invalid time must not reach the exchange");
  await assert.rejects(e.fills({ symbol: "TEST" }), /INVALID_FILL_TIME_RANGE/);
});
test("algo queries and single cancellation send only documented identifiers", async () => {
  const e = new BinanceExchange(), calls = [];
  e.request = async (path, params, options) => {
    calls.push({ path, params, options });
    return {};
  };
  await e.algo("TESTUSDT", "client-id");
  await e.algoById("TESTUSDT", 123);
  await e.cancelAlgo("TESTUSDT", 123);
  assert.deepEqual(calls.map((c) => c.params), [
    { clientAlgoId: "client-id" }, { algoId: 123 }, { algoId: 123 },
  ]);
  assert.equal(calls[2].options.method, "DELETE");
});
test("distinct targets submit reduce-only TP1 for half and close-position TP2 for the remainder", async () => {
  const e = new BinanceExchange(), calls = [];
  e.request = async (_, p) => { calls.push(p); return { algoId: calls.length }; };
  const t = { symbol: "TESTUSDT", side: "SHORT", actualQuantity: 2, sl: 101, tp1: 98, tp2: 96 };
  await e.protection(t, "tp1", "first");
  await e.protection(t, "tp2", "second");
  assert.equal(calls[0].side, "BUY");
  assert.equal(calls[0].quantity, 1);
  assert.equal(calls[0].reduceOnly, "true");
  assert.equal(calls[1].closePosition, "true");
  assert.equal(calls[1].quantity, undefined);
});
test("ambiguous market POST is queried by the same ID and is never blindly repeated", async () => {
  const calls = [];
  const e = new BinanceExchange({
    key: "fake",
    secret: "fake",
    wait: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "POST") throw new Error("response lost");
      return {
        ok: true,
        json: async () => ({
          orderId: 1,
          status: "FILLED",
          executedQty: "2",
          avgPrice: "100",
        }),
      };
    },
  });
  const o = await e.market(
    { symbol: "TEST", side: "LONG", quantity: 2 },
    "same-order",
  );
  assert.equal(o.status, "FILLED");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.ok(calls[1].url.includes("origClientOrderId=same-order"));
});
test("fill pagination does not combine fromId with time parameters", async () => {
  const queries = [],
    e = new BinanceExchange();
  e.request = async (_, p) => {
    queries.push(p);
    return queries.length === 1
      ? Array.from({ length: 1000 }, (_, i) => ({ id: i, time: 10000 }))
      : [];
  };
  await e.fills({ symbol: "TEST", enteredAt: 10000 }, 20000);
  assert.equal(queries[1].fromId, "1000");
  assert.equal(queries[1].startTime, undefined);
  assert.equal(queries[1].endTime, undefined);
});
test("coincident quantile targets submit two distinct reduce-only half-position orders", async () => {
  const e = new BinanceExchange();
  const calls = [];
  e.request = async (url, params) => {
    calls.push({ url, params });
    return { algoId: calls.length };
  };
  const t = {
    symbol: "TESTUSDT",
    side: "LONG",
    actualQuantity: 2,
    sl: 99,
    tp1: 103,
    tp2: 103,
  };
  await e.protection(t, "sl", "stop");
  await e.protection(t, "tp1", "first");
  await e.protection(t, "tp2", "second");
  assert.equal(calls[0].params.closePosition, "true");
  for (const call of calls.slice(1)) {
    assert.equal(call.params.quantity, 1);
    assert.equal(call.params.reduceOnly, "true");
    assert.equal(call.params.closePosition, undefined);
    assert.equal(call.params.triggerPrice, 103);
  }
  assert.notEqual(calls[1].params.clientAlgoId, calls[2].params.clientAlgoId);
});

test("sizing rounds protection before risk and always permits exact 50% TP1", () => {
  const info = {
    filters: [
      { filterType: "LOT_SIZE", stepSize: ".1", minQty: ".1", maxQty: "10000" },
      {
        filterType: "MARKET_LOT_SIZE",
        stepSize: ".1",
        minQty: ".1",
        maxQty: "10000",
      },
      { filterType: "PRICE_FILTER", tickSize: ".1" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  };
  const s = sizeTrade(
    { side: "LONG", entry: 100, sl: 99.05, tp1: 102.05, tp2: 104.05 },
    1000,
    0.0075,
    info,
  );
  assert.equal(s.sl, 99);
  assert.ok(s.quantity * s.initialRisk <= 7.5);
  assert.ok(
    Math.abs(s.quantity / 2 / 0.1 - Math.round(s.quantity / 2 / 0.1)) < 1e-8,
  );
  const shared = sizeTrade(
    { side: "LONG", entry: 100, sl: 99.05, tp1: 102.01, tp2: 102.02 },
    1000,
    0.0075,
    info,
  );
  assert.ok(shared);
  assert.equal(shared.tp1, shared.tp2);
  assert.ok(shared.quantity * shared.initialRisk <= 7.5);
});
