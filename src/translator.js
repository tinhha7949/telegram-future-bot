"use strict";

const { requestJson } = require("./http");

const cache = new Map();
const MAX_CACHE = 3000;
const providerCooldowns = new Map();
const FAILURE_TEXT = "Không thể dịch tự động tiêu đề tin này";

function isVietnamese(text) {
  // Chỉ nhận diện các ký tự đặc trưng của tiếng Việt, tránh coi mọi chữ có dấu
  // trong tiếng Pháp/Đức/Tây Ban Nha là tiêu đề tiếng Việt.
  return /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/u.test(String(text || ""));
}

function cleanTranslation(value) {
  return String(value || "").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function isTranslationFailure(value) {
  return !String(value || "").trim() || String(value).trim() === FAILURE_TEXT;
}

function rememberTranslation(original, translated) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(original, translated);
}

function setProviderCooldown(provider, error) {
  if (Number(error && error.status) === 429) {
    const retryAfter = Math.max(0, Number(error.retryAfterMs || 0));
    providerCooldowns.set(provider, Date.now() + Math.min(Math.max(retryAfter, 5 * 60 * 1000), 60 * 60 * 1000));
  }
}

async function translateToVietnamese(value, config = {}) {
  const original = String(value || "").trim();
  if (!original || isVietnamese(original)) return original;
  if (cache.has(original)) return cache.get(original);

  const timeout = Math.max(1000, Number(config.translationTimeoutMs || 6000));
  const headers = { "User-Agent":"Mozilla/5.0 MarketIntelligenceBot/3.0" };
  const googleUrl = new URL("https://translate.googleapis.com/translate_a/single");
  googleUrl.searchParams.set("client", "gtx");
  googleUrl.searchParams.set("sl", "auto");
  googleUrl.searchParams.set("tl", "vi");
  googleUrl.searchParams.set("dt", "t");
  googleUrl.searchParams.set("q", original);

  const memoryUrl = new URL("https://api.mymemory.translated.net/get");
  memoryUrl.searchParams.set("q", original);
  memoryUrl.searchParams.set("langpair", "autodetect|vi");

  const providers = [
    {
      name:"Google Translate",
      host:"translate.googleapis.com",
      run:async () => {
        const result = await requestJson(googleUrl, timeout, headers, { retries:0, retryOnRateLimit:false });
        return Array.isArray(result) && Array.isArray(result[0])
          ? result[0].map(part => Array.isArray(part) ? String(part[0] || "") : "").join("").trim()
          : "";
      }
    },
    {
      name:"MyMemory",
      host:"api.mymemory.translated.net",
      run:async () => {
        const result = await requestJson(memoryUrl, timeout, headers, { retries:0, retryOnRateLimit:false });
        if (Number(result && result.responseStatus) >= 400) {
          const error = new Error("MyMemory response status " + result.responseStatus);
          error.status = Number(result.responseStatus);
          throw error;
        }
        return cleanTranslation(result && result.responseData && result.responseData.translatedText);
      }
    }
  ];

  const failures = [];
  for (const provider of providers) {
    if (Date.now() < (providerCooldowns.get(provider.host) || 0)) {
      failures.push(provider.name + ": đang trong thời gian giới hạn request");
      continue;
    }
    try {
      const translated = cleanTranslation(await provider.run());
      if (!translated || /^MYMEMORY WARNING/i.test(translated) || !isVietnamese(translated) ||
          translated.toLocaleLowerCase() === original.toLocaleLowerCase()) {
        throw new Error("Nhà cung cấp không trả về bản dịch tiếng Việt hợp lệ");
      }
      rememberTranslation(original, translated);
      return translated;
    } catch (error) {
      setProviderCooldown(provider.host, error);
      failures.push(provider.name + ": " + String(error && error.message || error).slice(0, 240));
    }
  }

  // Không bao giờ thay tiêu đề bằng thông báo lỗi. Giữ nguyên dữ liệu gốc để
  // Telegram vẫn có nội dung hiển thị và lần quét/gửi sau có thể thử dịch lại.
  process.stderr.write("[CẢNH BÁO] Dịch tiêu đề thất bại; giữ nguyên tiêu đề gốc. " +
    failures.join(" | ") + "\n");
  return original;
}

async function translateBatch(items, config = {}) {
  const concurrency = Math.max(1, Math.min(5, Number(config.translationConcurrency || 3)));
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(async item => {
      const existingOriginal = String(item.originalTitle || "").trim();
      const currentTitle = String(item.title || "").trim();
      const original = existingOriginal && (isTranslationFailure(currentTitle) || !currentTitle)
        ? existingOriginal
        : existingOriginal || currentTitle;
      item.originalTitle = original;
      item.title = await translateToVietnamese(original, config);
      if (isTranslationFailure(item.title)) item.title = original;
    }));
  }
  return items;
}

module.exports = {
  translateToVietnamese, translateBatch, isVietnamese, cleanTranslation,
  isTranslationFailure, FAILURE_TEXT
};
