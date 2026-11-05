---
phase: 97-beer-and-cider-dashboard-sections
plan: 12
subsystem: release
tags: [staging, uat, cal-com, railway, apps-script]
requires:
  - phase: 97-11
    provides: Phase 97 on staging
provides:
  - "Cal.com beer packaging env var on staging and production; Apps Script v66 (rollback v65)"
  - "Staging UAT items 1-7 and 9 PASS; 8 skipped"
affects: [production release]
key-files:
  modified:
    - .planning/phases/97-beer-and-cider-dashboard-sections/97-ROLLOUT-LOG.md
    - .planning/todos/done/calcom-beer-packaging-appointment.md
key-decisions:
  - "Matcher's never-guess rule confirmed live: an email shared by 4 active batches returned no batch until a unique email was used"
requirements-completed: [D-02, D-03, D-06, D-14, D-16, SC1, SC2, SC3, SC4, TODO-beer-packaging]
metrics:
  tasks: 3
  completed: 2026-11-05
---

# Phase 97 Plan 12: Owner steps and staging UAT Summary

All owner steps done and staging UAT passed.

## Owner steps
- CALCOM_EVENT_TYPE_BEER_PACKAGING=6028745 added on staging (deploy 7e4520e5) and production (deploy 540dd4ae, restart only). Production /health authenticated true, database true at 2026-11-04T21:22:45Z; services list 3 incl. beer consult.
- Apps Script adminApi.gs deployed as v66 (rollback v65).
- Live Cal.com list with header 2026-05-01 works on staging.

## UAT
- Items 1, 3, 4, 5, 7 piloted by Claude; 2 and 6 save steps by owner; 9 booking matched SV-B-000250 (test booking cancelled); 8 skipped.

## Follow-ups for the production release
- Migration 0009 must run on production (preDeploy) before the Phase 97 code serves traffic.
- Cal.com env already set on production; production value has a harmless leading space (tidy optional).
- Apps Script v66 already live (inert until a recipe with target values mirrors).
- First uncached packaging-bookings call took about 17 s on staging; watch it.
- Matching is exact on email: plus-addresses and shared family emails will not match (by design).
- Owner question still open: the Cal.com 60/90/120/150 duration ladder.
