"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Exchange, makeClientId } = require("../src/exchange");

function createExchange() {
  return new Exchange({binance:{baseUrl:"https://example.test",testnetBaseUrl:"https://testnet.example",recvWindow:1000,requestTimeoutMs:1000,maxRetries:0}}, "key", "secret");
}

test("client IDs are short, unique, and Binance-safe", () => {
  const a = makeClientId("E"), b = makeClientId("A");
  assert.equal(a.length, 23);
  assert.equal(b.length, 23);
  assert.match(a, /^[A-Za-z0-9_-]{1,36}$/);
  assert.notEqual(a, b);
});

test("live URL is used even if an old VPS .env still has BINANCE_TESTNET=true", () => {
  const previous = process.env.BINANCE_TESTNET;
  process.env.BINANCE_TESTNET = "true";
  try {
    assert.equal(createExchange().base, "https://example.test");
  } finally {
    if (previous === undefined) delete process.env.BINANCE_TESTNET;
    else process.env.BINANCE_TESTNET = previous;
  }
});

test("quantity rounding uses MARKET_LOT_SIZE for entries and LOT_SIZE for algo exits", () => {
  const x = createExchange();
  x.filters.set("BTCUSDT", {
    marketStepSize: .01, marketMinQty: .01,
    lotStepSize: .001, lotMinQty: .001,
    tickSize: .1, minNotional: 5
  });
  assert.equal(x.quantity("BTCUSDT", .1239, true), .12);
  assert.equal(x.quantity("BTCUSDT", .1239, false), .123);
});

test("price rounding keeps stops and targets on the safe side of tick size", () => {
  const x = createExchange();
  x.filters.set("BTCUSDT", {tickSize:.1,marketStepSize:.001,marketMinQty:.001,lotStepSize:.001,lotMinQty:.001,minNotional:5});
  assert.equal(x.price("BTCUSDT", 100.01, "UP"), 100.1);
  assert.equal(x.price("BTCUSDT", 100.09, "DOWN"), 100);
  assert.equal(x.price("BTCUSDT", 100.06), 100.1);
});

test("conditional TP/SL submissions use the USD-M Algo Order endpoint and safe clientAlgoId", async () => {
  const x = createExchange();
  const previousFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = {url: new URL(url), options};
    return {ok:true, json:async()=>({algoId:123, clientAlgoId:"A123", algoStatus:"NEW"})};
  };
  try {
    const result = await x.newAlgoOrder({
      symbol:"BTCUSDT", side:"SELL", type:"STOP_MARKET",
      triggerPrice:100, closePosition:"true", workingType:"MARK_PRICE", priceProtect:"false"
    });
    assert.equal(result.algoId, 123);
    assert.equal(captured.url.pathname, "/fapi/v1/algoOrder");
    assert.equal(captured.url.searchParams.get("algoType"), "CONDITIONAL");
    assert.equal(captured.url.searchParams.get("clientAlgoId").length, 23);
    assert.equal(captured.url.searchParams.get("closePosition"), "true");
    assert.equal(captured.url.searchParams.has("quantity"), false);
    assert.equal(captured.url.searchParams.has("reduceOnly"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("algo order query and cancellation use algoId without unsupported symbol parameter", async () => {
  const x = createExchange();
  const previousFetch = global.fetch;
  const urls = [];
  global.fetch = async (url, options) => {
    urls.push({url:new URL(url), method:options.method});
    return {ok:true, json:async()=>({algoId:321, algoStatus:"CANCELED"})};
  };
  try {
    await x.algoOrder(321);
    await x.cancelAlgoOrder(321);
    assert.equal(urls[0].url.pathname, "/fapi/v1/algoOrder");
    assert.equal(urls[0].url.searchParams.get("algoId"), "321");
    assert.equal(urls[0].url.searchParams.has("symbol"), false);
    assert.equal(urls[1].method, "DELETE");
    assert.equal(urls[1].url.searchParams.get("algoId"), "321");
    assert.equal(urls[1].url.searchParams.has("symbol"), false);
  } finally {
    global.fetch = previousFetch;
  }
});
