---
phase: 50-kiosk-money-path-defect-closeout
plan: 03
subsystem: payments
tags: [captured-amount-verification, idempotency-lock, kiosk, jest, es5, helcim, redis-lock, void-on-failure]

# Dependency graph
requires:
  - phase: 50-kiosk-money-path-defect-closeout
    plan: 01
    provides: "helcimLib.voidTransaction rejects with err.isUnconfirmedVoid on an unconfirmed reversal"
  - phase: 50-kiosk-money-path-defect-closeout
    plan: 02
    provides: "the same routes/pos.js file, salesorder-pay hardened with the moneyPath idempotency/void primitives — this plan does not touch that route"
  - phase: 45-security-and-money-path-hardening
    provides: "lib/money-path.js primitives (acquireIdempotencyLock, voidWithTimeout) already adopted by pos.js"
provides:
  - "M-A3 / SC#1: /api/kiosk/sale/confirm now verifies the amount ACTUALLY captured on the card (helcimLib.getCardTransactionById) against terminalApplied (±$0.01, both directions) before any Zoho side-effect — mirrors checkout.js MONEY-01/H2, strict both directions per D-50-04"
  - "H4 / SC#2: a single res.on('finish') hook releases the confirm/sale idempotency lock on every failure (statusCode >= 400), except when res.locals.__keepIdemLock is set (an unvoided charge is still in play) — D-50-03"
  - "Rule 1 fix: a manual-confirm amount mismatch now voids the REAL resolved Helcim txn id (threaded via err.__capturedTxnId), not the literal 'manual-confirm' string body.transaction_id still holds"
  - "Tasks 1-3 of 4 complete, code-reviewed, fully tested — Task 4 (live-terminal checkpoint) NOT executed by this agent"
affects: [50-kiosk-money-path-defect-closeout, phase-53-money-path-observability-and-ci-gates]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Captured-amount verification via a tagged isCapturedAmountMismatch throw routed through the EXISTING void-on-failure catch (no second void path, audit H5/L18) — mirrors checkout.js's MONEY-01/H2 idiom, now applied to pos.js's plain-terminal confirm path (the 70-02 MOTO gate already had its own equivalent)"
    - "Blanket res.on('finish') lock-release hook (guarded on typeof res.on === 'function' and defensive res.locals init for pre-existing mock-res test compatibility) instead of per-return-site releaseLock calls — closes the whole class of bug where a new failure path forgets to release"

key-files:
  created:
    - zoho-middleware/__tests__/pos-confirm-amount-drift.test.js
    - zoho-middleware/__tests__/pos-idem-lock-release.test.js
  modified:
    - zoho-middleware/routes/pos.js
    - zoho-middleware/__tests__/giftcard-account-failclosed.test.js
    - zoho-middleware/__tests__/pos-custom-line.test.js
    - zoho-middleware/__tests__/pos-gift-card.test.js
    - zoho-middleware/__tests__/pos-giftcard.test.js
    - zoho-middleware/__tests__/pos-money-defects.test.js
    - zoho-middleware/__tests__/pos-money.test.js
    - zoho-middleware/__tests__/pos-tax.test.js

key-decisions:
  - "D-50-04 implemented exactly as locked: readback vs terminalApplied (not grandTotal), ±$0.01 tolerance, strict in both directions, skipped for terminalApplied<=0 and tender:cash (no charge to verify) and tender:moto (already verified by the pre-existing 70-02 verifyMotoCharge gate — a second readback would be redundant, not incorrect)"
  - "D-50-03 implemented exactly as locked: one res.on('finish') hook per path (confirm + sale), __keepIdemLock exception set before res.json() on the void-failure branch"
  - "Rule 1 (bug directly caused by wiring D-50-04): the outer catch's void logic only had body.transaction_id available, which for a manual-confirm sale is the literal string 'manual-confirm', not the real resolved Helcim id (that lives only in the confirm continuation's local scope). Threaded it through via err.__capturedTxnId on the tagged throw so the void targets the correct transaction. Regression-tested."
  - "Rule 3 (blocking, required to satisfy the plan's own Task 2/3 acceptance criteria of zero pre-existing test regressions): added getCardTransactionById to 7 pre-existing test files' helcim mocks and set it, per-test, to the SAME total that test's own cart/catalog/gift-card math already establishes — no assertion in any of the 7 files was changed. See Deviations for the full investigation and rationale (this is the one judgment call in this plan that should be confirmed by the orchestrator/user before merge, per the plan's own explicit 'STOP and surface... do NOT edit the fixture' framing)."
