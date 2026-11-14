"use strict";

class Telegram {
  constructor(config) {
    this.config = config;
    this.token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;
  }

  async send(text) {
    const chunks = String(text).match(/[\s\S]{1,3900}/g) || [];
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
      ...analyses.map(item => storage.getRecentNews(item.assetId, 3))
    ]);
    const lines = ["📰 MARKET INTELLIGENCE", `📅 ${now} (GMT+7)`, "BÁO CÁO TRIỂN VỌNG THỊ TRƯỜNG", ""];
    for (let i = 0; i < analyses.length; i++) {
      const item = analyses[i];
      const icon = item.direction === "BULLISH" ? "🟢" : item.direction === "BEARISH" ? "🔴" : "🟡";
      lines.push(`${icon} ${item.assetName}: ${item.direction}`);
      lines.push(`Độ tin cậy tham khảo: ${item.confidence}% | Điểm: ${item.score}`);
      lines.push(item.summary);
      const quotes = markets.filter(m => m.assetId === item.assetId);
      for (const quote of quotes.slice(0, 4)) {
        const change = Number(quote.changePercent || 0);
        lines.push(`• ${quote.symbol}: ${quote.price} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`);
      }
      if (item.drivers.length) lines.push("Yếu tố: " + item.drivers.slice(0, 3).join(" • "));
      const headlines = newsGroups[i] || [];
      if (headlines.length) {
        lines.push("Tin mới:");
        for (const news of headlines) lines.push(`- ${news.title}\n  ${news.url}`);
      }
      lines.push(`Lưu ý: ${item.caveat}`, "");
    }
    lines.push("Nguồn tin: GDELT. Giá tham chiếu: Yahoo Finance.");
    lines.push("GC=F là hợp đồng vàng tương lai tham chiếu, không phải giá broker XAUUSDm.");
    lines.push("Muốn dùng đúng giá XAUUSDm, cấu hình XAUUSD_PRICE_URL từ broker.");
    lines.push("Đây là phân tích thông tin, không phải khuyến nghị đầu tư hay cam kết kết quả.");
    return lines.join("\n");
  }
}

module.exports = { Telegram };
