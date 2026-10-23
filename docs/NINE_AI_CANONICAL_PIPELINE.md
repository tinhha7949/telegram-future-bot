# Nine-AI canonical 4h decision and execution contract (schema v6)

This is the current execution contract; it supersedes older 50/50, one-label
AI-7 and unconstrained-return notes. The executable configuration is
[`CONFIG.yaml`](../CONFIG.yaml). The daemon is installed by
[`scripts/install-service.sh`](../scripts/install-service.sh), which runs
unit tests before enabling the service. Test results are not evidence of
live profitability or proof of Binance production safety.

## Authority, data and specialist responsibilities

Each closed 4h bar is processed through `index.js` → `nine-ai-pipeline.js`
(AI-1 through AI-8) → `nine-ai-policy.js` (AI-9, sole direction authority)
→ `execution-validation.js` → `RiskGuard`, `MemoryGuard` and
`TradeLifecycle` → Binance. Any missing critical state, invalid order
geometry, stale data or unavailable risk ledger yields **WAIT**. An already
open position continues independent SL/TP/timeout management.

| Agent | Inputs | Outputs and authority |
|---|---|---|
| AI-1 Regime | Closed 4h OHLCV, 20/90-day realized volatility and momentum | UPTREND/DOWNTREND/RANGE/HIGH_VOL and confidence; live only trades trends |
| AI-2 Structure | Confirmed three-bar swing highs/lows and channel | Structure bias and zones; does not authorize orders |
| AI-3 Continuation | Trend, recent pullback/re-push, OI/funding | Side-specific continuation probability and estimated gross R |
| AI-4 Breakout | Closed range, breakout volume and hold confirmation | Side-specific breakout estimate; no chasing complete-range extensions |
| AI-5 Mean Reversion | VWAP, ATR deviation, liquidation | Diagnostic in RANGE/HIGH_VOL; the live trend-only rule still WAITs |
| AI-6 Flow | Funding, OI and liquidation imbalance | Direction/flow confirmation; blocks hot funding, unavailable, neutral, nonfinite or opposite flow; never orders |
| AI-7 Outcome | Unique real closed-trade MAE/MFE labels | After 100 setup+direction-matched labels: MAE p80, MFE p50/p90; otherwise ATR14 fallback |
| AI-8 Fill | Spread, depth, OI, latency | Expected price/slippage; configured SLIPPAGE_BPS fallback when estimation is unavailable |
| AI-9 Meta | Specialist outputs and regime track record | Exactly one LONG/SHORT/WAIT using net expected edge and strict direction gap |

The analysis feed fetches at least 541 *closed* bars to compute 540 returns
for exact 90-day realized volatility. The compressed float32/delta/gzip
archive keeps the most recent `N_CANDLES=500` per symbol, and is not used as
the high-precision feature input. Features and labels exclude future bars,
future closures and unclosed candles. The candle/market freshness window is
one 4h bar; an older decision cannot be resurrected from cache.

## AI-9 edge and uncertainty

For each eligible direction `a`, with R measured against the entry-to-stop
distance:

```text
edge(a) = p(a) * E[gross_R | a, regime] - cost_R(a) - uncertainty
cost_R(a) = (round_trip_fee_pct + signed_funding_pct(a) + slippage_pct) / stop_pct
round_trip_fee_pct = 2 * FEE_TAKER * 100
```

Funding may be a cost or credit; realized settlement reconciles actual
exchange fees and signed funding and does not subtract slippage a second time
from exchange-native realized PnL. The probabilities are not certified
calibrated probabilities at cold start. `MIN_EDGE` is at least 0.15;
`EDGE_GAP` is 0.05; the two comparisons are strict. Low confidence and
prediction-vs-realized calibration drift add uncertainty rather than
allowing blind parameter changes. AI-6 must be CONFIRMED and in the proposed
trade direction with finite funding/OI and nonzero liquidation imbalance;
UNAVAILABLE, NEUTRAL and opposite flow yield WAIT. A fresh liquidation
reading is checked again before MARKET. This fail-closed rule can sharply
reduce trading opportunities during quiet or unavailable flow periods.
The last 20/90-day vol lookbacks, confidence weights, target quantiles,
cost-model coefficients and service intervals are all read from CONFIG.yaml.
Calibration flags material drift only after CALIBRATION_MIN_SAMPLES actual
labels, using CALIBRATION_MAX_MAE_R and CALIBRATION_MAX_ABS_BIAS_R in R units.
An isolated small prediction error is not considered drift. Uncertain or more-than-one-bar-old data
abstains. A 30-day WAIT-rate ledger raises the effective minimum edge if
the measured WAIT fraction falls below `WAIT_MIN_RATIO`.

