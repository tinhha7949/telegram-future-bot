"use strict";

const { requestJson } = require("./http");

const cache = new Map();
const MAX_CACHE = 3000;

function isVietnamese(text) {
  return /[À-ỹĐđ]/u.test(String(text || ""));
}

async function translateToVietnamese(value, config = {}) {
  const original = String(value || "").trim();
  if (!original || isVietnamese(original)) return original;
  if (cache.has(original)) return cache.get(original);

  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "vi");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", original);

  try {
    const result = await requestJson(url, Number(config.translationTimeoutMs || 6000), {
      "User-Agent":"Mozilla/5.0 MarketIntelligenceBot/3.0"
    }, { retries:0, retryOnRateLimit:false });
    const translated = Array.isArray(result) && Array.isArray(result[0])
      ? result[0].map(part => Array.isArray(part) ? String(part[0] || "") : "").join("").trim()
      : "";
    if (!translated) throw new Error("Dịch vụ không trả về nội dung tiếng Việt");
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(original, translated);
    return translated;
  } catch (error) {
    process.stderr.write("[CẢNH BÁO] Không dịch được tiêu đề tin: " + error.message + "\n");
    const fallback = "Không thể dịch tự động tiêu đề tin này";
    cache.set(original, fallback);
    return fallback;
  }
}

async function translateBatch(items, config = {}) {
  const concurrency = Math.max(1, Math.min(5, Number(config.translationConcurrency || 3)));
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(async item => {
      item.originalTitle = item.title;
      item.title = await translateToVietnamese(item.title, config);
    }));
  }
  return items;
}

module.exports = { translateToVietnamese, translateBatch, isVietnamese };
