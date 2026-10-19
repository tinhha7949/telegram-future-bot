"use strict";

const assert = require("node:assert/strict");
const { decideFenixBootstrap, dualHorizonReport, qabbaProxyReport, visualProxyReport } = require("./nine-ai-fenix-bootstrap");

function makeCandles(n, direction = 1) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const o = price;
    price += direction * 0.8;
    const c = price;
    candles.push([i * 900000, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c, 100 + i]);
  }
  return candles.map(row => ({ openTime: row[0], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }));
}
const up = makeCandles(100, 1);
const down = makeCandles(100, -1);
const features = {
  valid: true, trend: "UP", mom4: 0.02, mom12: 0.06, atrPct: 0.01, atr: 1,
  macdHistogram: 0.5, rsi: 65, breakoutStrength: 0.5, candleBodyRatio: 0.7,
  structureTrend: "HIGHER_HIGHS_LOWS", volumeRatio: 1.5, bullishEngulfing: false,
  bearishEngulfing: false, lowerWickRatio: 0.05, upperWickRatio: 0.05,
  falseBreakoutRisk: 0, insideBar: false
};
const long = decideFenixBootstrap(up, features);
assert.equal(long.source, "FENIXAI_BOOTSTRAP");
assert.equal(long.side, "LONG");
assert.ok(long.reports.technical);
assert.ok(long.reports.qabba);
assert.ok(long.reports.visual);
assert.ok(long.reports.dualHorizon);
const short = decideFenixBootstrap(down, { ...features, trend: "DOWN", mom4: -0.02, mom12: -0.06,
  macdHistogram: -0.5, rsi: 35, breakoutStrength: -0.5, candleBodyRatio: -0.7,
  structureTrend: "LOWER_HIGHS_LOWS" });
assert.equal(short.side, "SHORT");
assert.equal(dualHorizonReport(up, features).side, "LONG");
assert.ok(qabbaProxyReport(up, features).score > 0);
assert.ok(visualProxyReport(up, features).confidence >= 0.35);
assert.equal(decideFenixBootstrap(up.slice(0, 20), features).side, null);
console.log("FenixAI multi-component bootstrap tests passed");
