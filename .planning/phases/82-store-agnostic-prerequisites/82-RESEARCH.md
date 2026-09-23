# Phase 82: Store-Agnostic Prerequisites - Research

**Researched:** 2026-09-23
**Domain:** Frontend-to-backend transport migration (direct Apps-Script calls → middleware proxy), Apps-Script action-surface trimming, Apps-Script lock/atomicity hardening
**Confidence:** HIGH (every claim below is grounded in file:line evidence from this repo, re-verified live during this research session; no external library research was needed — this phase adds zero new dependencies)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Legacy action deletion (corrects the research)
- **D-01:** The research's "7 zero-caller actions" list is WRONG for this codebase. Verified live callers: `get_kits` (`js/admin.js:848` + `zoho-middleware/lib/brewpad-integration.js:122`), `get_holds`/`get_schedule` (`admin.js:850-851`, `loadAllData`), `get_reservations` (`admin.js:911`), `update_hold` (`admin.js:1811,1935`), `update_reservation` (`admin.js:2068,2141`), `update_homepage` (`admin.js:5149`). These are ROUTED through the middleware, not deleted.
- **D-02:** Delete ONLY the 4 true zero-callers and their `adminApi.gs` handlers: `get_config`, `update_schedule`, `update_kits`, `get_homepage`. Planner must re-grep (frontend, middleware, apps-script, tests) to confirm zero callers before deleting each. Success criterion 2's "7" becomes "4" — record the correction in the SUMMARY.
- **D-03:** Reservations/Holds/Kits stay alive for Phase 88 (roadmap already plans their deletion there). Owner is not sure the Reservations & Holds tab is still used — treat it as live; the owner-check task adds "recent activity in Reservations/Holds tabs".
- **D-04:** `get_kits` server-side (`brewpad-integration.js` kit-SKU registry, hourly refresh) stays as-is — it is already middleware → Apps Script via `server_token`, so it already satisfies the phase goal.

