---
phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
plan: 04
subsystem: infra
tags: [apps-script, google-sheets, mailerlite, cutover, uat, railway, accessibility]

requires:
  - phase: 78-01
    provides: "setupWaitlist/ensureWaitlistSheet bootstrap and the three Apps Script waitlist handlers"
  - phase: 78-02
    provides: "POST /api/waitlist sheet-authoritative write and the admin-proxy allow-list"
  - phase: 78-03
    provides: "BrewPad Waitlist tab UI"
provides:
  - "Live Waitlist tab in the production spreadsheet with the seven contracted columns"
  - "Apps Script Web App redeployed on the existing deployment (URL unchanged), serving get_waitlist / add_waitlist_entry / update_waitlist_status"
  - "Six historical MailerLite subscribers backfilled in true signup order"
  - "Phase 78 middleware + frontend deployed to staging and verified end-to-end on the real surface"
  - "78-CUTOVER.md — the owner-facing runsheet, now carrying recorded results and two documented paste traps"
affects: [production-cutover, phase-51, phase-79]

tech-stack:
  added: []
  patterns:
    - "Secrets injected via `railway run -e <env> -s <service>` rather than pasted into a shell, keeping APPS_SCRIPT_URL/SERVER_TOKEN out of shell history"
    - "UAT writes verified server-side through the deployed read action, never by UI appearance alone"

key-files:
  created:
    - ".planning/phases/78-.../78-CUTOVER.md"
    - "tests/frontend/adminapi-waitlist-ensure-sheet.test.js"
    - "tests/frontend/beer-waitlist-contrast.test.js"
  modified:
    - "docs/APPS_SCRIPT.md"
    - "apps-script/adminApi.gs"
    - "css/styles.css"

key-decisions:
  - "Fixed ensureWaitlistSheet's empty-tab crash rather than working around it by hand-deleting the tab — the same throw would have hit every live waitlist write, not just setup"
  - "Backfill timestamps pasted with a leading apostrophe to force text storage; pre-formatting the column as plain text proved unreliable"
  - "Rejected var(--color-green) for the confirmation text — it measures 4.24:1 on cream, below WCAG AA"
  - "Leg 4 (MailerLite fail-open) skipped: it needs a staging env-var mutation and waitlist-route.test.js T2/T4 already cover the logic"

patterns-established:
  - "CSS contrast regression testing: resolve :root custom properties out of the real stylesheet, alpha-composite rgba over its backdrop, assert WCAG AA"

requirements-completed: [D-01, D-04, D-05, D-07]

duration: ~5h (interactive, owner-gated)
completed: 2026-09-03
---

# Phase 78 Plan 04: Cutover & Staging Verification Summary

**The beer waitlist is live and staff-usable on staging — sheet created, Apps Script redeployed, six historical subscribers backfilled in true signup order, and nine of ten UAT legs verified server-side — with two latent crashes and two invisible-text defects found and fixed along the way.**

## Performance

- **Duration:** ~5h wall clock, mostly waiting on owner-gated steps
- **Completed:** 2026-09-03
- **Tasks:** 3/3
- **Files modified:** 6 (plus build artifacts)

## Accomplishments

- **Task 1 — Waitlist tab created and Apps Script redeployed.** Existing deployment updated as a new version, so the `/exec` URL and every `APPS_SCRIPT_URL` in Railway are unchanged. Live probe returned `{"ok":true,"data":[]}`.
- **Task 2 — Backfill complete and verified.** All six MailerLite subscribers imported: ids `ml-0001`..`ml-0006`, every row `beer`/`waiting`, every `signed_up_at` an ISO-8601 UTC **string** in ascending oldest-first order, every `mailerlite_synced` true. D-04's stop-and-decide branch was not taken — the source timestamps proved to be real per-subscriber values at second resolution, in UTC.
- **Task 3 — Staging deploy and UAT.** All four gates green, pushed `dac7e521..b1a69395`, staging middleware healthy. Nine of ten UAT legs pass; every write was confirmed through the deployed `get_waitlist`, not by trusting the UI.
- **Two production defects fixed** that the plan did not anticipate (below).

## Task Commits

1. **Task 3 deliverables (front-loaded)** — `1f3ae20c` (docs: cutover runsheet + Apps Script Waitlist docs)
2. **Task 1 defect fix** — `6e07d652` (fix: initialise an existing-but-empty Waitlist tab)
3. **Task 1 record** — `89ba97d0` (docs: redeploy, passing probe, defect)
4. **Task 2 gate** — `53877f1e` (docs: MailerLite timestamp findings — UTC)
5. **Task 2 paste trap** — `945dd1a0` (docs: Sheets date-parsing warning)
6. **Task 2 complete** — `380fbe48`, `b1a69395` (docs: backfill verified, CSV deleted)
7. **Task 3 deploy** — `9ee7ce30` (docs: green gates and staging deploy)
8. **Task 3 UAT** — `93620ac7` (docs: 9/10 legs pass, contrast bugs)
9. **Contrast fix** — `dcb1875b` (fix: waitlist form legible on the light background)

