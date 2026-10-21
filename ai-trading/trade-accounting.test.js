"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const {
  summarizeClosedTrade,
  getTradeActualRisk,
} = require("./trade-accounting");
const t = {
  symbol: "TEST",
  side: "LONG",
  enteredAt: 10000,
  entryExecution: { orderId: "1", orderTime: 10000, plannedEntry: 100 },
  actualQuantity: 2,
  initialRisk: 1,
  risk: 7.5,
};
const rows = [
  {
    id: 1,
    symbol: "TEST",
    orderId: 1,
    time: 10000,
    side: "BUY",
    qty: "2",
    price: "100",
    commission: ".1",
    commissionAsset: "USDT",
    realizedPnl: "0",
  },
  {
    id: 2,
    symbol: "TEST",
    orderId: 2,
    time: 20000,
    side: "SELL",
    qty: "1",
    price: "102",
    commission: ".05",
    commissionAsset: "USDT",
    realizedPnl: "2",
  },
  {
    id: 3,
    symbol: "TEST",
    orderId: 3,
    time: 30000,
    side: "SELL",
    qty: "1",
    price: "104",
    commission: ".05",
    commissionAsset: "USDT",
    realizedPnl: "4",
  },
];
test("TP1 + TP2 reconciles all fills, fees and funding once, excluding later trades", () => {
  const funding = {
    symbol: "TEST",
    tranId: 1,
    time: 15000,
    asset: "USDT",
    income: "-.2",
  };
  const result = summarizeClosedTrade(
    t,
    [
      ...rows,
      rows[1],
      { ...rows[0], id: 4, orderId: 4, time: 40000, commission: "1000" },
    ],
    [funding, funding, { ...funding, time: 40000, income: "-100" }],
  );
  assert.equal(result.accountingComplete, true);
  assert.equal(result.grossRealizedPnl, 6);
  assert.ok(Math.abs(result.pnl - 5.6) < 1e-10);
  assert.equal(result.executionFillCount, 3);
  assert.equal(result.exitPrice, 103);
  assert.equal(result.exitQty, 2);
  assert.equal(getTradeActualRisk(t), 2);
});
test("missing/truncated exits or entry fills cannot produce realized PnL", () => {
  assert.equal(summarizeClosedTrade(t, rows.slice(0, 2), []), null);
  assert.equal(summarizeClosedTrade(t, rows.slice(1), []), null);
  assert.equal(summarizeClosedTrade(t, rows, null).pnl, null);
  const bnb = rows.map((f) => ({ ...f, commissionAsset: "BNB" }));
  assert.equal(summarizeClosedTrade(t, bnb, []).accountingComplete, false);
  assert.equal(
    summarizeClosedTrade(
      t,
      bnb.map((f) => ({ ...f, commissionUSDT: Number(f.commission) * 500 })),
      [],
    ).feesUSDT,
    100,
  );
});
