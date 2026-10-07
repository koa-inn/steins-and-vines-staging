---
phase: 86-vessels-fermschedules-config-postgres
plan: 11
subsystem: middleware
tags: [postgres, sheet-mirror, redis, vessels, ferm-schedules]
requires: [86-05, 86-06, 86-08]
provides:
  - "lib/ops-mirror.js: schedule(entity,id), sweep(), buildMirrorRequest(), ENTITIES"
affects: [86-14]
key-files:
  created:
    - zoho-middleware/lib/ops-mirror.js
    - zoho-middleware/__tests__/ops-mirror.test.js
decisions:
  - "buildMirrorRequest takes a third id arg so a missing schedule row can build the delete body"
  - "sweep() returns {redriven}; keys with unknown entity are ignored"
metrics:
  tasks: 1
  completed: 2026-10-07
---

# Phase 86 Plan 11: ops-mirror Summary

Entity-keyed (vessel | fermsched) production-only state-copy mirror to the sheet, a copy of the Phase 85 recipe mirror: read-latest at send time, per entity:id coalescing chains, durable Redis marker `ops:mirror-dirty:<entity>:<id>`, 2s/10s/60s/5min backoff, Sentry (tags component/entity/id only), and a sweep for surviving markers.

## Commits
- 6310ec8e: feat(86-11): add ops-mirror

## Verification
- ops-mirror + recipe-mirror tests pass (31); full middleware suite 2631 pass; lint clean.
- No staff entity; `schedule('staff', x)` throws `unknown mirror entity`.

## Deviations from Plan
- `buildMirrorRequest(entity, row, id)` has an extra `id` parameter (needed for the delete body when row is null). 86-14 replay should pass it.
- `mirrorLatest` is also exported (as in recipe-mirror) for tests/replay.

No wiring into routes or the sweep timer in this plan (not in scope; belongs to later plans).

## Self-Check: PASSED
