require("dotenv").config({ override: true });
const { loadConfig } = require("./src/config");
const { connectStore } = require("./src/store");
const { Exchange } = require("./src/exchange");
const { TelegramAlerts } = require("./src/telegram");
const { TradingEngine } = require("./src/engine");

async function main() {
  const config = loadConfig();
  const required = ["BINANCE_KEY", "BINANCE_SECRET", "MONGO_URI", "BOT_TOKEN", "CHAT_ID", "BOT_TOKEN_2", "AI_CHAT_ID"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error("Missing environment variables: " + missing.join(", "));
  const store = await connectStore(process.env.MONGO_URI, config.storage);
  const exchange = new Exchange(config, process.env.BINANCE_KEY, process.env.BINANCE_SECRET);
  const alerts = new TelegramAlerts();
  const engine = new TradingEngine(config, exchange, store, alerts);
  const shutdown = async (signal) => {
    console.log("[shutdown]", signal);
    await engine.stop();
    await store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await engine.start();
}
main().catch((error) => {
  console.error("[fatal]", error?.stack || error);
  process.exit(1);
});
