"use strict";

const { sleep } = require("./http");
const { directionVi, eventVi, horizonVi } = require("./i18n");
const { translateToVietnamese, isTranslationFailure } = require("./translator");

class Telegram {
  constructor(config) {
    this.config = config;
    this.token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;
  }

  async localizeMessage(value) {
    const lines = String(value).split("\n");
    const isNewsAlert = lines[0].startsWith("🚨 TIN TỨC QUAN TRỌNG |");

    if (isNewsAlert) {
      if (lines[1]) lines[1] = await translateToVietnamese(lines[1], this.config);
      if (lines[2] && lines[2].startsWith("Sự kiện: ")) {
        lines[2] = "Sự kiện: " + eventVi(lines[2].slice("Sự kiện: ".length));
      }
      if (lines[4] && (/BULLISH|BEARISH|NEUTRAL/.test(lines[4]) || lines[4].startsWith("Dự báo 24h sau cập nhật:"))) {
        lines[4] = lines[4].replace("Dự báo 24h sau cập nhật:", "Dự báo 24 giờ sau khi cập nhật:")
          .replace(/: (BULLISH|BEARISH|NEUTRAL) \|/, (_match, direction) => ": " + directionVi(direction) + " |")
          .replace(" | điểm ", " | điểm chất lượng ");
      }
      if (lines[5] && lines[5].startsWith("Mức độ: ")) {
        lines[5] = lines[5].replace("Mức độ:", "Mức độ quan trọng:");
      }
    }

    // Áp dụng cho mọi loại tin nhắn, kể cả thông báo cũ còn trong hàng đợi.
    return lines.filter(line =>
      !/^\s*(?:Nguồn|Source)\s*:/i.test(line) &&
      !/https?:\/\//i.test(line)
    ).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  async send(text) {
    const localizedText = await this.localizeMessage(text);
    const characters = Array.from(String(localizedText));
    const chunks = [];
    for (let i = 0; i < characters.length; i += 3900) {
      chunks.push(characters.slice(i, i + 3900).join(""));
    }
    for (const chunk of chunks) {
      let delivered = false;
      let lastError = null;
      for (let attempt = 0; attempt <= 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
        try {
          const response = await fetch("https://api.telegram.org/bot" + this.token + "/sendMessage", {
            method:"POST", signal:controller.signal,
            headers:{ "Content-Type":"application/json" },
            body:JSON.stringify({ chat_id:this.chatId, text:chunk, disable_web_page_preview:true })
          });
          const raw = await response.text();
          let result;
          try { result = raw ? JSON.parse(raw) : {}; }
          catch {
            if (!response.ok) {
              const error = new Error("Telegram trả về mã lỗi HTTP " + response.status);
              error.status = response.status;
              throw error;
            }
            throw new Error("Telegram trả về dữ liệu không hợp lệ (HTTP " + response.status + ")");
          }

          if (response.ok && result.ok) {
            delivered = true;
            lastError = null;
            break;
          }
          const error = new Error("Telegram báo lỗi: " + (result.description || "mã HTTP " + response.status));
          error.status = response.status;
          error.retryAfterMs = Number(result.parameters && result.parameters.retry_after || 0) * 1000;
          throw error;
        } catch (error) {
          lastError = error;
          const retryable = Number(error.status) === 429 || Number(error.status) >= 500 ||
            error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError;
          if (!retryable || attempt >= 2) throw error;
        } finally {
          clearTimeout(timer);
        }
        const serverDelay = Math.min(15 * 60 * 1000, Number(lastError.retryAfterMs || 0));
        const backoff = Math.min(10000, 500 * (2 ** attempt));
        await sleep(serverDelay || backoff);
      }
      if (!delivered) throw lastError || new Error("Telegram không gửi được tin nhắn");
    }
  }

  async buildDailyReport(analyses, storage) {
    const now = new Intl.DateTimeFormat("vi-VN", {
      timeZone:this.config.timezone, dateStyle:"full", timeStyle:"short"
    }).format(new Date());
    const [markets, ...groups] = await Promise.all([
      storage.getLatestMarkets(),
      ...analyses.map(item => storage.getRecentNews(item.assetId, 5))
    ]);
    const lines = [
      "🧠 TRÍ TUỆ THỊ TRƯỜNG",
      "📅 " + now + " (GMT+7)",
      "BÁO CÁO TIN TỨC & DỰ BÁO ĐỊNH LƯỢNG",
      "Mô hình: phân loại sự kiện + đánh giá tác động theo tài sản + động lượng giá",
      "━━━━━━━━━━━━━━━━━━", ""
    ];
    for (let i = 0; i < analyses.length; i++) {
      const item = analyses[i];
      lines.push("📌 " + item.assetName);
      lines.push("Tổng quan 24 giờ: " + directionVi(item.direction) + " | Điểm chất lượng tín hiệu: " + item.confidence + "/82");
      lines.push(item.summary);
      for (const forecast of item.forecasts || []) {
        const icon = forecast.direction === "BULLISH" ? "🟢" : forecast.direction === "BEARISH" ? "🔴" : "🟡";
        lines.push(icon + " " + (forecast.label || horizonVi(forecast.horizon)) + ": " + directionVi(forecast.direction) + " — " + forecast.confidence + "/82");
        lines.push("  Điểm mô hình: " + forecast.score + "; bằng chứng: " + forecast.evidenceCount);
        if (forecast.rationale) lines.push("  Nhận định: " + forecast.rationale);
        if (forecast.drivers && forecast.drivers.length) lines.push("  Động lực: " + forecast.drivers.slice(0, 2).join(" • "));
        if (forecast.risks && forecast.risks.length) lines.push("  Rủi ro: " + forecast.risks.slice(0, 2).join(" • "));
      }
      for (const quote of markets.filter(value => value.assetId === item.assetId).slice(0, 3)) {
        const change = Number(quote.changePercent || 0);
        lines.push("• " + (quote.instrumentName || (this.config.symbolLabels || {})[quote.symbol] || quote.symbol) + " (" + quote.symbol + "): " + quote.price + " (" + (change >= 0 ? "+" : "") + change.toFixed(2) + "%)");
      }
      const headlines = groups[i] || [];
      if (headlines.length) {
        lines.push("Tin tức mới:");
        for (const news of headlines) {
          const impact = Number(news.impactScore || 0);
          const storedTitle = String(news.title || "").trim();
          const originalTitle = String(news.originalTitle || "").trim();
          const sourceTitle = isTranslationFailure(storedTitle) ? originalTitle : storedTitle;
          const vietnameseTitle = await translateToVietnamese(sourceTitle || originalTitle, this.config);
          lines.push("- [" + news.importance + "/10 | " + (impact > 0 ? "+" : "") + impact.toFixed(1) + "] " + vietnameseTitle);

        }
      }
      if (item.risks && item.risks.length) lines.push("Rủi ro chính: " + item.risks.slice(0, 3).join(" • "));
      lines.push("Lưu ý: " + item.caveat, "");
    }
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("Điểm 0–82 thể hiện chất lượng tín hiệu, KHÔNG phải xác suất dự báo đúng.");
    lines.push("Giá tham chiếu từ Yahoo Finance: mã hợp đồng tương lai/chỉ số được ghi bên cạnh từng tài sản; GC=F là hợp đồng vàng COMEX, KHÔNG phải giá vàng XAUUSDm tại sàn giao dịch của mày.");
    lines.push("Mô hình định lượng có thể sai; đây không phải khuyến nghị đầu tư.");
    return lines.join("\n");
  }
}

module.exports = { Telegram };
