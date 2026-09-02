---
phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
plan: 02
subsystem: api
tags: [express, axios, apps-script, mailerlite, admin-proxy, waitlist]

# Dependency graph
requires:
  - phase: 78-01
    provides: "apps-script/adminApi.gs add_waitlist_entry / get_waitlist / update_waitlist_status handlers and the Waitlist sheet tab (the shared interface contract this plan calls against)"
provides:
  - "POST /api/waitlist rewritten so the Waitlist sheet row (not MailerLite) decides success — D-03"
  - "MailerLite demoted to fire-and-forget best-effort with a persisted mailerlite_synced drift signal — D-07"
  - "get_waitlist and update_waitlist_status reachable from BrewPad through the existing hardened /api/batch/admin-proxy"
  - "Two new middleware test files proving the D-03/D-06/D-07 endpoint contract and the two-whitelist proxy gate"
affects: [78-03, 78-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A fourth private callAppsScript(action, payload) helper in server.js, matching the pattern already duplicated in routes/gift-cards.js, routes/recipes.js, routes/pos-recipe.js — deliberately not extracted into a shared lib (CLAUDE.md rule 3)"
    - "Fail-closed only on the authoritative write; third-party marketing sync is fire-and-forget with a persisted drift flag instead of a log line (Phase 51 criterion-2 lesson, reapplied)"

key-files:
  created:
    - zoho-middleware/__tests__/waitlist-route.test.js
    - zoho-middleware/__tests__/waitlist-admin-proxy.test.js
  modified:
    - zoho-middleware/server.js
    - zoho-middleware/routes/pos.js

key-decisions:
  - "The pre-existing 503-on-MailerLite-unconfigured guard was moved (not deleted) to gate on the add_waitlist_entry sheet write instead, per CONTEXT.md's explicit planner note"
  - "category is hardcoded server-side to 'beer' — req.body.category is never read, closing off an unauthenticated caller's ability to choose which queue a row lands in (T-78-07)"
  - "add_waitlist_entry was deliberately left off both ADMIN_PROXY_ACTIONS and ADMIN_PROXY_READS — staff never create waitlist rows from BrewPad; signups only arrive via the public endpoint's own server_token call"

patterns-established:
  - "Pattern: blocking Apps Script write for the record-of-truth, exactly one call, no retry wrapper — because the admin proxy collapses upstream transport errors to 502, a retry cannot distinguish 'never happened' from 'already happened' (RESEARCH.md Pitfall 4)"

requirements-completed: [D-03, D-06, D-07]

# Metrics
duration: ~25min
completed: 2026-09-02
---

# Phase 78 Plan 02: Waitlist sheet write + admin-proxy allow-list Summary

**Rewrote `POST /api/waitlist` so a blocking Apps Script sheet write is authoritative and MailerLite is fire-and-forget best-effort, then opened `/api/batch/admin-proxy`'s two hardcoded allow-lists for BrewPad's `get_waitlist`/`update_waitlist_status` reads and writes.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-02
- **Tasks:** 2
- **Files modified:** 4 (2 source, 2 new test files)

## Accomplishments
- `POST /api/waitlist` now awaits exactly one `add_waitlist_entry` call and returns 503 only when that sheet write itself fails or transport-errors — a MailerLite outage or missing `MAILERLITE_API_KEY` no longer turns a customer away.
- MailerLite success now fires a best-effort `update_waitlist_status` call setting `mailerlite_synced: true`, giving marketing drift a durable cell instead of a vanishing log line (D-07).
- `get_waitlist` is reachable through `/api/batch/admin-proxy` as a GET (both allow-list objects updated); `update_waitlist_status` is reachable as a POST (write-only allow-list entry); `add_waitlist_entry` remains unreachable from any staff browser.
- Two new test files (14 total new test cases) lock in the D-03/D-06/D-07 contract and the two-whitelist gate.

## Task Commits

Each task was committed atomically:

1. **Task 1: Make the Waitlist sheet write authoritative in POST /api/waitlist and demote MailerLite** - `63f6d524` (feat)
2. **Task 2: Allow-list the waitlist actions on /api/batch/admin-proxy — both objects** - `2105f61a` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `zoho-middleware/server.js` - `POST /api/waitlist` rewritten: added `axios` require, local `callAppsScript()` helper, blocking `add_waitlist_entry` write with the 503 guard relocated onto it, fire-and-forget MailerLite + best-effort `mailerlite_synced` sync-flag write, hardcoded `category: 'beer'`, identical response for new/dedupe signups.
- `zoho-middleware/routes/pos.js` - `get_waitlist: true` added to both `ADMIN_PROXY_ACTIONS` and `ADMIN_PROXY_READS`; `update_waitlist_status: true` added to `ADMIN_PROXY_ACTIONS` only. Handler body untouched.
- `zoho-middleware/__tests__/waitlist-route.test.js` - 9 new tests (T1–T9) covering the happy path, the D-03 MailerLite-unconfigured/reject cases, fail-closed on `{ok:false}` and on transport rejection (with the no-retry call-count assertion), the D-07 sync-flag write, invalid email, the ignored client-supplied `category`, and D-06 byte-identical dedupe response.
- `zoho-middleware/__tests__/waitlist-admin-proxy.test.js` - 5 new tests covering `get_waitlist` routing via GET with token-strip, `update_waitlist_status` routing via POST, `add_waitlist_entry` rejected 400, no-credential 401, and device-tier rejection.

## Decisions Made
- Followed CONTEXT.md's explicit planner note: the 503 guard moved from "MailerLite unconfigured" to "sheet write failed" rather than being deleted.
- Followed RESEARCH.md Pattern 5 / Pitfall 4: no retry wrapper around `add_waitlist_entry`; exactly one call per request, asserted by a dedicated call-count test.
- Followed the plan's explicit instruction not to extract a shared `lib/apps-script.js` for the fourth `callAppsScript` copy — flagged via a code comment instead (CLAUDE.md rule 3, out-of-scope refactor).

## Deviations from Plan

None - plan executed exactly as written. One environment note: this worktree had no `node_modules` installed for either the root or `zoho-middleware` package (git worktrees don't carry `node_modules`); ran `npm install` in both locations before any test could execute. This is routine worktree setup, not a plan deviation, and is not tracked as a Rule 1–4 fix since it modified no source files (only restored `node_modules`, which is gitignored).

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required by this plan. (Plan 78-04's Apps Script redeploy, covering the `add_waitlist_entry`/`get_waitlist`/`update_waitlist_status` handlers this plan calls, is tracked separately — this plan's own verification note states these calls will surface as 503 against the still-undeployed Apps Script until that redeploy happens, which is expected and not a defect here.)

## Next Phase Readiness
- The middleware contract (`/api/waitlist` response shape, `add_waitlist_entry`/`get_waitlist`/`update_waitlist_status` request/response shapes) matches the shared `<interfaces>` block in 78-01/78-02/78-03 exactly, so 78-03 (BrewPad UI) can build against `get_waitlist`/`update_waitlist_status` via `adminApiGet`/`adminApiPost` without further contract changes.
- Not verifiable in this plan: whether the deployed Apps Script recognises the three new actions — that depends on 78-01's code existing AND the owner's manual redeploy in 78-04. Until then, live calls will 503/400 as documented in the plan's `<verification>` section.

## Self-Check: PASSED

All claimed files verified present (`zoho-middleware/server.js`, `zoho-middleware/routes/pos.js`,
`zoho-middleware/__tests__/waitlist-route.test.js`, `zoho-middleware/__tests__/waitlist-admin-proxy.test.js`,
this SUMMARY.md) and all claimed commit hashes verified present in `git log`
(`63f6d524`, `2105f61a`, `bed7facb`).

---
*Phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-*
*Completed: 2026-09-02*
