---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 12
subsystem: middleware
tags: [postgres, batches, admin-proxy, public-routes, freeze]
requires:
  - phase: 87-11
    provides: lib/batch-store.js facade
provides:
  - lib/batch-proxy.js (intercept, WRITE_ACTIONS, ACTION_TO_OP)
  - pos.js batch paths wired to the facade behind BATCHES_STORE / BATCHES_FREEZE
affects: [87-13, 87-15]
key-files:
  created:
    - zoho-middleware/lib/batch-proxy.js
    - zoho-middleware/__tests__/batch-proxy-routes.test.js
    - zoho-middleware/__tests__/batch-routes-postgres.test.js
  modified:
    - zoho-middleware/routes/pos.js
key-decisions:
  - "reassign-customer checks the freeze before resolving or creating the Zoho contact, so a frozen request never leaves a side effect in Zoho"
  - "Facade is only called from direct callers when mode is postgres or frozen, so sheets-mode code paths stay byte-identical"
requirements-completed: [DB-06]
completed: 2026-10-09
---
# Phase 87 Plan 12: Route Swap Summary

Both admin proxies, the three public batch routes, scan-invoices dedup, reassign-customer and the bottling-invite stamp now run on lib/batch-store when BATCHES_STORE=postgres, with the BATCHES_FREEZE 503 in front of every write in either mode. With the flag unset, behaviour is unchanged.

## Tasks
| Task | Commit | Notes |
|------|--------|-------|
| 1 batch-proxy + proxy wiring | 6d5eedb8 | 21 tests |
| 2 public routes, scan-invoices, reassign, stamp | 6d5eedb8 | 18 tests; same commit because both tasks edit pos.js |

## Behaviour
- Proxies: `batchProxy().intercept` runs before `opsProxy.intercept` inside the existing requireTiers callback. Reads and writes return the facade envelope with HTTP 200 (business failures included); facade rejection returns 502 `{ok:false,error:'server_error'}` with no detail and no retry. Actor is `req.staffEmail`.
- `create_batch` logs `[batch-proxy] create_batch ms=<n>` for the SC4 median.
- Public routes: `servePublicFromStore` helper; postgres calls getPublic / publicUpdateTask / publicAddReadings with the same whitelisted fields; freeze gives 503 on the two POSTs in both modes; GET is never frozen.
- Stamp: postgres goes through `batchStore.update`; a maintenance or failure result is logged and swallowed.
- reassign-customer: the facade result feeds the unchanged response construction (Q18 new_version quirk not touched); `maintenance` gives 503, `version_conflict` gives 409.

## Verification
Middleware `npm test` 196 suites / 3082 tests; `npm run test:db` 32 / 353; root `npm test` 163 / 2268; both lints clean. No existing test, js/brewpad.js, js/admin.js or js/batch.js changed.

## Deviations from Plan
- Tasks 1 and 2 landed in one commit (shared file pos.js).
- Tests were written after the implementation rather than strictly red-first; they cover every behaviour line in the plan and pass in both modes.
- Not run: the `git diff 8487c6e7` acceptance commands, since that commit is not in this worktree's history. Equivalent check against base 8be0c5d1 showed no changes under js/ or to existing tests.

## Notes for later plans
- In postgres mode, create_batch with `schedule_id` no longer goes through ops-proxy's schedule-steps fetch; the batch store resolves the schedule itself (87-07).
- propagate_ferm_schedule stays on opsProxy (re-pointed in 87-13).

## Known Stubs
None.

## Self-Check: PASSED
