"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requestJson } = require("../src/http");

test("requestJson retries HTTP 429 and succeeds on the next attempt", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok:false,
        status:429,
        headers:{ get:() => "0" }
      };
    }
    return { ok:true, json:async () => ({ success:true }) };
  };

  const result = await requestJson("https://example.test/data", 1000, {}, {
    retries:1,
    retryBaseMs:250
  });
  assert.deepEqual(result, { success:true });
  assert.equal(calls, 2);
});

test("requestJson reports an explicit timeout instead of a generic abort", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once:true });
  });

  await assert.rejects(
    requestJson("https://example.test/slow", 5, {}, { retries:0 }),
    /Request timeout after 5ms/
  );
});

test("requestJson does not retry permanent HTTP 404 errors", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok:false, status:404, headers:{ get:() => null } };
  };

  await assert.rejects(
    requestJson("https://example.test/missing", 1000, {}, { retries:2 }),
    /HTTP 404/
  );
  assert.equal(calls, 1);
});

test("requestJson can hand HTTP 429 to a provider cooldown without retrying", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok:false,
      status:429,
      headers:{ get:() => "300" }
    };
  };

  await assert.rejects(
    requestJson("https://example.test/rate-limited", 1000, {}, {
      retries:2,
      retryOnRateLimit:false
    }),
    error => error.status === 429 && error.retryAfterMs === 300000
  );
  assert.equal(calls, 1);
});

test("requestJson exposes the underlying network cause for fetch failed", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    const cause = new Error("connection reset by peer");
    cause.code = "ECONNRESET";
    throw new TypeError("fetch failed", { cause });
  };

  await assert.rejects(
    requestJson("https://api.gdeltproject.org/api/v2/doc/doc", 1000, {}, { retries:1, retryBaseMs:250 }),
    error => error.name === "TypeError" && /api\\.gdeltproject\\.org/.test(error.message) && /ECONNRESET/.test(error.message)
  );
  assert.equal(calls, 2);
});
