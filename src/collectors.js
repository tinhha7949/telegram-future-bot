"use strict";

const { requestJson } = require("./http");
const { scoreNews } = require("./analyzer");

function safeDate(value) {
  if (typeof value === "string" && /^\d{8}T\d{6}Z$/.test(value)) {
    value = value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
  }
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
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
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", "1d");
  url.searchParams.set("interval", "5m");
  const data = await requestJson(url, config.requestTimeoutMs, { "User-Agent": "Mozilla/5.0 MarketIntelligenceBot/2.0" });
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) return null;
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const closes = (quote && quote.close || []).filter(Number.isFinite);
  const price = closes.at(-1);
  const previous = result.meta && Number(result.meta.chartPreviousClose || result.meta.previousClose);
  if (!Number.isFinite(price)) return null;
  const changePercent = Number.isFinite(previous) && previous !== 0 ? ((price - previous) / previous) * 100 : 0;
  const timestamps = result.timestamp || [];
  return {
    price, changePercent, currency: result.meta.currency || "", source: "Yahoo Finance",
    marketTime: timestamps.length ? new Date(timestamps[timestamps.length - 1] * 1000) : null
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
        const sentiment = scoreNews(title);
        all.push({
          assetId: asset.id, assetName: asset.name, title, url,
          source: article.domain || article.source || "GDELT",
          publishedAt: safeDate(article.seendate),
          sentiment: sentiment.label,
          importance: sentiment.importance
        });
      }
    } catch (error) {
      process.stderr.write(`[WARN] GDELT ${asset.id}: ${error.message}\n`);
    }
  }
  const saved = await storage.saveNews(all);
  return { found: all.length, inserted: saved.inserted, importantNews: saved.importantNews };
}

async function collectMarkets(config, storage) {
  const all = [];
  const symbolOwners = new Map();
  for (const asset of config.assets) for (const symbol of asset.marketSymbols || []) symbolOwners.set(symbol, asset);
  const symbols = [...symbolOwners.keys()];
  for (let i = 0; i < symbols.length; i += 4) {
    const batch = symbols.slice(i, i + 4);
    const results = await Promise.all(batch.map(async symbol => {
      try {
        const quote = await fetchYahoo(symbol, config);
        if (!quote) return null;
        const asset = symbolOwners.get(symbol);
        return { assetId: asset.id, assetName: asset.name, symbol, ...quote };
      } catch (error) {
        process.stderr.write(`[WARN] Quote ${symbol}: ${error.message}\n`);
        return null;
      }
    }));
    all.push(...results.filter(Boolean));
  }

  if (process.env.XAUUSD_PRICE_URL) {
    try {
      const exact = await requestJson(process.env.XAUUSD_PRICE_URL, config.requestTimeoutMs);
      const price = Number(exact.price ?? exact.last ?? exact.close ?? exact.regularMarketPrice);
      if (Number.isFinite(price) && price > 0) {
        all.push({ assetId: "gold", assetName: "VÀNG", symbol: "XAUUSDm", price, changePercent: Number(exact.changePercent || 0), source: "Configured broker endpoint", currency: "USD", marketTime: new Date() });
      }
    } catch (error) {
      process.stderr.write(`[WARN] Exact XAUUSDm quote: ${error.message}\n`);
    }
  }
  const saved = await storage.saveMarkets(all);
  return { updated: saved.updated, largeMoves: saved.largeMoves };
}

module.exports = { collectNews, collectMarkets, fetchGdelt, fetchYahoo, safeDate };
