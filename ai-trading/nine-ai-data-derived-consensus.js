"use strict";

// Learns the live vote gate from the decision journal's chronological forward
// outcomes. Candidate vote and rank thresholds are drawn from observed rows;
// no fixed 4-of-7 rule is used by the live strategy after initialization.
// Statistical qualification is intentionally separate from capital controls.
const JOURNAL = "nine_ai_decision_journal";
const POLICIES = "nine_ai_data_derived_consensus_policies";
const REPORTS = "nine_ai_data_derived_consensus_reports";
const MAX_ROWS = 10000;
const MIN_TRAIN = 40;
const MIN_TEST = 20;
const MAX_CONDITION_COMPLEXITY = 8;
const MAX_ATOMS = 64;
let journal = null;
let policyCollection = null;
let reportCollection = null;
let activePolicies = [];
let running = false;

const number = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function votes(row) {
  const counts = { LONG: 0, SHORT: 0 };
  for (const role of Array.isArray(row?.roles) ? row.roles : []) {
    if (["Decision AI", "Risk Manager AI"].includes(role?.name)) continue;
    if (role?.side === "LONG" || role?.side === "SHORT") counts[role.side]++;
  }
  return counts;
}

function outcome(row, side, horizon) {
  return number(row?.evaluations?.[String(horizon)]?.[side.toLowerCase() + "NetR"]);
}

function normalizeRows(source) {
  const latest = new Map();
  for (const row of source || []) {
    const time = number(row?.signalTime);
    const regime = String(row?.marketRegime || "UNKNOWN").toUpperCase();
    const rank = number(row?.rankScore);
    const counts = votes(row);
    const outcomes = [outcome(row, "LONG", 4), outcome(row, "LONG", 16),
      outcome(row, "SHORT", 4), outcome(row, "SHORT", 16)];
    if (!Number.isFinite(time) || rank === null || !outcomes.every(Number.isFinite)) continue;
    const normalized = { symbol: String(row.symbol || "UNKNOWN"), signalTime: time,
      scannedAt: new Date(row.scannedAt || time).getTime(), regime, rank,
      long: counts.LONG, short: counts.SHORT,
      features: { ...(row.features || {}), ...(row.windowFeatures || {}),
        longVotes: counts.LONG, shortVotes: counts.SHORT,
        voteMargin: counts.LONG - counts.SHORT },
      longR: average(outcomes.slice(0, 2)), shortR: average(outcomes.slice(2)) };
    const key = normalized.symbol + ":" + time;
    const previous = latest.get(key);
    if (!previous || normalized.scannedAt > previous.scannedAt) latest.set(key, normalized);
  }
  const chronological = [...latest.values()].sort((a, b) => a.signalTime - b.signalTime || a.scannedAt - b.scannedAt);
  // Forward labels overlap for 16 candles. Keep non-overlapping per-symbol
  // opportunities so repeated scans cannot inflate the research sample.
  const independent = [];
  const lastBySymbol = new Map();
  for (const row of chronological) {
    const previous = lastBySymbol.get(row.symbol);
    if (previous != null && row.signalTime - previous < 16 * 15 * 60 * 1000) continue;
    independent.push(row);
    lastBySymbol.set(row.symbol, row.signalTime);
  }
  return independent;
}

function candidateValues(sourceValues) {
  const values = [...new Set(sourceValues.filter(Number.isFinite))].sort((a, b) => a - b);
  if (values.length <= 24) return values;
  const result = new Set();
  for (let i = 1; i <= 24; i++) result.add(values[Math.floor(i * (values.length - 1) / 25)]);
  return [...result].sort((a, b) => a - b);
}

function selectSide(row, policy) {
  if (policy.type === "FEATURE_RULE") {
    if (row.rank < policy.minimumRank || !matchesConditionTree(row.features, policy.conditionTree || {
      operator: policy.conditionMode || "AND", conditions: policy.conditions || []
    })) return null;
    return policy.side;
  }
  const long = row.long >= policy.minimumVotes && row.long - row.short >= policy.minimumMargin;
  const short = row.short >= policy.minimumVotes && row.short - row.long >= policy.minimumMargin;
  if (long === short) return null;
  if (row.rank < policy.minimumRank) return null;
  return long ? "LONG" : "SHORT";
}

function matchesConditions(features = {}, conditions = []) {
  return conditions.length > 0 && conditions.every(condition => {
    const value = number(features?.[condition.feature]);
    if (value === null || !Number.isFinite(Number(condition.threshold))) return false;
    return condition.operator === "gte" ? value >= condition.threshold :
      condition.operator === "lte" ? value <= condition.threshold : false;
  });
}

