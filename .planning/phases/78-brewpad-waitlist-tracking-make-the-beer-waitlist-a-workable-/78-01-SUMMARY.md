---
phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
plan: 01
subsystem: api
tags: [apps-script, google-sheets, waitlist, idempotency, brewpad]

# Dependency graph
requires:
  - phase: 51-gift-card-ledger-integrity
    provides: ensureGiftCardLedgerSheet/setupGiftCardLedger bootstrap shape and giftCardLedgerDecision pure-decision shape, copied verbatim for the Waitlist tab
provides:
  - "Waitlist sheet tab schema (id, email, category, status, signed_up_at, mailerlite_synced, notes) as the system of record (D-01)"
  - "ensureWaitlistSheet()/setupWaitlist() idempotent, fail-closed bootstrap"
  - "normalizeWaitlistEmail, waitlistCellSafe, waitlistSyncedTrue pure helpers"
  - "waitlistDedupeDecision(rows, email, category) pure D-06 idempotency decision"
  - "addWaitlistEntry / getWaitlist / updateWaitlistStatus handlers, routed through doPost's server_token block and the handleReadAction switch"
  - "tests/frontend/adminapi-waitlist-pure.test.js — 50 assertions (behavioural + source-shape) via the new Function source-extraction harness"
affects: [78-02, 78-03, 78-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sheet bootstrap: self-healing on missing tab, fail-closed (never repair headers) on drift — copied from ensureGiftCardLedgerSheet"
    - "Pure decision function taking pre-fetched rows as its first argument, zero Apps Script globals, tested via new Function source extraction"
    - "No LockService for non-money-adjacent sheet lists (mirrors addReservation, not the gift-card handlers)"

key-files:
  created: [tests/frontend/adminapi-waitlist-pure.test.js]
  modified: [apps-script/adminApi.gs]

key-decisions:
  - "Column A is a generated Utilities.getUuid() id, never the customer email — keeps findRowById's column-A-is-unique-key assumption valid once D-02's multi-category future lands"
  - "getWaitlist() returns either an array (success) or the ensureWaitlistSheet() failure object directly; handleReadAction's get_waitlist case detects which and avoids nesting a failure under `data`"
  - "A waitlist row with status 'removed' still counts as a dedupe match in waitlistDedupeDecision — re-signup does not create a second row; staff flip the existing row via BrewPad instead"

patterns-established:
  - "waitlistCellSafe(value): sanitizeInput() then apostrophe-prefix a leading =/+/-/@ — local formula-injection mitigation for new waitlist cells only, does not close M9 project-wide"

requirements-completed: [D-01, D-02, D-05, D-06, D-07, D-08]

# Metrics
duration: ~15min
completed: 2026-09-02
---

# Phase 78 Plan 01: Waitlist Sheet Schema, Bootstrap, Pure Helpers & Handlers Summary

**Apps Script `Waitlist` sheet tab with fail-closed bootstrap, a pure D-06 dedupe decision, and three server_token/handleReadAction-routed handlers (add/list/update-status), proven by a 50-assertion Jest source-extraction suite.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-09-02T22:17:02Z (base commit 7120ee0a)
- **Completed:** 2026-09-02T22:28:12Z
- **Tasks:** 2 completed
- **Files modified:** 2 (`apps-script/adminApi.gs`, `tests/frontend/adminapi-waitlist-pure.test.js`)

## Accomplishments
- `Waitlist` tab is now a fully specified system of record: 7-column schema (`id`, `email`, `category`, `status`, `signed_up_at`, `mailerlite_synced`, `notes`), idempotent self-healing bootstrap (`ensureWaitlistSheet`/`setupWaitlist`) that fails closed on header drift rather than repairing or reordering columns.
- D-06 non-disclosure idempotency is a strictly pure function (`waitlistDedupeDecision`) with zero Apps Script globals, unit-tested via the `new Function` source-extraction harness this repo already uses for the gift-card ledger.
- All three waitlist actions (`add_waitlist_entry`, `update_waitlist_status`, `get_waitlist`) exist, are routed exclusively through the already-authenticated `doPost` `server_token` block / `handleReadAction` switch, and take no script lock.
- `updateWaitlistStatus` validates the D-05 status literal BEFORE any `setValue`, so an invalid status writes nothing.
- `getWaitlist` strips `_row` via an explicit field allowlist and skips the cache layer entirely, matching `getGiftCards`' precedent.

## Task Commits

Each task was committed atomically:

1. **Task 1: Waitlist sheet schema, idempotent bootstrap, and the pure helpers** - `e5af4c98` (feat)
2. **Task 2: Waitlist handlers (add / list / update) and doPost + handleReadAction dispatch** - `abdddc10` (feat)

_No plan-metadata commit yet — SUMMARY.md commit is separate, per worktree-mode instructions (STATE.md/ROADMAP.md excluded)._

## Files Created/Modified
- `apps-script/adminApi.gs` — added `WAITLIST_SHEET_NAME` constant; `ensureWaitlistSheet()`/`setupWaitlist()` bootstrap; `normalizeWaitlistEmail`, `waitlistCellSafe`, `waitlistSyncedTrue`, `waitlistDedupeDecision` pure helpers; `addWaitlistEntry`, `getWaitlist`, `updateWaitlistStatus` handlers; two new `doPost` server_token branches; one new `handleReadAction` case.
- `tests/frontend/adminapi-waitlist-pure.test.js` — new file, 50 tests: behavioural coverage of the four pure helpers plus source-shape assertions for the bootstrap, handlers, purity, and dispatch wiring.

## Decisions Made
- Followed the plan's `<interfaces>` contract exactly (shared with plans 78-02/78-03) — no deviation in request/response shapes, action names, or header order.
- Comment wording in `addWaitlistEntry` was written to avoid the literal substrings "already"/"duplicate" so the D-06 non-disclosure source-assertion test (which scans the whole function body, comments included) passes on the intent it's checking, not just the code.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- First run of the D-06 non-disclosure test failed because an explanatory code comment inside `addWaitlistEntry` used the word "already" (in `already_listed`, listing forbidden field names). Reworded the comment to describe the same constraint without using the forbidden words — no functional code change, caught before commit (not counted as a deviation since it was resolved within the same task's normal write/test/fix loop, not a bug in shipped logic).

## User Setup Required

None - no external service configuration required. (The manual Apps Script redeploy this phase ultimately needs is scoped to plan 78-04, not this plan.)

## Next Phase Readiness
- `apps-script/adminApi.gs` now exposes the full server-side waitlist contract (`add_waitlist_entry`, `get_waitlist`, `update_waitlist_status`) that plans 78-02 (middleware wiring) and 78-03 (BrewPad UI) depend on per the shared `<interfaces>` block.
- Not yet deployed to the live Apps Script Web App — per RESEARCH.md Pitfall 2, this is a separate manual owner redeploy (plan 78-04), not automatable here.
- `npm test` (full frontend suite, 95 suites / 1443 tests) and `npm run lint` both exit 0 with no regressions in `adminapi-giftcard-ledger.test.js` or `adminapi-recipe-pure.test.js`.

---
*Phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-*
*Completed: 2026-09-02*
