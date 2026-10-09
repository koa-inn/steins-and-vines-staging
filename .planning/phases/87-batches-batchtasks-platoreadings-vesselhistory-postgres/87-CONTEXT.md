# Phase 87: Batches + BatchTasks + PlatoReadings + VesselHistory → Postgres - Context

**Gathered:** 2026-10-09
**Status:** Ready for planning

<domain>
## Phase Boundary

DB-06. The shop-floor core — `Batches`, `BatchTasks`, `PlatoReadings`, `VesselHistory` — moves to
relational, indexed, transactional Postgres storage in **one rehearsed Sunday maintenance-window
cutover** (no dual-write window, unlike 84/85/86), with:
- `deleteBatch`'s 3-sheet cascade replaced by FKs `ON DELETE CASCADE`; `SV-B-` / `PR-` IDs
  sequence-backed (existing IDs kept);
- dashboard / calendar / upcoming / location-conflict reads as indexed SQL;
- all batch actions on `/api/batch/admin-proxy` (BrewPad, 17 actions) and `/api/admin/proxy`
  (admin.js) swapped server-side — **`js/brewpad.js` unchanged**;
- the public token-authenticated `batch.html` path (`/api/batch/public/:id` read + tasks + readings
  writes) and the kiosk/online sale → batch creation path (`brewpad-integration.createBatchesFromSale`)
  working on the new store;
- Zoho `cf_batch_status` sync behaviour unchanged.

Out of this phase: Waitlist sheet (see Deferred), any new batch-editing UI, any behaviour change
to the public batch page.

</domain>

<decisions>
## Implementation Decisions

### Design gate
- **D-01:** The **first plan (87-01) writes `87-DESIGN.md`** — schema, FKs/cascade, indexes mapped
  to each dashboard/calendar/upcoming/conflict query, the public batch-token read/write path, Zoho
  reconcile hooks, the mirror shape, and the cutover runbook outline (window, steps, verification,
  rollback). It ends at a **blocking human checkpoint**; no implementation plan runs until the
  owner approves it (success criterion 1).

### Cutover window & live sales
- **D-02:** Production cutover runs **Sunday evening after close**, completed before Monday open.
- **D-03:** Runbook budgets a **2-hour window** (snapshot → backfill → verify counts + dashboard
  parity → flip → smoke), leaving room for one rollback inside it. The staging rehearsal measures
  the real duration; if it doesn't comfortably fit, the runbook must say so before the date is set.
- **D-04:** **Sales keep flowing during the window.** Kiosk/online payment and the Zoho invoice
  proceed normally; batch creation that can't be written during the freeze fails/skips and is
  **logged**. After cutover, staff run BrewPad's existing **Scan invoices**
  (`/api/batch/scan-invoices`) to create the missing batches. No new queue/replay code. The runbook
  includes this scan as a post-window step with the list of invoices taken during the window.
- **D-05:** During the window, BrewPad / admin batch screens / `batch.html` are **read-only**:
  reads keep working; batch writes return a clear server-side "maintenance until HH:MM" error that
  existing client error handling already displays. Server-side only — no `brewpad.js` change.

### Go/no-go & rollback
- **D-06:** **Strict no-go bar inside the window** — any one of these forces rollback to the sheet:
  a non-empty rejects file, any per-table row-count mismatch, any dashboard number differing from
  the pre-cutover snapshot, or any failed smoke write (create batch, mark task, add reading,
  vessel transfer).
- **D-07:** Rollback to the sheet stays a **supported, rehearsed option for one full week** after
  go-live. After 7 clean days Postgres is the sole record and rollback is retired.
- **D-08:** During that week, a **daily verify run** (Postgres vs mirrored sheet, all four tables)
  alerts on drift, and **any rollback first runs replay-to-sheet** so no Postgres-era write is lost.
  Reuse the 84/85/86 verify + replay tooling pattern.
- **D-09:** The window is run by **owner + Claude**: Claude runs the scripted steps and reports each
  check; the **owner makes the go/no-go call** and does the live BrewPad/kiosk smoke (Google sign-in).

### Sheet after cutover & data fixes
- **D-10:** **All four tables keep a production fire-and-forget sheet mirror** indefinitely
  (milestone decision; also required for D-07/D-08). Staging never mirrors.
- **D-11:** Hand data fixes (INV-000171-style backfills) go through **Claude running a reviewed SQL
  fix**: dry-run SELECT, then the UPDATE in a transaction, logged. The phase adds a short RUNBOOK
  recipe for this. No new admin edit UI.
