// Load VPS .env before reading any environment-backed configuration.
require("dotenv").config();

const { CONFIG } = require("./ai-trading/config");
const { RiskGuard } = require("./ai-trading/risk/day-guard");
const { WaitRateControl } = require("./ai-trading/risk/wait-rate");
const { RecentOHLCVStore } = require("./ai-trading/data/store/ohlcv");
const { MemoryGuard } = require("./ai-trading/risk/memory-guard");
const RISK_PER_TRADE = CONFIG.RISK_PER_TRADE;
const HISTORY_4H_LIMIT = CONFIG.HISTORY_FETCH_CANDLES;

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
const { TelegramNotifications } = require("./ai-trading/telegram-notifications");

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
    .slice(0, CONFIG.PID_HASH_HEX_CHARS);
  const file = path.join(os.tmpdir(), `tradebot-${key}.pid`);
  for (let attempt = 0; attempt < CONFIG.PID_LOCK_ATTEMPTS; attempt++) {
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
          text: String(text).slice(0, CONFIG.TELEGRAM_MAX_MESSAGE_CHARS),
        }),
        signal: AbortSignal.timeout(CONFIG.TELEGRAM_HTTP_TIMEOUT_MS),
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
      { symbol, period: CONFIG.TIMEFRAME, limit: CONFIG.MARKET_OI_HISTORY_POINTS },
      CONFIG.MARKET_OI_CACHE_MS,
    ),
    exchange.marketFeed?.get("book", symbol) ||
      observe("/fapi/v1/ticker/bookTicker", { symbol }),
    observe("/fapi/v1/depth", { symbol, limit: CONFIG.MARKET_DEPTH_LEVELS }, CONFIG.MARKET_DEPTH_CACHE_MS),
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
    liquidationImbalance: typeof exchange.getLiquidationImbalance === "function"
      ? exchange.getLiquidationImbalance(symbol, observedAt)
      : liquidationFeed.getImbalance(symbol, observedAt),
    markPrice: Number(premium?.markPrice),
    roundTripFeePct: CONFIG.FEE_TAKER * 2 * 100,
    fundingIntervalHours,
    expectedFundingCostPctBySide: Number.isFinite(funding)
      ? {
          LONG: funding * 100 * Math.ceil((CONFIG.TIMEOUT_BARS * CONFIG.BAR_HOURS) / fundingIntervalHours),
          SHORT: -funding * 100 * Math.ceil((CONFIG.TIMEOUT_BARS * CONFIG.BAR_HOURS) / fundingIntervalHours),
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
    riskGuard,
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
    try {
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
      // All orders require durable risk and verified margin.

      if (!riskGuard) { console.error("ENTRY WAIT RISK_GUARD_UNAVAILABLE"); continue; }

      const account = await exchange.accountState();

      const equity = account.equity;

      const gate = await riskGuard.assess(equity);

      if (!gate.ok) { console.log("ENTRY WAIT", decision.symbol, gate.reason); continue; }

      const sizing = sizeTrade(
        decision,
        equity,
        TRADE_CONFIG.riskPerTrade,
        await exchange.info(decision.symbol),
      );
      if (!sizing) { console.log("ENTRY WAIT", decision.symbol, "INVALID_SIZING"); continue; }

      if (!Number.isFinite(account.availableBalance) ||

          account.availableBalance < sizing.notional * CONFIG.RISK_RESERVATION_MIN_MARGIN_MULTIPLIER) {

        console.log("ENTRY WAIT", decision.symbol, "INSUFFICIENT_AVAILABLE_MARGIN");

        continue;

      }

      if (isStopped() || entriesPaused() || lifecycle.uncertain || lifecycle.untracked.size) break;

      const reservation = await riskGuard.reserve(`${decision.symbol}:${decision.signalAt}`, equity);

      if (!reservation.ok) { console.log("ENTRY WAIT", decision.symbol, reservation.reason); continue; }

      const trade = newTrade(decision, sizing);
      trade.executionValidation = validation;
      if (isStopped() || entriesPaused() || lifecycle.uncertain || lifecycle.untracked.size)
        break;
      await lifecycle.enter(trade);
    } catch (e) {
      console.error("ENTRY PROCESSING", decision.symbol, e.message);
    }
  }
}
async function loadDecisionInput(
  exchange,
  journalStore,
  symbol,
  now = Date.now(),
  recentStore = null,
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
  const h4 = await exchange.candles(symbol, CONFIG.TIMEFRAME, HISTORY_4H_LIMIT);
  const probe = pipeline.closedCandles(h4, Date.now()).at(-1);
  if (!probe) return null;
  if (recentStore) await recentStore.store(symbol, pipeline.closedCandles(h4, Date.now()).map(c=>[c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime]));
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
    connectTimeoutMS: CONFIG.MONGO_CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: CONFIG.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    socketTimeoutMS: CONFIG.MONGO_SOCKET_TIMEOUT_MS,
    maxPoolSize: CONFIG.MONGO_MAX_POOL_SIZE,
    retryWrites: true,
  });
  const exchange = new BinanceExchange({
    key: process.env.BINANCE_KEY,
    secret: process.env.BINANCE_SECRET,
  });
  let stopped = false,
    entriesPaused = false,
    notifications = null;
  const intervals = [];
  const report = async (msg, metadata) => {
    console.log(msg);
    if (notifications) await notifications.report(msg, metadata);
  };
  process.on("unhandledRejection", (e) => {
    entriesPaused = true;
    console.error("NEW ENTRIES PAUSED", e?.message || e);
  });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    intervals.forEach(clearInterval);
    notifications?.stop();
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
  notifications = new TelegramNotifications({ db });
  await notifications.initialize();
  await exchange.initialize();
  await journal.initialize(db);
  const learner = createOfflineLearning(db);

  await learner.initialize();

  const riskGuard = new RiskGuard(db, { alert: msg => report(msg) });

  const waitControl = new WaitRateControl(db);

  const initialRisk = await riskGuard.assess(await exchange.equity());

  if (!initialRisk.ok) {

    entriesPaused = true;

    await report("NEW ENTRIES PAUSED: " + initialRisk.reason);

  }
  const lifecycle = new TradeLifecycle({
    exchange,
    db,
    journal,
    learner,
    notify: report,
    notifyEntry: async (trade) => {
      await notifications.entry(trade);
      console.log("ENTRY CONFIRMED", trade.symbol, trade.side, trade.signalKey);
    },
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
  const manage = every(CONFIG.PROTECTION_INTERVAL_MS, () => lifecycle.tick({ runMaintenance: false }));
  await manage();
  // Exchange safety has its own loop; historical API cooldowns, MAE/MFE and
  // Telegram delivery cannot keep timeout/SL/TP reconciliation waiting.
  const bookkeeping = every(CONFIG.BOOKKEEPING_INTERVAL_MS, () => lifecycle.maintenance());
  void bookkeeping();
  const deliver = every(CONFIG.NOTIFICATION_INTERVAL_MS, () => notifications.flush());
  void deliver();
  every(CONFIG.CLOCK_SYNC_INTERVAL_MS, () => exchange.syncTime());
  const retention = createRetention(db);
  const clean = every(retention.config.intervalMs, async () => {
    const summary = await retention.runCleanup();
    const usage = summary.usageAfterMB ?? summary.usageMB;
    if (Number.isFinite(usage) && usage >= summary.triggerMB)
      await report(`DATABASE CAPACITY: ${usage} MB; threshold ${summary.triggerMB} MB. ${summary.note || "Check storage capacity."}`);
  });
  void clean();
  const daily = every(CONFIG.LEARNING_INTERVAL_HOURS * 60 * 60 * 1000, async () => {
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
          await exchange.candles(symbol, CONFIG.TIMEFRAME, HISTORY_4H_LIMIT)
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
  async function scanSymbol(symbol, champion, trackRecord, outcomes, minEdge) {
    const input = await loadDecisionInput(exchange, journal, symbol, Date.now(), recentStore);
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
      config: { ...champion, minEdge: Math.max(minEdge, Number(champion?.minEdge) || 0), gapEdge: CONFIG.EDGE_GAP },
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
    const audited = await waitControl.record({

      symbol, signalAt: decision.signalAt || probe.closeTime,

      action: decision.action, reason: decision.reason,

    });

    if (!audited.ok) { console.error("WAIT AUDIT FAILED", symbol, audited.reason); return null; }

    if (!decision.authorizedForExecution) countWait(decision.reason);

    return decision.authorizedForExecution
      ? { ...decision, nineAiDecisionKey: saved.decisionKey }
      : null;
  }
  const scan = every(CONFIG.SCAN_INTERVAL_MS, async () => {
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

    const capacity = await memoryGuard.assess();


    if (!capacity.ok) { console.error("SCAN WAIT", capacity.reason); return; }


    const riskState = await riskGuard.assess(await exchange.equity());

    if (!riskState.ok) { console.error("SCAN WAIT", riskState.reason); return; }

    const adaptive = await waitControl.minimumEdge();

    if (!adaptive.ok) { console.error("SCAN WAIT", adaptive.reason); return; }

    // Apply measured calibration drift as a penalty, not an untested model update.
     const latestLearning=await db.collection("nine_ai_daily_learning_reports")
       .find({}).sort({runAt:-1}).limit(1).toArray();
     const calibrationPenalty=latestLearning[0]?.calibration?.status ===
       "RED_FLAG_CALIBRATION_DRIFT" ? CONFIG.LOW_CONF_PENALTY : 0;
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
        .limit(CONFIG.RECENT_LABELS_LIMIT)
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
    for (let i = 0; i < symbols.length && !stopped; i += CONFIG.SCAN_BATCH_SIZE) {
      const batch = await Promise.allSettled(
        symbols
          .slice(i, i + CONFIG.SCAN_BATCH_SIZE)
          .map((s) => scanSymbol(s, {...champion,uncertaintyPenalty:calibrationPenalty}, track, outcomes, adaptive.minEdge)),
      );
      for (const r of batch) {
        if (r.status === "fulfilled" && r.value) signals.push(r.value);
        else if (r.status === "rejected")
          console.error("SCAN", r.reason.message);
      }
      if ((i + CONFIG.SCAN_BATCH_SIZE) % CONFIG.SCAN_PROGRESS_EVERY_SYMBOLS === 0)
        console.log(
          "NINE-AI SCAN PROGRESS",
          "scanned=" + Math.min(i + CONFIG.SCAN_BATCH_SIZE, symbols.length) + "/" + symbols.length,
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
      riskGuard,
      isStopped: () => stopped,
      entriesPaused: () => entriesPaused,
    });
  });
  // Commands have their own loop. A Telegram outage cannot stall SL/TP/timeout management.
  let updateId = 0;
  const commands = every(CONFIG.COMMAND_POLL_INTERVAL_MS, async () => {
    if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) return;
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getUpdates?offset=${updateId + 1}&timeout=${CONFIG.COMMAND_LONG_POLL_SECONDS}`,
      { signal: AbortSignal.timeout(CONFIG.COMMAND_HTTP_TIMEOUT_MS) },
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
  while (!stopped) await sleep(CONFIG.MAIN_IDLE_SLEEP_MS);
}
if (require.main === module)
  main().catch((e) => {
    console.error("START FAILED", e.message);
    process.exit(1);
  });
module.exports = {
  RISK_PER_TRADE,
  HISTORY_4H_LIMIT,
  TRADE_CONFIG,
  marketSnapshot,
  universe,
  executeDecisions,
  loadDecisionInput,
};