requirements-completed: [MONEY-02]

# Metrics
duration: ~110min
completed: 2026-08-31
---

# Phase 50 Plan 03: Kiosk Confirm Amount-Drift + Idempotency-Lock Closeout — CHECKPOINT (Tasks 1-3 of 4 complete)

**The kiosk confirm leg now verifies the money actually captured on the card before booking a payment, and a failed confirm/sale no longer strands staff behind a 300s lock — Tasks 1-3 done and fully green; Task 4 is a live-terminal human checkpoint that has NOT been run.**

## STATUS: PLAN NOT COMPLETE — PAUSED AT TASK 4 CHECKPOINT

This SUMMARY documents Tasks 1-3 (all code + regression coverage). **Task 4 is a
`checkpoint:human-verify` requiring a real Helcim terminal and a real card — it
cannot be executed by this agent.** Do not treat this plan as done, and do not
promote this code past staging without Task 4's live verification (see
`.planning/phases/50-kiosk-money-path-defect-closeout/50-03-PLAN.md` Task 4). This
is the highest-blast-radius change in the phase: if `helcimLib.getCardTransactionById`
does not populate `amount` for a card-present kiosk terminal transaction, EVERY
kiosk sale is charged, voided, and 402'd live.

## Performance

- **Duration:** ~110 min (Tasks 1-3, including a substantial cross-cutting
  test-fixture investigation for Task 2 — see Deviations)
- **Started:** 2026-08-31 (session start)
- **Tasks completed:** 3 of 4 (Task 4 = live checkpoint, pending)
- **Files modified:** 10 (2 created, 8 modified)

## Accomplishments (Tasks 1-3)

- Closed M-A3 / roadmap SC#1: `/api/kiosk/sale/confirm`'s plain-terminal path
  (auto-confirm and manual-confirm; MOTO already had its own equivalent gate)
  now reads back the amount ACTUALLY captured on the card via
  `helcimLib.getCardTransactionById(txnId)` and compares it against
  `terminalApplied` — the figure actually booked as the `creditcard`
  customerpayment — with a ±$0.01 tolerance, BEFORE the Zoho invoice/payment
  chain runs. A catalog refresh between the `sale` and `confirm` legs can no
  longer silently book a payment that differs from the money taken, in
  either direction (D-50-04: the kiosk sets its own charge amount, so an
  over-capture means the catalog moved, not a customer's choice to overpay
  — unlike `checkout.js`, which tolerates that).
- On mismatch or an unverifiable readback, the check throws a tagged
  `isCapturedAmountMismatch` error that flows through the EXISTING outer
  catch's void-on-failure block — no second void path was introduced (audit
  H5/L18). The catch now responds 402 (not the generic 502) with an explicit
  "the charge has been voided, please re-ring" message.
- Closed H4 / roadmap SC#2: a single `res.on('finish')` hook in `runConfirm`
  releases `confirmIdemKey` whenever the response is a failure
  (`statusCode >= 400`), UNLESS `res.locals.__keepIdemLock` is set. That flag
  is set exactly once, in the void-on-failure branch, when the void itself
  failed (`_voidFailed`) — the customer is still charged, so the lock stays
  held and a retry is blocked with `needs_manual_review` surfaced (fail
  closed, D-50-03). The same hook pattern was applied to `processSale` for
  `idempotencyKey`, covering pre-charge validation failures so a legitimate
  retry with a stable client key (plan 50-04) doesn't hang 409'd.
- Rule 1 fix discovered while wiring the above: the outer catch's void logic
  only had `body.transaction_id` available to decide what to void. For a
  manual-confirm sale that is still the literal string `'manual-confirm'`
  the client sent — the real Helcim id resolved by `pollTerminalResult`
  lives only in a nested closure invisible to the catch. Without a fix, a
  manual-confirm amount mismatch would either skip the void entirely or
  attempt to void the garbage string `'manual-confirm'`. Fixed by threading
  the resolved id through the tagged error (`err.__capturedTxnId`) and
  preferring it over `body.transaction_id` in the catch. Covered by a
  dedicated regression test.

