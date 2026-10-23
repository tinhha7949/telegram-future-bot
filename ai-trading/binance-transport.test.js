"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events");
const { BinanceExchange } = require("./binance-execution");
const { RequestBudget, requestWeight } = require("./binance-request-budget");
const { FourHourHistory, BAR_MS } = require("./four-hour-history");
const { BinanceMarketFeed, URLS } = require("./binance-market-feed");
const { marketSnapshot, loadDecisionInput, HISTORY_4H_LIMIT } = require("../index");
const host = "https://fapi.binance.com";
const response = (data, status = 200, headers = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (key) => headers[key.toLowerCase()] ?? null },
  async json() {
    return data;
  },
});

test("history request weights and a large scan stay inside the rolling budget", async () => {
  assert.deepEqual(
    [3, 499, 500, 1000, 1500].map((limit) =>
      requestWeight("/fapi/v1/klines", { limit }),
    ),
    [1, 2, 5, 5, 10],
  );
  let clock = 0;
  const budget = new RequestBudget({
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    limit: 60,
  });
  const sent = [];
  for (let i = 0; i < 100; i++) {
    await budget.acquire({
      host,
      path: "/fapi/v1/klines",
      params: { limit: 499 },
      signed: false,
      method: "GET",
    });
    sent.push({ at: clock, weight: 2 });
  }
  for (const event of sent)
    assert.ok(
      sent
        .filter((e) => e.at <= event.at && e.at > event.at - 60000)
        .reduce((sum, e) => sum + e.weight, 0) <= 48,
    );
  assert.ok(clock >= 4 * 60000);
});

test("background pacing does not queue protection behind history requests", async () => {
  let clock = 1000;
  const budget = new RequestBudget({
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    limit: 60,
  });
  await budget.acquire({
    host,
    path: "/fapi/v1/klines",
    params: { limit: 1500 },
    signed: false,
    method: "GET",
  });
  const before = clock;
  await budget.acquire({
    host,
    path: "/fapi/v1/algoOrder",
    params: {},
    signed: true,
    method: "POST",
  });
  assert.equal(clock, before);
  await budget.acquire({
    host,
    path: "/fapi/v1/klines",
    params: { limit: 1500 },
    signed: false,
    method: "GET",
  });
  assert.ok(clock > before);
});

test("IP usage headers reserve capacity for account/protection and defer background traffic", async () => {
  let clock = 1000;
  const budget = new RequestBudget({
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  });
  budget.observe(
    host,
    response({}, 200, { "x-mbx-used-weight-1m": "1700" }),
    {},
  );
  await budget.acquire({
    host,
    path: "/fapi/v2/positionRisk",
    params: {},
    signed: true,
    method: "GET",
  });
  assert.equal(clock, 1000);
  await budget.acquire({
    host,
    path: "/fapi/v1/depth",
    params: { limit: 20 },
    signed: false,
    method: "GET",
  });
  assert.ok(clock >= 60000);
  budget.configure([
    {
      rateLimitType: "REQUEST_WEIGHT",
      interval: "MINUTE",
      intervalNum: 1,
      limit: 1200,
    },
  ]);
  assert.equal(budget.limit, 900);
});

test("OI statistics honor their own five-minute request limit", async () => {
  let clock = 0;
  const budget = new RequestBudget({
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    limit: 100000,
  });
  const at = [];
  for (let i = 0; i < 801; i++) {
    await budget.acquire({
      host,
      path: "/futures/data/openInterestHist",
      params: {},
      signed: false,
      method: "GET",
    });
    at.push(clock);
  }
  assert.ok(at[800] - at[0] >= 300000);
});

test("429 shares Retry-After with concurrent requests, not a one-second retry", async () => {
  let clock = 0,
    first = true;
  const sent = [],
    notices = [],
    wait = async (ms) => {
      clock += ms;
    };
  let notifyBlocked;
  const blocked = new Promise((resolve) => {
    notifyBlocked = resolve;
  });
  const budget = new RequestBudget({
    now: () => clock,
    wait,
    onCooldown: (v) => {
      notices.push(v);
      notifyBlocked();
    },
  });
  const exchange = new BinanceExchange({
    now: () => clock,
    wait,
    budget,
    fetchImpl: async (url) => {
      sent.push({ at: clock, route: new URL(url).pathname });
      if (first) {
        first = false;
        return response({ code: -1003, msg: "Too many requests" }, 429, {
          "retry-after": "7",
        });
      }
      return response({ ok: true });
    },
  });
  const firstRequest = exchange.request("/fapi/v1/premiumIndex", {
    symbol: "TEST",
  });
  await blocked;
  await Promise.all([
    firstRequest,
    exchange.request("/fapi/v1/depth", { symbol: "TEST", limit: 20 }),
  ]);
  assert.equal(sent.length, 3);
  assert.ok(sent.slice(1).every((r) => r.at >= 7000));
  assert.equal(notices.length, 1);
});

