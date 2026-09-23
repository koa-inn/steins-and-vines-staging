# Phase 82: Store-Agnostic Prerequisites - Context

**Gathered:** 2026-09-23
**Status:** Ready for planning

<domain>
## Phase Boundary

After this phase no browser code talks to Apps Script or the Google Sheets API for data — `js/admin.js` and `js/batch.js` go through session- or token-authenticated middleware endpoints; the Apps Script action surface loses its true zero-caller actions; `updateGiftCardInvoice` runs under the script lock and `createBatch`'s dedup guard sits inside the lock; and the owner answers the four pre-migration checks. No Postgres, no data-model change, no user-visible behaviour change — this is a seam so Phases 83–88 swap implementations behind the middleware instead of rewriting call sites.

</domain>

<decisions>
## Implementation Decisions

### Legacy action deletion (corrects the research)
- **D-01:** The research's "7 zero-caller actions" list is WRONG for this codebase. Verified live callers: `get_kits` (`js/admin.js:848` + `zoho-middleware/lib/brewpad-integration.js:122`), `get_holds`/`get_schedule` (`admin.js:850-851`, `loadAllData`), `get_reservations` (`admin.js:911`), `update_hold` (`admin.js:1811,1935`), `update_reservation` (`admin.js:2068,2141`), `update_homepage` (`admin.js:5149`). These are ROUTED through the middleware, not deleted.
- **D-02:** Delete ONLY the 4 true zero-callers and their `adminApi.gs` handlers: `get_config`, `update_schedule`, `update_kits`, `get_homepage`. Planner must re-grep (frontend, middleware, apps-script, tests) to confirm zero callers before deleting each. Success criterion 2's "7" becomes "4" — record the correction in the SUMMARY.
- **D-03:** Reservations/Holds/Kits stay alive for Phase 88 (roadmap already plans their deletion there). Owner is not sure the Reservations & Holds tab is still used — treat it as live; the owner-check task adds "recent activity in Reservations/Holds tabs".
- **D-04:** `get_kits` server-side (`brewpad-integration.js` kit-SKU registry, hourly refresh) stays as-is — it is already middleware → Apps Script via `server_token`, so it already satisfies the phase goal.

