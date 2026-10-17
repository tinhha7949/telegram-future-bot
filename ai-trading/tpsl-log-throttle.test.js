"use strict";

const assert = require("node:assert/strict");
const { TpslLogThrottle } = require("./tpsl-log-throttle");

const throttle = new TpslLogThrottle(2000, 15 * 60 * 1000);
const start = 1_000_000;

assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:LONG", "NO_SAFE_RR_PLAN", start), true);
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:LONG", "NO_SAFE_RR_PLAN", start + 10_000), false,
  "same HOLD state must not repeat");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:WAIT", "NO_SAFE_RR_PLAN", start + 20_000), false,
  "side/state oscillation must not spam within the cooldown");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:WAIT", "PLAN_INVALID", start + 30_000), false,
  "reason changes must also be rate-limited within the cooldown");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:WAIT", "PLAN_INVALID", start + 15 * 60 * 1000), true,
  "after cooldown, a changed state can be logged once");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:WAIT", "PLAN_INVALID", start + 16 * 60 * 1000), false,
  "the same state must not repeat after cooldown");
assert.equal(throttle.shouldLog("ZKUSDT", "HOLD_NO_SAFE_RR:WAIT", "NO_SAFE_RR_PLAN", start + 16 * 60 * 1000), true,
  "different symbols are throttled independently");

throttle.clear("LITUSDT");
assert.equal(throttle.shouldLog("LITUSDT", "HOLD_NO_SAFE_RR:WAIT", "NO_SAFE_RR_PLAN", start + 16 * 60 * 1000), true,
  "a cleared state must be logged if it recurs");
assert.equal(throttle.shouldLog("", "ANY", "ANY", start), true, "unknown symbols should not be silently hidden");

const bounded = new TpslLogThrottle(2, 15 * 60 * 1000);
bounded.shouldLog("A", "HOLD", "R", start);
bounded.shouldLog("B", "HOLD", "R", start);
bounded.shouldLog("C", "HOLD", "R", start);
assert.equal(bounded.lastBySymbol.size, 2, "state map must remain bounded");

console.log("PASS: TPSL HOLD log throttle");
