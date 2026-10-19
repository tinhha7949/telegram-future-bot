"use strict";
const assert = require("node:assert/strict");
const { summarizeClosedTrade } = require("./nine-ai-execution-ledger");

const trade = { side: "LONG", enteredAt: 100 };
const fills = [
  { id: 1, orderId: 10, time: 101, price: "100", qty: "2", buyer: true,
    realizedPnl: "0", commission: "0.04", commissionAsset: "USDT" },
  { id: 2, orderId: 11, time: 200, price: "101", qty: "2", buyer: false,
    realizedPnl: "0", commission: "0.05", commissionAsset: "USDT" }
];
const result = summarizeClosedTrade(trade, fills, [
  { tranId: 99, symbol: "TESTUSDT", time: 180, income: "0.25", asset: "USDT" }
]);
assert.equal(result.grossRealizedPnl, 0);
assert.equal(result.pnl, 0.16);
assert.equal(result.exitQty, 2);
assert.equal(result.exitPrice, 101);
assert.equal(result.executionFillCount, 2);
assert.deepEqual(result.exitOrderIds, ["11"]);
assert.equal(result.fundingIncluded, true);
assert.equal(result.fundingUSDT, 0.25);
assert.equal(result.fundingEntries[0].transactionId, "99");
assert.equal(summarizeClosedTrade({ side: "LONG", enteredAt: 300 }, fills), null);

const bnbFee = summarizeClosedTrade(trade, [
  { id: 3, orderId: 12, time: 301, price: "100", qty: "1", buyer: false,
    realizedPnl: "2", commission: "0.001", commissionAsset: "BNB" }
]);
assert.equal(bnbFee.pnl, 2);
assert.equal(bnbFee.commissionsByAsset.BNB, 0.001);

console.log("nine-ai-execution-ledger.test.js: OK");
