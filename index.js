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
  process.stdout.write("[" + new Date().toISOString() + "] [" + level + "] " + message + suffix + "\n");
};

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (!(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN)) throw new Error("TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is required");
  if (!(process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID)) throw new Error("TELEGRAM_CHAT_ID (or CHAT_ID) is required");
  const storage = await createStorage(config);
  const telegram = new Telegram(config);
  let busy = false;

  async function runCycle(options = {}) {
    if (busy) return null;
    busy = true;
    try {
      const newsResult = options.news ? await collectNews(config, storage) : { found:0, inserted:0, importantNews:[] };
      const marketResult = options.markets ? await collectMarkets(config, storage) : { updated:0, largeMoves:[] };
      const analyses = await analyzeAll(config, storage);
      await storage.saveLiveAnalyses(analyses);
      const alerts = await storage.createAlerts(analyses, newsResult.importantNews, marketResult.largeMoves);
      for (const alert of alerts.slice(0, config.maxAlertsPerRun)) {
        await telegram.send(alert.message);
        await storage.markAlertSent(alert.key);
      }
      const evaluated = await storage.evaluateDueForecasts();
      log("INFO", "Deterministic analysis cycle completed", {
        newsFound:newsResult.found, newsInserted:newsResult.inserted,
        marketUpdated:marketResult.updated, alerts:alerts.length, forecastsEvaluated:evaluated
      });
      return { newsResult, marketResult, analyses };
    } catch (error) {
      log("ERROR", "Collection cycle failed", { error:error.message });
      return null;
    } finally { busy = false; }
  }

  async function dailyReport() {
    const cycle = await runCycle({ news:true, markets:true });
    if (!cycle) throw new Error("Daily collection failed; report was not sent");
    const analyses = await analyzeAll(config, storage);
    await telegram.send(await telegram.buildDailyReport(analyses, storage));
    await storage.saveDailyReport(analyses);
    const stats = await storage.getForecastStats();
    if (stats.length) {
      const summary = stats.map(item => item.horizon + ": " + item.accuracy + "% (" + item.total + " mẫu)").join(" | ");
      await telegram.send("📊 KIỂM ĐỊNH DỰ BÁO ĐÃ ĐẾN HẠN\n" + summary + "\nChỉ tính dự báo đủ thời gian và có dữ liệu giá đối chiếu.");
    }
    log("INFO", "Daily deterministic forecast report sent");
  }

  await runCycle({ news:true, markets:true });
  startScheduler(config, storage, {
    onNewsPoll:() => runCycle({ news:true }),
    onMarketPoll:() => runCycle({ markets:true }),
    onDailyReport:dailyReport,
    onError:error => log("ERROR", "Scheduler error", { error:error.message })
  });

  const shutdown = async signal => {
    log("INFO", "Shutting down", { signal });
    await storage.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  log("INFO", "MARKET INTELLIGENCE started", {
    timezone:config.timezone, dailyReportTime:config.dailyReportTime,
    analyzer:"deterministic-quantitative", externalAI:false
  });
}

main().catch(error => {
  process.stderr.write("FATAL: " + (error.stack || error.message) + "\n");
  process.exit(1);
});
