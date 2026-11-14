"use strict";

const { requestJson } = require("./http");
const { classifyHeadline } = require("./analyzer");

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
  const data = await requestJson(url, config.requestTimeoutMs);
  return Array.isArray(data.articles) ? data.articles : [];
}

async function fetchYahoo(symbol, config) {
  const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol));
  url.searchParams.set("range", "3mo");
  url.searchParams.set("interval", "1d");
  const data = await requestJson(url, config.requestTimeoutMs, { "User-Agent":"Mozilla/5.0 MarketIntelligenceBot/3.0" });
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) return null;
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const closes = (quote && quote.close || []).filter(value => Number.isFinite(value) && value > 0);
  const price = closes.at(-1);
  const previous = closes.at(-2) || Number(result.meta && (result.meta.chartPreviousClose || result.meta.previousClose));
  if (!Number.isFinite(price)) return null;
  const percentAt = sessions => {
    const base = closes[Math.max(0, closes.length - 1 - sessions)];
    return Number.isFinite(base) && base > 0 ? ((price - base) / base) * 100 : null;
  };
  const returns = [];
  for (let i = Math.max(1, closes.length - 15); i < closes.length; i++) returns.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1) : 0;
  const timestamps = result.timestamp || [];
  return {
    price,
    changePercent:Number.isFinite(previous) && previous > 0 ? ((price - previous) / previous) * 100 : 0,
    momentum:{ "24h":percentAt(1), "3d":percentAt(3), "7d":percentAt(7), "30d":percentAt(21) },
    volatilityPct:Math.sqrt(variance), currency:result.meta.currency || "",
    source:"Yahoo Finance",
    marketTime:timestamps.length ? new Date(timestamps[timestamps.length - 1] * 1000) : new Date()
  };
}

async function collectNews(config, storage) {
  const all = [];
  for (const asset of config.assets) {
    try {
      const articles = await fetchGdelt(asset.newsQuery, config);
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
      process.stderr.write("[WARN] GDELT " + asset.id + ": " + error.message + "\n");
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
  for (let i = 0; i < symbols.length; i += 4) {
    const batch = symbols.slice(i, i + 4);
    const results = await Promise.all(batch.map(async symbol => {
      try {
        const quote = await fetchYahoo(symbol, config);
        return quote ? { assetId:owners.get(symbol).id, assetName:owners.get(symbol).name, symbol, ...quote } : null;
      } catch (error) {
        process.stderr.write("[WARN] Quote " + symbol + ": " + error.message + "\n");
        return null;
      }
    }));
    all.push(...results.filter(Boolean));
  }
  if (process.env.XAUUSD_PRICE_URL) {
    try {
      const exact = await requestJson(process.env.XAUUSD_PRICE_URL, config.requestTimeoutMs);
      const price = Number(exact.price ?? exact.last ?? exact.close ?? exact.regularMarketPrice);
      if (Number.isFinite(price) && price > 0) all.push({
        assetId:"gold", assetName:"VÀNG", symbol:"XAUUSDm", price,
        changePercent:Number(exact.changePercent || 0),
        momentum:{ "24h":Number(exact.changePercent || 0) },
        volatilityPct:Number(exact.volatilityPct || 0.8),
        source:"Configured broker endpoint", currency:"USD", marketTime:new Date()
      });
    } catch (error) {
      process.stderr.write("[WARN] Exact XAUUSDm quote: " + error.message + "\n");
    }
  }
  const saved = await storage.saveMarkets(all);
  return { updated:saved.updated, largeMoves:saved.largeMoves };
}

module.exports = { collectNews, collectMarkets, fetchGdelt, fetchYahoo, safeDate, sourceWeight };
