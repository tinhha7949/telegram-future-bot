"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, memoryDb } = require("./test-fixtures.cjs");
const { analyzeNineAI } = require("./nine-ai-pipeline");
const { newTrade, TradeLifecycle, TIMEOUT_MS } = require("./trade-lifecycle");
const { createOfflineLearning } = require("./nine-ai-offline-learning");

function harness() {
  let now = Date.now(),
    qty = 0,
    sequence = 1;
  const f = fixture("LONG", now),
    d = analyzeNineAI(f);
  d.nineAiDecisionKey = "decision";
  const rules = {
    step: 0.1,
    tick: 0.01,
    minQty: 0.1,
    maxQty: 10000,
    minNotional: 5,
  };
  const sizing = {
    quantity: 2,
    sl: d.sl,
    tp1: d.tp1,
    tp2: d.tp2,
    risk: 2 * Math.abs(d.entry - d.sl),
    initialRisk: Math.abs(d.entry - d.sl),
    rules,
  };
  const trade = newTrade(d, sizing, now),
    db = memoryDb(),
    orders = new Map(),
    algos = new Map(),
    fills = [],
    calls = [];
  const exchange = {
    entryPrice: d.entry,
    async positions() {
      return qty
        ? [
            {
              symbol: d.symbol,
              positionAmt: String(qty),
              entryPrice: String(this.entryPrice),
              markPrice: String(this.entryPrice),
            },
          ]
        : [];
    },
    async openOrders() {
      return [];
    },
    async cancelAlgos() {
      calls.push("cancel");
      for (const a of algos.values()) a.algoStatus = "CANCELED";
    },
    async openAlgos() {
      return [...algos.values()].filter((a) => a.algoStatus === "NEW");
    },
    async order(_, id) {
      const o = orders.get(id);
      if (!o) {
        const e = new Error("not found");
        e.code = -2013;
        throw e;
      }
      return { ...o };
    },
    async market(t, cid, reduceOnly, amount = t.quantity) {
      calls.push(reduceOnly ? "close" : "entry");
      const price = this.entryPrice,
        id = sequence++;
      qty = reduceOnly ? 0 : amount;
      const o = {
        orderId: id,
        status: "FILLED",
        executedQty: String(amount),
        avgPrice: String(price),
        updateTime: now,
        clientOrderId: cid,
      };
      orders.set(cid, o);
      fills.push({
        id,
        orderId: id,
        symbol: t.symbol,
        time: now,
        side: reduceOnly ? "SELL" : "BUY",
        qty: String(amount),
        price: String(price),
        commission: ".01",
        commissionAsset: "USDT",
        realizedPnl: reduceOnly ? String((price - trade.entry) * amount) : "0",
      });
      return o;
    },
    async protection(t, kind, cid) {
      calls.push(kind);
      const a = {
        algoId: sequence++,
        clientAlgoId: cid,
        symbol: t.symbol,
        side: "SELL",
        orderType: kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
        triggerPrice: t[kind],
        quantity: kind === "tp1" ? t.actualQuantity / 2 : 0,
        reduceOnly: kind === "tp1",
        closePosition: kind !== "tp1",
        algoStatus: "NEW",
        kind,
      };
      algos.set(cid, a);
      return a;
    },
    async algo(_, cid) {
      const a = algos.get(cid);
      if (!a) {
        const e = new Error("not found");
        e.code = -2013;
        throw e;
      }
      return a;
    },
    async algoById(_, algoId) {
      return [...algos.values()].find(
        (a) => String(a.algoId) === String(algoId),
      );
    },
    async request(_, p) {
      return orders.get(String(p.orderId));
    },
    async fills() {
      return structuredClone(fills);
    },
    async funding() {
      return [];
    },
    async convertFees() {},
    async candles() {
      return [];
    },
    async info() {
      return { filters: [] };
    },
    trigger(kind) {
      const a = [...algos.values()].find(
        (a) => a.kind === kind && a.algoStatus === "NEW",
      );
      assert.ok(a);
      const amount = kind === "tp1" ? trade.actualQuantity / 2 : qty;
      qty -= amount;
      const orderId = sequence++;
      a.algoStatus = "FINISHED";
      a.actualOrderId = String(orderId);
      orders.set(String(orderId), {
        orderId,
        status: "FILLED",
        executedQty: String(amount),
      });
      fills.push({
        id: orderId,
        orderId,
        symbol: trade.symbol,
        time: ++now,
        side: "SELL",
        qty: String(amount),
        price: String(a.triggerPrice),
        commission: ".01",
        commissionAsset: "USDT",
        realizedPnl: String((a.triggerPrice - trade.entry) * amount),
      });
    },
  };
  const journal = {
      actuals: [],
      async recordActualOutcome(o) {
        this.actuals.push(o);
      },
    },
    learner = createOfflineLearning(db);
  const create = () =>
    new TradeLifecycle({
      exchange,
      db,
      journal,
      learner,
      notify: async () => {},
      now: () => now,
      wait: async () => {},
    });
  return {
    trade,
    db,
    exchange,
    calls,
    algos,
    fills,
    journal,
    create,
    advance: (ms) => {
      now += ms;
    },
  };
}
test("entry -> durable full plan -> restart -> TP1 -> restart -> TP2 -> complete accounting and labels", async () => {
  const h = harness();
  let l = h.create();
  await l.initialize();
  assert.equal(await l.enter(h.trade), true);
  assert.deepEqual(
    h.calls.filter((c) => ["sl", "tp1", "tp2"].includes(c)),
    ["sl", "tp2", "tp1"],
  );
  const claim = await h.db
    .collection("trade_signal_claims")
    .findOne({ signalKey: h.trade.signalKey });
  assert.equal(
    claim.tradeSnapshot.plannedLevels.tp1,
    h.trade.plannedLevels.tp1,
  );
  l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  h.exchange.trigger("tp1");
  await l.tick();
  assert.equal([...l.active.values()][0].tp1Filled, true);
  l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  h.exchange.trigger("tp2");
  await l.tick();
  assert.equal(l.active.size, 0);
  const saved = await h.db
    .collection("trades")
    .findOne({ signalKey: h.trade.signalKey });
  assert.equal(saved.result, "WIN");
  assert.equal(saved.closedAccounting.accountingComplete, true);
  assert.equal(saved.closedAccounting.executionFillCount, 3);
  const actual = h.db.collection("nine_ai_actual_outcomes").rows[0];
  assert.equal(actual.realizedR, h.journal.actuals[0].realizedR);
  assert.equal(h.db.collection("nine_ai_outcome_labels").rows.length, 1);
});
test("restart immediately after accepted MARKET recovers full TP1 plan from the claim", async () => {
  const h = harness(),
    t = h.trade;
  t.entryClientId = "accepted-entry";
  t.state = "ORDER_SUBMITTING";
  await h.db.collection("trade_signal_claims").insertOne({
    signalKey: t.signalKey,
    orderClientId: t.entryClientId,
    state: t.state,
    tradeSnapshot: t,
  });
  await h.exchange.market(t, t.entryClientId);
  const l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  assert.equal([...l.active.values()][0].state, "ACTIVE");
});
test("a canceled SL is repaired without canceling TP1/TP2 or changing the original plan", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  [...h.algos.values()].find((a) => a.kind === "sl").algoStatus = "CANCELED";
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "sl").length, 2);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp2").length, 1);
});
test("post-fill slippage beyond risk budget closes instead of accepting excess exposure", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  h.exchange.entryPrice += 10;
  assert.equal(await l.enter(h.trade), false);
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 0);
});
test("DB failure before MARKET prevents entry; DB failure after entry does not disable timeout", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  const claims = h.db.collection("trade_signal_claims");
  const original = claims.insertOne;
  claims.insertOne = async () => {
    throw new Error("DB down");
  };
  assert.equal(await l.enter(h.trade), false);
  assert.equal(h.calls.filter((c) => c === "entry").length, 0);
  claims.insertOne = original;
  await l.enter(h.trade);
  h.advance(TIMEOUT_MS + 1);
  claims.find = () => {
    throw new Error("DB down");
  };
  claims.updateOne = async () => {
    throw new Error("DB down");
  };
  await l.tick();
  assert.equal(h.calls.filter((c) => c === "close").length, 1);
});
test("funding outage keeps reconciliation pending and retries without losing PnL", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("tp1");
  await l.tick();
  h.exchange.trigger("tp2");
  h.exchange.funding = async () => {
    throw new Error("funding history unavailable");
  };
  await l.tick();
  assert.equal(l.active.size, 1);
  assert.equal(h.db.collection("nine_ai_actual_outcomes").rows.length, 0);
  h.exchange.funding = async () => [];
  await l.tick();
  assert.equal(l.active.size, 0);
});
test("upgrade preserves an already-filled legacy TP1 and its original deadline", async () => {
  const h = harness();
  let l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  const collection = h.db.collection("trades"),
    saved = collection.rows[0],
    deadline = saved.deadlineAt;
  for (const kind of ["sl", "tp1", "tp2"])
    saved[kind + "OrderId"] = [...h.algos.values()].find(
      (a) => a.kind === kind,
    ).algoId;
  saved.protectionIds = {};
  saved.protectionAlgoIds = {};
  h.exchange.trigger("tp1");
  l = h.create();
  await l.initialize();
  await l.tick();
  assert.equal([...l.active.values()][0].tp1Filled, true);
  assert.equal([...l.active.values()][0].deadlineAt, deadline);
  assert.equal(h.calls.filter((c) => c === "tp1").length, 1);
  assert.equal(h.calls.filter((c) => c === "close").length, 0);
});
test("a consumed signal cannot submit a second entry after a fast exit", async () => {
  const h = harness(),
    l = h.create();
  await l.initialize();
  await l.enter(h.trade);
  h.exchange.trigger("tp2");
  assert.equal(await l.enter(h.trade), false);
  assert.equal(h.calls.filter((c) => c === "entry").length, 1);
});