## Decisions Made

See `key-decisions` frontmatter. The load-bearing one: when `setupWaitlist()` crashed, fixing the code was correct rather than deleting the blank tab by hand — `ensureWaitlistSheet` is called by all three handlers, so an empty tab would have thrown on every live signup, not merely during setup.

## Deviations from Plan

### 1. [Rule 3 — correctness] `ensureWaitlistSheet` crashed on an existing-but-empty tab

- **Found during:** Task 1, first `setupWaitlist()` run
- **Issue:** `Exception: The number of columns in the range must be at least 1.` The spreadsheet already had a blank `Waitlist` tab, so the `if (!sheet)` header-write branch was skipped, and `getRange(1, 1, 1, sheet.getLastColumn())` was then called with `getLastColumn() === 0`. This would also have thrown on every live waitlist write.
- **Fix:** Insert the sheet when absent, then write headers whenever the sheet has no content at all. Distinct from the drifted-header case, which still fails closed with `waitlist_unavailable`.
- **Verification:** `tests/frontend/adminapi-waitlist-ensure-sheet.test.js` — injects a fake `SpreadsheetApp`/`Logger` so the bootstrap branches execute rather than being asserted by source shape; reproduces the throw before the fix.
- **Committed in:** `6e07d652`

### 2. [Rule 3 — correctness/accessibility] Beer waitlist form rendered invisibly

- **Found during:** Task 3, UAT legs 1–2
- **Issue:** `.beer-waitlist-form` was styled for the dark green hero banner, but `beer.html`'s only instance renders on the cream body. Input text and success confirmation were both `var(--color-cream)` `#e5dec1` against a body background of `#e5dec1` — **contrast 1.00**. Customers could see neither their own typing nor the confirmation; every cue said the signup had failed.
- **Fix:** Rebased the base rules on the light context — `var(--color-text)` on a white field, burgundy border, `var(--color-muted)` placeholder, a real focus outline, and the submit button inheriting the burgundy `.btn` it already carries. Cream-on-dark treatment moved under `.beer-banner--green`.
- **Verification:** `tests/frontend/beer-waitlist-contrast.test.js` (5 of 7 assertions failed before the fix); re-measured live on staging at 13.97 / 10.34 / 12.59.
- **Committed in:** `dcb1875b`

### 3. [scope] UAT leg order

Legs 8 and 9 were run 9-then-8, exercising the notes editor on a live `booked` row rather than an already-`removed` one. Strictly stronger coverage; no leg skipped.

---

**Total deviations:** 3 (2 correctness fixes, 1 test-ordering). Both fixes were pre-existing defects on the phase's own critical path, not scope creep. Defect 2 is in `beer.html`, which Phase 78 did not otherwise modify.

## Issues Encountered

- **Sheets parsed ISO timestamps into date serials** (`2026-08-27 19:16:30` → `46261.803125`). Two failure modes, neither of which errors: read back as a number, `sortWaitlistRows` treats the row as undated and sorts it **last**, inverting D-04; read back as a date value, Sheets re-interprets the wall-clock time in the spreadsheet timezone and shifts every stamp. Resolved with a leading-apostrophe guard. Documented in `78-CUTOVER.md` §4 STEP 3.
- **Round-tripping the export through Excel** overwrote the prepared clipboard block and landed emails-only in column B. The export must be transformed into the 7-column shape and pasted directly. Documented alongside the above.
- **`ensureGiftCardLedgerSheet` (Phase 51) carries the identical latent bug** to deviation 1 — same skip-if-exists structure, same zero-column read. Not fixed here; out of phase scope. **Needs its own ticket.**

## User Setup Required

Owner-gated throughout — Apps Script Run/Deploy and the MailerLite export have no CLI path. Full runsheet in [78-CUTOVER.md](./78-CUTOVER.md).

**Still outstanding:**

1. **UAT leg 10 cleanup.** Delete the `phase78-probe@example.com` row from the `Waitlist` tab (no delete action exists — removal is a status change by design), and remove that address from the MailerLite beer waitlist group, where it is a live subscriber.
2. **Rollback version numbers.** The prior Apps Script version was not captured at redeploy time, so the rollback procedure has no target. Recoverable from Deploy → Manage deployments → Version dropdown.

## Next Phase Readiness

Phase 78 is functionally complete and staging-verified. Not yet in production.

**Carried forward:**

- The staging push spanned **phases 78, 51 and 79** — all three modified `apps-script/adminApi.gs`, so Task 1's redeploy already put 51's and 79's Apps Script changes into **production**. Their middleware/frontend halves still need their own staging UAT before the production cutover.
- Phase 78's production cutover should be batched with the pending pushes for phases 73, 75 and 76 already tracked in STATE.md. This plan does not authorize that push.

---
*Phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-*
*Completed: 2026-09-03*
