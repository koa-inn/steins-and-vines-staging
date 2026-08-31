---
phase: 50-kiosk-money-path-defect-closeout
plan: 05
subsystem: payments
tags: [idempotency, kiosk, jest, es5, reconcile, zoho, helcim, recipe-sale, void-on-failure]

# Dependency graph
requires:
  - phase: 50-kiosk-money-path-defect-closeout
    plan: 01
    provides: "helcimLib.voidTransaction rejects with err.isUnconfirmedVoid on an unconfirmed reversal; lib/reconcile.js isAlreadyVoidedError structurally excludes that flag from an already-voided-success classification"
  - phase: 50-kiosk-money-path-defect-closeout
    plan: 02
    provides: "/api/kiosk/salesorder-pay pending-charge record shape (reference_number, amount, salesorder_id, idempotency_key, created_at) — salesorder_id is the D-50-08 discriminator this plan's Task 3 code consumes"
provides:
  - "/api/kiosk/recipe-sale hardened with the SAME idempotency-lock/deterministic-Helcim-key/pending-record/hardened-void primitives as /api/kiosk/sale (M12 / roadmap SC#5)"
  - "lib/reconcile.js is now Zoho-authoritative (D-50-07/D-50-08): a settled paid charge is never voided by reconcile, verified against the SALES ORDER for salesorder-pay records (which never carry a usable invoice reference) and against the invoice reference for sale/recipe records; an unanswerable Zoho call fails CLOSED (never voids what it cannot prove is orphaned)"
  - "OPERATIONAL NOTE for the runbook: while Zoho is unreachable, reconcile no longer auto-voids ANY orphan charge — every pending record fails closed and accumulates for manual review instead. This is the correct trade (never claw back a paying customer's settled sale) but means orphan auto-recovery silently degrades to a manual queue during a Zoho outage. See 'Operational Consequence' below."
affects: [50-kiosk-money-path-defect-closeout, phase-53-money-path-observability-and-ci-gates]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "D-50-06: a route can hold TWO distinct locks for two distinct reasons — an inventory-serialization mutex (RECIPE_SALE) and a duplicate-charge idempotency lock (moneyPath.acquireIdempotencyLock) — acquired in a specific order (idempotency FIRST, fail fast before burning a Zoho quote call) and released independently on different failure paths"
    - "Shared void-on-failure helper consolidating multiple call sites (_voidRecipeTxnWithTimeout in pos-recipe.js) so a file-wide grep for the raw Helcim void call returns exactly one hit (inside the _voidFailed-tracking shim), no matter how many route branches can trigger a post-charge void"
    - "D-50-07/D-50-08: reconcile's settled-check as a discriminated {settled, proven} result rather than a boolean — lets the caller distinguish 'proven settled, safe to clear the sentinel' from 'unprovable, must leave the sentinel intact for the next sweep' without conflating them into the same truthy branch"
    - "Test-fixture mocking as a distinct, narrowly-scoped correctness fix: when a shared lib gains a new external dependency (reconcile.js -> zoho-api), pre-existing unit tests that never needed to mock that dependency before must be given a definitive mock answer, or they silently start exercising a different code branch than the one they were written to test. The fix is supplying the precondition (the mock), never editing the assertion."

key-files:
  created:
    - zoho-middleware/__tests__/pos-recipe-money-path.test.js
    - zoho-middleware/__tests__/reconcile-zoho-authoritative.test.js
  modified:
    - zoho-middleware/routes/pos-recipe.js
    - zoho-middleware/lib/reconcile.js
    - zoho-middleware/__tests__/reconcile.test.js
    - zoho-middleware/__tests__/reconcile-wr02-wr07.test.js
    - zoho-middleware/__tests__/reconcile-unconfirmed-void.test.js

