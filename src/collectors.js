"use strict";

const { requestJson, sleep } = require("./http");
const { classifyHeadline } = require("./analyzer");

let gdeltCooldownUntil = 0;
let yahooCooldownUntil = 0;

function safeDate(value) {
  if (typeof value === "string" && /^\d{8}T\d{6}Z$/.test(value)) {
    value = value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
  }
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function sourceWeight(domain) {
  const host = String(domain || "").toLowerCase().replace(/^www\./, "");
  if (/(reuters|bloomberg|ft\.com|wsj|cnbc|apnews|bbc|nikkei|theguardian)\./.test(host)) return 1.15;
  if (/(federalreserve|bls\.gov|bea\.gov|eia\.gov|treasury\.gov|opec\.org)\b/.test(host)) return 1.25;
  if (/(marketwatch|investing|tradingeconomics|finance\.yahoo)\./.test(host)) return 0.95;
  return 0.8;
}

async function fetchGdelt(query, config) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(config.maxNewsPerCategory));
  url.searchParams.set("sort", "DateDesc");
  url.searchParams.set("timespan", "24h");
  const data = await requestJson(url, config.requestTimeoutMs, {}, {
    retries: config.gdeltMaxRetries ?? config.httpMaxRetries ?? 1,
    retryOnRateLimit:false,
    retryBaseMs: config.httpRetryBaseMs ?? 2000
  });
  return Array.isArray(data.articles) ? data.articles : [];
}

async function fetchYahoo(symbol, config) {
  if (Date.now() < yahooCooldownUntil) {
    const error = new Error("Yahoo Finance is in a temporary rate-limit cooldown");
    error.status = 429;
    throw error;
  }
  const headers = { "User-Agent":"Mozilla/5.0 MarketIntelligenceBot/3.0" };
  let result = null;
  let lastError = null;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = new URL("https://" + host + "/v8/finance/chart/" + encodeURIComponent(symbol));
    url.searchParams.set("range", "3mo");
    url.searchParams.set("interval", "1h");
    try {
      const data = await requestJson(url, config.requestTimeoutMs, headers, {
        retries: config.httpMaxRetries ?? 1,
        retryOnRateLimit:false,
        retryBaseMs: config.httpRetryBaseMs ?? 2000
      });
      result = data.chart && data.chart.result && data.chart.result[0];
      if (result) break;
      lastError = new Error("Yahoo Finance returned no chart data");
    } catch (error) {
      lastError = error;
      if (Number(error.status) === 429) {
        yahooCooldownUntil = Date.now() + Math.min(Math.max(Number(error.retryAfterMs || 0), 5 * 60 * 1000), 2 * 60 * 60 * 1000);
        break;
      }
    }
  }
  if (!result && lastError) throw lastError;
  if (!result) return null;

  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const rawCloses = quote && Array.isArray(quote.close) ? quote.close : [];
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const now = Date.now();
  const intervalMs = 60 * 60 * 1000;
  const bars = [];
  for (let i = 0; i < Math.min(rawCloses.length, timestamps.length); i++) {
    const close = Number(rawCloses[i]);
    const timestamp = Number(timestamps[i]);
    if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) continue;
    const closeTime = timestamp * 1000 + intervalMs;
    // Only completed hourly candles may be used for analysis and forecast verification.
    if (closeTime > now) continue;
    bars.push({ close, marketTime:new Date(closeTime) });
  }
  if (!bars.length) return null;

  const latest = bars[bars.length - 1];
  const previous = bars.length > 1 ? bars[bars.length - 2].close : null;
  const percentAt = hours => {
    const targetTime = latest.marketTime.getTime() - hours * 3600000;
    let base = null;
    let baseTime = null;
    for (let i = bars.length - 2; i >= 0; i--) {
      if (bars[i].marketTime.getTime() <= targetTime) {
        base = bars[i].close;
        baseTime = bars[i].marketTime.getTime();
        break;
      }
    }
    // Do not label a multi-day market closure as a precise 24h/3d/7d return.
    if (baseTime === null || targetTime - baseTime > 24 * 3600000) return null;
    return Number.isFinite(base) && base > 0 ? ((latest.close - base) / base) * 100 : null;
  };
  const momentum24h = percentAt(24);
  const returns = [];
  const dayAgo = latest.marketTime.getTime() - 24 * 3600000;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].marketTime.getTime() < dayAgo) continue;
    const prior = bars[i - 1].close;
    if (prior > 0) returns.push(((bars[i].close - prior) / prior) * 100);
  }
  // Convert hourly returns into an approximate 24-hour realized volatility.
  const volatilityPct = returns.length ? Math.sqrt(returns.reduce((sum, value) => sum + value * value, 0)) : null;

  return {
    price:latest.close,
    changePercent:momentum24h,
    momentum:{
      "24h":momentum24h,
      "3d":percentAt(72),
      "7d":percentAt(168),
      "30d":percentAt(720)
    },
    volatilityPct,
    currency:result.meta && result.meta.currency || "",
    source:"Yahoo Finance",
    marketTime:latest.marketTime
  };
}

