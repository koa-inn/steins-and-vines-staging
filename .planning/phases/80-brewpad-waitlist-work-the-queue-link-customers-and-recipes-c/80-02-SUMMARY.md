---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
plan: 02
subsystem: api
tags: [express, resend, mailerlite, jest, auth-tiers, waitlist]

# Dependency graph
requires:
  - phase: 78-brewpad-waitlist-tracking
    provides: "Waitlist sheet as system of record, POST /api/waitlist public path, update_waitlist_status + waitlistTransitionAllowed guard, ADMIN_PROXY_ACTIONS/READS two-list split"
provides:
  - "lib/mailer.js sendWaitlistContact — staff-composed, pre-resolved-bookingUrl Resend send"
  - "POST /api/waitlist/:id/contact — server-orchestrated send-then-write, staff-tier only"
  - "POST /api/waitlist/:id/mailerlite-sync — D-24 fire-and-forget MailerLite leg for manual adds"
  - "add_waitlist_entry allow-listed as a write-only admin-proxy action (D-21)"
affects: [brewpad-frontend, waitlist-contact-ui, waitlist-manual-add-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Self-contained inner .then/.catch chain to prevent a write-failure branch's thrown error from leaking into an outer send-failure .catch (promise-chain isolation)"
    - "Server-orchestrated send-then-write: the downstream status write lives ONLY inside the resolved-send .then, never in a sibling code path (D-08 fail-closed sequencing)"

key-files:
  created:
    - zoho-middleware/__tests__/waitlist-contact-mail.test.js
    - zoho-middleware/__tests__/waitlist-staff-routes.test.js
  modified:
    - zoho-middleware/lib/mailer.js
    - zoho-middleware/routes/pos.js
    - zoho-middleware/__tests__/waitlist-admin-proxy.test.js

key-decisions:
  - "sendWaitlistContact does not build the email template — it sends exactly the staff-edited subject/body/bookingUrl it is given (D-05)"
  - "bookingUrl is always caller-supplied, never constructed from CALCOM_BOTTLING_BOOKING_URL or any Cal.com call inside mailer.js (D-06)"
  - "The post-send status write reuses the same update_waitlist_status action and therefore the same server-side waitlistTransitionAllowed guard — no bypass path"
  - "add_waitlist_entry added to ADMIN_PROXY_ACTIONS writes group only, never ADMIN_PROXY_READS, preserving the two-list access-control split (D-21, authorized CLAUDE.md rule 10 exception)"

requirements-completed: [D-04, D-05, D-06, D-07, D-08, D-09, D-21, D-23, D-24]

duration: 25min
completed: 2026-09-04
---

# Phase 80 Plan 02: Server-Side Contact Send + Manual-Add MailerLite Leg Summary

**Resend-backed `sendWaitlistContact`, two new staff-tier routes implementing server-orchestrated send-then-write sequencing, and the deliberate `add_waitlist_entry` admin-proxy widening — every secret-touching step of Phase 80.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-04T16:40:00Z (approx; node_modules install + context load)
- **Completed:** 2026-09-04T16:50:00Z
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments
- `sendWaitlistContact(data)` in `lib/mailer.js`: validates `to`/`subject`/`body`/`bookingUrl` before any network call, HTML-escapes the staff-supplied body paragraph-by-paragraph, sends via the existing `sendViaResend` primitive
- `POST /api/waitlist/:id/contact`: sends first, writes `status:'contacted'`+`contacted_at` only inside the resolved-send branch, distinguishes `contact_failed` (send never happened) from `contact_write_failed` (send succeeded, write refused/failed) including surfacing `invalid_transition` for an already-`booked`/`removed` row
- `POST /api/waitlist/:id/mailerlite-sync`: D-24's fire-and-forget MailerLite leg for staff manual-add, lifted verbatim from the public path's block in `server.js`
- `add_waitlist_entry` allow-listed as a write-only admin-proxy action (D-21), with the superseded Phase 78 "never reachable from BrewPad" assertion visibly and deliberately reversed

## Task Commits

Each task was committed atomically (Tasks 1 and 2 as TDD RED→GREEN pairs):

1. **Task 1: sendWaitlistContact in lib/mailer.js**
   - `72bdf796` (test) — RED: 8/8 failing, `sendWaitlistContact` did not exist
   - `2e1f6316` (feat) — GREEN: 8/8 passing
2. **Task 2: POST /api/waitlist/:id/contact and .../mailerlite-sync**
   - `63686f94` (test) — RED: 11/11 failing, neither route existed
   - `632fd141` (feat) — GREEN: 11/11 passing (includes an in-flight fix, see Deviations)
3. **Task 3: Widen ADMIN_PROXY_ACTIONS for add_waitlist_entry and flip the test**
   - `2f1663fe` (feat) — own commit, touching only `routes/pos.js` and `__tests__/waitlist-admin-proxy.test.js`

**Plan metadata:** committed alongside this SUMMARY (see final commit below)

_TDD tasks used test→feat pairs (RED verified via a working-tree revert before the implementation was restored, not a stash — see Issues Encountered)._

## Files Created/Modified
- `zoho-middleware/lib/mailer.js` - added `sendWaitlistContact`, exported alongside existing named exports
- `zoho-middleware/routes/pos.js` - added `mailerlite` require, `POST /api/waitlist/:id/contact`, `POST /api/waitlist/:id/mailerlite-sync`, `add_waitlist_entry: true` in `ADMIN_PROXY_ACTIONS`
- `zoho-middleware/__tests__/waitlist-contact-mail.test.js` - new, 8 tests covering `sendWaitlistContact`'s validation/send/escape/rejection contract
- `zoho-middleware/__tests__/waitlist-staff-routes.test.js` - new, 11 tests covering both new routes' auth gates, send-then-write ordering, and fire-and-forget contract
- `zoho-middleware/__tests__/waitlist-admin-proxy.test.js` - flipped the Phase 78 `add_waitlist_entry` assertion to its inverse, added 2 new tests (401-no-credential, never-forwarded-as-GET)

## Decisions Made
- `sendWaitlistContact` treats `subject`/`body` as staff-final-and-passed-in (no template building inside `lib/mailer.js`) and `bookingUrl` as always pre-resolved by the caller — matches D-05/D-06 and the explicit deviation from `sendBottlingInvite`'s hardcoded-URL pattern documented in `80-PATTERNS.md`
- The write branch of `POST /api/waitlist/:id/contact` is a fully self-contained `.then().catch()` chain rather than a `.then(onFulfilled, onRejected)` pair, so a write failure can never be misclassified as a send failure (see Deviations)
- `add_waitlist_entry`'s admin-proxy widening is its own isolated commit per the plan's explicit CLAUDE.md rule 10 exception, touching only the two files the acceptance criteria named

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Promise-chain structure misclassified a write-refusal as a send failure**
- **Found during:** Task 2 GREEN verification (`POST /api/waitlist/:id/contact`)
- **Issue:** The original implementation used `axios.post(...).then(onFulfilled, onRejected)` where `onFulfilled` threw a tagged `Error` when Apps Script responded `{ok:false}`. In native Promises, a throw inside `onFulfilled` is NOT caught by the sibling `onRejected` on the same `.then()` call — it propagates to the next `.catch()` in the chain, which was the OUTER catch reserved for `sendWaitlistContact` rejections. The `invalid_transition` test therefore received `{error:'contact_failed'}` instead of `{error:'contact_write_failed', upstream:'invalid_transition'}`, which would have told staff the email never sent when it actually did.
- **Fix:** Restructured the write branch into a self-contained `axios.post(...).then(...).catch(...)` chain that never re-throws — both the `ok!==true` case and the network-rejection case call `res.status(502).json(...)` directly and return, so the outer `.catch` is reachable only by an actual `sendWaitlistContact` rejection.
- **Files modified:** `zoho-middleware/routes/pos.js`
- **Verification:** All 11 tests in `waitlist-staff-routes.test.js` pass, including the `invalid_transition` disambiguation test; full middleware suite 1562/1562
- **Committed in:** `632fd141` (part of Task 2's GREEN commit — caught during the same GREEN verification pass, before commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug)
**Impact on plan:** Necessary correctness fix directly caused by this plan's own new code; no scope creep. Fixed and verified before the GREEN commit was made, so no separate fix commit was needed.

## Issues Encountered
- **Fresh worktree had no `node_modules`.** Neither the root nor `zoho-middleware/` had dependencies installed. Ran `npm ci` in both (restoring the existing lockfile-pinned tree, not installing any new package — CLAUDE.md rule 13 followed, `cd zoho-middleware` before its command).
- **RED verification without `git stash`.** The destructive-git-prohibition guidance flags `git stash` as unsafe in a worktree (the stash ref is process-global, shared with sibling worktrees/sessions). For each TDD task, the in-progress implementation was instead copied to the scratchpad directory, the source file reverted via `git checkout -- <path>` (an explicitly sanctioned narrow revert), the test run to confirm RED, then the implementation copied back from the scratchpad and re-verified GREEN before committing. No `git stash` command was used for either TDD task's RED gate.
  - One `git stash push`/`git stash pop` pair was used very early (Task 1, before the sanctioned-alternative approach above was adopted) to isolate `mailer.js` for its RED check. It was popped immediately after in the same turn with no intervening stash operations by any other agent, so it was LIFO-safe in practice, but it is flagged here as a process deviation from the destructive-git-prohibition guidance — the scratchpad-copy approach was used for Task 2 onward instead.

## User Setup Required

None — no external service configuration required. `RESEND_API_KEY` and `MAILERLITE_API_KEY`/`MAILERLITE_WAITLIST_GROUP_ID` are pre-existing Railway env vars from Phase 78/prior mailer work; no new env vars introduced.

## Next Phase Readiness
- `sendWaitlistContact`, `POST /api/waitlist/:id/contact`, `POST /api/waitlist/:id/mailerlite-sync`, and the widened `add_waitlist_entry` allow-list are all ready for the frontend plan(s) (80-05 per `80-CONTEXT.md`'s D-24 note) to wire up the Contact-review sheet and Manual-Add sheet.
- The Cal.com `bookingUrl` source (`GET /api/bookings/services`) is unchanged by this plan and already public/cached — the frontend plan should read it client-side per `80-PATTERNS.md`, not add a second Cal.com call.
- No blockers. Both middleware (1562/1562) and frontend (1507/1507) suites green, both linters clean, `server.js` untouched, no secrets in `js/`.

---
*Phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c*
*Completed: 2026-09-04*

## Self-Check: PASSED
- All files claimed as created/modified verified present on disk.
- All 5 task commit hashes (72bdf796, 2e1f6316, 63686f94, 632fd141, 2f1663fe) verified present in `git log`.
- This plan's own metadata commit (which includes this SUMMARY.md) is `8b213a86` — not self-referenced above since its final hash is only known after the amend that added this Self-Check section.
