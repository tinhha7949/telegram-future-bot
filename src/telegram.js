"use strict";

class Telegram {
  constructor(config) {
    this.config = config;
    this.token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;
  }

  async send(text) {
    const chunks = String(text).match(/[\\s\\S]{1,3900}/g) || [];
    for (const chunk of chunks) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text: chunk, disable_web_page_preview: true })
        });
        if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
        const result = await response.json();
        if (!result.ok) throw new Error(result.description || "Telegram send failed");
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async buildDailyReport(analyses, storage) {
    const now = new Intl.DateTimeFormat("vi-VN", {
      timeZone: this.config.timezone, dateStyle: "full", timeStyle: "short"
    }).format(new Date());
    const [markets, ...newsGroups] = await Promise.all([
      storage.getLatestMarkets(),
      ...analyses.map(item => storage.getRecentNews(item.assetId, 4))
    ]);
    const lines = ["🧠 MARKET INTELLIGENCE", `📅 ${now} (GMT+7)`, "BÁO CÁO TIN TỨC & DỰ BÁO XU HƯỚNG", "━━━━━━━━━━━━━━━━━━", ""];
    for (let i = 0; i < analyses.length; i++) {
      const item = analyses[i];
      lines.push(`📌 ${item.assetName}`);
      lines.push(`Tổng quan: ${item.direction} | Điểm tín hiệu: ${item.confidence}/85`);
      lines.push(item.summary);
      for (const forecast of item.forecasts || []) {
        const icon = forecast.direction === "BULLISH" ? "🟢" : forecast.direction === "BEARISH" ? "🔴" : "🟡";
        lines.push(`${icon} ${forecast.label || forecast.horizon}: ${forecast.direction} — ${forecast.confidence}/85`);
        if (forecast.rationale) lines.push(`  Nhận định: ${forecast.rationale}`);
        if (forecast.drivers?.length) lines.push(`  Động lực: ${forecast.drivers.slice(0, 2).join(" • ")}`);
        if (forecast.risks?.length) lines.push(`  Rủi ro: ${forecast.risks.slice(0, 2).join(" • ")}`);
      }
      const quotes = markets.filter(m => m.assetId === item.assetId);
      for (const quote of quotes.slice(0, 3)) {
        const change = Number(quote.changePercent || 0);
        lines.push(`• ${quote.symbol}: ${quote.price} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`);
      }
      if (item.drivers?.length) lines.push("Yếu tố chính: " + item.drivers.slice(0, 3).join(" • "));
      const headlines = newsGroups[i] || [];
      if (headlines.length) {
        lines.push("Tin tức mới:");
        for (const news of headlines) lines.push(`- [${news.importance}/10] ${news.title}\n  ${news.source} | ${news.url}`);
      }
      if (item.risks?.length) lines.push("Rủi ro cần theo dõi: " + item.risks.slice(0, 3).join(" • "));
      lines.push(`Lưu ý: ${item.caveat}`, "");
    }
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("Điểm 0-85 là mức đánh giá tín hiệu, không phải xác suất dự báo đúng.");
    lines.push("Nguồn tin: GDELT. Giá tham chiếu: Yahoo Finance; GC=F không phải giá broker XAUUSDm.");
    lines.push("Dự báo được cập nhật khi có tin mới; không phải khuyến nghị đầu tư hay cam kết kết quả.");
    return lines.join("\n");
  }
}

module.exports = { Telegram };