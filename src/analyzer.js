"use strict";

const POSITIVE = ["surge", "rally", "gain", "rise", "higher", "record high", "bullish", "strong demand", "safe haven", "rate cut", "cuts rates", "easing", "stimulus", "beat estimates", "upgrade", "supply disruption", "sanctions", "geopolitical tension"];
const NEGATIVE = ["fall", "drop", "slump", "decline", "lower", "selloff", "bearish", "weak demand", "rate hike", "higher rates", "hawkish", "miss estimates", "downgrade", "oversupply", "ceasefire", "peace deal"];

function scoreNews(title) {
  const text = String(title || "").toLowerCase();
  let score = 0;
  for (const term of POSITIVE) if (text.includes(term)) score += 1;
  for (const term of NEGATIVE) if (text.includes(term)) score -= 1;
  const magnitude = Math.abs(score);
  const importance = Math.min(10, (/(fed|fomc|cpi|inflation|war|sanction|opec|emergency|crisis|surprise|rate decision|nfp|pce)/i.test(text) ? 4 : 1) + magnitude * 2);
  return { score, label: score > 0 ? "positive" : score < 0 ? "negative" : "neutral", importance };
}

function directionFromScore(score) {
  if (score >= 1.5) return "BULLISH";
  if (score <= -1.5) return "BEARISH";
  return "NEUTRAL";
}

function buildAnalysis(asset, news, markets, config = {}) {
  let score = 0;
  let evidence = 0;
  const drivers = [];
  const risks = [];
  for (const item of news.slice(0, 12)) {
    const s = item.sentiment === "positive" ? 1 : item.sentiment === "negative" ? -1 : 0;
    const ageHours = Math.max(0, (Date.now() - new Date(item.publishedAt || Date.now()).getTime()) / 3600000);
    const recencyWeight = ageHours <= 6 ? 1.25 : ageHours <= 24 ? 1 : 0.55;
    score += s * Math.max(1, Math.min(3, Number(item.importance || 1) / 3)) * recencyWeight;
    if (s) evidence++;
    if (drivers.length < 5) drivers.push(item.title);
    if (item.importance >= 5 && s === 0 && risks.length < 4) risks.push(item.title);
  }
  const quotes = markets.filter(item => item.assetId === asset.id);
  for (const quote of quotes) {
    const change = Number(quote.changePercent || 0);
    const weight = asset.id === "gold" && quote.symbol === "GC=F" ? 1.8 : 1;
    score += Math.max(-2, Math.min(2, change * 0.8)) * weight;
    evidence++;
    drivers.push(`${quote.symbol}: ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`);
  }
  if (asset.id === "gold") {
    const dxy = markets.find(item => item.symbol === "DX-Y.NYB");
    const yields = markets.find(item => item.symbol === "^TNX");
    if (dxy) { score -= Math.sign(dxy.changePercent || 0) * Math.min(1.2, Math.abs(dxy.changePercent || 0)); evidence++; drivers.push(`DXY: ${Number(dxy.changePercent).toFixed(2)}%`); }
    if (yields) { score -= Math.sign(yields.changePercent || 0) * Math.min(1.2, Math.abs(yields.changePercent || 0)); evidence++; drivers.push(`US 10Y yield: ${Number(yields.changePercent).toFixed(2)}%`); }
  }
  const direction = directionFromScore(score);
  const confidence = Math.min(78, Math.round(30 + Math.min(5, evidence) * 7 + Math.min(10, Math.abs(score)) * 2));
  const horizons = config.forecastHorizons || [
    { id: "24h", label: "24 GIỜ", hours: 24, confidenceDecay: 0 },
    { id: "3d", label: "3 NGÀY", hours: 72, confidenceDecay: 4 },
    { id: "7d", label: "7 NGÀY", hours: 168, confidenceDecay: 8 },
    { id: "30d", label: "30 NGÀY", hours: 720, confidenceDecay: 14 }
  ];
  const forecasts = horizons.map(h => ({
    horizon: h.id, label: h.label, hours: h.hours, direction,
    confidence: Math.max(15, confidence - Number(h.confidenceDecay || 0)),
    rationale: direction === "NEUTRAL" ? "Tín hiệu hiện tại chưa đủ đồng thuận để ưu tiên tăng hoặc giảm." : `Các dữ liệu hiện có đang nghiêng về xu hướng ${direction === "BULLISH" ? "tăng" : "giảm"}; độ chắc chắn giảm dần ở khung thời gian xa hơn.`,
    drivers: drivers.slice(0, 4), risks: risks.slice(0, 3),
    invalidation: "Cập nhật lại khi dữ liệu kinh tế, lợi suất, USD hoặc giá thị trường thay đổi đáng kể.",
    method: "local-evidence"
  }));
  return {
    assetId: asset.id, assetName: asset.name, direction, score: Number(score.toFixed(2)),
    confidence, evidenceCount: evidence, drivers: [...new Set(drivers)].slice(0, 5),
    risks: [...new Set(risks)].slice(0, 4), forecasts,
    summary: direction === "BULLISH" ? "Các tín hiệu hiện có nghiêng về chiều tăng." :
      direction === "BEARISH" ? "Các tín hiệu hiện có nghiêng về chiều giảm." :
      "Tín hiệu đang trái chiều hoặc chưa đủ mạnh để xác nhận xu hướng.",
    caveat: evidence < 2 ? "Dữ liệu còn mỏng; không nên xem đây là tín hiệu chắc chắn." : "Dự báo có thể thay đổi nhanh khi xuất hiện dữ liệu hoặc tin tức mới."
  };
}