## Entry, cold start, targets and exit

The prose requirement of 100 real outcomes conflicts with
`COLD_START_SAMPLES: 50`; the explicit
`AI7_ACTIVATION_SAMPLES: 100` is authoritative for switching quantiles.
A duplicated, simulated, future or opposite-direction label never counts
toward activation or contaminates that direction's MAE/MFE distribution.
Cross-symbol labels can be pooled for the same regime/setup/direction.

**Before AI-7 activation:** SL distance is `1.5 × ATR14`; TP1 must
reward at least `MIN_RR × risk_distance`, with the configured 60/40
target fractions and a 24×4h timeout. No label-history gate blocks
eligible cold-start trading.

**At/after activation:** the direction's MAE p80 determines initial stop;
TP1 distance is `max(MFE p50 distance, MIN_RR × stop_distance)`;
TP2 distance is at least `max(MFE p90 distance, TP1 distance)`.
Raw observed quantile prices are preserved separately from enforced
exchange prices. After the *actual* fill, AI-7 recalculates distances
using actual entry and stop; targets round **outward** to the exchange
price tick so `MIN_RR` cannot be lost to rounding. Exchange lot
granularity must permit `TP_BATCHES: [3, 2]` (60% TP1, 40% TP2).
The initial and post-fill risk/target geometry are revalidated.

The risk budget is `RISK_PER_TRADE × current_equity`, never multiplied
after a loss. A 2.5% start-of-day risk budget is conservatively reserved
in MongoDB before POST and survives restart/ambiguous API replies. An
equity drawdown at or above 15% latches new-entry shutdown; existing
positions continue exchange protection and timeout handling. Balance,
margin, position reconciliation, risk state and storage capacity are
preflight gates. Durable client/order IDs prevent blind duplicate
submissions; a failed/ambiguous POST must be reconciled, not repeated
with a new ID.

An exchange stop protects the remaining exposure. Both TP1 and TP2 are
reduce-only quantity-specific conditional orders; lifecycle recovery
reconciles which target was filled, including TP2-first and coincident
targets. After `TIMEOUT_BARS` bars, remaining exposure must be closed.
The accounting label stores actual gross, fee, funding, separately
observed slippage, MAE, MFE, initial risk and net R. Unknown/incomplete
fill history keeps the outcome pending rather than creating synthetic
realized labels.

## Training and retention

`nine-ai-offline-learning.js` evaluates champion/candidate on the same
matured 24-bar opportunities and the same signed-cost snapshots. The
closed-bar model uses a conservative stop-first convention if SL and TP
are both touched in the same bar. Chronological walk-forward
train/validation/test splits use purge/embargo. A candidate must
outperform the champion in held-out evaluation, then in a separate,
matured 14-day shadow cohort with actual trade-positive evidence
before automatic promotion. Its configurable minimum edge cannot
fall below `MIN_EDGE`; no manual model approval is necessary.

The 500 MB storage circuit uses allowlisted tier-priority cleanup,
retaining active positions, durable claims and champion state. Old
raw/tick and derived data are discarded before completed trade
snapshots/labels, which remain last resort. If capacity cannot be
measured or reduced, new entries remain WAIT; the exchange protection
loop is not stopped.

## Verification boundary

GitHub Actions runs recursive syntax and unit/integration tests with
mocked exchange/database responses. Neither CI nor a favorable backtest
guarantees profitable futures trading, exact protection under exchange
outages/gaps or immunity to forced liquidation. Before funding a VPS
account, independently validate the deployed Binance Futures order
types, quantities, account mode, adverse fill paths and restart
recovery on testnet/paper execution.
