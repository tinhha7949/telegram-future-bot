# NINE-AI MongoDB capacity-aware retention

## Safety contract

The goal is controlled storage reduction without destroying experience NINE-AI may need to analyze outcomes, evaluate strategies, or improve its decisions. **Age alone is not evidence that a record is disposable.**

The current automatic deletion allowlist is intentionally narrow. It contains only:
- `nine_ai_strategy_lab_reports`: generated reports older than 90 days.
- `nine_ai_autonomous_decision_reports`: generated reports older than 90 days.

Raw trades and all decision, diagnosis, counterfactual, contextual, reward-model, strategy-evolution, and ML outcome evidence are preserved. The repository has not yet established a durable compact replacement for every field those records contain or proven that every consumer reads such a replacement. Those collections must not be added to automatic deletion until that preservation path and its integration tests exist.

This means cleanup may stop above the target when report data is insufficient to reduce usage. That is the correct safe outcome, not permission to delete training evidence.

## Capacity behavior

- Estimated logical usage is calculated from each collection's data size plus indexes.
- Default configured limit: 5,120 MB.
- Cleanup starts at 80% of that limit (4,096 MB).
- Target is 60% (3,072 MB).
- The controller checks at startup and every 6 hours. By default it performs bounded deletion of eligible generated reports when usage crosses the trigger threshold.
- Each deletion batch is at most 100 documents by default.
- A run deletes at most 500 documents by default.
- The process deletes only from the two allowlisted report collections, oldest first.
- Each candidate is rechecked against its age and allowlist before deletion.
- Collections, indexes, databases, active trades, and all learning/research evidence are never dropped by this controller.
- Collections not on the allowlist are reported as unreviewed and are never automatically mutated.

## Configuration

- `DB_STORAGE_LIMIT_MB`: storage limit in MB (default `5120`).
- `DB_STORAGE_TRIGGER_RATIO`: trigger ratio (default `0.80`).
- `DB_STORAGE_TARGET_RATIO`: target ratio (default `0.60`, always kept below the trigger).
- `DB_RETENTION_BATCH_SIZE`: batch size (default `100`, bounded).
- `DB_RETENTION_MAX_DELETES_PER_RUN`: run cap (default `500`, bounded).
- `DB_RETENTION_INTERVAL_HOURS`: cycle interval (default `6`, bounded).
- `DB_RETENTION_ENABLE_DELETE`: deletion kill-switch. Defaults to enabled. Set to `false`, `0`, or `no` to disable all deletion. Setting `true`, `1`, or `yes` explicitly enables it.
- `DB_RETENTION_DRY_RUN`: defaults to `false`, so the controller actually deletes eligible old generated reports when the threshold is crossed. Set to `true` to preview only. Unknown values fail safe to preview.
- **Default production behavior:** no extra environment variables are required for bounded cleanup. Only the two generated-report collections listed above are eligible; trades and learning/research evidence remain outside the deletion allowlist.
- To disable cleanup immediately, set `DB_RETENTION_ENABLE_DELETE=false`. To temporarily switch to preview mode, set `DB_RETENTION_DRY_RUN=true`. No other collections become eligible.

## Measurement limitation

This is a per-collection logical-size estimate, not a guaranteed measurement of provider-level quota, overhead, or allocated disk. MongoDB may retain allocated storage after documents are deleted, so physical storage may not immediately shrink. If eligible reports are exhausted before the target is reached, the controller reports that fact and preserves protected data.

## What remains intentionally unclaimed

This module does not yet compact raw trades or learning evidence into a durable, tested learning archive. It therefore does not claim that the full long-term storage optimization goal is complete. The safe current behavior is to delete only generated reports and preserve records whose learning value has not been proven redundant.
