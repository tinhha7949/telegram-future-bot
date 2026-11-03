"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { cooldownUntilForTrade, cooldownRecordForClose, isCoolingDown } = require("./coin-cooldown");

test("cooldown expires the configured number of minutes after close", () => {
  const closedAt = new Date("2026-11-03T00:00:00.000Z");
  assert.equal(cooldownUntilForTrade(closedAt, 30).toISOString(), "2026-11-03T00:30:00.000Z");
});

test("zero or invalid cooldown disables the lock", () => {
  assert.equal(cooldownUntilForTrade(new Date(), 0), null);
  assert.equal(cooldownUntilForTrade("invalid", 30), null);
});

test("symbol stays locked until expiry and is available at expiry", () => {
  const until = new Date("2026-11-03T00:30:00.000Z");
  assert.equal(isCoolingDown({ until }, new Date("2026-11-03T00:29:59.999Z")), true);
  assert.equal(isCoolingDown({ until }, until), false);
});

test("missing or malformed cooldown data does not block a symbol", () => {
  assert.equal(isCoolingDown(null), false);
  assert.equal(isCoolingDown({ until: "invalid" }), false);
});

test("close detection creates a pending cooldown before WIN/LOSS is known", () => {
  const closedAt = new Date("2026-11-03T00:00:00.000Z");
  assert.deepEqual(cooldownRecordForClose(closedAt, 30), {
    until: new Date("2026-11-03T00:30:00.000Z"),
    closedAt,
    result: "PENDING"
  });
});
