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

- 2026-11-05 ~15:29 MST: `git push origin main` (6b5cc3b7..e0240304), owner said "push". Staging only; no production push.
- Railway staging sv_middleware deploy fdc19b14: SUCCESS.
- GitHub Actions "Deploy Staging (filtered)": success.

## Staging UAT

Claude-piloted pass, 2026-11-05 ~14:45 PT, desktop Chrome on staging ?dash=v2 (owner signed in to Cloudflare Access):

- Item 2 (placement): PASS. The Needs attention row is first in Today, above Today's tasks. Counts unchanged after switching filters to Wine + 30d.
- Item 3 (chips/order/colour): PASS. Overdue (11, red) · Due today (1) · Past schedule (8, amber) · Invite not sent (3) · Waitlist waiting (7).
  - Past schedule 8 on staging vs 6 on prod is a data difference. The same read-only spike against the staging DB gives active 40, noSchedule 1, mismatches [], plus14 8.
- Item 4 (tap-throughs): PASS.
  - Overdue → Tasks with 11 tasks.
  - Due today → Tasks with the Due today chip selected, 1 task.
  - Past schedule → Batches, banner "Showing 8 batches past schedule.", 8 rows, "N days past plan" sorted desc (244…37); ✕ clears the banner.
  - Invite not sent → banner "Showing 3 ready-to-bottle batches with no invite sent.", 3 rows.
  - Waitlist waiting → Waitlist tab on Waiting, 7 rows.
- Item 5 (invite count drop): NOT RUN (sends a real email; owner to do with a self-addressed batch if wanted).
- Item 6 (after 4 pm PT Tasks grouping): PASS, checked 16:40 PT 2026-11-05. On All, SV-B-000250 "Brew, Cast, and Yeast Pitch" (due 2026-11-05) sits under the TODAY (1) header, not Overdue. The Due today chip lists it; the Overdue chip does not.
- Item 7 (iPad portrait wrap): PASS.
  - 390px same-origin iframe: 5 chips wrap onto 3 lines, no horizontal scroll, every chip 44px tall.
  - 768px: no horizontal scroll.
  - Real iPad portrait: owner approved.

Owner approval: "approved", 2026-11-05 (after the after-4pm check). Past schedule signed off (D-10 gate PASS).

## Gaps

None. Follow-ups (not gaps):
- Item 5 (invite count drop after Send Invite) was not run live, because it sends a real email; unit-covered in 98-04/98-05.
- "This Week" Tasks boundary still uses UTC (98-03 follow-up).
