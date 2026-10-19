# NINE-AI MongoDB capacity-aware retention

## Safety contract

The goal is controlled storage reduction without destroying experience NINE-AI may need to analyze outcomes, evaluate strategies, or improve its decisions. **Age alone is not evidence that a record is disposable.**

The automatic deletion allowlist includes old, terminal event records from trades,
evaluated decisions, applied learning/model outcomes, contextual and counterfactual
outcomes, loss diagnoses, reports, research hypotheses/versions, and adaptation
history. Each eligible record must be at least 90 days old. The timestamp used is
the newest valid lifecycle timestamp available for that document, so a recent close,
evaluation, or update protects a record whose creation time is old.

The controller preserves open/pending trades, unevaluated decisions, unapplied
learning outcomes, legacy outcomes not yet migrated to the independent models,
model state, active/research policies, pending timing entries, signal claims, and
unknown collections. It also preserves any event with missing or invalid timestamps.
This keeps restart recovery and live decision state intact while old event history
is gradually pruned.

## Capacity behavior

- Estimated logical usage is calculated from each collection's data size plus indexes.
- Default configured limit: 5,120 MB.
- Cleanup starts at 80% of that limit (4,096 MB).
- Target is 60% (3,072 MB).
- The controller checks at startup and every 6 hours. By default it performs bounded deletion of eligible old event records when usage crosses the trigger threshold.
- Each deletion batch is at most 100 documents by default.
- A run deletes at most 500 documents by default.
- The process chooses the globally oldest eligible records across the allowlisted event collections.
- Each candidate is rechecked against its age, collection-specific terminal-state filter, and ID immediately before deletion.
- Outcome ledgers are eligible only after `applied: true`; `nine_ai_learning_outcomes` also requires `independentModelsMigrated: true`.
- The nine known `nine_ai_ml_*_outcomes` collections are included. Unknown model collections fail closed.
- Collections, indexes, or databases are never dropped. Active trades and mutable model/policy state are never deleted by this controller.
- Collections not on the allowlist are reported as unreviewed and are never automatically mutated.

## Configuration

- `DB_STORAGE_LIMIT_MB`: storage limit in MB (default `5120`).
- `DB_STORAGE_TRIGGER_RATIO`: trigger ratio (default `0.80`).
- `DB_STORAGE_TARGET_RATIO`: target ratio (default `0.60`, always kept below the trigger).
- `DB_RETENTION_BATCH_SIZE`: batch size (default `100`, bounded).
- `DB_RETENTION_MAX_DELETES_PER_RUN`: run cap (default `500`, bounded).
- `DB_RETENTION_INTERVAL_HOURS`: cycle interval (default `6`, bounded).
- `DB_RETENTION_ENABLE_DELETE`: deletion kill-switch. Defaults to enabled. Set to `false`, `0`, or `no` to disable all deletion. Setting `true`, `1`, or `yes` explicitly enables it.
- `DB_RETENTION_DRY_RUN`: defaults to `false`, so the controller actually deletes eligible old event records when the threshold is crossed. Set to `true` to preview only. Unknown values fail safe to preview.
- **Default production behavior:** no extra environment variables are required for bounded cleanup. All explicitly reviewed historical event collections and the nine known model-outcome ledgers are eligible; active state, policies, pending work, and unknown collections remain protected.
- To disable cleanup immediately, set `DB_RETENTION_ENABLE_DELETE=false`. To temporarily switch to preview mode, set `DB_RETENTION_DRY_RUN=true`. These switches do not change which collections are eligible.

## Measurement limitation

This is a per-collection logical-size estimate, not a guaranteed measurement of provider-level quota, overhead, or allocated disk. If any collection cannot be measured, the run fails closed and performs no deletion. MongoDB may retain allocated storage after documents are deleted, so physical storage may not immediately shrink. If the eligible records older than 90 days are exhausted before the target is reached, the controller reports that fact and preserves newer/protected data. A maximum of 500 records is deleted per run by default, so a large reduction can take multiple six-hour cycles.

## What remains intentionally unclaimed

This module prunes old event rows; it does not create a separate archival copy. Model state and active policies are retained, but consumers that recompute research from raw events will have a rolling 90-day history after old rows are pruned. The 3,072 MB target is best-effort: it does not override the 90-day age rule or protected-state rules.
