"use strict";

const assert = require("node:assert/strict");
const { fenixBootstrapSide, selectEntryDecision } = require("./nine-ai-entry-strategy");

assert.equal(fenixBootstrapSide({ rsi: 29.9, macdHistogram: 0.01 }), "LONG");
assert.equal(fenixBootstrapSide({ rsi: 70.1, macdHistogram: -0.01 }), "SHORT");
assert.equal(fenixBootstrapSide({ rsi: 30, macdHistogram: 0.01 }), null);
assert.equal(fenixBootstrapSide({ rsi: 75, macdHistogram: 0 }), null);
assert.equal(fenixBootstrapSide({ rsi: "invalid", macdHistogram: -1 }), null);
assert.equal(fenixBootstrapSide({ rsi: 20 }), null);

const bootstrapLong = selectEntryDecision({
  activeNativePolicyCount: 0,
  nativePolicyDecision: { ready: false, allowed: false, reason: "NO_VALIDATED_DATA_DERIVED_POLICY" },
  features: { rsi: 25, macdHistogram: 0.5 }
});
assert.equal(bootstrapLong.source, "FENIXAI_BOOTSTRAP");
assert.equal(bootstrapLong.side, "LONG");

const bootstrapWait = selectEntryDecision({
  activeNativePolicyCount: 0,
  features: { rsi: 50, macdHistogram: 0.5 }
});
assert.equal(bootstrapWait.source, "FENIXAI_BOOTSTRAP");
assert.equal(bootstrapWait.side, null);

const nativeLong = selectEntryDecision({
  activeNativePolicyCount: 1,
  nativePolicyDecision: {
    ready: true, allowed: true, side: "LONG", reason: "VALIDATED_DATA_DERIVED_POLICY_MATCH",
    policyId: "data-consensus:TREND_UP"
  },
  // The bootstrap condition would produce SHORT, but native policy must win.
  features: { rsi: 80, macdHistogram: -1 }
});
assert.equal(nativeLong.source, "NINE_AI_NATIVE");
assert.equal(nativeLong.side, "LONG");
assert.equal(nativeLong.policyId, "data-consensus:TREND_UP");

const nativeNoMatch = selectEntryDecision({
  activeNativePolicyCount: 1,
  nativePolicyDecision: { ready: false, allowed: false, reason: "NO_VALIDATED_DATA_DERIVED_POLICY" },
  // No FenixAI fallback is allowed after any native policy is active.
  features: { rsi: 20, macdHistogram: 1 }
});
assert.equal(nativeNoMatch.source, "NINE_AI_NATIVE");
assert.equal(nativeNoMatch.side, null);
assert.equal(nativeNoMatch.reason, "NO_VALIDATED_DATA_DERIVED_POLICY");

const latchedNativeWait = selectEntryDecision({
  activeNativePolicyCount: 0,
  nativeHandoffActivated: true,
  nativePolicyDecision: { ready: false, allowed: false, reason: "NO_VALIDATED_DATA_DERIVED_POLICY" },
  fenixDecision: { ready: true, side: "LONG", confidence: 90 },
  features: { rsi: 20, macdHistogram: 1 }
});
assert.equal(latchedNativeWait.source, "NINE_AI_NATIVE");
assert.equal(latchedNativeWait.side, null, "persisted handoff latch must prevent FenixAI fallback after restart");
assert.equal(latchedNativeWait.reason, "NO_VALIDATED_DATA_DERIVED_POLICY");

const multiAgentBootstrap = selectEntryDecision({
  activeNativePolicyCount: 0,
  fenixDecision: { ready: true, side: "SHORT", confidence: 74, reason: "FENIXAI_MULTI_AGENT_FUSION" }
});
assert.equal(multiAgentBootstrap.source, "FENIXAI_BOOTSTRAP");
assert.equal(multiAgentBootstrap.side, "SHORT");
assert.equal(multiAgentBootstrap.confidence, 74);
const fullFusionWait = selectEntryDecision({
  activeNativePolicyCount: 0,
  fenixDecision: { ready: true, side: null, confidence: 0, reason: "FENIXAI_FUSION_BELOW_THRESHOLD" },
  // RSI/MACD alone would have produced LONG, but must not bypass the full fusion threshold.
  features: { rsi: 20, macdHistogram: 1 }
});
assert.equal(fullFusionWait.source, "FENIXAI_BOOTSTRAP");
assert.equal(fullFusionWait.side, null);
assert.equal(fullFusionWait.reason, "FENIXAI_FUSION_BELOW_THRESHOLD");

console.log("NINE-AI entry strategy bootstrap/native handoff tests passed");
