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

Rehearsal run 1 (2026-10-09, started 13:36 PDT; Claude ran the scripts, owner did browser checks
until Claude piloted Chrome):

- 13:36 `BATCHES_FREEZE=15:00` set; redeploy live 13:40 (about 3.5 min). Freeze checks: BrewPad task tick
  refused (503) but BrewPad shows a generic "Save failed - try again" toast, not the maintenance text
  (brewpad.js is locked, so staff must be told about the window in advance); admin task complete refused
  with the maintenance message; public batch POST refused 503. Reads loaded normally.
- 13:46 snapshot 1. Tails check: no blank-id rows holding data in any of the four tabs.
- 13:47:30 dry run: 0 rejects; 204 / 1064 / 70 / 427; seeds 235 / 1079 / 72 / 429.
- 13:47:52 promote into staging Postgres (service `Postgres`, via SSH tunnel): ok, 10 invariants passed.
- 13:48:40 snapshot 2 + `batches-verify`: headers match, counts match, 0 orphans, 0 mismatches.
- 13:49:10 `batches-parity`: **NO-GO, 175 differences**, all `get_batches data.batches[].product_sku`:
  Sheets stores all-digit SKUs as number cells (Apps Script emits a JSON number) while `serializeBatch`
  emitted text. Fixed in `5935a5b1` (regression test first; full suites green).
- 13:51:58 parity re-run with the fix (Postgres side computed locally): 0 differences (5 reads).
- 13:51 and 14:04 staging builds of `5935a5b1` FAILED on Railway: Docker Hub `429 Too Many Requests`
  pulling a base image (platform rate limit, not code). Flip held until a build succeeds.
- 14:10 third build failed the same way. Owner chose to pause: `BATCHES_FREEZE` deleted 14:13, but the
  running container keeps it until a redeploy (CLI restart/redeploy refused while the newest deployment
  is a failed build). Staging stays on sheets (`BATCHES_STORE` unset). Background build retries every
  10 min. Staging Postgres still holds the 13:47 promote and goes stale as production writes the sheet.

**Resume plan (run 1 continued):** once a staging build of `5935a5b1` (or later) succeeds and the
freeze is gone: set `BATCHES_FREEZE` again -> empty the four staging batch tables -> fresh snapshot ->
dry run/promote -> fresh snapshot + verify -> parity (after the 300 s cache) -> flip
(`BATCHES_STORE=postgres`, freeze removed in one change) -> `/health` -> post-flip parity via proxy.
Record the re-run timings separately; the 13:36-13:52 timings above are a valid first measurement of
steps 3-6.

Rehearsal run 2 (2026-10-09, after a successful staging build of `5935a5b1` at 14:54):

- 15:04 owner snapshot 1 (taken just before the freeze; snapshot 2 + verify cover the gap).
- 15:04:40 `BATCHES_FREEZE=16:00` set; freeze live 15:09:50 (redeploy ~5 min).
- 15:04:58 the six staging batch tables emptied (204/1064/70/427 -> 0) inside one transaction.
- 15:05:04 dry run: tails clean, 0 rejects, 204 / 1064 / 70 / 427, seeds 235 / 1079 / 72 / 429.
- 15:10:50 promote (owner confirmed DB name): ok, invariants passed.
- 15:10:57 snapshot 2 (owner, 15:10, after the freeze) + verify: headers match, counts match, 0 orphans,
  0 mismatches.
- 15:15:27 parity (after the 300 s cache): **0 differences (5 reads)**. Go.
- 15:15:44 flip variables set; no redeploy triggered (CLI gotcha); `railway redeploy` 15:26:01; staging
  live on `BATCHES_STORE=postgres` 15:27:54 (startup log `store modes` line), freeze gone, `/health` ok.
- ~15:33 post-flip parity via `/api/admin/proxy` against the 15:15 snapshot (owner ran it with the
  session token): **0 differences (5 reads), EXIT 0**.
- D-12 notices deliberately not applied on staging: the workbook is shared with production.

Task 3 UAT on staging in Postgres mode (2026-10-09 15:30-15:48; Claude drove Chrome, owner signed in):

