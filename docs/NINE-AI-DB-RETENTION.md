# NINE-AI MongoDB capacity-aware retention

## Safety contract

The goal is controlled storage reduction without destroying experience NINE-AI may need to analyze outcomes, evaluate strategies, or improve its decisions. **Age alone is not evidence that a record is disposable.**

Retention evaluates **all collections dynamically**, rather than relying on a two-collection allowlist. It can delete only records whose newest recognized lifecycle timestamp is older than 90 days. Collections representing source-of-truth trades, orders, positions, fills, active risk/wallet state, learning memory, outcomes, diagnoses, decision journals, research evidence, model training, policies, and deployments are protected by collection-name safeguards. MongoDB system collections are also excluded.

For non-core collections, records with an active/in-flight `status` or `state` are excluded even if their timestamps are old. At deletion time, the controller rechecks the record IDs, the protected filter, and the newest valid timestamp. Records with no recognized valid timestamp are not candidates. This makes retention apply to stale data across collections without treating age alone as permission to erase the bot's source-of-truth trading or learning evidence.

The protections are conservative name-based safeguards, not a substitute for checking the actual production schema. If a new collection stores important data under an unfamiliar name, add its name pattern to the protected rules before deployment.

## Capacity behavior

- Estimated logical usage is calculated from each collection's data size plus indexes.
- Default configured limit: 5,120 MB.
- Cleanup starts at 80% of that limit (4,096 MB).
- Target is 60% (3,072 MB).
- The controller checks at startup and every 6 hours. By default it performs bounded deletion of eligible generated reports when usage crosses the trigger threshold.
- Each deletion batch is at most 100 documents by default.
- A run deletes at most 500 documents by default.
- The process evaluates every non-system, non-core collection with recognized timestamps, oldest first, while protecting source-of-truth trading and learning collections.
- Each candidate is rechecked against its age and allowlist before deletion.
- Collections, indexes, databases, active trades, and all learning/research evidence are never dropped by this controller.
- Protected trading/learning collections and MongoDB system collections are never automatically mutated.

## Configuration

- `DB_STORAGE_LIMIT_MB`: storage limit in MB (default `5120`).
- `DB_STORAGE_TRIGGER_RATIO`: trigger ratio (default `0.80`).
- `DB_STORAGE_TARGET_RATIO`: target ratio (default `0.60`, always kept below the trigger).
- `DB_RETENTION_BATCH_SIZE`: batch size (default `100`, bounded).
- `DB_RETENTION_MAX_DELETES_PER_RUN`: run cap (default `500`, bounded).
- `DB_RETENTION_INTERVAL_HOURS`: cycle interval (default `6`, bounded).
- `DB_RETENTION_ENABLE_DELETE`: deletion kill-switch. Defaults to enabled. Set to `false`, `0`, or `no` to disable all deletion. Setting `true`, `1`, or `yes` explicitly enables it.
- `DB_RETENTION_DRY_RUN`: defaults to `false`, so the controller actually deletes eligible old generated reports when the threshold is crossed. Set to `true` to preview only. Unknown values fail safe to preview.
- **Default production behavior:** no extra environment variables are required for bounded cleanup. All non-core collections are evaluated dynamically; records are eligible only when their newest valid lifecycle timestamp is older than 90 days and they are not active/in-flight. Trading and learning evidence remain protected.
- To disable cleanup immediately, set `DB_RETENTION_ENABLE_DELETE=false`. To temporarily switch to preview mode, set `DB_RETENTION_DRY_RUN=true`. No other collections become eligible.

## Measurement limitation

This is a per-collection logical-size estimate, not a guaranteed measurement of provider-level quota, overhead, or allocated disk. MongoDB may retain allocated storage after documents are deleted, so physical storage may not immediately shrink. If eligible reports are exhausted before the target is reached, the controller reports that fact and preserves protected data.

## What remains intentionally unclaimed

This module does not compact raw trades or learning evidence into a durable archive. It preserves those source-of-truth collections and deletes stale records from other collections only when the retention date and inactive-state checks pass. Production schemas and provider-level quota still need verification.
