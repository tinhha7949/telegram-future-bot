"use strict";

const { requestJson, requestText, sleep } = require("./http");
const { classifyHeadline, dedupeNewsEvents } = require("./analyzer");

const newsSourceCooldowns = new Map();
const newsSourceFailures = new Map();
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

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");
}

function xmlTag(block, name) {
  const match = block.match(new RegExp("<(?:[\\w.-]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + name + "\\s*>", "i"));
  return match ? decodeXml(match[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function parseRss(xml) {
  const blocks = [...String(xml || "").matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(match => match[2]);
  const items = [];
  for (const block of blocks) {
    const title = xmlTag(block, "title");
    const linkTag = block.match(/<(?:[\w.-]+:)?link\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?link\s*>/i);
    const linkAttr = block.match(/<(?:[\w.-]+:)?link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
    const link = decodeXml(linkAttr ? linkAttr[1] : linkTag ? linkTag[2] : xmlTag(block, "guid")).trim();
    const sourceTag = block.match(/<(?:[\w.-]+:)?source\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?source\s*>/i);
    const sourceUrl = sourceTag && sourceTag[1].match(/\burl=["']([^"']+)["']/i);
    const source = sourceTag ? decodeXml(sourceTag[2]).replace(/<[^>]+>/g, "").trim() : "";
    const publishedAt = xmlTag(block, "pubDate") || xmlTag(block, "published") || xmlTag(block, "updated") || xmlTag(block, "date");
    if (title && /^https?:\/\//i.test(link)) items.push({ title, url:link, source, sourceUrl:sourceUrl ? sourceUrl[1] : "", publishedAt:safeDate(publishedAt) });
  }
  return items;
}

function googleNewsUrl(query) {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", String(query || "") + " when:24h");
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  return url;
}

function headlineRelevant(title, assetId) {
  const patterns = {
    gold:/\b(gold|bullion|precious metals?|xau|fed|fomc|inflation|cpi|pce|treasury yields?|us dollar|dxy|central bank)\b/i,
    energy:/\b(oil|crude|wti|brent|opec|petroleum|pipeline|refinery|energy|shipping|sanctions)\b/i,
    gasoline:/\b(gasoline|petrol|diesel|fuel|refinery|crude|oil|opec|inventory)\b/i,
    stocks:/\b(stock|stocks|equities|shares|nasdaq|s&p|dow jones|wall street|earnings|market|fed|rates)\b/i,
    macro:/\b(fed|fomc|powell|inflation|cpi|pce|payroll|employment|jobs|gdp|pmi|interest rates?|treasury|economy|unemployment)\b/i,
    usd:/\b(us dollar|dollar|dxy|currency|forex|fed|fomc|interest rates?|treasury yields?|inflation)\b/i,
    geopolitics:/\b(war|conflict|military|sanctions|ceasefire|tariff|invasion|attack|ukraine|russia|iran|israel|middle east|taiwan|china)\b/i,
    metals:/\b(silver|platinum|palladium|precious metals?|gold|industrial metals?)\b/i
  };
  return Boolean((patterns[assetId] || /\b(market|economy|finance)\b/i).test(title));
}

async function fetchRss(source, config) {
  const url = source.kind === "google-news" ? googleNewsUrl(source.query) : new URL(source.url);
  const xml = await requestText(url, config.newsRequestTimeoutMs ?? config.requestTimeoutMs, {}, {
    retries:config.newsHttpRetries ?? 1,
    retryOnRateLimit:false,
    retryBaseMs:config.httpRetryBaseMs ?? 2000
  });
  return parseRss(xml).slice(0, Math.max(1, Number(config.maxNewsPerCategory || 25)));
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
  const sources = Array.isArray(config.newsSources) ? config.newsSources : [];
  const concurrency = Math.max(1, Math.min(5, Number(config.newsSourceConcurrency || 3)));
  let succeeded = 0, failed = 0, skipped = 0;

  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async source => {
      const sourceId = String(source.id || source.name || source.url || source.query);
      const cooldownUntil = newsSourceCooldowns.get(sourceId) || 0;
      if (Date.now() < cooldownUntil) return { source, skipped:true, articles:[] };
      try {
        const articles = await fetchRss(source, config);
        newsSourceFailures.delete(sourceId);
        newsSourceCooldowns.delete(sourceId);
        return { source, articles };
      } catch (error) {
        const failures = (newsSourceFailures.get(sourceId) || 0) + 1;
        newsSourceFailures.set(sourceId, failures);
        const base = Number(error.status) === 429
          ? Math.max(Number(error.retryAfterMs || 0), 10 * 60 * 1000)
          : Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.min(failures - 1, 5)));
        newsSourceCooldowns.set(sourceId, Date.now() + Math.min(base, 2 * 60 * 60 * 1000));
        process.stderr.write("[WARN] NEWS " + sourceId + ": " + error.message + "; nghỉ " + Math.ceil(base / 1000) + " giây, tiếp tục nguồn khác.\n");
        return { source, failed:true, articles:[] };
      }
    }));

    for (const result of results) {
      if (result.skipped) { skipped++; continue; }
      if (result.failed) { failed++; continue; }
      succeeded++;
      const source = result.source;
      const assetIds = Array.isArray(source.assets) ? source.assets : source.assetId ? [source.assetId] : [];
      for (const article of result.articles) {
        const sourceName = article.source || source.publisher || source.name || "Unknown";
        const domain = (() => {
          try { return new URL(article.sourceUrl || article.url).hostname; }
          catch { return sourceName; }
        })();
        for (const assetId of assetIds) {
          const asset = config.assets.find(item => item.id === assetId);
          if (!asset || (source.kind !== "google-news" && !headlineRelevant(article.title, assetId))) continue;
          const classification = classifyHeadline(article.title, asset.id);
          all.push({
            assetId:asset.id, assetName:asset.name, title:article.title, url:article.url,
            source:sourceName, sourceWeight:sourceWeight(domain || sourceName),
            publishedAt:article.publishedAt, sentiment:classification.sentiment,
            importance:classification.importance, eventType:classification.eventType,
            eventTypes:classification.eventTypes, impactScore:classification.impactScore,
            relevance:classification.relevance, eventHalfLifeHours:classification.eventHalfLifeHours
          });
        }
      }
    }
  }

  const uniqueEvents = dedupeNewsEvents(all);
  const saved = await storage.saveNews(uniqueEvents);
  process.stdout.write("[INFO] News providers completed " + JSON.stringify({
    providersConfigured:sources.length, providersSucceeded:succeeded, providersFailed:failed,
    providersCoolingDown:skipped, articlesFetched:all.length, uniqueEvents:uniqueEvents.length
  }) + "\n");
  return { found:uniqueEvents.length, inserted:saved.inserted, importantNews:saved.importantNews };
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

module.exports = { collectNews, collectMarkets, fetchRss, parseRss, fetchYahoo, safeDate, sourceWeight, headlineRelevant };