- **D-12:** Each of the four mirrored tabs gets a **"mirror only — edits are ignored/overwritten"
  notice plus protected ranges** (warn on edit), the same pattern 86 used for Config.

### Scope edges & ordering
- **D-13:** **Production cutover waits for Phase 86's production flip** (`OPS_DATA_STORE=postgres`),
  so batch create/transfer and vessel status are written in one transaction and the
  one-production-window-at-a-time rule holds. Design, code, tooling and the staging rehearsal may
  proceed now.
- **D-14:** The public `batch.html` path stays **identical**: same URLs, same existing tokens (printed
  QR codes keep working), same read + task-update + add-reading abilities. Tokens must remain
  retrievable (admin/BrewPad re-display them for QR printing), so they cannot be one-way hashed.
- **D-15:** `create_batch` gets **server-side idempotency** in Postgres (DB constraint / idempotency
  key, porting and strengthening the sheet dedup guard) so a BrewPad network-retry or a re-sent kiosk
  hook never produces two batches. No `brewpad.js` change.

### Claude's Discretion
- Table/column design, ID sequences seeded past existing max, migration naming (`0005_*`), store
  facade layout (one batch store vs per-table), mirror payload shape.
- How the "maintenance" freeze is switched (store-flag value, env var, or Redis key) — pick what
  rolls back fastest.
- How to place the D-12 sheet notice without breaking header-row parsing in backfill/mirror/verify
  (e.g. a note on the header cell instead of an inserted row).
- Whether dashboard-parity comparison is a script diffing `get_batch_dashboard_summary` /
  calendar / upcoming JSON before vs after, and what the pre-cutover snapshot captures.
- Handling of test/probe rows found by research in the four tabs: backfill as-is unless clearly
  safe to drop; surface in the rehearsal plan.
- Cache invalidation for Postgres-backed batch reads (the existing Apps Script `_cachedGet` / `gds`
  key gaps should not be reproduced).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone and requirement
- `.planning/ROADMAP.md` — Phase 87 goal + 4 success criteria; Phase 88 (retire legacy sheets)
- `.planning/REQUIREMENTS.md` — DB-06
- `.planning/research/sheets-to-postgres-migration.md` §1.2 (rows 4–7: Batches/BatchTasks/PlatoReadings/VesselHistory writers, readers, lock status), §1.4 (admin-proxy seam), §4 Stage 5, §6 (sheet-as-staff-UI cost, mirror mitigation)

### Pattern to copy (Phases 84/85/86)
- `.planning/phases/86-vessels-fermschedules-config-postgres/86-CONTEXT.md` — mirror, stale-save, store flag, one-window-at-a-time decisions
- `.planning/phases/85-recipes-recipeingredients-postgres/85-CONTEXT.md` — dual/mirror/stale-save/flip-bar pattern
- `.planning/phases/85-recipes-recipeingredients-postgres/85-12-SUMMARY.md` — staging rehearsal shape and UAT gotchas
- `zoho-middleware/lib/store-flag.js`, `lib/sheet-mirror.js`, `lib/ops-mirror.js`, `lib/ops-proxy.js` — flag helper, mirror worker, proxy intercept hook
- `zoho-middleware/lib/vessel-store.js`, `lib/vessel-pg.js`, `lib/ferm-schedule-store.js`, `lib/ferm-schedule-pg.js` — vessels/schedules the batch code must join and transact with
- `zoho-middleware/lib/recipe-store.js`, `lib/recipe-pg.js`, `lib/recipe-mirror.js` — store facade / atomic SQL / mirror structure
- `zoho-middleware/migrations/0001..0004_*.sql`, `scripts/migration-allowlist.js` — migration conventions and guards
- `zoho-middleware/scripts/backfill/` (incl. `README.md`) — backfill / verify / replay tooling
- `docs/RUNBOOK.md` — Apps Script deploy table, 84/85/86 cutover sections

