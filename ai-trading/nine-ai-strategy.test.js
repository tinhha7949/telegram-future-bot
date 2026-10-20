"use strict";
const assert = require("node:assert/strict");
const { fenixBootstrapSide, selectEntryDecision } = require("./nine-ai-entry-strategy");
const {
  ROLE_NAMES, ROLE_WEIGHTS, analyzeNineAI, parseClosedCandles, buildFeatures,
  resolveModelSide, resolveConsensusSide, assessIndependentRiskModel, assessEntryRiskEvidence,
  detectContrarianSignal, isContrarianConflict, observedPivotExitDistances, calculateWeightedRoleScore, compareNineAICandidates
} = require("./nine-ai-strategy");

// FenixAI bootstrap rules are active only before the first native policy.
assert.equal(fenixBootstrapSide({ rsi: 29.9, macdHistogram: 0.01 }), "LONG");
assert.equal(fenixBootstrapSide({ rsi: 70.1, macdHistogram: -0.01 }), "SHORT");
assert.equal(fenixBootstrapSide({ rsi: 30, macdHistogram: 0.01 }), null);
assert.equal(fenixBootstrapSide({ rsi: 75, macdHistogram: 0 }), null);
const bootstrapDecision = selectEntryDecision({
  activeNativePolicyCount: 0, features: { rsi: 25, macdHistogram: 0.5 }
});
assert.equal(bootstrapDecision.source, "FENIXAI_BOOTSTRAP");
assert.equal(bootstrapDecision.side, "LONG");
const nativeDecision = selectEntryDecision({
  activeNativePolicyCount: 1,
  nativePolicyDecision: { ready: true, allowed: true, side: "SHORT", reason: "VALIDATED_DATA_DERIVED_POLICY_MATCH" },
  // A valid FenixAI LONG setup must not override the native policy.
  features: { rsi: 25, macdHistogram: 0.5 }
});
assert.equal(nativeDecision.source, "NINE_AI_NATIVE");
assert.equal(nativeDecision.side, "SHORT");
const nativeWait = selectEntryDecision({
  activeNativePolicyCount: 1,
  nativePolicyDecision: { ready: false, allowed: false, reason: "NO_VALIDATED_DATA_DERIVED_POLICY" },
  features: { rsi: 25, macdHistogram: 0.5 }
});
assert.equal(nativeWait.source, "NINE_AI_NATIVE");
assert.equal(nativeWait.side, null, "never fall back to FenixAI after native activation");

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
assert.ok(Number.isFinite(contextFeatures.macdHistogram), "Fenix bootstrap MACD histogram must be available");
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
  assert.ok(Number.isFinite(result.rr) && result.rr >= 0.8, "authorized trades must meet the hard 0.8 minimum RR");
  assert.equal(result.authorizedForExecution, true);
  assert.equal(result.tradePlan.timeframe, "15m");
  assert.equal(result.tradePlan.entryMethod, "LATEST_CLOSED_CANDLE");
  assert.ok(result.tradePlan.stopMethod);
  assert.equal(result.entry, result.price);
  assert.equal(result.rankMetrics.roleContributions.length, 9);
  const contributionSum = result.rankMetrics.roleContributions
    .reduce((sum, role) => sum + role.weightedContribution, 0);
  assert.ok(Math.abs(result.rankMetrics.roleScore - contributionSum) < 0.1,
    "rounded per-role contributions should reconcile to the weighted role score");
  assert.ok(result.rankScore >= 0 && result.rankScore <= 100);
  assert.ok(Math.abs(result.rankMetrics.roleWeight + result.rankMetrics.setupWeight +
    result.rankMetrics.entryQualityWeight - 1) < 1e-9);
  assert.ok(result.rankMetrics.roleWeight >= 0 && result.rankMetrics.roleWeight <= 1);
  assert.ok(result.rankMetrics.setupWeight >= 0 && result.rankMetrics.setupWeight <= 1);
  assert.ok(result.rankMetrics.entryQualityWeight >= 0 && result.rankMetrics.entryQualityWeight <= 1);
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

const pivotPlan = observedPivotExitDistances([
  { l: 99, h: 101 }, { l: 98, h: 102 }, { l: 99, h: 104 },
  { l: 97, h: 103 }, { l: 99, h: 105 }, { l: 100, h: 102 },
  { l: 100, h: 101 }
], "LONG", 100);
assert.equal(pivotPlan.source, "OBSERVED_96_CLOSED_CANDLE_PIVOTS");
assert.equal(pivotPlan.stopDistance, 2.5);
assert.equal(pivotPlan.targetDistance, 4.5);

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

// General reward learner: arbitrary feature changes must alter its prediction;
// outcomes are continuous net-R estimates rather than binary win/loss labels.
const rewardModel = require("./nine-ai-reward-model");
const rewardFeatures = { trend: 1, momentum: 0.8, rsi: 61, volume: 1.4, extension: 0.3,
  candleBody: 0.6, wickImbalance: 0.2, breakoutStrength: 0.4, regime: 1,
  volatilityRegime: 0, structurePosition: 0.5, roomToResistance: 1.2,
  roomToSupport: 0.8, falseBreakoutRisk: 0, directionalStreak: 0.6,
  longEntryQuality: 78, shortEntryQuality: 32 };
assert.equal(rewardModel.featureVector(rewardFeatures).length, rewardModel.FEATURE_KEYS.length + 1);
const rewardState = rewardModel.freshState();
assert.equal(rewardModel.predict(rewardFeatures, "LONG", rewardState).ready, false);
rewardState.sides.LONG.samples = 40;
rewardState.sides.LONG.weights[0] = 0.25;
rewardState.sides.LONG.weights[1] = 0.7;
rewardState.sides.LONG.variance = 0.4;
const rewardPrediction = rewardModel.predict(rewardFeatures, "LONG", rewardState);
assert.equal(rewardPrediction.ready, true);
assert.ok(Number.isFinite(rewardPrediction.expectedR) && rewardPrediction.uncertainty > 0);
assert.notEqual(rewardPrediction.expectedR, rewardModel.predict({ ...rewardFeatures, trend: -1 }, "LONG", rewardState).expectedR);
assert.equal(rewardModel.predict(rewardFeatures, "WAIT", rewardState).ready, false);

console.log("PASS: Nine-AI data-derived consensus interface, adaptive ranking, observed-pivot exits, and trade geometry");
