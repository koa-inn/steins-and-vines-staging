---
phase: 98
status: issues_found
depth: standard
files_reviewed: 5
critical: 0
warning: 3
info: 3
total: 6
reviewed: 2026-11-05
diff_base: 44c54db3
---

# Phase 98 Code Review

The scope was the phase 98 diffs in js/brewpad.js, brewpad.html, zoho-middleware/lib/batch-pg-read.js and zoho-middleware/scripts/spike-past-schedule-98.js. There are no blockers. The findings below are advisory.

## Warnings

### WR-01: Task filter set by a chip tap persists
**File:** js/brewpad.js:9500 (onDashV2AttnClick), renderTasks ~14325

The chip sets `_taskFilter` to 'overdue' or 'duetoday', and nothing resets it. If staff later open Tasks from the tab bar, they land on the narrowed list (the chip is shown as active).

**Possible fix:** reset to 'incomplete' on a normal tab entry, or use a one-shot pending filter.

The reviewer also claimed that undated tasks can be counted as overdue. That is unconfirmed: the Overdue filter requires a due date by design.

### WR-02: Task counts can be truncated by the 200-row get_tasks_upcoming cap
**File:** js/brewpad.js:14285 (loadTasks)

If there are more than 200 open tasks, Due today and later tasks are cut off, and the counts are understated without any signal.

**Possible fix:** return overdue and today counts from the server, or flag the counts when `length >= limit`.

### WR-03: Waitlist chip failure path in ensureDashWaitlist
**File:** js/brewpad.js:~9451

A synchronous throw sets the state to failed without calling settle(), so there is no re-render. A failed fetch is also not retried until `_dashLoadTime` changes.

**Possible fix:** call `settle({state:'failed'})` in the catch.

## Info

### IN-01: Mixed time bases in renderTasks
`today` uses Vancouver time, but `weekEndStr` still uses UTC. This is the known 98-03 follow-up.

### IN-02: Drill sort can produce NaN for ids missing from order
**File:** ~10090 and ~10285

**Possible fix:** default the rank to a large number.

### IN-03: Spike main() has no try/catch around require/createPool
This is a dev-only, read-only tool.
