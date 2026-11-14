"use strict";

const EVENT_RULES = [
  ["fed_hawkish", /\b(fed|fomc|powell|central bank).{0,55}\b(hawkish|higher for longer|keep rates high|tighten|restrictive)\b|\bhawkish.{0,45}\b(fed|fomc|powell|rates)\b/i, 3, 120],
  ["fed_dovish", /\b(fed|fomc|powell|central bank).{0,55}\b(dovish|rate cuts?|easing|lower rates|pivot)\b|\bdovish.{0,45}\b(fed|fomc|powell|rates)\b/i, 3, 120],
  ["rate_hike", /\b(rate hike|raises? interest rates?|increases? rates?|tightening cycle)\b/i, 3, 120],
  ["rate_cut", /\b(rate cut|cuts? interest rates?|lowers? rates?|easing cycle)\b/i, 3, 120],
  ["inflation_hot", /\b(hotter|higher|sticky|rising|accelerating)\b.{0,35}\b(inflation|cpi|pce|prices)\b|\b(inflation|cpi|pce).{0,35}\b(hotter|higher|sticky|accelerates?|surges?)\b/i, 2, 72],
  ["inflation_cool", /\b(cooling|cooler|slowing|lower|eases?)\b.{0,35}\b(inflation|cpi|pce|prices)\b|\b(inflation|cpi|pce).{0,35}\b(cools?|slows?|falls?|eases?)\b/i, 2, 72],
  ["jobs_strong", /\b(strong|better-than-expected|beats? estimates?|accelerat(?:es|ed|ing))\b.{0,35}\b(jobs?|payrolls?|employment|wages?)\b|\b(nfp|nonfarm payrolls?).{0,35}\b(strong|beats?|surges?)\b/i, 2, 72],
  ["jobs_weak", /\b(weak|worse-than-expected|miss(?:es|ed)? estimates?|slows?|falls?)\b.{0,35}\b(jobs?|payrolls?|employment|wages?)\b|\b(unemployment).{0,35}\b(rises?|jumps?|higher)\b/i, 2, 72],
  ["growth_strong", /\b(gdp|economic growth|business activity|pmi).{0,35}\b(strong|accelerat|expan|beats?|higher)\b|\b(strong|accelerating|robust).{0,30}\b(gdp|growth|pmi|economy)\b/i, 2, 96],
  ["growth_weak", /\b(gdp|economic growth|business activity|pmi).{0,35}\b(weak|contract|slows?|miss|lower)\b|\b(recession|economic contraction|manufacturing contracts?)\b/i, 2, 96],
  ["yield_up", /\b(treasury yields?|bond yields?|10-year yield|real yields?).{0,30}\b(rise|rises|rising|jump|surge|higher|climb)\b/i, 2, 48],
  ["yield_down", /\b(treasury yields?|bond yields?|10-year yield|real yields?).{0,30}\b(fall|falls|falling|drop|decline|lower|slump)\b/i, 2, 48],
  ["usd_up", /\b(dollar|us dollar|dxy).{0,25}\b(strengthens?|rises?|surges?|higher|gains?)\b/i, 2, 48],
  ["usd_down", /\b(dollar|us dollar|dxy).{0,25}\b(weakens?|falls?|drops?|lower|declines?)\b/i, 2, 48],
  ["supply_disruption", /\b(supply disruption|supply outage|production outage|pipeline attack|shipping disruption|strait.{0,15}closed|production cuts?|output cuts?)\b/i, 3, 120],
  ["supply_increase", /\b(output increase|production increase|raises? output|supply glut|oversupply|record production)\b/i, 2, 96],
  ["opec_cut", /\b(opec|opec\+).{0,50}\b(cut|cuts|reduce|reduces|lower).{0,20}\b(production|output)\b/i, 3, 120],
  ["opec_raise", /\b(opec|opec\+).{0,50}\b(raise|raises|increase|increases|boost).{0,20}\b(production|output)\b/i, 2, 120],
  ["inventory_build", /\b(inventories|crude stocks|oil stocks).{0,30}\b(build|builds|rise|rises|increase|higher|larger)\b|\b(inventory build|stockpile increase)\b/i, 2, 48],
  ["inventory_draw", /\b(inventories|crude stocks|oil stocks).{0,30}\b(draw|draws|fall|falls|decline|lower|shrink)\b|\b(inventory draw)\b/i, 2, 48],
  ["geopolitical_escalation", /\b(war|invasion|missile|airstrike|military escalation|attack|armed conflict|escalation|blockade)\b/i, 3, 120],
  ["ceasefire", /\b(ceasefire|peace deal|peace agreement|de-escalation|truce|diplomatic breakthrough)\b/i, 2, 96],
  ["sanctions", /\b(new sanctions|sanctions imposed|embargo|trade restrictions|asset freeze)\b/i, 2, 120],
  ["tariffs", /\b(tariff|trade war|import duties|export restrictions)\b/i, 2, 96],
  ["gold_demand", /\b(central bank.{0,30}gold purchases?|gold buying|gold demand|gold etf inflows?|bullion inflows?)\b/i, 2, 120],
  ["gold_outflow", /\b(gold etf outflows?|gold selling|bullion outflows?|gold demand weakens?)\b/i, 2, 96],
  ["risk_off", /\b(market selloff|risk aversion|flight to safety|safe haven demand|banking crisis|financial crisis|liquidity crisis)\b/i, 2, 72],
  ["risk_on", /\b(risk appetite improves?|risk-on|relief rally|market optimism|investor optimism)\b/i, 1, 48],
  ["earnings_strong", /\b(earnings beat|profit beats?|raises? guidance|record profits?|revenue beats?)\b/i, 2, 72],
  ["earnings_weak", /\b(earnings miss|profit warning|cuts? guidance|loss widens?|revenue misses?)\b/i, 2, 72]
];

