# Phase 97: Beer and cider dashboard sections - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-03 (started 2026-10-30)
**Phase:** 97-beer-and-cider-dashboard-sections
**Areas discussed:** Packaging calendar source, Beer card OG/target FG, Packaging output and cider, Restored lists and layout

---

## Approval and todos

| Option | Description | Selected |
|--------|-------------|----------|
| Approve all of Phase D | Beer card/section, cider section, packaging calendar | ✓ |
| Approve part of it | Drop some parts | |
| Not now | Park Phase 97 | |

**Todos folded:** Restore Pending tasks + Ready to bottle; Wire beer packaging Cal.com type; Ready to Bottle filter on Batches (Claude had suggested keeping the filter separate; the owner folded it in).

---

## Packaging calendar source

| Option | Description | Selected |
|--------|-------------|----------|
| Both | Cal.com bookings + BrewPad packaging tasks marked "not booked yet" | ✓ |
| Cal.com bookings only | Only real appointments | |
| BrewPad packaging tasks only | No new integration | |

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-match by customer email | Unmatched bookings labelled "no batch matched" | ✓ |
| No linking | Side by side | |
| Staff link by hand | New write path | |

| Option | Description | Selected |
|--------|-------------|----------|
| List grouped by day | Today, Tomorrow, dated days | ✓ |
| Week grid | Two 7-day columns | |

| Option | Description | Selected |
|--------|-------------|----------|
| Leave undated tasks to Ready to bottle | Calendar shows dated items only | ✓ |
| "No date yet" strip | Under the calendar | |

---

## Beer card: OG / target FG

| Option | Description | Selected |
|--------|-------------|----------|
| Add to beer recipes | Recipe editor fields, copied to snapshot; fills G8 expected curve | ✓ |
| Enter per batch | Staff type per batch | |
| Skip targets for now | Latest reading, ABV, IBU only | |

| Option | Description | Selected |
|--------|-------------|----------|
| Next open task + due date | Uses real tasks; temperature steps highlighted | ✓ |
| Step by day count | Derived from schedule | |

| Option | Description | Selected |
|--------|-------------|----------|
| "No readings yet" | Neutral wording | ✓ |
| Hide the line | Cleaner card | |

---

## Packaging output and cider

| Option | Description | Selected |
|--------|-------------|----------|
| Estimate only | 25 L per 28 L brew, litres + approximate cans | ✓ |
| Record actual at packaging | New write path | |

| Option | Description | Selected |
|--------|-------------|----------|
| Show both can sizes | ≈ 52 × 473 mL or 70 × 355 mL | ✓ |
| 473 mL only | Simpler | |

| Option | Description | Selected |
|--------|-------------|----------|
| From recipe ingredients | Yeast/juice by type, name fallback | ✓ |
| New cider fields on the recipe | Dedicated fields | |

| Option | Description | Selected |
|--------|-------------|----------|
| Same card, cider lines | Shared card; G8 chart reused for curve | ✓ |
| Simpler cider list | One row per batch | |

---

## Restored lists and layout

| Option | Description | Selected |
|--------|-------------|----------|
| Today's tasks + Ready to bottle | Needs attention left to Phase 98 | ✓ |
| Also Needs attention as-is | Restore the classic block too | |

| Option | Description | Selected |
|--------|-------------|----------|
| New "Today" section at the top | Amends Phase 96 "Production first" | ✓ |
| Below the charts | Keeps Production first | |

| Option | Description | Selected |
|--------|-------------|----------|
| Ignore filters | To-do lists always show everything due | ✓ |
| Type filter only | | |
| All filters | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Own section, short empty line | Beer & cider after Floor today; hidden when Type = Wine | ✓ |
| Only show when batches exist | | |

---

## Claude's Discretion

- Card and calendar visual details (UI spec), Cal.com cache TTL and email-matching rule, recipe OG/FG field names and migration shape, can rounding.

## Deferred Ideas

- Recording actual packaged output; beer/cider card in the batch detail pane; Cal.com slug and wine appointment rename; Cal.com duration ladder question.
