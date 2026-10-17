"use strict";
const assert = require("node:assert/strict");
const {
  ROLE_NAMES, ROLE_WEIGHTS, analyzeNineAI, parseClosedCandles, buildFeatures,
  resolveModelSide, resolveConsensusSide, assessIndependentRiskModel, assessEntryRiskEvidence,
  detectContrarianSignal, isContrarianConflict, calculateWeightedRoleScore, compareNineAICandidates,
  deriveNineAIDynamicPlan, shouldNineAIExitPosition, canNineAIDynamicallyAdjust, MAX_NINE_AI_RR
} = require("./nine-ai-strategy");

assert.equal(ROLE_NAMES.length, 9);
assert.equal(new Set(ROLE_NAMES).size, 9);
assert.equal(Object.keys(ROLE_WEIGHTS).length, 9);
assert.ok(Math.abs(Object.values(ROLE_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
assert.equal(ROLE_WEIGHTS["Contrarian AI"], 0.15);

// A trained model with no decisive direction must not erase the rule-based
// fallback vote, which previously caused a sudden wave of WAIT/NO SIGNAL.
assert.equal(resolveModelSide({ trained: true, side: null }, "LONG"), "LONG");
assert.equal(resolveModelSide({ trained: true, side: "SHORT" }, "LONG"), "SHORT");
assert.equal(resolveModelSide({ trained: false, side: "SHORT" }, "LONG"), "LONG");

// Regression: once the Decision model reaches its training threshold, a
// disagreement must not turn a valid rule consensus into WAIT.
assert.equal(resolveConsensusSide("LONG"), "LONG");
assert.equal(resolveConsensusSide("SHORT"), "SHORT");
assert.equal(resolveConsensusSide(null), null);
assert.equal(resolveConsensusSide("WAIT"), null);

// A high learned loss probability lowers the Risk Manager's ranking confidence
// but never acts as a standalone veto. Deterministic safety rules remain active.
const highLossAssessment = assessIndependentRiskModel({ trained: true, pLoss: 0.9 });
assert.equal(highLossAssessment.veto, false);
assert.equal(highLossAssessment.confidence, 10);
assert.equal(highLossAssessment.reason, "HIGH_LOSS_RISK_SOFT_PENALTY");

assert.equal(assessIndependentRiskModel({ trained: false }).veto, false);

// Market observations formerly used as fixed hard vetoes are now evidence only.
// A low confidence, unusual ATR, extreme RSI, EMA mismatch, or opposing trap
// cannot independently suppress an otherwise valid directional candidate.
const lowRankButDirectional = assessEntryRiskEvidence({
  side: "LONG",
  features: { atrPct: 0.0004, rsi: 91, last: { c: 99 }, e21: 100 },
  contrarian: { side: "SHORT", strength: 90 }
});
assert.equal(lowRankButDirectional.allowed, true);
assert.ok(lowRankButDirectional.evidence.includes("opposingTrapEvidence"));
assert.ok(lowRankButDirectional.evidence.some(item => item.startsWith("atrPct=")));
assert.ok(lowRankButDirectional.evidence.some(item => item.startsWith("rsi=")));
assert.equal(assessEntryRiskEvidence({ side: "SHORT", features: { atrPct: 0.08, rsi: 5 } }).allowed, true);
assert.equal(assessEntryRiskEvidence({ side: null, features: {} }).allowed, false);

const now = Date.now();
const rows = [];
let price = 100;
for (let i = 0; i < 100; i++) {
  const open = price;
  price += 0.18 + Math.sin(i / 3) * 0.06;
  rows.push([now - (100 - i) * 900000, open, Math.max(open, price) + 0.2,
    Math.min(open, price) - 0.2, price, 100 + i, now - (100 - i) * 900000 + 899999]);
}
rows.push([now, price, price + 0.1, price - 0.1, price + 0.05, 100, now + 899999]);
assert.equal(parseClosedCandles(rows, now).length, 100);
const parsed = parseClosedCandles(rows, now);
const contextFeatures = buildFeatures(parsed);
assert.ok(["TREND_UP", "TREND_DOWN", "SIDEWAYS", "TRANSITION"].includes(contextFeatures.marketRegime));
assert.ok(["HIGH", "NORMAL", "LOW"].includes(contextFeatures.volatilityRegime));
assert.ok(contextFeatures.candleBodyRatio >= -1 && contextFeatures.candleBodyRatio <= 1);
assert.ok(contextFeatures.upperWickRatio >= 0 && contextFeatures.upperWickRatio <= 1);
assert.ok(contextFeatures.lowerWickRatio >= 0 && contextFeatures.lowerWickRatio <= 1);
assert.ok(Number.isFinite(contextFeatures.breakoutStrength));
assert.ok(contextFeatures.structurePosition >= -1 && contextFeatures.structurePosition <= 1);
assert.ok(Number.isFinite(contextFeatures.roomToResistanceAtr));
assert.ok(Number.isFinite(contextFeatures.roomToSupportAtr));
assert.ok(contextFeatures.longEntryQuality >= 0 && contextFeatures.longEntryQuality <= 100);
assert.ok(contextFeatures.shortEntryQuality >= 0 && contextFeatures.shortEntryQuality <= 100);
const result = analyzeNineAI(rows, "TESTUSDT", now);
assert.equal(result.symbol, "TESTUSDT");
assert.equal(result.roles.length, 9);
assert.equal(result.roles[7].name, "Decision AI");
assert.equal(result.roles[8].name, "Risk Manager AI");
if (result.side) {
  assert.ok(result.sl > 0 && result.tp > 0 && result.price > 0);
  assert.ok(result.rr >= 0.79 && result.rr <= 1.8, "any valid RR below the hard 1.8 ceiling is allowed");
  assert.equal(result.authorizedForExecution, true);
  assert.equal(result.tradePlan.timeframe, "15m");
  assert.equal(result.tradePlan.entryMethod, "LATEST_CLOSED_CANDLE");
  assert.equal(result.tradePlan.stopMethod, "ATR_AND_RECENT_STRUCTURE");
  assert.equal(result.entry, result.price);
  assert.equal(result.rankMetrics.roleContributions.length, 9);
  const contributionSum = result.rankMetrics.roleContributions
    .reduce((sum, role) => sum + role.weightedContribution, 0);
  assert.ok(Math.abs(result.rankMetrics.roleScore - contributionSum) < 0.1,
    "rounded per-role contributions should reconcile to the weighted role score");
  assert.ok(result.rankScore >= 0 && result.rankScore <= 100);
  assert.ok(Math.abs(result.rankMetrics.roleWeight + result.rankMetrics.setupWeight +
    result.rankMetrics.entryQualityWeight - 1) < 1e-9);
  assert.ok(result.rankMetrics.roleWeight >= 0.45 && result.rankMetrics.roleWeight <= 0.90);
  assert.ok(result.rankMetrics.setupWeight >= 0.03 && result.rankMetrics.setupWeight <= 0.35);
  assert.ok(result.rankMetrics.entryQualityWeight >= 0.03 && result.rankMetrics.entryQualityWeight <= 0.35);
  assert.ok(Math.abs(result.rankScore - (
    result.rankMetrics.roleScore * result.rankMetrics.roleWeight +
    result.rankMetrics.setupQuality * result.rankMetrics.setupWeight +
    result.rankMetrics.entryQuality * result.rankMetrics.entryQualityWeight
  )) < 0.02, "ranking uses learned component weights");
  assert.ok(result.rankMetrics.entryQuality >= 0 && result.rankMetrics.entryQuality <= 100);
  assert.ok(result.rankMetrics.breakoutQuality >= 0 && result.rankMetrics.breakoutQuality <= 100);
  assert.ok(result.rankMetrics.roomQuality >= 0 && result.rankMetrics.roomQuality <= 100);
  assert.equal(result.rankMetrics.netRRStatus, "NOT_CONFIGURED");
  assert.equal(result.rankMetrics.netRR, null);
  assert.ok(result.rankMetrics.features.marketRegime);
  assert.ok(result.rankMetrics.features.volatilityRegime);
  assert.ok(result.rankMetrics.contrarian.reason);
} else {
  assert.equal(result.authorizedForExecution, undefined);
}

// A false breakout above the recent range, rejected by a long upper wick,
// must be identified as a bull trap rather than a generic RSI fade.
const priorCandles = [];
for (let i = 0; i < 5; i++) {
  priorCandles.push({ o: 99.5, h: 101, l: 99, c: 100, v: 100 });
}
const bullTrapCandles = [...priorCandles, { o: 100.2, h: 102, l: 99.8, c: 100.4, v: 140 }];
const bullTrap = detectContrarianSignal(bullTrapCandles, {
  last: bullTrapCandles[bullTrapCandles.length - 1], atr: 1,
  volumeRatio: 1.4, rsi: 72, extensionAtr: 1.4
});
assert.equal(bullTrap.side, "SHORT");
assert.equal(bullTrap.reason, "BULL_TRAP_REJECTION");
assert.ok(bullTrap.strength >= 60);

// A failed breakdown that reclaims support must be identified as a bear trap.
const bearTrapCandles = [...priorCandles, { o: 99.8, h: 100.2, l: 97.8, c: 100.1, v: 150 }];
const bearTrap = detectContrarianSignal(bearTrapCandles, {
  last: bearTrapCandles[bearTrapCandles.length - 1], atr: 1,
  volumeRatio: 1.5, rsi: 28, extensionAtr: -1.4
});
assert.equal(bearTrap.side, "LONG");
assert.equal(bearTrap.reason, "BEAR_TRAP_RECLAIM");
assert.equal(isContrarianConflict("LONG", bullTrap), true,
  "a confirmed bull trap must veto a conflicting LONG entry");
assert.equal(isContrarianConflict("SHORT", bearTrap), true,
  "a confirmed bear trap must veto a conflicting SHORT entry");
assert.equal(isContrarianConflict("SHORT", bullTrap), false,
  "the reversal direction should not be vetoed by the trap it follows");
assert.equal(isContrarianConflict("LONG", { side: "SHORT", strength: 40 }), false,
  "weak countertrend evidence must not trigger the hard veto");

// The ranking score must actually change when role evidence changes, with
// every role's declared weight represented in the calculation.
const roleSetA = ROLE_NAMES.map(name => ({
  name, side: name === "Risk Manager AI" ? "LONG" : "LONG", confidence: 70
}));
const roleSetB = ROLE_NAMES.map(name => ({
  name, side: name === "Risk Manager AI" ? "LONG" : "NEUTRAL", confidence: 70
}));
const weightedA = calculateWeightedRoleScore(roleSetA, "LONG");
const weightedB = calculateWeightedRoleScore(roleSetB, "LONG");
assert.ok(weightedA.score > weightedB.score);
assert.equal(weightedA.roles.length, 9);
assert.ok(Math.abs(weightedA.roles.reduce((sum, role) => sum + role.weight, 0) - 1) < 1e-9);
assert.equal(weightedA.roles.find(role => role.name === "Contrarian AI").weight, 0.15);
assert.equal(weightedA.roles.find(role => role.name === "Contrarian AI").score, 70);
assert.equal(weightedB.roles.find(role => role.name === "Contrarian AI").score, 50);

const highQuality = {
  symbol: "ZZZUSDT", confidence: 60, rankScore: 72,
  rankMetrics: { consensusMargin: 3, directionalVotes: 5, setupQuality: 90, volumeQuality: 80 }
};
const lowerQuality = {
  symbol: "AAAUSDT", confidence: 61, rankScore: 68,
  rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80, volumeQuality: 70 }
};
assert.ok(compareNineAICandidates(highQuality, lowerQuality) < 0,
  "higher composite score must outrank a coin with slightly higher raw confidence");
assert.ok(compareNineAICandidates(
  { symbol: "BBB", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 3, directionalVotes: 5, setupQuality: 80 } },
  { symbol: "AAA", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80 } }
) < 0, "consensus margin must break a true composite-score tie before symbol name");
assert.ok(compareNineAICandidates(
  { symbol: "AAA", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80 } },
  { symbol: "ZZZ", rankScore: 70, confidence: 60, rankMetrics: { consensusMargin: 2, directionalVotes: 5, setupQuality: 80 } }
) < 0, "symbol name is only the final deterministic tie-breaker");

