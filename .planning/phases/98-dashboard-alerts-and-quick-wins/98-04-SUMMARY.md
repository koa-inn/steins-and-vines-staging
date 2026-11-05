---
phase: 98-dashboard-alerts-and-quick-wins
plan: 04
subsystem: brewpad-frontend
tags: [dashboard, needs-attention, waitlist, invite]
requires: ["98-02", "98-03"]
provides:
  - "Needs attention chip row in the v2 Today lead slot (#bp-dash-v2-attn), widget t0"
  - "dashV2AttentionModel() for plan 98-05 tap handling; data-attn keys on real buttons"
  - "_dashWaitlist / _dashInviteSent state and test seams"
affects: [98-05, 98-06]
key-files:
  modified: [js/brewpad.js, js/brewpad.min.js, css/brewpad.css, css/brewpad.min.css, brewpad.html]
  created: [tests/frontend/brewpad-dashboard-v2-attention.test.js]
key-decisions:
  - "Warn chip text is --ink-primary (amber text fails contrast); amber kept via border and tint"
  - "Only the waitlist integer count is retained in dashboard state"
  - "Waitlist loading or failed renders nothing extra (no all-clear, no new copy)"
requirements-completed: [A1, A2, A4, A5]
duration: 25min
completed: 2026-11-05
---

# Phase 98 Plan 04: Needs attention row Summary

Today section on ?dash=v2 now opens with a Needs attention chip row (Overdue, Due today, Past schedule, Invite not sent, Waitlist waiting) built from the 98-02 model, with a lazy once-per-load get_waitlist count and an in-session invite-sent override that decrements the invite chip without a refetch.

## Commit
- `f7a6d7a5` feat(98-04): Needs attention row at the top of Today (A1, A2, A4, A5) (single commit for the three tasks; Task 3 is build and verify)

## What changed
- `lead: 'bp-dash-v2-attn'` on the today section; `dashV2SectionsHtml` emits the lead div between head and grid (grid children unchanged).
- Widget `t0` first in DASH_V2_WIDGETS; `renderDashV2Attention` catches its own errors and never builds a `.bp-widget` shell.
- `ensureDashWaitlist` mirrors the ensureDashCalData token pattern; a malformed payload is treated as failed.
- Invite success callbacks (dashboard widget and detail pane) set `_dashInviteSent[id]` and rerender t0. No new send path or button.
- CSS: `.bp-attn*` block, tokens only, 44px chips.
- Tick refresh needed no code: existing handler ends in loadDashboard, which re-renders v2.

## Verification
Root `npm test` (3438), middleware `npm test` (4055), `npm run lint` green. Today and production v2 tests pass unmodified. Build restamps of unrelated files reverted.

## Deviations from Plan
- Tick test simulates the handler's post-save state (task marked done + dashboard re-render) rather than driving the change handler through its 300 ms debounce and loadDashboard.
- Waitlist-failed test uses an HTTP 500 response, because a rejected fetch goes through fetchWithRetry backoff and would not settle in test time.

## Known Stubs
None. Chips are real buttons with no click behaviour yet; plan 98-05 wires taps (intentional per plan).

## Self-Check: PASSED
