---
phase: 82-store-agnostic-prerequisites
plan: 02
subsystem: api
tags: [apps-script, google-sheets, locking, concurrency, batch-tracking, gift-cards]

# Dependency graph
requires: []
provides:
  - "batchDedupDecision pure function (createBatch's invoice+SKU dedup logic, now runs after the lock)"
  - "updateGiftCardInvoice wrapped in acquireScriptLock/finally (D-18, closes T-82-02-02)"
  - "7 new doPost server_token write entries (D-11): update_reservation, update_hold, update_homepage, add_batch_task, update_batch_task, propagate_ferm_schedule, regenerate_batch_token"
  - "_uniqueBatchIds pure helper + per-task batch cache-busting in updateBatchTask/bulkUpdateBatchTasks (D-09 server half)"
affects: [82-04-middleware-admin-proxy]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure decision functions extracted from Apps Script handlers for Jest testability (batchDedupDecision, _uniqueBatchIds) — same technique as Phase 51's giftCardLedgerDecision"
    - "source-shape assertions via sliceFunctionSource(src, name) brace-matching on the raw adminApi.gs text, since SpreadsheetApp/LockService/CacheService cannot be stubbed"

key-files:
  created:
    - tests/frontend/adminapi-phase82-locks.test.js
    - tests/frontend/adminapi-phase82-dispatch.test.js
  modified:
    - apps-script/adminApi.gs
    - tests/frontend/adminapi-giftcard-ledger.test.js

key-decisions:
  - "D-18 supersedes the Phase 51 decision '44-02' (updateGiftCardInvoice deliberately unlocked) — updated the one pre-existing test assertion that encoded 44-02, since the two decisions directly contradict on the same function"

patterns-established:
  - "Pattern: when a lock/atomicity fix in this phase reverses an earlier phase's explicit no-lock decision, update only the single assertion that encodes the old decision, not the surrounding suite"

requirements-completed: [DB-01]

# Metrics
duration: 8min
completed: 2026-09-23
---

# Phase 82 Plan 02: Apps Script lock fixes, D-11 dispatch, D-09 cache-bust Summary

**Closed both D-18 Apps Script lock holes (createBatch's dedup TOCTOU race and updateGiftCardInvoice's missing mutex), opened doPost's server_token path to the 7 admin writes the Phase 82-04 middleware proxy will forward, and made batch-task writes bust the task's own batch cache regardless of what the caller sends.**

## Performance

- **Duration:** ~8 min (18c638bb to f620636e)
- **Started:** 2026-09-23T13:30:16-07:00
- **Completed:** 2026-09-23T13:34:33-07:00
- **Tasks:** 2 completed (both TDD: RED then GREEN)
- **Files modified:** 1 source file (`apps-script/adminApi.gs`), 1 new + 1 modified test file

## Accomplishments
- `createBatch`'s invoice+SKU dedup guard extracted into a pure, unit-tested `batchDedupDecision()` and moved to run AFTER `acquireScriptLock(15000)`, inside the same `try` that generates the batch ID and appends the row — closes the check-then-append race (T-82-02-01). Dedup contract (unit_total floor / legacy / invoice-only fallback) is byte-for-byte unchanged, only the read timing moved.
- `updateGiftCardInvoice`'s entire read-modify-write is now wrapped in `acquireScriptLock(15000)`/`finally releaseLock()` — previously had no mutex at all and could race `redeemGiftCard`/`reloadGiftCard`/`voidGiftCard` on the same GiftCards row (T-82-02-02).
- `doPost`'s `server_token` branch gained 7 new write entries (`update_reservation`, `update_hold`, `update_homepage`, `add_batch_task`, `update_batch_task`, `propagate_ferm_schedule`, `regenerate_batch_token`), each passing `'middleware'` as the actor, mirroring the existing `update_batch` shape. The staff switch keeps every one of its 25 existing cases unchanged (D-19 — old browser path stays live until cutover).
- `updateBatchTask` now returns its own `batch_id` on success; new pure `_uniqueBatchIds()` helper de-duplicates affected batches order-preservingly; `bulkUpdateBatchTasks` busts every distinct batch its tasks belong to and returns `affected_batch_ids` (fixes the multi-batch calendar-view save bug flagged in `82-RESEARCH.md` orchestrator guidance 1). The staff-switch `update_batch_task` case now invalidates `r.batch_id || payload.batch_id` instead of only `payload.batch_id`.

## Task Commits

Each task was committed atomically (TDD: test commit then feat commit):

1. **Task 1: D-18 lock fixes** — `18c638bb` (test, RED) → `1ef690cd` (feat, GREEN)
2. **Task 2: D-11 dispatch + D-09 cache-bust** — `9b15f5cc` (test, RED) → `f620636e` (feat, GREEN)

