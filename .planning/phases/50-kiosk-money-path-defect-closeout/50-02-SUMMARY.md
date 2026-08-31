---
phase: 50-kiosk-money-path-defect-closeout
plan: 02
subsystem: payments
tags: [idempotency, kiosk, jest, es5, double-charge, helcim, redis-lock, void-on-failure]

# Dependency graph
requires:
  - phase: 50-kiosk-money-path-defect-closeout
    plan: 01
    provides: "helcimLib.voidTransaction rejects with err.isUnconfirmedVoid on an unconfirmed reversal; lib/reconcile.js isAlreadyVoidedError treats that as NOT already-voided"
  - phase: 50-kiosk-money-path-defect-closeout
    plan: 04
    provides: "kiosk client now sends idempotency_key ('SOPAY-'+soId+'-'+Date.now()) on salesorder-pay requests, stable per attempt"
  - phase: 45-security-and-money-path-hardening
    provides: "lib/money-path.js primitives (acquireIdempotencyLock, voidWithTimeout, finalizeSalesOrderInvoiceAndApplyPayment) already adopted by /api/kiosk/sale"
provides:
  - "/api/kiosk/salesorder-pay hardened with the SAME idempotency-lock/deterministic-Helcim-key/void primitives as /api/kiosk/sale — Tasks 1-3 of 4 complete, code-reviewed, fully tested"
  - "D-50-01 hybrid lock contract implemented: client idempotency_key -> kiosk:idem:sopay:<key> (replayable); no key -> kiosk:idem:sopay:so:<salesorder_id> fallback (locks but never replays)"
  - "D-50-01a deterministic Helcim key: sha256(effectiveKey).substring(0,25) — Helcim itself refuses a duplicate charge even if the Redis lock is bypassed"
  - "D-50-01b unique terminal reference per attempt: soNumber + '-' + first-6-chars-of-helcimIdemKey, used identically in terminalPurchase, pollTerminalResult, and the pending-charge key"
  - "Pending-charge record (SC#4) written after a successful terminal push, salesorder_id included (load-bearing for plan 50-05's D-50-08), deleted on success"
  - "Void routed through moneyPath.voidWithTimeout via a _voidFailed-tracking shim; payment_voided reported honestly instead of hardcoded true"
  - "Both pending-charge write sites (success path, 90s-timeout path) now agree: idempotency_key stores effectiveKey (the attempt's key) consistently, never the derived Helcim key — reconciled after coordinator review, see Deviations"
affects: [50-kiosk-money-path-defect-closeout, 50-05, phase-53-money-path-observability-and-ci-gates]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hybrid idempotency-lock contract (D-50-01): explicit client key vs. server-derived fallback, with the fallback explicitly barred from replaying a cached receipt — used where a route cannot yet require a client-supplied key without an outage risk (no staging middleware for this route)"
    - "_voidFailed tracking shim wrapping helcimLib inside a route handler so moneyPath.voidWithTimeout's existing CRITICAL-log/alert machinery fires unchanged while the route also gets an honest boolean for its own response body — same pattern now used in two call sites in routes/pos.js (sale/confirm and salesorder-pay)"

key-files:
  created:
    - zoho-middleware/__tests__/pos-salesorder-pay-idempotency.test.js
  modified:
    - zoho-middleware/routes/pos.js
    - zoho-middleware/__tests__/pos-giftcard.test.js

key-decisions:
  - "D-50-01/01a/01b implemented exactly as locked in the plan; no design deviation"
  - "Lock is released ONLY on the two pre-charge failure paths the plan explicitly named (terminal-push failure, SO-fetch failure) — NOT on the balance-zero/closed-order guards or the declined-payment branch, even though those are also pre-charge. This was a deliberate pull-back from an initial broader Rule-2 addition, made specifically to avoid breaking kiosk-salesorders.test.js's cache mock (which has no releaseLock at all) — see Deviations."
  - "pos-giftcard.test.js T6/T7 (Phase 45-07) were updated — the ONLY pre-existing test file touched — because they hardcoded the exact bare-soNumber collision (T-50-08) this plan exists to close; keeping them passing unmodified and satisfying D-50-01b's explicit 'MUST be the identical string' requirement are mutually exclusive. See Deviations."
  - "Coordinator review (post-Task-3) caught a field-meaning inconsistency: the timeout-path pending-charge write stored the derived Helcim key in idempotency_key while the success-path write stored effectiveKey. Fixed to store effectiveKey in both — grep-verified the only reader (lib/reconcile.js hasMatchingZohoOrder) never matches either value for salesorder-pay today (it looks up a kiosk:idem:confirm: namespace salesorder-pay never writes), so this was safe to fix without any other code changes. See Deviations."
