# Deploying the Nine-AI flow

Use Node.js 22 or newer, the existing MongoDB trading database and Binance USDT single-asset One-way Mode. The bot validates account mode. Keep the existing .env containing MONGO_URI, BINANCE_KEY and BINANCE_SECRET. BOT_TOKEN/CHAT_ID and optional BOT_TOKEN_2/AI_CHAT_ID handle Telegram reporting; Telegram does not control position protection.

Stop the old bot process. Inside the repo on main:

    git pull --ff-only origin main && npm ci --ignore-scripts && npm start

If an existing supervisor runs the bot, restart through that supervisor instead of launching a second process with npm start. Run only one managed bot against this account/database. The PID lock is local to the checkout, not a cross-host distributed lock.

No manual migration or initial model upload is needed. Version-5 journal keys/indexes prevent older cached decisions from restoring outdated expectation/exit/cost definitions. Earlier champion parameters are preserved for audit while current defaults initialize the new contract. Real labeled excursion data remains useful. Open positions restore their original saved protection and deadline.

With no winning excursion labels, AI-2 supplies temporary structure exits. AI-9 still applies its normal edge/cost/uncertainty rule. Once a usable winning label exists for the setup, AI-7 uses winning MAE p80 and all-labeled MFE p50/p90 without an additional symbol/side or winning-count requirement. Realized gross R supplies directional setup E[R] when available. Entry messages identify AI2_INITIAL versus AI7_LABELED. Zero measured MAE cannot be silently widened into a substitute ATR/structure stop.

Scanning considers trading USDT perpetual contracts without added turnover, daily-range, stablecoin or top-80 strategy filters. The scanner checks every two minutes and saves one decision per symbol/closed 4h candle. All strategy candles use 4h; the 20/90-day volatility windows are calculated from those 4h bars. Staleness increases uncertainty rather than triggering an independent five-minute execution cutoff. Signed API failures, missing required prices/costs, unsupported quantity or unresolved position state remain technical execution failures, not alternate trading signals.

Every approved symbol is considered; no fixed maximum position count, top-ten signal cutoff or one-entry-per-scan cap is imposed. Legacy MAX_ACTIVE_POSITIONS is no longer used. Exchange balance and order constraints still apply. Fee/slippage forecasts are nonnegative; funding preserves payment/receipt signs. Calibration uses predicted_R before uncertainty, not the penalized edge.

Inspect NINE-AI READY, NINE-AI SCAN, ENTRY WAIT, position protection/accounting and DAILY CALIBRATION logs. Missing MAE/MFE history stays pending and retries instead of losing the first outcome label. Development tests use fake exchange/database responses and submit no live orders. Sources and measurement precision are documented in NINE_AI_CANONICAL_PIPELINE.md; the requirement audit is NINE_AI_SPEC_AUDIT.md.
