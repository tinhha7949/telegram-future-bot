"use strict";
const { CONFIG } = require("./config");
const { assessAvailableMargin } = require("./execution-risk");
const { fundingIsHot } = require("./nine-ai-policy");

const finite = value =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);

function vetoMarketSnapshot(market = {}, now = Date.now(), config = CONFIG, barMs = config.BAR_HOURS * 60 * 60 * 1000) {
  const snapshotAt = finite(market.snapshotAt);
  if (snapshotAt === null)
    return { ok: false, reason: "EXECUTION_COST_INPUTS_MISSING_MARKET_SNAPSHOT_AT" };
  if (snapshotAt > now)
    return { ok: false, reason: "EXECUTION_COST_INPUTS_FUTURE_MARKET_SNAPSHOT" };
  if (now - snapshotAt > barMs)
    return { ok: false, reason: "STALE_MARKET_SNAPSHOT" };

  const fundingRate = finite(market.fundingRate);
  if (fundingRate === null)
    return { ok: false, reason: "EXECUTION_COST_INPUTS_MISSING_FUNDING_RATE" };
  if (fundingIsHot(fundingRate))
    return { ok: false, reason: "HOT_FUNDING" };

  const openInterestChange = finite(market.openInterestChange);
  if (openInterestChange === null)
    return { ok: false, reason: "EXECUTION_COST_INPUTS_MISSING_OPEN_INTEREST_CHANGE" };

  const spreadPct = finite(market.spreadPct);
  if (spreadPct === null || spreadPct < 0)
    return { ok: false, reason: "EXECUTION_COST_INPUTS_MISSING_SPREAD" };
  if (spreadPct > config.MAX_SPREAD_PCT)
    return { ok: false, reason: "SPREAD_TOO_WIDE" };

  const depthNotional = finite(market.depthNotional);
  if (depthNotional === null || depthNotional <= 0)
    return { ok: false, reason: "EXECUTION_COST_INPUTS_MISSING_ORDERBOOK_DEPTH" };

  const latencyMs = finite(market.latencyMs);
  if (latencyMs === null || latencyMs < 0)
    return { ok: false, reason: "EXECUTION_COST_INPUTS_MISSING_LATENCY" };

  return {
    ok: true,
    reason: "AI6_MARKET_VETO_PASSED",
    snapshotAgeMs: now - snapshotAt,
    fundingRate,
    spreadPct,
    depthNotional,
    openInterestChange,
    latencyMs,
  };
}

function vetoAvailableMargin({ account, sizing, symbol, config = CONFIG } = {}) {
  const equity = finite(account?.equity);
  const availableBalance = finite(account?.availableBalance);
  if (equity === null || equity <= 0 || availableBalance === null || availableBalance < 0)
    return { ok: false, reason: "AI6_VETO_BALANCE_UNAVAILABLE" };
  if (!sizing || !(Number(sizing.notional) > 0) || !Number.isFinite(Number(sizing.notional)))
    return { ok: false, reason: "AI6_VETO_INVALID_SIZING" };

  const leverage = account?.leverageBySymbol?.[symbol];
  const margin = assessAvailableMargin({
    availableBalance,
    notional: Number(sizing.notional),
    leverage: leverage?.leverage,
    maxNotional: leverage?.maxNotional,
    multiplier: config.RISK_RESERVATION_MIN_MARGIN_MULTIPLIER,
  });
  return margin.ok
    ? { ok: true, reason: "AI6_BALANCE_VETO_PASSED", margin }
    : { ok: false, reason: "AI6_VETO_" + margin.reason, margin };
}

module.exports = { vetoMarketSnapshot, vetoAvailableMargin };
