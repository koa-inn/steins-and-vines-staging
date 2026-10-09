# Phase 87 - Batches Cutover Log

Owner/Claude-maintained record of the staging rehearsal, the production window and the rollback week.
Procedure: `docs/RUNBOOK.md` section "Batches -> Postgres (Phase 87)". No secrets, customer names, emails,
tokens or notes: ids, field names, counts and classifications only.

## Staging rehearsal

Staging candidate SHA: `5aa2d2e7` (pushed 2026-10-09; guard chain applied `0005_batches`; `/health` ok;
`BATCHES_STORE` and `BATCHES_FREEZE` unset, so sheets mode). Production pin at push time: production
`main` = `ef3be1e3`, which contains no Phase 87 commits (Q10). Apps Script v62 deployed on: 2026-10-09
(rollback v61).

Apps Script v62 probes (production credentials, read-only, 2026-10-09): `get_batches` ok:true;
`export_batch_tabs` ok:true with Batches 204, BatchTasks 1068, PlatoReadings 70, VesselHistory 427. Orphan
child rows at that time: BatchTasks BT-000567, BT-000568, BT-000569, BT-000570 (all -> SV-B-000108);
PlatoReadings none; VesselHistory none.

| Step | Target (min) | Measured (min) | Result |
|------|--------------|----------------|--------|
| 3 Freeze + restart + check | 5 | | |
| 4 Snapshot, dry run, promote | 20 | | |
| 5 Second snapshot + verify | 10 | | |
| 6 Parity (after 300 s cache expiry) | 10 | | |
| 8 Flip + health + boot lines | 5 | | |
| 9 D-12 notices | 3 | | |
| 10 Smoke | 20 | | |
| 11 Scan invoices | 10 | | |

| Check | Result |
|-------|--------|
| Row counts (batches / batch_tasks / plato_readings / vessel_history) | |
| Rejects (must be 0) | |
| `batches-verify.js` (0 mismatches) | |
| `batches-parity.js` (parity: 0 differences) | |
| Smoke: create batch, mark task, add reading, vessel transfer | |
| Rollback rehearsal (replay, verify, notices removed, flag back) | |
| Fits the 2-hour budget with room for one rollback? | |

## Production prerequisites

| Check | Evidence | Date |
|-------|----------|------|
| Phase 86 production flip recorded (`OPS_DATA_STORE=postgres`, Q14/D-13) | | |
| Apps Script v62 deployed, rollback v61, editor-drift check | v62 live; pre-paste drift check skipped, post-paste hash matched repo; probes ok | 2026-10-09 |
| Staging rehearsal complete and within budget | | |
| Q1 orphan task rows BT-000567..570 deleted | Owner deleted the 4 rows; `export_batch_tabs` re-check shows 0 orphans in BatchTasks, PlatoReadings, VesselHistory (re-confirm before the production dry run) | 2026-10-09 |
| Q3 Apps Script timezone confirmed | | |
| Pinned production SHA | | |
| Migration 0005 and inert Phase 87 code on production | | |
| Window date and time agreed with owner | | |

## Production window

| Field | Value |
|-------|-------|
| Freeze set at (`BATCHES_FREEZE`) | |
| Flip at (`BATCHES_STORE=postgres`) | |
| Window closed at | |

Timeline:

| Step | Start | End | Notes |
|------|-------|-----|-------|

Go/no-go record (D-06):

| Gate | Result |
|------|--------|
| Dry run: 0 rejects | |
| Row counts equal | |
| `batches-verify.js` 0 mismatches | |
| `batches-parity.js` 0 differences | |
| Owner go/no-go decision and time | |
| Smoke: create batch / mark task / add reading / vessel transfer | |

Invoices taken during the window (numbers only):

| Invoice | Batch created by | Notes |
|---------|------------------|-------|

Scan invoices result:

## Next-business-day smoke (SC4)

| Check | Result |
|-------|--------|
| Kiosk and POS sales created batches | |
| `create_batch` median ms from `[batch-proxy] create_batch ms=<n>` logs | |
| Printed `batch.html` tokens open | |

## Rollback week

| Day | Date | Drift check (`[batches-drift]` line or Sentry) | Explained? | Action |
|-----|------|-----------------------------------------------|------------|--------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |

The first production drift run may show false date mismatches; read its log lines and record them here.

## Retirement

| Field | Value |
|-------|-------|
| Retirement date (rollback no longer supported) | |
| Snapshots deleted | |

## SQL fixes

| Date | Batch ids | Reason | Dry-run count | Rows updated | Mirror replayed |
|------|-----------|--------|---------------|--------------|-----------------|
