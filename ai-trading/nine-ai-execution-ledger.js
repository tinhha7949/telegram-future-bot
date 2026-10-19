"use strict";

function summarizeClosedTrade(trade = {}, exchangeTrades = [], fundingRows = null) {
  if (!Array.isArray(exchangeTrades) || !exchangeTrades.length) return null;
  const openTime = Number(trade.enteredAt || trade.createdAt || 0);
  const tradeFills = exchangeTrades.filter(fill => Number(fill.time || 0) >= openTime);
  const exits = tradeFills.filter(fill => {
    const closesDirection = trade.side === "LONG" ? fill.buyer === false : fill.buyer === true;
    return Number(fill.realizedPnl || 0) !== 0 || closesDirection;
  });
  if (!exits.length) return null;

  const latestOrderId = exits.at(-1).orderId;
  const latestOrderFills = exits.filter(fill => fill.orderId === latestOrderId);
  const grossRealizedPnl = exits.reduce((sum, fill) => sum + Number(fill.realizedPnl || 0), 0);
  const commissionsByAsset = tradeFills.reduce((totals, fill) => {
    const asset = String(fill.commissionAsset || "UNKNOWN").toUpperCase();
    totals[asset] = (totals[asset] || 0) + Math.abs(Number(fill.commission || 0));
    return totals;
  }, {});
  const feesUSDT = commissionsByAsset.USDT || 0;
  const fundingByAsset = Array.isArray(fundingRows) ? fundingRows.reduce((totals, row) => {
    const asset = String(row.asset || "UNKNOWN").toUpperCase();
    totals[asset] = (totals[asset] || 0) + Number(row.income || 0);
    return totals;
  }, {}) : {};
  const fundingUSDT = Array.isArray(fundingRows) ? (fundingByAsset.USDT || 0) : null;
  const exitQuantity = exits.reduce((sum, fill) => sum + Math.abs(Number(fill.qty || 0)), 0);
  const exitNotional = exits.reduce((sum, fill) =>
    sum + Math.abs(Number(fill.qty || 0)) * Number(fill.price || 0), 0);
  const latestFill = latestOrderFills.at(-1);
  const executionFills = tradeFills.map(fill => ({
    id: fill.id == null ? null : String(fill.id),
    orderId: fill.orderId == null ? null : String(fill.orderId),
    time: Number(fill.time || 0), price: Number(fill.price || 0),
    quantity: Number(fill.qty || 0), realizedPnl: Number(fill.realizedPnl || 0),
    commission: Math.abs(Number(fill.commission || 0)),
    commissionAsset: String(fill.commissionAsset || "UNKNOWN").toUpperCase(),
    buyer: typeof fill.buyer === "boolean" ? fill.buyer : null,
    maker: typeof fill.maker === "boolean" ? fill.maker : null,
    positionSide: String(fill.positionSide || "BOTH")
  }));

  return {
    pnl: grossRealizedPnl - feesUSDT + (fundingUSDT || 0),
    grossRealizedPnl,
    feesUSDT,
    exitPrice: exitQuantity > 0 ? exitNotional / exitQuantity : Number(latestFill.price || 0),
    exitQty: exitQuantity,
    exitOrderId: String(latestOrderId),
    exitOrderIds: [...new Set(exits.map(fill => String(fill.orderId)))],
    closedAt: Number(latestFill.time || Date.now()),
    executionFills,
    executionFillCount: tradeFills.length,
    executionFillsMayBeTruncated: tradeFills.length >= 1000,
    commissionsByAsset,
    fundingUSDT,
    fundingByAsset,
    fundingEntries: Array.isArray(fundingRows) ? fundingRows.map(row => ({
      transactionId: row.tranId == null ? null : String(row.tranId),
      time: Number(row.time || 0), income: Number(row.income || 0),
      asset: String(row.asset || "UNKNOWN").toUpperCase(),
      symbol: String(row.symbol || "")
    })) : [],
    fundingIncluded: Array.isArray(fundingRows)
  };
}

module.exports = { summarizeClosedTrade };
