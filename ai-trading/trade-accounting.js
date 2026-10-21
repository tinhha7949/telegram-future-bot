"use strict";

const number = (v) => (v == null || v === "" ? NaN : Number(v));
function getTradeActualRisk(trade = {}) {
  const saved = number(trade.actualInitialRiskUSDT);
  if (saved > 0 && Number.isFinite(saved)) return saved;
  const qty = [
    trade.actualQuantity,
    trade.entryExecution?.executedQuantity,
    trade.quantity,
  ]
    .map(number)
    .find((v) => v > 0 && Number.isFinite(v));
  const distance = number(trade.initialRisk ?? trade.riskDetail?.initialRisk);
  return qty > 0 && distance > 0 && Number.isFinite(distance)
    ? qty * distance
    : 0;
}

// Called only after the exchange confirms flat. Never invent missing fees or funding.
function summarizeClosedTrade(trade, rawFills, fundingRows) {
  if (!Array.isArray(rawFills) || !rawFills.length) return null;
  const entryId = trade.entryExecution?.orderId ?? trade.entryOrderId;
  const expectedQty = [
    trade.actualQuantity,
    trade.entryExecution?.executedQuantity,
    trade.quantity,
  ]
    .map(number)
    .find((v) => v > 0 && Number.isFinite(v));
  const start = Math.min(
    ...[
      trade.submittedAt,
      trade.entryExecution?.orderTime,
      trade.enteredAt,
      trade.openedAt,
    ]
      .map(number)
      .filter((v) => v > 0),
  );
  if (!(expectedQty > 0) || !Number.isFinite(start)) return null;
  const entrySide = trade.side === "LONG" ? "BUY" : "SELL";
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const unique = new Map();
  for (const f of rawFills) {
    if (f.symbol && f.symbol !== trade.symbol) continue;
    if (number(f.time) < start - 5000) continue;
    unique.set(String(f.id ?? `${f.orderId}:${f.time}:${f.qty}:${f.price}`), f);
  }
  const fills = [...unique.values()].sort(
    (a, b) => number(a.time) - number(b.time) || number(a.id) - number(b.id),
  );
  const entries = fills.filter(
    (f) =>
      f.side === entrySide &&
      (entryId != null
        ? String(f.orderId) === String(entryId)
        : number(f.time) >= start),
  );
  const entryQty = entries.reduce((s, f) => s + number(f.qty), 0);
  const tolerance = Math.max(expectedQty * 1e-7, 1e-10);
  if (
    !Number.isFinite(entryQty) ||
    Math.abs(entryQty - expectedQty) > tolerance
  )
    return null;
  const firstEntryTime = Math.min(...entries.map((f) => number(f.time)));
  const exits = [];
  let exitQty = 0;
  for (const f of fills) {
    if (f.side !== exitSide || number(f.time) < firstEntryTime) continue;
    exits.push(f);
    exitQty += number(f.qty);
    if (exitQty >= expectedQty - tolerance) break;
  }
  if (!Number.isFinite(exitQty) || Math.abs(exitQty - expectedQty) > tolerance)
    return null;
  const selected = [...entries, ...exits].sort(
    (a, b) => number(a.time) - number(b.time),
  );
  if (
    selected.some(
      (f) => !(number(f.qty) > 0 && number(f.price) > 0 && number(f.time) > 0),
    ) ||
    exits.some((f) => !Number.isFinite(number(f.realizedPnl)))
  )
    return null;
  const closedAt = Math.max(...exits.map((f) => number(f.time)));
  const commissionsByAsset = {},
    fundingByAsset = {};
  let feesUSDT = 0,
    conversionMissing = false;
  for (const f of selected) {
    const fee = number(f.commission),
      asset = String(f.commissionAsset || "");
    if (!Number.isFinite(fee) || fee < 0 || !asset) {
      conversionMissing = true;
      continue;
    }
    commissionsByAsset[asset] = (commissionsByAsset[asset] || 0) + fee;
    const converted =
      fee === 0 ? 0 : asset === "USDT" ? fee : number(f.commissionUSDT);
    if (!Number.isFinite(converted)) conversionMissing = true;
    else feesUSDT += converted;
  }
  const fundingEntries = Array.isArray(fundingRows)
    ? fundingRows.filter(
        (f) =>
          (!f.symbol || f.symbol === trade.symbol) &&
          number(f.time) >= firstEntryTime &&
          number(f.time) <= closedAt,
      )
    : [];
  let fundingUSDT = 0;
  const seenFunding = new Set();
  for (const f of fundingEntries) {
    const key = String(f.tranId ?? `${f.time}:${f.asset}:${f.income}`);
    if (seenFunding.has(key)) continue;
    seenFunding.add(key);
    const income = number(f.income),
      asset = String(f.asset || "");
    fundingByAsset[asset] = (fundingByAsset[asset] || 0) + income;
    const converted = asset === "USDT" ? income : number(f.incomeUSDT);
    if (!Number.isFinite(converted)) conversionMissing = true;
    else fundingUSDT += converted;
  }
  const grossRealizedPnl = exits.reduce((s, f) => s + number(f.realizedPnl), 0);
  const complete =
    Array.isArray(fundingRows) &&
    !conversionMissing &&
    Number.isFinite(grossRealizedPnl);
  const exitOrderIds = [...new Set(exits.map((f) => String(f.orderId)))];
  const lastExit = exits.at(-1);
  const plannedEntry = number(
    trade.entryExecution?.plannedEntry ?? trade.price ?? trade.entry,
  );
  const entryPrice =
    entries.reduce((s, f) => s + number(f.price) * number(f.qty), 0) / entryQty;
  return {
    accountingComplete: complete,
    accountingReason: complete
      ? "RECONCILED"
      : "MISSING_FUNDING_OR_FEE_CONVERSION",
    pnl: complete ? grossRealizedPnl - feesUSDT + fundingUSDT : null,
    grossRealizedPnl,
    feesUSDT: conversionMissing ? null : feesUSDT,
    fundingUSDT:
      Array.isArray(fundingRows) && !conversionMissing ? fundingUSDT : null,
    fundingIncluded: complete,
    fundingEntries,
    fundingByAsset,
    commissionsByAsset,
    exitPrice:
      exits.reduce((s, f) => s + number(f.price) * number(f.qty), 0) / exitQty,
    exitQty,
    exitOrderId: String(lastExit.orderId),
    exitOrderIds,
    closedAt,
    entryPrice,
    entrySlippage: entryPrice - plannedEntry,
    entrySlippageUSDT:
      (entryPrice - plannedEntry) * (trade.side === "LONG" ? 1 : -1) * entryQty,
    executionFills: selected,
    executionFillCount: selected.length,
    executionFillsMayBeTruncated: false,
  };
}

module.exports = { getTradeActualRisk, summarizeClosedTrade };
