"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Telegram } = require("../src/telegram");

test("Telegram retries rate limits and sends the message after the cooldown", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok:false,
        status:429,
        text:async () => JSON.stringify({
          ok:false,
          description:"Too Many Requests",
          parameters:{ retry_after:0 }
        })
      };
    }
    return { ok:true, status:200, text:async () => JSON.stringify({ ok:true }) };
  };

  const telegram = new Telegram({ requestTimeoutMs:1000 });
  telegram.token = "test-token";
  telegram.chatId = "test-chat";
  await telegram.send("test message");
  assert.equal(calls, 2);
});

test("Telegram does not retry permanent client errors", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok:false,
      status:400,
      text:async () => JSON.stringify({ ok:false, description:"Bad Request" })
    };
  };

  const telegram = new Telegram({ requestTimeoutMs:1000 });
  telegram.token = "test-token";
  telegram.chatId = "test-chat";
  await assert.rejects(telegram.send("test message"), /Bad Request/);
  assert.equal(calls, 1);
});
