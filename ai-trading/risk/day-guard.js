"use strict";
const { CONFIG } = require("../config");
const { phaseForLabelCount, riskForPhase } = require("../online-learning");

// Versioned, bot-activation-scoped ledger. Never import prior account/history peaks.
const RUN_RISK_ID = "BOT_RUN_V2";
const fail = reason => ({ ok: false, reason });
class RiskGuard {
  constructor(db, { config = CONFIG, now = () => Date.now(), alert = async () => {} } = {}) {
    if (!db?.collection) throw new Error("RISK_DB_REQUIRED");
    this.global = db.collection("nine_ai_global_risk");
    this.days = db.collection("nine_ai_daily_risk");
    this.reservations = db.collection("nine_ai_risk_reservations");
    this.config = config;
    this.now = now;
    this.alert = alert;
  }

  // The first *live* equity measurement anchors this bot session. The
  // document is durable across process crashes and systemd restarts; old
  // GLOBAL/account-history peaks are deliberately excluded.
  // Starting a different trading session requires a reviewed, explicit reset.
  async assess(equity) {
    if (!Number.isFinite(equity) || equity <= 0) return fail("EQUITY_UNCERTAIN");
    try {
      await this.global.updateOne(
        { _id: RUN_RISK_ID },
        { $setOnInsert: {
          schemaVersion: 2,
          startedAt: this.now(),
          startEquity: equity,
          peakEquity: equity,
          maxDrawdown: 0,
          halted: false,
        } },
        { upsert: true },
      );
      await this.global.updateOne(
        { _id: RUN_RISK_ID, halted: false },
        { $max: { peakEquity: equity } },
      );
      const state = await this.global.findOne({ _id: RUN_RISK_ID });
      if (!state || state.schemaVersion !== 2 ||
          !Number.isFinite(state.startEquity) || state.startEquity <= 0 ||
          !Number.isFinite(state.peakEquity) || state.peakEquity <= 0 ||
          !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0)
        return fail("RISK_STATE_UNCERTAIN");
      if (state.halted) return fail("DRAWDOWN_CIRCUIT_LATCHED");

      const dd = Math.max(0, (state.peakEquity - equity) / state.peakEquity);
      await this.global.updateOne(
        { _id: RUN_RISK_ID }, { $max: { maxDrawdown: dd } },
      );
      if (dd >= this.config.MAX_DRAWDOWN_CIRCUIT) {
        await this.global.updateOne(
          { _id: RUN_RISK_ID },
          { $set: { halted: true, haltedAt: this.now(), reason: "DRAWDOWN_CIRCUIT" } },
        );
        try { await this.alert("CRITICAL: bot-session drawdown circuit latched; new trades disabled"); }
        catch (error) { console.error("RISK ALERT FAILED", error.stack || error.message); }
        return fail("DRAWDOWN_CIRCUIT_LATCHED");
      }
      return {
        ok: true, drawdown: dd, peakEquity: state.peakEquity,
        startEquity: state.startEquity, startedAt: state.startedAt,
      };
    } catch (error) {
      console.error("RISK CHECK FAILED", error.stack || error.message);
      return fail("RISK_LEDGER_UNAVAILABLE");
    }
  }

