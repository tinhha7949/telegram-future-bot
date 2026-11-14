"use strict";

const { loadConfig, loadEnv } = require("./src/config");
const { createStorage } = require("./src/storage");
const { collectNews, collectMarkets } = require("./src/collectors");
const { analyzeAll } = require("./src/analyzer");
const { Telegram } = require("./src/telegram");
const { startScheduler } = require("./src/scheduler");

loadEnv();
const config = loadConfig();
const log = (level, message, extra = {}) => {
  const suffix = Object.keys(extra).length ? " " + JSON.stringify(extra) : "";
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}${suffix}\n`);
};

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (!(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN)) throw new Error("TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is required");
  if (!(process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID)) throw new Error("TELEGRAM_CHAT_ID (or CHAT_ID) is required");

  const storage = await createStorage(config);
  const telegram = new Telegram(config);
  let busy = false;

  async function runCycle({ news = false, markets = false } = {}) {
    if (busy) return null;
    busy = true;
    try {
      const newsResult = news ? await collectNews(config, storage) : { found: 0, inserted: 0, importantNews: [] };
      const marketResult = markets ? await collectMarkets(config, storage) : { updated: 0, largeMoves: [] };
      const analyses = await analyzeAll(config, storage);
      const alerts = await storage.createAlerts(analyses, newsResult.importantNews, marketResult.largeMoves);
      for (const alert of alerts.slice(0, config.maxAlertsPerRun)) {
        await telegram.send(alert.message);
        await storage.markAlertSent(alert.key);
      }
      log("INFO", "Collection cycle completed", { newsFound: newsResult.found, newsInserted: newsResult.inserted, marketUpdated: marketResult.updated, alerts: alerts.length });
      return { newsResult, marketResult, analyses };
    } catch (error) {
      log("ERROR", "Collection cycle failed", { error: error.message });
      return null;
    } finally {
      busy = false;
    }
  }

  async function dailyReport() {
    const cycle = await runCycle({ news: true, markets: true });
    if (!cycle) throw new Error("Daily collection failed; report was not sent");
    const analyses = await analyzeAll(config, storage, true);
    const report = await telegram.buildDailyReport(analyses);
    await telegram.send(report);
    await storage.saveDailyReport(analyses);
    log("INFO", "Daily report sent");
  }

  await runCycle({ news: true, markets: true });
  startScheduler(config, storage, {
    onNewsPoll: () => runCycle({ news: true }),
    onMarketPoll: () => runCycle({ markets: true }),
    onDailyReport: dailyReport,
    onError: error => log("ERROR", "Scheduler error", { error: error.message })
  });

  const shutdown = async signal => {
    log("INFO", "Shutting down", { signal });
    await storage.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  log("INFO", "MARKET INTELLIGENCE started", { timezone: config.timezone, dailyReportTime: config.dailyReportTime });
}

main().catch(error => {
  process.stderr.write(`FATAL: ${error.stack || error.message}\n`);
  process.exit(1);
});
