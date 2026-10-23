# Nine-AI futures engine — installation & operating contract

This repository implements one closed-4h Nine-AI decision authority. It **does not guarantee profits, loss limits on gaps, or risk-free trading**. The repository tests simulate orders; a green unit suite is not Binance production certification.

## Configuration
Only `CONFIG.yaml` owns strategy/risk/retention thresholds. `.env` supplies secrets and endpoints (`MONGO_URI`, `BINANCE_KEY`, `BINANCE_SECRET` and optional Telegram IDs). Startup rejects missing credentials. The exchange account must be USDT single-asset, one-way and have sufficient available balance. The bot never increases position size to recover losses.

`N_CANDLES=500` caps each symbol's float32/delta/gzip OHLCV archive in `nine_ai_ohlcv_4h`. Live realized volatility over 90 days needs 540 four-hour returns, so feed fetches at least **541 closed bars** for analysis without retaining all of them in the archive.

`COLD_START_SAMPLES=50` and the detailed 100-label requirement conflict; the implementation keeps both keys and uses **AI7_ACTIVATION_SAMPLES=100** as the explicit quantile activation threshold. Under 100 realized, unique, setup/direction-matched labels, SL uses 1.5×ATR14, TP1 is at least 0.8R and risk remains 1% of equity. From 100, AI7 derives MAE p80 and MFE p50/p90, respecting the minimum TP1 RR. TP1 exits 60%, TP2 exits 40%; SL protects the entire remaining position. Exchange quantity/tick rounding is revalidated after an actual fill.

The trend-only live filter makes range/high-vol AI5 diagnostic, not an alternative way around AI9. Funding hot checks and uncertainty result in WAIT. All real order submissions pass the sole central AI9 authorization boundary plus current market/position, available margin, daily risk, drawdown and memory gates.

## Install and automatic operation on a systemd VPS
With Node.js 22+, MongoDB, correct Binance futures permissions and a `.env` file present:

```bash
git pull --ff-only
npm ci --ignore-scripts
npm run install:service
```

The last command installs and **enables/starts** `nine-ai-quant.service`. systemd restarts it on failure and after reboots, without any daily approval. Installing dependencies by itself does not silently execute leveraged trades; service install is the deliberate single setup step. Do not run `npm start` in parallel with the service. A local PID lock prevents duplicate instances on one host; the durable DB claims and client order IDs provide extra idempotency but do **not** replace single-host deployment discipline.

```bash
systemctl status nine-ai-quant
journalctl -u nine-ai-quant -f
npm test
```

## Circuit breakers and model promotion
Risk reservations are persisted before any market POST, use 1% equity per signal and a 2.5%-of-start-of-day-equity UTC budget; ambiguous submissions never refund capacity automatically. Drawdown of 15% versus the higher of configured starting equity/observed peak **latches** new-entry shutdown across restart. Existing positions still receive SL/TP/timeout management. Reset of the risk latch requires review of account and market conditions; the system intentionally has no silent self-reset.

The 500 MB storage circuit first executes allowlisted, priority-ordered cleanup and rechecks storage. If still over limit or measurement unavailable, new entries WAIT without stopping exit management. Raw/ticks and old derived features have priority over models/research, which have priority over closed trades and actual labels. Labels remain last resort; no unreviewed collections or active policies are deleted.

Daily candidate fitting evaluates the identical opportunity cohort and cost snapshot, using walk-forward purge/embargo. Candidates can only **raise** MIN_EDGE above 0.15. An actual 14-day shadow period with matured observations and trade-positive improvement is required for **automatic champion promotion**, with no human approval. Calibration drift degrades confidence/causes abstention rather than blind fitting.

## Boundaries and validation
Run the recursive syntax+unit suite `npm test` (including nested data/risk tests) before upgrades. Current tests rely on mocked Binance and Mongo responses. The exact live OCO capabilities, exchange-specific algo order parameters, VPS secrets and upstream network behavior cannot be validated from GitHub CI alone. To protect capital, malformed/stale data, ambiguous fills, unavailable Mongo/account/capacity state, or uncertain untracked positions cause WAIT. No software can prevent gap slippage, forced liquidation, outages or market losses.

See `CONFIG.yaml`, `ai-trading/risk/`, `ai-trading/data/store/ohlcv.js`, `ai-trading/binance-execution.js`, `ai-trading/trade-lifecycle.js`, `ai-trading/nine-ai-pipeline.js`, and `ai-trading/nine-ai-offline-learning.js`.