// Dynamic TPSL invariants: role-derived RR never exceeds 1.8 and SL never widens.
assert.equal(MAX_NINE_AI_RR, 1.8);
assert.ok(1.3 <= MAX_NINE_AI_RR, "RR 1.3 is valid because 1.8 is a ceiling, not a required target");
const alignedDecision = {
  side: "LONG", authorizedForExecution: true, rankScore: 82,
  rankMetrics: { roleScore: 82, features: { atr14: 2 } },
  roles: [
    { name: "Contrarian AI", side: "LONG", confidence: 70 },
    { name: "Risk Manager AI", side: "LONG", confidence: 75 }
  ]
};
const alignedPlan = deriveNineAIDynamicPlan({
  decision: alignedDecision, side: "LONG", entry: 100, current: 100.5,
  oldSL: 95, oldTP: 110, tickSize: 0.1
});
assert.ok(alignedPlan === null || alignedPlan.sl >= 95,
  "aligned LONG dynamic management must never widen SL");
assert.ok(alignedPlan === null || alignedPlan.tp > 100.5,
  "any accepted LONG TP must remain beyond current price");
assert.ok(alignedPlan === null || alignedPlan.rr <= 1.8,
  "reject a trailing-stop update if retaining the original TP would violate RR<=1.8");

const shortAlignedDecision = {
  side: "SHORT", authorizedForExecution: true, rankScore: 80,
  rankMetrics: { roleScore: 80, features: { atr14: 2 } },
  roles: [
    { name: "Contrarian AI", side: "SHORT", confidence: 70 },
    { name: "Risk Manager AI", side: "SHORT", confidence: 75 }
  ]
};
const shortPlan = deriveNineAIDynamicPlan({
  decision: shortAlignedDecision, side: "SHORT", entry: 100, current: 99.5,
  oldSL: 105, oldTP: 90, tickSize: 0.1
});
assert.ok(shortPlan === null || shortPlan.sl <= 105,
  "aligned SHORT dynamic management must never widen SL");
