"use strict";
function calculateMargin(walletBalance, risk) {
  const wallet = Number(walletBalance);
  if (!Number.isFinite(wallet) || wallet <= 0) throw new Error("Wallet balance must be positive");
  let margin = wallet * Number(risk.walletPercentPerTrade) / 100;
  if (Number(risk.maxMarginPerTradeUsdt) > 0) margin = Math.min(margin, Number(risk.maxMarginPerTradeUsdt));
  if (margin < Number(risk.minMarginPerTradeUsdt || 0)) throw new Error("Calculated margin below configured minimum");
  return margin;
}
function calculateRawQuantity(margin, leverage, entryPrice) {
  if (!(margin > 0) || !(leverage > 0) || !(entryPrice > 0)) throw new Error("Margin, leverage and entry price must be positive");
  return margin * leverage / entryPrice;
}
function calculateTpSplit(quantity, percent, roundQuantity) {
  if (!(quantity > 0) || !(percent > 0 && percent < 100)) throw new Error("Invalid TP split input");
  const tp1Quantity = roundQuantity(quantity * percent / 100);
  const tp2Quantity = roundQuantity(quantity - tp1Quantity);
  if (!(tp1Quantity > 0) || !(tp2Quantity > 0)) throw new Error("Position is too small for TP1/TP2 quantity split");
  return { tp1Quantity, tp2Quantity };
}
module.exports = { calculateMargin, calculateRawQuantity, calculateTpSplit };
