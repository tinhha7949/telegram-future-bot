"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  connectMongoWithRetry,
  isTransientMongoConnectError,
  retryDelay,
  retryMongoOperation,
} = require("./mongo-connect");

const config = {
  MONGO_CONNECT_RETRY_BASE_MS: 100,
  MONGO_CONNECT_RETRY_MAX_MS: 250,
  MONGO_CONNECT_RETRY_EXPONENT_CAP: 2,
};

test("retries transient Mongo network timeouts and reconnects with a fresh client", async () => {
  let creates = 0;
  const closed = [];
  const delays = [];
  const retries = [];
  const client = () => {
    const id = ++creates;
    return {
      async connect() {
        if (id === 1) throw Object.assign(new Error("timed out"), {
          name: "MongoNetworkTimeoutError",
          code: "ETIMEDOUT",
        });
      },
      async close() { closed.push(id); },
      id,
    };
  };
  const connected = await connectMongoWithRetry({
    createClient: client,
    config,
    wait: async (ms) => delays.push(ms),
    onRetry: (_error, info) => retries.push(info),
  });
  assert.equal(connected.id, 2);
  assert.deepEqual(closed, [1]);
  assert.deepEqual(delays, [100]);
  assert.deepEqual(retries, [{ attempt: 1, delayMs: 100 }]);
});

test("does not retry permanent Mongo errors", async () => {
  let creates = 0;
  const authError = Object.assign(new Error("bad credentials"), {
    name: "MongoServerError",
    code: 18,
  });
  await assert.rejects(connectMongoWithRetry({
    createClient: () => ({
      async connect() { creates += 1; throw authError; },
      async close() {},
    }),
    config,
    wait: async () => assert.fail("must not wait"),
  }), authError);
  assert.equal(creates, 1);
});

test("uses capped exponential retry delays", () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelay(n, config)), [100, 200, 250, 250]);
  assert.equal(isTransientMongoConnectError({ name: "MongoNetworkTimeoutError" }), true);
  assert.equal(isTransientMongoConnectError({ name: "MongoServerError", code: 18 }), false);
});

test("stops retrying when shutdown happens during the wait", async () => {
  let creates = 0;
  let stopped = false;
  const result = await connectMongoWithRetry({
    createClient: () => {
      creates += 1;
      return {
        async connect() { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); },
        async close() {},
      };
    },
    config,
    isStopped: () => stopped,
    wait: async () => { stopped = true; },
  });
  assert.equal(result, null);
  assert.equal(creates, 1);
});

test("retries transient startup database operations after connect", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryMongoOperation(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("connection timed out"), {
      name: "MongoNetworkTimeoutError",
    });
    return "ready";
  }, {
    label: "PING",
    config,
    wait: async (ms) => delays.push(ms),
  });
  assert.equal(result, "ready");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]);
});

test("retries failed ping before returning a connected MongoClient", async () => {
  let pings = 0;
  let creates = 0;
  const result = await connectMongoWithRetry({
    createClient: () => {
      const id = ++creates;
      return {
        async connect() {},
        async close() {},
        async db() {
          return { command: async () => {
            pings += 1;
            if (pings === 1) throw Object.assign(new Error("connection timed out"), {
              name: "MongoNetworkTimeoutError",
            });
          }};
        },
        id,
      };
    },
    verifyClient: async (client) => client.db().then((db) => db.command({ ping: 1 })),
    config,
    wait: async () => {},
  });
  assert.equal(result.id, 2);
  assert.equal(pings, 2);
});
