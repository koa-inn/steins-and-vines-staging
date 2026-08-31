---
phase: 50-kiosk-money-path-defect-closeout
plan: 04
subsystem: payments
tags: [idempotency, kiosk, jest, es5, double-tap, re-entrancy-guard]

# Dependency graph
requires:
  - phase: 45-security-and-money-path-hardening
    provides: server-side idempotency lock (acquireIdempotencyLock) on POST /api/kiosk/sale and /api/kiosk/recipe-sale
  - phase: 48-kiosk-de-fork
    provides: shared js/kiosk-core.js consumed identically by kiosk.html and admin.html
provides:
  - One stable idempotency_key minted per kiosk sale payment attempt (kioskProceedToPayment), read (never re-minted) by every re-entry within that attempt
  - Proceed/Skip buttons disabled on click + a _kioskPaymentInFlight re-entrancy guard as the backstop
  - salesorder-pay now sends idempotency_key; kioskCollectPayment gains its own per-order in-flight guard + Pay-button disable-on-click
  - _kioskEndPaymentAttempt() central cleanup, wired into every terminal outcome (success/cancel/error) on both money paths
affects: [50-kiosk-money-path-defect-closeout, phase-53-money-path-observability-and-ci-gates]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Re-entrancy guard + disable-on-click as a paired primary/backstop guard on kiosk money-path buttons (button-disable alone is defeated by a stale queued onclick; the guard alone is defeated only by tapping a DIFFERENT still-enabled control)"
    - "Mint-once-per-attempt idempotency key stored in a module-scoped var, cleared via a single shared cleanup helper wired into every terminal branch (success/cancel/error), mirroring the server-side lock-release discipline from Phase 45"

key-files:
  created:
    - tests/frontend/kiosk-idempotency-key.test.js
  modified:
    - js/kiosk-core.js
    - js/kiosk-core.min.js
    - kiosk.html
    - admin.html

key-decisions:
  - "D-50-05 implemented against the file AS IT ACTUALLY IS, not as 50-04-PLAN.md described it: the refNumber/idempotency-key mint site had already been hoisted from inside _kioskPushToTerminal up into kioskProceedToPayment sometime after the plan was authored (most likely during the Phase 70 cash/moto tender work, WR-02) — which incidentally already fixed the intra-attempt re-entry half of the defect. The double-tap-of-Proceed/Skip half (two separate kioskProceedToPayment() calls) is what remained live and is what this plan closes."
  - "_kioskEndPaymentAttempt() and the equivalent SO-pay clears are centralized inside kioskShowError/kioskShowReceipt/kioskShowSoError (called from every terminal branch) rather than duplicated at each of the ~15 individual call sites, so a future new failure branch inherits the cleanup automatically instead of needing to remember it."
  - "The SO-pay guard clears BEFORE kioskShowSoError fires (not after), because kioskShowSoError's own Retry button re-enters kioskCollectPayment(_kioskSoPayingId) synchronously — clearing after would make every retry silently no-op against the guard it just set."

requirements-completed: [MONEY-02]

# Metrics
duration: ~10min
completed: 2026-08-31
---

# Phase 50 Plan 04: Kiosk Client Double-Tap / Idempotency-Key Defect Closeout Summary

**One idempotency key per kiosk payment attempt (sale AND salesorder-pay) plus disable-on-click + re-entrancy guards, so a double-tap can no longer defeat the Phase 45 server-side idempotency lock.**

## Performance

