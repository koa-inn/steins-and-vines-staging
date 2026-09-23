---
phase: 82-store-agnostic-prerequisites
plan: 05
subsystem: api
tags: [express, axios, rate-limit, token-auth, proxy]

# Dependency graph
requires:
  - phase: 82-store-agnostic-prerequisites
    provides: "82-04's forwardToAppsScript(action, payload, isRead, logTag, res) shared helper in zoho-middleware/routes/pos.js"
  - phase: 82-store-agnostic-prerequisites
    provides: "82-08's js/batch.js already coded against the exact GET/POST /api/batch/public/:id[/tasks|/readings] contract this plan serves"
provides:
  - "GET /api/batch/public/:id — forwards get_batch_public (batch_id, token) via axios.GET"
  - "POST /api/batch/public/:id/tasks — forwards update_batch_task (batch_id from route, batch_token, task_id, updates) via axios.POST"
  - "POST /api/batch/public/:id/readings — forwards bulk_add_plato_readings (batch_id from route, batch_token, readings) via axios.POST"
  - "batchPublicLimiter — 30/min per-IP rate limiter (no Redis-down skip) mounted on /api/batch/public"
  - "Zoho-guard and key/tier-guard '/batch/public/' prefix exemptions in server.js"
affects: [82-09-rollout]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Public, token-authenticated route built from an explicit field whitelist (never Object.assign(req.body/req.query)) calling the shared forwardToAppsScript helper with no authTiers wrapper — the pattern for any future middleware route where a non-staff token (not a session/device/legacy credential) is the sole authenticator"
    - "Path-prefix guard exemption ('/batch/public/') added as an early-return check inside the existing Zoho and key/tier app.use('/api', ...) middlewares, rather than widening an exact-match allowlist (KEYLESS_POSTS stays untouched)"

key-files:
  created:
    - zoho-middleware/__tests__/batch-public.test.js
    - zoho-middleware/__tests__/batch-public-guard.test.js
  modified:
    - zoho-middleware/routes/pos.js
    - zoho-middleware/server.js

key-decisions:
  - "batch_id always comes from req.params.id (the route), never from the request body — proven by a test that sends a different body.batch_id and asserts the forwarded payload uses the route id, closing the smuggling vector named in T-82-05-02/T-82-05-01"
  - "batchPublicLimiter has no skip (mirrors apiLimiter/paymentLimiter/pinLimiter's D-07 in-process memStore fallback) — an unauthenticated write surface must stay throttled even when Redis is down"
  - "Guard exemptions are two separate 'req.path.indexOf(\"/batch/public/\") === 0' early returns (Zoho guard + key/tier guard), not additions to the KEYLESS_POSTS exact-match array — confirmed via git diff that KEYLESS_POSTS itself is untouched"

patterns-established:
  - "Token-authenticated public route: build payload from an explicit whitelist, call the shared forwardToAppsScript helper, no authTiers, no caching, no token-format validation — validator lives entirely in Apps Script (D-13)"

requirements-completed: [DB-01]

# Metrics
duration: ~20min
completed: 2026-09-23
---

# Phase 82 Plan 05: Public Batch-Page Middleware Routes Summary

**Three token-authenticated /api/batch/public routes (get_batch_public, update_batch_task, bulk_add_plato_readings) added to pos.js with a dedicated 30/min-per-IP limiter and Zoho/key-guard prefix exemptions in server.js, giving batch.html a middleware path that never talks to Apps Script directly.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-23T20:40:00Z (approx)
- **Completed:** 2026-09-23T20:46:42Z
- **Tasks:** 2/2 completed
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- `GET /api/batch/public/:id` forwards exactly `{action:'get_batch_public', batch_id, token}` via `axios.get` — no `server_token`, no extra keys, `axios.post` never called.
- `POST /api/batch/public/:id/tasks` forwards exactly `{action:'update_batch_task', batch_id (route), batch_token, task_id, updates}` via `axios.post` — a client-supplied `action`, `server_token`, or `batch_id` in the body is silently dropped/ignored.
- `POST /api/batch/public/:id/readings` forwards exactly `{action:'bulk_add_plato_readings', batch_id (route), batch_token, readings}` via `axios.post`.
- A malformed token is still forwarded as-is (middleware does not validate token format) — the upstream `{ok:false,error:'invalid_token'}` body passes through untouched at HTTP 200 (D-13).
- `batchPublicLimiter` (30/min per IP, `makeRedisStore` with no `skip`) mounted on `/api/batch/public`, proven to trip 429 after 30 requests from one IP while leaving another `/api` path's own bucket unaffected.
- Both `app.use('/api', ...)` guards (Zoho-authenticated check, key/tier check) exempt exactly the `/batch/public/` path prefix — proven by supertest against the real app that `/api/admin/proxy` and an existing keyed `/api/batch/*` POST (`sync-zoho`) still require credentials, and that an existing route (`/api/orders/recent`) is still 401 when Zoho is unauthenticated.
- 18 new tests (12 in `batch-public.test.js`, 6 in `batch-public-guard.test.js`); full middleware suite now 114 suites / 1705 tests, all green; root frontend suite 131 suites / 1864 tests, all green; both linters clean.

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1 (RED): add failing tests for /api/batch/public routes** - `df108397` (test)
2. **Task 1 (GREEN): add /api/batch/public routes forwarding to Apps Script** - `cfa1e895` (feat)
3. **Task 2 (RED): add failing tests for batch-public guard exemptions + limiter** - `11d4902b` (test)
4. **Task 2 (GREEN): exempt /batch/public/ from Zoho + key guards, add per-IP limiter** - `4709917f` (feat)

