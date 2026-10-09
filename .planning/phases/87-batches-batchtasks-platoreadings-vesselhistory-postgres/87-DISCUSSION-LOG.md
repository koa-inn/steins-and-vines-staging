# Phase 87: Batches + BatchTasks + PlatoReadings + VesselHistory → Postgres - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-09
**Phase:** 87-batches-batchtasks-platoreadings-vesselhistory-postgres
**Areas discussed:** Cutover window & live sales, Rollback & go/no-go, Sheet after cutover & fixes, Scope edges & ordering

---

## Cutover window & live sales

| Option | Description | Selected |
|--------|-------------|----------|
| Sunday evening after close | Most buffer before Monday open | ✓ |
| Sunday, shop closed all day | Full-day buffer if closed Sundays | |
| Late night, any weekday | Not tied to Sunday | |

| Option | Description | Selected |
|--------|-------------|----------|
| Sales go through, batches recovered after | Payment + invoice normal; Scan invoices recovers batches | ✓ |
| Queue batch creation, replay automatically | Redis queue + replay; new money-adjacent code | |
| Stop ferment-in-store sales | Disable kit sales during window | |

| Option | Description | Selected |
|--------|-------------|----------|
| Read-only with maintenance banner | Reads work; writes return maintenance message; server-side only | ✓ |
| Fully down | 503 everything | |
| You decide | Planner picks | |

| Option | Description | Selected |
|--------|-------------|----------|
| 2 hours | Room for one rollback | ✓ |
| 1 hour | Only if rehearsal < 30 min | |
| Half day | Debug inside window | |

**User's choice:** Sunday evening; sales flow + Scan-invoices recovery; read-only freeze; 2 h.

---

## Rollback & go/no-go

| Option | Description | Selected |
|--------|-------------|----------|
| Any count/parity miss or failed smoke | Strict; matches criterion 3 | ✓ |
| Only fail on blockers | Allow documented small differences | |

| Option | Description | Selected |
|--------|-------------|----------|
| Until end of Monday | Rollback retired after first business day | |
| One full week | Rehearsed rollback ready for 7 days | ✓ |
| Window only | Fix forward after window | |

| Option | Description | Selected |
|--------|-------------|----------|
| You + Claude, you call it | Claude runs steps; owner go/no-go + live smoke | ✓ |
| Claude runs it, you approve at the end | Fewer interruptions | |

| Option | Description | Selected |
|--------|-------------|----------|
| Daily verify run + replay before any rollback | Daily drift alert; replay first on rollback | ✓ |
| Replay-only at rollback time | No daily checks | |

**User's choice:** Strict bar; one-week rollback guarded by daily verify + replay-first; owner calls go/no-go.

---

## Sheet after cutover & fixes

| Option | Description | Selected |
|--------|-------------|----------|
| All four | Milestone rule; needed for rollback | ✓ |
| Batches only | Rollback loses tasks/readings/transfers | |

| Option | Description | Selected |
|--------|-------------|----------|
| Ask Claude; reviewed SQL fix | Runbook recipe, no new UI | ✓ |
| Build an admin batch-edit form | New capability, own phase | |
| Read-only SQL console in admin | Query yourself, fixes via Claude | |

| Option | Description | Selected |
|--------|-------------|----------|
| Banner + protected ranges | Same as 86 Config | ✓ |
| Note only | No protection | |

**User's choice:** Mirror all four; SQL-fix recipe; notice + protected ranges.

---

## Scope edges & ordering

| Option | Description | Selected |
|--------|-------------|----------|
| Defer: add to Phase 88 scope | Keep 87 to four tables | ✓ |
| Fold into Phase 87 | Fifth table in the window | |
| Leave Waitlist on Sheets | Permanent exception | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, after 86 flips | Transactional vessel status; one window at a time | ✓ |
| No, can overlap | More modes to handle | |

| Option | Description | Selected |
|--------|-------------|----------|
| Keep identical | Same URLs/tokens/abilities | ✓ |
| Make public page read-only | Behaviour change | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, server-side idempotency | DB-enforced dedup, no brewpad.js change | ✓ |
| Port today's guard as-is | Same rule | |

| Option | Description | Selected |
|--------|-------------|----------|
| First plan writes a design doc; you approve | 87-DESIGN.md + blocking checkpoint | ✓ |
| Research doc is enough | Approve via research/plans | |

**User's choice:** Waitlist → Phase 88; cut over after 86 flips; public page identical; idempotent create_batch; design-doc gate.

---

## Claude's Discretion

- Schema/sequence/migration/store layout and mirror payload shape
- Freeze mechanism, sheet-notice placement, dashboard-parity script shape, test-row handling, cache invalidation

## Deferred Ideas

- Waitlist → Postgres (Phase 88 or own phase)
- Admin batch-edit UI / SQL console
- Public batch page read-only
