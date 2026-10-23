"use strict";
const { CONFIG } = require("./config");
const WebSocket = require("ws");
const URLS = {
  mark: "wss://fstream.binance.com/market/ws/!markPrice@arr@1s",
  book: "wss://fstream.binance.com/public/ws/!bookTicker",
};
class BinanceMarketFeed {
  constructor({
    Socket = WebSocket,
    now = Date.now,
    serverNow = now,
    timers = globalThis,
    onStatus = (message) => console.log("BINANCE MARKET WS", message),
  } = {}) {
    this.Socket = Socket;
    this.now = now;
    this.serverNow = serverNow;
    this.timers = timers;
    this.onStatus = onStatus;
    this.records = { mark: new Map(), book: new Map() };
    this.connections = new Map();
    this.started = false;
  }
  start() {
    if (this.started) return;
    this.started = true;
    for (const kind of Object.keys(URLS)) this.connect(kind);
  }
  connect(kind) {
    if (!this.started) return;
    const previous = this.connections.get(kind),
      state = { retry: previous?.retry || 0, lastMessage: this.now() };
    this.connections.set(kind, state);
    try {
      state.socket = new this.Socket(URLS[kind]);
    } catch (_) {
      this.reconnect(kind, state);
      return;
    }
    const socket = state.socket;
    socket.on("open", () => {
      state.retry = 0;
      state.lastMessage = this.now();
      this.onStatus(kind + " connected");
      state.heartbeat = this.timers.setInterval(() => {
        try {
          if (this.now() - state.lastMessage > CONFIG.MARKET_WS_STALE_MS) socket.terminate();
          else if (socket.readyState === 1) socket.ping();
        } catch (_) {
          // A close racing with the heartbeat is handled by the close event.
        }
      }, CONFIG.MARKET_WS_HEARTBEAT_MS);
      state.heartbeat.unref?.();
    });
    socket.on("message", (raw) => {
      if (this.connections.get(kind) !== state || !this.started) return;
      state.lastMessage = this.now();
      try { this.ingest(kind, raw); }
      catch (error) { this.onStatus(kind + " invalid message: " + error.message); }
    });
    socket.on("pong", () => {
      state.lastMessage = this.now();
    });
    socket.on("ping", () => {
      state.lastMessage = this.now();
    });
    socket.on("error", () => {
      try { socket.terminate(); } catch (_) {}
    });
    socket.on("close", () => {
      this.timers.clearInterval(state.heartbeat);
      if (this.connections.get(kind) === state) {
        this.records[kind].clear();
        this.reconnect(kind, state);
      }
    });
  }
  reconnect(kind, state) {
    if (!this.started || state.reconnect) return;
    state.retry += 1;
    state.reconnect = this.timers.setTimeout(
      () => {
        state.reconnect = null;
        this.connect(kind);
      },
      Math.min(CONFIG.MARKET_WS_RECONNECT_MAX_MS,
        CONFIG.MARKET_WS_RECONNECT_BASE_MS * 2 ** Math.min(state.retry - 1, CONFIG.MARKET_WS_RECONNECT_EXPONENT_CAP)),
    );
    state.reconnect.unref?.();
  }
  ingest(kind, raw) {
    let value;
    try {
      value = JSON.parse(String(raw));
    } catch (_) {
      return;
    }
    value = value?.data ?? value;
    for (const r of Array.isArray(value) ? value : [value]) {
      if (!r || (r.st != null && Number(r.st) !== 1)) continue;
      const symbol = String(r.s || "").toUpperCase(),
        eventAt = Number(r.E),
        observedAt = this.now();
      if (!symbol || !Number.isFinite(eventAt) || eventAt > this.serverNow())
        continue;
      let data;
      if (
        kind === "mark" &&
        Number(r.p) > 0 &&
        r.r != null &&
        Number.isFinite(Number(r.r))
      )
        data = { symbol, markPrice: r.p, lastFundingRate: r.r };
      if (kind === "book" && Number(r.b) > 0 && Number(r.a) >= Number(r.b))
        data = {
          symbol,
          bidPrice: r.b,
          askPrice: r.a,
          bidQty: r.B,
          askQty: r.A,
        };
      const old = this.records[kind].get(symbol);
      if (data && (!old || eventAt >= old.eventAt))
        this.records[kind].set(symbol, {
          data,
          observedAt,
          eventAt,
          latencyMs: Math.max(0, this.serverNow() - eventAt),
          source: "WEBSOCKET",
        });
    }
  }
  get(kind, symbol) {
    const r = this.records[kind].get(symbol);
    if (
      !r ||
      r.observedAt > this.now() ||
      r.eventAt > this.serverNow() ||
      this.now() - r.observedAt > CONFIG.MARKET_WS_MAX_EVENT_AGE_MS ||
      this.serverNow() - r.eventAt > CONFIG.MARKET_WS_MAX_EVENT_AGE_MS
    )
      return null;
    return structuredClone(r);
  }
  stop() {
    this.started = false;
    for (const s of this.connections.values()) {
      this.timers.clearTimeout(s.reconnect);
      this.timers.clearInterval(s.heartbeat);
      s.socket?.terminate();
    }
    this.connections.clear();
    this.records.mark.clear();
    this.records.book.clear();
  }
}
module.exports = { BinanceMarketFeed, URLS };
