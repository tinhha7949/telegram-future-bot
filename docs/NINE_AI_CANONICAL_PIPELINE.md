# Nine-AI canonical flow

The live path is index.js → nine-ai-pipeline.js → nine-ai-policy.js → central invariant checks → execution validation → TradeLifecycle. The same policy function is used by live decisions, cached decisions, candidate evaluation and shadow evaluation. Only AI-9 selects LONG, SHORT or WAIT. Exchange protection can reject/close unsafe exposure, but cannot invent a trading direction.

## Inputs and responsibilities

1. **Regime:** closed 4h OHLCV spanning at least 90 days (541 contiguous bars), plus closed 1h/day context; 20/90-day realized volatility, volatility percentile and momentum agreeing across timeframes. Outputs regime and confidence in [0,1]. Missing/stale/gapped context means WAIT.
2. **Structure:** confirmed fractal highs/lows, channel slopes, support/resistance and directional bias. Right-hand fractal bars must already be closed. The structure buffer can move the initial stop beyond support/resistance.
3. **Continuation:** a pullback in earlier bars, then a completed confirming impulse in the trend direction, increasing OI and non-hot funding. Probability comes from labeled outcomes, not a fixed invented success rate.
4. **Breakout:** range break in the matching trend, volume expansion, a held level, acceptable spread and an extension guard. Outputs a labeled probability when the setup is active.
5. **Mean reversion:** VWAP deviation plus liquidation evidence, enabled only in RANGE/HIGH_VOL. Its diagnostic output cannot bypass the final trend gate: the requested live loop trades only UPTREND/DOWNTREND.
6. **Flow:** funding, OI change and observed liquidation imbalance. Confirms or blocks a model's direction; never creates a direction. Missing flow or hot funding means WAIT. The liquidation socket has a heartbeat and reconnect handling.
7. **Outcome:** deduplicated, matured REALIZED_CLOSED_TRADE labels for the same symbol, regime/setup and side. Wins and losses estimate probability using a Beta(2,2) prior. Winning MAE/MFE quantiles have no minimum-trade-count gate. An empty winning set has undefined quantiles; missing data is not replaced with invented SL/TP values. Historical price excursions are not relabeled as actual trading wins.
8. **Fill/slippage:** a transparent heuristic using depth, spread, OI change and measured request latency, returning a round-trip slippage estimate and estimated fill price per side. This is an estimate, not a claim of a trained fill model or a guaranteed fill.
9. **Meta:** applies the formula below once, compares both directions and returns one action. E[R|success] uses the 50/50 quantile exit payoff, optionally blended with the matching realized winning gross-R track record. Calibration remains a diagnostic; it does not silently alter live parameters.

## The single decision formula

edge(a) = p(a) × E[R | a, regime] − cost(a) − uncertainty_penalty

cost(a) = fee + funding(a) + round-trip slippage

All costs are converted to R using the same side's entry-to-initial-stop distance. Funding uses the symbol's funding interval over the maximum 96h hold, charges the paying side and does not assume uncertain future funding receipts as profit. Original fee/funding/slippage inputs and normalized costs are preserved.

The uncertainty penalty increases with lower regime confidence, aging input data and similar directional edges. Data older than five minutes is rejected. LONG requires its edge > minEdge and LONG edge − SHORT edge > gapEdge; SHORT is symmetric. Missing estimates for an active setup mean WAIT. A side with no active setup has p=0 and eligible=false; it remains a finite comparison alternative but cannot execute. This distinction removes the old deadlock requiring two simultaneous opposing setups.

## Cadence and point-in-time snapshots

Each closed 4h candle has at most one durable version-2 decision per symbol, enforced by a partial unique MongoDB index. Market data observed shortly after the close is timestamped honestly at observation time; it is not backdated to the candle close. Decisions older than five minutes cannot execute. Starting midway through a candle therefore waits for the next decision window.

An authorized but unclaimed decision may be reused only within that window. It passes the same central checks and a fresh execution check for flow, funding, cost/uncertainty and price geometry before MARKET. The original decision snapshot stays immutable; the fresh validation snapshot is stored separately.

## Risk and exits