assert.ok(shortPlan === null || shortPlan.tp < 99.5,
  "any accepted SHORT TP must remain beyond current price");
assert.ok(shortPlan === null || shortPlan.rr <= 1.8,
  "SHORT dynamic RR must never exceed 1.8; reject updates that cannot preserve the original TP safely");

const oldTargetNear = deriveNineAIDynamicPlan({
  decision: alignedDecision, side: "LONG", entry: 100, current: 100.5,
  oldSL: 95, oldTP: 101, tickSize: 0.1
});
assert.ok(oldTargetNear, "9AI should be able to extend TP when RR allows it");
assert.ok(oldTargetNear.tp > 101, "TP is allowed to move farther when 9AI supports the setup");
assert.ok(oldTargetNear.rr <= 1.8, "extended TP must remain under RR 1.8");

const weakDecision = {
  side: null, authorizedForExecution: false, confidence: 0,
  roles: [{ name: "Risk Manager AI", side: "VETO", confidence: 100 }],
  rankMetrics: { features: { atr14: 2 } }
};
const tightenedPlan = deriveNineAIDynamicPlan({
  decision: weakDecision, side: "LONG", entry: 100, current: 102,
  oldSL: 95, oldTP: 110, tickSize: 0.1
});
assert.ok(tightenedPlan === null || tightenedPlan.sl >= 95,
  "weak/invalid decision must not widen LONG SL");
