# Simple Binance USDT Futures Bot

The live strategy is intentionally small:
- Closed 4h candle close above EMA100: uptrend; only LONG entries are allowed when closed 1m RSI(14) is at or below 25.
- Closed 4h candle close below EMA100: downtrend; only SHORT entries are allowed when closed 1m RSI(14) is at or above 75.
- SL distance uses 1m ATR(14) multiplied by a configurable factor and bounded by configured percentage limits. TP is derived from the configured reward/risk ratio (default 1.3).
- The symbol universe filters USDT perpetuals by 5m quote volume, 24h quote volume and 24h range, then keeps up to 100.
- MongoDB persists each signal/trade. Before an entry, the bot checks live Binance positions and existing conditional orders. Existing exchange positions are never stacked.
- Positions older than 24 hours are market-closed; the bot retries and reconciles against the exchange until closure is observed.
- /status reports tracked and exchange positions in Telegram.

## Setup
1. Use Node.js 22 or newer.
2. Set MONGO_URI, BINANCE_KEY, BINANCE_SECRET, and optionally BOT_TOKEN/CHAT_ID in the VPS .env.
3. Adjust strategy and risk parameters only in CONFIG.yaml.
4. Run npm ci, then npm start.

The bot requires Binance USDⓈ-M Futures One-way position mode. It refuses to start in Hedge Mode. Keep API withdrawals disabled and test with small size first.