#### Proxy shape & auth
- **D-05:** New sibling route `POST /api/admin/proxy` with its OWN hardcoded allowlist (admin.js's actions + the new ingredients read), sharing one extracted forwarding helper with `/api/batch/admin-proxy`. BrewPad's 17-action allowlist is untouched (`js/brewpad.js` zero changes). Never a free-form action passthrough; unknown action → 400 `invalid_action` before Apps Script is called.
- **D-06:** Auth = `authTiers.requireTiers(['legacy','session'])`, identity from `x-session-token` only (Phase 76 D-01..D-05 carried forward). `admin.js` stops sending the Google access token on data calls; Google token is used only at login. Proxy strips any client `token` and injects `server_token`.
- **D-07:** 401 handling follows Phase 76: re-login ONLY on a real middleware `res.status === 401`; the body-substring `isUnauthorizedError`/`handleUnauthorized` path on Apps Script responses is removed.
- **D-08:** Reads retry on [502,503,504]; writes are sent ONCE, never retried (proxy collapses upstream errors to 502 — a retried write can double-apply). This changes admin.js's current behaviour where `fetchWithRetry` retries writes.
- **D-09:** Every admin.js write that mutates a batch MUST include `batch_id` in the payload so Apps Script's `_invalidateBatchCache` busts `gb:<batchId>` (CacheService — shared by both proxies).
- **D-10:** No middleware caching — pure passthrough for parity. Revisit only if staging shows the admin dashboard load is slow.
- **D-11:** Read actions forwarded as GET, writes as POST (the Phase 76 hotfix rule — doGet's server_token bypass dispatches reads; doPost's if-chain only allowlists writes). Admin write actions not yet in the Apps Script doPost server_token allowlist (e.g. `update_reservation`, `update_hold`, `update_homepage`, `update_batch_task`, `add_batch_task`, `propagate_ferm_schedule`, `regenerate_batch_token` — planner verifies the exact list) are added there.

#### Public batch page (`batch.html` / `js/batch.js`)
- **D-12:** Writes stay — staff use the page on the floor via the batch QR to tick tasks and submit plato readings.
- **D-13:** Dedicated token routes: `GET /api/batch/public/:id?token=…` (→ `get_batch_public`), `POST /api/batch/public/:id/tasks` (→ `update_batch_task` with `batch_token`), `POST /api/batch/public/:id/readings` (→ `bulk_add_plato_readings` with `batch_token`). Allowlist is exactly these 3 actions. Apps Script keeps validating the batch token as today — middleware does NOT validate tokens itself in this phase.
- **D-14:** Per-IP rate limit on these unauthenticated routes (reuse existing middleware rate-limit pattern). Auto-refresh polling interval unchanged; no cache.

#### Direct Sheets API + dead fallbacks
- **D-15:** The live browser → Google Sheets API Ingredients read (`admin.js:863`, `sheetsGet(INGREDIENTS)`) moves behind `/api/admin/proxy` (new read action; planner chooses Apps Script handler vs. published CSV vs. other middleware read, preserving the data shape `parseSheetData(..., 'ingredients')` expects).
- **D-16:** Delete the direct-Sheets fallback code in admin.js — `sheetsGet`/`sheetsUpdate`/`sheetsAppend` (and any sibling), the `check_auth` calls inside them, the `loadAllData` fallback branch, and every `if (SHEETS_CONFIG.ADMIN_API_URL) … else <direct Sheets>` else-branch (holds/reservations/etc.). Removing `ADMIN_API_URL` without deleting these would flip execution into the fallbacks. After this, `check_auth` has no browser caller — delete it only if a grep confirms no other caller (otherwise leave it and note it).
- **D-17:** End state: `grep ADMIN_API_URL js/` finds no caller in `admin.js` or `batch.js`; whether `js/admin-config.js` itself is kept or removed is planner's call (check what else loads it — `brewpad.js`, html pages).

#### Lock fixes
- **D-18:** `updateGiftCardInvoice` (`adminApi.gs:4847`) runs under `acquireScriptLock` (`:1252`); `createBatch`'s dedup guard (`:2129`) moves INSIDE the lock so check-then-append is atomic. Timeouts follow the existing 15 s convention.

#### Rollout
- **D-19:** Order: (1) ONE owner Apps Script redeploy containing the new doPost allowlist entries + any new read action + both lock fixes + the 4 deletions — safe while the old browser path is still live because nothing with a caller is removed; record new AND rollback version numbers. (2) Push middleware + admin.js + batch.js to staging (`git push origin main`); walk the full admin surface (every tab, every write) and the public batch page (view, tick task, submit reading) live. Staging shares the prod workbook — use test records for writes. (3) Single gated prod cutover.
- **D-20:** Owner checks are a blocking human-checkpoint task in the FIRST wave, run in parallel with code work (no code depends on the answers): per-tab formulas / named ranges / pivots / charts; Apps Script → Executions filtered to failures, last 90 days; Railway plan + backup/PITR entitlement; live row count per sheet; recent activity in Reservations/Holds. Answers are written into the phase SUMMARY.

### Claude's Discretion
- Extraction/naming of the shared forwarding helper; rate-limit numbers; how admin.js's `adminApiGet`/`adminApiPost` are reshaped (preferred: keep their signatures and swap internals so the 55 call sites barely change).
- Parity test design per rewired action (roadmap requires one per action).

### Deferred Ideas (OUT OF SCOPE)
- Retiring the Reservations & Holds tab and the Reservations/Holds/Kits sheets — Phase 88 (pending owner confirmation of use).
- Rehoming the kit-SKU registry off the Kits sheet — Phase 88.
- Middleware-side batch-token validation — Phase 87 (Postgres batches).
- Caching admin reads / public batch GET — only if metrics show a need.

### Canonical References (downstream agents MUST read before planning/implementing)
- `.planning/ROADMAP.md` §"Phase 82: Store-Agnostic Prerequisites" — goal + 4 success criteria (criterion 2's "7" corrected to 4 by D-02)
- `.planning/REQUIREMENTS.md` — DB-01
- `.planning/research/sheets-to-postgres-migration.md` §1.4, §2.1–2.2, §4 Stage 0, §8 — NOTE its zero-caller list is wrong, see D-01 (independently re-verified in this research, see Summary)
- `.planning/phases/76-*/76-CONTEXT.md` + `76-VERIFICATION.md` — session auth, 401 rule, proxy GET/POST rule (the reference implementation this phase clones — see Architecture Patterns below)
- Memory note "BrewPad admin-proxy retry & cache" — 502 collapse, reads-retry/writes-don't, `batch_id` cache bust
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-------------------|
| DB-01 | No browser code calls Apps Script directly — `js/admin.js` (55 sites) and `js/batch.js` route through the middleware; the true zero-caller actions are deleted (corrected 7→4 per D-02); `updateGiftCardInvoice` and the `createBatch` dedup guard run under the lock; the four owner checks (tab formulas, Executions failures, Railway plan, live row counts, + D-03's Reservations/Holds activity check) are answered | Full transport-migration pattern (Architecture Patterns, Pattern 1-3), exact 7-action `doPost` allowlist gap (Code Examples), exact 4 dead-action list (re-verified via grep, State of the Art), lock-fix locations and shapes (Code Examples, Pitfall 6), owner-check list (D-20, carried verbatim into User Constraints) |
</phase_requirements>

## Summary

This phase has almost no unknowns left — Phase 76 (BrewPad session hardening) already built and shipped the exact pattern this phase needs to replicate for `js/admin.js` and `js/batch.js`: a hardcoded-allowlist, session-authenticated `POST /api/batch/admin-proxy` that forwards to Apps Script with `server_token`, strips any client-supplied token, and splits reads (GET) from writes (POST) because of a real prod-outage lesson already encoded in the code comments. The work here is mechanical repetition of that pattern onto two more surfaces, plus two small, well-isolated Apps Script atomicity fixes, plus four true dead-action deletions.

Live-code verification in this session found three things CONTEXT.md's canonical-refs section did not have exact detail on, all of which the planner needs:

1. **The exact 7 Apps Script `doPost` server_token actions missing** for admin.js's writes (independently re-derived, matches D-11's list exactly: `update_hold`, `update_reservation`, `update_homepage`, `add_batch_task`, `update_batch_task`, `regenerate_batch_token`, `propagate_ferm_schedule`). Reads need **no** Apps Script change — `doGet`'s `server_token` bypass dispatches any action through `handleReadAction` with no allowlist at all (`adminApi.gs:100-129`).
2. **A genuine pre-existing cache-staleness bug** in `js/admin.js`, not previously documented anywhere in `.planning/`: two `update_batch_task` call sites (`admin.js:6346`, `:6368`, the vessel-transfer-confirm and skip-transfer flows) never send `batch_id` in the payload, so Apps Script's `_invalidateBatchCache(payload.batch_id)` receives `undefined` and the specific `gb:<batchId>` (300s TTL) cache entry is never busted — stale batch detail can be served for up to 5 minutes after completing a transfer task. This is exactly the class of bug D-09 exists to close; the planner must add `batch_id` to these two call sites, not just "the new" proxy work.
3. **`bulk_update_batch_tasks` cannot be fixed the same simple way** — its calendar-view call site (`admin.js:8042`) can carry tasks belonging to *multiple different batches* in one request, so there is no single `batch_id` to attach. `bulkUpdateBatchTasks` (`adminApi.gs:2807-2819`) has no per-task cache-invalidation logic of its own. The planner needs an explicit decision here (documented in Common Pitfalls below) — this is bigger than D-09 as literally scoped and should be flagged, not silently worked around.

The `updateGiftCardInvoice`/`createBatch` lock fixes (D-18) are small, precisely located, single-function edits — no complexity. The Ingredients-read migration (D-15) is a one-line Apps Script addition matching an existing pattern used by `get_kits`/`get_holds`/`get_schedule` verbatim. The public batch-token routes (D-13) need zero Apps Script changes at all — `handleBatchTokenPost` and `handleGetBatchPublic` already exist, are already token-authenticated independent of staff auth, and already implement exactly the three actions `batch.js` calls.

**Primary recommendation:** Treat this phase as "clone the Phase 76 pattern twice, fix two lock holes, delete four dead actions" — the Phase 76 code (`zoho-middleware/routes/pos.js:3991-4076`, `js/brewpad.js:1700-1786`) and its test file (`zoho-middleware/__tests__/batch-admin-proxy.test.js`) are the reference implementation and template for every new file this phase touches. Do not re-derive the pattern from first principles.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Admin data reads/writes (batches, holds, reservations, schedules, homepage, kits, ferm schedules, vessels) | API/Backend (Railway middleware) | Database/Storage (Apps Script → Sheets, unchanged this phase) | Middleware becomes the sole authenticated broker; browser never holds Apps-Script-valid credentials again |
| Public batch view + task/reading writes (`batch.html`) | API/Backend (Railway middleware, new token routes) | Database/Storage (Apps Script, token-validated) | Same seam pattern as admin — token validation logic stays server-side in Apps Script, only the transport hop changes |
| Session/identity (`x-session-token`) | API/Backend (`authTiers.requireTiers`) | Browser (localStorage token storage only) | Already built in Phase 46/76; this phase only adds consumers |
| Apps-Script action allowlisting | API/Backend (new `/api/admin/proxy` route) | — | Never a passthrough; unknown action → 400 before Apps Script is called (established pattern, T-76-02-01) |
| Lock/atomicity for gift-card invoice stamping + batch dedup | Database/Storage (Apps Script `LockService`) | — | No architectural change, just closing two existing holes in the existing tier |
| Ingredients read for the admin Ingredients tab | API/Backend (new Apps Script action behind the same proxy) | — | Currently the ONLY remaining direct-to-Google-API call in admin.js; must move into the same broker as everything else |

## Standard Stack

No new libraries. This phase is a pure refactor of existing, already-in-production infrastructure.

### Core (already in the codebase, reused)
| Library | Version | Purpose | Why Standard (for this repo) |
|---------|---------|---------|--------------|
| `express` | ^4.21.2 | Route definitions (`router.post`, `router.get`) | Already used by every sibling `/api/batch/*` route |
| `axios` | ^1.13.5 | Middleware → Apps Script HTTP calls | Already used by `/api/batch/admin-proxy` and every server-side Apps-Script caller |
| (none — vanilla ES5) | — | Frontend transport rewrite in `js/admin.js`/`js/batch.js` | CLAUDE.md: frontend is ES5-only, no build step for JS logic beyond concat+minify |

### Package Legitimacy Audit

**Not applicable — this phase installs zero external packages.** No `npm install` of any kind is required; the Package Legitimacy Gate protocol is skipped by design (nothing to audit). All work is new routes/functions in existing files (`zoho-middleware/routes/pos.js`, `apps-script/adminApi.gs`, `js/admin.js`, `js/batch.js`) plus new test files using the existing Jest + `express`/`axios` mock harness already present in `zoho-middleware/__tests__/batch-admin-proxy.test.js`.

## Architecture Patterns

### System Architecture Diagram

```
BEFORE (current state):
  admin.js ──Google OAuth token──> ADMIN_API_URL (Apps Script, doGet/doPost,
                                    checkAuthorization(e) staff-email allowlist)
  admin.js ──Google OAuth token──> sheets.googleapis.com (direct Sheets API,
                                    Ingredients read + fallback writes)
  batch.js ──no auth (token param)──> ADMIN_API_URL?action=get_batch_public...
  batch.js ──batch_token in body──> ADMIN_API_URL (doPost, handleBatchTokenPost)

AFTER (this phase):
  admin.js ──x-session-token──> Railway middleware
                                   POST /api/admin/proxy (NEW, hardcoded allowlist)
                                     │
                                     ├─ read action  ──axios.get──> Apps Script doGet
                                     │                              (server_token bypass,
                                     │                               handleReadAction — no
                                     │                               allowlist needed there)
                                     └─ write action ──axios.post─> Apps Script doPost
                                                                    (server_token if-chain —
                                                                     D-11 adds 7 missing entries)

  batch.js ──no session, per-IP rate limit──> Railway middleware
                                   GET  /api/batch/public/:id?token=...   (NEW)
                                   POST /api/batch/public/:id/tasks       (NEW)
                                   POST /api/batch/public/:id/readings    (NEW)
                                     │  (batch_token forwarded, Apps Script
                                     │   validates it exactly as today —
                                     │   handleGetBatchPublic / handleBatchTokenPost,
                                     │   BOTH ALREADY EXIST, ZERO Apps Script change)
                                     └─axios──> Apps Script doGet/doPost
```

A reader can trace: browser → middleware (identity proven once, at the edge) → Apps Script (business logic + Sheets, unchanged) for every one of the 33 actions this phase touches.

### Recommended Project Structure (files touched, no new directories)
```
zoho-middleware/routes/pos.js         # + shared forwarding helper, + POST /api/admin/proxy,
                                       #   + 3 new /api/batch/public/* routes
zoho-middleware/__tests__/            # + admin-proxy.test.js, + batch-public.test.js
                                       #   (mirror batch-admin-proxy.test.js exactly)
apps-script/adminApi.gs               # + 7 doPost server_token entries (D-11), + get_ingredients
                                       #   action, + lock around updateGiftCardInvoice, + dedup
                                       #   guard moved inside createBatch's lock, - 4 dead actions
js/admin.js                           # adminApiGet/adminApiPost internals repointed to
                                       #   /api/admin/proxy (keep signatures — 55 call sites
                                       #   barely change); delete sheetsGet/Update/Append/
                                       #   loadAllData fallback/isUnauthorizedError/
                                       #   handleUnauthorized; fetchWithRetry gains
                                       #   retryStatuses param (mirror brewpad.js)
js/batch.js                           # apiUrl → MIDDLEWARE_URL; 3 fetches repointed to the
                                       #   new /api/batch/public/* routes; + module.exports
                                       #   test seam (currently has NONE — net-new)
```

### Pattern 1: Hardcoded action allowlist, never a passthrough
**What:** A plain JS object literal mapping allowed action names to `true`, checked with `if (!ALLOWLIST[action]) return res.status(400).json({ok:false, error:'invalid_action'})` BEFORE any network call.
**When to use:** Every proxy endpoint that forwards a client-chosen action string to a privileged upstream.
**Example (existing code to mirror exactly):**
```javascript
// Source: zoho-middleware/routes/pos.js:3991-4021 (live in prod)
var ADMIN_PROXY_ACTIONS = {
  get_batch: true, get_batches: true, /* ...reads... */
  create_batch: true, update_batch: true, /* ...writes... */
};
var ADMIN_PROXY_READS = { get_batch: true, get_batches: true, /* reads only */ };

router.post('/api/batch/admin-proxy', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
    var action = (req.body.action || '').toLowerCase();
    if (!ADMIN_PROXY_ACTIONS[action]) {
      return res.status(400).json({ ok: false, error: 'invalid_action' });
    }
    var payload = Object.assign({}, req.body, { action: action, server_token: process.env.APPS_SCRIPT_SERVER_TOKEN });
    delete payload.token;
    var upstream = ADMIN_PROXY_READS[action]
      ? axios.get(process.env.APPS_SCRIPT_URL, { params: payload, timeout: 15000, maxRedirects: 5 })
      : axios.post(process.env.APPS_SCRIPT_URL, JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 5 });
    upstream.then(function (resp) { res.json(resp.data); })
      .catch(function (err) { res.status(502).json({ ok: false, error: 'server_error' }); });
  });
});
```
The new `/api/admin/proxy` (D-05) is this exact shape with a different (larger) allowlist. **Recommend extracting the body of the `.then()/.catch()` + GET-vs-POST branch into a shared function** (e.g. `forwardToAppsScript(action, payload, isRead)`) that both `/api/batch/admin-proxy` and `/api/admin/proxy` call — CONTEXT D-05 already asks for this; the extraction is mechanical (about 15 lines).

### Pattern 2: Reads retry on transient 502/503/504, writes never retry
**What:** `fetchWithRetry(url, options, retries, retryStatuses)` — the 4th param is *omitted* for writes.
**When to use:** Any fetch through the new proxy (D-08 in CONTEXT is this exact pattern, already shipped in brewpad.js).
**Example (existing code to mirror exactly):**
```javascript
// Source: js/brewpad.js:1711-1730 (live in prod)
function fetchWithRetry(url, options, retries, retryStatuses) {
  if (retries === undefined) retries = 1;
  function backoffRetry() {
    return new Promise(function (resolve) { setTimeout(resolve, 1000); })
      .then(function () { return fetchWithRetry(url, options, retries - 1, retryStatuses); });
  }
  return fetch(url, options).then(function (r) {
    if (retryStatuses && retries > 0 && retryStatuses.indexOf(r.status) !== -1) return backoffRetry();
    return r;
  }, function (err) {
    if (retries > 0) return backoffRetry();
    throw err;
  });
}
// Reads: fetchWithRetry(url, opts, 2, [502, 503, 504])
// Writes: fetchWithRetry(url, opts)   // no retryStatuses — never re-sent
```
admin.js's CURRENT `fetchWithRetry` (`admin.js:634-646`) retries on network rejection only, with no status-code awareness, and — critically — is called identically for both reads AND writes today. This must change: writes must stop retrying via this mechanism once they go through a proxy that can return 502 on an upstream timeout that already succeeded (the exact double-apply risk documented in the "BrewPad admin-proxy retry & cache" memory note and D-08).

### Pattern 3: Test-only export seam for IIFE-scoped frontend modules
**What:** `if (typeof module !== 'undefined' && module.exports) { module.exports = Object.assign(module.exports || {}, { ... }) }` at the bottom of the file, exposing internal functions/setters for Jest.
**When to use:** Any new testable surface inside `js/admin.js` (already has this, e.g. `_adminApiGetForTest: adminApiGet` at `admin.js:10170`) or **`js/batch.js`, which currently has NO test seam and NO frontend test file at all** — this must be added net-new for parity tests to be possible (see Open Questions).

### Anti-Patterns to Avoid
- **Free-form `{action, ...params}` passthrough with no allowlist:** the T-76-02-01 lesson already encoded in `pos.js:3966-3970` comments — never let `req.body.action` reach Apps Script unchecked.
- **Retrying a write on a proxy 502:** the proxy collapses "Apps Script actually succeeded but took >15s" into 502 indistinguishably from "Apps Script never got it" — retrying a write assumes the latter and can double-apply the former (already documented in memory: "BrewPad admin-proxy retry & cache").
- **Sending the client's Google `token` field through to Apps Script on the new proxy:** identity must be proven ONLY by `requireTiers` + `x-session-token`; CONTEXT D-06 and the existing code both `delete payload.token` before forwarding.
- **Trusting `payload.batch_id` presence without checking call sites:** as found in this research, two live call sites silently omit it today; adding a new proxy does not fix this by itself — the call sites themselves need the field added.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Allowlisted Apps-Script proxy with GET/POST split, token strip, 502 collapse | A new proxy design from scratch | Extract the existing `/api/batch/admin-proxy` handler body into a shared helper, reuse for `/api/admin/proxy` | The exact same 15s-timeout / GET-vs-POST / token-strip logic was already debugged in prod (the Phase 76 hotfix commit history exists for a reason — do not re-derive it) |
| Reads-retry-writes-don't fetch wrapper | A new retry policy | Copy `js/brewpad.js:1711-1730` `fetchWithRetry` verbatim into `js/admin.js`, replacing its current retry-everything version | Already correctly scoped and battle-tested; inventing a different retry policy risks reintroducing the double-apply-on-retry class of bug |
| Public batch-token validation | New middleware-side token verification | Forward `batch_token`/`token` straight through to Apps Script's existing `handleBatchTokenPost`/`handleGetBatchPublic`, which already validate format (`SV-B-\d{6}`, 32 hex chars) and match against the stored `access_token` | D-13 is explicit: "middleware does NOT validate tokens itself in this phase." Duplicating validation logic in two places is a drift risk with zero benefit this phase |
| Ingredients data-shape translation | A CSV-parsing or reshaping layer in admin.js | A new Apps Script action `get_ingredients` returning `{values: sheet.getDataRange().getValues()}` — the EXACT same shape as `getKits()`/`getHolds()`/`getSchedule()` (`adminApi.gs:707-751`) | `parseSheetData` (`admin.js:1262-1297`) only ever reads `response.values` — matching that shape means zero admin.js-side reshaping code is needed at all |

**Key insight:** every piece of infrastructure this phase needs already exists once, in production, for BrewPad (Phase 76). The work is disciplined duplication, not design.

## Common Pitfalls

### Pitfall 1: `bulk_update_batch_tasks` cannot be fixed with a single `batch_id` field
**What goes wrong:** D-09 says "every admin.js write that mutates a batch MUST include `batch_id`." Two of the three `bulk_update_batch_tasks` call sites are fine (they're per-batch), but `admin.js:8042` (the **calendar view**, spanning potentially many batches in one screen) builds `tasksArr` from checkboxes that can belong to different `batch_id`s in a single request. There is no single value to attach.
**Why it happens:** `bulkUpdateBatchTasks` (`adminApi.gs:2807-2819`) loops `updateBatchTask` per task but never collects or invalidates per-task `batch_id`s; cache invalidation is entirely the caller's `payload.batch_id` (singular), which was designed for the single-batch case only.
**How to avoid:** The planner has two honest options — (a) client-side: after the bulk call, collect the **set** of unique `batch_id`s among `tasksArr` from already-loaded task data (`admin.js` already has this in memory for the calendar view) and issue a lightweight follow-up (e.g. call `get_batch` per affected id, which busts nothing but at least refetches fresh) — this does not fix server cache staleness; OR (b) server-side: change `bulkUpdateBatchTasks`'s Apps Script handler to invalidate `gb:<batch_id>` per task using each task's own `batch_id` (available from `updateBatchTask`'s lookup), independent of what the top-level payload sends. **(b) is the correct fix and is a small, contained Apps Script change** — flag it explicitly in the plan rather than silently deferring it, since D-09 as literally worded does not cover this case.
**Warning signs:** A staff member edits several tasks across different batches from the calendar view, then opens one of those batches' detail view and sees stale `completed` checkboxes for up to 300s.

### Pitfall 2: The two `update_batch_task` call sites missing `batch_id` (found live, not in CONTEXT)
**What goes wrong:** `admin.js:6346` (transfer-confirm) and `:6368` (skip-transfer) call `adminApiPost('update_batch_task', {task_id, updates, ...})` with no `batch_id`, even though the enclosing function has `batchId` in scope (it's used two lines later in `openBatchDetail(batchId)`). Silent stale-cache bug, not previously documented.
**Why it happens:** The field was presumably omitted because `update_batch_task`'s own required fields (`task_id`, `updates`) don't need it to locate the row — only the cache-bust does.
**How to avoid:** Add `batch_id: batchId` to both payloads while doing the transport rewrite (near-zero cost, already touching every `adminApiPost` call site conceptually) — this is the highest-value, lowest-risk fix in the whole phase and should not be deferred.
**Warning signs:** `grep -n "adminApiPost('update_batch_task'" js/admin.js` and check every match includes `batch_id`.

### Pitfall 3: `doGet`'s server_token bypass has NO action allowlist — the allowlist boundary is entirely at the middleware
**What goes wrong:** Assuming Apps Script itself gates which reads a `server_token` holder can perform. It does not — `adminApi.gs:100-129`'s `isServerAuth` branch grants `authorized: true` and then dispatches `handleReadAction(action, ...)` for **any** action string, with the only gate being `handleReadAction`'s own `default: invalid_action`. This is fine ONLY because the middleware's `ADMIN_PROXY_ACTIONS`/new proxy's allowlist is the actual security boundary for reads.
**Why it happens:** The comment at `adminApi.gs:93-99` explains this was an intentional 2026-07-12 fix to unify server_token auth across GET and POST — it was never meant to also be a read-action allowlist.
**How to avoid:** Do not skip or weaken the new `/api/admin/proxy`'s allowlist under the assumption "Apps Script will reject it anyway" — it will not, for reads. Writes ARE gated by Apps Script's `doPost` server_token if-chain (closed, `default: invalid_action` at line 382), so writes have defense-in-depth; reads do not.
**Warning signs:** A reviewer sees the new proxy's `ADMIN_PROXY_READS`-equivalent object missing an entry and assumes Apps Script will still reject it — it will not.

### Pitfall 4: `js/batch.js` has zero existing test coverage — parity tests are net-new, not "update existing"
**What goes wrong:** Planning "one parity test per rewired action" (per CONTEXT's Claude's-Discretion note) assuming an existing `batch.test.js` to extend.
**Why it happens:** `grep -rl "js/batch" tests/frontend` returns nothing; `js/batch.js` has no `module.exports` block at all (unlike `admin.js` and `brewpad.js`, both of which have export seams).
**How to avoid:** Budget time to (a) add a `module.exports` test seam to `js/batch.js` mirroring the `admin.js`/`brewpad.js` pattern, and (b) write a **new** `tests/frontend/batch-public-proxy.test.js` from scratch — there is nothing to extend.
**Warning signs:** Planner assumes "update the existing batch.js tests" as a task and finds none exist.

### Pitfall 5: `admin.html` and `batch.html` have NO `Content-Security-Policy` meta tag today — CONTEXT's canonical_refs assumption does not hold
**What goes wrong:** CONTEXT.md's code_context section says "CSP `connect-src` on `admin.html`/`batch.html` must allow the middleware origin (CLAUDE.md rule 12)." Live grep across the repo (`grep -rln "Content-Security-Policy" *.html`) shows **26 public pages have a CSP meta tag; `admin.html` and `batch.html` are not among them.** `kiosk.html` DOES have one (`kiosk.html:17`), listing both Railway origins, `script.google.com`, and `sheets.googleapis.com` in `connect-src` — that page is the correct reference if a CSP is ever added to admin/batch.
**Why it happens:** Likely because admin.html and batch.html were treated as staff/quasi-public tool pages rather than "public HTML pages" when CLAUDE.md rule 12 was written and CSPs were rolled out; `batch.html` in particular IS reachable by any customer with a QR code and has no login, so it arguably should have had one from the start.
**How to avoid:** This phase does not need to ADD a CSP to these two pages to succeed (there is none to update, so no domain can be "silently blocked" — CLAUDE.md rule 12's failure mode does not apply). **Do not spend phase-82 budget adding a CSP to admin.html/batch.html — it is out of this phase's stated scope** (CONTEXT's `<deferred>` section does not mention it, and the phase boundary is transport-only, "no user-visible behaviour change"). Flag it to the owner as a pre-existing gap worth a future hardening phase, but do not fold it in here silently.
**Warning signs:** A plan task says "update CSP on admin.html/batch.html" — verify first with `grep -n "Content-Security-Policy" admin.html batch.html` (currently returns nothing).

### Pitfall 6: `updateGiftCardInvoice` and `createBatch`'s dedup guard are separate, unrelated code paths — don't conflate the fix
**What goes wrong:** Treating D-18 as one change. `updateGiftCardInvoice` (`adminApi.gs:4847-4866`) has **no lock at all** (add `acquireScriptLock`/`releaseLock` around the whole body, matching the `try { ... } finally { lock.releaseLock(); }` shape used by all 11 other locked functions, e.g. `adminApi.gs:2227-2376`). `createBatch`'s dedup guard (`adminApi.gs:2158-2193`) runs entirely BEFORE the lock is acquired at line 2227 — the fix is to move the guard's read-then-decide logic to execute AFTER `acquireScriptLock`, inside the same `try` block that already wraps the ID generation and row append, so the check-then-append becomes atomic. These are two independent, single-function edits with no shared code.
**Why it happens:** N/A — this is a design note, not an observed failure.
**How to avoid:** Plan these as two separate tasks/verification points, each with its own before/after diff, not one "add locks" task.
**Warning signs:** A plan that touches both in one commit with one test — the TOCTOU fix and the missing-lock fix have different verification shapes (the dedup guard fix needs a concurrent-request test; the invoice-lock fix just needs the lock present).

## Code Examples

### The exact `doPost` server_token gap (D-11), reproduced from `adminApi.gs`
```javascript
// Source: apps-script/adminApi.gs:261-383 (current server_token if-chain)
// Present: add_reservation, create_batch, create_recipe, update_recipe, delete_recipe,
//   get_recipes, get_recipe, issue_gift_card, lookup_gift_card, redeem_gift_card,
//   reload_gift_card, void_gift_card, update_gift_card_invoice, get_next_cert_number,
//   add_waitlist_entry, update_waitlist_status, update_batch, update_batch_schedule,
//   delete_batch, bulk_add_plato_readings, bulk_update_batch_tasks, update_plato_reading,
//   delete_plato_reading, create_ferm_schedule, update_ferm_schedule, delete_ferm_schedule
//
// MISSING (admin.js calls these but only via staff-Google-OAuth today, lines 392-475):
//   update_reservation, update_hold, add_batch_task, update_batch_task,
//   propagate_ferm_schedule, regenerate_batch_token, update_homepage
//
// Add 7 new `if (action === '...') { ... }` blocks inside the `if (payload.server_token)`
// branch, each following the exact shape of the existing `update_batch` block:
if (action === 'update_reservation') {
  return _jsonResponse(updateReservation(payload, 'middleware'));
}
// ...repeat for the other 6, matching each function's existing (payload, email) signature.
```

### `updateGiftCardInvoice` — add the missing lock
```javascript
// Source: apps-script/adminApi.gs:4847-4866 (current, NO lock)
function updateGiftCardInvoice(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var invoiceNumber = sanitizeInput(payload.zoho_invoice_number || '');
  if (!certNum || !invoiceNumber) return { ok: false, error: 'missing_fields' };
  var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
  if (result.row === -1) return { ok: false, error: 'not_found' };
  // ... writes invoiceCol, updatedCol ...
}

// FIX shape (mirrors every other locked function, e.g. adminApi.gs:2227/:4049):
function updateGiftCardInvoice(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var invoiceNumber = sanitizeInput(payload.zoho_invoice_number || '');
  if (!certNum || !invoiceNumber) return { ok: false, error: 'missing_fields' };
  var lock = acquireScriptLock(15000);
  try {
    var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
    if (result.row === -1) return { ok: false, error: 'not_found' };
    // ... writes invoiceCol, updatedCol ...
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
```

### Ingredients read — new Apps Script action, matching the existing shape exactly
```javascript
// Source pattern: apps-script/adminApi.gs:744-751 (getKits, verbatim shape to copy)
function getIngredients() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INGREDIENTS_SHEET_NAME); // new const, add near line 49-63
  if (!sheet) return { values: [] };
  return { values: sheet.getDataRange().getValues() };
}
// + one line in handleReadAction's switch (adminApi.gs:149-243):
//   case 'get_ingredients': return { ok: true, data: getIngredients() };
// admin.js side: parseSheetData(result.data, 'ingredients') works UNCHANGED —
// result.data is {values:[[...]]}, exactly what sheetsGet() used to return.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `admin.js`/`batch.js` hold a Google OAuth token and call Apps Script directly | Middleware brokers every call with `x-session-token`/per-route rate limiting; Google token used only at login | Phase 46 (2026-07-08) established the pattern; Phase 76 (2026-08-27) proved it end-to-end for BrewPad; this phase (82) extends it to the last two surfaces | Removes the last direct-to-Apps-Script browser callers in the codebase — after this phase, `ADMIN_API_URL` has zero live readers anywhere in `js/` (verified: `grep -rln ADMIN_API_URL js/ --include="*.js"` returns only `batch.js`, `admin-config.js` (the definition), `sheets-config.js` (a comment), and `brewpad.js` (a comment) — no executable reference remains once this phase's D-16 deletions land) |
| Reads and writes retried identically on failure | Reads retry on `[502,503,504]`, writes never retry | Phase 76-03, from a documented prod incident (proxy 502-collapse could double-apply a write) | `admin.js`'s current `fetchWithRetry` (retries everything, no status awareness) must be replaced, not extended |

**Deprecated/outdated:**
- `js/admin.js`'s direct-Sheets-API fallback path (`sheetsGet`/`sheetsUpdate`/`sheetsAppend`, `admin.js:734-835`) — dead once `ADMIN_API_URL` is guaranteed present, per D-16.
- Apps Script actions `get_config`, `update_schedule`, `update_kits`, `get_homepage` — verified zero callers repo-wide (frontend, middleware, apps-script, tests, html) via direct grep in this session.
- `js/admin-config.js`'s `ADMIN_API_URL` value itself becomes dead configuration (no runtime reader) once D-16/D-17 land — kept only if the planner wants a slow, staged removal; safe to delete per the grep evidence above, but CONTEXT correctly leaves the final call to the planner (D-17).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommending `bulkUpdateBatchTasks`'s Apps Script handler be changed to invalidate cache per-task's own `batch_id` (Pitfall 1, option b) rather than accepting an array from the client | Common Pitfalls #1 | If the planner instead chooses the client-side option (a), no Apps Script change is needed here but the staleness is only mitigated, not closed — low risk either way since this is a UX staleness bug, not a money-path or data-integrity bug |
| A2 | Recommending the shared forwarding helper be extracted into a plain function (not a class/module) inside `pos.js` | Architecture Patterns, Pattern 1 | Low risk — CONTEXT explicitly leaves naming/extraction shape to Claude's Discretion; any working extraction satisfies D-05 |

**All other claims in this research are `[VERIFIED]` against live repository code (file:line cited throughout) or `[CITED]` from the Phase 76 CONTEXT/VERIFICATION docs, which were themselves live-verified in production.** No package-registry or external-documentation lookups were needed — this phase touches zero third-party libraries.

## Open Questions

1. **Should `bulkUpdateBatchTasks`'s server-side cache-invalidation gap (Pitfall 1) be fixed in this phase or deferred?**
   - What we know: it is a real, currently-live staleness bug, independent of anything this phase's transport change introduces.
   - What's unclear: whether the owner considers "up to 5 minutes of stale calendar-driven task state" worth fixing now vs. as a follow-up, given the phase's stated boundary is "no user-visible behaviour change."
   - Recommendation: fix it — it's a ~5-line Apps Script change (loop `payload.tasks`, invalidate `gb:<task.batch_id_from_lookup>` per task) with no behavior change to anything the phase already touches, and it directly serves D-09's stated intent.

2. **Does `js/batch.js` need a `module.exports` test seam added as its own task, or folded into the transport-rewrite task?**
   - What we know: zero existing test coverage; the file has no seam at all today.
   - What's unclear: whether the planner wants this as a separate, reviewable task (cleaner diff) or bundled with the rewrite.
   - Recommendation: separate task — mirrors how `admin.js`'s and `brewpad.js`'s seams were each added incrementally as needed, not as one giant diff.

## Environment Availability

Skipped — this phase has no new external dependencies (no new packages, no new services, no new CLI tools). All infrastructure (Railway middleware, Apps Script deployment, Jest/ESLint) is already in place and already exercised by the Phase 76 pattern this phase clones.

## Security Domain

### Applicable ASVS Categories (Level 1, per `.planning/config.json` `security_asvs_level: 1`, `security_block_on: "high"`)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | Yes | `x-session-token` via `authTiers.requireTiers(['legacy','session'])` for `/api/admin/proxy` (identical to the live `/api/batch/admin-proxy` gate); batch-token routes intentionally unauthenticated by session, token-validated by Apps Script (unchanged, pre-existing) |
| V3 Session Management | Yes | Reuses Phase 46/76's `sv_session` model — no new session logic this phase |
| V4 Access Control | Yes | Hardcoded allowlist object per proxy route, closed default (`invalid_action`), never a free-form passthrough — this is the phase's single most important security property |
| V5 Input Validation | Partial | Apps Script already regex-validates `batch_id` (`/^SV-B-\d{6}$/`) and `batch_token` (`/^[0-9a-f]{32}$/`) server-side for the public routes (`adminApi.gs:3102-3105`, `:1721-1723`) — the new middleware routes should NOT re-implement this (D-13: "middleware does NOT validate tokens itself"), just forward and let the existing check reject malformed input |
| V6 Cryptography | No new surface | Token comparison is pre-existing (`String(...) !== String(...)`, not constant-time) — out of this phase's scope to change; not introduced or worsened by this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Client sends an arbitrary `action` string hoping the proxy forwards it unchecked | Elevation of Privilege | Hardcoded allowlist checked before any network call (Pattern 1 above) — already the established, tested pattern |
| Client sends a `token`/`server_token` field hoping it overrides forwarded identity | Spoofing | `delete payload.token` before forwarding; `server_token` is ALWAYS injected server-side from `process.env.APPS_SCRIPT_SERVER_TOKEN`, never read from the request body |
| Unauthenticated public batch routes get hammered (scraping/brute-forcing batch tokens) | Denial of Service | D-14: per-IP rate limit on `/api/batch/public/*`, mirroring `clientErrorLimiter`/`telemetryLimiter` (`zoho-middleware/server.js:594-615`) — `rateLimit({windowMs, max, store: makeRedisStore(...)})` pattern, mounted via `app.use('/api/batch/public', limiter)` in `server.js` |
| A retried write double-applies after a proxy-collapsed 502 | Tampering (data integrity) | D-08: writes never carry `retryStatuses` to `fetchWithRetry` — see Pattern 2 |
| `updateGiftCardInvoice` races a concurrent `redeemGiftCard` (both touch the `GiftCards` sheet, only one currently locks) | Tampering (money-path) | D-18: wrap `updateGiftCardInvoice` in `acquireScriptLock`/`releaseLock`, matching the other 11 gift-card/batch functions that already lock |

## Sources

### Primary (HIGH confidence — direct code inspection this session)
- `js/admin.js` (11,521 lines) — full `adminApiGet`/`adminApiPost`/`sheetsGet`/`sheetsUpdate`/`sheetsAppend`/`loadAllData`/`fetchWithRetry`/`isUnauthorizedError`/`handleUnauthorized` inspection, all 18 `ADMIN_API_URL` sites, all 47 `adminApiGet`/`adminApiPost` call sites and their unique action names
- `js/batch.js` (406 lines) — full file read, all 3 Apps Script actions confirmed
- `js/brewpad.js` — `adminApiGet`/`adminApiPost`/`fetchWithRetry`/`_handleMiddlewareResponse` (lines 1690-1786), confirmed as the reference implementation
- `apps-script/adminApi.gs` (5,374 lines) — `doGet` (lines 71-129), `handleReadAction` (143-243), `doPost` server_token if-chain (249-383) and staff-auth switch (391-507), `handleBatchTokenPost` (3101-3136), `handleGetBatchPublic` (1715-1745+), `acquireScriptLock`/`generateNextId` (1235-1270ish), `createBatch` (2129-2376) incl. dedup guard and lock, `updateGiftCardInvoice` (4847-4887), `_invalidateBatchCache` (3454-3462), `getKits`/`getHolds`/`getSchedule`/`getConfig`/`getHomepage`/`updateSchedule`/`updateKits` (707-1230ish)
- `zoho-middleware/routes/pos.js` (4,296 lines) — `/api/batch/admin-proxy` full implementation (3966-4076) including `ADMIN_PROXY_ACTIONS`/`ADMIN_PROXY_READS`, all existing `/api/batch/*` route registrations (grepped for naming collisions)
- `zoho-middleware/server.js` (rate-limit section, lines 418-634) — `makeRedisStore`, `apiLimiter`/`paymentLimiter`/`pinLimiter`/`clientErrorLimiter`/`telemetryLimiter` patterns for D-14
- `zoho-middleware/__tests__/batch-admin-proxy.test.js` (268 lines) — full read, the template for new parity tests
- `js/admin-config.js`, `js/sheets-config.js` — confirmed `ADMIN_API_URL`/`MIDDLEWARE_URL` sourcing and hostname-based routing
- `admin.html`, `batch.html`, `kiosk.html` — grepped for CSP meta tags (found: none on admin/batch, present on kiosk)
- `.planning/config.json` — confirmed `nyquist_validation: false` (Validation Architecture section correctly omitted), `security_enforcement: true`, `security_asvs_level: 1`

### Secondary (CITED — prior phase docs, themselves live-verified)
- `.planning/phases/82-store-agnostic-prerequisites/82-CONTEXT.md` — all D-01..D-20 decisions, locked
- `.planning/phases/76-.../76-CONTEXT.md` + `76-VERIFICATION.md` — the auth model, 401 rule, GET/POST split rule this phase carries forward; VERIFICATION confirms 11/11 automated truths and documents the exact `_handleMiddlewareResponse`/dual-token-deletion pattern to replicate
- `.planning/research/sheets-to-postgres-migration.md` §1.4, §2.1-2.2, §4 Stage 0, §8 — background context; its zero-caller list is superseded by D-01/D-02 (independently re-verified in this session, matches D-02's corrected list of 4 exactly)

### Tertiary
None — no WebSearch/Context7/external lookups were performed or needed; this phase is 100% internal-codebase research.

## Metadata

**Confidence breakdown:**
- Standard stack: N/A (no new libraries) — HIGH confidence there are none needed
- Architecture: HIGH — every pattern cited is already live in production (Phase 76), not theoretical
- Pitfalls: HIGH — all 6 pitfalls are grounded in direct code reads with exact file:line citations, several found fresh in this session (not present in CONTEXT.md or the prior migration research doc)

**Research date:** 2026-09-23
**Valid until:** Effectively indefinite for the architectural pattern (Phase 76 code is stable, unlikely to change before this phase executes); re-verify the exact `ADMIN_API_URL` grep counts and `bulk_update_batch_tasks` call sites if significant admin.js changes land between now and plan execution (30-day suggested refresh window, consistent with an actively-developed repo).
