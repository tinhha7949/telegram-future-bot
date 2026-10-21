# Nine-AI canonical flow

The live path is index.js → nine-ai-pipeline.js → nine-ai-policy.js → central invariant checks → execution validation → TradeLifecycle. The same policy function is used by live decisions, cached decisions, candidate evaluation and shadow evaluation. Only AI-9 selects LONG, SHORT or WAIT. Exchange protection can reject/close unsafe exposure, but cannot invent a trading direction.

## Inputs and responsibilities

1. **Regime:** closed 4h OHLCV spanning at least 90 days (541 contiguous bars), plus closed 1h/day context; 20/90-day realized volatility, volatility percentile and momentum agreeing across timeframes. Outputs regime and confidence in [0,1]. Missing/stale/gapped context means WAIT.
2. **Structure:** confirmed fractal highs/lows, channel slopes, support/resistance and directional bias. Right-hand fractal bars must already be closed. The structure buffer can move the initial stop beyond support/resistance.
3. **Continuation:** a pullback in earlier bars, then a completed confirming impulse in the trend direction, increasing OI and non-hot funding. Before trade labels exist, the original repository's momentum/volume feature-score model supplies an explicitly uncalibrated probability estimate. Real labeled wins and losses replace that estimate when available.
4. **Breakout:** range break in the matching trend, volume expansion, a held level, acceptable spread and an extension guard. Uses the original volume-based initial estimate before real setup labels exist.
5. **Mean reversion:** VWAP deviation plus liquidation evidence, enabled only in RANGE/HIGH_VOL. Its diagnostic output cannot bypass the final trend gate: the requested live loop trades only UPTREND/DOWNTREND.
6. **Flow:** funding, OI change and observed liquidation imbalance. Confirms or blocks a model's direction; never creates a direction. Missing flow or hot funding means WAIT. The liquidation socket has a heartbeat and reconnect handling.
7. **Outcome:** deduplicated, matured REALIZED_CLOSED_TRADE labels for the same symbol, regime/setup and side. Wins and losses estimate probability using a Beta(2,2) prior. The user-authorized initial phase bypasses AI-7 exits and uses AI-2 structure instead. The first usable winning label enables winning MAE p80 and MFE p50/p90 immediately; there is no 30-trade gate. Historical price excursions are not relabeled as actual trading wins.
8. **Fill/slippage:** a transparent heuristic using depth, spread, OI change and measured request latency, returning a round-trip slippage estimate and estimated fill price per side. This is an estimate, not a claim of a trained fill model or a guaranteed fill.
9. **Meta:** applies the formula below once, compares both directions and returns one action. E[R|success] uses the 50/50 payoff of the actual proposed exits (AI-2 initially, AI-7 quantiles afterwards), optionally blended with the matching realized winning gross-R track record. Calibration remains a diagnostic; it does not silently alter live parameters.

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
- In AI2_INITIAL mode, SL is beyond the nearest valid confirmed structure zone with the existing ATR buffer. Targets use the next favorable swing/channel zones, with measured range/channel-width projections when price is beyond old highs/lows. These are actual structure-based prices, never presented as MAE/MFE quantiles.
- In AI7_LABELED mode, SL is winning MAE p80 plus a structure-zone buffer. TP1 is winning MFE p50, TP2 winning MFE p90. No independent minimum-RR filter or martingale is added.
- After the actual fill, keep the researched stop and shift target distances to the actual entry. Recalculate monetary risk from filled quantity and the rounded stop. Excess risk, invalid geometry or an unrepresentable 50% split triggers a reduce-only close rather than acceptance of extra exposure.
- TP1 reduces exactly half of the original filled quantity; TP2 and SL close remaining exposure. With one winner p50 equals p90, and tick rounding can also coincide. In that case submit two distinct reduce-only half-position targets at the same price, keep each fill/client ID separate, and accept either fill order. SL still protects all remaining exposure. Confirm each child fill before treating a half as closed; restart must not re-arm a filled half.
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

The user authorized the first one or two trades to bypass AI-7. This implementation uses the earliest permitted switch: one valid reconciled winning label for the matching symbol/regime/setup/side. Before those winning quantiles exist, AI2_INITIAL supplies the structure stop/targets and AI-9 still applies its unchanged edge/cost/uncertainty decision. At most two AI2_INITIAL positions can be active concurrently while awaiting feedback; this uses durable active trade plans, not a counter reset by restart. Empty-history LONG and SHORT can execute when all remaining requirements pass; entries are never forced just to collect labels.

Actual closures are labeled immediately after accounting, independently of the daily worker. On the next candle, AI-7 uses an available winning label without waiting for daily training or shadow promotion. p50 and p90 may coincide with one sample; that is supported end to end. Losing labels also reduce the empirical win probability. If no usable winner exists yet, or a different setup has no matching labels, its exits continue to use AI-2 rather than fabricating winning quantiles. This transition follows durable MongoDB labels and survives restarts; no process-local trade counter, paper portfolio or synthetic outcome dataset is used.

The journal, durable trade plan, feature snapshot and entry report identify AI2_INITIAL versus AI7_LABELED. Initial feature-score probabilities are marked FEATURE_SCORE_UNCALIBRATED; they are not claimed to be calibrated model outputs. Tests cover an empty database through the first completed real-accounting-shaped trade into an AI-7 decision using its saved label. Exchange/database responses in tests are fake; no live trade was submitted during development.

Legacy pending Nine-AI records are migrated in place and their exchange protection is verified. Preserve old entry times. A legacy record missing a valid plan/risk cannot be repaired by inventing TP1. Older research evaluations are retained for audit but excluded from version-2 policy training.
