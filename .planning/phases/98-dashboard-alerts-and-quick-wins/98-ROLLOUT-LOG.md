# Phase 98 Rollout Log

## Pre-flight

- Date: 2026-11-05
- HEAD before Task 1 commit: a0c8f18d
- Root `npm test`: 252 suites, 3447 tests passed
- Middleware `npm test` (node v24.21.0): 299 suites, 4063 tests passed
- `npm run lint`: clean (0 warnings)
- Spike unit test (`zoho-middleware/__tests__/spike-past-schedule-98.test.js`): 8 passed
- D-01 confirmed in `.planning/research/brewpad-dashboard-v2.md`: line 160 (A3 entry), line 246 (A1-A5 ticked, A3 struck), line 255 (2026-11-05 owner note)

## Past-schedule spike (production, read-only)

Run 2026-11-05 by Claude at the owner's request, via
`railway ssh -e production -s sv_middleware -- 'cd /app/zoho-middleware && node - --run' < scripts/spike-past-schedule-98.js`
(single SELECT, counts and batch_ids only).

| Metric | Value |
|--------|-------|
| active | 40 |
| noSchedule (D-11) | 1 |
| mismatches | [] |
| byPlannedDays any / plus7 / plus14 | 12 / 8 / 6 |
| bySnapshot any / plus7 / plus14 | 12 / 8 / 6 |
| flat90 | 5 |

D-10 gate: PASS (no planned_days vs schedule_snapshot mismatches; plus14 = 6 reproduces the owner's 6 of 40; 1 batch excluded for no schedule).

## Staging deploy

Pending (Task 3).

## Staging UAT

Pending (Task 3).

## Gaps

None recorded yet.
