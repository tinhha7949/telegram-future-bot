# NINE-AI autonomous learning and deployment

NINE-AI continuously learns from exchange-confirmed closed trades and evaluates entry-timing counterfactuals. The deployment controller compares each candidate with the same trade's actual baseline, splits paired observations chronologically (70% train / 30% holdout), and activates only candidates with adequate sample counts, positive net-R and statistically meaningful out-of-sample uplift.

Evaluated timing variants include earlier by 1/2 candles, later by 1/2 candles, and opposite-side hypotheses. Losses remain first-class observations: causal diagnosis and counterfactual outcomes are retained, compared against the actual baseline, and used to validate corrective hypotheses. A loss never causes a blind direction reversal.

Validated policies are wired into the live Nine-AI rank score as bounded evidence. They cannot bypass exchange risk controls, authorize invalid SL/TP geometry, change leverage, or increase position sizing. The deployment controller re-evaluates policies every six hours and retires policies that fail validation. Live attributed matched/control outcome rows, when available, trigger rollback if performance degrades.

Counterfactual results are simulations, not actual PnL. Actual trade outcomes remain separately recorded. Policy promotion is not a guarantee of profitability.
