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
    const newsResult = { found:0, inserted:0, importantNews:[] };
    const marketResult = { updated:0, largeMoves:[] };
    try {
      // A failed upstream provider must not prevent the other provider from updating.
      if (options.news) {
        try {
          Object.assign(newsResult, await collectNews(config, storage));
        } catch (error) {
          log("WARN", "News collection failed; continuing with stored news", { error:error.message });
        }
      }
      if (options.markets) {
        try {
          Object.assign(marketResult, await collectMarkets(config, storage));
        } catch (error) {
          log("WARN", "Market collection failed; continuing with stored market data", { error:error.message });
        }
      }

      const analyses = await analyzeAll(config, storage);
      await storage.saveLiveAnalyses(analyses);

      try {
        const alerts = await storage.createAlerts(analyses, newsResult.importantNews, marketResult.largeMoves);
        for (const alert of alerts.slice(0, config.maxAlertsPerRun)) {
          try {
            await telegram.send(alert.message);
            await storage.markAlertSent(alert.key);
          } catch (error) {
            log("WARN", "Telegram alert delivery failed; alert remains queued", { key:alert.key, error:error.message });
          }
        }
      } catch (error) {
        log("WARN", "Alert processing failed; analysis cycle will continue", { error:error.message });
      }

      let evaluated = 0;
      try {
        evaluated = await storage.evaluateDueForecasts();
      } catch (error) {
        log("WARN", "Forecast evaluation failed", { error:error.message });
      }

      log("INFO", "Deterministic analysis cycle completed", {
        newsFound:newsResult.found, newsInserted:newsResult.inserted,
        marketUpdated:marketResult.updated, forecastsEvaluated:evaluated
      });
      return { newsResult, marketResult, analyses };
    } catch (error) {
      log("ERROR", "Analysis cycle failed", { error:error.message });
      return null;
    } finally {
      busy = false;
    }
  }

  async function dailyReport() {
    const cycle = await runCycle({ news:true, markets:true });
    if (!cycle) throw new Error("Daily collection failed; report was not sent");
    const analyses = cycle.analyses;
    await telegram.send(await telegram.buildDailyReport(analyses, storage));
    await storage.saveDailyReport(analyses);
    const stats = await storage.getForecastStats();
    if (stats.length) {
      const summary = stats.map(item => item.horizon + ": " + item.accuracy + "% (" + item.total + " mẫu)").join(" | ");
      await telegram.send("📊 KIỂM ĐỊNH DỰ BÁO ĐÃ ĐẾN HẠN\n" + summary + "\nChỉ tính dự báo đủ thời gian và có dữ liệu giá đối chiếu.");
    }
    log("INFO", "Daily deterministic forecast report sent");
  }

  let stopScheduler = () => {};
  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("INFO", "Shutting down", { signal });
    stopScheduler();
    try { await storage.close(); }
    catch (error) { log("ERROR", "Storage shutdown failed", { error:error.message }); }
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await runCycle({ news:true, markets:true });
  stopScheduler = startScheduler(config, storage, {
    onNewsPoll:() => runCycle({ news:true }),
    onMarketPoll:() => runCycle({ markets:true }),
    onDailyReport:dailyReport,
    onError:error => log("ERROR", "Scheduler error", { error:error.message })
  });
  log("INFO", "MARKET INTELLIGENCE started", {
    timezone:config.timezone, dailyReportTime:config.dailyReportTime,
    analyzer:"deterministic-quantitative", externalAI:false
  });
}

main().catch(error => {
  process.stderr.write("FATAL: " + (error.stack || error.message) + "\n");
  process.exit(1);
});
