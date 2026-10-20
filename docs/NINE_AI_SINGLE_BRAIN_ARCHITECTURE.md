# Nine-AI Single-Brain Architecture

## Authority model

`analyzeNineAI()` is the only live strategy decision source. Its seven directional assessors provide evidence to the Nine-AI Decision AI meta-decision. The meta-decision emits one `LONG`, `SHORT` or abstains. The Risk Manager role remains part of the same Nine-AI result. `nine-ai-central-decision-engine` is a final invariant checker, not a strategy: it may preserve a valid Nine-AI direction or convert it to `WAIT`, but never originates a direction.

The final authorization boundary verifies:

- Nine-AI setup identity and symbol identity.
- Presence of all nine role outputs.
- At least 60 closed candles.
- A recent signal timestamp.
- Valid entry/stop/target geometry and minimum gross RR.
- Explicit `authorizedForExecution` from the Nine-AI strategy.

Execution-side risk limits, exchange reconciliation, duplicate-order protection, and order-state handling remain separate safety services. They can constrain or reject an order, never replace its side with another strategy's signal.

## Research and learning

The learning memory, independent role models, reward model, opportunity journal, counterfactual research, autonomous strategy research, data-derived consensus research, adaptive research, and timing research can continue collecting outcomes and producing diagnostics. They are not allowed to alter live side, authorization, rank, entry, SL/TP, or entry timing directly. Research policy activation means only that a hypothesis passed that module's own validation; it is not proof of a profitable strategy and does not imply live deployment.

The live pipeline therefore has one authority boundary:

`market data -> nine role assessors -> Nine-AI meta-decision -> central invariant gate -> execution risk controls -> order execution`

Research runs alongside as a read-only feedback loop:

`decision/outcome ledger -> labeling -> research hypotheses -> chronological holdout evaluation -> shadow/paper evidence -> separately reviewed deployment`

## What this change does not claim

This architecture does not prove positive expectancy. Current indicators and learned models are hypotheses until evaluated on clean, chronological out-of-sample data after fees, funding, spread, slippage, and partial fills. The reward model currently learns from observed closed-trade outcomes; hypothetical opposite-side outcomes must remain explicitly counterfactual and must not be recorded as realized PnL. Do not enable new research policies for live trading merely because they have an ACTIVE status in a research collection.
