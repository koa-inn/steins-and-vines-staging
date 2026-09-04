---
phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
verified: 2026-09-03T20:15:00Z
status: human_needed
score: 11/11 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 9/11
  gaps_closed:
    - "D-05's one-way status rule (server-side) and CR-02's removed-row reinstate are LIVE in the deployed Apps Script Web App that staff actually use"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Delete the phase78-probe@example.com row from the live Waitlist tab and remove the address from the MailerLite beer waitlist group (78-CUTOVER.md Leg 10 cleanup)"
    expected: "No leftover probe data in the shared production sheet/MailerLite group"
    why_human: "Direct manual action against the live shared spreadsheet and MailerLite account; not code-verifiable."
    status: RESOLVED
    resolution: "Owner completed both actions 2026-09-04, AFTER this verification pass began — the 'still open' assessment in the body below was accurate when written and is now superseded. Confirmed by live probe: the Waitlist tab holds exactly the 6 backfilled subscribers (ml-0001..ml-0006), every row `waiting`, ascending oldest-first, zero probe residue. Recorded in 78-CUTOVER.md leg 10."
  - test: "Recover the prior Apps Script deployment version number from Deploy -> Manage deployments -> Version dropdown and record it in 78-CUTOVER.md §2, alongside the new version number and deployment ID"
    expected: "78-CUTOVER.md §2's rollback table has real values instead of '<OWNER TO FILL IN>', so the documented rollback procedure has a selectable target"
    why_human: "Requires Apps Script UI access with deployment version history; no CLI/API path. Non-blocking to the phase's functional goal (the live fix is independently probe-verified) but is a real operational-readiness gap if the deployment ever needs to be rolled back."
---

# Phase 78: BrewPad Waitlist Tracking Verification Report

**Phase Goal:** Make the beer waitlist a workable queue — a sheet-backed system of record for beer
waitlist signups, with a staff-facing BrewPad tab to work the queue.
**Verified:** 2026-09-03T20:15:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure

## What changed since the last pass

The prior verification's single blocking gap was that `apps-script/adminApi.gs` has no CI deploy
path, so the two Critical code-review fixes (CR-01 server-side D-05 one-way guard, CR-02
removed-row reinstate) were committed but the live Apps Script Web App — the only deployment,
shared by staging and production — still ran the pre-fix code. That gap is now closed:

- The owner performed the required second redeploy (78-CUTOVER.md §7b, confirmed 2026-09-04).
- **CR-02** was proven through the real customer-facing endpoint: `POST /api/waitlist` against a
  `removed` probe row on staging (which hits the same shared Apps Script deployment) returned
  `{"success":true}`, the sheet's row count stayed 7 (no duplicate), status flipped to `waiting`,
  `signed_up_at` refreshed, and the response was byte-identical to a first-time signup — D-06
  non-disclosure holds on the wire.
- **CR-01** was proven the way the original UAT structurally could not (leg 7 only proved the
  *client* refuses to send a backward request): a direct API call to the live Apps Script `/exec`
  endpoint now returns `{"ok":false,"error":"invalid_transition"}` for both `booked -> waiting` and
  `booked -> contacted`, while `contacted -> booked` (forward) and `booked -> booked` (idempotent
  no-op) both succeed. Row status after both rejected attempts stayed `booked`; row count stayed 7
  — a rejected transition writes nothing, as designed.

I independently confirmed the deployed-source claim: `git log` shows `a706d7b8` (CR-01) and
`7cbccf41` (CR-02) both present at HEAD on `apps-script/adminApi.gs`, the current file content at
`updateWaitlistStatus`/`waitlistTransitionAllowed` (lines ~5111-5185) matches exactly what the
commit messages and probe log describe, `git status` shows the file clean (no uncommitted drift
from what was redeployed), and the two regression suites
(`adminapi-waitlist-transition.test.js`, `adminapi-waitlist-reinstate.test.js`) pass locally
(22/22 tests). This is genuine, verified-live closure of the prior blocking gap — not a
re-statement of the SUMMARY's claim.

## Goal Achievement

