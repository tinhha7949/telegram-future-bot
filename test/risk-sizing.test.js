"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTradeSizing } = require("../src/risk");

const filters = {
  marketStepSize: 0.001,
  marketMinQty: 0.001,
  lotStepSize: 0.001,
  lotMinQty: 0.001,
  minNotional: 5
};
const risk = {
  walletPercentPerTrade: 5,
  maxMarginPerTradeUsdt: 0,
  minMarginPerTradeUsdt: 0
};
function size(overrides = {}) {
  return calculateTradeSizing({
    walletBalance: 7,
    availableBalance: 7,
    risk,
    leverage: 20,
    entryPrice: 100,
    tp1Price: 105,
    tp1ClosePct: 60,
    filters,
    ...overrides
  });
}

test("small wallet is uplifted only enough to satisfy rounded TP1 minNotional", () => {
  const result = size();
  assert.equal(result.adjusted, true);
  assert.ok(result.margin > 0.35);
  assert.ok(result.marketQty * 100 >= 5);
  assert.ok(result.tp1Qty * 105 >= 5);
  assert.ok(result.tp1Qty < result.marketQty);
  assert.ok(result.margin < 0.41);
});

test("larger wallet keeps the exact configured percentage margin", () => {
  const result = size({ walletBalance: 100, availableBalance: 100 });
  assert.equal(result.adjusted, false);
  assert.equal(result.margin, 5);
  assert.equal(result.marketQty, 1);
  assert.equal(result.tp1Qty, 0.6);
});

test("rounds TP1 quantity using LOT_SIZE rather than MARKET_LOT_SIZE", () => {
  const result = size({
    filters: { ...filters, lotStepSize: 0.01, lotMinQty: 0.01 }
  });
  assert.equal(result.adjusted, true);
  assert.equal(result.tp1Qty, 0.05);
  assert.ok(result.tp1Qty * 105 >= 5);
});

test("short-side lower TP1 price is included in minimum sizing", () => {
  const result = size({ tp1Price: 95 });
  assert.equal(result.adjusted, true);
  assert.ok(result.tp1Qty * 95 >= 5);
});

test("does not exceed maxMarginPerTradeUsdt when uplift is needed", () => {
  assert.throws(
    () => size({ risk: { ...risk, maxMarginPerTradeUsdt: 0.38 } }),
    /ENTRY_REJECTED_TP1_MIN_NOTIONAL_MARGIN_CAP/
  );
});

test("does not uplift beyond available balance", () => {
  assert.throws(
    () => size({ availableBalance: 0.39 }),
    /ENTRY_REJECTED_TP1_MIN_NOTIONAL_INSUFFICIENT_BALANCE/
  );
});

test("supports Binance quantity steps represented in scientific notation", () => {
  const result = calculateTradeSizing({
    walletBalance: 100,
    availableBalance: 100,
    risk,
    leverage: 20,
    entryPrice: 100000000,
    tp1Price: 105000000,
    tp1ClosePct: 60,
    filters: {
      marketStepSize: 1e-8, marketMinQty: 1e-8,
      lotStepSize: 1e-8, lotMinQty: 1e-8,
      minNotional: 5
    }
  });
  assert.equal(result.adjusted, false);
  assert.ok(result.marketQty > 0);
  assert.ok(result.tp1Qty > 0);
});
