# NINE-AI Autonomous Adaptation

The autonomous adaptation overlay reads confirmed, closed `NINE_AI_15M` trades from the existing `trades` collection. It does not treat hypothetical journal/counterfactual outcomes as realized PnL.

## Learning loop

1. Rebuild outcome rows from persisted trade features, side, regime, close time, realized PnL, and risk budget.
2. Discover every numeric feature present in the training ledger, derive candidate cut points from its observed values, and score each predicate against contemporaneous controls.
3. Combine the strongest independent predicates into new two-condition strategy genomes. These genomes are data-only (`feature >= observed value` / `feature <= observed value`); they cannot execute code or change the order/execution pipeline.
4. Evaluate each genome on chronological held-out outcomes. The confidence requirement rises with the number of strategies searched (family-wise error correction). Only sufficiently sampled strategies with statistically supported positive or negative edge against same-side/same-regime controls can affect live ranking or trigger the existing evidence-gated veto.
5. Persist generated strategy genomes, measured evidence, the active policy snapshot, and versioned history in `nine_ai_autonomous_adaptation` and `nine_ai_autonomous_adaptation_history`.
6. Recompute periodically from the database. New outcomes can promote, change, or remove policies. The scanner ranks by validated generated-policy effect before the existing family-performance fallback.

## Live authority and safety

- Ranking adjustment is derived from out-of-sample uplift after its uncertainty penalty; matching policies are averaged so a strategy does not gain extra force just by matching more genes.
- A hard veto requires at least 40 chronological holdout matches and statistically negative performance versus contemporaneous same-side/same-regime controls after correcting for the number of generated strategies searched.
- The overlay never changes leverage, position sizing, SL/TP geometry, or exchange orders. Existing capital and execution guards remain unchanged.
- The search can create new feature-conjunction policies, but it does not rewrite JavaScript or invent data that is absent from the trade ledger. A strategy only affects live decisions after evidence gates pass.
- A research policy is not considered validated just because a log or database record exists.
- If the module is unavailable, existing Nine-AI decision flow continues and logs the failure; existing deterministic risk/execution guards remain in force.
- These are evidence gates, not guarantees of profitability. Backtest and live slippage differences remain possible.

## Regression test

Run `node --check ai-trading/nine-ai-autonomous-adaptation.js` and `node ai-trading/nine-ai-autonomous-adaptation.test.js`.

