# NINE-AI MongoDB capacity-aware retention

The retention controller is a **last-resort space-management mechanism**, not a way to age out AI learning history. It estimates logical data plus indexes in each MongoDB collection; this is not the same as the provider's billed quota or allocated disk.

## Safe defaults

- Assumed budget: `DB_STORAGE_LIMIT_MB=5120`; set it to the actual database budget.
- Preview threshold: 80% (4,096 MB by default); target: 60% (3,072 MB).
- Starts at boot and repeats every 6 hours.
- **Dry-run is enabled by default.** It reports eligible candidates and deletes nothing until `DB_RETENTION_DRY_RUN=false` is explicitly configured.
- Batch size defaults to 100 and is bounded to 10–500 documents.
- Hard cap defaults to 500 actual deletions per run, bounded to 10–2,000 using `DB_RETENTION_MAX_DELETES_PER_RUN`.
- Candidate ordering is oldest-first across the approved collections.
- One strict retention age is used. There is **no emergency mode that shortens retention windows** to chase a storage target.

## What may be deleted automatically

Only these report-artifact collections are eligible, and only after their `createdAt` timestamp is at least 365 days old:

- `nine_ai_strategy_lab_reports`
- `nine_ai_autonomous_decision_reports`

At selection and immediately before deletion, the worker checks that the record still meets the age rule. A missing or unparseable timestamp is not eligible. Each run is bounded by the configured batch size and deletion cap.

## What is explicitly protected

The automatic cleaner does not delete these categories, regardless of storage pressure:

- AI learning, reward-model, contextual-learning, counterfactual, and ML outcome records.
- Decision journal entries and loss diagnoses.
- Trade history, including closed trades; all active/pending trades remain untouched.
- Model/learning state, strategy state, deployment policies, and other unlisted collections.
- Collections, indexes, or whole databases.

If storage is still over target after eligible old reports are exhausted, the worker reports that the target was not reached. It must not sacrifice training outcomes or shorten retention to force the target.

## Configuration

- `DB_STORAGE_LIMIT_MB`
- `DB_STORAGE_TRIGGER_RATIO`
- `DB_STORAGE_TARGET_RATIO`
- `DB_RETENTION_BATCH_SIZE`
- `DB_RETENTION_MAX_DELETES_PER_RUN`
- `DB_RETENTION_INTERVAL_HOURS`
- `DB_RETENTION_DRY_RUN`

Review dry-run summaries before deliberately enabling deletion. Do not switch dry-run off until the actual collection names and timestamp schema have been checked against the production database.

## MongoDB/Atlas limitation

Per-collection stats are only an estimate and may not match Atlas account-level quota, overhead, or allocated disk. Deleting documents also may not immediately reduce allocated disk size. If the database remains over quota, investigate actual indexes, duplicate/rebuildable artifacts, and Atlas metrics instead of deleting AI learning history blindly.