const IMPACT = {
  gold: { fed_hawkish:-1.5, fed_dovish:1.5, rate_hike:-1.5, rate_cut:1.5, inflation_hot:-0.35, inflation_cool:0.45, jobs_strong:-0.55, jobs_weak:0.7, growth_strong:-0.35, growth_weak:0.55, yield_up:-1.2, yield_down:1.2, usd_up:-1.1, usd_down:1.1, supply_disruption:0.35, geopolitical_escalation:1.2, ceasefire:-0.55, sanctions:0.35, gold_demand:1.5, gold_outflow:-1.5, risk_off:0.9, risk_on:-0.35, tariffs:0.25 },
  energy: { supply_disruption:1.6, supply_increase:-1.25, opec_cut:1.5, opec_raise:-1.1, inventory_build:-1, inventory_draw:1, geopolitical_escalation:0.9, ceasefire:-0.4, sanctions:0.8, growth_strong:0.8, growth_weak:-0.9, risk_off:-0.25, tariffs:-0.25 },
  gasoline: { supply_disruption:1.35, supply_increase:-1.1, opec_cut:1, opec_raise:-0.9, inventory_build:-1, inventory_draw:1, geopolitical_escalation:0.65, ceasefire:-0.3, sanctions:0.55, growth_strong:0.75, growth_weak:-0.8 },
  stocks: { fed_hawkish:-1.35, fed_dovish:1.35, rate_hike:-1.4, rate_cut:1.25, inflation_hot:-0.75, inflation_cool:0.8, jobs_strong:0.45, jobs_weak:-0.6, growth_strong:1, growth_weak:-1.1, yield_up:-0.8, yield_down:0.7, usd_up:-0.15, usd_down:0.15, geopolitical_escalation:-0.9, ceasefire:0.5, risk_off:-1, risk_on:0.8, earnings_strong:1.2, earnings_weak:-1.2, tariffs:-0.7 },
  macro: { fed_hawkish:0.5, fed_dovish:-0.5, rate_hike:0.6, rate_cut:-0.6, inflation_hot:0.6, inflation_cool:-0.4, jobs_strong:0.6, jobs_weak:-0.6, growth_strong:1, growth_weak:-1, yield_up:0.4, yield_down:-0.4 },
  usd: { fed_hawkish:1.4, fed_dovish:-1.4, rate_hike:1.4, rate_cut:-1.4, inflation_hot:0.55, inflation_cool:-0.4, jobs_strong:0.65, jobs_weak:-0.65, growth_strong:0.5, growth_weak:-0.5, yield_up:1, yield_down:-1, risk_off:0.8, risk_on:-0.35, geopolitical_escalation:0.35 },
  geopolitics: { geopolitical_escalation:1.5, ceasefire:-1.2, sanctions:0.9, tariffs:0.6, risk_off:0.5 },
  metals: { fed_hawkish:-0.8, fed_dovish:0.8, rate_hike:-0.8, rate_cut:0.8, usd_up:-0.7, usd_down:0.7, yield_up:-0.7, yield_down:0.7, geopolitical_escalation:0.45, gold_demand:0.35, growth_strong:0.4, growth_weak:-0.25 }
};

const DEFAULT_HORIZONS = [
  { id:"24h", label:"24 GIỜ", hours:24, halfLife:18 },
  { id:"3d", label:"3 NGÀY", hours:72, halfLife:48 },
  { id:"7d", label:"7 NGÀY", hours:168, halfLife:96 },
  { id:"30d", label:"30 NGÀY", hours:720, halfLife:240 }
];

