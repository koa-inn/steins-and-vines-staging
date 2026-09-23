---
phase: 82-store-agnostic-prerequisites
plan: 08
subsystem: api
tags: [frontend, middleware-seam, jest, es5, brewpad-pattern]

# Dependency graph
requires:
  - phase: 76-brewpad-session-expiry-hardening
    provides: module.exports test-seam pattern (js/brewpad.js) and the
      MIDDLEWARE_URL / fetchWithRetry transport shape this plan mirrors
provides:
  - js/batch.js routed exclusively through MIDDLEWARE_URL + /api/batch/public/*
    (GET :id, POST :id/tasks, POST :id/readings) -- zero remaining
    SHEETS_CONFIG.ADMIN_API_URL / script.google.com / ?action= references
  - module.exports test seam on js/batch.js (init, loadBatch, toggleTask,
    submitPlatoReadings, refreshBatchOnce, plus test-only state accessors)
  - tests/frontend/batch-public-proxy.test.js -- 10-test parity suite pinning
    the exact request/response contract the 82-05 middleware routes must serve
affects: [82-05-token-routes, 82-09-rollout, 82-06-admin-js, 82-07-admin-js]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "publicBatchUrl(suffix) helper builds apiUrl + /api/batch/public/:id + suffix,
       with batchId always through encodeURIComponent (T-82-08-01)"
    - "bottom-of-file module.exports test seam (mirrors js/brewpad.js) for
       IIFE-scoped frontend modules with no other public API surface"

key-files:
  created:
    - tests/frontend/batch-public-proxy.test.js
  modified:
    - js/batch.js
    - js/batch.min.js
    - batch.html
    - js/admin.js (BUILD_TIMESTAMP stamp only, side effect of npm run build)
    - js/admin.min.js (same)
    - admin.html
    - kiosk.html
    - brewpad.html
    - index.html

key-decisions:
  - "Followed D-13 exactly: GET /api/batch/public/:id?token=..., POST .../tasks,
     POST .../readings; action and batch_id are now implicit in the route (not
     sent in the request body), only batch_token + the action-specific fields go
     in the POST body"
  - "Kept the 60s poll interval and exponential-backoff logic in startAutoRefresh()
     completely unchanged (D-14) -- only extracted the poll body into a named
     refreshBatchOnce() function so it could be driven directly by tests"
  - "Did not add a CSP meta tag to batch.html -- none existed before this change
     and the plan scoped that out (orchestrator guidance 3); documented below as
     a pre-existing gap, not something this plan introduced or fixed"
  - "npm run build touches many more files than this plan's own scope (every
     page's cache-bust version, via stamp:pages) -- reverted all of those via
     git checkout before committing, keeping only the files this plan's frontmatter
     declares (admin.html/kiosk.html/brewpad.html/index.html/admin.js are kept
     because they are explicitly listed and the wave note calls out that 82-06/07
     are sequenced after this plan because of exactly this stamp side effect)"

patterns-established:
  - "Test seam pattern for small standalone IIFE pages (batch.js) matches the
     brewpad.js pattern at file-bottom scale, without needing a partial-export
     merge sequence (single Object.assign call is sufficient for a 400-line file)"

requirements-completed: [DB-01]

# Metrics
duration: ~25min
completed: 2026-09-23
---

# Phase 82 Plan 08: Batch public-page middleware repoint Summary

**js/batch.js's public batch tracker now talks exclusively to MIDDLEWARE_URL + /api/batch/public/:id[/tasks|/readings] with a new module.exports test seam and a 10-test Jest parity suite; zero remaining ADMIN_API_URL/script.google.com/?action= references.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-23T20:19:00Z (approx, per STATE.md session start)
- **Completed:** 2026-09-23T20:37:25Z
- **Tasks:** 2/2 completed
- **Files modified:** 10 (1 created, 9 modified)

## Accomplishments

- `js/batch.js` no longer reads `SHEETS_CONFIG.ADMIN_API_URL` anywhere — all three
  actions (view/refresh, task tick, bulk plato submit) now build their URL via a
  new `publicBatchUrl(suffix)` helper against `SHEETS_CONFIG.MIDDLEWARE_URL`.
- `toggleTask()` and `submitPlatoReadings()` now POST `application/json` (not
  `text/plain`) with only `{batch_token, ...}` — `action` and `batch_id` are
  dropped from the body since the route path now carries that information,
  matching the 82-05 route contract exactly.
- Added a bottom-of-file `module.exports` test seam (mirrors `js/brewpad.js`)
  exposing `init`, `loadBatch`, `toggleTask`, `submitPlatoReadings`,
  `refreshBatchOnce`, and three test-only state accessors.
- New `tests/frontend/batch-public-proxy.test.js` (261 lines, 10 tests) —
  Task 1 committed it as a characterization suite pinning today's Apps-Script
  transport; Task 2 flipped every assertion RED→GREEN to the new contract in
  the same TDD cycle, plus 5 new tests for the `<behavior>` block requirements
  (Configuration-error guard with no fetch, 429/502 error-toast paths without
  throwing, no `script.google.com`/`?action=` anywhere, `batchId` encoding).
- `batch.html` no longer loads `js/admin-config.js` (D-23) — `admin.html`,
  `brewpad.html`, and `kiosk.html` still load it (their removal is scoped to
  later plans).
- `npm run build` regenerated `js/batch.min.js` (verified it now contains
  `api/batch/public`) and, as an unavoidable side effect of the shared build
  pipeline, stamped `js/admin.js`'s `BUILD_TIMESTAMP` and the cache-bust query
  strings on `admin.html`/`kiosk.html`/`brewpad.html`/`index.html`. All other
  pages touched transiently by `npm run stamp:pages` (wine.html, beer.html,
  the `products/*.html` catalogue pages, etc.) were reverted via
  `git checkout --` before committing since they carry zero functional change
  and are outside this plan's declared scope.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add a batch.js test seam with characterization tests of today's behaviour** - `41721bca` (test)
2. **Task 2: Repoint batch.js to /api/batch/public/* (D-13), drop admin-config.js from batch.html (D-23), rebuild** - `c1817b3b` (feat)

_TDD task (Task 2): the same commit contains both the RED test-assertion rewrite and the GREEN implementation, since the plan's action block asked for the RED update and GREEN fix as one logical "repoint" change; the RED state was verified interactively (8/10 new assertions failing against the pre-change transport) before writing the implementation, per the workflow's RED→GREEN gate._

**Plan metadata:** (this commit, made after this summary is written)

## Files Created/Modified

- `js/batch.js` - Extracted `submitPlatoReadings(submitBtn)` and `refreshBatchOnce()` as named functions (Task 1, no behaviour change); added module.exports test seam; repointed all three fetch call sites onto `MIDDLEWARE_URL` + `/api/batch/public/*` via a new `publicBatchUrl(suffix)` helper (Task 2)
- `js/batch.min.js` - Rebuilt via `npm run build`; carries the new transport (verified via grep)
- `batch.html` - Removed the `<script src="js/admin-config.js" defer></script>` tag (D-23)
- `tests/frontend/batch-public-proxy.test.js` - New 10-test Jest suite (DOM fixture + SHEETS_CONFIG stub harness, mirroring `admin-session-auth.test.js`/`brewpad-read-retry.test.js`); pins the exact request/response contract for all 3 public-batch routes
- `js/admin.js` / `js/admin.min.js` - `BUILD_TIMESTAMP` bump only (side effect of the shared `npm run build` pipeline; no other admin.js changes belong to this plan — those are 82-06/82-07)
- `admin.html` / `kiosk.html` / `brewpad.html` / `index.html` - Cache-bust query-string version bumps only (same build side effect, listed in this plan's `files_modified` frontmatter)

## Decisions Made

- Followed D-13's route contract literally: `GET /api/batch/public/:id?token=...`,
  `POST /api/batch/public/:id/tasks`, `POST /api/batch/public/:id/readings` —
  `action`/`batch_id` dropped from POST bodies since the route encodes them.
- Left `startAutoRefresh()`'s 60s interval and exponential-backoff calculation
  completely untouched (D-14) — only extracted the poll body into
  `refreshBatchOnce()` so tests could drive it directly without waiting on
  real timers.
- No CSP added to `batch.html` — none existed before this plan and D-23/
  orchestrator guidance explicitly scoped that out; noted here as a
  pre-existing gap per CLAUDE.md rule 12, not introduced or worsened by this
  plan (batch.html's `connect-src` posture is unchanged — it already had none).
- Reverted every file `npm run build` touched outside this plan's declared
  `files_modified` list (the ~19 marketing/catalogue pages hit by
  `stamp:pages`) via `git checkout --`, since those are pure cache-bust noise
  with zero functional diff and are not this plan's concern.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria were
verified via the exact grep/test commands specified in the plan.

## Issues Encountered

- Initial versions of the three new Promise-chain assertions (refreshBatchOnce
  failure-path, toggleTask/submitPlatoReadings error-toast paths) used
  `Promise.resolve().then(...)` to wait for the fetch chain to settle, which
  only advances one microtask tick — insufficient for a `fetch().then(res =>
  res.json()).then(data => ...)` chain (2 microtask hops). Switched to a
  `flushPromises()` helper using `setTimeout(resolve, 0)` (macrotask), matching
  the existing pattern in `tests/frontend/admin-session-auth.test.js`. Fixed
  before the GREEN commit; not a deviation from the plan, just test-authoring
  correction within Task 2.

## User Setup Required

None — no external service configuration required. This plan's routes
(`/api/batch/public/*`) are built by 82-05 in a separate wave; this plan only
codes the frontend against the documented contract with fetch mocked in tests,
so there is no runtime dependency to wire up here.

## Next Phase Readiness

- `js/batch.js` is fully decoupled from Apps Script/`ADMIN_API_URL` — ready for
  82-05's middleware routes to go live and for 82-09's staging walk-through
  (view batch, tick a task, submit a plato reading on the public page).
- `js/admin.js`/HTML cache-bust stamps from this plan's `npm run build` run are
  already committed, so 82-06/82-07 (the admin.js content rewrites) can proceed
  without re-stamping surprises — though they will still re-run `npm run build`
  themselves per D-23, bumping the same cache versions again.
- Owner note carried forward from CONTEXT: batch.html's missing CSP is a
  pre-existing gap, not newly introduced; if a future phase adds a CSP to
  batch.html, `connect-src` must allow the middleware origin per CLAUDE.md
  rule 12.

## Self-Check: PASSED

All 11 declared files verified present on disk (`js/batch.js`, `js/batch.min.js`,
`batch.html`, `tests/frontend/batch-public-proxy.test.js`, `js/admin.js`,
`js/admin.min.js`, `admin.html`, `kiosk.html`, `brewpad.html`, `index.html`,
this SUMMARY). All 3 commit hashes (`41721bca`, `c1817b3b`, `2fcc6ace`)
verified present in `git log`.

---
*Phase: 82-store-agnostic-prerequisites*
*Completed: 2026-09-23*
