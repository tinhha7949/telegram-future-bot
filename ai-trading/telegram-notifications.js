"use strict";
const crypto = require("node:crypto");
const { CONFIG } = require("./config");

function entryMessage(t) {
  return [
    `MỞ LỆNH THÀNH CÔNG | ${t.symbol} ${t.side}`,
    `Khối lượng: ${t.actualQuantity} | Entry: ${t.entry}`,
    `SL: ${t.sl}`,
    `TP1: ${t.tp1} | chốt ${100 * CONFIG.TP_BATCHES[0] / (CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1])}% (${t.tp1Quantity})`,
    `TP2: ${t.tp2} | phần còn lại (${t.tp2Quantity})`,
    `Kế hoạch: ${t.tradePlan?.outcomeMode === "AI7_LABELED" ? "AI7 MAE/MFE" : "ATR14 cold-start"} | Timeout: ${CONFIG.TIMEOUT_BARS * CONFIG.BAR_HOURS}h`,
    `Mã lệnh: ${t.signalKey}`,
  ].join("\n");
}

// Persist intent before delivery. No Telegram HTTP request runs on the order
// management path. A restart resumes PENDING messages using the same event key.
class TelegramNotifications {
  constructor({ db, env = process.env, fetchImpl = globalThis.fetch,
    now = Date.now, log = console } = {}) {
    Object.assign(this, { env, fetch: fetchImpl, now, log });
    this.rows = db.collection("telegram_notification_outbox");
    this.cooldown = new Map();
    this.controller = new AbortController();
    this.running = false;
    this.stopped = false;
  }
  async initialize() {
    await this.rows.createIndex({ eventKey: 1 }, { unique: true, name: "uniq_telegram_event" });
    await this.rows.createIndex({ route: 1, status: 1, nextAttemptAt: 1, createdAt: 1 },
      { name: "telegram_pending_delivery" });
    // Only confirmed sent messages expire; pending deliveries survive outages.
    await this.rows.createIndex({ sentAt: 1 },
      { expireAfterSeconds: CONFIG.TELEGRAM_SENT_RETENTION_DAYS * 86400, name: "expire_sent_telegram_30d" });
  }
  destination(route) {
    return route === "entry"
      ? { token: this.env.BOT_TOKEN, chatId: this.env.CHAT_ID }
      : { token: this.env.BOT_TOKEN_2 || this.env.BOT_TOKEN,
          chatId: this.env.AI_CHAT_ID || this.env.CHAT_ID };
  }
  async enqueue(route, eventKey, text) {
    if (!["entry", "result"].includes(route) || !eventKey)
      throw new Error("INVALID_TELEGRAM_EVENT");
    try {
      await this.rows.updateOne({ eventKey }, { $setOnInsert: {
        eventKey, route, text: String(text).slice(0, CONFIG.TELEGRAM_MAX_MESSAGE_CHARS), status: "PENDING",
        attempts: 0, nextAttemptAt: 0, createdAt: this.now(),
      } }, { upsert: true });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  entry(trade) {
    return this.enqueue("entry", `ENTRY:${trade.signalKey}`, entryMessage(trade));
  }
  report(text, { eventKey } = {}) {
    // Repeated state warnings share one hourly event rather than flooding chat.
    const key = eventKey || "ALERT:" + Math.floor(this.now() / CONFIG.TELEGRAM_ALERT_DEDUP_WINDOW_MS) + ":" +
      crypto.createHash("sha256").update(String(text)).digest("hex");
    return this.enqueue("result", key, text);
  }
  async flush() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      for (const route of ["entry", "result"]) {
        if (this.stopped) break;
        if ((this.cooldown.get(route) || 0) > this.now()) continue;
        const row = (await this.rows.find({ route, status: "PENDING",
          nextAttemptAt: { $lte: this.now() } }).sort({ createdAt: 1 }).limit(1).toArray())[0];
        if (!row) continue;
        const { token, chatId } = this.destination(route);
        const attempts = row.attempts + 1;
        let failure = "MISSING_DESTINATION", delay = CONFIG.TELEGRAM_DELIVERY_MISSING_ROUTE_MS, data, response;
        if (token && chatId) {
          try {
            response = await this.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: row.text }),
              signal: AbortSignal.any([AbortSignal.timeout(CONFIG.TELEGRAM_DELIVERY_TIMEOUT_MS), this.controller.signal]),
            });
            data = await response.json();
            if (response.ok && data?.ok === true) {
              await this.rows.updateOne({ eventKey: row.eventKey }, { $set: {
                status: "SENT", attempts, sentAt: new Date(this.now()),
                messageId: data.result?.message_id ?? null,
              } });
              this.cooldown.set(route, this.now() + CONFIG.TELEGRAM_DELIVERY_IDLE_COOLDOWN_MS);
              continue;
            }
            failure = "API_" + (data?.error_code || response.status);
          } catch (_) {
            // Do not log the request URL/error: it can contain the bot token.
            failure = "DELIVERY_UNCONFIRMED";
          }
          const retryAfter = Number(data?.parameters?.retry_after);
          delay = retryAfter > 0 ? Math.ceil(retryAfter * 1000)
            : [400, 401, 403, 404].includes(Number(data?.error_code || response?.status))
              ? CONFIG.TELEGRAM_DELIVERY_BAD_AUTH_RETRY_MS
              : Math.min(CONFIG.TELEGRAM_DELIVERY_RETRY_MAX_MS,
                CONFIG.TELEGRAM_DELIVERY_RETRY_BASE_MS *
                2 ** Math.min(attempts - 1, CONFIG.TELEGRAM_DELIVERY_RETRY_EXPONENT_CAP));
        }
        this.cooldown.set(route, this.now() + delay);
        await this.rows.updateOne({ eventKey: row.eventKey }, { $set: {
          attempts, nextAttemptAt: this.now() + delay, lastError: failure,
        } });
        this.log.error("TELEGRAM DELIVERY PENDING", route, row.eventKey, failure);
      }
    } finally {
      this.running = false;
    }
  }
  stop() {
    this.stopped = true;
    this.controller.abort();
  }
}
module.exports = { TelegramNotifications, entryMessage };