### Observable Truths (mapped to locked decisions D-01..D-08)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D-01: a `Waitlist` sheet tab is the system of record; `adminApi.gs` owns schema/bootstrap/read/write | ✓ VERIFIED | Unchanged from prior pass — `WAITLIST_SHEET_NAME`, `ensureWaitlistSheet`/`setupWaitlist`, `addWaitlistEntry`/`getWaitlist`/`updateWaitlistStatus`; live probe confirmed |
| 2 | D-02: every row carries a `category` column, `beer` first, no migration needed | ✓ VERIFIED | Unchanged — `addWaitlistEntry` writes `category`; BrewPad auto-suppresses the column when all rows are `beer` |
| 3 | D-03: `POST /api/waitlist` blocks on the sheet write, 503 on failure; MailerLite fire-and-forget | ✓ VERIFIED | Unchanged — `zoho-middleware/server.js:229-288`; live UAT legs 1-3 |
| 4 | D-04: MailerLite CSV backfill uses a verified per-subscriber timestamp, oldest-first | ✓ VERIFIED | Unchanged — 78-CUTOVER.md §4, 6/6 rows imported ascending |
| 5 | D-05: statuses are one-way, enforced at the authoritative (server) layer | ✓ VERIFIED — now confirmed LIVE | `waitlistTransitionAllowed` (`adminApi.gs:5122`), called before any `setValue` in `updateWaitlistStatus` (~5163-5167), reads current status from the sheet not the payload; 12 behavioral unit tests; **and now proven against the live deployment** by direct API call (§7b probe log): `booked->waiting` and `booked->contacted` both refused with `invalid_transition`, row unchanged, row count unchanged |
| 6 | D-06: repeat signup is idempotent, response byte-identical to first-time signup | ✓ VERIFIED | Unchanged in code; **additionally reconfirmed live** by the §7b CR-02 probe — the reinstate response was byte-identical to a new-signup response |
| 7 | D-07: `mailerlite_synced` is a persisted, visible, filterable column | ✓ VERIFIED | Unchanged — live UAT leg 5 |
| 8 | D-08: standalone list, free-text notes, no Zoho-customer/batch-id column | ✓ VERIFIED | Unchanged — allowlist in `getWaitlist`, no such column in BrewPad's render loop |
| 9 | Staff see a sixth Waitlist tab, entries ordered oldest-signup-first | ✓ VERIFIED | Unchanged — live UAT leg 5 |
| 10 | Built artifacts (`brewpad.min.js`/`.min.css`) contain the new code, loaded by `brewpad.html` | ✓ VERIFIED | Unchanged |
| 11 | CR-02: a `removed` customer's re-signup reinstates to `waiting`, live in the deployed system | ✓ VERIFIED — now confirmed LIVE | `waitlistShouldReinstate` (`adminApi.gs:4985`), wired into `addWaitlistEntry`'s dedupe-hit branch (~5046-5051), 10 unit tests; **and now proven against the live deployment** by a real `POST /api/waitlist` call through the customer-facing endpoint (§7b probe log) |

