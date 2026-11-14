"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadEnv(file = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadConfig() {
  const configPath = path.resolve(process.env.CONFIG_PATH || "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.database.name = process.env.MONGO_DB_NAME || config.database.name;
  config.maxNewsPerCategory = Math.max(1, Number(config.maxNewsPerCategory) || 25);
  config.newsPollMinutes = Math.max(2, Number(config.newsPollMinutes) || 10);
  config.marketPollMinutes = Math.max(5, Number(config.marketPollMinutes) || 15);
  return config;
}

module.exports = { loadConfig, loadEnv };
