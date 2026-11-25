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
function decimalPlaces(step) {
  const value = String(step).toLowerCase();
  const [coefficient, exponentText] = value.split("e");
  const fractionDigits = (coefficient.split(".")[1] || "").length;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionDigits - exponent);
}
function roundToStep(raw, step, roundUp = false) {
  if (!(raw >= 0) || !(step > 0)) throw new Error("Invalid quantity step input");
  const units = raw / step;
  const roundedUnits = roundUp
    ? Math.ceil(units - 1e-10)
    : Math.floor(units + 1e-10);
  const precision = decimalPlaces(step);
  return Number((roundedUnits * step).toFixed(precision));
}
function buildTradeSizing(margin, leverage, entryPrice, tp1Price, tp1ClosePct, filters) {
  const marketQty = roundToStep(margin * leverage / entryPrice, filters.marketStepSize);
  const tp1Qty = roundToStep(marketQty * tp1ClosePct / 100, filters.lotStepSize);
  const notional = marketQty * entryPrice;
  const tp1Notional = tp1Qty * tp1Price;
  if (!(marketQty >= filters.marketMinQty)
    || !(tp1Qty >= filters.lotMinQty)
    || !(tp1Qty < marketQty)
    || notional + 1e-10 < filters.minNotional
    || tp1Notional + 1e-10 < filters.minNotional) return null;
  return {
    margin,
    marketQty,
    tp1Qty,
    notional,
    tp1Notional,
    requiredMargin: notional / leverage
  };
}
/**
 * Preserve the configured margin whenever its rounded MARKET and TP1 quantities
 * already satisfy Binance filters. Only uplift a too-small margin to the smallest
 * step-aligned position that satisfies both notionals and quantity filters.
 */
function calculateTradeSizing({
  walletBalance, availableBalance, risk, leverage, entryPrice, tp1Price, tp1ClosePct, filters
}) {
  const baseMargin = calculateMargin(walletBalance, risk);
  if (!(Number.isFinite(availableBalance) && availableBalance >= 0)) {
    throw new Error("ENTRY_REJECTED_INVALID_AVAILABLE_BALANCE");
  }
  if (!(leverage > 0) || !(entryPrice > 0) || !(tp1Price > 0)
    || !(tp1ClosePct > 0 && tp1ClosePct < 100)) {
    throw new Error("Invalid trade sizing inputs");
  }
  const requiredFilters = ["marketStepSize", "marketMinQty", "lotStepSize", "lotMinQty", "minNotional"];
  if (!filters || requiredFilters.some(key => !(Number(filters[key]) > 0))) {
    throw new Error("ENTRY_REJECTED_MISSING_OR_INVALID_EXCHANGE_FILTERS");
  }

  const current = buildTradeSizing(baseMargin, leverage, entryPrice, tp1Price, tp1ClosePct, filters);
  if (current) {
    if (current.requiredMargin > availableBalance) {
      throw new Error("ENTRY_REJECTED_INSUFFICIENT_AVAILABLE_BALANCE: required " +
        current.requiredMargin.toFixed(8) + " USDT, available " + availableBalance.toFixed(8) + " USDT");
    }
    return { ...current, adjusted: false };
  }

  const requiredTp1Qty = roundToStep(
    Math.max(filters.lotMinQty, filters.minNotional / tp1Price),
    filters.lotStepSize,
    true
  );
  const requiredMarketQty = roundToStep(
    Math.max(
      filters.marketMinQty,
      filters.minNotional / entryPrice,
      requiredTp1Qty * 100 / tp1ClosePct
    ),
    filters.marketStepSize,
    true
  );
  const maxMargin = Number(risk.maxMarginPerTradeUsdt) > 0
    ? Number(risk.maxMarginPerTradeUsdt)
    : Infinity;

  // A tiny sub-step epsilon prevents floating-point division from flooring the
  // exact target quantity one step below the intended MARKET_LOT_SIZE.
  for (let extraSteps = 0; extraSteps <= 1000; extraSteps++) {
    const targetQty = requiredMarketQty + extraSteps * filters.marketStepSize;
    const candidateMargin = (targetQty + filters.marketStepSize * 1e-9) * entryPrice / leverage;
    if (candidateMargin <= baseMargin) continue;
    if (candidateMargin > maxMargin + 1e-10) {
      throw new Error("ENTRY_REJECTED_TP1_MIN_NOTIONAL_MARGIN_CAP: required " +
        candidateMargin.toFixed(8) + " USDT, maxMarginPerTradeUsdt " + maxMargin.toFixed(8) + " USDT");
    }
    if (candidateMargin > availableBalance + 1e-10) {
      throw new Error("ENTRY_REJECTED_TP1_MIN_NOTIONAL_INSUFFICIENT_BALANCE: required " +
        candidateMargin.toFixed(8) + " USDT, available " + availableBalance.toFixed(8) + " USDT");
    }
    const candidate = buildTradeSizing(
      candidateMargin, leverage, entryPrice, tp1Price, tp1ClosePct, filters
    );
    if (candidate) return { ...candidate, adjusted: true, baseMargin };
  }
  throw new Error("ENTRY_REJECTED_TP1_MIN_NOTIONAL_UNSATISFIABLE");
}
function calculateTpSplit(quantity, percent, roundQuantity) {
  if (!(quantity > 0) || !(percent > 0 && percent < 100)) throw new Error("Invalid TP split input");
  const tp1Quantity = roundQuantity(quantity * percent / 100);
  const tp2Quantity = roundQuantity(quantity - tp1Quantity);
  if (!(tp1Quantity > 0) || !(tp2Quantity > 0)) throw new Error("Position is too small for TP1/TP2 quantity split");
  return { tp1Quantity, tp2Quantity };
}
module.exports = {
  calculateMargin, calculateRawQuantity, calculateTradeSizing, calculateTpSplit
};
