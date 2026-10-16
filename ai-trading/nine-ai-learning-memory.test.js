"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const learner = require("./nine-ai-learning-memory");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nine-ai-learn-"));
const file = path.join(dir, "state.json");
try {
  const p0 = learner.predict({trend:1,momentum:1,rsi:60,volume:1.2,extension:0.2}, learner.fresh());
  assert.strictEqual(p0.trained, false, "must not claim trained before enough closed trades");
  for (let i=0;i<25;i++) {
    const result = learner.learnClosedTrade({
      tradeId:"closed-"+i, features:{trend:1,momentum:1,rsi:60,volume:1.2,extension:0.2},
      side:"LONG", realizedR:i%3===0?-1:1, closed:true
    }, file);
    assert.strictEqual(result.updated, true);
  }
  const trained = learner.predict({trend:1,momentum:1,rsi:60,volume:1.2,extension:0.2}, learner.read(file));
  assert.strictEqual(trained.trained, true);
  assert.strictEqual(trained.samples, 25);
  assert.strictEqual(learner.learnClosedTrade({
    tradeId:"closed-24", features:{}, side:"LONG", realizedR:1, closed:true
  }, file).reason, "DUPLICATE_TRADE");
  assert.throws(() => learner.learnClosedTrade({
    tradeId:"open", features:{}, side:"LONG", realizedR:1, closed:false
  }, file), /CLOSED_TRADE_LABEL_REQUIRED/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file,"utf8")).samples,25);
  console.log("nine-ai-learning-memory tests passed");
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