**Score:** 11/11 truths verified, both in committed source and — for the two that were previously
"code fix present, not live" (D-05 server enforcement, CR-02 reinstate) — independently confirmed
against the live Apps Script deployment via direct API probes, not just SUMMARY narration.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps-script/adminApi.gs` | Waitlist schema, bootstrap, 3 handlers, D-05/CR-02 fixes | ✓ VERIFIED, source AND live | Confirmed committed (`a706d7b8`, `7cbccf41`) and now confirmed deployed via §7b probe log |
| `zoho-middleware/server.js` | Blocking sheet write, fire-and-forget MailerLite | ✓ VERIFIED | Unchanged |
| `zoho-middleware/routes/pos.js` | Two-whitelist gate | ✓ VERIFIED | Unchanged |
| `js/brewpad.js` | Waitlist tab, pure helpers, handlers | ✓ VERIFIED and WIRED | Unchanged |
| `brewpad.html` | Sixth tab button + panel | ✓ VERIFIED | Unchanged |
| `css/brewpad.css`/`.min.css` | Sync badge / position styles | ✓ VERIFIED | Unchanged |
| `tests/frontend/adminapi-waitlist-transition.test.js` | CR-01 behavioral coverage | ✓ VERIFIED | Re-ran locally: PASS, 12/12 tests |
| `tests/frontend/adminapi-waitlist-reinstate.test.js` | CR-02 behavioral coverage | ✓ VERIFIED | Re-ran locally: PASS, 10/10 tests |
| `78-CUTOVER.md` §7b | Redeploy runsheet + probe log | ✓ VERIFIED | All three tracking fields now filled in (YES/YES/YES) with a detailed probe transcript, not just a checkbox |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `updateWaitlistStatus` | `waitlistTransitionAllowed` | guard before `setValue` | ✓ WIRED, live-confirmed | Order confirmed by test AND by the fact that rejected live probes wrote nothing (row count/status unchanged) |
| `addWaitlistEntry` dedupe-hit branch | `waitlistShouldReinstate` | in-function call | ✓ WIRED, live-confirmed | Live probe: `removed` row flipped to `waiting` with refreshed `signed_up_at`, no duplicate row |
| (all other links) | | | ✓ WIRED | Unchanged from prior pass — see prior report body for the full 10-row table; re-spot-checked, no drift |

### Data-Flow Trace (Level 4)

Unchanged from prior pass — `renderWaitlist`, sync pill, and queue position all trace to a live
`getWaitlist()` sheet read, not a static array. Re-confirmed no regression: `js/brewpad.js` has no
uncommitted changes since the prior pass.

### Behavioral Spot-Checks / Probe Execution

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| §7b CR-01 direct API probe | `curl` against live `/exec`, `booked->waiting` | `{"ok":false,"error":"invalid_transition"}` | PASS |
| §7b CR-01 direct API probe | `curl` against live `/exec`, `booked->contacted` | `{"ok":false,"error":"invalid_transition"}` | PASS |
| §7b CR-01 direct API probe | `curl` against live `/exec`, `contacted->booked` | `{"ok":true,...,"status":"booked"}` | PASS |
| §7b CR-01 direct API probe | `curl` against live `/exec`, `booked->booked` (no-op) | `{"ok":true}` | PASS |
| §7b CR-02 probe | `POST /api/waitlist` (staging middleware, real customer path) against a `removed` row | `{"success":true}`, row reinstated to `waiting`, count still 7, response shape identical to new signup | PASS |
| `npx jest adminapi-waitlist-transition.test.js adminapi-waitlist-reinstate.test.js` | local re-run | 2 suites, 22/22 tests passed | PASS (re-run at HEAD during this verification) |
| `git log -1 -- apps-script/adminApi.gs` / `git status` | confirm deployed-source claim | `7cbccf41` at HEAD, working tree clean for this file | PASS |
| `grep TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER` on the CR-01/CR-02 diff | debt-marker scan | none found | PASS |

Full gate suite (frontend 100/1507, middleware 104/1541, lint clean) reported green at HEAD per the
task brief; not independently re-run in full during this narrow re-verification pass, since the only
files touched since the last full-suite run are the two already-passing test files and
`78-CUTOVER.md` (a `.md` file, no test/lint surface).

### Requirements Coverage

No formal REQ-IDs; traceability runs through D-01..D-08. All eight are now fully represented in
code AND confirmed live. Unchanged conclusion from prior pass, now stronger.

### Anti-Patterns Found

None new. `WR-02` (no optimistic locking on `updateWaitlistStatus`) and `IN-01` (`payload.status`
not routed through `waitlistCellSafe`, safe today via the allow-list) remain open per
`78-REVIEW.md`, unchanged since the prior pass. Both were previously assessed as non-blocking and
remain so:

- **WR-02** is explicitly traded off against `78-CONTEXT.md` D-01's accepted "sheets are weak under
  concurrent writes" cost, and CR-01's one-way guard already makes concurrent *status* advances
  converge safely (the failure mode is now limited to concurrent *notes* edits silently
  last-write-wins, not queue-integrity corruption). Judgment: **non-blocking** — a real
  code-quality note worth a follow-up ticket, not a defect that prevents "workable queue."
- **IN-01** is a defense-in-depth suggestion, not a live vulnerability — `validStatuses` is a fixed
  4-item allowlist and none of the values can trigger formula injection. Judgment: **non-blocking**.

No debt markers (`TBD`/`FIXME`/`XXX`) in the CR-01/CR-02 diff or the redeploy runsheet.

### Human Verification Required

Two items remain open, neither of which blocks the phase's functional goal — the code guarantees
(D-05 one-way, CR-02 reinstate) are independently proven live via direct API probes, not just
claimed. Both are genuine outstanding owner actions, tracked in `78-CUTOVER.md` itself, and are
carried forward here per the escalation-gate pattern rather than silently dropped:

1. **~~Leg 10 cleanup (data hygiene in the live shared sheet/MailerLite group).~~ RESOLVED
   2026-09-04** — closed by the owner after this pass began; confirmed by live probe (6 rows, all
   `waiting`, ascending, no probe residue). The assessment below was accurate when written and is
   retained for the record.

   The
   `phase78-probe@example.com` row is still present in the production `Waitlist` tab — now with
   `status: booked` and `notes: "probe note"` as a side effect of the CR-01 probe sequence — and
   the address is still an active MailerLite subscriber in the real beer waitlist group. **Judged
   non-blocking to the phase goal:** the row is clearly identifiable as test data by its email and
   notes, so staff working the real queue are very unlikely to mistake it for a genuine signup, and
   the MailerLite subscription has no bearing on whether the waitlist queue itself is workable.
   It should still be cleaned up — leftover synthetic data in a production system of record is a
   real (if low-severity) hygiene issue — but it does not block phase closure.

2. **Task 1 rollback version numbers (78-CUTOVER.md §2) are still unrecorded.** The three rollback
   fields (prior version, new version, deployment ID) are blank; the doc itself flags this as an
   open gap and notes the values are still recoverable from the Apps Script version-history
   dropdown "before relying on rollback." **Judged non-blocking to the phase goal:** this is an
   operational-readiness/runbook-completeness gap, not evidence that the shipped behavior is wrong
   — the live probes independently confirm the deployed code is correct. If a future incident does
   require rollback, the missing version numbers add friction (a manual lookup) but do not make
   rollback impossible. Recommend closing before this phase is considered fully wrapped, since an
   incomplete rollback runbook is exactly the kind of thing that's cheap to fix now and expensive to
   discover missing during an actual incident.

Both items are structured in the frontmatter `human_verification` list above for tracking.

### Gaps Summary

The prior verification's sole blocking gap — that the two Critical code-review fixes were
committed but not live on the deployment staff and customers actually use — is now genuinely
closed. This is not a re-statement of the SUMMARY/CUTOVER claim: I independently confirmed (a) the
fix commits are at HEAD and the working tree for `apps-script/adminApi.gs` is clean, (b) the
current file content matches what the probe log describes line-for-line, (c) the two regression
suites pass locally, and (d) the §7b probe log documents direct API calls against the live `/exec`
endpoint (for CR-01) and the real customer-facing `POST /api/waitlist` path (for CR-02) with
concrete before/after row-count and status evidence, not just a pass/fail checkbox — including the
detail that rejected transitions wrote nothing (row count and status unchanged), which is the
actual property the phase needs.

All eight locked decisions (D-01..D-08) are implemented and, where a live-deployment gap
previously existed (D-05, CR-02), that gap is now closed and independently verified. The phase
goal — "a sheet-backed system of record for beer waitlist signups, with a staff-facing BrewPad tab
to work the queue" — is achieved on the live system, not just in source.

One non-blocking, owner-action item remains (rollback version-number recording); leg 10 data
cleanup was resolved 2026-09-04 after this pass began. (Original wording: two items — leg 10 data cleanup, rollback version-number
recovery). Neither is evidence the phase goal is unmet; both are legitimate loose ends flagged for
the developer's decision on when to close them, consistent with the escalation-gate pattern. Status
is `human_needed` rather than `passed` because these items are surfaced, unresolved, and require a
human/manual action against live shared systems (spreadsheet, MailerLite, Apps Script UI) with no
code path to verify or close them — not because there is any remaining doubt about whether the
phase's functional goal was achieved.

---

_Verified: 2026-09-03T20:15:00Z_
_Verifier: Claude (gsd-verifier)_
