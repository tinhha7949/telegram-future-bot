"use strict";
const { CONFIG } = require("./config");
const MINUTE = 60000;
function requestWeight(path, p = {}) {
  if (/\/klines$/.test(path)) {
    const n = Number(p.limit || 500);
    return path.startsWith("/api/")
      ? 2
      : n < 100
        ? 1
        : n < 500
          ? 2
          : n <= 1000
            ? 5
            : 10;
  }
  if (path.endsWith("/income")) return 30;
  if (path.endsWith("/openOrders")) return p.symbol ? 1 : 40;
  if (path.endsWith("/openAlgoOrders")) return 40;
  if (path.endsWith("/depth"))
    return Number(p.limit || 500) <= 50
      ? 2
      : Number(p.limit) <= 100
        ? 5
        : Number(p.limit) <= 500
          ? 10
          : 20;
  if (/positionRisk|\/account$|userTrades/.test(path)) return 5;
  if (path.endsWith("/ticker/bookTicker")) return p.symbol ? 2 : 5;
  if (path.endsWith("/premiumIndex")) return p.symbol ? 1 : 10;
  // Count zero-weight statistics endpoints as one locally, in addition to
  // their separate request-count limiter. Conservative for unknown routes.
  return /order|algo/i.test(path) ? 5 : 1;
}
class RequestBudget {
  constructor({
    now = Date.now,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    limit = CONFIG.BINANCE_REQUEST_WEIGHT_LIMIT,
    onCooldown = (r) =>
      console.warn("BINANCE REST COOLDOWN", "retryAfterMs=" + r.retryAfterMs),
  } = {}) {
    this.now = now;
    this.wait = wait;
    this.limit = limit;
    this.states = new Map();
    this.onCooldown = onCooldown;
  }
  state(host) {
    if (!this.states.has(host))
      this.states.set(host, {
        events: [],
        oi: [],
        blockedUntil: 0,
        nextBackgroundAt: 0,
        remoteWindow: -1,
        remoteUsed: 0,
        remoteExtra: 0,
      });
    return this.states.get(host);
  }
  configure(rateLimits = []) {
    const row = rateLimits.find(
      (r) =>
        r.rateLimitType === "REQUEST_WEIGHT" &&
        r.interval === "MINUTE" &&
        Number(r.intervalNum) === 1,
    );
    if (Number(row?.limit) > 0)
      this.limit = Math.min(this.limit, Math.floor(Number(row.limit) * CONFIG.BINANCE_SERVER_WEIGHT_SAFETY_RATIO));
  }
  stop() {
    this.stopped = true;
  }
  async acquire({ host, path, params, signed, method }) {
    const s = this.state(host),
      weight = requestWeight(path, params),
      priority =
        (signed && !/income|userTrades/.test(path)) || path.endsWith("/time"),
      statistics = path.startsWith("/futures/data/");
    for (;;) {
      if (this.stopped) throw new Error("EXCHANGE_CLIENT_STOPPED");
      const now = this.now();
      s.events = s.events.filter((e) => e.at > now - MINUTE);
      s.oi = s.oi.filter((at) => at > now - 5 * MINUTE);
      if (s.remoteWindow !== Math.floor(now / MINUTE)) {
        s.remoteWindow = Math.floor(now / MINUTE);
        s.remoteUsed = 0;
        s.remoteExtra = 0;
      }
      const localUsed = s.events.reduce((sum, e) => sum + e.weight, 0),
        used = Math.max(localUsed, s.remoteUsed + s.remoteExtra),
        ceiling = priority ? this.limit : Math.floor(this.limit * CONFIG.BINANCE_BACKGROUND_BUDGET_RATIO);
      if (weight > ceiling)
        throw new Error("REQUEST_WEIGHT_EXCEEDS_LOCAL_BUDGET");
      let delay = Math.max(
        0,
        s.blockedUntil - now,
        priority ? 0 : s.nextBackgroundAt - now,
      );
      if (used + weight > ceiling)
        delay = Math.max(
          delay,
          s.events[0]
            ? s.events[0].at + MINUTE - now + 1
            : MINUTE - (now % MINUTE) + 1,
        );
      if (statistics && s.oi.length >= CONFIG.BINANCE_OI_REQUESTS_PER_5MIN)
        delay = Math.max(delay, s.oi[0] + 5 * MINUTE - now + 1);
      if (delay > 0) {
        await this.wait(Math.min(delay, CONFIG.BINANCE_REQUEST_BACKOFF_CAP_MS));
        continue;
      }
      s.events.push({ at: now, weight });
      if (s.remoteUsed) s.remoteExtra += weight;
      if (statistics) s.oi.push(now);
      if (!priority)
        s.nextBackgroundAt =
          now + (weight * MINUTE) / Math.max(1, this.limit * CONFIG.BINANCE_BACKGROUND_BUDGET_RATIO);
      return;
    }
  }
  observe(host, response, data) {
    const s = this.state(host),
      now = this.now(),
      get = (name) => response.headers?.get?.(name);
    const used = Number(get("x-mbx-used-weight-1m"));
    if (Number.isFinite(used) && used > 0) {
      const window = Math.floor(now / MINUTE);
      if (s.remoteWindow !== window || used > s.remoteUsed) {
        s.remoteUsed = used;
        s.remoteExtra = 0;
      }
      s.remoteWindow = window;
    }
    if (![429, 418].includes(response.status) && Number(data?.code) !== -1003)
      return;
    const retry = get("retry-after");
    let delay =
      retry != null && retry !== "" && Number.isFinite(Number(retry))
        ? Number(retry) * 1000
        : Date.parse(retry) - now;
    if (!(delay > 0)) delay = response.status === 418 ? CONFIG.BINANCE_HTTP_418_FALLBACK_MS : CONFIG.BINANCE_HTTP_429_FALLBACK_MS;
    const until = String(data?.msg || "").match(/until\s+(\d{10,13})/i);
    if (until)
      delay = Math.max(
        delay,
        Number(until[1]) * (until[1].length === 10 ? 1000 : 1) - now,
      );
    const wasBlocked = s.blockedUntil > now;
    s.blockedUntil = Math.max(s.blockedUntil, now + delay);
    if (!wasBlocked)
      this.onCooldown({
        retryAfterMs: s.blockedUntil - now,
        status: response.status,
      });
  }
}
module.exports = { RequestBudget, requestWeight };