- **Duration:** ~10 min (commit span 10:34:27 → 10:43:40 PDT; total session including read/investigation longer)
- **Started:** 2026-08-31T17:34:27Z
- **Completed:** 2026-08-31T17:43:40Z
- **Tasks:** 3 (RED, GREEN sale-path, GREEN SO-pay-path + build)
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- Closed M-B1's client half: double-tapping Proceed, Skip, or a `.kiosk-so-pay-btn` now sends exactly ONE request; any request that does still reach the server for the same attempt carries the SAME `idempotency_key`, so the Phase 45 server-side lock (`acquireIdempotencyLock`) finally sees the duplicate it was built to catch.
- `salesorder-pay` now sends `idempotency_key` in its request body (the client half of plan 50-02's D-50-01 contract).
- Every terminal outcome (success, cancel, and every error branch on both money paths) reliably clears the in-flight guard and re-enables the buttons — verified against the specific bricked-kiosk and bricked-retry failure modes the plan's threat model called out (T-50-22).
- Documented and worked around real plan-vs-code drift found during `read_first` verification (see Deviations) rather than blindly following stale line-number references.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — regression test proving a double-tap produces two different idempotency keys** - `e20691a9` (test)
2. **Task 2: GREEN — sale path: one stable key per payment attempt + disable-on-click** - `27d25186` (fix)
3. **Task 3: GREEN — sales-order path: stable key + disable-on-click** - `49314466` (fix), then **regenerate build artifacts** - `cb22d30c` (build)

_No refactor commit needed — no dead code or duplication left behind by the GREEN implementation._

## Files Created/Modified

- `tests/frontend/kiosk-idempotency-key.test.js` - 8 cases (7 from the plan + 1 extra explicit SO-pay-retry regression) covering double-tap suppression, key stability within an attempt, key freshness across attempts, button disable/re-enable, and the SO-pay retry-after-decline path
- `js/kiosk-core.js` - `_kioskPaymentKey`/`_kioskPaymentInFlight` (sale path) and `_kioskSoPayKey`/`_kioskSoPayInFlightId` (SO-pay path) module state; re-entrancy guards at the top of `kioskProceedToPayment`/`kioskCollectPayment`; disable-on-click on Proceed/Skip/`.kiosk-so-pay-btn`; new `_kioskEndPaymentAttempt()` cleanup helper wired into every terminal branch
- `js/kiosk-core.min.js` - regenerated via `npm run build` (terser); content diff confirmed non-empty before committing
- `kiosk.html`, `admin.html` - cache-busting query strings re-stamped by the same build run (both explicitly in this plan's `files_modified`)

## Decisions Made

See `key-decisions` in frontmatter. In short: implemented D-50-05's intent (one key per attempt, disable + re-entrancy guard, clear on every terminal outcome) against the code's actual current structure rather than the plan's stale line-number description of it, since the mint site had already moved between when the plan was authored and when this executed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Plan drift, not a bug] Adapted RED test design and fix location to match actual current code structure**
- **Found during:** Task 1 (`read_first` verification against `js/kiosk-core.js`)
- **Issue:** 50-04-PLAN.md describes `refNumber = 'KIOSK-' + Date.now()` as minted **inside** `_kioskPushToTerminal`, per invocation (line ~2446), with `_kioskPushToTerminal` as a function reachable independently of `kioskProceedToPayment`. In the actual current file, the mint site had already been hoisted up into `kioskProceedToPayment` itself as a per-attempt closure variable, and `_kioskPushToTerminal` is a nested closure defined fresh each `kioskProceedToPayment()` call that reads that same variable — meaning the "re-entry within one attempt" half of the bug (gift-card panel step, stock-override resubmit) was **already fixed** by that unrelated prior refactor (most likely Phase 70's cash/moto tender work, WR-02, which needed a stable per-attempt base key). All function/line references in the plan (`:2105-2113`, `:2314-2330`, `:2446`, `:2600-2620`, `:3280-3320`, `:3554-3620`) were correspondingly off by 150-750 lines against the actual file.
- **Fix:** Verified actual current behavior empirically (ran the RED suite against unmodified source) rather than trusting the plan's stale line numbers. Redesigned the 7 RED cases so cases 1/2/4/6/7 genuinely reproduce the LIVE defect (two separate `kioskProceedToPayment()`/`kioskCollectPayment()` calls — i.e. an actual double-tap — mint two different keys and send two requests) while cases 3/5 assert the already-partially-correct anti-over-correction behavior. Implemented D-50-05's guard/mint/cleanup design at the CURRENT locations (`kioskProceedToPayment` top, `kioskCollectPayment` top, the Proceed/Skip/`.kiosk-so-pay-btn` handlers, `kioskShowError`/`kioskShowReceipt`/`kioskShowSoError`/the three sale-path cancel handlers).
- **Files modified:** `tests/frontend/kiosk-idempotency-key.test.js`, `js/kiosk-core.js`
- **Verification:** Ran the RED suite against unmodified source first (5/7 failed as designed, 2/7 passed — matching the acceptance criteria's exact required-failure list of cases 1,2,4,6,7) before writing any fix code; re-ran after each GREEN commit (7/7, then 8/8 with the added retry-path test).
- **Committed in:** `e20691a9` (Task 1), `27d25186`/`49314466` (Task 2/3 fixes)

**2. [Rule 3 - Blocking] `zoho-middleware/node_modules` missing `@sentry/node` in this worktree**
- **Found during:** Task 3 verification (`cd zoho-middleware && npm test`)
- **Issue:** 81/94 middleware test suites failed to even load with `Cannot find module '@sentry/node'`. `@sentry/node` is already a committed dependency in `zoho-middleware/package.json` (`^10.42.0`) and the lockfile was clean/unmodified — this worktree's `node_modules` simply hadn't been installed from it (a worktree-provisioning gap, not a code issue, and not a new/unverified package — Package Legitimacy Gate not applicable).
- **Fix:** Ran `npm ci` in `zoho-middleware/` to sync `node_modules` from the already-committed lockfile. No `package.json`/`package-lock.json` changes.
- **Verification:** Middleware suite went from 81 failed/13 passed to 94/94 passed, 1461/1461 tests — matching the documented baseline exactly.
- **Committed in:** N/A — `node_modules` is gitignored; no commit needed or made.

**3. [Rule 1 - Bug in `git commit -m` shell quoting] Truncated commit message on the Task 3 source commit**
- **Found during:** Task 3, first commit attempt
- **Issue:** The intended commit message contained an inner double-quoted phrase (`"Save & Pay"`) inside an outer double-quoted `-m` argument; the shell closed the outer string early at the inner quote and interpreted `& Pay" flow...` as a backgrounded command, truncating the actual commit message mid-sentence (exit code 127 on the stray trailing text, but the commit itself had already been created with the truncated message).
- **Fix:** Wrote the full intended message to a scratch file and ran `git commit --amend -F <file>` to correct it. No code/file content was affected — the diff being committed was already staged correctly; only the message text was wrong.
- **Verification:** `git log -1 --format=%B` confirmed the full corrected message; `git status --short` confirmed no stray files or extra commits from the malformed shell fallout.
- **Committed in:** `49314466` (amended)

**4. [Rule 1 - Bug/scope] Reverted unrelated build churn from `npm run build`**
- **Found during:** Task 3, after running the full project build
- **Issue:** `npm run build` is a single whole-project script (stamp + stamp:admin/kiosk/brewpad/index/pages + minify:css + minify:js) with no narrower "just kiosk" target. Running it touched 21 files: the 3 this plan actually needs (`js/kiosk-core.min.js`, `kiosk.html`, `admin.html`) plus 18 unrelated ones — `about.html`, `brewpad.html`, `contact.html`, `custom-labels.html`, `index.html`, `ingredients.html`, `products.html`, 8 `products/*.html` pages, `reservation.html` (all pure cache-bust query-string churn, zero content change since their sources were untouched), and `js/admin.js` (its `BUILD_TIMESTAMP` constant) + the resulting `js/admin.min.js` regen.
- **Fix:** `git checkout -- <each unrelated file>` individually (never a blanket reset) to discard the incidental churn before staging, keeping only the 3 files this plan's `files_modified` actually declares.
- **Files modified:** Reverted (not committed): `about.html`, `brewpad.html`, `contact.html`, `custom-labels.html`, `index.html`, `ingredients.html`, `js/admin.js`, `js/admin.min.js`, `products.html`, `products/additives.html`, `products/equipment.html`, `products/ferment-in-store.html`, `products/grains.html`, `products/hops.html`, `products/ingredients-supplies.html`, `products/packaging.html`, `products/yeast.html`, `reservation.html`.
- **Verification:** `git status --short` after revert showed only `admin.html`, `js/kiosk-core.min.js`, `kiosk.html` modified; `git diff --stat js/kiosk-core.min.js` confirmed a genuine (non-empty) content diff, not just a stamp.
- **Committed in:** N/A — reverted before staging, never committed.

---

**Total deviations:** 4 auto-fixed (1 plan-drift adaptation, 1 blocking environment gap, 1 shell-quoting bug, 1 build-scope revert)
**Impact on plan:** All four were necessary to deliver the plan's actual intent (a working, correctly-scoped, fully-tested fix) against the real state of the repo and this worktree. No scope creep — deviation 4 specifically PREVENTED scope creep that the build tooling would otherwise have introduced.

## Issues Encountered

- The plan's Task 2 `<verify>` line (`npx jest ... -t "sale|attempt|Proceed|Skip" && npm test && npm run lint`) implicitly assumed `npm test` would be fully green at the Task 2 checkpoint. Because Task 1 bundled all 7 cases (both sale-path and SO-pay-path) into ONE test file, the full `npm test` run at the Task-2-only checkpoint necessarily still showed 2 known-pending failures (cases 6-7, not yet fixed until Task 3). Treated this the same way a RED commit's failing test is treated within a TDD arc: verified the SALE-PATH-SCOPED subset was green (`-t "sale path"`, 5/5), confirmed lint was clean, and completed Task 3 immediately in the same session so the final delivered state is fully green (1166/1166 frontend, 1461/1461 middleware, lint clean) with no risk of shipping the intermediate partial state.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- M-B1 is closed on both kiosk surfaces (kiosk.html standalone, admin.html embedded) via the shared `kiosk-core.js` — no further client-side work needed for this defect.
- The `js/kiosk-core.min.js` the iPad actually loads has been regenerated and is live in this worktree's commits; ready for the normal staging → prod promotion path once merged.
- Phase 50 plan 04 was the last of Phase 50's plans per the roadmap's MONEY-02 scope (H4: release idempotency lock on every failure path — this plan's client half specifically); STATE.md/ROADMAP.md updates deferred to the orchestrator per worktree-mode convention.

---
*Phase: 50-kiosk-money-path-defect-closeout*
*Completed: 2026-08-31*

## Self-Check: PASSED

- FOUND: `tests/frontend/kiosk-idempotency-key.test.js`
- FOUND: `.planning/phases/50-kiosk-money-path-defect-closeout/50-04-SUMMARY.md`
- FOUND commit: `e20691a9` (test)
- FOUND commit: `27d25186` (fix — sale path)
- FOUND commit: `49314466` (fix — SO-pay path)
- FOUND commit: `cb22d30c` (build — artifacts)
