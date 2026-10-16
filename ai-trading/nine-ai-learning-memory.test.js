"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const learner = require("./nine-ai-learning-memory");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nine-ai-learn-"));
const file = path.join(dir, "state.json");
const features = { trend: 1, momentum: 1, rsi: 60, volume: 1.2, extension: 0.2 };
try {
  const p0 = learner.predict(features, learner.fresh());
  assert.equal(p0.trained, false, "must not claim trained before enough closed trades");

  learner.rememberDecision({ id: "closed-0", action: "LONG", features }, file);
  const first = learner.learnClosedTrade({
    tradeId: "closed-0", features, side: "LONG", realizedR: 1, closed: true
  }, file);
  assert.equal(first.updated, true, "pending decision must be trainable after it closes");

  for (let i = 1; i < 25; i++) {
    const result = learner.learnClosedTrade({
      tradeId: "closed-" + i, features, side: "LONG", realizedR: i % 3 === 0 ? -1 : 1, closed: true
    }, file);
    assert.equal(result.updated, true);
  }

  const trained = learner.predict(features, learner.read(file));
  assert.equal(trained.trained, true);
  assert.equal(trained.samples, 25);
  assert.equal(learner.learnClosedTrade({
    tradeId: "closed-24", features: {}, side: "LONG", realizedR: 1, closed: true
  }, file).reason, "DUPLICATE_TRADE");
  assert.throws(() => learner.learnClosedTrade({
    tradeId: "open", features: {}, side: "LONG", realizedR: 1, closed: false
  }, file), /CLOSED_TRADE_LABEL_REQUIRED/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).samples, 25);
  console.log("PASS: local online learner trains only once per closed trade and persists safely");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
