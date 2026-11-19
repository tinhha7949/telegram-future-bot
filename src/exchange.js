"use strict";
const crypto = require("node:crypto");
class Exchange {
  constructor(config, key, secret) {
    this.cfg = config.binance; this.key = key; this.secret = secret;
    this.base = process.env.BINANCE_TESTNET === "true" ? this.cfg.testnetBaseUrl : this.cfg.baseUrl;
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
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
      try {
        const response = await fetch(url, { method, headers: { "X-MBX-APIKEY": this.key }, signal: controller.signal });
        const body = await response.json();
        if (!response.ok) {
          const error = new Error(body.msg || ("Binance HTTP " + response.status));
          error.code = body.code; error.status = response.status;
          if (response.status === 429 || response.status === 418 || response.status >= 500) throw error;
          throw error;
        }
        return body;
      } catch (e) {
        last = e;
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
      if (s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT") this.filters.set(s.symbol, {
        stepSize: Number(f.MARKET_LOT_SIZE?.stepSize || f.LOT_SIZE?.stepSize),
        minQty: Number(f.MARKET_LOT_SIZE?.minQty || f.LOT_SIZE?.minQty),
        tickSize: Number(f.PRICE_FILTER?.tickSize),
        minNotional: Number(f.MIN_NOTIONAL?.notional || 5)
      });
    }
    return info;
  }
  ticker24hr() { return this.request("GET", "/fapi/v1/ticker/24hr"); }
  klines(symbol, interval, limit = 150) { return this.request("GET", "/fapi/v1/klines", { symbol, interval, limit }); }
  account() { return this.request("GET", "/fapi/v2/account", {}, true); }
  positions() { return this.request("GET", "/fapi/v2/positionRisk", {}, true); }
  openOrders(symbol) { return this.request("GET", "/fapi/v1/openOrders", { symbol }, true); }
  order(symbol, orderId) { return this.request("GET", "/fapi/v1/order", { symbol, orderId }, true); }
  trades(symbol, startTime) { return this.request("GET", "/fapi/v1/userTrades", { symbol, startTime, limit: 1000 }, true); }
  setLeverage(symbol, leverage) { return this.request("POST", "/fapi/v1/leverage", { symbol, leverage }, true); }
  setMarginType(symbol, marginType) { return this.request("POST", "/fapi/v1/marginType", { symbol, marginType }, true).catch(e => { if (e.code !== -4046) throw e; }); }
  newOrder(params) { return this.request("POST", "/fapi/v1/order", params, true); }
  cancelOrder(symbol, orderId) { return this.request("DELETE", "/fapi/v1/order", { symbol, orderId }, true); }
  cancelAll(symbol) { return this.request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, true); }
  quantity(symbol, raw) {
    const f = this.filters.get(symbol); if (!f) throw new Error("Missing exchange filters for " + symbol);
    const q = Math.floor((raw + 1e-12) / f.stepSize) * f.stepSize;
    const precision = Math.max(0, (String(f.stepSize).split(".")[1] || "").replace(/0+$/, "").length);
    const value = Number(q.toFixed(precision));
    if (value < f.minQty) throw new Error("Quantity below minQty for " + symbol);
    return value;
  }
  price(symbol, raw) {
    const f = this.filters.get(symbol); if (!f) throw new Error("Missing exchange filters for " + symbol);
    const n = Math.round(raw / f.tickSize) * f.tickSize;
    const precision = Math.max(0, (String(f.tickSize).split(".")[1] || "").replace(/0+$/, "").length);
    return Number(n.toFixed(precision));
  }
}
module.exports = { Exchange };