**Plan metadata:** commit pending (this SUMMARY + any state files, made by the orchestrator after all wave agents complete — per this plan's instructions this executor does not touch STATE.md/ROADMAP.md).

## Files Created/Modified
- `apps-script/adminApi.gs` — `batchDedupDecision()` (new, pure), `createBatch()` (dedup call moved inside lock), `updateGiftCardInvoice()` (wrapped in lock/finally), `doPost()` (7 new server_token entries + staff-switch `update_batch_task` cache-bust fix), `updateBatchTask()` (returns `batch_id`), `_uniqueBatchIds()` (new, pure), `bulkUpdateBatchTasks()` (per-batch cache-bust + `affected_batch_ids`)
- `tests/frontend/adminapi-phase82-locks.test.js` (new) — 14 tests: `batchDedupDecision` contract + purity, lock-ordering source-shape for `createBatch`/`updateGiftCardInvoice`
- `tests/frontend/adminapi-phase82-dispatch.test.js` (new) — 28 tests: 7 server_token entries + actor-arg assertions, staff-switch preservation, `_uniqueBatchIds` contract, per-task cache-bust source shape
- `tests/frontend/adminapi-giftcard-ledger.test.js` (modified, 1 test) — updated the one assertion that encoded the now-superseded "updateGiftCardInvoice has no lock" decision (44-02); see Deviations below

## Decisions Made
- D-18 (`updateGiftCardInvoice` gets a lock) supersedes Phase 51's decision 44-02 (deliberately no lock) — this phase's threat model explicitly assigns `mitigate` to T-82-02-02 for exactly this function, so the new decision is authoritative.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — correctness/security, plan-authorized] Updated one pre-existing test assertion that contradicted this task's own explicit objective**
- **Found during:** Task 1 (D-18 lock fixes), verification step
- **Issue:** `tests/frontend/adminapi-giftcard-ledger.test.js` (written in Phase 51) contains a test literally named `'updateGiftCardInvoice still takes no lock (decision 44-02 stands, deliberately left unmodified)'`, asserting zero occurrences of `acquireScriptLock(` in that function. This plan's Task 1 — per its own `<action>`, `<must_haves>`, and `<threat_model>` (T-82-02-02, disposition `mitigate`) — explicitly requires adding `acquireScriptLock(15000)` to that exact function. The two are in direct, unavoidable contradiction: implementing D-18 as instructed necessarily fails that one pre-existing assertion. The plan's own Task 1 acceptance criteria also states `git diff --stat tests/frontend/adminapi-giftcard-ledger.test.js` should be empty — a bullet that cannot be simultaneously satisfied with the D-18 requirement.
- **Fix:** Updated only the single obsolete assertion (renamed to `'updateGiftCardInvoice now runs under acquireScriptLock (D-18, Phase 82 — supersedes decision 44-02)'`, now asserting the lock IS present with a `finally`/`releaseLock()`). All 87 other tests in that file (the giftCardLedgerDecision contract, redeem/reload business-rule preservation, issueGiftCard/lookupGiftCard/voidGiftCard shape checks) are untouched.
- **Files modified:** `tests/frontend/adminapi-giftcard-ledger.test.js` (1 test block changed)
- **Verification:** Full suite `npx jest tests/frontend/adminapi-phase82-locks.test.js tests/frontend/adminapi-giftcard-ledger.test.js` → 102/102 pass. Full frontend `npm test` → 132 suites / 1896 tests pass.
- **Committed in:** `1ef690cd` (part of Task 1's GREEN commit, called out explicitly in the commit message)

---

**Total deviations:** 1 auto-fixed (Rule 2 — correctness fix explicitly authorized by this plan's own D-18/threat-model instructions, in unavoidable conflict with a stale pre-existing test from a prior, now-superseded phase decision)
**Impact on plan:** No scope creep — the change is a single test-assertion update matching a behavior change the plan itself mandates. Every other acceptance-criteria bullet for both tasks (grep counts, lock-ordering, dedup contract preservation, 7-action dispatch, staff-switch preservation, `_uniqueBatchIds` contract) is met exactly as specified. Flagging this clearly since CLAUDE.md Rule 10 ("do NOT modify existing tests unless explicitly asked") and this plan's own Task 1 acceptance-criteria bullet both nominally forbid touching this file — the plan's D-18 action instructions are the more specific and current authority, and they cannot be satisfied without this one-line test update.

## Issues Encountered
- `zoho-middleware/node_modules` was not installed in this worktree (pre-existing environment gap, unrelated to any file this plan touches). Ran `npm install` (no new packages — restoring the existing `package-lock.json`) so `cd zoho-middleware && npm test` could run per CLAUDE.md's before-commit rule. Result: 111 suites / 1628 tests, all green.

## User Setup Required

None — no external service configuration required. Apps Script redeploy (to take these fixes live) is out of scope for this plan; per `82-CONTEXT.md`/`82-RESEARCH.md`, the redeploy is sequenced with the rest of Phase 82's owner-facing steps in a later plan.

## Next Phase Readiness
- `apps-script/adminApi.gs` now carries both D-18 lock fixes, the 7 D-11 server_token entries, and D-09's server-half cache-busting — all pinned by 42 new tests (14 + 28) plus the full pre-existing suite (132 frontend suites / 1896 tests, 111 middleware suites / 1628 tests), all green, lint clean.
- Nothing with a live caller was removed — the staff switch (old browser path) is byte-for-byte preserved except the one intentional `update_batch_task` cache-key fix, so this file stays safe to redeploy while the old browser path is still live (D-19).
- Ready for Plan 82-04 (middleware admin-proxy), which will forward `js/admin.js`'s writes through these 7 new server_token actions.
- Repudiation trade-off flagged but accepted per plan's threat model (T-82-02-04, disposition `accept`): the new server_token writes record the actor as `'middleware'` rather than the staff email — same trade Phase 76 accepted for BrewPad. A candidate follow-up is passing `req.staffEmail` through from the 82-04 proxy in a later phase.

---
*Phase: 82-store-agnostic-prerequisites*
*Completed: 2026-09-23*

## Self-Check: PASSED

- FOUND: apps-script/adminApi.gs
- FOUND: tests/frontend/adminapi-phase82-locks.test.js
- FOUND: tests/frontend/adminapi-phase82-dispatch.test.js
- FOUND: tests/frontend/adminapi-giftcard-ledger.test.js
- FOUND: .planning/phases/82-store-agnostic-prerequisites/82-02-SUMMARY.md
- FOUND commit: 18c638bb (test, RED, Task 1)
- FOUND commit: 1ef690cd (feat, GREEN, Task 1)
- FOUND commit: 9b15f5cc (test, RED, Task 2)
- FOUND commit: f620636e (feat, GREEN, Task 2)