### Current batch code (what is being replaced)
- `apps-script/adminApi.gs` — `checkLocationConflict` (~L1802), `getBatches` (~L1934), `getBatchDetail` (~L1992), `getTasksCalendar` (~L2198), `getTasksUpcoming` (~L2265), `getBatchDashboardSummary` (~L2314), `createBatch` (~L2604, dedup guard, task generation, VesselHistory), `updateBatch` (~L2817, transfers), `deleteBatch` (~L2984, cascade), `updateBatchSchedule` (~L3033), `updateBatchTask` / `bulkUpdateBatchTasks` / `addBatchTask` (~L3151–3345), `handlePackagingCompletion/Uncompletion` (~L3346–3411), plato readings (~L3412+), `regenerateBatchToken` (~L3895), `get_batch_public`
- `zoho-middleware/routes/pos.js` — `ADMIN_PROXY_ACTIONS` (~L4062), `/api/batch/admin-proxy` (~L4110), `ADMIN_PANEL_PROXY_ACTIONS` + `/api/admin/proxy` (~L4145–4215), `/api/batch/public/:id` + `/tasks` + `/readings` (~L4243–4274), `/api/batch/scan-invoices` (~L3259), batch update / bottling-invite `update_batch` callers (~L3753, ~L3925), cf_batch_status reconcile (~L3007–3100)
- `zoho-middleware/lib/brewpad-integration.js` — `createBatchesFromSale` (~L345, fire-and-forget create_batch), cf_batch_status label/reconcile (~L469–800)
- `zoho-middleware/routes/checkout.js` (~L682) — online sale → batch creation
- `js/batch.js` — public batch page client (must not change behaviour)
- `js/admin.js` — batch tab, QR modal re-displaying `access_token` (~L5453, ~L5685), `regenerate_batch_token` (~L5923)
- `js/brewpad.js` — consumer only; MUST remain unchanged
- `docs/DATA-MODEL.md` — Batches / BatchTasks / PlatoReadings / VesselHistory tab columns (~L109–190)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `opsProxy.intercept(...)` is already called on both proxies before `forwardToAppsScript`; batch actions can be served from Postgres through the same hook (or a sibling batch intercept).
- Phase 86 vessel/schedule stores: `create_batch` already pulls schedule steps from Postgres (`ferm-schedule-store.js` ~L117, `ops-proxy.js` ~L82).
- 84/85/86 backfill → verify → replay CLIs and the sheet-mirror worker.
- `/api/batch/scan-invoices`: existing recovery path for sales that got no batch (D-04).

### Established Patterns
- Per-store flag (`sheets|dual|postgres`); here the flag goes `sheets → postgres` directly at the window (no dual), plus the D-05 freeze state.
- Production-only fire-and-forget mirror; staging never mirrors; staging and prod share one workbook, so a staging rehearsal must use a **fresh workbook snapshot**, never write the live sheet.
- Additive-only migrations enforced by `migrate:guard` + parser allowlist.
- Reads may retry through the proxy; writes must not (proxy collapses upstream errors to 502).

### Integration Points
- Vessel status changes on create/transfer/complete → transactional with `vessels` (D-13).
- `createBatchesFromSale` (kiosk `pos.js` ~L1838, ~L2694; online `checkout.js` ~L682) → new store, idempotent (D-15).
- Zoho `cf_batch_status` reconcile reads the live batch set → must read Postgres after cutover.
- Bottling-invite stamp + optimistic-lock `update_batch` (pos.js ~L3753) → preserve the optimistic-lock semantics.

</code_context>

<specifics>
## Specific Ideas

- Sunday-evening window, owner on hand for the go/no-go and the live smoke.
- "Every dashboard number matches the pre-cutover snapshot" is a hard gate, not a goal.
- The rollback week is guarded by a daily drift check, not by hope.

</specifics>

<deferred>
## Deferred Ideas

- **Waitlist sheet → Postgres:** not assigned to any 82–88 phase but rides the same admin proxy.
  Owner decision: add it to **Phase 88 scope** (or its own small phase). Update ROADMAP Phase 88 accordingly.
- **Admin batch-edit / correction UI** or a read-only SQL console: not now; revisit if the D-11 SQL-fix
  recipe gets used often.
- **Making the public batch page read-only:** not proposed; any change would be its own decision.

### Reviewed Todos (not folded)
- `brewpad-bottled-status-stale-ui`, `brewpad-ready-to-bottle-filter`: need `brewpad.js` changes (forbidden in this phase); they belong to Phase 69. Postgres reads should not reproduce the `gds` cache-bust gap.
- `brewpad-writes-retry-once`: client change not done here; D-15 makes `create_batch` server-idempotent, which covers the riskiest retried write.
- `admin-write-attribution-kiosk-middleware`: already folded into Phase 86; Postgres batch writes record the real staff email directly.
- Beer/cider launch pages, GA4 staging pollution, gated-deploy branch safety: keyword-only matches, unrelated.

</deferred>

---

*Phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres*
*Context gathered: 2026-10-09*
