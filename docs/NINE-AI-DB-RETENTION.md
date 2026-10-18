# NINE-AI MongoDB capacity-aware retention

The bot now runs a periodic retention controller. It estimates used storage by summing per-collection MongoDB `totalSize` (with storage/index fallback) and prunes only when the estimate reaches a configurable threshold.

## Defaults

- Assumed database budget: `DB_STORAGE_LIMIT_MB=5120` (5 GiB-style MB budget; set this to the actual Atlas quota you purchased).
- Start cleanup at 70%: 3,584 MB by default.
- Aim to return to 55%: 2,816 MB, leaving 45% estimated headroom.
- Run at startup and every 6 hours.
- Batch deletion: 500 documents.
- Normal retention priority: evaluated decision journal (45 days), old research reports (90 days), counterfactual outcomes and diagnoses (120–180 days), then learned outcome ledgers (365 days).
- If the target is still not reached, an emergency pass can retain 30 days of evaluated journal, 60 days of reports, 120 days of counterfactual/diagnosis records, and at least 180 days of learned outcomes. Closed trades are considered last and retain at least 365 days.

## Safety guarantees

- Never deletes `PENDING` trades; only closed terminal trade results are eligible, and trades are the last-resort collection.
- Does not delete learning/model state, active strategy policies, timing deployment policies, collections, or indexes.
- Decision journal entries are eligible only after their forward outcomes are evaluated.
- Uses bounded batches, emits a compact summary only when cleanup runs, and does not stop scanning if retention fails during startup.
- `DB_RETENTION_DRY_RUN=true` lists candidates without deleting them.
- Configure with `DB_STORAGE_LIMIT_MB`, `DB_STORAGE_TRIGGER_RATIO`, `DB_STORAGE_TARGET_RATIO`, `DB_RETENTION_BATCH_SIZE`, `DB_RETENTION_INTERVAL_HOURS`, and `DB_RETENTION_DRY_RUN`.

## Important Atlas limitation

MongoDB collection statistics are an estimate, not a guaranteed reading of the Atlas cluster's full billed storage/quota. They may exclude Atlas-level overhead or other databases. Set the budget/threshold conservatively and compare the logs with Atlas Metrics. This controller cannot query Atlas's account-level storage quota using ordinary database permissions. Deleting documents also may not immediately shrink Atlas allocated disk size, though it frees reusable collection space.
