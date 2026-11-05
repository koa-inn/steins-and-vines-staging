# Phase 98: Dashboard alerts and quick wins - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-05
**Phase:** 98-dashboard-alerts-and-quick-wins
**Areas discussed:** Which alerts to keep, Needs attention counts, Stale batch rule, Waitlist & invite tiles

---

## Which alerts to keep

| Question | Options | Selected |
|----------|---------|----------|
| A3 vessel conflict | Strike A3 / No-vessel alert only / Over-capacity alert | Strike A3 |
| A4 invite not sent | Count + filter / Separate tile and list / Strike A4 | Count + filter |
| A1, A2, A5 | Keep all three / A1+A2 only / A1 only | Keep all three |

---

## Needs attention counts

| Question | Options | Selected |
|----------|---------|----------|
| Which counts | Overdue / Due today / Stale (A2) / Invite not sent (A4) | All four |
| Placement | Top of Today / Under KPI tiles / Inside KPI row | Top of Today |
| Tap target | Filtered list / Scroll on dashboard | Filtered list |
| Staff batches | Include / Exclude | Include |
| Tasks tab landing | Add filter chips / Temporary filter + banner | Add filter chips |
| Empty state | One short line / Hide the row | One short line |

**Notes:** Tasks tab had no Overdue/Due today filter (only To Do, All, Transfers, Packaging), so the tap target needed one.

---

## Stale batch rule

Data shown (production, 2026-11-05, counts only): 40 active, plan length 27–56 d (median 45), 1 with no schedule; past plan by any 12, +7 d 8, +14 d 6, +30 d 6; flat 90 d 6.

| Question | Options | Selected |
|----------|---------|----------|
| Grace | 14 days past plan / 7 days / any day | 14 days past plan |
| Plan length | Last schedule step / Packaging step day | Last schedule step |
| No schedule | Leave out / Fall back to 90 days | Leave out |
| Wording | Neutral + days over (amber) / Warning style (red) | Neutral + days over |

---

## Waitlist & invite tiles

| Question | Options | Selected |
|----------|---------|----------|
| Waitlist number | Waiting count / Waiting + contacted | Waiting count |
| Tile placement | In Needs attention / KPI tile row | In Needs attention |
| Invite rule | Ready, has email, never sent / Also count no-email | Ready, has email, never sent |
| Staff invites | Exclude staff / Include | Exclude staff |

---

## Claude's Discretion

- Chip order, styling, Tasks-tab chip copy (neutral).
- Client-side counts vs adding to the Phase 94 stats endpoint, with no N+1 or extra Zoho calls.

## Deferred Ideas

- A3 vessel conflict alert (struck); over-capacity alert (not chosen).
- Close todo recipe-og-target-fg-capture.md (resolved by Phase 97).
