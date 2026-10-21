# Nine-AI decision contract

The live sequence is index.js -> Nine-AI pipeline -> shared AI-9 policy -> execution validation -> durable TradeLifecycle. The same netEdge function is used to select the best setup per direction and to compare LONG/SHORT. Only AI-9 selects a trading direction. Exchange validation checks executable prices, quantities and account state; it does not add technical-analysis filters.

## Specialist roles

1. Regime uses only closed 4h OHLCV. Realized volatility over 20/90 days uses the last 120/540 returns from that same 4h history; these are lookback durations, not other candle timeframes. The 5/20-day momentum windows also use that history (30/120 bars), with matching signs defining trend direction. Volatility is ranked by percentile. Outputs UPTREND, DOWNTREND, RANGE or HIGH_VOL and confidence in [0,1]. The requested live loop returns WAIT outside a trend. There is no separate 1.2% momentum prerequisite or confirmation from another candle timeframe.
2. Structure uses a three-candle fractal: the middle high/low must exceed/be below its two neighbors. Confirmed swings define support, resistance and projected channels. Structure bias is an output, not an additional veto on AI-9. AI-2 supplies temporary exits only when winning outcome quantiles do not yet exist, as authorized by the user.
3. Continuation requires a prior pullback and a confirming push in the trend, with non-hot funding. OI change participates in the probability estimate. No separate volume threshold, minimum ATR body size or positive-OI-only gate is imposed on this role.
4. Breakout uses a range of prior closed bars, volume expansion on the break and a subsequent closed bar holding the broken level. It avoids chasing after a complete measured range extension. Spread contributes to probability and execution cost; there is no independent 0.15% spread veto or fixed role priority. These calculations implement the requested volume/hold/no-chase behavior.
5. Mean reversion uses VWAP, deviation and liquidation only in RANGE/HIGH_VOL. The user's final trend-only live loop still returns WAIT in those regimes, so this specialist remains diagnostic there.
6. Flow reports funding, OI and liquidation direction/confirmation. It never creates an order. Hot funding blocks an entry. Neutral, missing or opposing liquidation is not an extra mandatory trade gate. Funding heat has a single numerical definition in nine-ai-policy.js (absolute rate above 0.0008 per funding interval).
7. Outcome groups deduplicated, matured REALIZED_CLOSED_TRADE excursion labels by regime/setup, without an additional symbol/side prerequisite. MAE p80 uses winning labels; MFE p50/p90 uses all labeled trades, including losses. No minimum number of winning trades is required. A valid positive stop distance and favorable targets are necessary to represent an executable plan; zero MAE is not replaced with ATR or structure.
8. Fill/slippage estimates round-trip impact from depth, spread, OI and observed latency. It remains an explicit numerical estimate, not a claim that a separate trained fill model exists.
9. Meta selects the best available setup in each direction by the shared net-edge formula, then returns one LONG/SHORT/WAIT decision for the symbol. There are no fixed Continuation/Breakout role weights or structure/liquidation vetoes.

## One decision formula

    edge(a) = p(a) * E[R | a, regime] - cost(a) - uncertainty_penalty
    cost(a) = fee + funding(a) + slippage
    LONG if edge(LONG) > minEdge and edge(LONG)-edge(SHORT) > gapEdge
    SHORT symmetrically; otherwise WAIT

Costs and payoffs use the same entry-to-stop R unit. Fee is configured in percentage points; expected funding uses the observed rate and funding interval over the 96h holding horizon, preserving its sign: payment is a cost and receipt is a credit. Net forecast cost may be negative. Funding is a forecast, not a guaranteed receipt or a future rate observation. Slippage is estimated from the snapshotted inputs. Actual closure accounting uses real exchange fees/funding.

Uncertainty increases as regime confidence falls, observations/candle/OI context age, or directional edges approach one another. Stale values are penalized through edge rather than a separate five-minute/30-second entry window. Missing/nonfinite required cost inputs and impossible future timestamps cannot be converted into an estimate. The current numerical probability models, percentile definitions and uncertainty scale are visible in source; they are not additional trade-count unlocks.

Before real outcomes exist, each role's own feature model supplies an explicitly uncalibrated probability. Continuation uses trend/funding/OI; Breakout uses expansion/spread; Mean Reversion uses VWAP deviation/liquidation. Real directional setup outcomes update that model as (wins + current feature-model probability)/(observations + 1), without a minimum count or an immediate probability of exactly zero/one after one trade. Track-record counts may supply observations if excursion labels are unavailable. E[R] uses the mean realized gross R for the same direction/regime/setup, including winning and losing trades, when available in the actual track record or complete excursion labels. Only before those returns exist does the proposed 50/50 exit geometry supply an explicitly uncalibrated initial estimate. No minimum count or fixed blend is imposed. The requested p*E[R]-cost formula remains unchanged, and costs are subtracted once.