## Files Created/Modified

- `zoho-middleware/__tests__/batch-public.test.js` - New 12-test suite (mock-express-router + mock-axios harness cloned from `batch-admin-proxy.test.js`) pinning the exact forwarding contract for all 3 routes, including the malformed-token pass-through, 502 collapse, and no-authTiers-gate assertions
- `zoho-middleware/__tests__/batch-public-guard.test.js` - New 6-test supertest suite (full-app-require harness cloned from `auth-tiers-guard.test.js`) proving the guard exemptions are scoped exactly to `/batch/public/` and the limiter trips at 30/min per IP
- `zoho-middleware/routes/pos.js` - Added the 3 public batch routes directly after `/api/admin/proxy`, each building an explicit whitelisted payload and calling the existing `forwardToAppsScript` helper
- `zoho-middleware/server.js` - Added a `/batch/public/` prefix early-return in the Zoho guard and the key/tier guard; added `batchPublicLimiter` (defined next to `telemetryLimiter`, mounted next to the `clientErrorLimiter`/`telemetryLimiter` mounts)

## Decisions Made

- Followed the plan's route contract literally: GET reads `req.query.token`, POST routes read `batch_token`/`task_id`/`updates`/`readings` from the body, and `batch_id` always comes from `req.params.id` — never the body — for all three routes.
- `batchPublicLimiter` uses the plan's specified 30/min ceiling with no `skip`, matching the D-07 rationale already established for `apiLimiter`/`paymentLimiter`/`pinLimiter`.
- Used `/api/batch/sync-zoho` (an existing keyed POST) as the "still requires credentials" negative-control route in the guard test, since the plan's suggested `/api/batch/scan-invoices` is actually a GET in the codebase.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria were verified via the exact grep/test commands specified in the plan.

## Issues Encountered

- `zoho-middleware/node_modules` and root `node_modules` were both absent in this fresh worktree (`npm ci` run in both before testing — matches the environment-setup note already recorded in 82-04-SUMMARY.md, not a plan deviation).

## User Setup Required

None — no external service configuration required. These routes are dead code from the browser's perspective until 82-09's staging rollout, other than for js/batch.js (82-08, already merged) which is coded against this exact contract and will start resolving successfully once this plan's commits reach staging.

## Next Phase Readiness

- `/api/batch/public/:id`, `/api/batch/public/:id/tasks`, and `/api/batch/public/:id/readings` are live and fully tested, ready for 82-09's staging deploy + UAT (view a batch, tick a task, submit a plato reading via the public batch QR page).
- T-82-05-06 (a batch-A token updating a task that belongs to batch B — `handleBatchTokenPost` does not check the task belongs to `payload.batch_id`) is a pre-existing Apps Script gap, unchanged by this plan, and remains an accepted risk flagged for Phase 87 per the plan's threat model.
- No blockers.

## Threat Flags

None — every trust boundary and threat register entry in the plan's `<threat_model>` was already accounted for by the implementation; no new security-relevant surface was introduced beyond what the plan specified.

---
*Phase: 82-store-agnostic-prerequisites*
*Completed: 2026-09-23*

## Self-Check: PASSED

- FOUND: zoho-middleware/__tests__/batch-public.test.js
- FOUND: zoho-middleware/__tests__/batch-public-guard.test.js
- FOUND: zoho-middleware/routes/pos.js
- FOUND: zoho-middleware/server.js
- FOUND: .planning/phases/82-store-agnostic-prerequisites/82-05-SUMMARY.md
- FOUND commit: df108397 (test, Task 1 RED)
- FOUND commit: cfa1e895 (feat, Task 1 GREEN)
- FOUND commit: 11d4902b (test, Task 2 RED)
- FOUND commit: 4709917f (feat, Task 2 GREEN)
