"use strict";
const TelegramBot = require("node-telegram-bot-api");
class TelegramAlerts {
  constructor() {
    this.openBot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
    this.resultBot = new TelegramBot(process.env.BOT_TOKEN_2, { polling: false });
    this.openChat = process.env.CHAT_ID;
    this.resultChat = process.env.AI_CHAT_ID;
  }
  async opened(p) {
    const text = [
      "🟢 FUTURES ORDER OPENED", p.symbol + " · " + p.side,
      "Entry: " + p.entry, "SL: " + p.stop, "TP1: " + p.tp1 + " (60%)",
      "TP2: " + p.tp2 + " (40%)", "Margin: " + p.margin.toFixed(4) + " USDT",
      "Leverage: " + p.leverage + "x", "Quantity: " + p.quantity
    ].join("\n");
    try { await this.openBot.sendMessage(this.openChat, text); } catch (e) { console.error("[telegram-open]", e.message); }
  }
  async result(p) {
    const pnl = Number(p.pnl || 0);
    const text = [
      (pnl >= 0 ? "🏆 WIN" : "🔴 LOSS") + " · " + p.symbol,
      "Side: " + p.side, "Entry: " + p.entry, "Exit: " + p.exit,
      "Realized PNL: " + pnl.toFixed(4) + " USDT",
      "ROI: " + Number(p.pnlPct || 0).toFixed(2) + "%",
      "Reason: " + p.reason
    ].join("\n");
    try { await this.resultBot.sendMessage(this.resultChat, text); } catch (e) { console.error("[telegram-result]", e.message); }
  }
  async startup(message) {
    try { await this.openBot.sendMessage(this.openChat, message); } catch (e) { console.error("[telegram-startup]", e.message); }
  }
}
module.exports = { TelegramAlerts };
