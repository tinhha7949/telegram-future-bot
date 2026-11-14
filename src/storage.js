"use strict";

const { MongoClient } = require("mongodb");
const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function createStorage(config) {
  const client = new MongoClient(process.env.MONGO_URI, {
    maxPoolSize: 3, minPoolSize: 0, maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, retryWrites: true
  });
  await client.connect();
  const db = client.db(config.database.name);
  const news = db.collection("news");
  const markets = db.collection("market_snapshots");
  const marketHistory = db.collection("market_history");
  const analyses = db.collection("analyses");
  const forecasts = db.collection("forecast_history");
  const alerts = db.collection("alerts");
  const state = db.collection("bot_state");

  await Promise.all([
    news.createIndex({ key: 1 }, { unique: true, name: "news_key_unique" }),
    news.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "news_ttl" }),
    news.createIndex({ assetId: 1, publishedAt: -1 }, { name: "news_asset_date" }),
    markets.createIndex({ key: 1 }, { unique: true, name: "market_key_unique" }),
    markets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "market_ttl" }),
    markets.createIndex({ assetId: 1, capturedAt: -1 }, { name: "market_asset_date" }),
    marketHistory.createIndex({ assetId: 1, symbol: 1, capturedAt: 1 }, { name: "market_history_lookup" }),
    marketHistory.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "market_history_ttl" }),
    analyses.createIndex({ assetId: 1, reportDay: -1 }, { name: "analysis_asset_day" }),
    analyses.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "analysis_ttl" }),
    forecasts.createIndex({ forecastKey: 1 }, { unique: true, name: "forecast_key_unique" }),
    forecasts.createIndex({ status: 1, dueAt: 1 }, { name: "forecast_due_lookup" }),
    forecasts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "forecast_ttl" }),
    alerts.createIndex({ key: 1 }, { unique: true, name: "alert_key_unique" }),
    alerts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "alert_ttl" }),
    state.createIndex({ key: 1 }, { unique: true, name: "state_key_unique" })
  ]);

  async function trim(collection, max) {
    const count = await collection.countDocuments();
    if (count <= max) return;
    const old = await collection.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(count - max).toArray();
    if (old.length) await collection.deleteMany({ _id: { $in: old.map(x => x._id) } });
  }

  return {
    async saveNews(items) {
      let inserted = 0;
      const importantNews = [];
      const now = new Date();
      for (const item of items) {
        const key = hash(`${item.assetId}:${item.url || item.title}`);
        const importance = Number(item.importance || 0);
        const days = importance >= 6 ? config.database.criticalNewsRetentionDays :
          importance >= config.importantNewsScore ? config.database.importantNewsRetentionDays :
          config.database.newsRetentionDays;
        const doc = {
          key, assetId: item.assetId, assetName: item.assetName,
          title: String(item.title || "").slice(0, 280),
          source: String(item.source || "Unknown").slice(0, 80),
          url: String(item.url || "").slice(0, 500),
          publishedAt: item.publishedAt || now, fetchedAt: now, importance,
          sentiment: item.sentiment || "neutral",
          eventType: item.eventType || "unclassified",
          eventTypes: item.eventTypes || [],
          impactScore: Number(item.impactScore || 0),
          relevance: Number(item.relevance || 0.25),
          sourceWeight: Number(item.sourceWeight || 0.8),
          eventHalfLifeHours: Number(item.eventHalfLifeHours || 24),
          expiresAt: new Date(now.getTime() + days * 86400000)
        };
        const result = await news.updateOne({ key }, { $setOnInsert: doc }, { upsert: true });
        if (result.upsertedCount) {
          inserted++;
          if (importance >= config.importantNewsScore) importantNews.push(doc);
        }
      }
      await trim(news, config.database.maxNewsDocuments);
      return { inserted, importantNews };
    },
    async saveMarkets(items) {
      const now = new Date();
      let updated = 0;
      const largeMoves = [];
      for (const item of items) {
        const key = `${item.assetId}:${item.symbol}`;
        const doc = { ...item, key, capturedAt: now, expiresAt: new Date(now.getTime() + config.database.marketRetentionDays * 86400000) };
        await markets.updateOne({ key }, { $set: doc }, { upsert: true });
        await marketHistory.insertOne({
          assetId: item.assetId, assetName: item.assetName, symbol: item.symbol,
          price: item.price, changePercent: item.changePercent, momentum: item.momentum || {},
          volatilityPct: item.volatilityPct || 0, source: item.source,
          capturedAt: now,
          expiresAt: new Date(now.getTime() + (config.database.marketHistoryRetentionDays || 45) * 86400000)
        });
        updated++;
        if (Math.abs(Number(item.changePercent || 0)) >= config.urgentMovePercent) largeMoves.push(doc);
      }
      await trim(markets, config.database.maxMarketDocuments);
      await trim(marketHistory, config.database.maxMarketHistoryDocuments || 12000);
      return { updated, largeMoves };
    },
    async getRecentNews(assetId, limit = 12) {
      return news.find({ assetId, expiresAt: { $gt: new Date() } }).sort({ publishedAt: -1 }).limit(limit).toArray();
    },
    async getLatestMarkets() {
      return markets.find({ expiresAt: { $gt: new Date() } }).sort({ capturedAt: -1 }).limit(100).toArray();
    },
    async createAlerts(analysisItems, importantNews, largeMoves) {
      const candidates = [];
      for (const item of importantNews) candidates.push({
        key: `news:${item.key}`,
        message: `🚨 TIN TỨC QUAN TRỌNG | ${item.assetName}\n${item.title}\nSự kiện: ${item.eventType || "chưa phân loại"}\nTác động theo mô hình: ${Number(item.impactScore || 0) > 0 ? "TÍCH CỰC" : Number(item.impactScore || 0) < 0 ? "TIÊU CỰC" : "CHƯA RÕ"} (${Number(item.impactScore || 0).toFixed(1)})\nMức độ: ${item.importance}/10\nNguồn: ${item.source}\n${item.url}`
      });
      for (const item of largeMoves) {
        const direction = item.changePercent >= 0 ? "TĂNG" : "GIẢM";
        candidates.push({
          key: `move:${item.assetId}:${item.symbol}:${new Date().toISOString().slice(0, 13)}`,
          message: `⚡ BIẾN ĐỘNG THỊ TRƯỜNG\n${item.symbol}: ${direction} ${Number(item.changePercent).toFixed(2)}%\nGiá tham chiếu: ${item.price}\nNguồn: ${item.source || "Yahoo Finance"}`
        });
      }
      for (const candidate of candidates) {
        await alerts.updateOne(
          { key: candidate.key },
          { $setOnInsert: { key: candidate.key, message: candidate.message, createdAt: new Date(), expiresAt: new Date(Date.now() + config.database.alertRetentionDays * 86400000) } },
          { upsert: true }
        );
      }
      return alerts.find({ sentAt: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ createdAt: 1 }).limit(config.maxAlertsPerRun).toArray();
    },
    async markAlertSent(key) { await alerts.updateOne({ key }, { $set: { sentAt: new Date() } }); },
    async saveDailyReport(items) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const marketsNow = await this.getLatestMarkets();
      for (const item of items) {
        await analyses.updateOne(
          { assetId: item.assetId, reportDay: day },
          { $set: { ...item, reportDay: day, createdAt: new Date(), expiresAt: new Date(Date.now() + config.database.analysisRetentionDays * 86400000) } },
          { upsert: true }
        );
        const reference = marketsNow.find(m => m.assetId === item.assetId && Number(m.price) > 0);
        if (!reference) continue;
        for (const forecast of item.forecasts || []) {
          const forecastKey = `${day}:${item.assetId}:${forecast.horizon}`;
          const dueAt = new Date(Date.now() + Number(forecast.hours || 24) * 3600000);
          await forecasts.updateOne(
            { forecastKey },
            { $setOnInsert: {
              forecastKey, reportDay: day, assetId: item.assetId, assetName: item.assetName,
              horizon: forecast.horizon, direction: forecast.direction, confidence: forecast.confidence,
              method: forecast.method || item.analysisMethod || "deterministic-quantitative",
              modelScore: forecast.score || 0, evidenceCount: forecast.evidenceCount || 0,
              referenceSymbol: reference.symbol, referencePrice: reference.price,
              referenceAt: reference.capturedAt || new Date(), dueAt, status: "pending",
              expiresAt: new Date(Date.now() + config.database.analysisRetentionDays * 86400000)
            } },
            { upsert: true }
          );
        }
      }
    },
    async evaluateDueForecasts() {
      const due = await forecasts.find({ status: "pending", dueAt: { $lte: new Date() } }).limit(100).toArray();
      let evaluated = 0;
      for (const forecast of due) {
        const observed = await marketHistory.findOne(
          { assetId: forecast.assetId, symbol: forecast.referenceSymbol, capturedAt: { $gte: forecast.dueAt }, price: { $gt: 0 } },
          { sort: { capturedAt: 1 } }
        );
        if (!observed || !Number(forecast.referencePrice)) continue;
        const changePct = ((Number(observed.price) - Number(forecast.referencePrice)) / Number(forecast.referencePrice)) * 100;
        const neutralBand = Number(config.forecastNeutralBandPct || 0.15);
        const actual = changePct > neutralBand ? "BULLISH" : changePct < -neutralBand ? "BEARISH" : "NEUTRAL";
        const correct = forecast.direction === actual;
        await forecasts.updateOne({ _id: forecast._id, status: "pending" }, {
          $set: { status: "evaluated", actualDirection: actual, changePct: Number(changePct.toFixed(4)), correct, evaluatedAt: observed.capturedAt }
        });
        evaluated++;
      }
      return evaluated;
    },
    async getForecastStats() {
      const rows = await forecasts.aggregate([
        { $match: { status: "evaluated" } },
        { $group: { _id: "$horizon", total: { $sum: 1 }, correct: { $sum: { $cond: ["$correct", 1, 0] } } } }
      ]).toArray();
      return rows.map(row => ({ horizon: row._id, total: row.total, accuracy: row.total ? Math.round(row.correct / row.total * 100) : 0 }));
    },
    async saveDailySentState(day) { await state.updateOne({ key: `daily:${day}` }, { $set: { sentAt: new Date() } }, { upsert: true }); },
    async wasDailySent(day) { return Boolean(await state.findOne({ key: `daily:${day}` })); },
    async markDailySent(day) { await state.updateOne({ key: `daily:${day}` }, { $set: { sentAt: new Date() } }, { upsert: true }); },
    async close() { await client.close(); }
  };
}

module.exports = { createStorage, hash };