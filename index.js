// Load VPS .env before reading any environment-backed configuration.
require("dotenv").config();

// Manually tune per-trade equity risk here. Use a fraction: 0.0075 = 0.75%.
const RISK_PER_TRADE = 0.075;

const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { MongoClient } = require("mongodb");
const pipeline = require("./ai-trading/nine-ai-pipeline");
const { DECISION_SCHEMA_VERSION } = require("./ai-trading/nine-ai-policy");
const central = require("./ai-trading/nine-ai-central-decision-engine");
const journal = require("./ai-trading/nine-ai-decision-journal");
const {
  createOfflineLearning,
  formatDailyLearningReport,
} = require("./ai-trading/nine-ai-offline-learning");
const { createRetention } = require("./ai-trading/nine-ai-db-retention");
const liquidationFeed = require("./ai-trading/binance-liquidation-feed");
const {
  BinanceExchange,
  sizeTrade,
} = require("./ai-trading/binance-execution");
const { TradeLifecycle, newTrade } = require("./ai-trading/trade-lifecycle");
const { validateExecution } = require("./ai-trading/execution-validation");

function envNumber(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}
const TRADE_CONFIG = Object.freeze({
  riskPerTrade: RISK_PER_TRADE,
  maxRiskPerTrade: RISK_PER_TRADE,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function acquirePidLock() {
  const key = crypto
    .createHash("sha256")
    .update(path.resolve(__filename))
    .digest("hex")
    .slice(0, 16);
  const file = path.join(os.tmpdir(), `tradebot-${key}.pid`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => {
        try {
          if (fs.readFileSync(file, "utf8").trim() === String(process.pid))
            fs.unlinkSync(file);
        } catch (_) {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (check) {
          alive = check.code !== "ESRCH";
        }
        if (alive) throw new Error("BOT_ALREADY_RUNNING");
      }
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  throw new Error("PID_LOCK_UNAVAILABLE");
}
async function telegram(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text).slice(0, 4000),
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    return res.ok && (await res.json()).ok === true;
  } catch (_) {
    return false;
  }
}
async function marketSnapshot(exchange, symbol, now = Date.now()) {
  const observe = async (route, params, ttl = 0) => {
    const started = Date.now();
    const data =
      ttl && exchange.cachedRequest
        ? await exchange.cachedRequest(route, params, ttl)
        : await exchange.request(route, params);
    const timing = exchange.observations?.get(data);
    return {
      data,
      ...(timing || {
        observedAt: Date.now(),
        latencyMs: Date.now() - started,
        source: "REST",
      }),
    };
  };
  const [
    premiumRecord,
    oiRecord,
    bookRecord,
    depthRecord,
    fundingIntervalHours,
  ] = await Promise.all([
    exchange.marketFeed?.get("mark", symbol) ||
      observe("/fapi/v1/premiumIndex", { symbol }),
    observe(
      "/futures/data/openInterestHist",
      { symbol, period: "4h", limit: 2 },
      60000,
    ),
    exchange.marketFeed?.get("book", symbol) ||
      observe("/fapi/v1/ticker/bookTicker", { symbol }),
    observe("/fapi/v1/depth", { symbol, limit: 20 }, 500),
    exchange.fundingInterval(symbol),
  ]);
  const premium = premiumRecord.data,
    oiHistory = oiRecord.data,
    book = bookRecord.data,
    depth = depthRecord.data;
  const observedAt = Date.now(),
    snapshotAt = Math.min(
      premiumRecord.observedAt,
      bookRecord.observedAt,
      depthRecord.observedAt,
    ),
    latencyMs = Math.max(
      premiumRecord.latencyMs,
      oiRecord.latencyMs,
      bookRecord.latencyMs,
      depthRecord.latencyMs,
    ),
    bid = Number(book?.bidPrice),
    ask = Number(book?.askPrice);
  const funding =
    premium?.lastFundingRate == null ? null : Number(premium.lastFundingRate);
  const previous = Number(oiHistory?.[0]?.sumOpenInterest),
    latest = Number(oiHistory?.at(-1)?.sumOpenInterest);
  const oiFresh =
    Array.isArray(oiHistory) &&
    oiHistory.length >= 2 &&
    oiHistory.every((o) => Number(o.timestamp) <= observedAt);
  const notional = (levels) =>
    Array.isArray(levels) && levels.length
      ? levels.reduce((sum, l) => sum + Number(l[0]) * Number(l[1]), 0)
      : null;
  const bids = notional(depth?.bids),
    asks = notional(depth?.asks);
  return {
    now: observedAt,
    snapshotAt,
    fundingRate: Number.isFinite(funding) ? funding : null,
    openInterestChange:
      oiFresh && previous > 0 && Number.isFinite(latest)
        ? (latest / previous - 1) * 100
        : null,
    spreadPct:
      bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null,
    depthNotional: bids > 0 && asks > 0 ? bids + asks : null,
    latencyMs,
    marketDataSources: {
      funding: premiumRecord.source,
      book: bookRecord.source,
      depth: depthRecord.source,
    },
    oiObservedAt: oiFresh ? Number(oiHistory.at(-1).timestamp) : null,
    liquidationImbalance: liquidationFeed.getImbalance(symbol, observedAt),
    markPrice: Number(premium?.markPrice),
    roundTripFeePct: envNumber("ROUND_TRIP_FEE_PCT", 0.1, 0, 2),
    fundingIntervalHours,
    expectedFundingCostPctBySide: Number.isFinite(funding)
      ? {
          LONG: funding * 100 * Math.ceil(96 / fundingIntervalHours),
          SHORT: -funding * 100 * Math.ceil(96 / fundingIntervalHours),
        }
      : null,
  };
}
async function universe(exchange) {
  const eligible = new Set(
    (await exchange.symbols())
      .filter(
        (s) =>
          s.status === "TRADING" &&
          s.contractType === "PERPETUAL" &&
          s.quoteAsset === "USDT",
      )
      .map((s) => s.symbol),
  );
  return [...eligible].sort();
}
async function executeDecisions(
  signals,
  {
    exchange,
    lifecycle,
    report,
    isStopped = () => false,
    entriesPaused = () => false,
  },
) {
  signals.sort((a, b) => b.edges[b.side].edge - a.edges[a.side].edge);
  for (const decision of signals) {
    if (
      isStopped() ||
      entriesPaused() ||
      lifecycle.uncertain ||
      lifecycle.untracked.size
    )
      break;
    if (
      [...lifecycle.active.values()].some((t) => t.symbol === decision.symbol)
    )
      continue;
    if (
      await lifecycle.claims.findOne({
        signalKey: `${decision.symbol}:${decision.signalAt}`,
      })
    )
      continue;
    const fresh = await marketSnapshot(exchange, decision.symbol);
    const validation = validateExecution(decision, fresh, Date.now());
    if (!validation.ok) {
      console.log("ENTRY WAIT", decision.symbol, validation.reason);
      continue;
    }
    const equity = await exchange.equity();
    const sizing = sizeTrade(
      decision,
      equity,
      TRADE_CONFIG.riskPerTrade,
      await exchange.info(decision.symbol),
    );
    if (!sizing) continue;
    const trade = newTrade(decision, sizing);
    trade.executionValidation = validation;
    if (await lifecycle.enter(trade)) {
      await report(
        `${trade.symbol} ${trade.side} | Entry ${trade.entry} | SL ${trade.sl} | TP1 ${trade.tp1} | TP2 ${trade.tp2} | ${trade.tradePlan?.outcomeMode === "AI7_LABELED" ? "AI7 MAE/MFE" : "AI7 OFF: AI2 initial SL/TP"}`,
      );
    }
  }
}
async function loadDecisionInput(
  exchange,
  journalStore,
  symbol,
  now = Date.now(),
) {
  const expectedClose =
    Math.floor((now + (exchange.offset || 0)) / pipeline.BAR_MS) *
      pipeline.BAR_MS -
    1;
  let prior = await journalStore.getDecisionForCandle(
    symbol,
    expectedClose,
    DECISION_SCHEMA_VERSION,
  );
  if (prior) return { prior };
  const h4 = await exchange.candles(symbol, "4h", 1500);
  const probe = pipeline.closedCandles(h4, Date.now()).at(-1);
  if (!probe) return null;
  if (probe.closeTime !== expectedClose)
    prior = await journalStore.getDecisionForCandle(
      symbol,
      probe.closeTime,
      DECISION_SCHEMA_VERSION,
    );
  return { prior, h4, probe };
}
async function main() {
  for (const name of ["MONGO_URI", "BINANCE_KEY", "BINANCE_SECRET"]) {
    if (!process.env[name]) throw new Error("MISSING_" + name);
  }
  const releaseLock = acquirePidLock();
  process.on("exit", releaseLock);
  const client = new MongoClient(process.env.MONGO_URI, {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 15000,
    maxPoolSize: 20,
    retryWrites: true,
  });
  const exchange = new BinanceExchange({
    key: process.env.BINANCE_KEY,
    secret: process.env.BINANCE_SECRET,
  });
  let stopped = false,
    entriesPaused = false;
  const intervals = [];
  const report = async (msg) => {
    console.log(msg);
    void telegram(
      process.env.BOT_TOKEN_2 || process.env.BOT_TOKEN,
      process.env.AI_CHAT_ID || process.env.CHAT_ID,
      msg,
    );
  };
  process.on("unhandledRejection", (e) => {
    entriesPaused = true;
    console.error("NEW ENTRIES PAUSED", e?.message || e);
  });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    intervals.forEach(clearInterval);
    liquidationFeed.stop();
    exchange.close();
    await client.close();
    releaseLock();
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  await client.connect();
  const db = client.db("trading");
  await db.command({ ping: 1 });
  await exchange.initialize();
  await journal.initialize(db);
  const learner = createOfflineLearning(db);
  await learner.initialize();
  const lifecycle = new TradeLifecycle({
    exchange,
    db,
    journal,
    learner,
    notify: report,
  });
  await lifecycle.initialize();
  liquidationFeed.start();
  exchange.startMarketData();
  function every(ms, job) {
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await job();
      } catch (e) {
        console.error(e.message);
      } finally {
        running = false;
      }
    };
    intervals.push(setInterval(run, ms));
    return run;
  }
  const manage = every(10000, () => lifecycle.tick());
  await manage();
  every(60000, () => exchange.syncTime());
  const retention = createRetention(db);
  const clean = every(retention.config.intervalMs, () =>
    retention.runCleanup(),
  );
  void clean();
  const daily = every(24 * 3600000, async () => {
    const symbols = await db.collection(journal.COLLECTION).distinct("symbol", {
      "decisionSnapshot.decisionSchemaVersion": DECISION_SCHEMA_VERSION,
      outcomeStatus: {
        $in: ["PENDING_HORIZON_EVALUATION", "PARTIALLY_EVALUATED"],
      },
    });
    for (const symbol of symbols) {
      try {
        await journal.settleMatured(
          symbol,
          await exchange.candles(symbol, "4h"),
        );
      } catch (e) {
        console.error("SETTLEMENT", symbol, e.message);
      }
    }
    const report = await learner.runDailyCycle();
    console.log(formatDailyLearningReport(report));
  });
  void daily();
  let scanReasons = new Map();
  const countWait = (reason) =>
    scanReasons.set(reason, (scanReasons.get(reason) || 0) + 1);
  async function scanSymbol(symbol, champion, trackRecord, outcomes) {
    const input = await loadDecisionInput(exchange, journal, symbol);
    if (!input) return null;
    const { prior, h4, probe } = input;
    if (prior) {
      const cached = central.finalizeDecision(
        prior.decisionSnapshot?.executionDecision,
        { symbol, scannedAt: Date.now() },
      );
      if (!cached.authorizedForExecution) countWait(cached.reason);
      return cached.authorizedForExecution
        ? { ...cached, nineAiDecisionKey: prior.decisionKey }
        : null;
    }
    await journal.settleMatured(symbol, h4);
    const market = await marketSnapshot(exchange, symbol);
    let decision = pipeline.analyzeNineAI({
      symbol,
      candles4h: h4,
      outcomes,
      market: { ...market, trackRecord },
      config: champion,
    });
    decision = { ...decision, riskPerTradePct: RISK_PER_TRADE };
    decision = central.finalizeDecision(decision, {
      symbol,
      scannedAt: Date.now(),
    });
    const saved = await journal.recordDecision({
      symbol,
      decision,
      signalTime: decision.signalAt || probe.closeTime,
      scannedAt: Date.now(),
      marketWindow: h4,
    });
    if (!decision.authorizedForExecution) countWait(decision.reason);
    return decision.authorizedForExecution
      ? { ...decision, nineAiDecisionKey: saved.decisionKey }
      : null;
  }
  const scan = every(120000, async () => {
    if (entriesPaused || lifecycle.uncertain || lifecycle.untracked.size) {
      console.log(
        "NINE-AI SCAN PAUSED",
        entriesPaused
          ? "RUNTIME_ERROR"
          : lifecycle.uncertain
            ? "POSITION_STATE_UNCERTAIN"
            : "UNTRACKED_EXCHANGE_POSITION",
      );
      return;
    }
    await db.command({ ping: 1 });
    const cutoffAt = Date.now();
    const [symbols, champion, track, outcomes] = await Promise.all([
      universe(exchange),
      learner.getChampionConfig(),
      learner.getTrackRecord(cutoffAt),
      db
        .collection("nine_ai_outcome_labels")
        .find({
          labeled: true,
          source: "REALIZED_CLOSED_TRADE",
          closedAt: { $lte: cutoffAt },
        })
        .sort({ closedAt: -1 })
        .limit(5000)
        .toArray(),
    ]);
    console.log(
      "NINE-AI SCAN START",
      "symbols=" + symbols.length,
      "realizedLabels=" + outcomes.length,
      "timeframe=4h",
    );
    const signals = [];
    scanReasons = new Map();
    for (let i = 0; i < symbols.length && !stopped; i += 5) {
      const batch = await Promise.allSettled(
        symbols
          .slice(i, i + 5)
          .map((s) => scanSymbol(s, champion, track, outcomes)),
      );
      for (const r of batch) {
        if (r.status === "fulfilled" && r.value) signals.push(r.value);
        else if (r.status === "rejected")
          console.error("SCAN", r.reason.message);
      }
      if ((i + 5) % 50 === 0)
        console.log(
          "NINE-AI SCAN PROGRESS",
          "scanned=" + Math.min(i + 5, symbols.length) + "/" + symbols.length,
          "signals=" + signals.length,
        );
    }
    console.log(
      "NINE-AI SCAN",
      "symbols=" + symbols.length,
      "signals=" + signals.length,
      [...scanReasons]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([reason, n]) => reason + "=" + n)
        .join(" | "),
    );
    await executeDecisions(signals, {
      exchange,
      lifecycle,
      report,
      isStopped: () => stopped,
      entriesPaused: () => entriesPaused,
    });
  });
  // Commands have their own loop. A Telegram outage cannot stall SL/TP/timeout management.
  let updateId = 0;
  const commands = every(2000, async () => {
    if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) return;
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getUpdates?offset=${updateId + 1}&timeout=20`,
      { signal: AbortSignal.timeout(25000) },
    );
    if (!res.ok) return;
    const payload = await res.json();
    for (const u of payload.result || []) {
      updateId = Math.max(updateId, u.update_id);
      if (
        String(u.message?.chat?.id) === String(process.env.CHAT_ID) &&
        u.message?.text === "/status"
      )
        await telegram(
          process.env.BOT_TOKEN,
          process.env.CHAT_ID,
          `BOT OK | active=${lifecycle.active.size} | entriesPaused=${entriesPaused || lifecycle.uncertain || !!lifecycle.untracked.size}`,
        );
    }
  });
  void commands();
  void scan();
  console.log(
    "NINE-AI READY: closed 4h decisions; independent protection/timeout; daily offline learning",
  );
  while (!stopped) await sleep(1000);
}
if (require.main === module)
  main().catch((e) => {
    console.error("START FAILED", e.message);
    process.exit(1);
  });
module.exports = {
  RISK_PER_TRADE,
  TRADE_CONFIG,
  marketSnapshot,
  universe,
  executeDecisions,
  loadDecisionInput,
};