function matchesConditionTree(features = {}, tree = {}) {
  if (Array.isArray(tree.conditions)) {
    if (!tree.conditions.length) return false;
    const results = tree.conditions.map(condition => matchesConditions(features, [condition]));
    return tree.operator === "OR" ? results.some(Boolean) : results.every(Boolean);
  }
  return Array.isArray(tree.children) && tree.children.length > 0 &&
    (tree.operator === "OR" ? tree.children.some(child => matchesConditionTree(features, child))
      : tree.children.every(child => matchesConditionTree(features, child)));
}

function evaluate(rows, policy, confidenceMultiplier = 1.96) {
  const picked = rows.map(row => {
    const side = selectSide(row, policy);
    return side ? { row, side, r: side === "LONG" ? row.longR : row.shortR } : null;
  }).filter(Boolean);
  const values = picked.map(item => item.r);
  const meanR = average(values);
  const variance = values.length ? average(values.map(value => (value - meanR) ** 2)) : null;
  const standardError = values.length > 1 ? Math.sqrt(variance / values.length) : Infinity;
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return { samples: values.length, expectancyR: meanR,
    lowerBoundR: Number.isFinite(standardError) ? meanR - confidenceMultiplier * standardError : null,
    standardError: Number.isFinite(standardError) ? standardError : null,
    winRate: values.length ? values.filter(value => value > 0).length / values.length : null,
    totalR: values.reduce((sum, value) => sum + value, 0), maxDrawdownR };
}