key-decisions:
  - "D-50-06/D-50-06a/M12 implemented exactly as locked in the plan for pos-recipe.js — no design deviation. The RECIPE_SALE inventory mutex was kept unchanged; the idempotency lock is a distinct, separately-released guard acquired before it."
  - "D-50-07/D-50-08 implemented exactly as locked in the plan for lib/reconcile.js — the three-step ladder (cache fast path -> Zoho authority, branching on ctx.salesorder_id -> fail-CLOSED on an unanswerable Zoho call) and the discriminated {settled, proven} caller contract."
  - "Coordinator-approved, scope-bounded exception to CLAUDE.md rule 10 (2026-08-31): added a jest.mock('../lib/zoho-api', ...) returning a definitive 'no matching order' answer to 3 pre-existing test files (reconcile.test.js, reconcile-wr02-wr07.test.js, reconcile-unconfirmed-void.test.js). Root cause and safety verified before the exception was requested/granted: those files never mocked zoho-api, so the new Zoho-authoritative call hit the REAL module, which rejects with 'Not authenticated' in the test env — an unanswerable call the new fail-CLOSED policy correctly refuses to void on, turning positively-proven-orphan scenarios into unprovable ones. No assertion in any of the 3 files was changed — only the missing precondition (mock) was supplied. This plan's own new suite (reconcile-zoho-authoritative.test.js) independently proves every behavior those cases assert, so supplying the precondition is safe, not a coverage gap papered over."
  - "The wip(50-05) commit (46135085) documenting the blocked state was superseded via a non-interactive git reset --soft + recommit (not an interactive rebase, which this environment disallows) so the final history reads test -> fix -> fix with no wip marker, per the coordinator's explicit request."
requirements-completed: [MONEY-02]

# Metrics
duration: ~150min
completed: 2026-08-31
---

# Phase 50 Plan 05: Recipe-Sale Money-Path Hardening + Reconcile Zoho-Authoritative Check — CHECKPOINT (Tasks 1-3 of 4 complete)

**pos-recipe.js now shares /api/kiosk/sale's exact idempotency-lock/deterministic-key/pending-record/hardened-void primitives; lib/reconcile.js is now Zoho-authoritative — a settled paid charge (kiosk sale, recipe sale, or salesorder-pay) is never voided by reconcile, and an unanswerable Zoho call fails closed rather than reversing a card charge it cannot verify. Tasks 1-3 are done and fully green; Task 4 is a live-Zoho-tenant human checkpoint that has NOT been run.**

## STATUS: PLAN NOT COMPLETE — PAUSED AT TASK 4 CHECKPOINT

This SUMMARY documents Tasks 1-3 (all code + regression coverage, fully
green). **Task 4 is a `checkpoint:human-verify` requiring read-only probes
against the live production Zoho tenant — it cannot be executed by this
agent.** Do not treat this plan as done, and do not promote this code past
staging without Task 4's live probe verification (see
`.planning/phases/50-kiosk-money-path-defect-closeout/50-05-PLAN.md` Task 4).

## Performance