test("418 ban timestamp and HTTP-date Retry-After apply to the whole host", async () => {
  let clock = 1700000000000;
  const budget = new RequestBudget({
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    onCooldown() {},
  });
  const until = clock + 180000;
  budget.observe(host, response({}, 418, { "retry-after": "1" }), {
    code: -1003,
    msg: "IP banned until " + until,
  });
  await budget.acquire({
    host,
    path: "/fapi/v1/order",
    params: {},
    signed: true,
    method: "GET",
  });
  assert.ok(clock >= until);
  const date = clock + 5000;
  budget.observe(
    host,
    response({}, 429, { "retry-after": new Date(date).toUTCString() }),
    {},
  );
  await budget.acquire({
    host,
    path: "/fapi/v1/order",
    params: {},
    signed: true,
    method: "GET",
  });
  assert.ok(clock >= date);
});

test("repeated startup throttles wait rather than exhausting GET retries into a PM2 restart", async () => {
  let clock = 0,
    count = 0;
  const times = [],
    wait = async (ms) => {
      clock += ms;
    },
    budget = new RequestBudget({ now: () => clock, wait, onCooldown() {} });
  const exchange = new BinanceExchange({
    now: () => clock,
    wait,
    budget,
    fetchImpl: async () => {
      times.push(clock);
      if (++count < 3)
        return response({ code: -1003, msg: "Too many requests" }, 429, {
          "retry-after": "2",
        });
      return response({ serverTime: clock });
    },
  });
  await exchange.syncTime();
  assert.equal(count, 3);
  assert.ok(times[1] - times[0] >= 2000);
  assert.ok(times[2] - times[1] >= 2000);
  assert.equal(exchange.offset, 0);
});

test("shutdown cancels queued cooldown admission without dispatching another request", async () => {
  let release;
  const budget = new RequestBudget({
    now: () => 1000,
    wait: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    onCooldown() {},
  });
  budget.observe(host, response({}, 429, { "retry-after": "60" }), {});
  const pending = budget.acquire({
    host,
    path: "/fapi/v1/depth",
    params: {},
    method: "GET",
  });
  budget.stop();
  release();
  await assert.rejects(pending, /EXCHANGE_CLIENT_STOPPED/);
});

test("signed timestamps and network latency start after queue admission", async () => {
  let clock = 1000;
  const budget = {
    async acquire() {
      clock += 20000;
    },
    observe() {},
  };
  const exchange = new BinanceExchange({
    key: "fake",
    secret: "fake",
    now: () => clock,
    budget,
    fetchImpl: async (url) => {
      assert.equal(Number(new URL(url).searchParams.get("timestamp")), clock);
      clock += 25;
      return response({ account: true });
    },
  });
  const data = await exchange.request("/fapi/v3/account", {}, { signed: true });
  assert.equal(exchange.observations.get(data).latencyMs, 25);
});

test("parallel metadata loads share one request and OI cached observations keep their original age", async () => {
  let clock = 1000;
  const sent = [],
    exchange = new BinanceExchange({
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      fetchImpl: async (url) => {
        const route = new URL(url).pathname;
        sent.push(route);
        return response(
          route.endsWith("exchangeInfo")
            ? { symbols: [{ symbol: "TEST" }], rateLimits: [] }
            : [],
        );
      },
    });
  await Promise.all(
    Array.from({ length: 20 }, () => exchange.fundingInterval("TEST")),
  );
  await Promise.all(Array.from({ length: 20 }, () => exchange.symbols()));
  assert.equal(sent.filter((p) => p.endsWith("fundingInfo")).length, 1);
  assert.equal(sent.filter((p) => p.endsWith("exchangeInfo")).length, 1);
  const first = await exchange.cachedRequest(
    "/futures/data/openInterestHist",
    { symbol: "TEST", period: "4h", limit: 2 },
    60000,
  );
  const observed = exchange.observations.get(first).observedAt;
  clock += 30000;
  const second = await exchange.cachedRequest(
    "/futures/data/openInterestHist",
    { symbol: "TEST", period: "4h", limit: 2 },
    60000,
  );
  assert.equal(first, second);
  assert.equal(exchange.observations.get(second).observedAt, observed);
});

test("clock synchronization excludes cooldown/queue time from its network midpoint", async () => {
  let clock = 1000;
  const exchange = new BinanceExchange({
    now: () => clock,
    budget: {
      async acquire() {
        clock += 20000;
      },
      observe() {},
    },
    fetchImpl: async () => {
      const serverTime = clock + 510;
      clock += 20;
      return response({ serverTime });
    },
  });
  await exchange.syncTime();
  assert.equal(exchange.offset, 500);
});

