# VPS deployment: Nine-AI canonical bot

## Requirements
- Linux VPS with Node.js 22 (see `.nvmrc`)
- MongoDB reachable from the VPS
- Binance USD-M Futures API key with trading permission, IP-restricted to the VPS, and withdrawals disabled
- Telegram bot token and destination chat ID

## First installation
```bash
git clone https://github.com/tinhha7949/telegram-future-bot.git
cd telegram-future-bot
cp .env.example .env
nano .env
npm install
npm test
```

Fill in the real values for `MONGO_URI`, `BINANCE_KEY`, `BINANCE_SECRET`, `BOT_TOKEN`, and `CHAT_ID` in `.env`. Keep `.env` private and never commit it. Optional Telegram destinations may be left blank.

## Start and monitor
```bash
npm start
```

Keep the process under your existing supervisor (systemd/PM2) only after the first foreground run passes startup checks. Review startup logs for MongoDB READY, time synchronization, decision-journal initialization, offline-learning initialization, and the liquidation WebSocket. If required data is unavailable, the canonical strategy should emit WAIT rather than invent missing inputs.

## Updating
For future updates after this release:
```bash
git switch main
git pull --ff-only origin main
npm install
npm test
```

Before restarting an existing live bot, verify the exchange has no unprotected position. The process uses a local PID lock, but that does not protect against a second copy on another VPS.

## Fixed risk and strategy
- To change per-trade risk, manually edit the numeric literal in `index.js`: `const RISK_PER_TRADE = 0.0075` means 0.75% of equity. For example, `0.01` means 1%. Both risk limits use this constant; `.env` does not override it. Run `npm test` after editing.
- The decision cycle uses closed 4-hour candles and requires about 90 days of 4-hour history plus closed 1-hour and 1-day context.
- New entries default to WAIT when market inputs, liquidation confirmation, outcome distributions, or exchange protection are unavailable.
- The initial champion policy can trade when the Nine-AI entry contract passes. Candidate policies cannot replace the champion until the same-opportunity/cost walk-forward test passes and a 14-day shadow period beats the champion.
- Do not treat passing unit tests as proof of profitability. Start with a small, explicitly risked account and inspect fills, funding, SL/TP orders, and daily calibration before increasing exposure.
