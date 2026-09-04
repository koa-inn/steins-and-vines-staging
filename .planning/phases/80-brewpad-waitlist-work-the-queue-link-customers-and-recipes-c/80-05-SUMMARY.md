---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
plan: 05
subsystem: ui
tags: [brewpad, waitlist, es5, jsdom, resend, mailerlite, fail-closed, reuse-not-rebuild]

# Dependency graph
requires:
  - phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c (plan 80-02)
    provides: "POST /api/waitlist/:id/contact (server-orchestrated send-then-write),
      POST /api/waitlist/:id/mailerlite-sync, add_waitlist_entry allow-listed in
      ADMIN_PROXY_ACTIONS"
  - phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c (plan 80-04)
    provides: "widened renderWaitlist() with Customer/Recipes cells, the
      .bp-vessel-*/_waitlistRecipeCatalog multi-select shape this plan's manual-add
      Recipes field reuses, adminApiPost('update_waitlist_status', ...)"
provides:
  - "Contact column + review sheet — resolves the Cal.com booking link
    client-side, pre-fills an editable subject/body, sends through the
    staff-tier endpoint with a fail-closed inline error on failure (D-04-D-09)"
  - "'+ Add to Waitlist' toolbar trigger + manual-add sheet with client-side
    email validation, a get_waitlist-before-add snapshot, optional-field
    write, MailerLite sync, and the D-23 in-sheet duplicate disclosure
    (D-21-D-25)"
affects: [80-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Snapshot-diff dedupe detection: a get_waitlist read taken immediately
       before a shared-handler write, diffed against the write's returned id,
       used client-side to derive a disclosure the server's response
       deliberately cannot carry (D-23 RACE comment documents the accepted
       race window and why the snapshot diff was chosen over changing the
       shared handler's return shape)"
    - "Sheet-local accumulation before a single combined write: the manual-add
       Recipes picker reuses 80-04's multi-select markup/catalog cache but
       collects selections in a closure-local array instead of writing
       per-tap, because the row it would attach to does not exist until submit"

key-files:
  created:
    - tests/frontend/brewpad-waitlist-contact.test.js
    - tests/frontend/brewpad-waitlist-manual-add.test.js
  modified:
    - js/brewpad.js
    - css/brewpad.css
    - js/brewpad.min.js
    - css/brewpad.min.css
    - brewpad.html (cache-buster query string bump, side effect of npm run build)

key-decisions:
  - "The Contact sheet's To field is read-only and the send always reads
     row.email directly — never the DOM input's value — so the field cannot
     be used to retarget an email to a different inbox (T-80-28)"
  - "No client code path ever writes status:'contacted'; the status transition
     lives entirely inside POST /api/waitlist/:id/contact's server-side
     resolved-send branch (D-08) — verified by a diff-scoped grep gate, not
     just code review"
  - "The manual-add Recipes picker deliberately does NOT reuse 80-04's
     write-per-selection attachWaitlistRecipe/renderWaitlistRecipeAttachPanel
     functions verbatim — those write to an existing row id. A new local
     variant reuses the same markup classes and the same
     _waitlistRecipeCatalog lazy-fetch cache, but only writes once, at
     submit, alongside name/phone"
  - "D-23 disclosure reads the PRE-write snapshot's signed_up_at/status, never
     a post-write re-read, since a reinstated removed row's timestamp
     refreshes server-side and the pre-write value is the honest answer to
     when the customer signed up"

requirements-completed: [D-05, D-06, D-07, D-08, D-21, D-22, D-23, D-24, D-25]

# Metrics
duration: ~45min
completed: 2026-09-04
---

# Phase 80 Plan 05: BrewPad Waitlist — Contact Review Sheet + Manual Add Summary

**Contact column/sheet with a client-resolved Cal.com link and D-08 fail-closed send, plus a manual-add sheet with client-side validation, a get_waitlist-before-add snapshot, and the D-23 duplicate-signup disclosure — the two sheet-based flows that complete Phase 80.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-09-04
- **Tasks:** 2 (both `tdd="true"`: RED commit then GREEN commit each)
- **Files modified:** 7 (2 new test files, js/brewpad.js, css/brewpad.css, js/brewpad.min.js, css/brewpad.min.css, brewpad.html)

## Accomplishments

- A `Contact` column (bare-verb `.btn bp-btn-sm`, between Status and Notes)
  renders on every waitlist row, disabled via the native `disabled` attribute
  on `booked`/`removed` rows using the existing `actionable` predicate.
- Tapping Contact opens `#bp-waitlist-contact-sheet` (verbatim reuse of the
  `.bp-create-sheet` shell), shows `Preparing email…`, resolves the booking
  link from `GET /api/bookings/services` (no new Cal.com call), and on
  success pre-fills a read-only To, an editable Subject, and an editable Body
  textarea with the resolved booking URL interpolated inline.
- Send issues exactly one `POST /api/waitlist/:id/contact` carrying the
  edited subject/body and the row's email (never the DOM's To value). Success
  closes the sheet, refreshes the list, and toasts `Email sent — marked
  Contacted`. A `contact_write_failed` response is distinguished in the
  inline error text from a `contact_failed` one so staff know whether the
  email actually went out.
- D-08 verified structurally: no client code path ever writes
  `status:'contacted'` (grep-gated on the diff), and a failed send leaves the
  sheet open with an unmistakable inline `--batch-danger` error, re-enabled
  Send, and no success toast.
- A `+ Add to Waitlist` toolbar trigger (`.btn bp-new-batch-btn`, same
  placement pattern as `+ New Batch`) opens `#bp-waitlist-add-sheet` with
  Email (required)/Name/Phone/Recipes (all optional). Client-side email
  validation runs before any request; the Recipes field reuses 80-04's
  multi-select markup and `_waitlistRecipeCatalog` cache, accumulating
  selections in a sheet-local array until submit.
- Submit order is exactly: `adminApiGet('get_waitlist')` snapshot →
  `adminApiPost('add_waitlist_entry', {email, category:'beer'})` (no
  `signed_up_at` — D-25, server-stamped) → if the returned id is new, one
  `update_waitlist_status` carrying only the filled optional keys, then the
  `mailerlite-sync` fire-and-forget leg (D-24), close, toast `Added to
  waitlist`.
- D-23: when the returned id is already present in the pre-write snapshot,
  the sheet body swaps in place to `{email} is already on the beer waitlist —
  signed up {date}, currently {Status}.` with a single `Got It` dismissal —
  no optional-field write, no MailerLite sync, sheet stays open until
  dismissed. A `D-23 RACE:` comment anchors the snapshot-diff tradeoff
  (race window, why the shared-handler return shape was not changed instead,
  and why the false-negative is an accepted risk) at the exact check site.
- A write failure at any step keeps the sheet open with the typed values
  intact and shows `Failed: ' + err.message` inline, never a toast.
- `js/modules/`, `beer.html`, `zoho-middleware/server.js`, and
  `tests/frontend/checkout-waitlist.test.js` all confirmed untouched (`git
  diff --numstat`); minified artifacts rebuilt via `npm run build`.

## Task Commits

Each task was committed atomically as RED then GREEN:

1. **Task 1: Contact column and review sheet with fail-closed send** (tdd) —
   `e4a8da0d` (test, RED — 18/18 fail: `_openWaitlistContactSheetForTest` does not exist) →
   `0114ec54` (feat, GREEN — 18/18 pass)
2. **Task 2: manual-add sheet with the D-23 disclosure state and MailerLite sync** (tdd) —
   `eda9e7b7` (test, RED — 12/12 fail: `_openWaitlistAddSheetForTest` does not exist) →
   `44ae2816` (feat, GREEN — 12/12 pass; includes the `npm run build` artifacts)

_Verification for both RED commits: the test file was run against the tree
exactly as it stood before that task's implementation edits (no `git stash` —
per the destructive-git-prohibition guidance, verified via the commit
boundary itself since each RED commit strictly precedes its GREEN commit),
confirming every test failed on the missing test seam, not an unrelated
error — then the implementation was added and the suite re-run to confirm
GREEN before committing._