assert.ok(tightenedPlan === null || tightenedPlan.action === "CLOSE_TARGET_REACHED" || tightenedPlan.rr <= 1.8,
  "weak/invalid decision must stay under the RR ceiling or request immediate exit if the live target is already crossed");
assert.ok(tightenedPlan === null || tightenedPlan.tp >= 110,
  "weak/invalid decision must never pull the confirmed LONG TP inward");

// A weak/neutral re-analysis cannot shrink the original SHORT target either.
const weakShortPlan = deriveNineAIDynamicPlan({
  decision: { ...weakDecision, side: null },
  side: "SHORT", entry: 100, current: 98,
  oldSL: 105, oldTP: 90, tickSize: 0.1
});
assert.ok(weakShortPlan === null || weakShortPlan.tp <= 90,
  "weak/invalid decision must never pull the confirmed SHORT TP inward");


assert.equal(canNineAIDynamicallyAdjust({ side: "LONG", entry: 100, current: 100.1, initialRisk: 5 }), true);
assert.equal(canNineAIDynamicallyAdjust({ side: "SHORT", entry: 100, current: 100.1, initialRisk: 5 }), true);
assert.equal(shouldNineAIExitPosition({
  authorizedForExecution: true, side: "SHORT",
  rankMetrics: { features: { trend: "DOWN", momentum12: -1, structureTrend: "LOWER_HIGHS_LOWS" } }
}, "LONG"), true);
assert.equal(shouldNineAIExitPosition({ authorizedForExecution: false, side: "SHORT", rankMetrics: { roleScore: 99 } }, "LONG"), false);
assert.equal(shouldNineAIExitPosition({ authorizedForExecution: true, side: "LONG", rankMetrics: { roleScore: 99 } }, "LONG"), false);

console.log("PASS: Nine-AI sole decision authority, AI-owned dynamic gates, weighted ranking, trade geometry, non-contracting TP, and RR cap");
