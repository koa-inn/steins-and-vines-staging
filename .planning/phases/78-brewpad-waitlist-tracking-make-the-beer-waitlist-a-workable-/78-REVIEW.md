---
phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
reviewed: 2026-09-03T23:38:53Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - apps-script/adminApi.gs
  - zoho-middleware/server.js
  - zoho-middleware/routes/pos.js
  - js/brewpad.js
  - brewpad.html
  - beer.html
  - css/brewpad.css
  - css/styles.css
  - tests/frontend/adminapi-waitlist-pure.test.js
  - tests/frontend/adminapi-waitlist-ensure-sheet.test.js
  - tests/frontend/beer-waitlist-contrast.test.js
  - tests/frontend/brewpad-waitlist.test.js
  - zoho-middleware/__tests__/waitlist-route.test.js
  - zoho-middleware/__tests__/waitlist-admin-proxy.test.js
findings:
  critical: 2
  warning: 2
  info: 1
  total: 5
  critical_fixed: 2
status: critical_resolved
resolved:
  - id: CR-01
    commit: a706d7b8
    note: "Server-side D-05 one-way guard (waitlistTransitionAllowed), 12 new tests"
  - id: CR-02
    commit: 7cbccf41
    note: "Removed rows reinstate to waiting on re-signup (waitlistShouldReinstate), 10 new tests"
open:
  - id: WR-01
    note: "PRE-EXISTING — adminApiPost/fetchWithRetry predate phase 78 (BrewPad v1.2.2), untouched here. The waitlist path is now retry-safe: CR-01's guard allows a no-op re-set. The broader 'all BrewPad writes retry once' concern needs its own ticket."
  - id: WR-02
    note: "OPEN — no optimistic locking on updateWaitlistStatus. With the one-way guard in place, concurrent staff advances converge; concurrent notes edits can still clobber."
  - id: IN-01
    note: "OPEN — payload.status not routed through waitlistCellSafe; safe today via the enum allow-list, fragile if the enum grows."
---

> **DEPLOY GATE:** both Critical fixes are in `apps-script/adminApi.gs`, which has **no CI deploy
> path**. The live Web App still serves the pre-fix code until the owner pastes the updated file
> into the Apps Script editor and redeploys the existing deployment as a new version. See
> `78-CUTOVER.md` §2.

# Phase 78: Code Review Report

**Reviewed:** 2026-09-03T23:38:53Z
**Depth:** standard
**Files Reviewed:** 14 (8 source + 6 test)
**Status:** issues_found

## Summary

Phase 78 adds a `Waitlist` sheet tab, three Apps Script handlers, middleware wiring, and a
BrewPad tab. The formula-injection mitigation (`waitlistCellSafe`), the D-06 non-disclosure
dedupe contract, the D-03 fail-open-on-MailerLite/fail-closed-on-sheet-write split, the
admin-proxy read/write allow-list separation, and the WCAG contrast fix are all correctly
implemented and reasonably well tested.

