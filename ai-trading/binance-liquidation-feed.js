"use strict";

const WebSocket = require("ws");

const STREAM_URL = "wss://fstream.binance.com/ws/!forceOrder@arr";
const WINDOW_MS = 15 * 60 * 1000;
const MAX_EVENTS_PER_SYMBOL = 2000;
const STALE_MS = 10 * 60 * 1000;

let socket = null;
let started = false;
let reconnectTimer = null;
let lastPongAt = 0;
const eventsBySymbol = new Map();

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
  reconnectTimer.unref?.();
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(STREAM_URL);
    socket.on("open", () => {
      lastPongAt = Date.now();
      socket?.on("pong", () => { lastPongAt = Date.now(); });
    });
    socket.on("message", raw => {
      let payload;
      try { payload = JSON.parse(String(raw)); } catch (_) { return; }
      const rows = Array.isArray(payload) ? payload : [payload];
      const now = Date.now();
      for (const item of rows) {
        const order = item?.o || item;
        const symbol = String(order?.s || order?.symbol || "").toUpperCase();
        const side = String(order?.S || order?.side || "").toUpperCase();
        const price = Number(order?.ap || order?.avgPrice || order?.p || order?.price);
        const quantity = Number(order?.q || order?.origQty || order?.z || order?.executedQty);
        const eventTime = Number(order?.T || item?.E || now);
        if (!symbol || !["BUY", "SELL"].includes(side) || !(price > 0 && quantity > 0) || !Number.isFinite(eventTime)) continue;
        const list = eventsBySymbol.get(symbol) || [];
        list.push({ time: eventTime, side, notional: price * quantity });
        const kept = list.filter(e => e.time >= now - WINDOW_MS).slice(-MAX_EVENTS_PER_SYMBOL);
        eventsBySymbol.set(symbol, kept);
      }
    });
    socket.on("error", () => {
      try { socket?.terminate(); } catch (_) {}
    });
    socket.on("close", () => {
      socket = null;
      scheduleReconnect();
    });
    socket.on("ping", () => { lastPongAt = Date.now(); });
  } catch (_) {
    socket = null;
    scheduleReconnect();
  }
}

function start() {
  if (started) return;
  started = true;
  connect();
}

function getImbalance(symbol, now = Date.now()) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !lastPongAt || now - lastPongAt > STALE_MS) return null;
  const rows = (eventsBySymbol.get(String(symbol || "").toUpperCase()) || []).filter(e => e.time >= now - WINDOW_MS);
  let shortLiquidationNotional = 0;
  let longLiquidationNotional = 0;
  for (const event of rows) {
    if (event.side === "BUY") shortLiquidationNotional += event.notional;
    else if (event.side === "SELL") longLiquidationNotional += event.notional;
  }
  const total = shortLiquidationNotional + longLiquidationNotional;
  return total > 0 ? (shortLiquidationNotional - longLiquidationNotional) / total : 0;
}

function stop() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  started = false;
  try { socket?.close(); } catch (_) {}
  socket = null;
  eventsBySymbol.clear();
}

module.exports = { start, stop, getImbalance, WINDOW_MS, STALE_MS };
