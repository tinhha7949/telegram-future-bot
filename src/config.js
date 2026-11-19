"use strict";
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

function loadConfig(file = path.join(process.cwd(), "config.yml")) {
  const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  validateConfig(parsed);
  return parsed;
}
function validateConfig(c) {
  const required = [
    ["scanner.maxCoins", c.scanner?.maxCoins, 1, 200],
    ["scanner.batchSize", c.scanner?.batchSize, 1, 50],
    ["scanner.batchDelayMs", c.scanner?.batchDelayMs, 0, 60000],
    ["strategy.emaPeriod", c.strategy?.emaPeriod, 2, 500],
    ["strategy.rsiPeriod", c.strategy?.rsiPeriod, 2, 100],
    ["strategy.signalCheckIntervalSeconds", c.strategy?.signalCheckIntervalSeconds, 10, 300],
    ["strategy.confirmationCandles", c.strategy?.confirmationCandles, 1, 20],
    ["risk.walletPercentPerTrade", c.risk?.walletPercentPerTrade, 0.01, 100],
    ["risk.maxActivePositions", c.risk?.maxActivePositions, 1, 200],
    ["binance.leverage", c.binance?.leverage, 1, 125],
    ["strategy.tp1ClosePct", c.strategy?.tp1ClosePct, 1, 99]
  ];
  for (const [name, value, min, max] of required) {
    if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new Error("Invalid config value " + name + ": expected " + min + ".." + max);
    }
  }
  for (const key of ["trendTimeframe", "entryTimeframe"]) {
    if (typeof c.strategy[key] !== "string" || !/^\d+[mhdw]$/.test(c.strategy[key])) {
      throw new Error("Invalid timeframe: strategy." + key);
    }
  }
  if (c.strategy.rsiLongTrigger >= c.strategy.rsiShortTrigger) throw new Error("RSI long trigger must be below short trigger");
  if (c.strategy.rewardRiskTp1 <= 0 || c.strategy.rewardRiskTp2 <= c.strategy.rewardRiskTp1) {
    throw new Error("TP2 RR must be greater than TP1 RR and both must be positive");
  }
  if (c.strategy.slBufferPct < 0 || c.strategy.breakevenOffsetPct < 0) throw new Error("SL/BE percentages cannot be negative");
  return true;
}
module.exports = { loadConfig, validateConfig };