requirements-completed: []

# Metrics
duration: ~65min
completed: 2026-08-31
---

# Phase 50 Plan 02: Kiosk Salesorder-Pay Idempotency Hardening — CHECKPOINT (Tasks 1-3 of 4 complete)

**salesorder-pay now shares /api/kiosk/sale's exact lock/deterministic-key/unique-reference/pending-record/void primitives — Tasks 1-3 done and fully green; Task 4 is a live-terminal human checkpoint that has NOT been run.**

## STATUS: PLAN NOT COMPLETE — PAUSED AT TASK 4 CHECKPOINT

This SUMMARY documents Tasks 1-3 (all code + regression coverage). **Task 4 is a
`checkpoint:human-verify` requiring a real Helcim terminal and a real card — it
cannot be executed by this agent.** Do not treat this plan as done, and do not
promote this code past staging without Task 4's live double-tap verification
(see `.planning/phases/50-kiosk-money-path-defect-closeout/50-02-PLAN.md` Task 4).

## Performance

- **Duration:** ~65 min (Tasks 1-3 plus a post-Task-3 coordinator-review fix)
- **Started:** 2026-08-31 (session start)
- **Tasks completed:** 3 of 4 (Task 4 = live checkpoint, pending)
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments (Tasks 1-3)

- Closed the headline defect: `/api/kiosk/salesorder-pay` now acquires an idempotency
  lock via `moneyPath.acquireIdempotencyLock` — the SAME primitive `/api/kiosk/sale`
  uses — before ever touching the Zoho balance or the terminal. Two concurrent
  requests for the same order: one proceeds, the other gets 409.
- Implemented the D-50-01 hybrid contract exactly as locked: a client-supplied
  `idempotency_key` becomes the lock key verbatim and IS replayable; with no key,
  a salesorder-scoped fallback (`kiosk:idem:sopay:so:<salesorder_id>`) still locks
  but is explicitly barred from serving a cached receipt (not a statement of intent).
- Replaced `helcimLib.generateIdempotencyKey()` (a fresh random key per call — the
  single most important defect per the plan) with a deterministic
  `sha256(effectiveKey).substring(0,25)`, so Helcim itself refuses a duplicate
  terminal charge even if the Redis lock is ever bypassed.
- Gave each payment attempt a unique terminal reference
  (`soNumber + '-' + helcimIdemKey.substring(0,6)`), used identically across
  `terminalPurchase`, `pollTerminalResult`, and the pending-charge cache key —
  closing the T-50-08 collision where two attempts on one order shared a reference.
