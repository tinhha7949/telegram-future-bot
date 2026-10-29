"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG } = require("./config");
const { initialStructurePlan } = require("./initial-structure-plan");

test("AI-7 cold start uses 1.5 ATR stop and configured fallback TP2 R", () => {
  const entry = 100;
  const atr = 2;
  const plan = initialStructurePlan({
    side: "LONG",
    entry,
    atr,
    highs: [],
    lows: [],
    support: 95,
    resistance: 105,
    channel: { upper: { price: 106 }, lower: { price: 94 } },
    rangeHigh: 105,
    rangeLow: 95,
  });
  const stopDistance = CONFIG.AI7_ATR_MULTIPLIER * atr;
  assert.equal(plan.sl, entry - stopDistance);
  assert.equal(plan.tp1, entry + Math.max(CONFIG.MIN_RR * stopDistance, 6));
  assert.equal(plan.tp2, entry + Math.max(CONFIG.FALLBACK_TP2_R * stopDistance, plan.tp1 - entry));
  assert.equal(plan.closePercentAtTP1, 60);
  assert.equal(plan.timeoutCandles, CONFIG.TIMEOUT_BARS);
});
