"use strict";
const assert = require("node:assert/strict");
const research = require("./nine-ai-counterfactual-research");
const candles = [
  [0,100,101,99,100,10,899999],
  [900000,100,102,99,101,12,1799999],
  [1800000,101,103,100,102,13,2699999],
  [2700000,102,104,101,103,14,3599999],
  [3600000,103,104,98,99,15,4499999],
];
const baseline = research.simulate({candles,entryIndex:1,side:"LONG",entry:100,sl:98,tp:103,risk:2});
assert.equal(baseline.valid,true);
assert.equal(baseline.exit,"TP");
const conservative = research.simulate({candles:[[0,100,100.5,99.5,100,1,899999],[900000,100,103,97,100,1,1799999]],entryIndex:0,side:"LONG",entry:100,sl:98,tp:102,risk:2});
assert.equal(conservative.valid,true);
assert.equal(conservative.exit,"SL"); // both SL and TP touched, assume stop first
const variants = research.buildVariants({tradeId:"t1",side:"LONG",entry:100,sl:98,tp:104,entryTime:900000,realizedR:-1},candles);
assert.ok(variants.some(v=>v.variant==="BASELINE"));
assert.ok(variants.some(v=>v.variant.startsWith("EXIT_LEVEL:") &&
  v.levelSource === "PRE_ENTRY_OBSERVED_MARKET_STRUCTURE" &&
  Number.isFinite(v.stopScale) && Number.isFinite(v.targetScale)),
  "counterfactual research must create numeric SL/TP candidates from observed pre-entry market levels");
assert.ok(!variants.some(v=>/^(STOP|TARGET)_SCALE_/.test(v.variant)),
  "counterfactual research must not enumerate preset SL/TP multipliers");
assert.ok(variants.some(v=>v.variant==="OPPOSITE_SIDE"&&v.side==="SHORT"));
assert.ok(variants.some(v=>v.variant==="DELAY_1_BAR"));
assert.ok(!variants.some(v=>v.variant.startsWith("RISK_SCALE_")), "exit research must not create position-risk sizing variants");
const rows=[];
for(let i=0;i<50;i++){
  const id="trade-"+i;
  const date=Date.UTC(2025,0,1)+i*86400000;
  rows.push({tradeId:id,variant:"BASELINE",side:"LONG",regime:"TREND_UP",netR:-0.1,closedAt:date});
  rows.push({tradeId:id,variant:"DELAY_1_BAR",side:"LONG",regime:"TREND_UP",netR:0.25,closedAt:date});
}
const candidates=research.evaluatePolicy(rows);
assert.ok(candidates.some(p=>p.variant==="DELAY_1_BAR"&&p.testSamples>=15&&p.testUpliftR>=0.1));

const exitRows=[];
for(let i=0;i<60;i++){
  const tradeId="exit-"+i;
  const closedAt=Date.UTC(2026,0,1)+i*86400000;
  exitRows.push({tradeId,variant:"BASELINE",side:"LONG",regime:"TREND_UP",netR:-0.1,closedAt,hypothetical:false});
  exitRows.push({tradeId,variant:"EXIT_LEVEL:S1.200:T1.400",side:"LONG",regime:"TREND_UP",
    stopScale:1.2,targetScale:1.4,netR:0.5,closedAt,hypothetical:true});
  exitRows.push({tradeId,variant:"EXIT_LEVEL:S0.700:T0.800",side:"LONG",regime:"TREND_UP",
    stopScale:0.7,targetScale:0.8,netR:-0.5,closedAt,hypothetical:true});
}
const learnedExit=research.evaluateExitPolicies(exitRows);
assert.ok(learnedExit.some(p=>p.variant==="EXIT_LEVEL:S1.200:T1.400" &&
  p.trainSamples>=research.MIN_TRAIN && p.testSamples>=research.MIN_TEST && p.testUpliftR>0),
  "exit optimizer must select data-derived stop/target ratios only after chronological out-of-sample validation");

// Earlier entries require a causal setup at the earlier close and enter at the next open.
const rising = Array.from({length: 50}, (_, i) => {
  const open = 100 + i;
  return [i * 900000, open, open + 0.4, open - 0.4, open + 0.2, 10 + i / 10, (i + 1) * 900000 - 1];
});
const earlyGate = research.validateEarlierSetup(research.normalizeCandles(rising), 33, "LONG");
assert.equal(earlyGate.valid, true);
assert.equal(research.validateEarlierSetup(research.normalizeCandles(rising), 33, "SHORT").valid, false);
const earlyVariants = research.buildVariants({tradeId:"early-test",side:"LONG",entry:135.2,sl:133.2,tp:139.2,entryTime:35*900000,realizedR:0.5}, rising);
assert.ok(earlyVariants.some(v => v.variant === "EARLIER_1_BAR" && v.signalGate === "CAUSAL_EMA_MOMENTUM_CONFIRMED"));
assert.ok(earlyVariants.some(v => v.variant === "EARLIER_2_BAR" && v.signalIndex < 34));
// Flat data must not produce an earlier entry: no independent momentum setup.
const flat = Array.from({length: 50}, (_, i) => [i*900000,100,100.2,99.8,100,10,(i+1)*900000-1]);
const flatVariants = research.buildVariants({tradeId:"flat-test",side:"LONG",entry:100,sl:98,tp:104,entryTime:35*900000,realizedR:0},flat);
assert.ok(!flatVariants.some(v => v.variant === "EARLIER_1_BAR" || v.variant === "EARLIER_2_BAR"));

const tags = research.featureTags({extensionAtr:2.1, rsi14:72, momentum4:0.03, falseBreakoutRisk:0.7, volumeRatio:0.6});
assert.ok(tags.includes("EXTENDED_ENTRY"));
assert.ok(tags.includes("MOMENTUM_EXHAUSTION"));
assert.ok(tags.includes("RSI_OVERBOUGHT"));
assert.ok(tags.includes("FALSE_BREAKOUT_RISK"));
assert.ok(tags.includes("LOW_VOLUME"));
const contextualRows = [];
for (let i = 0; i < 12; i++) {
  const closedAt = Date.UTC(2026, 0, 1) + i * 86400000;
  const tradeId = "context-" + i;
  contextualRows.push({tradeId, variant:"BASELINE", side:"LONG", regime:"TREND_UP", netR:-1, closedAt, hypothetical:false});
  contextualRows.push({tradeId, variant:"OPPOSITE_SIDE", side:"SHORT", regime:"TREND_UP", netR:0.5, closedAt, hypothetical:true, features:["EXTENDED_ENTRY","MOMENTUM_EXHAUSTION"]});
}
const contextualAdvice = research.pairedVariantEvidence(contextualRows,
  {extensionAtr:2.0, rsi14:70, momentum4:0.02}, "TREND_UP");
assert.ok(contextualAdvice.some(p => p.variant === "OPPOSITE_SIDE" && p.side === "SHORT"));
assert.ok(contextualAdvice[0].testUpliftR > contextualAdvice[0].standardError);

console.log("nine-ai-counterfactual-research.test.js: OK");
