"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CONFIG, parseConfig } = require("./config");

const original = fs.readFileSync(path.join(__dirname, "..", "CONFIG.yaml"), "utf8");
function edit(name, value) {
  const line = new RegExp("^" + name + ": [^\\n]*$", "m");
  assert.match(original, line, "test fixture key missing: " + name);
  return original.replace(line, name + ": " + value);
}

test("all operational settings load from YAML with strict default values", () => {
  assert.equal(CONFIG.BINANCE_HTTP_TIMEOUT_MS, 15000);
  assert.equal(CONFIG.BINANCE_HTTP_GET_ATTEMPTS, 2);
  assert.equal(CONFIG.BINANCE_RECV_WINDOW_MS, 10000);
  assert.equal(CONFIG.MARKET_WS_STALE_MS, 90000);
  assert.equal(CONFIG.TELEGRAM_DELIVERY_TIMEOUT_MS, 10000);
  assert.equal(CONFIG.JOURNAL_WRITE_MAX_ATTEMPTS, 3);
  assert.equal(CONFIG.RETENTION_ENABLE_DELETE, true);
  assert.equal(CONFIG.RETENTION_DRY_RUN, false);
  assert.ok(Object.isFrozen(CONFIG));
  assert.ok(Object.isFrozen(CONFIG.TP_BATCHES));
});

test("safe operational parameters can be changed in YAML without modifying code", () => {
  assert.equal(parseConfig(edit("BINANCE_HTTP_GET_ATTEMPTS", "4")).BINANCE_HTTP_GET_ATTEMPTS, 4);
  assert.equal(parseConfig(edit("MARKET_WS_HEARTBEAT_MS", "20000")).MARKET_WS_HEARTBEAT_MS, 20000);
  assert.equal(parseConfig(edit("JOURNAL_WRITE_MAX_ATTEMPTS", "5")).JOURNAL_WRITE_MAX_ATTEMPTS, 5);
  assert.equal(parseConfig(edit("RETENTION_ENABLE_DELETE", "false")).RETENTION_ENABLE_DELETE, false);
  assert.equal(parseConfig(edit("RETENTION_DRY_RUN", "true")).RETENTION_DRY_RUN, true);
});

test("invalid booleans and unsafe operational values abort startup, never silently clamp", () => {
  for (const [name, value, reason] of [
    ["RETENTION_ENABLE_DELETE", "yes", /CONFIG_INVALID_BOOLEAN_RETENTION_ENABLE_DELETE/],
    ["RETENTION_DRY_RUN", "1", /CONFIG_INVALID_BOOLEAN_RETENTION_DRY_RUN/],
    ["BINANCE_HTTP_GET_ATTEMPTS", "0", /CONFIG_INVALID_NUMBER_BINANCE_HTTP_GET_ATTEMPTS/],
    ["BINANCE_HTTP_GET_ATTEMPTS", "100", /CONFIG_UNSAFE_OPERATIONAL_VALUE_BINANCE_HTTP_GET_ATTEMPTS/],
    ["BINANCE_RECV_WINDOW_MS", "120000", /CONFIG_UNSAFE_OPERATIONAL_VALUE_BINANCE_RECV_WINDOW_MS/],
    ["BINANCE_REQUEST_WEIGHT_LIMIT", "9999", /CONFIG_UNSAFE_OPERATIONAL_VALUE_BINANCE_REQUEST_WEIGHT_LIMIT/],
    ["BINANCE_BACKGROUND_BUDGET_RATIO", "0.99", /CONFIG_UNSAFE_OPERATIONAL_VALUE_BINANCE_BACKGROUND_BUDGET_RATIO/],
    ["MARKET_WS_RECONNECT_EXPONENT_CAP", "500", /CONFIG_UNSAFE_OPERATIONAL_VALUE_MARKET_WS_RECONNECT_EXPONENT_CAP/],
    ["TELEGRAM_DELIVERY_RETRY_MAX_MS", "300", /CONFIG_UNSAFE_OPERATIONAL_VALUE_TELEGRAM_DELIVERY_RETRY_MAX_MS/],
    ["JOURNAL_MAX_RECORDS", "10", /CONFIG_UNSAFE_OPERATIONAL_VALUE_JOURNAL_MAX_RECORDS/],
    ["JOURNAL_WRITE_MAX_ATTEMPTS", "2.5", /CONFIG_NOT_INTEGER_JOURNAL_WRITE_MAX_ATTEMPTS/],
  ]) assert.throws(() => parseConfig(edit(name, value)), reason, name);
});

test("cross-field contradictions abort before any API connections", () => {
  assert.throws(
    () => parseConfig(edit("MARKET_WS_HEARTBEAT_MS", "90000")),
    /CONFIG_UNSAFE_OPERATIONAL_VALUE_MARKET_WS_HEARTBEAT_MS/,
  );
  assert.throws(
    () => parseConfig(edit("MARKET_WS_STALE_MS", "20000")),
    /CONFIG_CROSS_FIELD_INVARIANT/,
  );
  assert.throws(
    () => parseConfig(edit("MARKET_WS_RECONNECT_BASE_MS", "30000")),
    /CONFIG_CROSS_FIELD_INVARIANT/,
  );
  assert.throws(
    () => parseConfig(edit("TELEGRAM_DELIVERY_RETRY_BASE_MS", "350000")),
    /CONFIG_UNSAFE_OPERATIONAL_VALUE_TELEGRAM_DELIVERY_RETRY_BASE_MS/,
  );
  assert.throws(() => parseConfig(original + "\\nUNKNOWN_SETTING: 1\\n"), /CONFIG_UNEXPECTED_OR_DUPLICATE_UNKNOWN_SETTING/);
  assert.throws(() => parseConfig(original.replace("BINANCE_HTTP_TIMEOUT_MS: 15000\\n", "")), /CONFIG_MISSING_BINANCE_HTTP_TIMEOUT_MS/);
});
