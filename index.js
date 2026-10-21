// Load VPS .env before reading any environment-backed configuration.
require("dotenv").config();

// Manually tune per-trade equity risk here. Use a fraction: 0.0075 = 0.75%.
const RISK_PER_TRADE = 0.0075;

const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { MongoClient } = require("mongodb");
const pipeline = require("./ai-trading/nine-ai-pipeline");
const central = require("./ai-trading/nine-ai-central-decision-engine");
const journal = require("./ai-trading/nine-ai-decision-journal");
const {
  createOfflineLearning,
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
  maxActivePositions: Math.round(envNumber("MAX_ACTIVE_POSITIONS", 20, 1, 50)),
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
  const started = now;
  const [premium, oiHistory, book, depth, fundingIntervalHours] =
    await Promise.all([
      exchange.request("/fapi/v1/premiumIndex", { symbol }),
      exchange.request("/futures/data/openInterestHist", {
        symbol,
        period: "4h",
        limit: 2,
      }),
      exchange.request("/fapi/v1/ticker/bookTicker", { symbol }),
      exchange.request("/fapi/v1/depth", { symbol, limit: 20 }),
      exchange.fundingInterval(symbol),
    ]);
  const observedAt = Date.now(),
    bid = Number(book?.bidPrice),
    ask = Number(book?.askPrice);
  const funding =
    premium?.lastFundingRate == null ? null : Number(premium.lastFundingRate);
  const previous = Number(oiHistory?.[0]?.sumOpenInterest),
    latest = Number(oiHistory?.at(-1)?.sumOpenInterest);
  const oiFresh =
    Array.isArray(oiHistory) &&
    oiHistory.length >= 2 &&
    oiHistory.every(
      (o) =>
        Number(o.timestamp) <= observedAt &&
        observedAt - Number(o.timestamp) <= 8 * 3600000,
    );
  const notional = (levels) =>
    Array.isArray(levels) && levels.length
      ? levels.reduce((sum, l) => sum + Number(l[0]) * Number(l[1]), 0)
      : null;
  const bids = notional(depth?.bids),
    asks = notional(depth?.asks);
  return {
    now: observedAt,
    snapshotAt: observedAt,
    fundingRate: Number.isFinite(funding) ? funding : null,
    openInterestChange:
      oiFresh && previous > 0 && Number.isFinite(latest)
        ? (latest / previous - 1) * 100
        : null,
    spreadPct:
      bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null,
    depthNotional: bids > 0 && asks > 0 ? bids + asks : null,
    latencyMs: observedAt - started,
    liquidationImbalance: liquidationFeed.getImbalance(symbol, observedAt),
    markPrice: Number(premium?.markPrice),
    roundTripFeePct: envNumber("ROUND_TRIP_FEE_PCT", 0.1, 0, 2),
    fundingIntervalHours,
    expectedFundingCostPctBySide: Number.isFinite(funding)
      ? {
          LONG:
            Math.max(0, funding) * 100 * Math.ceil(96 / fundingIntervalHours),
          SHORT:
            Math.max(0, -funding) * 100 * Math.ceil(96 / fundingIntervalHours),
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
  const tickers = await exchange.request("/fapi/v1/ticker/24hr");
  if (!Array.isArray(tickers)) throw new Error("INVALID_UNIVERSE_RESPONSE");
  return tickers
    .filter(
      (t) =>
        eligible.has(t.symbol) &&
        Number(t.quoteVolume) >= 5000000 &&
        Number(t.lastPrice) > 0 &&
        (Number(t.highPrice) - Number(t.lowPrice)) / Number(t.lastPrice) >=
          0.03 &&
        ![
          "USDCUSDT",
          "BUSDUSDT",
          "FDUSDUSDT",
          "TUSDUSDT",
          "USDPUSDT",
          "DAIUSDT",
          "USD1USDT",
          "RLUSDUSDT",
        ].includes(t.symbol),
    )
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, 80)
    .map((t) => t.symbol);
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
      "decisionSnapshot.decisionSchemaVersion": 2,
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
    console.log(
      "DAILY CALIBRATION",
      JSON.stringify(report.calibration),
      "CANDIDATE",
      report.candidateResult?.status,
      "SHADOW",
      report.shadowResult?.status,
    );
  });
  void daily();
  let lastEntryAt = 0;
  let scanReasons = new Map();
  const countWait = (reason) =>
    scanReasons.set(reason, (scanReasons.get(reason) || 0) + 1);
  async function scanSymbol(symbol, champion, trackRecord) {
    const probe = pipeline
      .closedCandles(await exchange.candles(symbol, "4h", 3), Date.now())
      .at(-1);
    if (!probe) return null;
    const prior = await journal.getDecisionForCandle(symbol, probe.closeTime);
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
    const [h4, h1, d1] = await Promise.all([
      exchange.candles(symbol, "4h", 1500),
      exchange.candles(symbol, "1h", 100),
      exchange.candles(symbol, "1d", 100),
    ]);
    await journal.settleMatured(symbol, h4);
    const market = await marketSnapshot(exchange, symbol);
    const outcomes = await db
      .collection("nine_ai_outcome_labels")
      .find({
        symbol,
        labeled: true,
        source: "REALIZED_CLOSED_TRADE",
        closedAt: { $lte: market.now },
      })
      .sort({ closedAt: -1 })
      .limit(5000)
      .toArray();
    let decision = pipeline.analyzeNineAI({
      symbol,
      candles4h: h4,
      candles1h: h1,
      candles1d: d1,
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
    if (
      entriesPaused ||
      lifecycle.uncertain ||
      lifecycle.untracked.size ||
      Date.now() - lastEntryAt < 60000
    )
      return;
    await db.command({ ping: 1 });
    const positions = await exchange.positions();
    if (positions.length >= TRADE_CONFIG.maxActivePositions) return;
    const symbols = await universe(exchange),
      champion = await learner.getChampionConfig(),
      track = await learner.getTrackRecord();
    const signals = [];
    scanReasons = new Map();
    for (let i = 0; i < symbols.length && !stopped; i += 5) {
      const batch = await Promise.allSettled(
        symbols.slice(i, i + 5).map((s) => scanSymbol(s, champion, track)),
      );
      for (const r of batch) {
        if (r.status === "fulfilled" && r.value) signals.push(r.value);
        else if (r.status === "rejected")
          console.error("SCAN", r.reason.message);
      }
    }
    console.log(
      "NINE-AI SCAN",
      [...scanReasons]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([reason, n]) => reason + "=" + n)
        .join(" | "),
    );
    signals.sort((a, b) => b.edges[b.side].edge - a.edges[a.side].edge);
    for (const decision of signals.slice(0, 10)) {
      if (
        stopped ||
        entriesPaused ||
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
      const livePositions = await exchange.positions();
      if (livePositions.length >= TRADE_CONFIG.maxActivePositions) break;
      const trade = newTrade(decision, sizing);
      trade.executionValidation = validation;
      if (await lifecycle.enter(trade)) {
        lastEntryAt = Date.now();
        await report(
          `${trade.symbol} ${trade.side} | Entry ${trade.entry} | SL ${trade.sl} | TP1 ${trade.tp1} | TP2 ${trade.tp2}`,
        );
        break;
      }
    }
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
module.exports = { RISK_PER_TRADE, TRADE_CONFIG, marketSnapshot, universe };