function historySource(now) {
  return Array.from({ length: Math.floor(now / BAR_MS) + 1 }, (_, i) => [
    i * BAR_MS,
    "100",
    "102",
    "99",
    i === Math.floor(now / BAR_MS) ? "101" : "100",
    "10",
    (i + 1) * BAR_MS - 1,
  ]);
}
test("4h history bootstrap is single-flight, reuses bars and refreshes the last open bar on rollover", async () => {
  let clock = 2000 * BAR_MS + 1000;
  const sent = [],
    history = new FourHourHistory(
      async (_, limit, extra) => {
        sent.push({ limit, ...extra });
        return historySource(clock)
          .filter(
            (r) =>
              r[0] <= extra.endTime &&
              (extra.startTime == null || r[0] >= extra.startTime),
          )
          .slice(-limit);
      },
      () => clock,
    );
  const [a, b] = await Promise.all([history.get("TEST"), history.get("TEST")]);
  assert.deepEqual(a, historySource(clock).slice(-1500));
  assert.deepEqual(a, b);
  assert.equal(sent.length, 4);
  assert.equal(
    sent.reduce((sum, p) => sum + requestWeight("/fapi/v1/klines", p), 0),
    7,
  );
  a[0][4] = "MUTATED";
  await history.get("TEST", 3);
  assert.equal(sent.length, 4);
  assert.notEqual((await history.get("TEST"))[0][4], "MUTATED");
  clock += BAR_MS;
  assert.deepEqual(
    await history.get("TEST"),
    historySource(clock).slice(-1500),
  );
  assert.equal(sent.length, 5);
  assert.equal(sent.at(-1).limit, 2);
});

test("failed history loads do not cache incomplete pages or leave a stuck in-flight promise", async () => {
  const clock = 2000 * BAR_MS + 1000;
  let calls = 0,
    fail = true;
  const history = new FourHourHistory(
    async (_, limit, extra) => {
      calls++;
      if (fail && calls === 2) throw new Error("429");
      return historySource(clock)
        .filter((r) => r[0] <= extra.endTime)
        .slice(-limit);
    },
    () => clock,
  );
  await assert.rejects(history.get("TEST"), /429/);
  fail = false;
  assert.deepEqual(
    await history.get("TEST"),
    historySource(clock).slice(-1500),
  );
});

test("a 4h boundary crossed during a queued history load is refreshed before analysis", async () => {
  let clock = 2000 * BAR_MS + BAR_MS - 1,
    first = true;
  const history = new FourHourHistory(
    async (_, limit, extra) => {
      if (first) {
        first = false;
        clock += 1000;
      }
      return historySource(clock)
        .filter(
          (r) =>
            r[0] <= extra.endTime &&
            (extra.startTime == null || r[0] >= extra.startTime),
        )
        .slice(-limit);
    },
    () => clock,
  );
  assert.deepEqual(
    await history.get("TEST"),
    historySource(clock).slice(-1500),
  );
});

test("already-journaled 4h decisions do not poll the exchange for another probe", async () => {
  const now = 2000 * BAR_MS + 1000,
    prior = { decisionKey: "existing" },
    keys = [];
  const exchange = {
    offset: 0,
    async candles() {
      throw new Error("Unexpected REST poll");
    },
  };
  const journal = {
    async getDecisionForCandle(symbol, at) {
      keys.push({ symbol, at });
      return prior;
    },
  };
  assert.deepEqual(await loadDecisionInput(exchange, journal, "TEST", now), {
    prior,
  });
  assert.equal(keys[0].at, 2000 * BAR_MS - 1);
});

test("a new 4h decision loads history once and preserves initial LONG/SHORT analysis", async () => {
  const { fixture } = require("./test-fixtures.cjs"),
    { analyzeNineAI } = require("./nine-ai-pipeline");
  for (const side of ["LONG", "SHORT"]) {
    // Align exchange's last close exactly to a real 4h boundary.
    const boundary = Math.floor(Date.now() / BAR_MS) * BAR_MS;
    const f = fixture(side, boundary + 999),
      calls = [];
    const input = await loadDecisionInput(
      {
        offset: 0,
        async candles(symbol, interval, limit) {
          calls.push({ symbol, interval, limit });
          return f.candles4h;
        },
      },
      {
        async getDecisionForCandle() {
          return null;
        },
      },
      f.symbol,
      f.market.now,
    );
    assert.deepEqual(calls, [
      { symbol: f.symbol, interval: "4h", limit: HISTORY_4H_LIMIT },
    ]);
    assert.equal(input.probe.closeTime, f.candles4h.at(-1)[6]);
    const decision = analyzeNineAI({ ...f, outcomes: [], candles4h: input.h4 });
    assert.equal(decision.action, side);
    assert.equal(decision.tradePlan.outcomeMode, "AI2_INITIAL");
  }
});

