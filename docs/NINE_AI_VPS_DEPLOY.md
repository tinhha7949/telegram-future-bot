# Deploying the Nine-AI flow

Use Node.js 22 and a reachable MongoDB database. The bot requires a Binance USDT single-asset account in One-way Mode; it validates mode before starting. No account mode or leverage setting is changed automatically.

## Install and check

```sh
cp .env.example .env
# Fill your own required values in .env.
npm ci --ignore-scripts
npm test
```

Required environment variables: MONGO_URI, BINANCE_KEY and BINANCE_SECRET. Telegram BOT_TOKEN/CHAT_ID are optional for command/status reporting. BOT_TOKEN_2/AI_CHAT_ID may route trade reports to a second destination. Telegram outages do not block position management.

Only the numeric RISK_PER_TRADE literal at the top of index.js controls per-trade equity risk. MAX_ACTIVE_POSITIONS controls the simultaneous position cap. ROUND_TRIP_FEE_PCT is an execution-cost estimate in percentage points. The .env file never overrides the manual risk literal.

## First start / upgrade

Review existing exchange positions and saved pending trades before replacing a running deployment. Preserve the MongoDB trading database and existing claims. The startup migration removes createdAt-based claim TTL indexes and expires only reconciled closed claims, so pending/ambiguous orders are not forgotten.

The migration adds a partial unique index for one version-2 decision per symbol/candle and a partial unique trade signal key. Pending legacy Nine-AI records with an existing Mongo ID are updated in place. Incomplete or unrecognized positions block new entries or take the explicitly logged protection/close path; no missing strategy plan is invented.

```sh
npm start
```

Run only one managed process against this account/database. A local PID lock prevents the same checkout from starting twice; it is not a cross-host account lock. Inspect NINE-AI READY, position reconciliation/protection logs, ENTRY WAIT reasons, and DAILY CALIBRATION. Use the existing supervisor only after startup checks succeed. A restart halfway through a 4h candle waits for the next fresh decision window.

## What verification covers

Tests cover LONG/SHORT/WAIT, missing/stale inputs, flow vetoes, one shared live/offline policy, risk after tick rounding/fill, exact half quantities, lost MARKET responses, restart recovery, TP1 idempotency, canceled-stop repair, timeout during DB failure, fill/funding accounting, matured 24-bar opportunities, purge/embargo and shadow promotion timing. They use fake exchange/database responses and do not submit live orders.

No production credentials, MongoDB instance, Binance account or VPS was used during implementation. Production API permissions, network/rate limits and real fills still require deployment verification. Fee conversion and MAE/MFE measurement precision are documented in NINE_AI_CANONICAL_PIPELINE.md. A passing test suite is not a profitability result.

Cold start requires real labeled outcomes. If those are absent, WAIT is the expected result. The bot does not fabricate historical winners, silently turn on a paper portfolio, or bypass the outcome contract to force a first trade.

## API references

- [Binance USD-M trade endpoints](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade): conditional orders, actual child order IDs and account trade pagination.
- [Binance market-data endpoints](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data): klines, premium/funding inputs and adjusted funding intervals.
