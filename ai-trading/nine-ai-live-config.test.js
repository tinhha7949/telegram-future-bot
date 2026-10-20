"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
assert.match(source, /require\(["']dotenv["']\)\.config\(\);\s*\r?\n\s*\/\/ Fixed Nine-AI risk: 0\.75% of equity per trade\. Never override from \.env\.\s*\r?\n\s*const RISK_PER_TRADE = 0\.0075;/,
  "dotenv must load before configuration and per-trade risk must be fixed at 0.75%");
assert.equal((source.match(/const RISK_PER_TRADE\s*=/g) || []).length, 1,
  "there must be exactly one authoritative risk constant");
assert.match(source, /riskPerTrade:\s*RISK_PER_TRADE,\s*\r?\n\s*maxRiskPerTrade:\s*RISK_PER_TRADE/,
  "risk and maximum risk must both use the same fixed value");
console.log("NINE-AI LIVE CONFIG TESTS PASSED");