### Proxy shape & auth
- **D-05:** New sibling route `POST /api/admin/proxy` with its OWN hardcoded allowlist (admin.js's actions + the new ingredients read), sharing one extracted forwarding helper with `/api/batch/admin-proxy`. BrewPad's 17-action allowlist is untouched (`js/brewpad.js` zero changes). Never a free-form action passthrough; unknown action → 400 `invalid_action` before Apps Script is called.
- **D-06:** Auth = `authTiers.requireTiers(['legacy','session'])`, identity from `x-session-token` only (Phase 76 D-01..D-05 carried forward). `admin.js` stops sending the Google access token on data calls; Google token is used only at login. Proxy strips any client `token` and injects `server_token`.
- **D-07:** 401 handling follows Phase 76: re-login ONLY on a real middleware `res.status === 401`; the body-substring `isUnauthorizedError`/`handleUnauthorized` path on Apps Script responses is removed.
- **D-08:** Reads retry on [502,503,504]; writes are sent ONCE, never retried (proxy collapses upstream errors to 502 — a retried write can double-apply). This changes admin.js's current behaviour where `fetchWithRetry` retries writes.
- **D-09:** Every admin.js write that mutates a batch MUST include `batch_id` in the payload so Apps Script's `_invalidateBatchCache` busts `gb:<batchId>` (CacheService — shared by both proxies).
- **D-10:** No middleware caching — pure passthrough for parity. Revisit only if staging shows the admin dashboard load is slow.
- **D-11:** Read actions forwarded as GET, writes as POST (the Phase 76 hotfix rule — doGet's server_token bypass dispatches reads; doPost's if-chain only allowlists writes). Admin write actions not yet in the Apps Script doPost server_token allowlist (e.g. `update_reservation`, `update_hold`, `update_homepage`, `update_batch_task`, `add_batch_task`, `propagate_ferm_schedule`, `regenerate_batch_token` — planner verifies the exact list) are added there.

### Public batch page (`batch.html` / `js/batch.js`)
- **D-12:** Writes stay — staff use the page on the floor via the batch QR to tick tasks and submit plato readings.
- **D-13:** Dedicated token routes: `GET /api/batch/public/:id?token=…` (→ `get_batch_public`), `POST /api/batch/public/:id/tasks` (→ `update_batch_task` with `batch_token`), `POST /api/batch/public/:id/readings` (→ `bulk_add_plato_readings` with `batch_token`). Allowlist is exactly these 3 actions. Apps Script keeps validating the batch token as today — middleware does NOT validate tokens itself in this phase.
- **D-14:** Per-IP rate limit on these unauthenticated routes (reuse existing middleware rate-limit pattern). Auto-refresh polling interval unchanged; no cache.

### Direct Sheets API + dead fallbacks
- **D-15:** The live browser → Google Sheets API Ingredients read (`admin.js:863`, `sheetsGet(INGREDIENTS)`) moves behind `/api/admin/proxy` (new read action; planner chooses Apps Script handler vs. published CSV vs. other middleware read, preserving the data shape `parseSheetData(..., 'ingredients')` expects).
- **D-16:** Delete the direct-Sheets fallback code in admin.js — `sheetsGet`/`sheetsUpdate`/`sheetsAppend` (and any sibling), the `check_auth` calls inside them, the `loadAllData` fallback branch, and every `if (SHEETS_CONFIG.ADMIN_API_URL) … else <direct Sheets>` else-branch (holds/reservations/etc.). Removing `ADMIN_API_URL` without deleting these would flip execution into the fallbacks. After this, `check_auth` has no browser caller — delete it only if a grep confirms no other caller (otherwise leave it and note it).
- **D-17:** End state: `grep ADMIN_API_URL js/` finds no caller in `admin.js` or `batch.js`; whether `js/admin-config.js` itself is kept or removed is planner's call (check what else loads it — `brewpad.js`, html pages).

### Lock fixes
- **D-18:** `updateGiftCardInvoice` (`adminApi.gs:4847`) runs under `acquireScriptLock` (`:1252`); `createBatch`'s dedup guard (`:2129`) moves INSIDE the lock so check-then-append is atomic. Timeouts follow the existing 15 s convention.

### Rollout
- **D-19:** Order: (1) ONE owner Apps Script redeploy containing the new doPost allowlist entries + any new read action + both lock fixes + the 4 deletions — safe while the old browser path is still live because nothing with a caller is removed; record new AND rollback version numbers. (2) Push middleware + admin.js + batch.js to staging (`git push origin main`); walk the full admin surface (every tab, every write) and the public batch page (view, tick task, submit reading) live. Staging shares the prod workbook — use test records for writes. (3) Single gated prod cutover.
- **D-20:** Owner checks are a blocking human-checkpoint task in the FIRST wave, run in parallel with code work (no code depends on the answers): per-tab formulas / named ranges / pivots / charts; Apps Script → Executions filtered to failures, last 90 days; Railway plan + backup/PITR entitlement; live row count per sheet; recent activity in Reservations/Holds. Answers are written into the phase SUMMARY.

### Planning-time amendments (2026-09-23, owner-approved)
- **D-21:** Scope widened (Option A). ~15 admin.js functions call the Sheets API directly and UNCONDITIONALLY (not fallbacks): kit stock/on_hold updates inside the `update_hold` flow, manual hold modal, Kit Inventory/Ingredients saves/adds/deletes, Supplier Orders `syncOnOrder`/`acceptDelivery`, Scheduling slot generate/toggle/bulk/reset, `applyImport`, `loadHomepageData`. All move behind `/api/admin/proxy` via typed, allowlisted actions — never a generic cell writer. Proposed: keep `get_homepage` (gains a caller); replace `update_kits` with `update_inventory_cells` (sheet limited to Kits|Ingredients); add `append_inventory_row`, `import_kits`, `add_hold`, `append_schedule_slots`, `update_schedule_slots`. Row-index addressing kept for parity. This supersedes D-02's deletion list: delete `get_config` plus whichever of `update_schedule`/`update_kits` the new actions replace; D-16's helper deletion proceeds after the rewiring. Ingredients/Schedule/Homepage having no destination in Phases 83–88 is a milestone-level gap to raise separately.
- **D-22:** Owner explicitly approves (CLAUDE.md rule 10 exception) updating ONLY the admin.js settings block of `tests/frontend/admin-api-get-token.test.js` to the new D-06/D-07 behaviour, mirroring Phase 76-03's brewpad.js change; the shared test body stays untouched.
- **D-23:** `js/admin-config.js` stays (kiosk.html, brewpad.html load it); remove its script tag from admin.html and batch.html only. Every plan touching admin.js/batch.js runs `npm run build` (pages load `*.min.js`).

### Claude's Discretion
- Extraction/naming of the shared forwarding helper; rate-limit numbers; how admin.js's `adminApiGet`/`adminApiPost` are reshaped (preferred: keep their signatures and swap internals so the 55 call sites barely change).
- Parity test design per rewired action (roadmap requires one per action).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone & scope
- `.planning/ROADMAP.md` §"Phase 82: Store-Agnostic Prerequisites" (line ~1899) — goal + 4 success criteria (criterion 2's "7" corrected to 4 by D-02)
- `.planning/REQUIREMENTS.md` — DB-01
- `.planning/research/sheets-to-postgres-migration.md` §1.4 (admin-proxy seam), §2.1–2.2 (lock inventory + holes), §4 Stage 0, §8 (owner checks) — NOTE its zero-caller list is wrong, see D-01

### Prior decisions carried forward
- `.planning/phases/76-*/76-CONTEXT.md` + `76-VERIFICATION.md` — single-credential session auth, 401 rule, proxy GET/POST rule
- Memory note "BrewPad admin-proxy retry & cache" — 502 collapse, reads-retry/writes-don't, `batch_id` cache bust

### Code
- `js/admin.js:1-40` (x-session-token interceptor), `:648-730` (`adminApiGet`/`adminApiPost`), `:734-830` (direct Sheets helpers), `:838-900` (`loadAllData` + fallback)
- `js/batch.js` (406 lines — 3 Apps Script actions)
- `js/admin-config.js` (`ADMIN_API_URL`)
- `zoho-middleware/routes/pos.js:3980-4075` (`/api/batch/admin-proxy`, `ADMIN_PROXY_ACTIONS`, `ADMIN_PROXY_READS`)
- `zoho-middleware/lib/brewpad-integration.js:110-140` (`get_kits` registry — keep)
- `apps-script/adminApi.gs` — `doGet` `:71` (`get_batch_public` `:86`, server_token `:108`), `doPost` `:249` (server_token allowlist `:262-340`), `acquireScriptLock` `:1252`, `createBatch` `:2129`, `updateGiftCardInvoice` `:4847`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `/api/batch/admin-proxy` handler: auth gate, allowlist, token strip/inject, GET-vs-POST split, 502 collapse — extract into a helper for the sibling proxy.
- admin.js fetch interceptor already attaches `x-session-token` to every `MIDDLEWARE_URL` request.
- BrewPad's `fetchWithRetry` with `retryStatuses` (reads-only retry) — the pattern to mirror in admin.js.

### Established Patterns
- Hardcoded allowlists, never passthrough (T-76-02-01).
- Apps Script redeploys are manual owner steps; record rollback versions.
- Staging middleware auto-deploys on `git push origin main`; staging and prod share one workbook.

### Integration Points
- admin.js → `/api/admin/proxy`; batch.js → `/api/batch/public/*`; both → Apps Script with `server_token` (admin) or `batch_token` (public).
- `batch.html` must load whatever config supplies `MIDDLEWARE_URL` (check `js/sheets-config.js:55-70` hostname routing).
- CSP `connect-src` on `admin.html` / `batch.html` must allow the middleware origin (CLAUDE.md rule 12) — `script.google.com` can drop from those pages only if nothing else on them needs it.

</code_context>

<specifics>
## Specific Ideas

- Keep `adminApiGet(action, params)` / `adminApiPost(action, payload)` signatures; swap internals to call `/api/admin/proxy` so the 55 call sites stay put.
- The rollout must never leave a window where the browser calls an action Apps Script no longer accepts — hence Apps Script first (additive + only true-zero-caller deletions).

</specifics>

<deferred>
## Deferred Ideas

- Retiring the Reservations & Holds tab and the Reservations/Holds/Kits sheets — Phase 88 (pending owner confirmation of use).
- Rehoming the kit-SKU registry off the Kits sheet — Phase 88.
- Middleware-side batch-token validation — Phase 87 (Postgres batches).
- Caching admin reads / public batch GET — only if metrics show a need.

</deferred>

---

*Phase: 82-store-agnostic-prerequisites*
*Context gathered: 2026-09-23*
