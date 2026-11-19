"use strict";
const { MongoClient } = require("mongodb");
async function connectStore(uri, cfg) {
  const client = new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 10000, retryWrites: true });
  await client.connect();
  const db = client.db(cfg.databaseName);
  const names = cfg.collections;
  const store = {
    client, db,
    positions: db.collection(names.positions),
    setups: db.collection(names.setups),
    events: db.collection(names.events),
    scanner: db.collection(names.scanner),
    async init() {
      await this.positions.createIndex({ symbol: 1 }, { unique: true, partialFilterExpression: { status: "OPEN" } });
      await this.positions.createIndex({ status: 1, updatedAt: -1 });
      await this.setups.createIndex({ symbol: 1 }, { unique: true });
      await this.events.createIndex({ createdAt: 1 }, { expireAfterSeconds: cfg.eventRetentionDays * 86400 });
      await this.scanner.createIndex({ _id: 1 });
    },
    async getOpenPositions() { return this.positions.find({ status: "OPEN" }).toArray(); },
    async getPosition(symbol) { return this.positions.findOne({ symbol, status: "OPEN" }); },
    async openPosition(doc) { await this.positions.insertOne({ ...doc, status: "OPEN", createdAt: new Date(), updatedAt: new Date() }); },
    async updatePosition(symbol, patch) { await this.positions.updateOne({ symbol, status: "OPEN" }, { $set: { ...patch, updatedAt: new Date() } }); },
    async closePosition(symbol, result) { await this.positions.updateOne({ symbol, status: "OPEN" }, { $set: { ...result, status: "CLOSED", closedAt: new Date(), updatedAt: new Date() } }); },
    async getSetup(symbol) { return this.setups.findOne({ symbol }); },
    async saveSetup(symbol, setup) { await this.setups.updateOne({ symbol }, { $set: { ...setup, symbol, updatedAt: new Date() } }, { upsert: true }); },
    async deleteSetup(symbol) { await this.setups.deleteOne({ symbol }); },
    async saveEvent(event) { await this.events.insertOne({ ...event, createdAt: new Date() }); },
    async saveScanner(symbols) { await this.scanner.updateOne({ _id: "universe" }, { $set: { symbols, updatedAt: new Date() } }, { upsert: true }); },
    async getScanner() { return this.scanner.findOne({ _id: "universe" }); },
    async close() { await client.close(); }
  };
  await store.init();
  return store;
}
module.exports = { connectStore };