## Files Created/Modified

- `js/brewpad.js` — Contact column cell + `openWaitlistContactSheet`/
  `renderWaitlistContactForm`/`sendWaitlistContact`; `+ Add to Waitlist`
  toolbar trigger + `openWaitlistAddSheet`/`renderWaitlistAddForm`/
  `submitWaitlistAdd`/`showWaitlistAddDisclosure`; delegated click handler
  for the Contact trigger; module.exports test seams
  (`_openWaitlistContactSheetForTest`, `_openWaitlistAddSheetForTest`)
- `css/brewpad.css` — one additive `.bp-waitlist-form-error` rule (verbatim
  copy of the existing `.bp-waitlist-pos-error` shape) shared by both sheets'
  inline error lines
- `tests/frontend/brewpad-waitlist-contact.test.js` — 18 tests: disabled
  state, loading/error/populated sheet states, editable subject/body, D-05
  edit-before-send, D-07 success, D-08 fail-closed, contact_write_failed vs
  contact_failed distinguishability
- `tests/frontend/brewpad-waitlist-manual-add.test.js` — 12 tests: toolbar
  trigger, validation, get_waitlist-before-add ordering, no-signed_up_at
  payload, new-row optional-write + sync, D-23 disclosure (no sync, no
  optional write, stays open), write-failure-keeps-typed-values, and a
  documentation-gate test asserting the `D-23 RACE:` comment exists
- `js/brewpad.min.js`, `css/brewpad.min.css` — rebuilt via `npm run build`
- `brewpad.html` — cache-buster query string for `brewpad.min.js`/`.css`
  bumped (necessary consequence of rebuilding those two artifacts; every
  other file the shared build script touched was reverted — see Issues
  Encountered, same pattern as 80-03/80-04)

## Decisions Made

