"use strict";

class TpslLogThrottle {
  constructor(maxEntries = 2000) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 2000);
    this.lastBySymbol = new Map();
  }

  shouldLog(symbol, state, reason) {
    const key = String(symbol || "").trim();
    if (!key) return true;
    const signature = `${String(state || "UNKNOWN")}|${String(reason || "UNKNOWN")}`;
    if (this.lastBySymbol.get(key) === signature) return false;
    this.lastBySymbol.delete(key);
    this.lastBySymbol.set(key, signature);
    while (this.lastBySymbol.size > this.maxEntries) {
      this.lastBySymbol.delete(this.lastBySymbol.keys().next().value);
    }
    return true;
  }

  clear(symbol) {
    const key = String(symbol || "").trim();
    if (key) this.lastBySymbol.delete(key);
  }
}

module.exports = { TpslLogThrottle };
