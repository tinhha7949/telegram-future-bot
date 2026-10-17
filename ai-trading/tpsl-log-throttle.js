"use strict";

class TpslLogThrottle {
  constructor(maxEntries = 2000, minIntervalMs = 15 * 60 * 1000) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 2000);
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.lastBySymbol = new Map();
  }

  shouldLog(symbol, state, reason, now = Date.now()) {
    const key = String(symbol || "").trim();
    if (!key) return true;

    const signature = `${String(state || "UNKNOWN")}|${String(reason || "UNKNOWN")}`;
    const previous = this.lastBySymbol.get(key);

    if (!previous) {
      this.remember(key, signature, now);
      return true;
    }

    // Suppress repeated HOLDs even if the side/reason oscillates between scans.
    // At most one HOLD line per symbol per cooldown window.
    if (now - previous.lastLoggedAt < this.minIntervalMs) {
      previous.latestSignature = signature;
      this.lastBySymbol.delete(key);
      this.lastBySymbol.set(key, previous);
      return false;
    }

    // After the cooldown, only emit a line if the current state differs from
    // the last state that was actually logged.
    if (signature === previous.lastLoggedSignature) {
      previous.latestSignature = signature;
      this.lastBySymbol.delete(key);
      this.lastBySymbol.set(key, previous);
      return false;
    }

    this.remember(key, signature, now);
    return true;
  }

  remember(key, signature, now) {
    this.lastBySymbol.delete(key);
    this.lastBySymbol.set(key, {
      lastLoggedSignature: signature,
      latestSignature: signature,
      lastLoggedAt: now
    });

    while (this.lastBySymbol.size > this.maxEntries) {
      this.lastBySymbol.delete(this.lastBySymbol.keys().next().value);
    }
  }

  clear(symbol) {
    const key = String(symbol || "").trim();
    if (key) this.lastBySymbol.delete(key);
  }
}

module.exports = { TpslLogThrottle };
