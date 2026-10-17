"use strict";

const assert = require("assert");
const { shouldLogTpslHold, resetTpslHoldLogState, DEFAULT_REMINDER_INTERVAL_MS } = require("./tpsl-hold-log-deduper");

resetTpslHoldLogState();
assert.strictEqual(shouldLogTpslHold("LITUSDT", "LONG", "no safe RR<=1.8 plan", 1000), true, "first HOLD should log");
assert.strictEqual(shouldLogTpslHold("LITUSDT", "LONG", "no safe RR<=1.8 plan", 2000), false, "score changes should not matter to dedupe signature");
assert.strictEqual(shouldLogTpslHold("ZKUSDT", "WAIT", "no safe RR<=1.8 plan", 2000), true, "symbols should be tracked independently");
assert.strictEqual(shouldLogTpslHold("LITUSDT", "SHORT", "no safe RR<=1.8 plan", 3000), true, "side change should log");
assert.strictEqual(shouldLogTpslHold("LITUSDT", "SHORT", "different reason", 4000), true, "reason change should log");
assert.strictEqual(shouldLogTpslHold("LITUSDT", "SHORT", "different reason", 4000 + DEFAULT_REMINDER_INTERVAL_MS), true, "periodic reminder should log");
assert.strictEqual(shouldLogTpslHold("LITUSDT", "SHORT", "different reason", 4001 + DEFAULT_REMINDER_INTERVAL_MS), false, "reminder should also be rate limited");
resetTpslHoldLogState();
assert.strictEqual(shouldLogTpslHold("LITUSDT", "LONG", "reason", 1), true, "reset should clear state");
console.log("tpsl-hold-log-deduper tests passed");
