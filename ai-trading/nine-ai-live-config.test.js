"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");

assert.match(source, /require\(["']dotenv["']\)\.config\(\);\s*\r?\n\s*\/\/ Manually tune per-trade equity risk here\. Use a fraction: 0\.0075 = 0\.75%\.\s*\r?\n\s*const RISK_PER_TRADE = (\d+(?:\.\d+)?);/,
  "risk must remain a manually editable numeric constant in index.js");
const riskMatch = source.match(/const RISK_PER_TRADE\s*=\s*(\d+(?:\.\d+)?);/);
assert.ok(riskMatch, "RISK_PER_TRADE must be a numeric literal so it can be edited by hand");
const riskPerTrade = Number(riskMatch[1]);
assert.ok(Number.isFinite(riskPerTrade) && riskPerTrade > 0 && riskPerTrade <= 1,
  "manually configured risk must be a fraction greater than 0 and no more than 1");
assert.equal((source.match(/const RISK_PER_TRADE\s*=/g) || []).length, 1,
  "there must be exactly one authoritative risk constant");
assert.match(source, /riskPerTrade:\s*RISK_PER_TRADE,\s*\r?\n\s*maxRiskPerTrade:\s*RISK_PER_TRADE/,
  "risk and maximum risk must both use the manually configured constant");
assert.doesNotMatch(source, /envNumber\(\s*["'](?:RISK_PER_TRADE|MAX_RISK_PER_TRADE)["']/,
  "environment variables must not override the manual risk constant");
console.log("NINE-AI LIVE CONFIG TESTS PASSED");
