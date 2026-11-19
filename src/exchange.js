"use strict";
const crypto = require("node:crypto");

function makeClientId(prefix = "O") {
  const clean = String(prefix).replace(/[^A-Z0-9_-]/gi, "").slice(0, 2) || "O";
  return clean + crypto.randomBytes(11).toString("hex");
}

class Exchange {
  constructor(config, key, secret) {
    this.cfg = config.binance;
    this.key = key;
    this.secret = secret;
    // This bot is intentionally LIVE-only. BINANCE_TESTNET is ignored.
    this.base = this.cfg.baseUrl || "https://fapi.binance.com";
    this.filters = new Map();
  }
  async request(method, path, params = {}, signed = false) {
    const p = { ...params };
    if (signed) { p.timestamp = Date.now(); p.recvWindow = this.cfg.recvWindow; }
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) query.set(k, String(v));
    if (signed) query.set("signature", crypto.createHmac("sha256", this.secret).update(query.toString()).digest("hex"));
    const url = this.base + path + (query.size ? "?" + query.toString() : "");
    let last;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
      try {
        const response = await fetch(url, { method, headers: { "X-MBX-APIKEY": this.key }, signal: controller.signal });
        const body = await response.json();
        if (!response.ok) {
          const error = new Error(body.msg || ("Binance HTTP " + response.status));
          error.code = body.code; error.status = response.status;
          throw error;
        }
        return body;
      } catch (e) {
        last = e;
        // Never blindly retry an order submission: the exchange may have accepted it.
        if (method === "POST" || method === "DELETE") throw e;
        if (e.status && e.status !== 429 && e.status !== 418 && e.status < 500) throw e;
        if (attempt < this.cfg.maxRetries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      } finally { clearTimeout(timer); }
    }
    throw last;
  }
  async assertOneWayMode() {
    const mode = await this.request("GET", "/fapi/v1/positionSide/dual", {}, true);
    if (mode.dualSidePosition === true) throw new Error("Binance account is in Hedge Mode. Switch to One-way Mode before starting this bot.");
  }
  async exchangeInfo() {
    const info = await this.request("GET", "/fapi/v1/exchangeInfo");
    for (const s of info.symbols) {
      const f = Object.fromEntries(s.filters.map(x => [x.filterType, x]));
      if (s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT") {
        const lotStep = Number(f.LOT_SIZE?.stepSize);
        const marketStep = Number(f.MARKET_LOT_SIZE?.stepSize);
        const lotMin = Number(f.LOT_SIZE?.minQty);
        const marketMin = Number(f.MARKET_LOT_SIZE?.minQty);
        this.filters.set(s.symbol, {
          marketStepSize: marketStep > 0 ? marketStep : lotStep,
          marketMinQty: marketMin > 0 ? marketMin : lotMin,
          lotStepSize: lotStep > 0 ? lotStep : marketStep,
          lotMinQty: lotMin > 0 ? lotMin : marketMin,
          tickSize: Number(f.PRICE_FILTER?.tickSize),
          minNotional: Number(f.MIN_NOTIONAL?.notional || f.NOTIONAL?.minNotional || 5),
          triggerProtect: Number(s.triggerProtect || 0)
        });
      }
    }
    return info;
  }
  ticker24hr() { return this.request("GET", "/fapi/v1/ticker/24hr"); }
  klines(symbol, interval, limit = 150) { return this.request("GET", "/fapi/v1/klines", { symbol, interval, limit }); }
  account() { return this.request("GET", "/fapi/v2/account", {}, true); }
  positions() { return this.request("GET", "/fapi/v2/positionRisk", {}, true); }
  leverageBracket(symbol) { return this.request("GET", "/fapi/v1/leverageBracket", { symbol }, true); }
  openOrders(symbol) { return this.request("GET", "/fapi/v1/openOrders", { symbol }, true); }
  openAlgoOrders(symbol) { return this.request("GET", "/fapi/v1/openAlgoOrders", { symbol, algoType: "CONDITIONAL" }, true); }
  order(symbol, orderId, origClientOrderId) { return this.request("GET", "/fapi/v1/order", { symbol, orderId, origClientOrderId }, true); }
  algoOrder(algoId, clientAlgoId) { return this.request("GET", "/fapi/v1/algoOrder", { algoId, clientAlgoId }, true); }
  trades(symbol, startTime) { return this.request("GET", "/fapi/v1/userTrades", { symbol, startTime, limit: 1000 }, true); }
  setLeverage(symbol, leverage) { return this.request("POST", "/fapi/v1/leverage", { symbol, leverage }, true); }
  setMarginType(symbol, marginType) { return this.request("POST", "/fapi/v1/marginType", { symbol, marginType }, true).catch(e => { if (e.code !== -4046) throw e; }); }
  newOrder(params) {
    return this.request("POST", "/fapi/v1/order", { ...params, newClientOrderId: params.newClientOrderId || makeClientId("E") }, true);
  }
  newAlgoOrder(params) {
    return this.request("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      ...params,
      clientAlgoId: params.clientAlgoId || makeClientId("A")
    }, true);
  }
  cancelOrder(symbol, orderId) { return this.request("DELETE", "/fapi/v1/order", { symbol, orderId }, true); }
  cancelAlgoOrder(algoId, clientAlgoId) {
    return this.request("DELETE", "/fapi/v1/algoOrder", { algoId, clientAlgoId }, true);
  }
  cancelAll(symbol) { return this.request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, true); }
  cancelAllAlgo(symbol) { return this.request("DELETE", "/fapi/v1/algoOpenOrders", { symbol }, true); }
  async cancelProtection(symbol, ids = []) {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    const results = await Promise.allSettled(unique.map(id => this.cancelAlgoOrder(id)));
    return results;
  }
  quantity(symbol, raw, marketOrder = false) {
    const f = this.filters.get(symbol);
    if (!f) throw new Error("Missing exchange filters for " + symbol);
    const step = marketOrder ? f.marketStepSize : f.lotStepSize;
    const min = marketOrder ? f.marketMinQty : f.lotMinQty;
    const q = Math.floor((raw + step * 1e-10) / step) * step;
    const precision = Math.max(0, (String(step).split(".")[1] || "").replace(/0+$/, "").length);
    const value = Number(q.toFixed(precision));
    if (!(value > 0) || value < min) throw new Error("Quantity below Binance minQty/stepSize for " + symbol);
    return value;
  }
  price(symbol, raw, rounding = "NEAREST") {
    const f = this.filters.get(symbol);
    if (!f) throw new Error("Missing exchange filters for " + symbol);
    const units = raw / f.tickSize;
    const n = (rounding === "UP" ? Math.ceil(units - 1e-10) : rounding === "DOWN" ? Math.floor(units + 1e-10) : Math.round(units)) * f.tickSize;
    const precision = Math.max(0, (String(f.tickSize).split(".")[1] || "").replace(/0+$/, "").length);
    return Number(n.toFixed(precision));
  }
}
module.exports = { Exchange, makeClientId };
