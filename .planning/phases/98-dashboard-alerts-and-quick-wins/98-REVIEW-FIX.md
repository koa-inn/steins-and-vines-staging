---
phase: 98
fixed_at: 2026-11-05T00:00:00Z
review_path: .planning/phases/98-dashboard-alerts-and-quick-wins/98-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 98: Code Review Fix Report

**Source review:** .planning/phases/98-dashboard-alerts-and-quick-wins/98-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3
- Fixed: 3
- Skipped: 0

Regression tests for all three are in the new file `tests/frontend/brewpad-dashboard-v2-review-fixes-98.test.js`. Each was run against the unfixed code first and failed (WR-01, WR-02 and the WR-03 retry tests). The sync-throw WR-03 test passed before the fix too, because the mocked fetch throw is converted to a rejection and never reaches the catch block. That test is a guard, not a reproduction. Root and middleware suites and lint passed before each commit. Nothing was pushed.

## Fixed Issues

### WR-01: Task filter set by a chip tap persists

**Files modified:** `js/brewpad.js`, `js/brewpad.min.js`, `brewpad.html` (cache-bust stamp), `tests/frontend/brewpad-dashboard-v2-review-fixes-98.test.js`
**Commit:** 0eb151e6
**Applied fix:** `handleTabBarClick('tasks')` resets `_taskFilter` to 'incomplete'. Chip taps call `switchTab` directly, so they still land on Overdue or Due today.
**Undated-tasks claim:** No change. `dashTodayTaskRows` (dashboard counts) and the Overdue filter both require a due date, so they agree.

### WR-02: Task counts can be truncated by the get_tasks_upcoming row cap

**Files modified:** `js/brewpad.js`, `js/brewpad.min.js`, `brewpad.html`, test file
**Commit:** c17d844b
**Applied fix:** New `_upcomingTruncated` flag, set at each fetch site (length >= 200 for the eager load and loadTasks, >= 100 for the dashboard refresh). The Overdue and Due today chips show `(N+)`, and their aria text says "at least N". No server changes.

### WR-03: Waitlist chip failure path in ensureDashWaitlist

**Files modified:** `js/brewpad.js`, `js/brewpad.min.js`, `brewpad.html`, test file
**Commit:** 05a49b8f
**Applied fix:** The catch path now calls `settle({ state: 'failed' })`. A failed fetch is retried at most once per dashboard load, on a later render. The re-render that `settle` itself triggers is skipped via a `skipNext` flag. Total waitlist calls per load are capped at 2.
**Requires human verification:** This is state-handling logic (the retry and `skipNext` flags).

---

_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
