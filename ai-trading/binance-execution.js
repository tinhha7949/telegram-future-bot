"use strict";
const crypto = require("node:crypto");
const { isRiskWithinBudget } = require("./execution-risk");

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
  if (
    !(Number.isFinite(value) && value > 0 && Number.isFinite(step) && step > 0)
  )
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
  const sl = roundStep(Number(decision.sl), r.tick, long ? "floor" : "ceil");
  const tp1 = roundStep(Number(decision.tp1), r.tick, long ? "floor" : "ceil");
  const tp2 = roundStep(
    Number(decision.tp2 ?? decision.tp),
    r.tick,
    long ? "floor" : "ceil",
  );
  if (
    !(entry > 0 && equity > 0 && riskFraction > 0 && riskFraction <= 1) ||
    (long
      ? !(sl < entry && entry < tp1 && tp1 < tp2)
      : !(tp2 < tp1 && tp1 < entry && entry < sl))
  )
    return null;
  const budget = equity * riskFraction,
    distance = Math.abs(entry - sl);
  // An even number of lots permits an exact 50% TP1, each half above minQty.
  const quantity = roundStep(Math.min(budget / distance, r.maxQty), 2 * r.step);
  if (
    !(quantity / 2 >= r.minQty && quantity * entry >= r.minNotional) ||
    !isRiskWithinBudget(quantity * distance, budget)
  )
    return null;
  return {
    quantity,
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
  } = {}) {
    this.key = key;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.now = now;
    this.wait = wait;
    this.offset = 0;
    this.exchangeInfo = null;
    this.exchangeInfoAt = 0;
  }
  async request(
    path,
    params = {},
    {
      method = "GET",
      signed = false,
      host = "https://fapi.binance.com",
      timeoutMs = 15000,
    } = {},
  ) {
    const attempts = method === "GET" ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const values = { ...params };
      if (signed) {
        values.recvWindow = 10000;
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
      try {
        response = await this.fetch(host + path + (query ? "?" + query : ""), {
          method,
          headers: signed ? { "X-MBX-APIKEY": this.key } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        data = await response.json();
      } catch (error) {
        if (method === "GET" && attempt + 1 < attempts) {
          await this.wait(250);
          continue;
        }
        throw new ExchangeError("EXCHANGE_RESPONSE_UNAVAILABLE", {
          ambiguous: method !== "GET",
        });
      }
      if (!response.ok || Number(data?.code) < 0) {
        const error = new ExchangeError(
          String(data?.msg || "EXCHANGE_HTTP_" + response.status),
          {
            code: Number(data?.code),
            ambiguous:
              method !== "GET" &&
              (response.status >= 500 || response.status === 408),
          },
        );
        if (
          method === "GET" &&
          attempt + 1 < attempts &&
          (response.status >= 500 || response.status === 429)
        ) {
          await this.wait(1000);
          continue;
        }
        throw error;
      }
      return data;
    }
  }
  async syncTime() {
    const start = this.now(),
      r = await this.request("/fapi/v1/time");
    if (!Number.isFinite(r?.serverTime)) throw new Error("INVALID_SERVER_TIME");
    this.offset = r.serverTime - (start + this.now()) / 2;
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
  async equity() {
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
    return Number(asset.walletBalance) + Number(asset.unrealizedProfit);
  }
  async symbols() {
    if (!this.exchangeInfo || this.now() - this.exchangeInfoAt > 3600000) {
      const info = await this.request("/fapi/v1/exchangeInfo");
      if (!Array.isArray(info?.symbols))
        throw new Error("INVALID_EXCHANGE_INFO");
      this.exchangeInfo = info.symbols;
      this.exchangeInfoAt = this.now();
    }
    return this.exchangeInfo;
  }
  async info(symbol) {
    return (await this.symbols()).find((s) => s.symbol === symbol);
  }
  async fundingInterval(symbol) {
    if (!this.fundingInfo || this.now() - (this.fundingInfoAt || 0) > 3600000) {
      const rows = await this.request("/fapi/v1/fundingInfo");
      if (!Array.isArray(rows))
        throw new Error("INVALID_FUNDING_INTERVAL_INFO");
      this.fundingInfo = rows;
      this.fundingInfoAt = this.now();
    }
    const record = this.fundingInfo.find((r) => r.symbol === symbol);
    const hours = record ? Number(record.fundingIntervalHours) : 8;
    if (!(hours > 0 && hours <= 24))
      throw new Error("INVALID_FUNDING_INTERVAL");
    return hours;
  }
  async candles(symbol, interval, limit = 1500, extra = {}) {
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
      { symbol, clientAlgoId },
      { signed: true },
    );
  }
  algoById(symbol, algoId) {
    return this.request(
      "/fapi/v1/algoOrder",
      { symbol, algoId },
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
      for (let i = 0; i < 5; i++) {
        try {
          return await this.order(trade.symbol, clientOrderId);
        } catch (queryError) {
          if (queryError.code !== -2013 && queryError.code !== -2011)
            throw queryError;
        }
        await this.wait(500);
      }
      throw error;
    }
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
    if (kind === "tp1") {
      params.quantity = trade.actualQuantity / 2;
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
    return this.request(
      "/fapi/v1/algoOpenOrders",
      { symbol },
      { method: "DELETE", signed: true },
    );
  }
  async fills(trade, endTime = this.now()) {
    const start = Math.max(
      0,
      Math.min(
        ...[trade.submittedAt, trade.entryExecution?.orderTime, trade.enteredAt]
          .map(Number)
          .filter((v) => v > 0),
      ) - 5000,
    );
    const all = [];
    let fromId,
      windowStart = start;
    // First window is at most seven days. Subsequent pages use fromId alone.
    // Timeout positions are 96h, but persisted reconciliation can be retried later.
    for (let page = 0; page < 100; page++) {
      const windowEnd = Math.min(endTime, windowStart + 7 * 86400000 - 1);
      const params =
        fromId == null
          ? {
              symbol: trade.symbol,
              startTime: windowStart,
              endTime: windowEnd,
              limit: 1000,
            }
          : { symbol: trade.symbol, fromId, limit: 1000 };
      const rows = await this.request("/fapi/v1/userTrades", params, {
        signed: true,
      });
      if (!Array.isArray(rows)) throw new Error("INVALID_FILL_HISTORY");
      all.push(...rows.filter((f) => Number(f.time) <= endTime));
      if (rows.length && Number(rows.at(-1).time) > endTime) return all;
      if (rows.length < 1000) {
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
    for (let page = 1; page <= 100; page++) {
      const rows = await this.request(
        "/fapi/v1/income",
        {
          symbol,
          incomeType: "FUNDING_FEE",
          startTime,
          endTime,
          limit: 1000,
          page,
        },
        { signed: true },
      );
      if (!Array.isArray(rows)) throw new Error("INVALID_FUNDING_HISTORY");
      all.push(...rows);
      if (rows.length < 1000) return all;
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
