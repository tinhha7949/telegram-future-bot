"use strict";

const { CONFIG } = require("./config");

const TRANSIENT_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoPoolClearedError",
]);
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

function isTransientMongoConnectError(error) {
  for (let current = error; current; current = current.cause) {
    if (TRANSIENT_NAMES.has(current.name) || TRANSIENT_CODES.has(current.code))
      return true;
  }
  return false;
}

function retryDelay(attempt, config = CONFIG) {
  const exponent = Math.min(Math.max(0, attempt - 1), config.MONGO_CONNECT_RETRY_EXPONENT_CAP);
  return Math.min(
    config.MONGO_CONNECT_RETRY_MAX_MS,
    config.MONGO_CONNECT_RETRY_BASE_MS * (2 ** exponent),
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectMongoWithRetry({
  createClient,
  onClient = () => {},
  wait = sleep,
  isStopped = () => false,
  onRetry = () => {},
  config = CONFIG,
}) {
  if (typeof createClient !== "function") throw new Error("MONGO_CLIENT_FACTORY_REQUIRED");
  let attempt = 0;
  while (!isStopped()) {
    const client = createClient();
    onClient(client);
    try {
      await client.connect();
      if (isStopped()) {
        await client.close().catch(() => {});
        return null;
      }
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (isStopped()) return null;
      if (!isTransientMongoConnectError(error)) throw error;
      attempt += 1;
      const delayMs = retryDelay(attempt, config);
      onRetry(error, { attempt, delayMs });
      await wait(delayMs);
    }
  }
  return null;
}

module.exports = { connectMongoWithRetry, isTransientMongoConnectError, retryDelay };
