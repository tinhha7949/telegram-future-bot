"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateMargin, calculateRawQuantity } = require("../src/risk");
test("margin uses only total wallet balance percentage", () => {
  const risk = { walletPercentPerTrade: 10, maxMarginPerTradeUsdt: 0, minMarginPerTradeUsdt: 0 };
  assert.equal(calculateMargin(10, risk), 1);
  assert.equal(calculateMargin(25, risk), 2.5);
  assert.equal(calculateMargin(100, risk), 10);
});
test("margin cap is applied without changing wallet percentage base", () => {
  const risk = { walletPercentPerTrade: 20, maxMarginPerTradeUsdt: 3, minMarginPerTradeUsdt: 0 };
  assert.equal(calculateMargin(100, risk), 3);
});
test("leverage converts margin allocation into notional quantity", () => {
  assert.equal(calculateRawQuantity(1, 20, 100), .2);
});
test("invalid wallet balance is rejected", () => {
  assert.throws(() => calculateMargin(0, { walletPercentPerTrade: 10 }), /Wallet balance/);
});
