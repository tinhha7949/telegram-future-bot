# Nine-AI canonical trading pipeline

This branch keeps one live decision authority: `ai-trading/nine-ai-pipeline.js`. The rest of the application is execution, persistence, exchange protection, and offline evaluation. Legacy competing strategy/research modules were removed from the runtime and repository.

## Live decision cadence

- Scan only a fully closed 4-hour candle and record at most one decision per symbol and candle.
- Require 4-hour history sufficient for the 90-day realized-volatility window, plus closed 1-hour and 1-day context. Missing required data means `WAIT`.
- AI-1 classifies `UPTREND`, `DOWNTREND`, `RANGE`, or `HIGH_VOL` from multi-timeframe momentum and 20/90-day realized volatility.
- AI-2 extracts fractal swing highs/lows and support/resistance for structure and stop placement.
- AI-3 evaluates trend pullback continuation. AI-4 evaluates range breakouts with volume expansion, hold, spread, and extension guards. AI-5 evaluates VWAP deviation only in range/high-volatility conditions. They cannot bypass the final regime gate.
- AI-6 reads funding, OI change, and Binance force-order liquidation imbalance. It is confirmation/blocking evidence, never an independent direction generator. Hot funding or missing required market data blocks a trade.
- AI-7 estimates p80 MAE and p50/p90 MFE from labeled outcomes. Cold-start historical bootstrap samples use the same trend-pullback/breakout entry rules, only after the full 24-candle outcome window has matured. Historical simulations remain explicitly tagged and separate from realized trade outcomes.
- AI-8 estimates slippage from depth, spread, OI change, and API latency. The exact fee/funding/slippage snapshot is saved with the decision and used in forward opportunity evaluations.
- AI-9 compares net edge for both sides, subtracts cost and uncertainty, applies the minimum-edge and direction-gap thresholds, and emits exactly one `LONG`, `SHORT`, or `WAIT`.

## Risk and exits

- Fixed risk budget: `RISK_PER_TRADE = 0.0075` at the top of `index.js`, equal to 0.75% of equity per trade. No martingale or risk escalation.
- Stop distance uses the p80 adverse-movement quantile with a structure-zone buffer.
- TP1 uses p50 MFE and closes 50% of the actual filled position; TP2 uses p90 MFE for the remainder.
- A still-open `NINE_AI_4H` position is closed after 24 four-hour bars (96 hours).
- Exchange order IDs and realized gross PnL, fees, funding, slippage, MAE, MFE, and net R are persisted for reconciliation and learning.

## Daily offline learning

- Every closed trade is saved as a point-in-time feature snapshot plus its realized accounting outcome.
- Daily calibration reports compare predicted net edge with realized net R. Calibration is diagnostic and does not blindly tune live parameters.
- Candidate policies are evaluated on the same matured 24-bar opportunity set and the same per-opportunity cost snapshot. Walk-forward train/validation/test splits use a 24-bar purge/embargo.
- A candidate must beat the champion on the held-out test set, then remain in shadow for at least 14 days. Only then can the candidate become champion; the champion controls only the min-edge/gap thresholds. If evidence is insufficient or the shadow result does not beat the champion, no promotion occurs.

## Safety behavior

Missing/stale inputs, insufficient 90-day history, missing multi-timeframe candles, unavailable liquidation data, invalid exit geometry, or insufficient outcome samples produce `WAIT`. The system does not invent liquidation values or MAE/MFE quantiles. This is intentionally conservative during cold start.
