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

  async buildDailyReport(analyses) {
    const now = new Intl.DateTimeFormat("vi-VN", {
      timeZone: this.config.timezone, dateStyle: "full", timeStyle: "short"
    }).format(new Date());
    const lines = ["📰 MARKET INTELLIGENCE", `📅 ${now} (GMT+7)`, "BÁO CÁO TRIỂN VỌNG THỊ TRƯỜNG", ""];
    for (const item of analyses) {
      const icon = item.direction === "BULLISH" ? "🟢" : item.direction === "BEARISH" ? "🔴" : "🟡";
      lines.push(`${icon} ${item.assetName}: ${item.direction}`);
      lines.push(`Độ tin cậy tham khảo: ${item.confidence}% | Điểm: ${item.score}`);
      lines.push(item.summary);
      if (item.drivers.length) lines.push("Yếu tố: " + item.drivers.slice(0, 4).join(" • "));
      lines.push(`Lưu ý: ${item.caveat}`, "");
    }
    lines.push("Nguồn: GDELT và Yahoo Finance. GC=F là hợp đồng vàng tương lai tham chiếu, không phải giá broker XAUUSDm.");
    lines.push("Muốn dùng đúng giá XAUUSDm, cấu hình XAUUSD_PRICE_URL từ broker của mày.");
    lines.push("Đây là phân tích thông tin, không phải khuyến nghị đầu tư hay cam kết kết quả.");
    return lines.join("\n");
  }
}

module.exports = { Telegram };
