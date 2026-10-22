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

On a new database, daily output reads:

    DAILY CALIBRATION NO_REALIZED_PREDICTION_PAIRS samples=0 | CANDIDATE COLLECTING_MATURED_24_BAR_OPPORTUNITIES | SHADOW NO_SHADOW_CANDIDATE

These are idle learning states: no completed forecast/outcome pairs, no matured evaluation cohort, and no shadow candidate yet. Missing averages remain null in stored reports, rather than being invented as zero; the console omits those unavailable averages. This daily report does not pause live decisions or require a trade count to unlock initial AI-2 exits. NINE-AI SCAN START reports the universe and label counts; the completed scan reports signal counts and WAIT reasons. NINE-AI SCAN PAUSED identifies an actual runtime or position-state pause separately. A newly qualified candidate reports SHADOW_STARTED immediately; subsequent runs report its current shadow status.

## Binance request limits and live data

Position exits now clean up SL/TP siblings as soon as a fresh exchange snapshot confirms the symbol is flat, before requesting fills, funding, fee conversion, MAE/MFE candles or database writes. All already-flat trades are cleaned before accounting begins for any one trade. A failed cancellation remains pending and pauses new entries until reconciliation succeeds. With the normal ten-second management loop this happens on the next successful management pass; exchange/network cooldowns can delay confirmation. A completed TP1 realizes half of the original filled quantity; SL/TP2 remain exchange-side for the remainder. This does not add a break-even/trailing-stop rule.

Startup also removes identifiable orphan Nine-AI conditional orders on flat symbols; unrelated orders and symbols with exposure are excluded from that orphan sweep. Triggered regular child orders belonging to a tracked closed trade are canceled too. Closed accounting remains retryable and cannot keep TP2 alive or create a fabricated learning label. A closed, cleaned trade awaiting accounting does not by itself mark live exposure uncertain.

All Binance time parameters are integer milliseconds, including legacy fractional submittedAt values. Restart preserves pending closes and existing deadlines. AI-2 structure target prices remain at their planned zones after entry slippage; AI-7 levels still derive from the real fill and the specified quantiles. Risk remains the user-editable RISK_PER_TRADE in index.js; this fix does not modify it. See [the lifecycle audit](NINE_AI_LIFECYCLE_FIXES.md) for regression coverage and API references.

Mark price/funding and bid/ask updates use the public all-market WebSocket streams. A disconnected or stale stream falls back to a budgeted REST refresh; it is not relabeled as a fresh observation. Current depth remains REST, OI history uses its existing 4h period, and private account/order reconciliation still uses REST. No new strategy timeframe or entry filter is added.

All requests share the exchange client's weighted IP budget: at most 1800 local weight/minute by default, reduced if exchangeInfo advertises a lower limit. Background requests stop at 80% of that budget to reserve capacity for account/protection/close requests. Used-weight response headers account for other traffic visible to Binance. Statistics routes additionally stay below 800 requests/5min. HTTP 429/418 and code -1003 establish a shared cooldown using Retry-After/ban-until when available; the bot does not retry every second against the exchange. Existing exchange-side SL/TP orders remain in place during a cooldown.

History loads share one in-flight request per symbol. Initial 1500-bar history is paginated efficiently; subsequent 4h windows update the existing history. Scans check the durable decision for the expected closed 4h bar before any candle REST request, so repeat scans of an already-journaled bar use no REST candle probe. Daily settlement shares the same history cache. Exchange metadata loads are also coalesced; cached data keeps its original observation time. Signed timestamps and network latency are measured at dispatch, after queue admission.

First startup may take longer while the entire universe warms its history under the request budget. NINE-AI SCAN PROGRESS reports progress every 50 symbols. BINANCE MARKET WS reports successful stream connections; BINANCE REST COOLDOWN reports the enforced wait. Rate-limited GET requests remain paused/retry after the shared cooldown, including during initialization, instead of exhausting two quick retries and triggering a PM2 restart loop. Mutating order requests are never blindly repeated. Shutdown cancels queued admission. The budget controls this bot's traffic and reacts to IP usage headers; unrelated processes sharing the IP can still consume the exchange allowance. Restarting does not bypass a Binance-imposed IP cooldown.

References: [Binance rate limits](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info), [REST endpoint weights](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data), [mark-price streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market), [book-ticker streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public).