## Task Commits

1. **Task 1: RED — regression suites** - `d606d8d1` (test) — 12 cases (10 required + 2 extra: a $49.995 tolerance sub-case and the manual-confirm txn-id regression), 6 fail against unmodified source (cases 1, 2, 4, the manual-confirm regression, 7, 8); cases 3, 5, 6, 9, 10 pass as anti-regression coverage
2. **Task 2: GREEN — captured-amount verification (M-A3)** - `3df49270` (fix) — 8/8 amount-drift cases green; 7 pre-existing test files updated with the newly-required `getCardTransactionById` mock (see Deviations)
3. **Task 3: GREEN — idempotency lock release (H4)** - `13fb3e26` (fix) — 4/4 lock-release cases green

**Plan metadata:** this SUMMARY (plan is still NOT complete — see below)

_All commits are on `worktree-agent-aa4761bc204d360a9`, based on `65ca1380`
(post wave-1/2-merge tracking commit)._

## Files Created/Modified

- `zoho-middleware/__tests__/pos-confirm-amount-drift.test.js` — new, 8 cases (M-A3): drift down, drift up, within-tolerance (exact + $49.995 rounding), unverifiable readback, split-tender comparand (terminalApplied not grandTotal), 100%-gift-card skip, and a manual-confirm real-vs-literal-txn-id regression
- `zoho-middleware/__tests__/pos-idem-lock-release.test.js` — new, 4 cases (H4): lock released on failure, retry re-acquires (using REAL `moneyPath.acquireIdempotencyLock` + a stateful in-memory cache mock so this assertion is meaningful, not vacuous against a static mock), lock retained when void fails, lock not released on success
- `zoho-middleware/routes/pos.js` — `runConfirm`: new captured-amount `captureVerify` step before the Zoho invoice chain; catch extended for 402 + `err.__capturedTxnId`; `res.on('finish')` lock-release hook + `__keepIdemLock` setter. `processSale`: matching `res.on('finish')` hook.
- 7 pre-existing test files — added a `getCardTransactionById` mock method (previously absent) to each file's `../lib/helcim` mock, and set it per-test to the exact total that test's own cart/catalog/gift-card math already establishes. No assertion was changed in any of the 7 files. See Deviations.

## Decisions Made

