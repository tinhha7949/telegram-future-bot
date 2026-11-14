"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { localParts } = require("../src/scheduler");

test("scheduler converts timestamps using the configured Vietnam timezone", () => {
  const parts = localParts(new Date("2026-11-14T00:00:00.000Z"), "Asia/Ho_Chi_Minh");
  assert.equal(parts.year, "2026");
  assert.equal(parts.month, "11");
  assert.equal(parts.day, "14");
  assert.equal(parts.hour, "07");
  assert.equal(parts.minute, "00");
});
