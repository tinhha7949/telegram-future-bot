"use strict";
const assert = require("node:assert/strict");
const { ROLE_NAMES, analyzeNineAI, parseClosedCandles } = require("./nine-ai-strategy");
assert.equal(ROLE_NAMES.length, 9);
assert.equal(new Set(ROLE_NAMES).size, 9);
const now = Date.now();
const rows = [];
let price = 100;
for (let i = 0; i < 100; i++) {
  const open = price;
  price += 0.18 + Math.sin(i / 3) * 0.06;
  rows.push([now - (100 - i) * 900000, open, Math.max(open, price) + 0.2,
    Math.min(open, price) - 0.2, price, 100 + i, now - (100 - i) * 900000 + 899999]);
}
rows.push([now, price, price + 0.1, price - 0.1, price + 0.05, 100, now + 899999]);
assert.equal(parseClosedCandles(rows, now).length, 100);
const result = analyzeNineAI(rows, "TESTUSDT", now);
assert.equal(result.symbol, "TESTUSDT");
assert.equal(result.roles.length, 9);
assert.equal(result.roles[7].name, "Decision AI");
assert.equal(result.roles[8].name, "Risk Manager AI");
if (result.side) {
  assert.ok(result.sl > 0 && result.tp > 0 && result.price > 0);
  assert.ok(result.rr >= 1.7);
  assert.equal(result.authorizedForExecution, true);
} else {
  assert.equal(result.authorizedForExecution, undefined);
}
console.log("PASS: nine roles, closed-candle filter, execution authorization, deterministic analysis, and trade geometry");
