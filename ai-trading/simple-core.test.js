"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ema, rsi, atr, coreLogic } = require("./coreLogic");
const { getTopSymbol } = require("./getTopSymbol");
const { loadSimpleConfig } = require("./simple-config");
const { buildProtection } = require("./tpsl");
const C = loadSimpleConfig();

function bars(n, start, step, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => ({
    openTime: now - n * 60000 + i * 60000,
    high: start + i * step + 1,
    low: start + i * step - 1,
    close: start + i * step,
    volume: 100,
    closeTime: now - n * 60000 + (i + 1) * 60000 - 1
  }));
}

test("EMA calculates last value and requires sufficient candles", () => {
  assert.equal(ema([1, 2, 3], 4), null);
  assert.ok(ema(Array.from({ length: 100 }, (_, i) => i + 1), 100) > 0);
});

test("RSI reaches 100 for monotonic rise and 0 for monotonic fall", () => {
  assert.equal(rsi(Array.from({ length: 15 }, (_, i) => i + 1), 14), 100);
  assert.equal(rsi(Array.from({ length: 15 }, (_, i) => 15 - i), 14), 0);
});

test("ATR is positive for valid candles", () => assert.ok(atr(bars(20, 100, 0.1), 14) > 0));

test("strategy never signals LONG below EMA or SHORT above EMA", () => {
  const now = Date.now();
  const falling = Array.from({ length: 120 }, (_, i) => ({
    openTime: now - (120 - i) * 14400000,
    high: 200 - i,
    low: 198 - i,
    close: 199 - i,
    closeTime: now - (120 - i) * 14400000 + 14399999
  }));
  const entryUp = Array.from({ length: 30 }, (_, i) => ({
    openTime: now - (30 - i) * 60000,
    high: 100 + i,
    low: 98 + i,
    close: 99 + i,
    closeTime: now - (30 - i) * 60000 + 59999
  }));
  const down = coreLogic({ trendCandles: falling, entryCandles: entryUp, config: C, now });
  assert.notEqual(down.side, "LONG");
  const rising = falling.map((x, i) => ({ ...x, high: 100 + i, low: 98 + i, close: 99 + i }));
  const entryDown = entryUp.map((x, i) => ({ ...x, high: 130 - i, low: 128 - i, close: 129 - i }));
  const up = coreLogic({ trendCandles: rising, entryCandles: entryDown, config: C, now });
  assert.notEqual(up.side, "SHORT");
});

test("config uses RR 1.3 and caps the symbol list at 100", () => {
  assert.equal(C.REWARD_RISK, 1.3);
  assert.equal(C.MAX_SYMBOLS, 100);
  assert.equal(Object.keys(C).some(k => /5M/i.test(k)), false);
});

test("coin selection uses only 24h ticker metrics and caps results", async () => {
  const calls = [];
  const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "NOTPERPUSDT"];
  const exchangeInfo = { symbols: symbols.map((symbol, i) => ({
    symbol, status: "TRADING", contractType: i === 3 ? "CURRENT_QUARTER" : "PERPETUAL", quoteAsset: "USDT"
  })) };
  const tickers = [
    { symbol: "AAAUSDT", quoteVolume: "9000000", highPrice: "120", lowPrice: "90", lastPrice: "100" },
    { symbol: "BBBUSDT", quoteVolume: "8000000", highPrice: "115", lowPrice: "90", lastPrice: "100" },
    { symbol: "CCCUSDT", quoteVolume: "7000000", highPrice: "110", lowPrice: "90", lastPrice: "100" },
    { symbol: "NOTPERPUSDT", quoteVolume: "99999999", highPrice: "150", lowPrice: "80", lastPrice: "100" }
  ];
  const request = async (method, path) => {
    calls.push(path);
    if (path === "/fapi/v1/exchangeInfo") return exchangeInfo;
    if (path === "/fapi/v1/ticker/24hr") return tickers;
    throw new Error("Unexpected endpoint: " + path);
  };
  const result = await getTopSymbol({ request, config: { ...C, MAX_SYMBOLS: 2 } });
  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result), new Set(["AAAUSDT", "BBBUSDT"]));
  assert.deepEqual(calls.sort(), ["/fapi/v1/exchangeInfo", "/fapi/v1/ticker/24hr"]);
});

test("TP/SL obey direction and configured 1.3 RR", () => {
  const long = buildProtection({ side: "LONG", entryPrice: 100, atr: 1, config: C, priceTick: 0.01 });
  const short = buildProtection({ side: "SHORT", entryPrice: 100, atr: 1, config: C, priceTick: 0.01 });
  assert.ok(long.sl < 100 && long.tp > 100);
  assert.ok(short.sl > 100 && short.tp < 100);
  assert.ok(Math.abs((long.tp - 100) / (100 - long.sl) - C.REWARD_RISK) < 0.02);
  assert.ok(Math.abs((100 - short.tp) / (short.sl - 100) - C.REWARD_RISK) < 0.02);
});