function learnPolicies(sourceRows) {
  const rows = normalizeRows(sourceRows);
  const regimes = [...new Set(rows.map(row => row.regime))];
  const policies = [];
  const reports = [];
  for (const regime of regimes) {
    const group = rows.filter(row => row.regime === regime);
    if (group.length < MIN_TRAIN + MIN_TEST) continue;
    const split = Math.floor(group.length * 0.7);
    const train = group.slice(0, split), test = group.slice(split);
    // Candidate thresholds come strictly from the training partition.
    const voteLimits = candidateValues(train.flatMap(row => [row.long, row.short]));
    const margins = candidateValues(train.map(row => Math.abs(row.long - row.short)));
    const ranks = candidateValues(train.map(row => row.rank));
    const featureNames = [...new Set(train.flatMap(row => Object.entries(row.features)
      .filter(([, value]) => number(value) !== null).map(([name]) => name)))];
    const featureGrid = [];
    for (const feature of featureNames) {
      const thresholds = candidateValues(train.map(row => number(row.features[feature])).filter(Number.isFinite));
      for (const threshold of thresholds) for (const operator of ["gte", "lte"])
        featureGrid.push({ feature, operator, threshold });
    }
    // Keep a deterministic, data-ranked atom pool, then compose those atoms
    // into multi-condition AND/OR genomes. The grammar is intentionally data
    // only: it can invent predicates and combinations without executing code.
    const atomScored = featureGrid.map(atom => {
      const picked = train.filter(row => matchesConditions(row.features, [atom]));
      const support = picked.length;
      // Atom ordering favors features that partition outcomes, including
      // interactions whose individual edge is weak.
      const longShift = (average(picked.map(row => row.longR)) || 0) - (average(train.map(row => row.longR)) || 0);
      const shortShift = (average(picked.map(row => row.shortR)) || 0) - (average(train.map(row => row.shortR)) || 0);
      const partitionEdge = Math.max(Math.abs(longShift), Math.abs(shortShift));
      return { atom, support, partitionEdge };
    }).filter(item => item.support >= MIN_TRAIN && item.support <= train.length * 0.95)
      .sort((a, b) => b.partitionEdge - a.partitionEdge || b.support - a.support)
      .slice(0, MAX_ATOMS);
    const diverseAtoms = [];
    const perFeature = new Map();
    for (const item of atomScored) {
      const count = perFeature.get(item.atom.feature) || 0;
      if (count >= 3) continue;
      perFeature.set(item.atom.feature, count + 1);
      diverseAtoms.push(item);
    }
    const atoms = diverseAtoms.slice(0, MAX_ATOMS).map(item => item.atom);
    const featureGenomes = new Map();
    const maxConditionsSearched = Math.min(MAX_CONDITION_COMPLEXITY,
      Math.max(1, Math.floor(Math.log2(train.length / MIN_TRAIN))));
    const addGenome = (conditions, operator, side, conditionTree = null) => {
      if (!conditions.length || conditions.length > maxConditionsSearched) return null;
      const ordered = [...conditions].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const genome = { type: "FEATURE_RULE", side, minimumRank: -Infinity,
        conditionMode: operator, conditions: ordered, ...(conditionTree ? { conditionTree } : {}) };
      const key = JSON.stringify(genome);
      if (!featureGenomes.has(key)) featureGenomes.set(key, genome);
      return featureGenomes.get(key);
    };
    for (const atom of atoms) for (const side of ["LONG", "SHORT"]) addGenome([atom], "AND", side);
    // Beam-expand observed predicates into longer, mixed AND/OR genomes.
    // Search depth grows with the amount of independent training evidence,
    // up to a compute-bounded maximum; the trading rules themselves come
    // from observed feature thresholds, not a catalogue of hand-written setups.
    let beam = [...featureGenomes.values()].map(genome => ({ genome,
      stats: evaluate(train, genome, 0) }))
      .filter(item => item.stats.samples >= MIN_TRAIN)
      .sort((a, b) => b.stats.expectancyR - a.stats.expectancyR).slice(0, 48);
    for (let depth = 2; depth <= maxConditionsSearched && beam.length; depth++) {
      const priorSize = featureGenomes.size;
      for (const { genome } of beam) for (const atom of atoms) {
        if (genome.conditions.some(condition => JSON.stringify(condition) === JSON.stringify(atom))) continue;
        const parent = genome.conditionTree || { operator: genome.conditionMode, conditions: genome.conditions };
        const leaf = { operator: "AND", conditions: [atom] };
        for (const operator of ["AND", "OR"]) for (const side of ["LONG", "SHORT"])
          addGenome([...genome.conditions, atom], operator, side,
            { operator, children: [parent, leaf] });
      }
      const generation = [...featureGenomes.values()].slice(priorSize);
      beam = generation.map(genome => ({ genome, stats: evaluate(train, genome, 0) }))
        .filter(item => item.stats.samples >= MIN_TRAIN)
        .sort((a, b) => b.stats.expectancyR - a.stats.expectancyR ||
          b.stats.totalR - a.stats.totalR).slice(0, 48);
    }
    featureGrid.length = 0;
    featureGrid.push(...featureGenomes.values());
    const comparisonCount = Math.max(1, voteLimits.length * margins.length * ranks.length + featureGrid.length);
    const confidenceMultiplier = Math.sqrt(2 * Math.log(2 * comparisonCount / 0.01));
    const candidates = [];
    for (const minimumVotes of voteLimits) for (const minimumMargin of margins) for (const minimumRank of ranks) {
      const params = { minimumVotes, minimumMargin, minimumRank };
      const trainResult = evaluate(train, params, confidenceMultiplier);
      if (trainResult.samples < MIN_TRAIN || !(trainResult.lowerBoundR > 0)) continue;
      candidates.push({ regime, type: "VOTE_GATE", ...params, train: trainResult });
    }
    const featureSeeds = featureGrid.map(genome => ({ genome,
      stats: evaluate(train, { ...genome, minimumRank: -Infinity }, confidenceMultiplier) }))
      .filter(item => item.stats.samples >= MIN_TRAIN)
      .sort((a, b) => b.stats.expectancyR - a.stats.expectancyR ||
        b.stats.lowerBoundR - a.stats.lowerBoundR).slice(0, 32);
    for (const { genome } of featureSeeds) for (const minimumRank of ranks) {
      const params = { ...genome, minimumRank };
      const trainResult = evaluate(train, params, confidenceMultiplier);
      if (trainResult.samples < MIN_TRAIN || !(trainResult.lowerBoundR > 0)) continue;
      candidates.push({ regime, ...params, train: trainResult });
    }
    candidates.sort((a, b) => b.train.lowerBoundR - a.train.lowerBoundR ||
      b.train.totalR - a.train.totalR || a.train.maxDrawdownR - b.train.maxDrawdownR);
    // Select from training data only, then evaluate exactly one winner on the
    // untouched chronological holdout to avoid repeatedly fishing the test set.
    const proposed = candidates[0] || null;
    const testResult = proposed ? evaluate(test, proposed, confidenceMultiplier) : null;
    const selected = testResult && testResult.samples >= MIN_TEST && testResult.lowerBoundR > 0
      ? { ...proposed, test: testResult } : null;
    reports.push({ regime, totalRows: group.length, trainRows: train.length,
      testRows: test.length, candidatesTested: comparisonCount,
      maximumConditionComplexitySearched: maxConditionsSearched,
      qualifiedCandidates: candidates.length, selected });
    if (selected) policies.push({ policyId: "data-consensus:" + regime,
      mode: selected.type === "FEATURE_RULE" ? "OBSERVED_COMPOSED_FEATURE_GENOME_CHRONOLOGICAL_HOLDOUT"
        : "OBSERVED_VOTE_AND_RANK_THRESHOLDS_CHRONOLOGICAL_HOLDOUT",
      status: "ACTIVE", regime, type: selected.type || "VOTE_GATE", side: selected.side || null,
      conditions: selected.conditions || [], conditionMode: selected.conditionMode || null,
      conditionTree: selected.type === "FEATURE_RULE" ? (selected.conditionTree || {
        operator: selected.conditionMode || "AND", conditions: selected.conditions || [] }) : null,
      minimumVotes: selected.minimumVotes ?? null,
      minimumMargin: selected.minimumMargin ?? null, minimumRank: selected.minimumRank,
      train: selected.train, test: selected.test, samples: group.length });
  }
  return { rows: rows.length, policies, reports };
}