  // Conservatively charge the FULL configured per-trade risk. Failed or
  // ambiguous orders never return capacity because they might have filled.
  // Unique signal reservations stop duplicate entry after retry/restart.
  async reserve(signalKey, equity, { labelCount = 0 } = {}) {
    if (!signalKey || typeof signalKey !== "string") return fail("INVALID_SIGNAL_KEY");
    const health = await this.assess(equity);
    if (!health.ok) return health;
    const phase = phaseForLabelCount(labelCount, this.config);
    const riskPct = riskForPhase(labelCount, this.config);
    const amount = equity * riskPct;
    if (!(amount > 0 && Number.isFinite(amount))) return fail("INVALID_RISK_AMOUNT");
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const dayKey = "UTC:" + day;
    try {
      await this.reservations.insertOne({
        _id: signalKey,
        day: dayKey,
        risk: amount,
        status: "CLAIMED_BEFORE_RISK_RESERVATION",
        createdAt: this.now(),
      });
    } catch (error) {
      // Uncertain outcome or duplicate key: fail closed, never resubmit.
      return fail("RISK_RESERVATION_ALREADY_EXISTS_OR_UNCERTAIN");
    }
    const discardUnchargedReservation = async () => {
      if (typeof this.reservations.deleteOne === "function")
        await this.reservations.deleteOne({
          _id: signalKey,
          status: "CLAIMED_BEFORE_RISK_RESERVATION",
        });
    };
    try {
      await this.days.updateOne(
        { _id: dayKey },
        { $setOnInsert: { startingEquity: equity, usedRisk: 0, usedTrades: 0 } },
        { upsert: true },
      );
      let bucket = await this.days.findOne({ _id: dayKey });
      if (!bucket) {
        await discardUnchargedReservation();
        return fail("DAILY_RISK_STATE_UNCERTAIN");
      }
      if (!Number.isFinite(bucket.usedTrades)) {
        let existingTrades = 0;
        if (typeof this.reservations.countDocuments === "function") {
          existingTrades = await this.reservations.countDocuments({
            day: dayKey, status: { $in: ["RESERVED", "RELEASING"] },
          });
        }
        await this.days.updateOne({ _id: dayKey }, { $set: { usedTrades: existingTrades } });
        bucket = await this.days.findOne({ _id: dayKey });
      }
      const capacity = bucket?.startingEquity * this.config.MAX_DAILY_RISK;
      if (!(Number.isFinite(capacity) && capacity > 0))
        return fail("DAILY_RISK_STATE_UNCERTAIN");
      if ((Number(bucket.usedTrades) || 0) >= this.config.MAX_TRADES_PER_DAY) {
        try { await this.alert("MAX TRADES PER DAY REACHED: new entries disabled until next UTC day"); }
        catch (error) { console.error("RISK ALERT FAILED", error.message); }
        await discardUnchargedReservation();
        return fail("MAX_TRADES_PER_DAY_REACHED");
      }
      if ((Number(bucket.usedRisk) || 0) + amount > capacity + 1e-12) {
        await discardUnchargedReservation();
        return fail("MAX_DAILY_RISK_REACHED");
      }
      const result = await this.days.updateOne(
        {
          _id: dayKey,
          usedRisk: { $lte: capacity - amount },
          usedTrades: { $lt: this.config.MAX_TRADES_PER_DAY },
        },
        { $inc: { usedRisk: amount, usedTrades: 1 } },
      );
      if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
        const current = await this.days.findOne({ _id: dayKey });
        if ((Number(current?.usedTrades) || 0) >= this.config.MAX_TRADES_PER_DAY) {
          await discardUnchargedReservation();
          return fail("MAX_TRADES_PER_DAY_REACHED");
        }
        try { await this.alert("DAILY RISK LIMIT: no new entries until next UTC day"); }
        catch (error) { console.error("RISK ALERT FAILED", error.message); }
        await discardUnchargedReservation();
        return fail("MAX_DAILY_RISK_REACHED");
      }
      // Conservatively treat unsuccessful status writes as claimed: the
      // reserved budget remains consumed and duplicate signal remains blocked.
      await this.reservations.updateOne(
        { _id: signalKey },
        { $set: { status: "RESERVED", reservedAt: this.now(), tradeCountCharged: true, phase, riskPct } },
      );
      return { ok: true, day: dayKey, risk: amount };
    } catch (error) {
      console.error("DAILY RISK RESERVATION FAILED", error.message);
      return fail("RISK_LEDGER_UNAVAILABLE");
    }
  }
  // Return a reservation only when the caller proves no order request was sent.
  // RELEASING makes the decrement recoverable: an interrupted release stays
  // fail-closed and cannot be mistaken for available capacity.
  async release(signalKey) {
    if (!signalKey || typeof signalKey !== "string") return false;
    try {
      const reservation = await this.reservations.findOneAndUpdate(
        { _id: signalKey, status: "RESERVED" },
        { $set: { status: "RELEASING", releasingAt: this.now() } },
        { returnDocument: "before" },
      );
      const row = reservation?.value ?? reservation;
      if (!row || row.status !== "RESERVED" ||
          !row.day || !(Number.isFinite(row.risk) && row.risk > 0)) return false;
      const dayRow = typeof this.days.findOne === "function"
        ? await this.days.findOne({ _id: row.day }) : null;
      const filter = { _id: row.day, usedRisk: { $gte: row.risk } };
      const decrement = { usedRisk: -row.risk };
      if (row.tradeCountCharged === true && Number.isFinite(dayRow?.usedTrades)) {
        filter.usedTrades = { $gte: 1 };
        decrement.usedTrades = -1;
      }
      const result = await this.days.updateOne(filter, { $inc: decrement });
      if (result.matchedCount !== 1 || result.modifiedCount !== 1) return false;
      await this.reservations.updateOne(
        { _id: signalKey, status: "RELEASING" },
        { $set: { status: "RELEASED", releasedAt: this.now() } },
      );
      await this.reservations.deleteOne({ _id: signalKey, status: "RELEASED" });
      return true;
    } catch (error) {
      console.error("DAILY RISK RELEASE FAILED", error.message);
      return false;
    }
  }
}
module.exports = { RiskGuard, RUN_RISK_ID };