The most serious problem is that **D-05's one-way status rule — the decision this phase's own
code comments repeatedly call out as the thing that must never regress ("silently reopen a
booked customer's spot") — is enforced only in the BrewPad client, not in the Apps Script
handler that is supposed to be the authoritative system of record (D-01).** `updateWaitlistStatus`
validates that a submitted status is one of the four literal values, but never checks it against
the row's *current* status, so nothing stops a `booked` row from being written back to `waiting`
by any caller that doesn't go through `advanceWaitlistStatus`'s client-side guard. Combined with
this is a second, related gap: the code's own stated remedy for a re-signup after removal ("staff
flip the existing row back via BrewPad instead") does not actually exist anywhere in the shipped
UI — there is no control that can move a `removed` or `booked` row back to `waiting`. Together
these mean the queue's integrity depends entirely on client-side JavaScript behaving correctly on
every device that ever calls the admin-proxy, which contradicts the phase's own "sheet row is the
system of record" premise.

Two lower-severity issues (a write-retry inconsistency and a UX/data-integrity gap on removed-row
resubmission) round out the findings. No secrets, no HTML/script injection paths, and no CSP gaps
were found.

## Critical Issues

### CR-01: D-05's one-way status transition is enforced only client-side; the authoritative Apps Script handler accepts any transition, including backward

**File:** `apps-script/adminApi.gs:5081-5125` (`updateWaitlistStatus`)
**Also relevant:** `js/brewpad.js:958-967` (`nextWaitlistStatus`, client-only guard), `js/brewpad.js:8357-8375` (`advanceWaitlistStatus`)

**Issue:** `updateWaitlistStatus` validates that `payload.status` is one of the four literal
values (`waiting`/`contacted`/`booked`/`removed`) before writing, but it never compares the
requested status to the row's *current* status:

```js
// D-05: validate BEFORE any setValue -- an out-of-set status writes nothing.
var validStatuses = ['waiting', 'contacted', 'booked', 'removed'];
if (hasStatus && validStatuses.indexOf(payload.status) === -1) {
  return { ok: false, error: 'invalid_status' };
}
...
if (hasStatus) {
  var statusCol = headers.indexOf('status') + 1;
  sheet.getRange(result.row, statusCol).setValue(payload.status);
}
```

The ONLY place the forward-only rule (`waiting → contacted → booked`, no wraparound) is
implemented is `nextWaitlistStatus()` in `js/brewpad.js`, which is consulted by
`advanceWaitlistStatus()` before it ever calls the API. Any other caller of
`POST /api/batch/admin-proxy` with `{action:'update_waitlist_status', id, status:'waiting'}` —
a raw `fetch()` from devtools with a valid staff session cookie, a future bug in another code
path that reuses this handler, a stale browser tab, or a scripted admin tool — can silently move
a `booked` row back to `waiting`, reopening a customer's confirmed spot with no error, no audit
trail, and no server-side guard at all.

This is a direct violation of the phase's own stated invariant. `78-CUTOVER.md`'s live UAT
(step 7, "One-way (D-05 correctness deviation)") only verified that the *client* refuses to send
the request when a badge is tapped twice on a booked row — it never exercised a direct backward
API call, so the gap was never actually probed. The Jest suites confirm this: both
`adminapi-waitlist-pure.test.js` and `waitlist-admin-proxy.test.js` assert only that the four
status literals are *accepted* as valid values; neither test asserts that a backward transition
is rejected.

Per D-01 ("the sheet row is the system of record") and the pattern this phase says it followed
from gift-card ledger handlers (which DO enforce state-machine transitions server-side), the
authoritative validation belongs in `adminApi.gs`, not solely in `brewpad.js`.

**Fix:** Add the same one-way check server-side, using the current row's status read via
`findRowById`:

```js
var WAITLIST_STATUS_ORDER = ['waiting', 'contacted', 'booked']; // mirror js/brewpad.js's list

if (hasStatus) {
  var currentStatus = result.data.status;
  if (payload.status !== 'removed' && currentStatus !== payload.status) {
    var curIdx = WAITLIST_STATUS_ORDER.indexOf(currentStatus);
    var nextIdx = WAITLIST_STATUS_ORDER.indexOf(payload.status);
    if (curIdx === -1 || nextIdx === -1 || nextIdx <= curIdx) {
      return { ok: false, error: 'invalid_transition' };
    }
  }
  var statusCol = headers.indexOf('status') + 1;
  sheet.getRange(result.row, statusCol).setValue(payload.status);
}
```//
(Adjust to decide whether `removed` should also be one-way from `removed` back to anything, per
CR-02 below — resolving that decision should happen in the same change.)

---

### CR-02: The documented remedy for a removed customer's re-signup ("staff flip the row back via BrewPad") does not exist in the shipped UI, and the re-signup itself silently changes nothing

**File:** `apps-script/adminApi.gs:4958-4990` (`waitlistDedupeDecision`), `apps-script/adminApi.gs:5005-5039` (`addWaitlistEntry`)
**Also relevant:** `js/brewpad.js:958-967`, `8357-8396` (no restore/re-add action exists for `removed` or `booked` rows)

**Issue:** `waitlistDedupeDecision`'s doc comment states:

> A row with status 'removed' STILL counts as a match ... the staff-facing fix for that case is
> flipping the existing row back via BrewPad, not duplicating them.

But nothing in `js/brewpad.js` can move a `removed` (or `booked`) row back to `waiting`:
`nextWaitlistStatus('removed')` and `nextWaitlistStatus('booked')` both return `null`
(`js/brewpad.js:963-967`), the status badge is rendered non-actionable for exactly those two
statuses (`actionable = status !== 'booked' && status !== 'removed'`, `js/brewpad.js:8298`), and
the only other row control is `removeWaitlistEntry`, which only writes `status: 'removed'` — there
is no "restore" or "re-add" affordance anywhere in the panel.

Combine this with `addWaitlistEntry`'s dedupe-hit branch, which does nothing but echo success:

```js
if (decision.action === 'existing') {
  return { ok: true, id: decision.row.id };
}
```

The row's status, `signed_up_at`, and every other field are left untouched. So the actual
end-to-end behavior when a previously-removed (or already-booked) customer re-submits the public
form on `beer.html` is:
1. The customer receives the normal "Thanks! You're on the list" success response (by design,
   D-06 non-disclosure).
2. Nothing on their row changes — they remain `removed`/`booked` and are NOT back in the
   `waiting` queue.
3. No signal is written or shown anywhere that a re-signup happened (no notes bump, no counter, no
   log visible to staff) — the exact "durable cell over log line" philosophy D-07 was built on is
   absent here.
4. Staff have no way, short of directly editing the Google Sheet outside BrewPad, to notice this
   occurred or to correct it.

A customer who genuinely wants back on the list is told they succeeded and is, in fact, invisible
to staff. This undermines the phase's core deliverable — a workable, accurate, staff-readable
queue — in exactly the scenario the code's own comments anticipated but never built a fix for.

**Fix:** Either (a) add a BrewPad control that can move a `removed` row back to `waiting` (and
decide, per CR-01, whether that transition should also be server-validated as an explicit
allowed exception to the one-way rule), or (b) have `addWaitlistEntry`'s dedupe-hit branch itself
reset a `removed` row to `waiting` and bump `signed_up_at`, and/or write a visible marker (e.g., a
notes-field bump or a `resignup_count`) so staff see it in `get_waitlist` without needing sheet
access. Pick one and make the code comment's claim ("staff flip the existing row back via
BrewPad") actually true.

## Warnings

### WR-01: `adminApiPost` (used by every waitlist write) silently retries once on a network-level failure, contradicting the phase's own no-retry-on-writes claim

**File:** `js/brewpad.js:1640-1659` (`fetchWithRetry`), `js/brewpad.js:1694-1711` (`adminApiPost`)

**Issue:** `78-03-SUMMARY.md` states: "All three writes go through `adminApiPost('update_waitlist_status', ...)` unwrapped — no retry on 502/503/504, per the Phase 77 write-retry constraint." That claim is only true for HTTP-status-based retries. `adminApiPost` calls
`fetchWithRetry(url, options)` with only two arguments, so `retries` is `undefined` and defaults
to `1` inside `fetchWithRetry`:

```js
function fetchWithRetry(url, options, retries, retryStatuses) {
  if (retries === undefined) retries = 1;
  ...
  return fetch(url, options).then(function (r) {
    if (retryStatuses && retries > 0 && retryStatuses.indexOf(r.status) !== -1) {
      return backoffRetry();
    }
    return r;
  }, function (err) {
    // Network-level rejection (offline, DNS, dropped connection) — always retryable.
    if (retries > 0) return backoffRetry();
    throw err;
  });
}
```

Because `retryStatuses` is `undefined` for `adminApiPost`, the *status-code* retry branch is
correctly disabled — but the network-rejection branch (`fetch()` itself throwing, e.g. a dropped
connection mid-request) checks `retries > 0` unconditionally, so it retries once regardless. This
is exactly the "unknown outcome" scenario the Phase 77 write-retry constraint (carried into this
phase's context) warns against: "the admin proxy collapses upstream errors to 502; reads may
retry, writes must NOT... Do not add retry around it." A dropped connection after the sheet write
already succeeded server-side, followed by the client's automatic retry, sends the identical
`update_waitlist_status` payload twice. In practice this is low-impact for the waitlist writes
specifically (setting the same status/notes/synced-flag twice is idempotent), but it is a real gap
between the documented invariant and the shipped behavior, and it is not scoped to the waitlist —
every write in BrewPad that uses `adminApiPost` inherits it.

**Fix:** Either pass `0` explicitly for `retries` in `adminApiPost` (`fetchWithRetry(url, options, 0)`), or correct the summary/constraint documentation to reflect that only status-based retry
is disabled, not network-rejection retry.

### WR-02: No optimistic-locking / conflict detection on waitlist row writes, unlike every other admin API write handler

**File:** `apps-script/adminApi.gs:5081-5125` (`updateWaitlistStatus`)

**Issue:** `updateReservation` and `updateHold` elsewhere in this same file both implement
`expectedVersion` optimistic locking against a `last_updated` timestamp, rejecting a write if the
server's row changed since the client last read it. `updateWaitlistStatus` has no equivalent —
two staff members updating the same row concurrently (e.g., one advancing status while another
edits notes) will silently last-write-wins with no conflict signal. `78-CONTEXT.md`'s D-01
explicitly accepts "sheets are weak under concurrent writes" as a cost for this phase, so this may
be an intentional simplification — but it is inconsistent with the pattern already established
elsewhere in the same file for comparable staff-facing lists, and worth a deliberate call-out
rather than a silent omission, especially once multiple staff regularly work the same queue.

**Fix:** If accepted, note it explicitly in a code comment near `updateWaitlistStatus` (mirroring
the "no LockService" comment already present) so a future reader doesn't assume parity with
`updateReservation`/`updateHold`. If not accepted, add `expectedVersion` handling using
`signed_up_at` or a new `last_updated` column.

## Info

### IN-01: `updateWaitlistStatus`'s literal-status-writes-are-unsanitized reliance on the allow-list is correct but fragile if the enum ever grows

**File:** `apps-script/adminApi.gs:5108-5111`

**Issue:** `sheet.getRange(result.row, statusCol).setValue(payload.status)` writes
`payload.status` directly without passing it through `waitlistCellSafe`, relying entirely on the
preceding `validStatuses.indexOf(payload.status) === -1` check to prevent formula injection (safe
today, since none of `waiting`/`contacted`/`booked`/`removed` starts with `=+-@`). This is fine as
written, but if a future status value were ever added to `validStatuses` without checking its
first character, the injection guard would silently stop applying to that one write path while
every other waitlist cell write goes through `waitlistCellSafe`. Consider running `payload.status`
through `waitlistCellSafe` anyway for defense-in-depth consistency with the rest of the file, or
add a comment at the `validStatuses` declaration warning that new values must not begin with
`=+-@`.

**Fix:** `sheet.getRange(result.row, statusCol).setValue(waitlistCellSafe(payload.status));` (safe
no-op today; free insurance against a future enum change).

---

_Reviewed: 2026-09-03T23:38:53Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
