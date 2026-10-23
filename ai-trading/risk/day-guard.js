"use strict";
const { CONFIG } = require("../config");

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

  // A drawdown trip is durable and LATCHED. It cannot be silently cleared by
  // restarting a process or resetting the daily budget.
  async assess(equity) {
    if (!Number.isFinite(equity) || equity <= 0) return fail("EQUITY_UNCERTAIN");
    try {
      await this.global.updateOne(
        { _id: "GLOBAL" },
        { $max: { peakEquity: equity }, $setOnInsert: { halted: false } },
        { upsert: true },
      );
      const state = await this.global.findOne({ _id: "GLOBAL" });
      if (!state || !Number.isFinite(state.peakEquity) || state.peakEquity <= 0)
        return fail("RISK_STATE_UNCERTAIN");
      if (state.halted) return fail("DRAWDOWN_CIRCUIT_LATCHED");
      const dd = (state.peakEquity - equity) / state.peakEquity;
      if (dd >= this.config.MAX_DRAWDOWN_CIRCUIT) {
        await this.global.updateOne(
          { _id: "GLOBAL" },
          { $set: { halted: true, haltedAt: this.now(), reason: "DRAWDOWN_CIRCUIT" } },
        );
        try { await this.alert("CRITICAL: drawdown circuit latched; new trades disabled"); }
        catch (error) { console.error("RISK ALERT FAILED", error.message); }
        return fail("DRAWDOWN_CIRCUIT_LATCHED");
      }
      return { ok: true, drawdown: dd, peakEquity: state.peakEquity };
    } catch (error) {
      console.error("RISK CHECK FAILED", error.message);
      return fail("RISK_LEDGER_UNAVAILABLE");
    }
  }

  // Conservatively charge the FULL configured per-trade risk. Failed or
  // ambiguous orders never return capacity because they might have filled.
  // Unique signal reservations stop duplicate entry after retry/restart.
  async reserve(signalKey, equity) {
    if (!signalKey || typeof signalKey !== "string") return fail("INVALID_SIGNAL_KEY");
    const health = await this.assess(equity);
    if (!health.ok) return health;
    const amount = equity * this.config.RISK_PER_TRADE;
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
    try {
      await this.days.updateOne(
        { _id: dayKey },
        { $setOnInsert: { startingEquity: equity, usedRisk: 0 } },
        { upsert: true },
      );
      const bucket = await this.days.findOne({ _id: dayKey });
      const capacity = bucket?.startingEquity * this.config.MAX_DAILY_RISK;
      if (!(Number.isFinite(capacity) && capacity > 0))
        return fail("DAILY_RISK_STATE_UNCERTAIN");
      const result = await this.days.updateOne(
        { _id: dayKey, usedRisk: { $lte: capacity - amount } },
        { $inc: { usedRisk: amount } },
      );
      if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
        try { await this.alert("DAILY RISK LIMIT: no new entries until next UTC day"); }
        catch (error) { console.error("RISK ALERT FAILED", error.message); }
        return fail("MAX_DAILY_RISK_REACHED");
      }
      // Conservatively treat unsuccessful status writes as claimed: the
      // reserved budget remains consumed and duplicate signal remains blocked.
      await this.reservations.updateOne(
        { _id: signalKey },
        { $set: { status: "RESERVED", reservedAt: this.now() } },
      );
      return { ok: true, day: dayKey, risk: amount };
    } catch (error) {
      console.error("DAILY RISK RESERVATION FAILED", error.message);
      return fail("RISK_LEDGER_UNAVAILABLE");
    }
  }
}
module.exports = { RiskGuard };