| # | Check | Result |
|---|-------|--------|
| 1 | BrewPad: dashboard; create test batch SV-B-000236 (no customer, no invoice) on CON-001 with the 4 Week Wine template; tick tasks; transfer to COR-001 B/05; add + edit a reading; schedule edit; packaging completes; delete | PASS. Create `[batch-proxy] create_batch ms=54`; CON-001 In-Use then Empty after the move; history VH-000431 recorded the old location; status primary -> secondary on racking -> complete on packaging with COR-001 Empty; reading 22.0 edited to 21.5; `update_batch_schedule` ok (4 updated; keeps flags, recomputes due dates, same as Apps Script); delete cascaded tasks/readings/history, wrote a tombstone, cleared dedup. |
| 2 | Admin: list, calendar, upcoming, detail, QR, regenerate token | PASS. Old token -> `invalid_token`, new token loads. Dashboard chips (5 overdue, 11 ready to package) correct. |
| 3 | batch.html with the batch's token: load, tick a task, add a reading; another batch's task refused | PASS. Packaging checkbox disabled for public; BT-001077 (SV-B-000235) refused "Task does not belong to this batch" (Q8). |
| 4 | Scan invoices twice | SKIPPED on staging: staging and production share the Zoho org (same ZOHO_ORG_ID / CF_BATCH_STATUS), so staging batches for real invoices could write cf_batch_status on real invoices. Covered by code tests; runs for real in the production window (step 11). |
| 5 | Double submit of a manual create | PASS (UI): BrewPad's Create button locks after the first click, so one request and one batch. Server-side replay protection covered by the 87-07 concurrency tests. |
| 6 | Rollback rehearsal | PASS. `batches-replay-to-sheet --since=2026-10-09T22:27:54Z` dry run: 1 request (0 state, 1 delete for the test tombstone), no HTTP sent. `BATCHES_STORE` unset + `railway redeploy` 15:44:57 -> `store modes ... "BATCHES_STORE":"sheets"` 15:48:00 (~3 min); BrewPad lists from the sheet again. |

create_batch latency: one sample, 54 ms (SC4 median needs more samples; collect in production smoke).
Observation (pre-existing, matches Apps Script via parity): BrewPad dashboard "Avg days to complete" shows 165, equal to the completed count.

| Step | Target (min) | Measured (min) | Result |
|------|--------------|----------------|--------|
| 3 Freeze + restart + check | 5 | 5 | ok |
| 4 Snapshot, dry run, promote | 20 | 3 | ok, 0 rejects |
| 5 Second snapshot + verify | 10 | 1 | ok, 0 mismatches |
| 6 Parity (after 300 s cache expiry) | 10 | 5 | ok, 0 differences (run 1: no-go, sku typing, fixed) |
| 8 Flip + health + boot lines | 5 | 2 (+11 lost to the redeploy gotcha) | ok; post-flip proxy parity 0 differences |
| 9 D-12 notices | 3 | n/a | skipped on staging (shared workbook) |
| 10 Smoke | 20 | | |
| 11 Scan invoices | 10 | | |

| Check | Result |
|-------|--------|
| Row counts (batches / batch_tasks / plato_readings / vessel_history) | 204 / 1064 / 70 / 427 (sheet = Postgres) |
| Rejects (must be 0) | 0 |
| `batches-verify.js` (0 mismatches) | 0 mismatches |
| `batches-parity.js` (parity: 0 differences) | 0 pre-flip; 0 post-flip via proxy |
| Smoke: create batch, mark task, add reading, vessel transfer | PASS (staging, Task 3 table above) |
| Rollback rehearsal (replay, verify, notices removed, flag back) | PASS: replay dry run 1 request; flag back to sheets ~3 min; notices n/a on staging |
| Fits the 2-hour budget with room for one rollback? | Yes: steps 3-8 took ~30 min; smoke and scan invoices still to measure in Task 3 |

## Production prerequisites

| Check | Evidence | Date |
|-------|----------|------|
| Phase 86 production flip recorded (`OPS_DATA_STORE=postgres`, Q14/D-13) | 86-DUAL-LOG "Flip decision" + "Post-flip verification"; flipped in the same change that set the freeze (combined variant) | 2026-10-27 |
| Apps Script v62 deployed, rollback v61, editor-drift check | v62 live; pre-paste drift check skipped, post-paste hash matched repo; probes ok | 2026-10-09 |
| Staging rehearsal complete and within budget | Run 2: 0 rejects, 0 mismatches, 0 parity differences, steps 3-8 ~30 min (see above) | 2026-10-09 |
| Q1 orphan task rows BT-000567..570 deleted | Owner deleted the 4 rows; `export_batch_tabs` re-check shows 0 orphans in BatchTasks, PlatoReadings, VesselHistory (re-confirm before the production dry run) | 2026-10-09 |
| Q3 Apps Script timezone confirmed | Owner confirmed America/Vancouver. Caveat: Node 20.20.2 ships tzdata 2025c and will treat Vancouver as UTC-8 from 2026-11-01 (BC is permanently UTC-7). Must be fixed before the production window; see todo node-tzdata-bc-permanent-time. **Resolved:** production on Node 24.21 since 2026-10-16 | 2026-10-09 |
| Pinned production SHA | No deploy for the window. Production code `47fcd354`+ (prod-20261022-1, Railway `e7776fc9`) already carried the Phase 87 code; window used variable-only redeploys | 2026-10-27 |
| Migration 0005 and inert Phase 87 code on production | 0005 applied 2026-10-17 (prod-20261017-1); all 6 batch tables were 0 rows before the promote | 2026-10-27 |
| Window date and time agreed with owner | Owner: "lets do it now, brewpad can afford to be down" (Tue, shop open, daytime) | 2026-10-27 |

