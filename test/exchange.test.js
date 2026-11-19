"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Exchange } = require("../src/exchange");
test("price rounding keeps stops and targets on the safe side of tick size", () => {
  const x = new Exchange({binance:{baseUrl:"https://example.test",recvWindow:1000,requestTimeoutMs:1000,maxRetries:0}}, "key", "secret");
  x.filters.set("BTCUSDT", {tickSize:.1,stepSize:.001,minQty:.001,minNotional:5});
  assert.equal(x.price("BTCUSDT", 100.01, "UP"), 100.1);
  assert.equal(x.price("BTCUSDT", 100.09, "DOWN"), 100);
  assert.equal(x.price("BTCUSDT", 100.06), 100.1);
});
