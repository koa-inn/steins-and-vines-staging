---
phase: 98
status: passed
score: 5/5
verified: 2026-11-05
---

# Phase 98 Verification

**Goal:** The dashboard surfaces the things staff need to act on: attention items by type, stale batches, vessel conflicts, uninvited bottling and the waitlist. A3 (vessel conflicts) was struck by the owner under D-01.

| # | Truth | Status | Evidence |
|---|---|---|---|
| A1 | Overdue and Due today task chips open the filtered Tasks list | VERIFIED | `buildDashAttentionModel`, `onDashV2AttnClick` and the Tasks chips in js/brewpad.js. Staging UAT showed 11 and 1, matching the lists. |
| A2 | Past-schedule batches are flagged (grace > 14, no-plan excluded, amber, "N days past plan") | VERIFIED | `dashPastPlanDays`. D-10 gate PASS on prod: 6 of 40, 0 mismatches. |
| A4 | Ready-to-bottle batches with no invite sent are counted (inviteSentIds, staff/family excluded) | VERIFIED | batch-pg-read.js `inviteSentIds`, the model and the drill banner. |
| A5 | The waitlist chip shows the Waiting count and taps through to Waiting | VERIFIED | `_dashWaitlist` and `_waitlistFilter='waiting'`. Staging showed 7 of 7. |
| Row | The Needs attention row leads Today and shows an all-clear line when nothing is due | VERIFIED | The `bp-dash-v2-attn` slot and the empty copy. Owner approved on the iPad. |

## Notes (non-blocking)
- **planned_days source:** `planned_days` is `max(batch_tasks.day_offset)`, not the schedule_snapshot maximum. The two were proven equivalent on production data (D-10 PASS).
- **Code review:** 98-REVIEW.md has warnings WR-01 to WR-03, all advisory.
- **Live Send Invite not run:** the count drop after a live Send Invite was not tested, because it sends a real email. Unit tests cover it.
- **UTC boundary:** the "This Week" Tasks boundary still uses UTC. This is a follow-up from 98-03.
- **Requirement IDs:** A-IDs are tracked in 98-CONTEXT.md and .planning/research/brewpad-dashboard-v2.md, not in REQUIREMENTS.md.
- **Deployment:** staging only. The production release is pending.