## Production window

| Field | Value |
|-------|-------|
| Freeze set at (`BATCHES_FREEZE`) | T0 2026-10-27T18:13:39Z (`BATCHES_FREEZE="1:30 PM"`, set 18:11:21Z with the 86 flip; deploy `fd9fb39e`) |
| Flip at (`BATCHES_STORE=postgres`) | T1 2026-10-27T18:34:09Z (set + `BATCHES_FREEZE` deleted + `railway redeploy`); deploy `90dfb9c1` live 18:40:18Z |
| Window closed at | T2 ~2026-10-27T19:05Z after smoke + test batch delete. Batch writes frozen ~27 min (18:13:39 → 18:40:18) |

Timeline:

| Step | Start | End | Notes |
|------|-------|-----|-------|
| 5a Freeze (combined with 86 flip) | 18:11Z | 18:13Z | deploy `fd9fb39e` |
| 5c Snapshot S4 | 18:15Z | | owner download, sha `fad92bb1` |
| 5d Dry run | 18:16Z | | 214 / 1106 / 72 / 440, 0 rejects, seeds 245/1121/74/442 |
| 5e Promote | 18:16Z | | exit 0, sequences 245/1121/74/442 |
| 5g Parity (pre-flip) | ~18:17Z | | 0 differences (5 reads); snapshot copied to `~/sv-backfill/pre-cutover-2026-10-27.json` (mode 600) |
| 5f Verify on S5 (post-promote snapshot, 11:24 PDT, sha `5ae19af9`) | ~18:25Z | | headers match, counts equal, 0 orphans, 0 mismatches |
| 5i Flip | 18:34Z | 18:40Z | deploy `90dfb9c1`; store modes all postgres; drift check registered |
| 5k Post-flip parity via proxy | ~18:42Z | | 0 differences (5 reads); session token via clipboard, never printed |
| 5l Smoke | 18:43Z | ~19:05Z | see below |
| 5j D-12 notices (`setupBatchMirrorNotices`) | | | **owner action pending** |

Go/no-go record (D-06):

| Gate | Result |
|------|--------|
| Dry run: 0 rejects | PASS |
| Row counts equal | PASS (214 / 1106 / 72 / 440) |
| `batches-verify.js` 0 mismatches | PASS |
| `batches-parity.js` 0 differences | PASS (pre-flip and post-flip) |
| Owner go/no-go decision and time | GO, ~18:33Z ("lets do ettt") |
| Smoke: create batch / mark task / add reading / vessel transfer | PASS. SV-B-000246 (internal, FS-0001, LFB-009) created in BrewPad, `create_batch ms=79`; task tick, reading (20 °P) and transfer to LFB-008 saved; vessel statuses flipped (LFB-008 In-Use, LFB-009 Empty); history row carries the OLD vessel by design. Sheet mirror row confirmed by owner. Admin: customer page loaded, Regenerate URL → old token "Invalid access token", new token loads. Deleted from admin: PG rows 0, tombstone 1, both vessels Empty, 214 batches, 0 dirty markers, no errors in logs |

Invoices taken during the window (numbers only):

| Invoice | Batch created by | Notes |
|---------|------------------|-------|
| none | - | The freeze deployment `fd9fb39e` logged no POST requests at all between 18:13Z and 18:40Z (no sales, no refused creates) |

Scan invoices result: not run; nothing to recover.

## Next-business-day smoke (SC4)

| Check | Result |
|-------|--------|
| Kiosk and POS sales created batches | |
| `create_batch` median ms from `[batch-proxy] create_batch ms=<n>` logs | |
| Printed `batch.html` tokens open | |

