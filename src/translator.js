"use strict";

const { requestJson } = require("./http");

const cache = new Map();
const MAX_CACHE = 3000;
let translationCooldownUntil = 0;

function isVietnamese(text) {
  return (String(text || "").match(/[À-ỹĐđ]/gu) || []).length >= 2;
}

function cleanTranslation(value) {
  return String(value || "").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

async function translateToVietnamese(value, config = {}) {
  const original = String(value || "").trim();
  if (!original || isVietnamese(original)) return original;
  if (cache.has(original)) return cache.get(original);
  if (Date.now() < translationCooldownUntil) return "Không thể dịch tự động tiêu đề tin này";

  const timeout = Number(config.translationTimeoutMs || 6000);
  const googleUrl = new URL("https://translate.googleapis.com/translate_a/single");
  googleUrl.searchParams.set("client", "gtx");
  googleUrl.searchParams.set("sl", "auto");
  googleUrl.searchParams.set("tl", "vi");
  googleUrl.searchParams.set("dt", "t");
  googleUrl.searchParams.set("q", original);

  const memoryUrl = new URL("https://api.mymemory.translated.net/get");
  memoryUrl.searchParams.set("q", original);
  memoryUrl.searchParams.set("langpair", "en|vi");

  const providers = [
    async () => {
      const result = await requestJson(googleUrl, timeout, { "User-Agent":"Mozilla/5.0 MarketIntelligenceBot/3.0" }, { retries:0, retryOnRateLimit:false });
      return Array.isArray(result) && Array.isArray(result[0])
        ? result[0].map(part => Array.isArray(part) ? String(part[0] || "") : "").join("").trim()
        : "";
    },
    async () => {
      const result = await requestJson(memoryUrl, timeout, { "User-Agent":"Mozilla/5.0 MarketIntelligenceBot/3.0" }, { retries:0, retryOnRateLimit:false });
      return cleanTranslation(result && result.responseData && result.responseData.translatedText);
    }
  ];

  let lastError = null;
  for (const provider of providers) {
    try {
      const translated = await provider();
      if (!translated || /^MYMEMORY WARNING/i.test(translated)) throw new Error("Nguồn dịch không trả về bản dịch hợp lệ");
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(original, translated);
      return translated;
    } catch (error) {
      lastError = error;
    }
  }

  translationCooldownUntil = Date.now() + (Number(lastError && lastError.status) === 429 ? 15 * 60 * 1000 : 60 * 1000);
  process.stderr.write("[CẢNH BÁO] Các dịch vụ dịch tiêu đề tạm thời không khả dụng; bot vẫn tiếp tục thu thập tin và sẽ thử dịch lại sau.\\n");
  return "Không thể dịch tự động tiêu đề tin này";
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

module.exports = { translateToVietnamese, translateBatch, isVietnamese, cleanTranslation };