function classifyHeadline(title, assetId = "macro") {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  const matched = EVENT_RULES.filter(rule => rule[1].test(text));
  const impactMap = IMPACT[assetId] || {};
  const impacts = matched.map(rule => ({ type:rule[0], score:Number(impactMap[rule[0]] || 0), severity:rule[2], halfLife:rule[3] }))
    .filter(item => item.score !== 0);
  const impactScore = impacts.slice(0, 2).reduce((sum, item) => sum + item.score, 0);
  const primary = matched[0] || null;
  return {
    eventType: primary ? primary[0] : "unclassified",
    eventTypes: matched.map(item => item[0]).slice(0, 4),
    impactScore: Math.max(-3, Math.min(3, impactScore)),
    sentiment: impactScore > 0.15 ? "positive" : impactScore < -0.15 ? "negative" : "neutral",
    importance: Math.min(10, primary ? 4 + primary[2] * 2 + Math.min(2, matched.length - 1) : 2),
    relevance: primary && impacts.length ? 1 : primary ? 0.55 : 0.25,
    eventHalfLifeHours: primary ? primary[3] : 24
  };
}

function scoreNews(title, assetId = "macro") {
  const item = classifyHeadline(title, assetId);
  return { score:item.impactScore, label:item.sentiment, importance:item.importance, eventType:item.eventType };
}