## Rollback week

| Day | Date | Drift check (`[batches-drift]` line or Sentry) | Explained? | Action |
|-----|------|-----------------------------------------------|------------|--------|
| 1 | 2026-10-28 | No run. The 24 h timer restarts on every deploy, and production redeployed 10-27 19:52 PT and 10-28 13:07 PT. | n/a | Recorded on 11-03 from Railway deployment history |
| 2 | 2026-10-29 | No run (deploy 10-29 12:23 PT before the timer reached 24 h). | n/a | as above |
| 3 | 2026-10-30 | No run (deploys 10:54, 11:13, 11:20 PT). Timer registered 18:22:32Z on deploy `6aae93bd`. | n/a | as above |
| 4 | 2026-10-31 | 18:22Z `Headers: match` + 49 `batches SV-B-0000NN missing_in_sheet` lines (log capped at 50); Sentry `batches drift detected` | Yes: false positive (check bug) | See "Drift check false positive" below |
| 5 | 2026-11-01 | 18:22Z identical to day 4 (same 49 ids) | Yes: same false positive | as above |
| 6 | 2026-11-02 | 18:22Z identical to day 4 (same 49 ids) | Yes: same false positive | as above |
| 7 | 2026-11-03 | Manual `batches-verify` at 18:12:12Z in-container against an owner snapshot (sha256 `7e39b1dcbcaab688`, checked on both ends): headers match; counts 218 / 1125 / 72 / 446 equal; 0 orphans; **0 mismatches** (exit 0) | Yes: clean | Owner chose verify-then-retire |

### Drift check false positive (found 2026-11-03)

- `export_batch_tabs` returns true date cells over JSON as ISO timestamps (`2026-01-15T08:00:00.000Z`).
  `normalizeDateOnly` only accepts `YYYY-MM-DD` strings or `Date` objects, so rows were rejected and
  then reported as `missing_in_sheet`. The drift check ignores `rejects`, so it never said why.
- A read-only export pull on 11-03 (reject counts only, no values) showed: Batches `start_date`
  invalid_date 216 of 218; BatchTasks `due_date` invalid_date 910; every child row then `orphan_parent`.
  The sheet itself had all 218 / 1125 / 72 / 446 rows.
- So days 4–6 proved nothing either way. Day 7's snapshot verify is the real evidence. The fix
  (parse ISO timestamps to an America/Vancouver date, and report rejects) is a follow-up quick task
  with a regression test first. Until it ships the check raises a false Sentry alert every day.

The first production drift run may show false date mismatches; read its log lines and record them here.

## Retirement

| Field | Value |
|-------|-------|
| Retirement date (rollback no longer supported) | **2026-11-03** (owner decision in-session, after the day-7 verify). Postgres is the sole batch record; the sheet stays a production mirror with notices. |
| Snapshots deleted | `~/sv-backfill/pre-cutover-2026-10-27.json` deleted 2026-11-03; the in-container verify copy removed. All `~/sv-backfill/` workbook snapshots (.xlsx), `staging-94-parity.json` and the `out-*` folders deleted 2026-11-03 (owner OK); small dry-run/reject logs kept. |

## SQL fixes

| Date | Batch ids | Reason | Dry-run count | Rows updated | Mirror replayed |
|------|-----------|--------|---------------|--------------|-----------------|
| 2026-10-27 22:19Z | all 215 (SV-B-000001..000247) | Phase 94 B3: set `batch_type` + `batch_type_source` (`batch-type-backfill.js --apply --expect=215`, trusted channel, owner OK) | 215 | 215 | yes, 215/215 (finished 23:15Z); verify 0 mismatches at 23:28Z |
| 2026-10-27 23:30Z | 40 (SV-B-000002..000057) | Phase 94 B2: set missing `completed_at` from task completion, source `backfill-task` (`completed-at-backfill.js --apply --expect=40`, owner OK) | 40 | 40 | yes, 40/40 (finished 23:42Z); verify 0 mismatches at 01:33Z |
| 2026-10-28 20:27Z | 20 (Koa Inn 11 + Paul McLachlan 9; 10 customer batches excluded) | Phase 95 staff_batch backfill (`staff-batch-backfill.js --apply --exclude=<10> --expect=20 --expect-ids=79e38cb5f22c`, apply start 2026-10-28T20:27:42Z), owner OK in session, no last_updated bump | 20 | 20 | no replay needed (Postgres-only column, last_updated unchanged); verify 0 mismatches at ~20:29Z |
