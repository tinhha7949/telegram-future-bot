"use strict";

// FenixAI's deterministic technical fallback from src/trading/engine.py:
// RSI < 30 with positive MACD histogram => BUY; RSI > 70 with negative
// MACD histogram => SELL. This is only the no-native-policy bootstrap.
// Once any validated NINE-AI policy is ACTIVE, FenixAI is never a fallback.

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fenixBootstrapSide(features = {}) {
  const rsi = finiteNumber(features.rsi);
  const macdHistogram = finiteNumber(features.macdHistogram);
  if (rsi === null || macdHistogram === null) return null;
  if (rsi < 30 && macdHistogram > 0) return "LONG";
  if (rsi > 70 && macdHistogram < 0) return "SHORT";
  return null;
}

function selectEntryDecision({
  activeNativePolicyCount = 0,
  nativeHandoffActivated = false,
  nativePolicyDecision = {},
  fenixDecision = null,
  features = {}
} = {}) {
  const activeCount = Number(activeNativePolicyCount);
  const nativeMode = Boolean(nativeHandoffActivated) ||
    (Number.isFinite(activeCount) && activeCount > 0);

  // This is deliberately one-way. Once a native policy has ever been active,
  // a later missing/inapplicable policy means WAIT, never FenixAI fallback.
  if (nativeMode) {
    const side = nativePolicyDecision?.ready && nativePolicyDecision?.allowed &&
      ["LONG", "SHORT"].includes(nativePolicyDecision.side)
      ? nativePolicyDecision.side : null;
    return {
      source: "NINE_AI_NATIVE",
      side,
      reason: side
        ? nativePolicyDecision.reason || "NATIVE_POLICY_MATCH"
        : nativePolicyDecision.reason ||
          (nativeHandoffActivated && !(activeCount > 0)
            ? "NATIVE_HANDOFF_LATCHED_NO_ACTIVE_POLICY" : "NATIVE_POLICY_NOT_APPLICABLE"),
      policyId: nativePolicyDecision?.policyId || null
    };
  }

  const side = ["LONG", "SHORT"].includes(fenixDecision?.side)
    ? fenixDecision.side : fenixBootstrapSide(features);
  return {
    source: "FENIXAI_BOOTSTRAP",
    side,
    reason: fenixDecision?.reason || (side ? "FENIXAI_RSI_MACD_ENTRY" : "FENIXAI_NO_ENTRY_SETUP"),
    policyId: null,
    confidence: Number.isFinite(Number(fenixDecision?.confidence)) ? Number(fenixDecision.confidence) : null,
    details: fenixDecision || null
  };
}

module.exports = { fenixBootstrapSide, selectEntryDecision };
