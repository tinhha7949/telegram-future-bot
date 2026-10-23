"use strict";

const WebSocket = require("ws");
const { CONFIG } = require("./config");

const STREAM_URL = "wss://fstream.binance.com/market/ws/!forceOrder@arr";
const WINDOW_MS = CONFIG.LIQUIDATION_WINDOW_MINUTES * 60 * 1000;
const MAX_EVENTS_PER_SYMBOL = CONFIG.LIQUIDATION_MAX_EVENTS_PER_SYMBOL;
const STALE_MS = CONFIG.LIQUIDATION_STALE_MINUTES * 60 * 1000;

let socket = null;
let started = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastPongAt = 0;
const eventsBySymbol = new Map();

function scheduleReconnect() {
  if (!started) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, CONFIG.LIQUIDATION_RECONNECT_MS);
  reconnectTimer.unref?.();
}

function connect() {
  if (!started) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    const connection = new WebSocket(STREAM_URL);
    socket = connection;
    connection.on("open", () => {
      if (!started || socket !== connection) return;
      lastPongAt = Date.now();
      connection.on("pong", () => { if (socket === connection) lastPongAt = Date.now(); });
    });
    connection.on("message", raw => {
      if (!started || socket !== connection) return;
      let payload;
      try { payload = JSON.parse(String(raw)); } catch (_) { return; }
      const rows = Array.isArray(payload) ? payload : [payload];
      const now = Date.now();
      for (const item of rows) {
        const order = item?.o || item;
        const symbol = String(order?.s || order?.symbol || "").toUpperCase();
        const side = String(order?.S || order?.side || "").toUpperCase();
        const price = Number(order?.ap || order?.avgPrice || order?.p || order?.price);
        const quantity = Number(order?.z ?? order?.executedQty ?? 0);
        const eventTime = Number(order?.T || item?.E || now);
        if (!symbol || !["BUY", "SELL"].includes(side) || !(price > 0 && quantity > 0) || !Number.isFinite(eventTime)) continue;
        const list = eventsBySymbol.get(symbol) || [];
        list.push({ time: eventTime, side, notional: price * quantity });
        const kept = list.filter(e => e.time >= now - WINDOW_MS).slice(-MAX_EVENTS_PER_SYMBOL);
        eventsBySymbol.set(symbol, kept);
      }
    });
    connection.on("error", () => {
      try { connection.terminate(); } catch (_) {}
    });
    connection.on("close", () => {
      if (socket !== connection) return;
      socket = null;
      scheduleReconnect();
    });
    connection.on("ping", () => {
      if (socket === connection) lastPongAt = Date.now();
    });
  } catch (_) {
    socket = null;
    scheduleReconnect();
  }
}

function start() {
  if (started) return;
  started = true;
  connect();
  heartbeatTimer=setInterval(()=>{
    if(!socket||socket.readyState!==WebSocket.OPEN)return;
    if(Date.now()-lastPongAt>STALE_MS){
      try { socket.terminate(); } catch (_) {}
      return;
    }
    try { socket.ping(); }
    catch (_) { try { socket.terminate(); } catch (_) {} }
    const cutoff=Date.now()-WINDOW_MS;
    for(const [symbol,list] of eventsBySymbol){
      const kept=list.filter(e=>e.time>=cutoff);
      if(kept.length)eventsBySymbol.set(symbol,kept);else eventsBySymbol.delete(symbol);
    }
  },CONFIG.LIQUIDATION_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

function getImbalance(symbol, now = Date.now()) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !lastPongAt || now - lastPongAt > STALE_MS) return null;
  const rows = (eventsBySymbol.get(String(symbol || "").toUpperCase()) || []).filter(e => e.time >= now - WINDOW_MS && e.time <= now);
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
  if(heartbeatTimer)clearInterval(heartbeatTimer);
  heartbeatTimer=null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  started = false;
  try { socket?.close(); } catch (_) {}
  socket = null;
  eventsBySymbol.clear();
}

module.exports = { start, stop, getImbalance, WINDOW_MS, STALE_MS };