- RISK_PER_TRADE is the single manually editable numeric literal at the top of index.js. Its supplied value is 0.0075. Environment variables and learned policies do not override it.
- Sizing uses current USDT equity, including unrealized PnL, and the actual tick-rounded stop distance. Quantity is rounded down to an even number of valid exchange lots so TP1 can close exactly 50%; exchange size limits still apply. Leverage/margin configuration is left with the account; an insufficient-margin rejection does not increase risk or retry a different size.
- Initial SL is winning MAE p80 plus a structure-zone buffer. TP1 is winning MFE p50, TP2 winning MFE p90. No independent minimum-RR filter or martingale is added.
- After the actual fill, keep the researched stop and shift target distances to the actual entry. Recalculate monetary risk from filled quantity and the rounded stop. Excess risk, invalid geometry or an unrepresentable 50% split triggers a reduce-only close rather than acceptance of extra exposure.
- TP1 reduces exactly half of the original filled quantity; TP2 and SL close remaining exposure. Confirm a triggered TP1's actual child order before treating it as filled. Do not re-arm TP1 after a partial exit/restart.
- The original entry time and full plan are durable before/after submission; the 96h deadline survives restarts. Protection/timeout management runs independently of Telegram, scanning and CPU-heavy offline training.
- Missing/canceled protection is repaired without canceling healthy sibling orders. A failed protection recovery attempts a reduce-only close. A signed API outage is never treated as proof that a position is flat.
- Ambiguous MARKET responses are queried by their saved client ID, never blindly resubmitted. Unknown entries pause new entries until reconciled. Unknown external positions are reported and block new entries; the bot does not invent their strategy plan.

## Accounting and outcome quality

After confirmed flat, reconcile entry fills and all partial exits, deduplicate fill IDs, paginate trade/funding history and preserve raw amounts, assets, order IDs and times. Net PnL = realized gross PnL − commissions + signed funding income. Missing history/conversion remains pending and is retried; it is not converted to a fake LOSS or discarded after three attempts. Actual R uses the immutable actual initial monetary risk in both journal and learner.

USDT commissions are native amounts. Other fee assets are valued using the historical spot 1m close, with the conversion method retained; that USDT valuation is an estimate. Log entry/exit slippage separately from fees and actual exchange realized PnL to avoid double deduction.

MAE/MFE use closed 1m bars fully inside the holding interval plus observed mark/fill prices. The entry/exit minute boundaries have sampled precision, not tick-complete coverage; this source/precision is saved. Missing full-minute history prevents creating an outcome-distribution label. A websocket/tick recorder would be needed for exact tick-level extrema.

## Daily offline learning

Closed trades save decision-time feature/prediction snapshots alongside realized accounting. Daily calibration compares predicted edge R with realized net R and reports drift, without blind tuning.

Candidates change only minEdge/gapEdge. Each policy is evaluated on the exact same eligible opportunities and snapshotted directional costs, using the actual SL → 50% TP1 → TP2/96h timeout contract. If a bar touches both stop and target, assume the stop first. These hypothetical evaluations are explicitly separate from exchange PnL. No open candle is settled or frozen as a final outcome.

Chronological train/validation/test splits use a 24-bar purge/embargo on each split boundary. Select on train/validation, compare once on held-out test, and start shadow only for a qualified improvement. Shadow uses 14 full days of new opportunities and waits another 96h for the final labels to mature before promotion (earliest day 18). Insufficient evidence, a changed champion or a losing candidate prevents promotion. Training runs in a worker so it cannot block the live watchdog. WAIT history is retained 90 days so it remains available during shadow.

## Cold start and upgrades

The daily learning cycle and candidate promotion are not prerequisites for a live decision. No requirement to accumulate 30 winning live trades applies. Any existing valid labeled winners can supply the requested quantiles, provided the resulting exit geometry is valid.

An unresolved initialization requirement remains: this repository contains neither an initial trained AI-7 outcome model nor an initial labeled trade dataset. With an empty dataset, p80 winning MAE and p50/p90 winning MFE are undefined, so a conforming exit plan cannot be created. Removing the sample-count gate alone does not make an empty database capable of its first trade. This implementation does not claim otherwise or silently introduce paper trades, simulated labels, or fixed substitute exits.

Legacy pending Nine-AI records are migrated in place and their exchange protection is verified. Preserve old entry times. A legacy record missing a valid plan/risk cannot be repaired by inventing TP1. Older research evaluations are retained for audit but excluded from version-2 policy training.