async function initialize(db) {
  if (!db || typeof db.collection !== "function") throw new Error("NINE_AI_CONSENSUS_MONGODB_REQUIRED");
  journal = db.collection(JOURNAL);
  policyCollection = db.collection(POLICIES);
  reportCollection = db.collection(REPORTS);
  await journal.createIndex({ outcomeStatus: 1, signalTime: -1 }, { name: "nine_ai_decision_status_time" });
  await policyCollection.createIndex({ regime: 1, status: 1 }, { name: "nine_ai_consensus_active" });
  activePolicies = await policyCollection.find({ status: "ACTIVE" }).toArray();
  return { ready: true, activePolicies: activePolicies.length };
}

async function runResearchCycle({ now = new Date() } = {}) {
  if (!journal || !policyCollection || !reportCollection) throw new Error("NINE_AI_CONSENSUS_NOT_INITIALIZED");
  if (running) return { status: "SKIPPED", reason: "CYCLE_ALREADY_RUNNING" };
  running = true;
  try {
    const sourceRows = await journal.find({ outcomeStatus: "EVALUATED" })
      .sort({ outcomeStatus: 1, signalTime: -1 }).hint({ outcomeStatus: 1, signalTime: -1 })
      .limit(MAX_ROWS).toArray();
    const learned = learnPolicies(sourceRows);
    // Never retire a live policy merely because this cycle found no replacement.
    // A policy is replaced only after a new policy for the same regime has passed
    // the chronological holdout validation above.
    for (const policy of learned.policies) {
      const stored = { ...policy, updatedAt: new Date(now) };
      await policyCollection.updateOne({ policyId: policy.policyId }, { $set: stored }, { upsert: true });
    }
    activePolicies = await policyCollection.find({ status: "ACTIVE" }).toArray();
    const report = { createdAt: new Date(now), status: "COMPLETED", rows: learned.rows,
      qualifiedPolicies: learned.policies.length, regimes: learned.reports,
      researchSemantics: "HYPOTHETICAL_FORWARD_CLOSES_NOT_EXECUTED_PNL",
      deploymentSemantics: "ONLY_CHRONOLOGICAL_OUT_OF_SAMPLE_POSITIVE_EXPECTANCY" };
    await reportCollection.insertOne(report);
    return { status: report.status, rows: learned.rows, activePolicies: activePolicies.length,
      regimes: learned.reports.length };
  } finally { running = false; }
}

function assessPolicy(roles, policy, rankScore, features = {}) {
  if (!policy) return { ready: false, allowed: false, side: null, reason: "NO_VALIDATED_DATA_DERIVED_POLICY" };
  const row = { long: 0, short: 0, rank: number(rankScore) ?? 0, features };
  for (const role of Array.isArray(roles) ? roles : []) {
    if (["Decision AI", "Risk Manager AI"].includes(role?.name)) continue;
    if (role?.side === "LONG" || role?.side === "SHORT") row[role.side === "LONG" ? "long" : "short"]++;
  }
  const liveFeatures = { ...features, longVotes: row.long, shortVotes: row.short,
    voteMargin: row.long - row.short, rankScore: number(rankScore) ?? 0 };
  const side = selectSide({ ...row, features: liveFeatures, rank: policy.minimumRank }, policy);
  const rankAllowed = rankScore == null ? null : number(rankScore) >= Number(policy.minimumRank);
  return { ready: true, allowed: Boolean(side), side,
    rankAllowed,
    reason: !side ? "VALIDATED_DATA_DERIVED_POLICY_WAIT" : rankAllowed === false
      ? "VALIDATED_DATA_DERIVED_RANK_BELOW_LEARNED_THRESHOLD" : "VALIDATED_DATA_DERIVED_POLICY_MATCH",
    policyId: policy.policyId, parameters: { minimumVotes: policy.minimumVotes,
      minimumMargin: policy.minimumMargin, minimumRank: policy.minimumRank },
    test: policy.test };
}

function assessLive(roles, regime, rankScore, features = {}) {
  const key = String(regime || "UNKNOWN").toUpperCase();
  const policy = activePolicies.find(item => item.status === "ACTIVE" && item.regime === key);
  return assessPolicy(roles, policy, rankScore, features);
}

function status() { return { initialized: Boolean(journal), activePolicies: activePolicies.length, policies: activePolicies }; }

module.exports = { MIN_TRAIN, MIN_TEST, MAX_CONDITION_COMPLEXITY, votes, normalizeRows, candidateValues, selectSide,
  evaluate, learnPolicies, initialize, runResearchCycle, assessPolicy, assessLive, status };
