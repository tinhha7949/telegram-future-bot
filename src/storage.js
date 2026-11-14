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
  const analyses = db.collection("analyses");
  const alerts = db.collection("alerts");
  const state = db.collection("bot_state");

  await Promise.all([
    news.createIndex({ key: 1 }, { unique: true, name: "news_key_unique" }),
    news.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "news_ttl" }),
    news.createIndex({ assetId: 1, publishedAt: -1 }, { name: "news_asset_date" }),
    markets.createIndex({ key: 1 }, { unique: true, name: "market_key_unique" }),
    markets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "market_ttl" }),
    markets.createIndex({ assetId: 1, capturedAt: -1 }, { name: "market_asset_date" }),
    analyses.createIndex({ assetId: 1, reportDay: -1 }, { name: "analysis_asset_day" }),
    analyses.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "analysis_ttl" }),
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
        updated++;
        if (Math.abs(Number(item.changePercent || 0)) >= config.urgentMovePercent) largeMoves.push(doc);
      }
      await trim(markets, config.database.maxMarketDocuments);
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
        message: `🚨 TIN TỨC QUAN TRỌNG | ${item.assetName}\n${item.title}\nMức độ: ${item.importance}/10\nNguồn: ${item.source}\n${item.url}`
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
      return alerts.find({ key: { $in: candidates.map(x => x.key) }, sentAt: { $exists: false } }).limit(config.maxAlertsPerRun).toArray();
    },
    async markAlertSent(key) { await alerts.updateOne({ key }, { $set: { sentAt: new Date() } }); },
    async saveDailyReport(items) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      for (const item of items) {
        await analyses.updateOne(
          { assetId: item.assetId, reportDay: day },
          { $set: { ...item, reportDay: day, createdAt: new Date(), expiresAt: new Date(Date.now() + config.database.analysisRetentionDays * 86400000) } },
          { upsert: true }
        );
      }
    },
    async wasDailySent(day) { return Boolean(await state.findOne({ key: `daily:${day}` })); },
    async markDailySent(day) { await state.updateOne({ key: `daily:${day}` }, { $set: { sentAt: new Date() } }, { upsert: true }); },
    async close() { await client.close(); }
  };
}

module.exports = { createStorage, hash };
