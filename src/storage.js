"use strict";

const { MongoClient } = require("mongodb");
const crypto = require("node:crypto");
const { formatNewsAlert, formatMarketAlert } = require("./i18n");

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function forecastDueAt(referenceAt, hours) {
  const parsed = new Date(referenceAt || Date.now());
  const baseTime = Number.isFinite(parsed.getTime()) ? parsed.getTime() : Date.now();
  const horizonMs = Math.max(0, Number(hours) || 0) * 3600000;
  return new Date(baseTime + horizonMs);
}

async function createStorage(config) {
  const client = new MongoClient(process.env.MONGO_URI, {
    maxPoolSize: 3, minPoolSize: 0, maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, retryWrites: true
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  const db = client.db(config.database.name);
  const news = db.collection("news");
  const markets = db.collection("market_snapshots");
  const marketHistory = db.collection("market_history");
  const analyses = db.collection("analyses");
  const forecasts = db.collection("forecast_history");
  const alerts = db.collection("alerts");
  const state = db.collection("bot_state");

  try {
    await Promise.all([
    news.createIndex({ key: 1 }, { unique: true, name: "news_key_unique" }),
    news.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "news_ttl" }),
    news.createIndex({ assetId: 1, publishedAt: -1 }, { name: "news_asset_date" }),
    markets.createIndex({ key: 1 }, { unique: true, name: "market_key_unique" }),
    markets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "market_ttl" }),
    markets.createIndex({ assetId: 1, capturedAt: -1 }, { name: "market_asset_date" }),
    marketHistory.createIndex({ assetId: 1, symbol: 1, marketTime: 1 }, { name: "market_history_observation" }),
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
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }

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
        const originalTitle = String(item.originalTitle || item.title || "").trim();
        const candidateTitle = String(item.title || "").trim();
        const safeTitle = !candidateTitle || candidateTitle === "Không thể dịch tự động tiêu đề tin này"
          ? originalTitle : candidateTitle;
        const doc = {
          key, assetId: item.assetId, assetName: item.assetName,
          title: String(safeTitle || originalTitle).slice(0, 280),
          originalTitle: originalTitle.slice(0, 280),
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
        const result = await news.updateOne({ key }, { $set: doc }, { upsert: true });
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
        const sourceTime = item.marketTime ? new Date(item.marketTime) : now;
        const marketTime = Number.isFinite(sourceTime.getTime()) && sourceTime.getTime() <= now.getTime() + 5 * 60000 ? sourceTime : now;
        const doc = { ...item, key, marketTime, capturedAt: now, expiresAt: new Date(now.getTime() + config.database.marketRetentionDays * 86400000) };
        await markets.updateOne({ key }, { $set: doc }, { upsert: true });
        const historyDoc = {
          assetId: item.assetId, assetName: item.assetName, symbol: item.symbol,
          instrumentName: item.instrumentName || (config.symbolLabels || {})[item.symbol] || item.symbol,
          price: item.price, changePercent: item.changePercent, momentum: item.momentum || {},
          volatilityPct: item.volatilityPct ?? null, source: item.source,
          marketTime, capturedAt: now,
          expiresAt: new Date(now.getTime() + (config.database.marketHistoryRetentionDays || 45) * 86400000)
        };
        // Re-polling the same completed candle refreshes its value instead of creating fake observations.
        await marketHistory.updateOne(
          { assetId: item.assetId, symbol: item.symbol, marketTime },
          { $set: historyDoc },
          { upsert: true }
        );
        updated++;
        if (Number.isFinite(Number(item.changePercent)) && Math.abs(Number(item.changePercent)) >= config.urgentMovePercent) largeMoves.push(doc);
      }
      await trim(markets, config.database.maxMarketDocuments);
      await trim(marketHistory, config.database.maxMarketHistoryDocuments || 12000);
      return { updated, largeMoves };
    },
    async getRecentNews(assetId, limit = 12) {
      return news.find({ assetId, expiresAt: { $gt: new Date() } }).sort({ publishedAt: -1 }).limit(limit).toArray();
    },
    async getLatestMarkets() {
      const now = new Date();
      const maxAgeMs = Math.max(1, Number(config.marketMaxAgeHours || 96)) * 3600000;
      return markets.find({
        expiresAt: { $gt: now },
        marketTime: { $gte: new Date(now.getTime() - maxAgeMs), $lte: new Date(now.getTime() + 5 * 60000) }
      }).sort({ capturedAt: -1 }).limit(100).toArray();
    },
    async createAlerts(analysisItems, importantNews, largeMoves) {
      const candidates = [];
      for (const item of importantNews) {
        const latest = analysisItems.find(value => value.assetId === item.assetId);
        const forecast = latest && (latest.forecasts || []).find(value => value.horizon === "24h");
        candidates.push({
          key: "news:" + item.key,
          message: formatNewsAlert(item, forecast)
        });
      }
      const cooldownMs = Math.max(0, Number(config.alertCooldownMinutes ?? 90)) * 60000;
      for (const item of largeMoves) {
        const prefix = "move:" + item.assetId + ":" + item.symbol + ":";
        if (cooldownMs > 0) {
          const escapedPrefix = prefix.replace(/\./g, "\\.");
          const recent = await alerts.findOne({
            key: { $regex: "^" + escapedPrefix },
            createdAt: { $gte: new Date(Date.now() - cooldownMs) }
          });
          if (recent) continue;
        }
        candidates.push({
          key: prefix + new Date().toISOString(),
          message: formatMarketAlert(item, config)
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
    async saveLiveAnalyses(items) {
      const now = new Date();
      for (const item of items) {
        await analyses.updateOne(
          { assetId: item.assetId, snapshotType: "live" },
          { $set: { ...item, snapshotType: "live", updatedAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000) } },
          { upsert: true }
        );
      }
    },
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
          const referenceAt = reference.marketTime || reference.capturedAt || new Date();
          const dueAt = forecastDueAt(referenceAt, forecast.hours || 24);
          await forecasts.updateOne(
            { forecastKey },
            { $setOnInsert: {
              forecastKey, reportDay: day, assetId: item.assetId, assetName: item.assetName,
              horizon: forecast.horizon, direction: forecast.direction, confidence: forecast.confidence,
              method: forecast.method || item.analysisMethod || "deterministic-quantitative",
              modelScore: forecast.score || 0, evidenceCount: forecast.evidenceCount || 0,
              referenceSymbol: reference.symbol, referencePrice: reference.price,
              referenceAt, dueAt, status: "pending",
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
          { assetId: forecast.assetId, symbol: forecast.referenceSymbol, marketTime: { $gte: forecast.dueAt }, price: { $gt: 0 } },
          { sort: { marketTime: 1 } }
        );
        if (!observed || !Number(forecast.referencePrice)) continue;
        const changePct = ((Number(observed.price) - Number(forecast.referencePrice)) / Number(forecast.referencePrice)) * 100;
        const neutralBand = Number(config.forecastNeutralBandPct || 0.15);
        const actual = changePct > neutralBand ? "BULLISH" : changePct < -neutralBand ? "BEARISH" : "NEUTRAL";
        const correct = forecast.direction === actual;
        await forecasts.updateOne({ _id: forecast._id, status: "pending" }, {
          $set: { status: "evaluated", actualDirection: actual, changePct: Number(changePct.toFixed(4)), correct, evaluatedAt: observed.marketTime }
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

module.exports = { createStorage, hash, forecastDueAt };