- **Duration:** ~150 min (Tasks 1-3, including an investigation + coordinator
  checkpoint round-trip on Task 3's pre-existing test conflict)
- **Started:** 2026-08-31 (session start)
- **Tasks completed:** 3 of 4 (Task 4 = live checkpoint, pending, human-only)
- **Files modified:** 7 (2 created, 5 modified — 2 source files, 3 pre-existing
  test fixtures given a scope-bounded, coordinator-approved mock addition)

## Accomplishments (Tasks 1-3)

- Closed M12 / roadmap SC#5: `/api/kiosk/recipe-sale` now acquires
  `moneyPath.acquireIdempotencyLock` on a `kiosk:idem:` key — the SAME primitive
  `/api/kiosk/sale` uses — as a duplicate-charge guard DISTINCT from the
  pre-existing `RECIPE_SALE` inventory mutex (D-50-06). The idempotency gate
  runs BEFORE `computeRecipeQuote`, so a duplicate fails fast (409) without
  burning a Zoho quote call; the mutex is unchanged and un-removed.
- `terminalPurchase` now receives a deterministic
  `sha256(idempotency_key).substring(0,25)` third argument (D-50-06a), so
  Helcim itself refuses a duplicate charge even if the Redis lock is bypassed.
- A pending-charge record (`kiosk:pending-charge:<refNumber>`) is written
  immediately after a successful terminal push and deleted on confirm success
  (M12) — an orphaned recipe charge is now visible to `lib/reconcile.js`,
  closing the "invisible to the sweep" gap the plan's objective named.
- Both confirm-leg void call sites (unpriceable ingredient line,
  invoice-creation failure) now route through ONE shared
  `_voidRecipeTxnWithTimeout` helper wrapping `moneyPath.voidWithTimeout` via
  a `_voidFailed`-tracking shim (T-50-28, audit H5/L18) — a file-wide grep for
  a raw `helcimLib.voidTransaction` call now returns exactly 1 hit, and it is
  inside the shim. An unconfirmed void (50-01's `isUnconfirmedVoid`) now
  correctly alerts staff instead of resolving silently.
- Closed H3 / roadmap SC#1's named regression: `hasMatchingZohoOrder` is
  rewritten as the D-50-07 three-step ladder (cache fast path -> Zoho
  authority -> fail-CLOSED on an unanswerable call), returning a
  discriminated `{settled, proven}` result so `reconcilePendingCharge` only
  clears the pending sentinel when the answer is PROVEN, never merely
  "settled-by-inference."
- Closed the D-50-08 blocker: the Zoho-authority check branches on
  `ctx.salesorder_id` — a `salesorder-pay` record is verified against the
  SALES ORDER (`balance <= 0.01` or `status`/`order_status` in
  `paid`/`closed`), never an invoice `reference_number` lookup, because
  `fromsalesorder` invoices never carry the kiosk payment reference and a
  naive invoice-only check would wrongly void a fully paid customer.

## Operational Consequence (for the runbook — read this before the next Zoho outage)

**While Zoho is unreachable, `lib/reconcile.js` will no longer auto-void ANY
orphan charge.** Every pending record that would previously have been voided
now fails CLOSED (`settled: true, proven: false`) and is left intact,
accumulating in Redis for up to its 7-day TTL, waiting for a later sweep that
CAN reach Zoho to prove it one way or the other. This is the correct trade —
the alternative (the old policy) reversed a customer's card whenever the
system merely COULDN'T CONFIRM the charge was orphaned, which is far worse
than a charge sitting unreconciled for a few extra hours — but it is a real
behavior change staff need to know about: **orphan auto-recovery silently
degrades to a manual queue during a Zoho outage.** No new alert fires the
moment this happens (each individual failed Zoho call is logged at `error`
level with `[reconcile] Zoho ... lookup failed for ... — treating as settled
(fail CLOSED, D-50-07): will NOT void`, but there is no aggregate "reconcile
is currently blind" signal). If Zoho is down for an extended period during a
busy kiosk day, expect a backlog of pending-charge records that need manual
review once Zoho access is restored, rather than a silent automatic cleanup.

## Task Commits

1. **Task 1: RED — regression suite** - `4ac805bd` (test) — 14 cases (7+7) across two new files, verified failing/passing exactly per the plan's acceptance criteria against unmodified source
2. **Task 2: GREEN — pos-recipe.js money-path adoption** - `b810dd46` (fix) — 7/7 new suite green, 73/73 pre-existing `pos-recipe.test.js` unmodified and green, full middleware suite 1498/1502 (Task 3 not yet implemented), lint clean
3. **Task 3: GREEN — reconcile.js Zoho-authoritative check** - `64af4d23` (fix) — code matches D-50-07/D-50-08 exactly; `reconcile-zoho-authoritative.test.js` 7/7; the 3 pre-existing files that needed a coordinator-approved `zoho-api` mock addition (`reconcile.test.js` 10/10, `reconcile-wr02-wr07.test.js` 3/3, `reconcile-unconfirmed-void.test.js` 6/6) all pass unmodified in assertions

**Plan metadata:** this SUMMARY (plan is NOT complete — paused at Task 4)

_All commits are on `worktree-agent-aa0e2f21a7e3e390f`, based on `65ca1380`
(the merge of plan 50-02's worktree, per this wave's wave-3 `depends_on`).
An earlier `wip(50-05): 46135085` commit documenting Task 3's blocked state
was superseded via `git reset --soft` + recommit (non-interactive, since this
environment disallows `rebase -i`) once the coordinator approved Option A —
the final history carries no `wip` marker._

## Files Created/Modified

- `zoho-middleware/__tests__/pos-recipe-money-path.test.js` — new, 7 cases: duplicate-charge guard, idempotency-lock-before-mutex ordering, required-in-production, deterministic Helcim key, pending-record write, dual-lock release on terminal failure, confirm-leg void through the primitive
- `zoho-middleware/routes/pos-recipe.js` — `/api/kiosk/recipe-sale` gains the idempotency gate + pending record; both confirm-leg void sites consolidated behind `_voidRecipeTxnWithTimeout`; confirm success now also deletes the pending record (Rule 2 addition beyond the plan's literal step list — see Deviations)
- `zoho-middleware/__tests__/reconcile-zoho-authoritative.test.js` — new, 7 cases (8-14): the Zoho-authoritative settled check, cases 12-14 built by driving the REAL `/api/kiosk/salesorder-pay` route (read-only `require('../routes/pos')`, unmodified — owned by sibling plan 50-03 this wave) to capture the actual pending-charge record shape (D-50-08's own explicit anti-blind-spot requirement)
- `zoho-middleware/lib/reconcile.js` — `hasMatchingZohoOrder` rewritten as the D-50-07 three-step ladder returning `{settled, proven}`; `reconcilePendingCharge`'s caller updated to only clear the pending sentinel when `proven`, and to leave it intact when `settled && !proven` (fail-CLOSED)
- `zoho-middleware/__tests__/reconcile.test.js`, `reconcile-wr02-wr07.test.js`, `reconcile-unconfirmed-void.test.js` — coordinator-approved, scope-bounded addition of a `jest.mock('../lib/zoho-api', ...)` returning `{ invoices: [] }` (a definitive "no matching order" answer) so each file's pre-existing orphan scenario remains a POSITIVELY PROVEN orphan under the new ladder. No assertion changed in any of the three files.

## Decisions Made

See `key-decisions` in frontmatter. Both D-50-06/D-50-06a/M12 (Task 2) and
D-50-07/D-50-08 (Task 3) were implemented exactly as locked in the plan — no
design deviation. Task 3 hit a real, empirically-confirmed conflict with 3
pre-existing test files (documented fully below and in the coordinator
round-trip); the coordinator explicitly authorized a narrow, bounded fix
(Option A) rather than any alternative that would have altered behavior or
existing assertions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Confirm-success path did not delete the pending-charge record**

- **Found during:** Task 2, verifying the plan's own acceptance criterion `grep -n "KIOSK_PENDING_CHARGE_PREFIX" ... returns at least 2 matches (write on sale, delete on confirm)`
- **Issue:** My first pass wrote the pending record on the recipe-sale push (per plan step 3) but the plan's step 5 instruction to "Also delete the pending-charge record on the confirm SUCCESS path (mirroring pos.js:1241-1246)" had not yet been wired in — grep returned only 1 match. Without this, every successfully-confirmed recipe sale would leave a live pending-charge record for 7 days, and the reconcile sweep would eventually flag/void a perfectly settled sale once the age guard passed.
- **Fix:** Added `cache.del(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + pendingRef)` on the confirm success path, where `pendingRef = body.reference` — the same string the recipe-sale push returned as `reference` and that the confirm leg already uses verbatim as the invoice's `reference_number` (existing code, `pos-recipe.js` invoice payload). No new plumbing needed.
- **Files modified:** `zoho-middleware/routes/pos-recipe.js`
- **Verification:** `grep -n "KIOSK_PENDING_CHARGE_PREFIX"` now returns 2 code matches; full `pos-recipe.test.js` (73/73) and `pos-recipe-money-path.test.js` (7/7) still green afterward.
- **Committed in:** `b810dd46` (folded into Task 2's commit — same logical unit, both steps of the plan's own Task 2 action list)

### Coordinator-directed resolution (not an executor-unilateral decision)

**2. [Task 3 acceptance criteria, verbatim] "if T1 now fails, the fail-closed inversion has broken genuine orphan detection — STOP and surface it (CLAUDE.md rule 10), do not edit the test."**

- **Found during:** Task 3, running the full middleware suite after implementing `hasMatchingZohoOrder`'s D-50-07 rewrite.
- **What happened:** 3 pre-existing test files — `reconcile.test.js` (T1, T1b, T5), `reconcile-wr02-wr07.test.js` (WR-02-C-ALREADY-VOIDED), `reconcile-unconfirmed-void.test.js` (case B) — never mocked `../lib/zoho-api`. The new Zoho-authoritative branch made a real `zohoGet(...)` call whenever the cache fast path missed; in the test environment (no Zoho credentials), the real `zohoAuth.getAccessToken()` rejects near-instantly with `Not authenticated — complete OAuth flow first` (verified empirically with a throwaway probe test — no hang, ~0-90ms). Per D-50-07 step 3, this is explicitly one of the three named "unanswerable" triggers that must fail CLOSED. So 5 cases written to exercise "genuine orphan -> void" instead exercised "unanswerable -> fail CLOSED -> do NOT void", and failed.
- **Action taken:** STOPPED and surfaced the conflict to the orchestrator exactly as the plan instructed, with the root cause pre-verified empirically (not just inspected) and options laid out (A: mock zoho-api in the 3 files with a definitive answer; B: re-litigate D-50-07's fail-closed policy for auth failures specifically; C: defer to a follow-up plan).
- **Coordinator decision:** Option A approved, explicitly scope-bounded: add `jest.mock('../lib/zoho-api', ...)` to exactly those 3 files, returning a definitive "no matching order" answer (empty `invoices` array; any `salesorder_id`-bearing fixture given an outstanding-balance SO). Change no assertion. If any case needed an assertion changed rather than just the precondition, stop again and report that case specifically.
- **Outcome:** All 3 files needed only the mock addition — no case required an assertion change. `reconcile.test.js` 10/10, `reconcile-wr02-wr07.test.js` 3/3, `reconcile-unconfirmed-void.test.js` 6/6, all green with zero assertion edits (verified via `git diff` showing only the added `jest.mock` block in each file).
- **Files modified:** `zoho-middleware/__tests__/reconcile.test.js`, `zoho-middleware/__tests__/reconcile-wr02-wr07.test.js`, `zoho-middleware/__tests__/reconcile-unconfirmed-void.test.js`
- **Committed in:** `64af4d23` (folded into Task 3's commit, together with `lib/reconcile.js` — same logical unit: the code change and the test-fixture precondition it now requires)

---

**Total deviations:** 1 auto-fixed (Rule 2, folded into Task 2) + 1 coordinator-directed, scope-bounded test-fixture addition (folded into Task 3, per explicit written authorization, zero assertions changed).
**Impact on plan:** Both were necessary to deliver exactly what the plan specifies against the real state of the repo and its pre-existing test suite. Neither represents scope creep — deviation 1 is a plan-step the plan itself specified and I had not yet wired in; deviation 2 is a mechanical test precondition made necessary by the plan's own D-50-07 design, resolved via the exact process the plan mandated (stop, surface, get explicit authorization, keep the fix narrowly scoped).

## Issues Encountered

None beyond the two deviations above, both fully resolved. Full middleware
suite (99 suites / 1502 tests) and full frontend suite (88 suites / 1166
tests) both green; both linters (`zoho-middleware` and root) clean at the
final state of this plan's Tasks 1-3.

## User Setup Required

None for Tasks 1-3 (code-only, fully tested, fully committed). **Task 4
requires a human to run three read-only GET probes against the live
production Zoho tenant** — see the plan's Task 4 `<how-to-verify>` steps.
This is NOT a configuration step; it is the live verification gate itself,
confirming the D-50-08 SO-branch's `so.balance` inference before this code
is trusted in production.

## Next Phase Readiness — BLOCKED ON TASK 4 (live-Zoho probe checkpoint)

- Tasks 1-3 are code-complete, fully committed, fully tested (their own new
  suites AND all pre-existing suites, unmodified in assertions), coverage/lint
  clean in both root and `zoho-middleware`.
- **This plan is NOT ready to promote to staging/prod.** Task 4's live probe
  of the production Zoho tenant has NOT been performed by this agent (it
  cannot be — no Zoho API access in this environment) and must be run by a
  human before this code goes live, per the plan's own framing: the D-50-08
  SO-branch's `balance <= 0.01` settled-signal is currently an INFERENCE from
  how the route reads `so.balance`, not yet verified against the live tenant.
- Roadmap SC#5 (M12) is met: `pos-recipe.js` adopts the same money-path
  primitives + pending-record pattern already used by `pos.js`/`checkout.js`.
- Roadmap SC#1's named regression is met: a regression test (this plan's own
  suite, cases 8-14) asserts a settled paid charge is never voided by
  reconcile, across all three kiosk money-path surfaces (sale, recipe-sale,
  salesorder-pay).
- **Read the Operational Consequence section above before this ships** — it
  is a real behavior change (orphan auto-recovery degrades to a manual queue
  during a Zoho outage) that belongs in the runbook, not discovered live.

---
*Phase: 50-kiosk-money-path-defect-closeout*
*Status: PAUSED at Task 4 checkpoint — Tasks 1-3 complete*

## Self-Check: PASSED

- FOUND: `zoho-middleware/__tests__/pos-recipe-money-path.test.js`
- FOUND: `zoho-middleware/__tests__/reconcile-zoho-authoritative.test.js`
- FOUND: `zoho-middleware/routes/pos-recipe.js` (modified)
- FOUND: `zoho-middleware/lib/reconcile.js` (modified)
- FOUND: `zoho-middleware/__tests__/reconcile.test.js` (modified — mock addition only)
- FOUND: `zoho-middleware/__tests__/reconcile-wr02-wr07.test.js` (modified — mock addition only)
- FOUND: `zoho-middleware/__tests__/reconcile-unconfirmed-void.test.js` (modified — mock addition only)
- FOUND commit: `4ac805bd` (test)
- FOUND commit: `b810dd46` (fix)
- FOUND commit: `64af4d23` (fix)
- CONFIRMED: no `wip(50-05)` commit remains in history (`git log --oneline` shows test -> fix -> fix)