test("WebSocket mark/book data reject stale, future, out-of-order and other-market events", () => {
  let now = 100000;
  const feed = new BinanceMarketFeed({ now: () => now, onStatus() {} });
  feed.ingest(
    "mark",
    JSON.stringify([
      { E: now, s: "TEST", p: "100", r: "0.0001", st: 1 },
      { E: now, s: "TEST", p: "999", r: "0.1", st: 2 },
    ]),
  );
  feed.ingest(
    "book",
    JSON.stringify({ data: { E: now, s: "TEST", b: "99", a: "101" } }),
  );
  assert.equal(feed.get("mark", "TEST").data.markPrice, "100");
  assert.equal(feed.get("book", "TEST").data.bidPrice, "99");
  feed.ingest(
    "mark",
    JSON.stringify({ E: now - 1, s: "TEST", p: "90", r: "0" }),
  );
  feed.ingest(
    "mark",
    JSON.stringify({ E: now + 1, s: "TEST", p: "900", r: "0" }),
  );
  assert.equal(feed.get("mark", "TEST").data.markPrice, "100");
  now += 16000;
  assert.equal(feed.get("mark", "TEST"), null);
  feed.ingest(
    "mark",
    JSON.stringify({ E: now - 20000, s: "OLD", p: "1", r: "0" }),
  );
  assert.equal(feed.get("mark", "OLD"), null);
});

test("WebSocket disconnect invalidates that stream and shutdown cancels reconnects", () => {
  const sockets = [],
    tasks = new Map();
  let seq = 0;
  class Socket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      sockets.push(this);
    }
    terminate() {
      this.readyState = 3;
      this.emit("close");
    }
    ping() {}
  }
  const timers = {
    setInterval(fn) {
      const id = ++seq;
      tasks.set(id, fn);
      return id;
    },
    clearInterval(id) {
      tasks.delete(id);
    },
    setTimeout(fn) {
      const id = ++seq;
      tasks.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
  };
  const feed = new BinanceMarketFeed({
    Socket,
    timers,
    now: () => 1000,
    onStatus() {},
  });
  feed.start();
  assert.deepEqual(
    sockets.map((s) => s.url),
    Object.values(URLS),
  );
  for (const socket of sockets) socket.emit("open");
  sockets[0].emit(
    "message",
    JSON.stringify([{ E: 1000, s: "TEST", p: "100", r: "0" }]),
  );
  assert.ok(feed.get("mark", "TEST"));
  sockets[0].terminate();
  assert.equal(feed.get("mark", "TEST"), null);
  const callbacks = [...tasks.values()];
  feed.stop();
  assert.equal(tasks.size, 0);
  for (const cb of callbacks) cb();
  assert.equal(sockets.length, 2);
});

test("market snapshots use live streams without REST mark/book polling or refreshed cache timestamps", async () => {
  const observedAt = Date.now() - 5000,
    routes = [],
    mark = {
      data: { markPrice: "100", lastFundingRate: "0.0001" },
      observedAt,
      latencyMs: 10,
      source: "WEBSOCKET",
    },
    book = {
      data: { bidPrice: "99", askPrice: "101" },
      observedAt,
      latencyMs: 10,
      source: "WEBSOCKET",
    };
  const exchange = new BinanceExchange({
    budget: { async acquire() {}, observe() {} },
    marketFeed: { get: (kind) => (kind === "mark" ? mark : book) },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      routes.push(path);
      if (path.endsWith("fundingInfo")) return response([]);
      if (path.endsWith("openInterestHist"))
        return response([
          { timestamp: Date.now() - BAR_MS, sumOpenInterest: "100" },
          { timestamp: Date.now() - 1, sumOpenInterest: "101" },
        ]);
      if (path.endsWith("depth"))
        return response({ bids: [[99, 100]], asks: [[101, 100]] });
      throw new Error("Unexpected REST route " + path);
    },
  });
  const a = await marketSnapshot(exchange, "TEST"),
    b = await marketSnapshot(exchange, "TEST");
  assert.equal(a.snapshotAt, observedAt);
  assert.equal(b.snapshotAt, observedAt);
  assert.equal(a.marketDataSources.funding, "WEBSOCKET");
  assert.equal(a.marketDataSources.book, "WEBSOCKET");
  assert.equal(routes.length, 3);
});
