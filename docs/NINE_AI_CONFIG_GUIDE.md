# NINE-AI — Operational Configuration

The **only editable runtime/strategy parameter source** is `CONFIG.yaml`.
Change one key at a time, validate with `npm test`, then restart the service
under operator supervision. Editing a file does **not** hot-reload the bot.

## What belongs where

- `CONFIG.yaml`: trading strategy/risk thresholds; Binance request timeouts,
  GET retry/backoff, request-weight budget, metadata cache, ambiguous-order
  *lookup* retries, position reconciliation timing, paginated accounting;
  market WebSocket heartbeat/reconnect/freshness; Telegram delivery retries,
  HTTP timeout and sent-message TTL; MongoDB retention cleanup mode/limits,
  decision-journal cache, write retries and expired-claim TTL.
- `.env`: Mongo connection URI, Binance API key/secret, Telegram credentials,
  chat IDs, and **emergency-only** `DB_RETENTION_ENABLE_DELETE=false` /
  `DB_RETENTION_DRY_RUN=true`. The emergency flags may only **disable**
  deletion or **force a dry run**; they cannot bypass a disabled cleanup mode
  in `CONFIG.yaml`.

The YAML parser intentionally accepts only a restricted flat syntax: numeric
values, quoted timeframe, numeric `TP_BATCHES` array, and literal
`true`/`false` for the two retention flags. All keys are required, unknown
or duplicate keys abort, numeric settings cannot be negative or zero,
operational knobs must satisfy explicit bounds, integer fields must remain
integers, and cross-field checks reject inconsistent thresholds. The bot
refuses startup instead of silently guessing parameters or clamping values.

**Do not change code-level invariants** (Binance signed-request rules, stable
schema versions, deduplication IDs, one-way positions, exchange pagination
protocol, 4h-only strategy contract, STOP/TP fail-closed protections) by adding
unvalidated YAML knobs. `TIMEFRAME` and `BAR_HOURS` must remain 4h/4.
`EQUITY_START` is legacy data and **does not set** the live drawdown baseline.
Bot-session drawdown state is durable in MongoDB and does not reset on restart.

## Examples

```yaml
RISK_PER_TRADE: 0.01
MAX_DRAWDOWN_CIRCUIT: 0.15
SCAN_INTERVAL_MS: 120000
BINANCE_HTTP_TIMEOUT_MS: 15000
BINANCE_HTTP_GET_ATTEMPTS: 2
MARKET_WS_HEARTBEAT_MS: 30000
MARKET_WS_STALE_MS: 90000
TELEGRAM_DELIVERY_TIMEOUT_MS: 10000
TELEGRAM_DELIVERY_RETRY_MAX_MS: 300000
JOURNAL_WRITE_MAX_ATTEMPTS: 3
RETENTION_ENABLE_DELETE: true
RETENTION_DRY_RUN: false
```

Example invalid edits, all rejected: `MAX_DRAWDOWN_CIRCUIT: 1.5`,
`BINANCE_HTTP_GET_ATTEMPTS: 999`, `RETENTION_DRY_RUN: yes`, heartbeat
`>=` stale threshold, or minimum daily risk lower than per-trade risk.
`npm test` executes the full parser and strategy regression suite.

## TTL changes

Modifying `TELEGRAM_SENT_RETENTION_DAYS` or
`TRADE_CLOSED_CLAIMS_RETENTION_DAYS` updates an existing MongoDB TTL index
using `collMod` when required. MongoDB must permit `collMod`; failure
blocks startup rather than running with an unexpected older TTL. Pending
notifications and open/uncertain trade claims never have the terminal
expiration timestamp and are not eligible for these TTL rules.

## Deployment safety

Before restart: verify live exchange positions, active SL/TP and exit
reconciliation, and take a MongoDB backup. Deploy `main`, run `npm ci
--ignore-scripts && npm test`, then restart **one** `nine-ai-quant` process;
observe systemd and risk logs. If config validation fails, stop and correct
the YAML, do not bypass a circuit breaker to force trading. A green CI run
does not certify real Binance connectivity or eliminate market risk.
