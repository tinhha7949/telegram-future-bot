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
test("distinct targets submit independent reduce-only TP1 60% and TP2 40%", async () => {
  const e = new BinanceExchange(), calls = [];
  e.request = async (_, p) => { calls.push(p); return { algoId: calls.length }; };
  const t = { symbol: "TESTUSDT", side: "SHORT", actualQuantity: 2, tp1Quantity: 1.2, tp2Quantity: 0.8, sl: 101, tp1: 98, tp2: 96 };
  await e.protection(t, "tp1", "first");
  await e.protection(t, "tp2", "second");
  assert.equal(calls[0].side, "BUY");
  assert.equal(calls[0].quantity, 1.2);
  assert.equal(calls[0].reduceOnly, "true");
  assert.equal(calls[1].reduceOnly, "true");
  assert.equal(calls[1].quantity, 0.8);
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
for (const code of [-1006, -1007])
  test(`Binance ${code} with HTTP 400 still reconciles the accepted order ID`, async () => {
    const calls = [];
    const e = new BinanceExchange({ key: "fake", secret: "fake",
      budget: { async acquire() {}, observe() {} }, wait: async () => {},
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method });
        return options.method === "POST"
          ? { ok: false, status: 400, json: async () => ({ code, msg: "Execution status unknown" }) }
          : { ok: true, status: 200, json: async () => ({ orderId: 123, status: "FILLED", executedQty: "2", avgPrice: "100" }) };
      },
    });
    const order = await e.market({ symbol: "TESTUSDT", side: "LONG", quantity: 2 }, "same-id");
    assert.equal(order.status, "FILLED");
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    assert.match(calls[1].url, /origClientOrderId=same-id/);
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
test("coincident quantile targets submit two distinct reduce-only 60/40 orders", async () => {
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
    tp1Quantity: 1.2,
    tp2Quantity: 0.8,
    sl: 99,
    tp1: 103,
    tp2: 103,
  };
  await e.protection(t, "sl", "stop");
  await e.protection(t, "tp1", "first");
  await e.protection(t, "tp2", "second");
  assert.equal(calls[0].params.closePosition, "true");
  for (const [i, call] of calls.slice(1).entries()) {
    assert.equal(call.params.quantity, i === 0 ? 1.2 : 0.8);
    assert.equal(call.params.reduceOnly, "true");
    assert.equal(call.params.closePosition, undefined);
    assert.equal(call.params.triggerPrice, 103);
  }
  assert.notEqual(calls[1].params.clientAlgoId, calls[2].params.clientAlgoId);
});

test("sizing rounds protection before risk and enforces exact 60/40 TP", () => {
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
    Math.abs(s.tp1Quantity / 0.1 - Math.round(s.tp1Quantity / 0.1)) < 1e-8 &&
    Math.abs(s.tp2Quantity / 0.1 - Math.round(s.tp2Quantity / 0.1)) < 1e-8 &&
    Math.abs(s.tp1Quantity / s.quantity - 0.6) < 1e-8,
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

test("an unavailable lookup never changes an ambiguous MARKET into a definitive rejection", async () => {
  let posts = 0;
  const e = new BinanceExchange({ key: "fake", secret: "fake", wait: async () => {},
    budget: { async acquire() {}, observe() {} },
    fetchImpl: async (_, options) => {
      if (options.method === "POST") posts++;
      throw new Error("network down");
    },
  });
  await assert.rejects(e.market({ symbol: "TEST", side: "LONG", quantity: 2 }, "accepted-id"),
    (error) => error.ambiguous === true);
  assert.equal(posts, 1);
});

for (const side of ["LONG", "SHORT"])
  test(`${side} missing average fill price is rebuilt only from matching complete entry executions`, async () => {
    const e = new BinanceExchange();
    const fills = [
      { id: 1, orderId: 123, symbol: "TEST", side: side === "LONG" ? "BUY" : "SELL", qty: ".5", price: "100", time: 10000 },
      { id: 2, orderId: 123, symbol: "TEST", side: side === "LONG" ? "BUY" : "SELL", qty: "1.5", price: "102", time: 10001 },
    ];
    e.request = async (_, params) => {
      assert.equal(params.orderId, 123);
      return [...fills, fills[0], { ...fills[0], id: 3, orderId: 999 }];
    };
    const order = await e.entryFill({ symbol: "TEST", side, quantity: 2 },
      { orderId: 123, status: "FILLED", executedQty: "2", avgPrice: "0" });
    assert.equal(Number(order.avgPrice), 101.5);
    assert.equal(Number(order.executedQty), 2);
    assert.equal(order.time, 10000);
    assert.equal(order.fillSource, "CONFIRMED_ORDER_TRADE_HISTORY");
    e.request = async () => fills.slice(0, 1);
    await assert.rejects(e.entryFill({ symbol: "TEST", side, quantity: 2 },
      { orderId: 123, status: "FILLED", executedQty: "2" }), /ENTRY_FILL_HISTORY_INCOMPLETE/);
  });

test("cancelAlgos cancels only this bot's conditional orders", async () => {
  const e = new BinanceExchange(), canceled = [];
  e.openAlgos = async () => [
    { symbol: "TESTUSDT", algoId: 1, clientAlgoId: "n9_1234abcd_sl_abc" },
    { symbol: "TESTUSDT", algoId: 2, clientAlgoId: "manual-stop" },
    { symbol: "OTHERUSDT", algoId: 3, clientAlgoId: "n9_8765abcd_tp1_def" },
  ];
  e.cancelAlgo = async (symbol, algoId) => canceled.push({ symbol, algoId });
  assert.equal(await e.cancelAlgos("TESTUSDT"), 1);
  assert.deepEqual(canceled, [{ symbol: "TESTUSDT", algoId: 1 }]);
});
