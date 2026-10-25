"use strict";
const { CONFIG } = require("./config");
const crypto = require("node:crypto");
const { isRiskWithinBudget } = require("./execution-risk");
const { RequestBudget } = require("./binance-request-budget");
const { FourHourHistory } = require("./four-hour-history");
const { BinanceMarketFeed } = require("./binance-market-feed");

class ExchangeError extends Error {
  constructor(message, { code, ambiguous = false } = {}) {
    super(message);
    this.code = code;
    this.ambiguous = ambiguous;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decimals = (step) => {
  const [base, exp = "0"] = String(step).toLowerCase().split("e");
  return Math.max(0, (base.split(".")[1] || "").length - Number(exp));
};
function roundStep(value, step, mode = "floor") {
  if (!(
    Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(step) &&
    step > 0
  ))
    return NaN;
  const units = value / step;
  return Number(
    (Math[mode](units + (mode === "floor" ? 1e-9 : -1e-9)) * step).toFixed(
      decimals(step),
    ),
  );
}
function symbolRules(info) {
  const f = (type) => info?.filters?.find((f) => f.filterType === type);
  const lot = f("LOT_SIZE"),
    market = f("MARKET_LOT_SIZE"),
    price = f("PRICE_FILTER"),
    notional = f("MIN_NOTIONAL") || f("NOTIONAL");
  const steps = [Number(lot?.stepSize), Number(market?.stepSize)].filter(
    (v) => v > 0,
  );
  const step = Math.max(...steps),
    tick = Number(price?.tickSize);
  if (
    !(step > 0 && tick > 0) ||
    steps.some((s) => Math.abs(step / s - Math.round(step / s)) > 1e-7)
  )
    throw new Error("INVALID_SYMBOL_RULES");
  return {
    step,
    tick,
    minQty: Math.max(Number(lot?.minQty) || 0, Number(market?.minQty) || 0),
    maxQty: Math.min(
      ...[lot?.maxQty, market?.maxQty].map(Number).filter((v) => v > 0),
    ),
    minNotional: Number(notional?.notional ?? notional?.minNotional ?? 5),
  };
}
function sizeTrade(decision, equity, riskFraction, info) {
  const r = symbolRules(info),
    long = decision.side === "LONG",
    entry = Number(decision.entry);
  const ai7 = decision.tradePlan?.outcomeMode === "AI7_LABELED";
  // Exchange tick rounding never widens an AI-7 p80 stop beyond its quantile.
  const sl = roundStep(
    Number(decision.sl),
    r.tick,
    ai7 ? (long ? "ceil" : "floor") : long ? "floor" : "ceil",
  );
  const tp1 = roundStep(Number(decision.tp1), r.tick,
    long ? "ceil" : "floor");
  const tp2 = roundStep(
    Number(decision.tp2 ?? decision.tp),
    r.tick,
    long ? "ceil" : "floor",
  );
  if (
    !(entry > 0 && equity > 0 && riskFraction > 0 && riskFraction <= 1) ||
    (long
      ? !(sl < entry && entry < tp1 && tp1 <= tp2)
      : !(tp2 <= tp1 && tp1 < entry && entry < sl))
  )
    return null;
  const budget = equity * riskFraction,
    distance = Math.abs(entry - sl);
  if (Math.abs(tp1 - entry) + Number.EPSILON * Math.max(entry, tp1) <
      CONFIG.MIN_RR * distance) return null;
  const totalLots = CONFIG.TP_BATCHES[0] + CONFIG.TP_BATCHES[1];
  const quantity = roundStep(Math.min(budget / distance, r.maxQty), totalLots * r.step);
  const tp1Quantity = roundStep(quantity * CONFIG.TP_BATCHES[0] / totalLots, r.step);
  const tp2Quantity = roundStep(quantity - tp1Quantity, r.step);
  if (
    !(tp1Quantity >= r.minQty && tp2Quantity >= r.minQty && quantity * entry >= r.minNotional) ||
    !isRiskWithinBudget(quantity * distance, budget)
  )
    return null;
  return {
    quantity,
    tp1Quantity,
    tp2Quantity,
    sl,
    tp1,
    tp2,
    risk: budget,
    initialRisk: distance,
    notional: quantity * entry,
    rules: r,
  };
}

class BinanceExchange {
  constructor({
    key,
    secret,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    wait = sleep,
    budget,
    marketFeed,
  } = {}) {
    this.key = key;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.now = now;
    this.wait = wait;
    this.offset = 0;
    this.exchangeInfo = null;
    this.exchangeInfoAt = 0;
    this.budget = budget || new RequestBudget({ now, wait });
    this.requestCache = new Map();
    this.requestPending = new Map();
    this.observations = new WeakMap();
    this.marketFeed =
      marketFeed ||
      new BinanceMarketFeed({ now, serverNow: () => this.now() + this.offset });
    this.history4h = new FourHourHistory(
      (symbol, limit, extra) => this.rawCandles(symbol, "4h", limit, extra),
      () => this.now() + this.offset,
    );
  }
  async request(
    path,
    params = {},
    {
      method = "GET",
      signed = false,
      host = "https://fapi.binance.com",
      timeoutMs = CONFIG.BINANCE_HTTP_TIMEOUT_MS,
    } = {},
  ) {
    const attempts = method === "GET" ? CONFIG.BINANCE_HTTP_GET_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Queue before signing: recvWindow starts at actual dispatch, not while
      // a background history request waits for the shared IP budget.
      await this.budget.acquire({ host, path, params, signed, method });
      const values = { ...params };
      // Clock synchronization uses a network midpoint and can yield half-ms
      // offsets. Binance LONG parameters reject decimal/exponential strings.
      for (const key of ["startTime", "endTime", "timestamp", "recvWindow"]) {
        if (values[key] == null) continue;
        const value = Math.floor(Number(values[key]));
        if (!Number.isSafeInteger(value) || value < 0)
          throw new ExchangeError("INVALID_TIME_PARAMETER_" + key);
        values[key] = value;
      }
      if (signed) {
        values.recvWindow = CONFIG.BINANCE_RECV_WINDOW_MS;
        values.timestamp = Math.floor(this.now() + this.offset);
      }
      let query = new URLSearchParams(
        Object.entries(values)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      if (signed)
        query +=
          "&signature=" +
          crypto.createHmac("sha256", this.secret).update(query).digest("hex");
      let response, data;
      const sentAt = this.now();
      try {
        response = await this.fetch(host + path + (query ? "?" + query : ""), {
          method,
          headers: signed ? { "X-MBX-APIKEY": this.key } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        data = await response.json();
      } catch (error) {
        if (response) this.budget.observe(host, response, data);
        if (method === "GET" && attempt + 1 < attempts) {
          await this.wait(CONFIG.BINANCE_HTTP_RETRY_MS);
          continue;
        }
        throw new ExchangeError("EXCHANGE_RESPONSE_UNAVAILABLE", {
          ambiguous: method !== "GET",
        });
      }
      this.budget.observe(host, response, data);
      if (!response.ok || Number(data?.code) < 0) {
        const error = new ExchangeError(
          String(data?.msg || "EXCHANGE_HTTP_" + response.status),
          {
            code: Number(data?.code),
            ambiguous:
              method !== "GET" &&
              (response.status >= 500 || response.status === 408 ||
                [-1006, -1007].includes(Number(data?.code))),
          },
        );
        if (
          method === "GET" &&
          ([429, 418].includes(response.status) || Number(data?.code) === -1003)
        ) {
          // Rate limiting is a shared, timed pause, not a reason for the startup
          // process to exit and let PM2 create a new client against the same ban.
          attempt--;
          continue;
        }
        if (
          method === "GET" &&
          attempt + 1 < attempts &&
          response.status >= 500
        ) {
          await this.wait(CONFIG.BINANCE_HTTP_5XX_RETRY_MS);
          continue;
        }
        throw error;
      }
      if (data && typeof data === "object")
        this.observations.set(data, {
          sentAt,
          observedAt: this.now(),
          latencyMs: this.now() - sentAt,
          source: "REST",
        });
      return data;
    }
  }
  async cachedRequest(path, params = {}, ttlMs = 0) {
    const key = path + ":" + JSON.stringify(params),
      cached = this.requestCache.get(key);
    if (cached && this.now() - cached.at < ttlMs) return cached.data;
    if (this.requestPending.has(key)) return this.requestPending.get(key);
    const pending = this.request(path, params).then((data) => {
      this.requestCache.set(key, { at: this.now(), data });
      return data;
    });
    this.requestPending.set(key, pending);
    try {
      return await pending;
    } finally {
      this.requestPending.delete(key);
    }
  }
  startMarketData() {
    this.marketFeed.start();
  }
  stopMarketData() {
    this.marketFeed.stop();
  }
  close() {
    this.stopMarketData();
    this.budget.stop?.();
  }
  async syncTime() {
    const start = this.now(),
      r = await this.request("/fapi/v1/time");
    if (!Number.isFinite(r?.serverTime)) throw new Error("INVALID_SERVER_TIME");
    const timing = this.observations.get(r);
    this.offset =
      r.serverTime -
      ((timing?.sentAt ?? start) + (timing?.observedAt ?? this.now())) / 2;
  }
  async initialize() {
    await this.syncTime();
    const mode = await this.request(
      "/fapi/v1/positionSide/dual",
      {},
      { signed: true },
    );
    if (mode?.dualSidePosition !== false)
      throw new Error("ONE_WAY_POSITION_MODE_REQUIRED");
  }
  async positions() {
    const rows = await this.request(
      "/fapi/v2/positionRisk",
      {},
      { signed: true },
    );
    if (!Array.isArray(rows)) throw new Error("INVALID_POSITION_RESPONSE");
    return rows.filter((p) => Number(p.positionAmt) !== 0);
  }
  async accountState() {
    const account = await this.request(
      "/fapi/v3/account",
      {},
      { signed: true },
    );
    if (account.multiAssetsMargin === true)
      throw new Error("SINGLE_ASSET_USDT_ACCOUNT_REQUIRED");
    const asset = account.assets?.find((a) => a.asset === "USDT");
    if (
      !asset ||
      ![asset.walletBalance, asset.unrealizedProfit].every(
        (v) => v != null && Number.isFinite(Number(v)),
      )
    )
      throw new Error("INVALID_EQUITY_RESPONSE");
    const equity = Number(asset.walletBalance) + Number(asset.unrealizedProfit);
    const availableBalance = Number(account.availableBalance ?? asset.availableBalance);
    if (!(equity > 0 && Number.isFinite(availableBalance) && availableBalance >= 0))
      throw new Error("INVALID_AVAILABLE_BALANCE");
    return { equity, availableBalance };
  }
  async equity() { return (await this.accountState()).equity; }
  async symbols() {
    if (!this.exchangeInfo || this.now() - this.exchangeInfoAt > CONFIG.BINANCE_METADATA_CACHE_MS) {
      const info = await this.cachedRequest(
        "/fapi/v1/exchangeInfo",
        {},
        CONFIG.BINANCE_METADATA_CACHE_MS,
      );
      if (!Array.isArray(info?.symbols))
        throw new Error("INVALID_EXCHANGE_INFO");
      this.exchangeInfo = info.symbols;
      this.budget.configure(info.rateLimits);
      this.exchangeInfoAt = this.now();
    }
    return this.exchangeInfo;
  }
  async info(symbol) {
    return (await this.symbols()).find((s) => s.symbol === symbol);
  }
  async fundingInterval(symbol) {
    if (!this.fundingInfo || this.now() - (this.fundingInfoAt || 0) > CONFIG.BINANCE_METADATA_CACHE_MS) {
      const rows = await this.cachedRequest(
        "/fapi/v1/fundingInfo",
        {},
        CONFIG.BINANCE_METADATA_CACHE_MS,
      );
      if (!Array.isArray(rows))
        throw new Error("INVALID_FUNDING_INTERVAL_INFO");
      this.fundingInfo = rows;
      this.fundingInfoAt = this.now();
    }
    const record = this.fundingInfo.find((r) => r.symbol === symbol);
    const hours = record ? Number(record.fundingIntervalHours) : CONFIG.BINANCE_FUNDING_INTERVAL_FALLBACK_HOURS;
    if (!(hours > 0 && hours <= 24))
      throw new Error("INVALID_FUNDING_INTERVAL");
    return hours;
  }
  async candles(symbol, interval, limit = CONFIG.BINANCE_CANDLE_REQUEST_LIMIT, extra = {}) {
    if (interval === "4h" && Object.keys(extra).length === 0)
      return this.history4h.get(symbol, limit);
    return this.rawCandles(symbol, interval, limit, extra);
  }
  async rawCandles(symbol, interval, limit = CONFIG.BINANCE_CANDLE_REQUEST_LIMIT, extra = {}) {
    const rows = await this.request("/fapi/v1/klines", {
      symbol,
      interval,
      limit,
      ...extra,
    });
    if (!Array.isArray(rows)) throw new Error("INVALID_CANDLE_RESPONSE");
    return rows;
  }
  order(symbol, clientOrderId) {
    return this.request(
      "/fapi/v1/order",
      { symbol, origClientOrderId: clientOrderId },
      { signed: true },
    );
  }
  async openOrders(symbol) {
    const rows = await this.request(
      "/fapi/v1/openOrders",
      { symbol },
      { signed: true },
    );
    if (!Array.isArray(rows)) throw new Error("INVALID_OPEN_ORDER_RESPONSE");
    return rows;
  }
  async cancelEntry(trade) {
    try {
      await this.request(
        "/fapi/v1/order",
        { symbol: trade.symbol, origClientOrderId: trade.entryClientId },
        { method: "DELETE", signed: true },
      );
    } catch (e) {
      if (![-2011, -2013].includes(e.code) && !e.ambiguous) throw e;
    }
    return this.order(trade.symbol, trade.entryClientId);
  }
  algo(symbol, clientAlgoId) {
    return this.request(
      "/fapi/v1/algoOrder",
      { clientAlgoId },
      { signed: true },
    );
  }
  algoById(symbol, algoId) {
    return this.request(
      "/fapi/v1/algoOrder",
      { algoId },
      { signed: true },
    );
  }
  async openAlgos() {
    const rows = await this.request(
      "/fapi/v1/openAlgoOrders",
      {},
      { signed: true },
    );
    if (!Array.isArray(rows)) throw new Error("INVALID_ALGO_RESPONSE");
    return rows;
  }
  async market(
    trade,
    clientOrderId,
    reduceOnly = false,
    quantity = trade.quantity,
  ) {
    const side =
      trade.side === "LONG"
        ? reduceOnly
          ? "SELL"
          : "BUY"
        : reduceOnly
          ? "BUY"
          : "SELL";
    try {
      return await this.request(
        "/fapi/v1/order",
        {
          symbol: trade.symbol,
          side,
          type: "MARKET",
          quantity,
          newClientOrderId: clientOrderId,
          reduceOnly: reduceOnly ? "true" : undefined,
          newOrderRespType: "RESULT",
        },
        { method: "POST", signed: true },
      );
    } catch (error) {
      if (!error.ambiguous) throw error;
      // The request may have been accepted: reconcile the same ID, never resubmit.
      for (let i = 0; i < CONFIG.BINANCE_AMBIGUOUS_ORDER_LOOKUP_ATTEMPTS; i++) {
        try {
          return await this.order(trade.symbol, clientOrderId);
        } catch (queryError) {
          if (queryError.code !== -2013 && queryError.code !== -2011)
            // A failed lookup cannot turn an ambiguous accepted POST into a
            // definitive rejection. Keep the original uncertainty for recovery.
            throw error;
        }
        await this.wait(CONFIG.BINANCE_AMBIGUOUS_ORDER_LOOKUP_DELAY_MS);
      }
      throw error;
    }
  }
  async entryFill(trade, order) {
    if (order?.orderId == null) throw new Error("ENTRY_ORDER_ID_MISSING");
    const rows = await this.request("/fapi/v1/userTrades", {
      symbol: trade.symbol, orderId: order.orderId, limit: CONFIG.BINANCE_ACCOUNTING_PAGE_SIZE,
    }, { signed: true });
    if (!Array.isArray(rows)) throw new Error("INVALID_ENTRY_FILL_HISTORY");
    const expected = Number(order.executedQty) > 0 ? Number(order.executedQty)
      : order.status === "FILLED" ? Number(trade.quantity) : NaN;
    const side = trade.side === "LONG" ? "BUY" : "SELL";
    const unique = new Map();
    for (const f of rows) {
      if (String(f.orderId) !== String(order.orderId) || f.side !== side ||
          (f.symbol && f.symbol !== trade.symbol)) continue;
      if (f.id == null || ![f.qty, f.price, f.time].every((v) => Number.isFinite(Number(v)) && Number(v) > 0))
        throw new Error("INVALID_ENTRY_FILL_HISTORY");
      unique.set(String(f.id), f);
    }
    const fills = [...unique.values()];
    const qty = fills.reduce((sum, f) => sum + Number(f.qty), 0);
    const quote = fills.reduce((sum, f) => sum + Number(f.qty) * Number(f.price), 0);
    if (!(expected > 0 && qty > 0 && quote > 0) ||
        Math.abs(qty - expected) > Math.max(expected * 1e-7, 1e-10))
      throw new Error("ENTRY_FILL_HISTORY_INCOMPLETE");
    return { ...order, executedQty: String(qty), avgPrice: String(quote / qty),
      cumQuote: String(quote), time: Math.min(...fills.map((f) => Number(f.time))),
      fillSource: "CONFIRMED_ORDER_TRADE_HISTORY" };
  }
  async protection(trade, kind, clientAlgoId) {
    const params = {
      symbol: trade.symbol,
      algoType: "CONDITIONAL",
      clientAlgoId,
      side: trade.side === "LONG" ? "SELL" : "BUY",
      type: kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      triggerPrice:
        trade[kind === "sl" ? "sl" : kind === "tp1" ? "tp1" : "tp2"],
      workingType: "MARK_PRICE",
    };
    if (kind === "tp1" || kind === "tp2") {
      params.quantity = kind === "tp1" ? trade.tp1Quantity : trade.tp2Quantity;
      params.reduceOnly = "true";
    } else params.closePosition = "true";
    try {
      return await this.request("/fapi/v1/algoOrder", params, {
        method: "POST",
        signed: true,
      });
    } catch (error) {
      if (!error.ambiguous) throw error;
      return this.algo(trade.symbol, clientAlgoId);
    }
  }
  async cancelAlgos(symbol) {
    // Binance's cancel-all endpoint also removes manual and third-party
    // conditional orders. Cancel only algo orders with this bot's ID format.
    const rows = await this.openAlgos();
    const owned = rows.filter((row) =>
      row.symbol === symbol &&
      /^n9_[a-f0-9]{8}_(sl|tp1|tp2)_/.test(String(row.clientAlgoId)),
    );
    for (const row of owned) {
      if (row.algoId == null) throw new Error("BOT_ALGO_ID_MISSING");
      await this.cancelAlgo(symbol, row.algoId);
    }
    return owned.length;
  }
  async cancelAlgo(symbol, algoId) {
    try {
      return await this.request(
        "/fapi/v1/algoOrder",
        { algoId },
        { method: "DELETE", signed: true },
      );
    } catch (e) {
      if (![-2011, -2013].includes(e.code)) throw e;
    }
  }
  async cancelOrder(symbol, orderId) {
    try {
      return await this.request(
        "/fapi/v1/order",
        { symbol, orderId },
        { method: "DELETE", signed: true },
      );
    } catch (e) {
      if (![-2011, -2013].includes(e.code)) throw e;
    }
  }
  async fills(trade, endTime = this.now() + this.offset) {
    endTime = Math.floor(Number(endTime));
    const start = Math.max(
      0,
      Math.floor(
        Math.min(
          ...[trade.submittedAt, trade.entryExecution?.orderTime, trade.enteredAt]
            .map(Number)
            .filter((v) => Number.isFinite(v) && v > 0),
        ),
      ) - 5000,
    );
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endTime) ||
      endTime < start
    )
      throw new Error("INVALID_FILL_TIME_RANGE");
    const all = [];
    let fromId,
      windowStart = start;
    // First window is at most seven days. Subsequent pages use fromId alone.
    // Timeout positions are 96h, but persisted reconciliation can be retried later.
    for (let page = 0; page < CONFIG.BINANCE_FILL_HISTORY_MAX_PAGES; page++) {
      const windowEnd = Math.min(endTime, windowStart + 7 * 86400000 - 1);
      const params =
        fromId == null
          ? {
              symbol: trade.symbol,
              startTime: windowStart,
              endTime: windowEnd,
              limit: CONFIG.BINANCE_ACCOUNTING_PAGE_SIZE,
            }
          : { symbol: trade.symbol, fromId, limit: 1000 };
      const rows = await this.request("/fapi/v1/userTrades", params, {
        signed: true,
      });
      if (!Array.isArray(rows)) throw new Error("INVALID_FILL_HISTORY");
      all.push(...rows.filter((f) => Number(f.time) <= endTime));
      if (rows.length && Number(rows.at(-1).time) > endTime) return all;
      if (rows.length < CONFIG.BINANCE_ACCOUNTING_PAGE_SIZE) {
        if (fromId != null || windowEnd >= endTime) return all;
        windowStart = windowEnd + 1;
        continue;
      }
      const next = BigInt(rows.at(-1).id) + 1n;
      if (fromId != null && next <= BigInt(fromId))
        throw new Error("FILL_PAGINATION_STALLED");
      fromId = String(next);
    }
    throw new Error("FILL_HISTORY_INCOMPLETE");
  }
  async funding(symbol, startTime, endTime) {
    const all = [];
    for (let page = 1; page <= CONFIG.BINANCE_FUNDING_HISTORY_MAX_PAGES; page++) {
      const rows = await this.request(
        "/fapi/v1/income",
        {
          symbol,
          incomeType: "FUNDING_FEE",
          startTime,
          endTime,
          limit: CONFIG.BINANCE_ACCOUNTING_PAGE_SIZE,
          page,
        },
        { signed: true },
      );
      if (!Array.isArray(rows)) throw new Error("INVALID_FUNDING_HISTORY");
      all.push(...rows);
      if (rows.length < CONFIG.BINANCE_ACCOUNTING_PAGE_SIZE) return all;
    }
    throw new Error("FUNDING_HISTORY_INCOMPLETE");
  }
  async convertFees(fills, funding) {
    const cache = new Map();
    const convert = async (asset, value, time) => {
      if (asset === "USDT" || Number(value) === 0) return Number(value);
      const minute = Math.floor(Number(time) / 60000) * 60000,
        key = asset + ":" + minute;
      if (this.now() < minute + 60000)
        throw new Error("FEE_CONVERSION_CANDLE_NOT_CLOSED");
      if (!cache.has(key)) {
        const bars = await this.request(
          "/api/v3/klines",
          {
            symbol: asset + "USDT",
            interval: "1m",
            startTime: minute,
            limit: 1,
          },
          { host: "https://api.binance.com" },
        );
        const price = Number(bars?.[0]?.[4]);
        if (!(price > 0)) throw new Error("FEE_CONVERSION_UNAVAILABLE");
        cache.set(key, price);
      }
      return Number(value) * cache.get(key);
    };
    for (const fill of fills) {
      fill.commissionUSDT = await convert(
        fill.commissionAsset,
        fill.commission,
        fill.time,
      );
      fill.commissionConversionMethod =
        fill.commissionAsset === "USDT" ? "NATIVE_USDT" : "SPOT_1M_CLOSE";
    }
    for (const row of funding) {
      row.incomeUSDT = await convert(row.asset, row.income, row.time);
      row.incomeConversionMethod =
        row.asset === "USDT" ? "NATIVE_USDT" : "SPOT_1M_CLOSE";
    }
  }
}
module.exports = {
  BinanceExchange,
  ExchangeError,
  roundStep,
  symbolRules,
  sizeTrade,
};
