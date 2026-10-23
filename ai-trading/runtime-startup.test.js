"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { scanPauseReason } = require("../index");

test("runtime pause is exclusive to unexpected async faults, not risk WAIT", () => {
  assert.equal(scanPauseReason({}), null);
  assert.equal(scanPauseReason({ runtimeFault: false, uncertain: false, untracked: 0 }), null);
  assert.equal(scanPauseReason({ uncertain: true }), "POSITION_STATE_UNCERTAIN");
  assert.equal(scanPauseReason({ untracked: 1 }), "UNTRACKED_EXCHANGE_POSITION");
  assert.equal(scanPauseReason({ runtimeFault: true }), "RUNTIME_ERROR");
  assert.equal(scanPauseReason({ runtimeFault: true, uncertain: true }), "RUNTIME_ERROR");
});
