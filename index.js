"use strict";

const { loadConfig, loadEnv } = require("./src/config");
const { createStorage } = require("./src/storage");
const { collectNews, collectMarkets } = require("./src/collectors");
const { analyzeAll } = require("./src/analyzer");
const { Telegram } = require("./src/telegram");
const { startScheduler } = require("./src/scheduler");

loadEnv();
const config = loadConfig();
const LOG_KEYS = {
  newsFound:"soTinTimDuoc", newsInserted:"soTinMoiDaLuu", marketUpdated:"soMaThiTruongDaCapNhat",
  forecastsEvaluated:"soDuBaoDaDanhGia", providersConfigured:"soNguonDaCauHinh",
  providersSucceeded:"soNguonHoatDong", providersFailed:"soNguonGapLoi", providersCoolingDown:"soNguonDangTamNghi",
  articlesFetched:"soBaiDaLay", uniqueEvents:"soSuKienSauKhiLocTrung", timezone:"muiGio", dailyReportTime:"gioBaoCaoHangNgay",
  analyzer:"moHinhPhanTich", externalAI:"suDungTriTueNhanTao", signal:"tinHieuDung", key:"maCanhBao", error:"loi"
};
const log = (level, message, extra = {}) => {
  const localized = Object.fromEntries(Object.entries(extra).map(([key, value]) => [LOG_KEYS[key] || key, value]));
  const suffix = Object.keys(localized).length ? " " + JSON.stringify(localized) : "";
  const levels = { INFO:"THÔNG TIN", WARN:"CẢNH BÁO", ERROR:"LỖI" };
  process.stdout.write("[" + new Date().toISOString() + "] [" + (levels[level] || level) + "] " + message + suffix + "\n");
};

async function main() {
  if (!process.env.MONGO_URI) throw new Error("Thiếu cấu hình kết nối cơ sở dữ liệu MONGO_URI");
  if (!(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN)) throw new Error("Thiếu mã truy cập Telegram (TELEGRAM_BOT_TOKEN hoặc BOT_TOKEN)");
  if (!(process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID)) throw new Error("Thiếu mã cuộc trò chuyện Telegram (TELEGRAM_CHAT_ID hoặc CHAT_ID)");
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
          log("WARN", "Thu thập tin tức gặp lỗi; tiếp tục phân tích bằng tin đã lưu", { error:error.message });
        }
      }
      if (options.markets) {
        try {
          Object.assign(marketResult, await collectMarkets(config, storage));
        } catch (error) {
          log("WARN", "Thu thập dữ liệu thị trường gặp lỗi; tiếp tục bằng dữ liệu đã lưu", { error:error.message });
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
            log("WARN", "Không gửi được cảnh báo Telegram; cảnh báo vẫn được giữ trong hàng đợi", { key:alert.key, error:error.message });
          }
        }
      } catch (error) {
        log("WARN", "Xử lý cảnh báo gặp lỗi; chu kỳ phân tích vẫn tiếp tục", { error:error.message });
      }

      let evaluated = 0;
      try {
        evaluated = await storage.evaluateDueForecasts();
      } catch (error) {
        log("WARN", "Đánh giá dự báo đến hạn gặp lỗi", { error:error.message });
      }

      log("INFO", "Đã hoàn tất chu kỳ phân tích định lượng", {
        newsFound:newsResult.found, newsInserted:newsResult.inserted,
        marketUpdated:marketResult.updated, forecastsEvaluated:evaluated
      });
      return { newsResult, marketResult, analyses };
    } catch (error) {
      log("ERROR", "Chu kỳ phân tích gặp lỗi", { error:error.message });
      return null;
    } finally {
      busy = false;
    }
  }

  async function dailyReport() {
    const cycle = await runCycle({ news:true, markets:true });
    if (!cycle) throw new Error("Thu thập dữ liệu cho báo cáo hằng ngày thất bại; không gửi báo cáo");
    const analyses = cycle.analyses;
    await telegram.send(await telegram.buildDailyReport(analyses, storage));
    await storage.saveDailyReport(analyses);
    const stats = await storage.getForecastStats();
    if (stats.length) {
      const summary = stats.map(item => item.horizon + ": " + item.accuracy + "% (" + item.total + " mẫu)").join(" | ");
      await telegram.send("📊 ĐÁNH GIÁ KẾT QUẢ DỰ BÁO ĐẾN HẠN\n" + summary + "\nChỉ tính những dự báo đã đủ thời gian và có dữ liệu giá để đối chiếu.");
    }
    log("INFO", "Đã gửi báo cáo dự báo định lượng hằng ngày");
  }

  let stopScheduler = () => {};
  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("INFO", "Đang tắt bot", { signal });
    stopScheduler();
    try { await storage.close(); }
    catch (error) { log("ERROR", "Đóng kết nối cơ sở dữ liệu gặp lỗi", { error:error.message }); }
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
  log("INFO", "BOT PHÂN TÍCH THỊ TRƯỜNG ĐÃ KHỞI ĐỘNG", {
    timezone:"Giờ Việt Nam (UTC+7)", dailyReportTime:config.dailyReportTime,
    analyzer:"Mô hình định lượng theo quy tắc", externalAI:false
  });
}

main().catch(error => {
  process.stderr.write("LỖI NGHIÊM TRỌNG: " + (error.stack || error.message) + "\n");
  process.exit(1);
});
