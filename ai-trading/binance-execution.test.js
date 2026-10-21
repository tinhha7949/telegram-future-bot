"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { BinanceExchange, sizeTrade } = require("./binance-execution");
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