An inactive direction has no executable plan, probability zero and execution cost zero. It remains a finite comparison alternative but cannot execute. A competing active setup is selected by its net edge, never a fixed role order.

## Exact AI-7 exits and actual fills

For LONG:

    SL  = actual_entry * (1 - MAE_p80/100)
    TP1 = actual_entry * (1 + MFE_p50/100)
    TP2 = actual_entry * (1 + MFE_p90/100)

SHORT reverses the signs. There is no structure, ATR or fixed-RR adjustment to an AI-7 stop or target. Raw quantile prices and actual exchange-rounded prices are saved separately. SL rounds toward entry to the exchange price tick, so it is never widened beyond p80. A target rounds toward entry as well. Invalid/zero-distance or unrepresentable geometry is rejected instead of inventing replacement prices.

Initial plans without winning MAE quantiles use AI-2 structure exits only. They are recorded as AI2_INITIAL, never as measured quantiles. The first usable labeled winner for the setup enables AI7_LABELED for subsequent decisions across symbols. Losing trades participate in MFE, probability and realized E[R], but cannot manufacture a winning-MAE quantile. No fixed maximum position count, top-ten candidate cutoff, one-entry-per-scan cap or cooldown is imposed by the strategy. Every approved symbol is considered; duplicate entries for the same symbol/candle and overlapping same-symbol exposure remain prevented. Exchange balance/order constraints still apply.

TP1 closes exactly half the original quantity. TP2 closes the remainder; SL protects remaining exposure. Coincident p50/p90 targets use two distinct reduce-only half-position orders, with separate role/client IDs and fill reconciliation in either order. After TP1, the remaining original stop is preserved; no automatic breakeven rule is added. The original 24-candle/96h timeout survives restart.

Sizing uses the manually editable risk constant in index.js and current equity. Exchange tick/lot/minimum-order constraints and the risk budget remain execution checks. Actual fill quantile prices are recomputed from the real entry; exposure beyond the budget is not silently accepted.

## Snapshots, execution and labels

Each symbol/closed-4h candle has one durable version-5 decision. Strategy candle requests, regime calculations and signal features use only 4h bars. Data timestamps are recorded at actual observation and never backdated. Track-record queries and cache reads respect their decision-time cutoff, excluding later closures. Before MARKET, current cost/funding/price geometry and the same AI-9 rule are rechecked. Full plans and order client IDs are saved before POST; ambiguous responses are queried rather than blindly resubmitted. Protection and timeout management operate independently of Telegram and offline CPU work.

After confirmed flat, reconcile all fills, partial exits, commissions and signed funding. Net PnL is actual gross PnL minus fees plus signed funding. Slippage is logged separately and is not subtracted twice from exchange PnL. R uses actual initial monetary risk. MAE/MFE use complete 1m bars within the holding interval plus observed mark/fill boundary samples. Missing measurement intervals keep the closed trade pending and are retried from entry before labeling; no incomplete/future interval becomes a final outcome.

Non-USDT fee conversion uses a matured historical spot 1m close with source/precision recorded. Entry/exit boundary extrema are sampled, not tick-complete. Fake exchange/database responses are used in tests; no real order or production database is exercised by the suite.

## Daily learning

Actual closed trades retain decision-time features/predictions and real results. predicted_R = p*E[R]-cost is saved separately from edge = predicted_R-uncertainty_penalty. Calibration compares net realized_R against predicted_R; uncertainty is a decision penalty, not a predicted exchange loss. Older complete snapshots can reconstruct predicted_R from p, E[R] and cost; an edge-only legacy snapshot is excluded rather than mislabeled. Discrepancies are flagged without a trade-count prerequisite and do not directly change champion parameters. Candidate policy fitting varies minEdge/gapEdge.

Candidate and champion use the same eligible opportunities, signed cost snapshots and SL/half-TP1/TP2/timeout simulation. Closed-bar evaluation uses SL first when intrabar ordering is ambiguous. Chronological train/validation/test partitions are purged/embargoed by the 24-bar horizon. Candidate thresholds are selected using train net R and then must beat the champion on validation and test without refitting to those future outcomes. Empty partitions cannot produce a validated candidate, but no 400/30/20 row/trade-count prerequisites or extra 0.02R uplift requirement are added.

A qualified candidate shadows a full two-week opportunity cohort. Promotion requires winning on that same cohort and complete matured labels. There is no fixed extra four-day wait when all labels are already mature, and no arbitrary day-21 rejection timer. If the end-of-shadow opportunities still need their forward labels, promotion waits for those labels. A completed losing shadow is rejected; an empty cohort cannot prove a win. Earlier candidates/decisions are retained for audit but cannot be promoted or reused by the version-5 engine. A pre-v5 champion's parameters are preserved as previousChampion and current parameters return to the declared defaults, so coefficients learned using different return/exit/cost definitions cannot silently enter the new contract. Existing open positions retain their saved protection plans rather than being silently rewritten. Daily offline learning remains a schedule, not a daily candle input.
