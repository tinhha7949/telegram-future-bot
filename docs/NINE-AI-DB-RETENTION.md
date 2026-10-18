# NINE-AI MongoDB capacity-aware retention

The retention controller manages high-volume historical records without treating all old data as disposable. It uses explicit per-collection retention windows, oldest-first selection, a bounded delete budget, and autonomous real cleanup by default.

## Capacity behavior

- Assumed database budget: `DB_STORAGE_LIMIT_MB=5120`; set this to the actual configured database budget.
- Cleanup preview starts at 80% of the configured budget and targets 60%.
- Runs at startup and every 6 hours.
- Real bounded deletion is enabled by default. Set `DB_RETENTION_DRY_RUN=true` only to pause deletion and preview eligible records.
- Batch size defaults to 100 (bounded 10–500); actual deletion is capped at 500 documents per run by default (bounded 10–2,000).
- Records are selected oldest-first across eligible collections. The worker rechecks age and collection-specific filters immediately before deletion.
- There is no emergency mode that shortens a collection's minimum age to chase a space target.

## Retention tiers

| Collection | Minimum age | Conditions / purpose |
|---|---:|---|
| `trades` | 90 days | Only terminal `result: "WIN"` or `result: "LOSS"`; `PENDING` and unknown statuses never match. The newest valid lifecycle timestamp controls age. |
|---|---:|---|
| `nine_ai_decision_journal` | 90 days | Only `outcomeStatus: "EVALUATED"`; unresolved journal rows are protected |
| `nine_ai_strategy_lab_reports` | 90 days | Generated analysis reports |
| `nine_ai_autonomous_decision_reports` | 90 days | Generated decision-research reports |
| `nine_ai_loss_diagnoses` | 180 days | Derived diagnoses, retained longer for review |
| `nine_ai_counterfactual_outcomes` | 365 days | Learning evidence |
| `nine_ai_contextual_outcomes` | 365 days | Only `closed: true`; learning evidence |
| `nine_ai_learning_outcomes` | 365 days | Only `closed: true` and `applied: true`; unapplied outcomes are protected |
| `nine_ai_reward_model_outcomes` | 365 days | Only `closed: true` and `applied: true`; unapplied outcomes are protected |
| `nine_ai_strategy_evolution_outcomes` | 365 days | Only `closed: true` and `applied: true`; unapplied outcomes are protected |
| `nine_ai_ml_technical_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_signal_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_memory_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_bull_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_bear_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_contrarian_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_analyst_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_decision_outcomes` | 365 days | ML training/evaluation evidence |
| `nine_ai_ml_risk_outcomes` | 365 days | ML training/evaluation evidence |

The full allow-list is explicit in code. An unknown collection is never automatically cleaned. A missing or invalid timestamp is not eligible. The newest valid lifecycle timestamp is used, so a recent `updatedAt` or `closedAt` protects a record even if `createdAt` is old. ML outcome collections also require `closed: true` and `applied: true`.

## Never automatically deleted

- Pending/live trades, trades with unknown status, and records without a safely parseable lifecycle timestamp.
- Mutable model/learning state, active policies, strategy versions, deployment status, pending timing entries, and deduplication/claim ledgers.
- Unresolved decision-journal rows.
- Any collection not explicitly allow-listed above.
- Collections, indexes, or entire databases.

Learning evidence is not eligible before 365 days, even when database usage exceeds the target. Outcome records with an explicit `applied: false` or missing `applied: true` marker remain protected. If the database is only seven months old, only the 90/180-day tiers and 90-day closed trade history may be candidates. Training evidence is never deleted merely to make the storage graph look better.

## Configuration

- `DB_STORAGE_LIMIT_MB`
- `DB_STORAGE_TRIGGER_RATIO`
- `DB_STORAGE_TARGET_RATIO`
- `DB_RETENTION_BATCH_SIZE`
- `DB_RETENTION_MAX_DELETES_PER_RUN`
- `DB_RETENTION_INTERVAL_HOURS`
- `DB_RETENTION_DRY_RUN`

Real deletion is enabled by default. Set `DB_RETENTION_DRY_RUN=true` to preview instead. The allow-list is intentionally fail-closed: unknown collections remain untouched and are reported in the cleanup summary.

## Storage measurement limitations

Per-collection logical size plus indexes is an estimate, not a guaranteed reading of provider-level quota, overhead, or allocated disk. Deletes may not immediately reduce allocated disk. If the target is still not reached after eligible records are exhausted, the controller reports that instead of deleting protected training data.
