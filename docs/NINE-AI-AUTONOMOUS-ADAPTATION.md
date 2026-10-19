# NINE-AI Autonomous Adaptation

The autonomous adaptation overlay reads confirmed, closed `NINE_AI_15M` trades from the existing `trades` collection. It does not treat hypothetical journal/counterfactual outcomes as realized PnL.

## Learning loop

1. Rebuild outcome rows from persisted trade features, side, regime, close time, realized PnL, and risk budget.
2. Evaluate four interpretable context rules: extended momentum entry, weak directional entry quality, low volume, and low room to opposing structure.
3. Split each rule's matched outcomes chronologically into 70% train and 30% test. Only sufficiently sampled rules with negative or positive holdout expectancy and a material matched-vs-control difference can affect live ranking.
4. Persist the current policy snapshot and versioned history in `nine_ai_autonomous_adaptation` and `nine_ai_autonomous_adaptation_history`.
5. Recompute periodically from the database. New outcomes can promote, change, or remove policies; no manual threshold edit is needed for these bounded rule families.

## Live authority and safety

- Validated evidence may adjust ranking by at most 8 points in either direction.
- A hard veto requires at least 30 chronological holdout matches, strongly negative test mean-R, materially worse performance than contemporaneous same-side/same-regime controls, and a 95% confidence bound below zero.
- The overlay never changes leverage, position sizing, SL/TP geometry, or exchange orders.
- A research policy is not considered validated just because a log or database record exists.
- If the module is unavailable, existing Nine-AI decision flow continues and logs the failure; existing deterministic risk/execution guards remain in force.
- These are evidence gates, not guarantees of profitability. Backtest and live slippage differences remain possible.

## Regression test

Run `node --check ai-trading/nine-ai-autonomous-adaptation.js` and `node ai-trading/nine-ai-autonomous-adaptation.test.js`.