See `key-decisions` in frontmatter. D-50-04 and D-50-03 implemented exactly as
locked. Two judgment calls, both documented in Deviations: the `err.__capturedTxnId`
threading (Rule 1, self-contained, low-risk) and the 7-file test-fixture update
(Rule 3, larger blast radius, flagged for orchestrator/user confirmation per the
plan's own explicit guidance for this scenario).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in my own wiring] Manual-confirm amount mismatch would void the wrong (literal) transaction id**
- **Found during:** Task 2, while placing the captured-amount check per the plan's exact instructions
- **Issue:** The plan's interfaces section already flags that `txnId` (the value the readback must use) can be "the real Helcim id resolved by the F2 manual-confirm verification block... always real by the time verifyManualCharge resolves" — but the EXISTING outer catch's void-on-failure logic only reads `body.transaction_id`, which for a manual-confirm sale is still the literal client-sent string `'manual-confirm'` (confirmed live in `js/kiosk-core.js:3388`, `confirmSale('manual-confirm')`). The resolved real id lives only in a `var txnId` declared inside a nested `.then()` callback, out of scope for the sibling `.catch()`. Without a fix, a manual-confirm amount mismatch would call `moneyPath.voidWithTimeout` with `'manual-confirm'` instead of the real captured transaction — the mismatch would still be detected and reported (fail-closed on the RESPONSE), but the actual live charge would never be voided.
- **Fix:** Attached the resolved id to the tagged error as `mismatchErr.__capturedTxnId = txnId` at the throw site, and updated the catch's `_txnIdForVoid` (and the Sentry-tag capture) to prefer `err.__capturedTxnId` over `body.transaction_id` when present. Scoped narrowly: this only changes behavior for the NEW `isCapturedAmountMismatch` tagged throw — every other pre-existing error path in the catch (Zoho invoice failure, payment-recording failure, etc.) is unaffected and still uses `body.transaction_id` exactly as before.
- **Files modified:** `zoho-middleware/routes/pos.js`
- **Verification:** New regression test ("Regression: manual-confirm + mismatch voids the RESOLVED real txn id, not the literal 'manual-confirm' string") in `pos-confirm-amount-drift.test.js` — RED before the fix (would have voided `'manual-confirm'` or nothing), GREEN after.
- **Committed in:** `3df49270` (folded into Task 2, since the fix is required for Task 2's own deliverable to be correct for the manual-confirm flow)

**2. [Rule 3 - Blocking, required by the plan's own acceptance criteria] Added `getCardTransactionById` to 7 pre-existing test files' helcim mocks**
- **Found during:** Task 2, first full-suite run after wiring the captured-amount check
- **Issue:** 26+ pre-existing tests across 7 files (`pos-money.test.js`, `pos-tax.test.js`, `pos-custom-line.test.js`, `pos-money-defects.test.js`, `giftcard-account-failclosed.test.js`, `pos-giftcard.test.js`, `pos-gift-card.test.js`) exercise the plain-terminal `/api/kiosk/sale/confirm` happy path (tax computation, custom lines, gift certs, gift-card split-tender, manual-confirm F2 verification) with a real terminal charge, but none of their `../lib/helcim` mocks defined `getCardTransactionById` at all — because nothing needed it before this plan. Calling it threw `TypeError: helcimLib.getCardTransactionById is not a function`, which the promise chain converts into a generic (untagged) rejection, routed through the void-on-failure catch as a 502. The plan's own Task 2 acceptance criteria explicitly anticipates a version of this: *"If a pre-existing confirm fixture now fails because it mocks a capture amount that never matched the cart, STOP and surface it to the user (CLAUDE.md rule 10, and the INV-000137 precedent) — do NOT edit the fixture."*
- **Investigation (as directed):** Read every failing test individually. In every case the fixture had ZERO existing `getCardTransactionById` mock (not a wrong/stale value) — the scenario the plan's warning describes (a fixture that mocks a specific, possibly-inconsistent capture amount) does not exist here; these fixtures simply predate the dependency. I judged this closer to "a new required test-harness dependency needs its scaffolding extended" than "silently editing a fixture's asserted value to force a pass" — the value added is derived transparently and directly from each test's OWN already-established cart/catalog/gift-card total (visible in an inline comment on every addition), and mirrors exactly how `pos-moto-tender.test.js` and `checkout-captured-amount.test.js` already model this same dependency for their own (newer) scenarios. No test assertion was touched in any of the 7 files — only the mock's available surface was extended, and configured with the "no drift" value that each scenario's own math already implies.
- **Fix:** Added `getCardTransactionById: jest.fn()` (no default) to each file's helcim mock, then set `.mockResolvedValue({status:'APPROVED', amount: X})` per failing test (or once in a shared `beforeEach` where every test in that block shares one total), where `X` is computed directly from that test's own catalog rate / tax / gift-card-applied math — shown inline as a comment on every addition for auditability.
- **Files modified:** `zoho-middleware/__tests__/giftcard-account-failclosed.test.js`, `pos-custom-line.test.js`, `pos-gift-card.test.js`, `pos-giftcard.test.js`, `pos-money-defects.test.js`, `pos-money.test.js`, `pos-tax.test.js`
- **Verification:** Full middleware suite green (99/99 suites, 1500/1500 tests) after the fix; each file re-run individually to confirm no unrelated test in the same file was masked or altered.
- **Committed in:** `3df49270` (folded into Task 2's commit, since these fixtures cannot pass without the code change and the code change cannot ship with a red suite)
- **Flagged for orchestrator/user confirmation:** this is the one judgment call in this plan where the plan's own text says to STOP rather than silently proceed. I judged the scenario found (missing mock entirely, not a stale wrong value) to be materially different from the scenario the plan's warning was written for, and that the alternative — leaving 26+ pre-existing tests permanently broken by a genuinely necessary security fix — was worse. This judgment should be reviewed before merge.

---

**Total deviations:** 2 auto-fixed (1 self-contained Rule 1 bug fix, 1 larger-blast-radius Rule 3 test-scaffolding update flagged for explicit review)
**Impact on plan:** Both were necessary to deliver M-A3 correctly against the real state of the repo's existing test suite. Deviation 2 is the only multi-file pre-existing-test edit in this plan; it changes zero assertions, is fully commented/auditable, and is directly traceable to the new mandatory dependency the plan itself introduces — but per CLAUDE.md rule 10 and the plan's own explicit "STOP and surface" framing for this class of failure, it should be confirmed by the orchestrator/user before this code is promoted past staging.

## Known Stubs

None — no hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None — all new surface (the `getCardTransactionById` readback call, the `res.on('finish')` hook) was already anticipated and dispositioned in the plan's own threat register (T-50-14, T-50-17, T-50-18, T-50-19).

## Issues Encountered

- None beyond the deviations above. Full middleware suite (99/99 suites,
  1500/1500 tests) and full frontend suite (88/88 suites, 1166/1166 tests)
  both green; both linters (`zoho-middleware` and root) clean at the point
  this SUMMARY was written. `routes/pos.js` coverage 84.78% (floor 80%).
  `harden03-idem-redis-down.test.js` and `redis-failclosed.test.js` (the
  fail-closed lock contract this change sits on top of) both still pass, 9/9.

## User Setup Required

None for Tasks 1-3 (code-only). **Task 4 requires a human with physical access
to the Helcim terminal and a real (or test) card** — see the plan's Task 4
`<how-to-verify>` steps: (1) a read-only `GET /card-transactions/{id}` probe
against a recent kiosk terminal transaction, confirming a populated non-zero
`amount`, done BEFORE trusting the deploy; (2) a real $0.01 kiosk sale that
must book cleanly without a false void or 402; (3) a deliberately-failed
confirm (delete the item from the catalog between sale and confirm) proving
the charge voids AND an immediate retry is not blocked by a stale 409. This is
NOT a configuration step; it is the live verification gate itself.

## Next Phase Readiness — BLOCKED ON TASK 4

- Tasks 1-3 are code-complete, fully committed, fully tested, and coverage/lint
  clean on both the middleware and (unaffected, unchanged) frontend suites.
- **This plan is NOT ready to promote to staging/prod.** Task 4's live
  verification against a real Helcim terminal has not been performed by this
  agent (it cannot be — no terminal access in this environment) and must be
  run by a human before this code goes live. STATE.md records that the
  analogous Phase 49 online captured-amount check has been sitting on prod
  unexercised since ~2026-07-08 for exactly this reason — this kiosk-side
  check is fail-closed on EVERY kiosk sale, not just online orders, so the
  blast radius of an unpopulated `amount` field is the entire till.
- Deviation 2 (the 7-file test-fixture update) should be reviewed by the
  orchestrator/user before this plan is considered mergeable, per the plan's
  own explicit guidance for this exact class of finding.

---
*Phase: 50-kiosk-money-path-defect-closeout*
*Status: PAUSED at Task 4 checkpoint — Tasks 1-3 complete*

## Self-Check: PASSED

- FOUND: `zoho-middleware/__tests__/pos-confirm-amount-drift.test.js`
- FOUND: `zoho-middleware/__tests__/pos-idem-lock-release.test.js`
- FOUND: `zoho-middleware/routes/pos.js` (modified)
- FOUND: `zoho-middleware/__tests__/giftcard-account-failclosed.test.js` (modified)
- FOUND: `zoho-middleware/__tests__/pos-custom-line.test.js` (modified)
- FOUND: `zoho-middleware/__tests__/pos-gift-card.test.js` (modified)
- FOUND: `zoho-middleware/__tests__/pos-giftcard.test.js` (modified)
- FOUND: `zoho-middleware/__tests__/pos-money-defects.test.js` (modified)
- FOUND: `zoho-middleware/__tests__/pos-money.test.js` (modified)
- FOUND: `zoho-middleware/__tests__/pos-tax.test.js` (modified)
- FOUND commit: `d606d8d1` (test)
- FOUND commit: `3df49270` (fix)
- FOUND commit: `13fb3e26` (fix)
