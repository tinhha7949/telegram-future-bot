"use strict";

const assert = require("node:assert/strict");
const { TpslLogThrottle } = require("./tpsl-log-throttle");

const throttle = new TpslLogThrottle();
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:LONG", "NO_SAFE_RR_PLAN"), true);
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:LONG", "NO_SAFE_RR_PLAN"), false,
  "same symbol/state/reason must not repeat");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:SHORT", "NO_SAFE_RR_PLAN"), true,
  "a state change must be logged");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:SHORT", "PLAN_INVALID"), true,
  "a reason change must be logged");
throttle.clear("LITUSDT");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:SHORT", "NO_SAFE_RR_PLAN"), true,
  "a cleared state must be logged if it recurs");
assert.equal(throttle.shouldLog("", "ANY", "ANY"), true, "unknown symbols should not be silently hidden");

const bounded = new TpslLogThrottle(2);
bounded.shouldLog("A", "HOLD", "R");
bounded.shouldLog("B", "HOLD", "R");
bounded.shouldLog("C", "HOLD", "R");
assert.equal(bounded.lastBySymbol.size, 2, "state map must remain bounded");

console.log("PASS: TPSL HOLD log throttle");