async function collectNews(config, storage) {
  const all = [];
  let lastRequestAt = 0;
  let consecutiveFailures = 0;
  if (Date.now() < gdeltCooldownUntil) {
    const seconds = Math.ceil((gdeltCooldownUntil - Date.now()) / 1000);
    process.stderr.write("[WARN] GDELT đang tạm nghỉ sau lỗi nguồn; thử lại sau " + seconds + " giây.\n");
    return { found:0, inserted:0, importantNews:[] };
  }
  for (const asset of config.assets) {
    try {
      const gapMs = Math.max(0, Number(config.gdeltRequestGapMs || 0));
      const waitMs = gapMs - (Date.now() - lastRequestAt);
      if (lastRequestAt && waitMs > 0) await sleep(waitMs);
      const articles = await fetchGdelt(asset.newsQuery, config);
      lastRequestAt = Date.now();
      consecutiveFailures = 0;
      for (const article of articles) {
        const title = String(article.title || "").trim();
        const url = String(article.url || "").trim();
        if (!title || !url || !/^https?:\/\//i.test(url)) continue;
        const domain = article.domain || article.source || "GDELT";
        const classification = classifyHeadline(title, asset.id);
        all.push({
          assetId:asset.id, assetName:asset.name, title, url,
          source:domain, sourceWeight:sourceWeight(domain),
          publishedAt:safeDate(article.seendate),
          sentiment:classification.sentiment, importance:classification.importance,
          eventType:classification.eventType, eventTypes:classification.eventTypes,
          impactScore:classification.impactScore, relevance:classification.relevance,
          eventHalfLifeHours:classification.eventHalfLifeHours
        });
      }
    } catch (error) {
      lastRequestAt = Date.now();
      consecutiveFailures++;
      process.stderr.write("[WARN] GDELT " + asset.name + " (" + asset.id + "): " + error.message + "\n");
      if (Number(error.status) === 429 || consecutiveFailures >= 2) {
        const minimumCooldown = Number(error.status) === 429 ? 5 * 60 * 1000 : 3 * 60 * 1000;
        const cooldownMs = Math.max(Number(error.retryAfterMs || 0), minimumCooldown);
        gdeltCooldownUntil = Date.now() + Math.min(cooldownMs, 2 * 60 * 60 * 1000);
        process.stderr.write("[WARN] Dừng truy vấn GDELT còn lại trong chu kỳ để tránh tăng tải; tạm nghỉ " + Math.ceil((gdeltCooldownUntil - Date.now()) / 1000) + " giây.\n");
        break;
      }
    }
  }
  const saved = await storage.saveNews(all);
  return { found:all.length, inserted:saved.inserted, importantNews:saved.importantNews };
}

async function collectMarkets(config, storage) {
  const all = [];
  const owners = new Map();
  for (const asset of config.assets) for (const symbol of asset.marketSymbols || []) owners.set(symbol, asset);
  const symbols = [...owners.keys()];
  const batchSize = Math.max(1, Math.min(4, Number(config.marketFetchConcurrency || 2)));
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async symbol => {
      try {
        const quote = await fetchYahoo(symbol, config);
        return quote ? { assetId:owners.get(symbol).id, assetName:owners.get(symbol).name, instrumentName:(config.symbolLabels || {})[symbol] || symbol, symbol, ...quote } : null;
      } catch (error) {
        process.stderr.write("[WARN] Quote " + ((config.symbolLabels || {})[symbol] || symbol) + " (" + symbol + ") [" + owners.get(symbol).name + "]: " + error.message + "\n");
        return null;
      }
    }));
    all.push(...results.filter(Boolean));
  }
  if (process.env.XAUUSD_PRICE_URL) {
    try {
      const exact = await requestJson(process.env.XAUUSD_PRICE_URL, config.requestTimeoutMs, {}, { retries:config.httpMaxRetries ?? 1, retryOnRateLimit:false, retryBaseMs:config.httpRetryBaseMs ?? 2000 });
      const price = Number(exact.price ?? exact.last ?? exact.close ?? exact.regularMarketPrice);
      if (Number.isFinite(price) && price > 0) all.push({
        assetId:"gold", assetName:"VÀNG (XAUUSDm)", instrumentName:(config.symbolLabels || {}).XAUUSDm || "Vàng giao ngay theo giá broker", symbol:"XAUUSDm", price,
        changePercent:Number(exact.changePercent || 0),
        momentum:{ "24h":Number(exact.changePercent || 0) },
        volatilityPct:Number(exact.volatilityPct || 0.8),
        source:"Configured broker endpoint", currency:"USD", marketTime:new Date()
      });
    } catch (error) {
      process.stderr.write("[WARN] " + ((config.symbolLabels || {}).XAUUSDm || "Vàng giao ngay theo giá broker") + " (XAUUSDm): " + error.message + "\n");
    }
  }
  const saved = await storage.saveMarkets(all);
  return { updated:saved.updated, largeMoves:saved.largeMoves };
}

module.exports = { collectNews, collectMarkets, fetchGdelt, fetchYahoo, safeDate, sourceWeight };
