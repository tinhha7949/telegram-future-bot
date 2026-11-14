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
        const response = await fetch("https://api.telegram.org/bot" + this.token + "/sendMessage", {
          method:"POST", signal:controller.signal,
          headers:{ "Content-Type":"application/json" },
          body:JSON.stringify({ chat_id:this.chatId, text:chunk, disable_web_page_preview:true })
        });
        if (!response.ok) throw new Error("Telegram HTTP " + response.status);
        const result = await response.json();
        if (!result.ok) throw new Error(result.description || "Telegram send failed");
      } finally { clearTimeout(timer); }
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
      "🧠 MARKET INTELLIGENCE",
      "📅 " + now + " (GMT+7)",
      "BÁO CÁO TIN TỨC & DỰ BÁO ĐỊNH LƯỢNG",
      "Mô hình: quy tắc sự kiện + tác động theo tài sản + động lượng giá",
      "━━━━━━━━━━━━━━━━━━", ""
    ];
    for (let i = 0; i < analyses.length; i++) {
      const item = analyses[i];
      lines.push("📌 " + item.assetName);
      lines.push("Tổng quan 24h: " + item.direction + " | Điểm tín hiệu: " + item.confidence + "/82");
      lines.push(item.summary);
      for (const forecast of item.forecasts || []) {
        const icon = forecast.direction === "BULLISH" ? "🟢" : forecast.direction === "BEARISH" ? "🔴" : "🟡";
        lines.push(icon + " " + (forecast.label || forecast.horizon) + ": " + forecast.direction + " — " + forecast.confidence + "/82");
        lines.push("  Điểm mô hình: " + forecast.score + "; bằng chứng: " + forecast.evidenceCount);
        if (forecast.rationale) lines.push("  Nhận định: " + forecast.rationale);
        if (forecast.drivers && forecast.drivers.length) lines.push("  Động lực: " + forecast.drivers.slice(0, 2).join(" • "));
        if (forecast.risks && forecast.risks.length) lines.push("  Rủi ro: " + forecast.risks.slice(0, 2).join(" • "));
      }
      for (const quote of markets.filter(value => value.assetId === item.assetId).slice(0, 3)) {
        const change = Number(quote.changePercent || 0);
        lines.push("• " + quote.symbol + ": " + quote.price + " (" + (change >= 0 ? "+" : "") + change.toFixed(2) + "%)");
      }
      const headlines = groups[i] || [];
      if (headlines.length) {
        lines.push("Tin tức mới:");
        for (const news of headlines) {
          const impact = Number(news.impactScore || 0);
          lines.push("- [" + news.importance + "/10 | " + (impact > 0 ? "+" : "") + impact.toFixed(1) + "] " + news.title);
          lines.push("  " + news.source + " | " + news.url);
        }
      }
      if (item.risks && item.risks.length) lines.push("Rủi ro chính: " + item.risks.slice(0, 3).join(" • "));
      lines.push("Lưu ý: " + item.caveat, "");
    }
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("Điểm 0-82 là điểm chất lượng tín hiệu, KHÔNG phải xác suất dự báo đúng.");
    lines.push("Giá tham chiếu: Yahoo Finance; GC=F không phải giá broker XAUUSDm.");
    lines.push("Mô hình định lượng có thể sai; đây không phải khuyến nghị đầu tư.");
    return lines.join("\n");
  }
}

module.exports = { Telegram };