- **To field is read-only, send reads `row.email` directly** — matches
  T-80-28's mitigation exactly; the DOM value is never trusted even if a test
  or a browser extension could theoretically mutate it.
- **The Contact sheet never calls `adminApiPost`** — the send is a single raw
  `fetch` to `/api/waitlist/:id/contact`; the status write to `'contacted'`
  is entirely the server's second leg (D-08). A grep gate on the diff enforces
  no added `status: 'contacted'` line.
- **Manual-add's Recipes picker is a new local-array variant, not a call into
  80-04's `attachWaitlistRecipe`** — that function writes immediately per
  selection against an existing row id, which doesn't exist yet in the
  manual-add flow. The new variant reuses the same `.bp-vessel-*` markup and
  the same `_waitlistRecipeCatalog` cache (so a warm cache from the row-level
  picker benefits this sheet too) but defers the write to the single combined
  submit.
- **D-23 disclosure uses the pre-write snapshot's `signed_up_at`/`status`,
  never a post-write re-read** — a reinstated `removed` row's timestamp
  refreshes server-side on the same write, so re-reading after the write
  would show a start-of-queue timestamp instead of the honest original
  signup date.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria
(grep-gated string counts, the ES5-only diff gate, the `js/modules/`/
`beer.html`/`server.js`/`checkout-waitlist.test.js` untouched gate, and the
`D-23 RACE:` documentation anchor) all verified directly against the diff
before each GREEN commit, not just inferred from test passes.

## Issues Encountered

- **`fetchWithRetry`'s real 1000ms backoff on a network-level rejection**
  (`js/brewpad.js:1691-1710`, unrelated to this plan, pre-existing) meant two
  tests needed a real-timer wait longer than a single microtask flush: the
  manual-add write-failure test waits 1200ms past the click to let
  `adminApiPost`'s one retry exhaust, and both sheets' success-close tests
  wait 200ms past the 180ms sheet-close animation delay before asserting DOM
  removal. Neither is a production behavior change — both are test-timing
  accommodations for existing, correct retry/animation code.
- **Two comment-wording collisions with this plan's own diff-scoped grep
  gates**, caught and fixed before the GREEN commit: an early draft of the
  Contact sheet's block comment used the literal substring
  `CALCOM_BOTTLING_BOOKING_URL` (tripping the `listEventType\|
  CALCOM_BOTTLING_BOOKING_URL` gate meant to catch *code*, not prose) and a
  draft Contact-column comment used the phrase "would let staff send" (the
  word "let " tripped the ES5 `const \|let \|=>` gate meant to catch *var/let
  declarations*, not English prose). Both were reworded without losing
  meaning — verified by re-running the exact acceptance-criteria grep
  commands against the diff before committing.
- **`npm run build` regenerates cache-buster query strings and timestamps
  across every public page and `js/admin.js`/`.min.js`**, not just BrewPad's
  artifacts — same out-of-scope side effect 80-03/80-04 documented. Reverted
  every touched file outside this plan's `files_modified` via `git checkout
  --`, keeping only `brewpad.html`'s cache-buster bump plus the two BrewPad
  minified artifacts.
- **`zoho-middleware/node_modules` was absent** in this worktree (same as
  80-03/80-04); restored via `npm ci` from the existing, unmodified
  `package-lock.json` (environment setup, not a package-legitimacy decision —
  excluded from the Rule 3 install-exclusion). Full middleware suite ran
  clean afterward (1562/1562, no flakes this time).

## User Setup Required

None — no external service configuration required. `RESEND_API_KEY`,
`CALCOM_EVENT_TYPE_FERMENT_KIT`/`CALCOM_EVENT_TYPE_BOTTLING`, and
`MAILERLITE_API_KEY`/`MAILERLITE_WAITLIST_GROUP_ID` are all pre-existing
Railway env vars consumed entirely server-side (plan 80-02 and prior phases);
no new env var is introduced and none is referenced from `js/`.

## Next Phase Readiness

Both sheet-based flows named in the phase objective (contact a waitlisted
customer, add someone by hand) are live. Combined with 80-03's queue/pin
mechanics and 80-04's customer-link/recipe-attach panels, every phase-80
must-have interaction is now wired into the Waitlist tab. Plan 80-06 (owner
checkpoint — confirm the draft contact-email template, confirm the Cal.com
event type, confirm the Contact-disabled-on-booked/removed and
pin-available-on-every-row Phase-Specific Decisions) has everything it needs
to review live in BrewPad. No blockers. Full gate status: frontend
1633/1633 (108 suites), middleware 1562/1562 (106 suites), both linters
clean, `npm run build` clean, no `RESEND_API_KEY`/`CALCOM_API_KEY` reference
anywhere under `js/`.

---
*Phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c*
*Completed: 2026-09-04*

## Self-Check: PASSED

- All 7 files_modified plus this SUMMARY.md confirmed present on disk.
- All 4 task commits (e4a8da0d, 0114ec54, eda9e7b7, 44ae2816) confirmed present in `git log`.