function directionFromScore(score, threshold = 0.55) {
  if (score >= threshold) return "BULLISH";
  if (score <= -threshold) return "BEARISH";
  return "NEUTRAL";
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function tanh(value) { return Math.tanh ? Math.tanh(value) : (Math.exp(2 * value) - 1) / (Math.exp(2 * value) + 1); }
function ageHours(date, now) {
  const time = new Date(date || now).getTime();
  return Number.isFinite(time) ? Math.max(0, (now - time) / 3600000) : 9999;
}
function momentumFor(quote, horizon) {
  if (!quote) return null;
  const raw = (quote.momentum || {})[horizon] ?? (horizon === "24h" ? quote.changePercent : null);
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function marketMomentumScore(quote, horizon) {
  const change = momentumFor(quote, horizon);
  if (change === null) return null;
  const rawVolatility = Number(quote.volatilityPct);
  const volatility = Number.isFinite(rawVolatility) && rawVolatility > 0 ? Math.max(0.15, rawVolatility) : 0.8;
  const days = horizon === "24h" ? 1 : horizon === "3d" ? 3 : horizon === "7d" ? 7 : horizon === "30d" ? 30 : 1;
  const score = tanh(change / (volatility * Math.sqrt(days))) * 1.8;
  return Number.isFinite(score) ? clamp(score, -1.8, 1.8) : null;
}

const NEWS_STOP_WORDS = new Set([
  "the","a","an","and","or","to","of","in","on","for","from","with","as","at","by","after","before",
  "is","are","was","were","be","been","being","will","would","could","should","may","might","says","said",
  "over","under","into","amid","its","their","this","that","these","those","new","latest","update","report",
  "market","markets","price","prices","today","week","daily","what","how","why","more","than"
]);

function newsTokens(title) {
  return new Set(String(title || "").toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(token => token.length > 2 && !NEWS_STOP_WORDS.has(token)));
}

function dedupeNewsEvents(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = String(item.assetId || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const unique = [];
  for (const group of groups.values()) {
    const clusters = [];
    for (const item of group) {
      const tokens = newsTokens(item.title);
      const published = new Date(item.publishedAt || 0).getTime();
      let match = null;
      for (const cluster of clusters) {
        const reference = cluster[0];
        const referenceTime = new Date(reference.publishedAt || 0).getTime();
        if (Number.isFinite(published) && Number.isFinite(referenceTime) && Math.abs(published - referenceTime) > 12 * 3600000) continue;
        const referenceTokens = newsTokens(reference.title);
        const intersection = [...tokens].filter(token => referenceTokens.has(token)).length;
        const union = new Set([...tokens, ...referenceTokens]).size || 1;
        const similarity = intersection / union;
        const sameEventType = item.eventType && item.eventType !== "unclassified" && item.eventType === reference.eventType;
        if ((similarity >= 0.62 && intersection >= 3) || (sameEventType && intersection >= 3 && similarity >= 0.45)) {
          match = cluster;
          break;
        }
      }
      if (match) match.push(item);
      else clusters.push([item]);
    }
    for (const cluster of clusters) {
      cluster.sort((left, right) => {
        const score = item => Number(item.sourceWeight || 0.8) * Number(item.importance || 1) * Number(item.relevance || 0.5);
        return score(right) - score(left);
      });
      const representative = { ...cluster[0], corroboratingSources:[...new Set(cluster.map(item => item.source).filter(Boolean))] };
      unique.push(representative);
    }
  }
  return unique;
}

function buildHorizon(asset, news, markets, horizon, config, now) {
  news = dedupeNewsEvents(news);
  const drivers = [];
  const risks = [];
  let newsSum = 0, newsWeight = 0, newsCount = 0;
  for (const item of news) {
    const impact = Number(item.impactScore ?? (item.sentiment === "positive" ? 0.5 : item.sentiment === "negative" ? -0.5 : 0));
    if (!impact) continue;
    const age = ageHours(item.publishedAt, now);
    if (age > Number(config.analysis?.maxNewsAgeHours || 720)) continue;
    const freshness = Math.exp(-Math.LN2 * age / horizon.halfLife);
    const source = clamp(Number(item.sourceWeight || 0.8), 0.35, 1.25);
    const importance = clamp(Number(item.importance || 3) / 6, 0.35, 1.5);
    const relevance = clamp(Number(item.relevance || 0.7), 0.2, 1);
    const weight = freshness * source * importance * relevance;
    newsSum += impact * weight;
    newsWeight += weight;
    newsCount++;
    const label = String(item.title || "Tin tức") + " [" + String(item.eventType || "event") + "]";
    if (impact > 0 && drivers.length < 5) drivers.push(label);
    if (impact < 0 && risks.length < 4) risks.push(label);
  }
  const newsScore = newsWeight ? clamp(newsSum / newsWeight, -1.8, 1.8) : 0;

  const ownQuotes = markets.filter(item => item.assetId === asset.id);
  const ownScores = ownQuotes.map(item => ({ item, score:marketMomentumScore(item, horizon.id) })).filter(item => item.score !== null);
  const ownMomentum = ownScores.length ? ownScores.reduce((sum, item) => sum + item.score, 0) / ownScores.length : 0;
  for (const item of ownScores) {
    const pct = momentumFor(item.item, horizon.id);
    const label = item.item.symbol + " " + horizon.id + ": " + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
    if (pct > 0 && drivers.length < 5) drivers.push(label);
    if (pct < 0 && risks.length < 4) risks.push(label);
  }

  let crossScore = 0, crossCount = 0;
  const dxy = markets.find(item => item.symbol === "DX-Y.NYB");
  const yields = markets.find(item => item.symbol === "^TNX");
  if (asset.id === "gold" || asset.id === "metals") {
    for (const pair of [[dxy, -0.55, "USD/DXY"], [yields, -0.5, "US 10Y yield"]]) {
      const value = marketMomentumScore(pair[0], horizon.id);
      if (value === null) continue;
      crossScore += value * pair[1];
      crossCount++;
      const raw = momentumFor(pair[0], horizon.id);
      if (raw * pair[1] > 0 && drivers.length < 5) drivers.push(pair[2] + ": " + raw.toFixed(2) + "%");
      if (raw * pair[1] < 0 && risks.length < 4) risks.push(pair[2] + ": " + raw.toFixed(2) + "%");
    }
  } else if (asset.id === "stocks" && yields) {
    const value = marketMomentumScore(yields, horizon.id);
    if (value !== null) { crossScore -= value * 0.25; crossCount++; }
  } else if (asset.id === "energy" || asset.id === "gasoline") {
    const sp = markets.find(item => item.symbol === "^GSPC");
    const value = marketMomentumScore(sp, horizon.id);
    if (value !== null) { crossScore += value * 0.2; crossCount++; }
  }

  const configuredWeights = config.analysis || {};
  const weights = {
    news: Number.isFinite(Number(configuredWeights.newsWeight)) ? Math.max(0, Number(configuredWeights.newsWeight)) : 0.48,
    momentum: Number.isFinite(Number(configuredWeights.momentumWeight)) ? Math.max(0, Number(configuredWeights.momentumWeight)) : 0.42,
    crossMarket: Number.isFinite(Number(configuredWeights.crossMarketWeight)) ? Math.max(0, Number(configuredWeights.crossMarketWeight)) : 0.10
  };
  const components = [
    { name:"news", value:newsScore, weight:weights.news, count:newsCount },
    { name:"momentum", value:ownMomentum, weight:weights.momentum, count:ownScores.length },
    { name:"crossMarket", value:crossCount ? crossScore / crossCount : 0, weight:weights.crossMarket, count:crossCount }
  ];
  const available = components.reduce((sum, item) => sum + (item.count ? item.weight : 0), 0);
  const score = available ? components.reduce((sum, item) => sum + item.value * (item.count ? item.weight : 0), 0) / available : 0;
  const evidenceCount = newsCount + ownScores.length + crossCount;
  const direction = evidenceCount ? directionFromScore(score, Number(config.analysis?.directionThreshold || 0.55)) : "NEUTRAL";
  const active = components.filter(item => item.count && Math.abs(item.value) > 0.15);
  const agreement = active.length > 1 ? Math.abs(active.reduce((sum, item) => sum + Math.sign(item.value), 0)) / active.length : active.length ? 0.65 : 0;
  const confidenceDecay = Math.max(0, Number(horizon.confidenceDecay || 0));
  const confidence = evidenceCount
    ? Math.round(clamp(22 + clamp(evidenceCount / 6, 0, 1) * 30 + clamp(Math.abs(score) / 1.8, 0, 1) * 25 + agreement * 12 - confidenceDecay, 15, 82))
    : 10;
  const rationale = direction === "NEUTRAL"
    ? "Tín hiệu tin tức và dữ liệu giá chưa đủ mạnh hoặc đang trái chiều; ưu tiên chờ xác nhận."
    : "Tín hiệu tổng hợp nghiêng " + (direction === "BULLISH" ? "tăng" : "giảm") + "; điểm xu hướng " + score.toFixed(2) + " trên thang -1.8 đến +1.8.";
  return {
    horizon:horizon.id, label:horizon.label, hours:horizon.hours, direction, confidence,
    score:Number(score.toFixed(3)), rationale, drivers:[...new Set(drivers)].slice(0,4),
    risks:[...new Set(risks)].slice(0,3),
    invalidation:"Nhận định mất hiệu lực nếu tin mới đảo chiều, động lượng giá phá cấu trúc hiện tại hoặc USD/lợi suất biến động ngược đáng kể.",
    method:"deterministic-quantitative", evidenceCount,
    breakdown:components.map(item => ({ component:item.name, score:Number(item.value.toFixed(3)), available:Boolean(item.count) }))
  };
}

function buildAnalysis(asset, news = [], markets = [], config = {}, now = Date.now()) {
  const horizons = config.forecastHorizons || DEFAULT_HORIZONS;
  const forecasts = horizons.map(item => {
    const base = DEFAULT_HORIZONS.find(value => value.id === item.id) || DEFAULT_HORIZONS[0];
    return buildHorizon(asset, news, markets, { ...base, ...item }, config, now);
  });
  const primary = forecasts[0] || { direction:"NEUTRAL", confidence:10, score:0, drivers:[], risks:[], evidenceCount:0 };
  return {
    assetId:asset.id, assetName:asset.name, direction:primary.direction,
    confidence:primary.confidence, score:primary.score, evidenceCount:primary.evidenceCount,
    drivers:[...new Set(forecasts.flatMap(item => item.drivers || []))].slice(0,5),
    risks:[...new Set(forecasts.flatMap(item => item.risks || []))].slice(0,4),
    forecasts,
    summary:primary.direction === "BULLISH" ? "Dữ liệu tin tức và thị trường hiện nghiêng về xu hướng tăng."
      : primary.direction === "BEARISH" ? "Dữ liệu tin tức và thị trường hiện nghiêng về xu hướng giảm."
      : "Chưa có lợi thế tăng/giảm đủ rõ; nên chờ thêm xác nhận.",
    caveat:primary.evidenceCount < 2
      ? "Dữ liệu xác nhận còn ít. Điểm tin cậy là điểm chất lượng tín hiệu, không phải xác suất thắng."
      : "Đây là mô hình định lượng theo quy tắc, không phải bảo đảm dự báo đúng. Tin mới và biến động bất thường có thể làm thay đổi kết quả.",
    analysisMethod:"deterministic-quantitative"
  };
}

async function analyzeAll(config, storage) {
  const now = Date.now();
  const maxAgeMs = Math.max(1, Number(config.marketMaxAgeHours || 96)) * 3600000;
  const storedMarkets = await storage.getLatestMarkets();
  const markets = storedMarkets.filter(item => {
    const time = new Date(item.marketTime || item.capturedAt || 0).getTime();
    return Number.isFinite(time) && time <= now + 5 * 60000 && now - time <= maxAgeMs;
  });
  const results = [];
  for (const asset of config.assets) results.push(buildAnalysis(asset, await storage.getRecentNews(asset.id, 40), markets, config));
  return results;
}

module.exports = { classifyHeadline, scoreNews, directionFromScore, marketMomentumScore, dedupeNewsEvents, buildAnalysis, analyzeAll };