- Added a pending-charge record written immediately after a successful terminal
  push (not before — avoids a phantom record for a charge that never happened),
  carrying `salesorder_id` (load-bearing for plan 50-05's D-50-08 discriminator),
  and deleted on the success path.
- Routed the post-charge void through `moneyPath.voidWithTimeout` via the same
  `_voidFailed`-tracking shim pattern already used by the sale/confirm route in
  this file, and made `payment_voided` honest (`!_voidFailed`) instead of a
  hardcoded `true` that lied whenever the void had actually failed or (as of
  plan 50-01) was rejected as unconfirmed.

## Task Commits

1. **Task 1: RED — regression suite** - `ab9e2655` (test) — 11 cases (10 required + 1 extra), 11/11 fail against unmodified source
2. **Task 2 commit 1: idempotency lock gate** - `1de5371b` (fix)
3. **Task 2 commit 2: deterministic Helcim key** - `94c9d70e` (fix) — cases 1-6 green
4. **Task 3 commit 1: unique terminal reference** - `4e849234` (fix) — case 7 green
5. **Deviation fix: pos-giftcard.test.js T6/T7 updated for the new reference format** - `2313fee8` (fix) — see Deviations
6. **Task 3 commit 2: pending-charge record persist/clear** - `29e3c2bd` (fix) — case 8 green
7. **Task 3 commit 3: hardened void + honest reporting** - `8fde749f` (fix) — cases 9-10 green, 10/10 (12/12 incl. extras) total
8. **Checkpoint summary (pre-review)** - `aa414fd3` (docs) — superseded in content by this revision
9. **Coordinator-review fix: reconcile idempotency_key across both pending-charge write sites** - `143be9a3` (fix) — adds a 12th regression case; 97/97 middleware suites, 1488/1488 tests green

**Plan metadata:** this revision of the SUMMARY (plan is still NOT complete — see below)

_All commits are on `worktree-agent-a47fe9f4a5b2a1403`, based on `867c84c1` (post
wave-1-merge tracking commit)._

## Files Created/Modified

- `zoho-middleware/__tests__/pos-salesorder-pay-idempotency.test.js` — new, 12 cases covering the double-charge lock gate, client/fallback key contract, deterministic Helcim key, unique-reference format pin, pending-charge lifecycle, cross-branch `idempotency_key` consistency, and honest void reporting
- `zoho-middleware/routes/pos.js` — `/api/kiosk/salesorder-pay` rewritten: router callback (validation + lock gate) split from `processSalesOrderPay` (the work), mirroring the `/api/kiosk/sale` / `processSale` split
- `zoho-middleware/__tests__/pos-giftcard.test.js` — T6/T7 (Phase 45-07) updated to expect the new unique reference format instead of the bare soNumber they previously hardcoded (see Deviations)

## Decisions Made

See `key-decisions` in frontmatter. In short: implemented D-50-01/01a/01b exactly
as locked, with two judgment calls documented in Deviations below (both driven by
avoiding damage to pre-existing test fixtures while still satisfying the plan's
explicit requirements).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Worktree `node_modules` missing in both `zoho-middleware/` and repo root**
- **Found during:** Task 1, first `npx jest` run
- **Issue:** `Cannot find module 'express'` — this worktree's `node_modules` had never been installed from the committed lockfiles (a worktree-provisioning gap, same class of issue 50-04 hit for `@sentry/node`).
- **Fix:** Ran `npm ci` in both `zoho-middleware/` and the repo root. No `package.json`/`package-lock.json` changes — no Package Legitimacy Gate applicable.
- **Verification:** Both suites subsequently ran normally.
- **Committed in:** N/A — `node_modules` is gitignored.

**2. [Rule 1 - Bug in my own initial diff] `pendingCacheKey` declared inside a sibling `.then()` callback, out of scope where it was later referenced**
- **Found during:** Task 3 commit 2, first `npx jest` run against case 8 ("a pending-charge record is written right after the terminal push and deleted on success")
- **Issue:** `var pendingCacheKey = ...` was declared inside the terminal-push-success `.then(function () {...})` callback, then referenced again inside a LATER SIBLING `.then(function (termResponse) {...}).then(function (result) {...})` deep in the finalize-success handler to call `cache.del(pendingCacheKey)`. Since `var` is function-scoped (not chain-scoped), that reference threw a `ReferenceError` at runtime, which silently diverted execution into the `.catch(function (payErr) {...})` void-on-failure branch instead of completing the success path — masked in the test output as "cache.del never called with the pending key" rather than an obvious crash.
- **Fix:** Moved the `var pendingCacheKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber;` declaration up to the outer `processSalesOrderPay` scope (alongside `refNumber`/`helcimIdemKey`), where both sibling `.then()` callbacks can see it.
- **Files modified:** `zoho-middleware/routes/pos.js`
- **Verification:** Case 8 passed after the fix; full middleware suite re-run confirmed no other test was masking a similar diversion.
- **Committed in:** `29e3c2bd` (folded into Task 3 commit 2, since the fix and the feature it enables are the same logical unit)

**3. [Rule 1 - Scope pull-back to match the plan exactly] Removed extra `cache.releaseLock` calls I had added beyond the plan's 2 explicit release points**
- **Found during:** Task 2 commit 1, first full-suite run (`kiosk-salesorders.test.js`)
- **Issue:** My first draft added `cache.releaseLock(lockKey)` on three pre-charge paths beyond the plan's explicit spec (balance-zero guard, closed/void-order guard, declined-payment branch) as a Rule-2 "obviously good, prevents lock starvation" addition. `kiosk-salesorders.test.js`'s `cache` mock has no `acquireLock`/`releaseLock` at all (that route currently has no lock), so `cache.releaseLock is not a function` broke 2 pre-existing tests ("SO balance is zero returns 400", "payment declined returns 402").
- **Fix:** Pulled back to EXACTLY the plan's threat-model-specified 2 release points (terminal-push generic failure, SO-fetch failure) — the balance-zero/closed-order/declined paths do not release the lock, which is consistent with D-50-01's own documented "accepted cost of the hybrid" tradeoff (a legitimate retry within the TTL window waits instead of being blocked forever).
- **Files modified:** `zoho-middleware/routes/pos.js`
- **Verification:** `kiosk-salesorders.test.js` 38/38 green afterward; scoped `pos-salesorder-pay-idempotency.test.js` subset unaffected.
- **Committed in:** `1de5371b` (never separately committed — the extra calls were removed before the first commit of this task)

**4. [Rule 1 - Pre-existing test hardcoded the exact defect being fixed] Updated `pos-giftcard.test.js` T6/T7**
- **Found during:** Task 3 commit 1, full-suite run
- **Issue:** `pos-giftcard.test.js` T6/T7 (Phase 45-07) asserted the salesorder-pay timeout-branch pending-charge record used the BARE `soNumber` as its reference/cache key — i.e., they encoded the exact T-50-08 collision (two attempts on the same order sharing one reference) as CORRECT behavior. 50-02-PLAN.md Task 3 step 1 explicitly and unambiguously requires: "Pass refNumber (NOT the bare soNumber) to terminalPurchase, to pollTerminalResult, and as the KIOSK_PENDING_CHARGE_PREFIX suffix... or lib/reconcile.js will never locate the record." Satisfying that requirement and keeping T6/T7 passing unmodified are mutually exclusive — there is no third option that keeps `lib/reconcile.js` able to find the pending record (it matches on Helcim's real `invoiceNumber`, which IS the new unique refNumber).
- **Fix:** Updated ONLY the 2 hardcoded reference-format assertions in T6/T7 to compute the expected `refNumber` the same way `routes/pos.js` now does (added a small `expectedSoPayRefNumber` helper using `crypto`, mirroring the production sha256 derivation). No other assertion, mock, or test in the file was touched.
- **Files modified:** `zoho-middleware/__tests__/pos-giftcard.test.js`
- **Verification:** 9/9 `pos-giftcard.test.js` pass; full middleware suite re-run confirmed no further collisions (1487/1487 after Task 3 commit 3).
- **Committed in:** `2313fee8`, as its own separate, clearly-labeled commit (not folded into the reference-uniqueness commit) so it is auditable independently.
- **Caveat (flagged by coordinator review, addressed in Deviation 5):** because `expectedSoPayRefNumber` reimplements the SAME sha256 derivation `routes/pos.js` uses, T6/T7 can prove a pending record is written but CANNOT catch a regression in the reference format itself (a bug in both places at once would still pass). The format is now pinned independently in `pos-salesorder-pay-idempotency.test.js` via a direct regex (`^SO-001-[0-9a-f]{6}$`) that does not mirror the implementation.

**5. [Coordinator review - Rule 1 bug] Two pending-charge write sites disagreed on what `idempotency_key` means**
- **Found during:** Post-Task-3 coordinator review of the merge candidate
- **Issue:** The success-path pending-charge write (`processSalesOrderPay`, after a successful terminal push) stored `idempotency_key: effectiveKey`. The 90s-timeout-path write (pre-existing 45-07 code, updated in Task 3 commit 1 for the new `refNumber`) stored `idempotency_key: helcimIdemKey` — the derived Helcim API key, not the attempt's own idempotency key. Both write to the same `KIOSK_PENDING_CHARGE_PREFIX + refNumber` namespace, so the same field meant two different things depending on which branch fired — a trap for plan 50-05, which is about to read these records via a `salesorder_id` discriminator (D-50-08).
- **Investigation (as directed):** `grep -rn "KIOSK_PENDING_CHARGE_PREFIX|pending-charge" routes/ lib/` showed the only reader of `ctx.idempotency_key` on a pending-charge record is `lib/reconcile.js:102` (`hasMatchingZohoOrder`), which builds `KIOSK_IDEM_PREFIX + 'confirm:' + ctx.idempotency_key` — a namespace written ONLY by `/api/kiosk/sale/confirm`. `salesorder-pay` has no confirm leg, so this lookup never matches for either the old or new value today. The inconsistency was real but currently inert — safe to fix without touching `lib/reconcile.js` or any other reader.
- **Fix:** Both write sites now store `effectiveKey`. `helcimIdemKey` remains one-line-recoverable from `effectiveKey` via the same sha256 derivation already in the route, so nothing is lost.
- **Files modified:** `zoho-middleware/routes/pos.js`, `zoho-middleware/__tests__/pos-salesorder-pay-idempotency.test.js`
- **Test added:** a 12th case that runs one attempt down the success path and a second (same `effectiveKey`) down the timeout path, and asserts both pending records carry the identical `idempotency_key` value — and explicitly asserts it is NOT the sha256-derived Helcim key (the pre-fix timeout-branch value), so a regression back to the old behavior would be caught. This directly covers the shape the coordinator flagged T7 as unable to catch (T7 only asserts `typeof === 'string'`, which passes for either value).
- **Verification:** `zoho-middleware`: 97/97 suites, 1488/1488 tests green, `routes/pos.js` coverage 84.83% (floor 80%), lint clean. Root: 88/88 suites, 1166/1166 tests green (untouched), lint clean.
- **Committed in:** `143be9a3`

---

**Total deviations:** 5 (1 environment gap, 1 self-caught scoping bug, 1 scope pull-back to avoid breaking a pre-existing test, 1 explicitly-mandated pre-existing test fixture update, 1 coordinator-review consistency fix)
**Impact on plan:** All five were necessary to deliver exactly what the plan specifies against the real state of the repo, its other test files, and cross-plan consumers (50-05). Deviation 4 is the only pre-existing-test edit, is narrowly scoped to 2 assertions, and is directly traceable to an unambiguous plan requirement — flagged here for explicit review per CLAUDE.md rule 10, since the plan's own Task 2 acceptance criteria said to STOP and surface rather than silently edit a fixture. I judged the plan's Task 3 step 1 language ("MUST be the identical string... or lib/reconcile.js will never locate the record") to be the "explicitly asked" carve-out that rule anticipates, but this judgment call should be confirmed by the orchestrator/user before merge. Deviation 5 was raised and directed by the coordinator, not self-initiated.

## Issues Encountered

- None beyond the deviations above. Full middleware suite (97/97 suites,
  1488/1488 tests) and full frontend suite (88/88 suites, 1166/1166 tests)
  both green; both linters (`zoho-middleware` and root) clean at the point
  this SUMMARY was last revised.

## User Setup Required

None for Tasks 1-3 (code-only). **Task 4 requires a human with physical access to
the Helcim terminal and a real (or test) card** — see the plan's Task 4
`<how-to-verify>` steps. This is NOT a configuration step; it is the live
verification gate itself.

## Next Phase Readiness — BLOCKED ON TASK 4

- Tasks 1-3 are code-complete, fully committed, fully tested, and coverage/lint clean.
- **This plan is NOT ready to promote to staging/prod.** Task 4's live double-tap
  verification against a real Helcim terminal has not been performed by this
  agent (it cannot be — no terminal access in this environment) and must be run
  by a human before this code goes live, per the plan's own framing: "this route
  deploys to the PRODUCTION Railway instance — there is no staging middleware...
  A green suite did not stop `fda6e40` from never working in prod for four days."
- Plan 50-05 depends on this plan's pending-charge record carrying `salesorder_id`
  (D-50-08 discriminator) — that field is in place and asserted by case 8.

---
*Phase: 50-kiosk-money-path-defect-closeout*
*Status: PAUSED at Task 4 checkpoint — Tasks 1-3 complete*

## Self-Check: PASSED

- FOUND: `zoho-middleware/__tests__/pos-salesorder-pay-idempotency.test.js`
- FOUND: `zoho-middleware/routes/pos.js` (modified, `moneyPath.acquireIdempotencyLock` x3, `moneyPath.voidWithTimeout` present in salesorder-pay handler, both pending-charge writes store `effectiveKey`)
- FOUND: `zoho-middleware/__tests__/pos-giftcard.test.js` (modified)
- FOUND commit: `ab9e2655` (test)
- FOUND commit: `1de5371b` (fix)
- FOUND commit: `94c9d70e` (fix)
- FOUND commit: `4e849234` (fix)
- FOUND commit: `2313fee8` (fix)
- FOUND commit: `29e3c2bd` (fix)
- FOUND commit: `8fde749f` (fix)
- FOUND commit: `aa414fd3` (docs)
- FOUND commit: `143be9a3` (fix)
