"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ema, rsi, atr, isLongRsi, isShortRsi, coreLogic } = require("./coreLogic");
const { getTopSymbol } = require("./getTopSymbol");
const { loadSimpleConfig } = require("./simple-config");
const { buildProtection, placeProtection } = require("./tpsl");
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

test("RSI triggers inclusively in configured LONG 10-20 and SHORT 80-90 ranges", () => {
  assert.equal(C.TREND_TIMEFRAME, "1h");
  assert.equal(C.TREND_EMA_PERIOD, 5);
  assert.equal(C.RSI_LONG_MIN, 10);
  assert.equal(C.RSI_LONG_TRIGGER, 20);
  assert.equal(C.RSI_SHORT_TRIGGER, 80);
  assert.equal(C.RSI_SHORT_MAX, 90);
  for (const value of [10, 10.01, 15, 19.99, 20]) assert.equal(isLongRsi(value, C), true, "LONG RSI " + value);
  for (const value of [0, 9.999, 9, 20.001, 21, 30, 80, 100]) assert.equal(isLongRsi(value, C), false, "not LONG RSI " + value);
  for (const value of [80, 80.01, 85, 89.99, 90]) assert.equal(isShortRsi(value, C), true, "SHORT RSI " + value);
  for (const value of [0, 10, 79.999, 79, 90.001, 91, 100]) assert.equal(isShortRsi(value, C), false, "not SHORT RSI " + value);
});

test("config rejects invalid RSI trigger thresholds", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "CONFIG.yaml"), "utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-config-"));
  const file = path.join(dir, "CONFIG.yaml");
  try {
    fs.writeFileSync(file, source.replace("RSI_LONG_TRIGGER: 20", "RSI_LONG_TRIGGER: 5"));
    assert.throws(() => loadSimpleConfig(file), /SIMPLE_CONFIG_INVARIANT:RSI_LONG_RANGE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Wilder RSI converges when calculated from a long Binance candle history", () => {
  const closes = Array.from({ length: 1000 }, (_, i) => 100 + Math.sin(i / 7) * 3 + Math.sin(i / 31) * 2 + i * 0.002);
  const fullHistory = rsi(closes, 14);
  const warmHistory = rsi(closes.slice(-500), 14);
  assert.ok(Number.isFinite(fullHistory) && Number.isFinite(warmHistory));
  assert.ok(Math.abs(fullHistory - warmHistory) < 0.05, "500 closed candles should converge to the long-history Wilder RSI");
});

test("protection prices round away from entry and Binance algo client IDs stay below 36 chars", async () => {
  const calls = [];
  await placeProtection({
    request: async (method, path, params) => { calls.push(params); return { algoId: calls.length }; },
    symbol: "1000PEPEUSDT", side: "LONG", sl: 0.0049, tp1: 0.0051, tp2: 0.0052,
    qty: 10, stepSize: 0.1, minQty: 0.1, config: C
  });
  const ids = calls.map(x => x.clientAlgoId);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every(id => typeof id === "string" && id.length > 0 && id.length < 36));
});

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

test("config uses configured RR and caps the symbol list at 100", () => {
  assert.equal(C.REWARD_RISK, 1.55);
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

test("TP/SL obey direction and configured TP2 RR", () => {
  const long = buildProtection({ side: "LONG", entryPrice: 100, atr: 1, config: C, priceTick: 0.01 });
  const short = buildProtection({ side: "SHORT", entryPrice: 100, atr: 1, config: C, priceTick: 0.01 });
  assert.ok(long.sl < 100 && long.tp > 100);
  assert.ok(short.sl > 100 && short.tp < 100);
  assert.ok(Math.abs((long.tp - 100) / (100 - long.sl) - C.TP2_REWARD_RISK) < 0.02);
  assert.ok(Math.abs((100 - short.tp) / (short.sl - 100) - C.REWARD_RISK) < 0.02);
});