async function applyAI(results, config, storage) {
  if (!process.env.OPENAI_API_KEY) return results;
  const evidence = [];
  for (const result of results) {
    const news = await storage.getRecentNews(result.assetId, 12);
    evidence.push({
      assetId: result.assetId, name: result.assetName, preliminary: result,
      headlines: news.map(n => ({ title: n.title, source: n.source, publishedAt: n.publishedAt, importance: n.importance })),
      marketQuotes: (await storage.getLatestMarkets()).filter(m => m.assetId === result.assetId).map(m => ({ symbol: m.symbol, price: m.price, changePercent: m.changePercent, capturedAt: m.capturedAt }))
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs * 2);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini", temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Bạn là hệ thống phân tích tin tức và triển vọng thị trường. Chỉ dùng dữ liệu đầu vào, không bịa tin, giá, lịch sự kiện hoặc xác suất. Phân tích riêng từng horizon 24h, 3d, 7d, 30d; không được mặc định các horizon cùng chiều. Trả JSON {results:[{assetId,direction,confidence,summary,drivers,risks,caveat,forecasts:[{horizon,direction,confidence,rationale,drivers,risks,invalidation}]}]}. direction chỉ BULLISH/BEARISH/NEUTRAL; confidence là điểm đánh giá chủ quan 0-85, KHÔNG phải xác suất thắng. Horizon xa phải thận trọng hơn. Nếu dữ liệu thiếu/mâu thuẫn, chọn NEUTRAL và confidence thấp. Nêu rõ điều kiện có thể làm nhận định mất hiệu lực." },
          { role: "user", content: JSON.stringify(evidence) }
        ]
      })
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const byId = new Map((parsed.results || []).map(item => [item.assetId, item]));
    return results.map(item => {
      const ai = byId.get(item.assetId);
      if (!ai || !["BULLISH", "BEARISH", "NEUTRAL"].includes(ai.direction)) return item;
      const forecasts = (config.forecastHorizons || []).map(h => {
        const f = (ai.forecasts || []).find(x => x.horizon === h.id);
        if (!f || !["BULLISH", "BEARISH", "NEUTRAL"].includes(f.direction)) return item.forecasts.find(x => x.horizon === h.id);
        return {
          ...item.forecasts.find(x => x.horizon === h.id), direction: f.direction,
          confidence: Math.max(0, Math.min(85, Number(f.confidence) || 0)),
          rationale: String(f.rationale || "").slice(0, 500),
          drivers: Array.isArray(f.drivers) ? f.drivers.slice(0, 4).map(x => String(x).slice(0, 220)) : item.drivers.slice(0, 4),
          risks: Array.isArray(f.risks) ? f.risks.slice(0, 3).map(x => String(x).slice(0, 220)) : item.risks,
          invalidation: String(f.invalidation || item.caveat).slice(0, 400), method: "openai-assisted"
        };
      });
      return {
        ...item, direction: ai.direction,
        confidence: Math.max(0, Math.min(85, Number(ai.confidence) || item.confidence)),
        summary: String(ai.summary || item.summary).slice(0, 500),
        drivers: Array.isArray(ai.drivers) ? ai.drivers.slice(0, 5).map(x => String(x).slice(0, 240)) : item.drivers,
        risks: Array.isArray(ai.risks) ? ai.risks.slice(0, 4).map(x => String(x).slice(0, 240)) : item.risks,
        caveat: String(ai.caveat || item.caveat).slice(0, 500),
        forecasts, analysisMethod: "OpenAI-assisted"
      };
    });
  } catch (error) {
    process.stderr.write(`[WARN] AI analysis unavailable; using local scoring: ${error.message}\n`);
    return results;
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeAll(config, storage, useAI = false) {
  const markets = await storage.getLatestMarkets();
  let results = [];
  for (const asset of config.assets) {
    const news = await storage.getRecentNews(asset.id, 12);
    results.push(buildAnalysis(asset, news, markets, config));
  }
  if (useAI) results = await applyAI(results, config, storage);
  return results;
}

module.exports = { scoreNews, directionFromScore, buildAnalysis, analyzeAll, applyAI };