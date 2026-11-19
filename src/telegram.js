"use strict";
class TelegramAlerts {
  constructor() {
    this.openToken = process.env.BOT_TOKEN;
    this.resultToken = process.env.BOT_TOKEN_2;
    this.openChat = process.env.CHAT_ID;
    this.resultChat = process.env.AI_CHAT_ID;
  }
  async send(token, chat, text) {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || "Telegram send failed");
  }
  async opened(p) {
    const message = [
      "🟢 FUTURES ORDER OPENED", p.symbol + " · " + p.side,
      "Entry: " + p.entry, "SL: " + p.stop, "TP1: " + p.tp1 + " (60%)",
      "TP2: " + p.tp2 + " (40%)", "Margin: " + p.margin.toFixed(4) + " USDT",
      "Leverage: " + p.leverage + "x", "Quantity: " + p.quantity
    ].join("\n");
    try { await this.send(this.openToken, this.openChat, message); }
    catch (e) { console.error("[telegram-open]", e.message); }
  }
  async result(p) {
    const pnl = Number(p.pnl || 0);
    const message = [
      (pnl >= 0 ? "🏆 WIN" : "🔴 LOSS") + " · " + p.symbol,
      "Side: " + p.side, "Entry: " + p.entry, "Exit: " + p.exit,
      "Realized PNL: " + pnl.toFixed(4) + " USDT",
      "ROI: " + Number(p.pnlPct || 0).toFixed(2) + "%",
      "Reason: " + p.reason
    ].join("\n");
    try { await this.send(this.resultToken, this.resultChat, message); }
    catch (e) { console.error("[telegram-result]", e.message); }
  }
  async startup(message) {
    try { await this.send(this.openToken, this.openChat, message); }
    catch (e) { console.error("[telegram-startup]", e.message); }
  }
}
module.exports = { TelegramAlerts };
