"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { memoryDb } = require("./test-fixtures.cjs");
const { TelegramNotifications } = require("./telegram-notifications");
const trade = { signalKey: "TESTUSDT:1", symbol: "TESTUSDT", side: "LONG",
  actualQuantity: 2, tp1Quantity: 1.2, tp2Quantity: 0.8, entry: 100, sl: 99, tp1: 102, tp2: 104,
  tradePlan: { outcomeMode: "AI7_LABELED" } };
function harness(env = { BOT_TOKEN: "fake-primary", CHAT_ID: "chat1",
  BOT_TOKEN_2: "fake-secondary", AI_CHAT_ID: "chat2" }) {
  const db = memoryDb(), calls = [], logs = [];
  let now = 1000;
  const create = (fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  }) => new TelegramNotifications({ db, env, fetchImpl, now: () => now,
    log: { error: (...args) => logs.push(args) } });
  return { db, calls, logs, create, advance: (ms) => { now += ms; },
    rows: db.collection("telegram_notification_outbox").rows };
}
test("confirmed entry goes to Telegram 1; WIN/LOSS goes to Telegram 2", async () => {
  const h = harness(), n = h.create();
  await n.initialize();
  await n.entry(trade);
  await n.report("TEST WIN", { eventKey: "CLOSED:TESTUSDT:1" });
  assert.equal(h.calls.length, 0, "enqueue does not wait on Telegram");
  await n.flush();
  assert.match(h.calls[0].url, /fake-primary\/sendMessage$/);
  assert.equal(h.calls[0].body.chat_id, "chat1");
  assert.match(h.calls[0].body.text, /chốt 60% \(1\.2\)/);
  assert.match(h.calls[0].body.text, /phần còn lại \(0\.8\)/);
  assert.match(h.calls[0].body.text, /Entry: 100/);
  assert.match(h.calls[0].body.text, /AI7 MAE\/MFE/);
  assert.match(h.calls[1].url, /fake-secondary\/sendMessage$/);
  assert.equal(h.calls[1].body.chat_id, "chat2");
  assert.ok(h.rows.every((r) => r.status === "SENT"));
  assert.ok(h.rows.every((r) => r.sentAt instanceof Date));
  assert.doesNotMatch(JSON.stringify(h.rows), /fake-primary|fake-secondary/);
});
test("duplicate events and restart do not resend a confirmed notification", async () => {
  const h = harness();
  let n = h.create();
  await n.initialize();
  await n.entry(trade);
  await n.entry(trade);
  n = h.create();
  await n.initialize();
  await n.flush();
  await n.entry(trade);
  h.advance(86400000 * 10);
  n = h.create();
  await n.flush();
  assert.equal(h.rows.length, 1);
  assert.equal(h.calls.length, 1);
});
test("429 honors retry_after across restart while the other destination still sends", async () => {
  const h = harness();
  const n = h.create(async (url) => url.includes("fake-primary")
    ? { ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 60 } }) }
    : { ok: true, json: async () => ({ ok: true }) });
  await n.entry(trade);
  await n.report("WIN", { eventKey: "CLOSED:TESTUSDT:1" });
  await n.flush();
  assert.equal(h.rows[0].status, "PENDING");
  assert.equal(h.rows[0].nextAttemptAt, 61000);
  assert.equal(h.rows[1].status, "SENT");
  const restarted = h.create();
  await restarted.flush();
  assert.equal(h.calls.length, 0);
  h.advance(60000);
  await restarted.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.rows[0].status, "SENT");
});
test("network failures stay pending, redact tokens and retry after the backoff", async () => {
  const h = harness(), n = h.create(async () => { throw new Error("secret fake-primary URL"); });
  await n.entry(trade);
  await n.flush();
  assert.equal(h.rows[0].status, "PENDING");
  assert.equal(h.rows[0].attempts, 1);
  assert.equal(h.rows[0].nextAttemptAt, 3000);
  assert.doesNotMatch(JSON.stringify(h.logs), /fake-primary|secret/);
  h.advance(2000);
  await h.create().flush();
  assert.equal(h.rows[0].status, "SENT");
});
test("missing Telegram 1 configuration retains entry without redirecting it to Telegram 2", async () => {
  const h = harness({ BOT_TOKEN_2: "fake-secondary", AI_CHAT_ID: "chat2" }), n = h.create();
  await n.entry(trade);
  await n.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.rows[0].lastError, "MISSING_DESTINATION");
  assert.equal(h.rows[0].status, "PENDING");
});
test("secondary destination keeps the existing fallback to primary", async () => {
  const h = harness({ BOT_TOKEN: "fake-primary", CHAT_ID: "chat1" }), n = h.create();
  await n.report("LOSS", { eventKey: "CLOSED:x" });
  await n.flush();
  assert.equal(h.calls[0].body.chat_id, "chat1");
  assert.match(h.calls[0].url, /fake-primary/);
});
test("API rejection is not silently marked delivered or retried in a tight loop", async () => {
  const h = harness();
  let attempts = 0;
  const n = h.create(async () => {
    attempts++;
    return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403 }) };
  });
  await n.entry(trade);
  await n.flush();
  await n.flush();
  assert.equal(attempts, 1);
  assert.equal(h.rows[0].status, "PENDING");
  assert.equal(h.rows[0].nextAttemptAt, 3601000);
});
test("one in-flight sender and shutdown cannot drain duplicate batches", async () => {
  const h = harness();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let attempts = 0;
  const n = h.create(async (_, { signal }) => {
    attempts++;
    ready();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  await n.entry(trade);
  const sending = n.flush();
  await started;
  await n.flush();
  n.stop();
  await sending;
  await n.flush();
  assert.equal(attempts, 1);
  assert.equal(h.rows[0].status, "PENDING");
});
test("retention index expires sent rows only, not pending notifications", async () => {
  const h = harness(), indexes = [];
  h.db.collection("telegram_notification_outbox").createIndex = async (key, options) => indexes.push({ key, options });
  await h.create().initialize();
  const ttl = indexes.filter((x) => x.options.expireAfterSeconds);
  assert.deepEqual(ttl.map((x) => x.key), [{ sentAt: 1 }]);
  await h.create().entry(trade);
  assert.equal(h.rows[0].sentAt, undefined);
});
