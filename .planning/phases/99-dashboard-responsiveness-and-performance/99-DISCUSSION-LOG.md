# Phase 99: Dashboard responsiveness and performance - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-06
**Phase:** 99-dashboard-responsiveness-and-performance
**Areas discussed:** Switching to v2 as default, Speed targets & measuring, Phone & desktop layout, Accessibility pass scope

---

## Switching to v2 as default

| Question | Options | Selected |
|---|---|---|
| What happens to classic v1? | Keep fallback, remove later / Remove v1 now / Keep v1 indefinitely | Keep fallback, remove later |
| What counts as sign-off? | Staging UAT + iPad check / Trial week / Flip immediately | Staging UAT + iPad check |
| Devices that chose classic? | Everyone moves to v2 once / Respect earlier choices | Everyone moves to v2 once |
| How long does the fallback stay? | Until owner says / ~2 weeks / ~1 month | Until owner says |

## Speed targets & measuring

| Question | Options | Selected |
|---|---|---|
| Where to measure? | Shop iPad + Lighthouse / Lighthouse lab only / Both must pass | Lighthouse lab only |
| Stale-first rendering? | Yes with "as of" hint / Yes except Needs attention / No, always fresh | Yes with "as of" hint |
| How to run Lighthouse? | Local build + recorded data / Staging in signed-in Chrome / Both | Local build + recorded data |
| Max cache age? | Same day only / Any age / Within 1 hour | Same day only |

Claude's note: the recorded data fixture is anonymized before it is committed (privacy default).

## Phone & desktop layout

| Question | Options | Selected |
|---|---|---|
| Phone section order? | Action first / Same as desktop / KPIs first | Action first |
| Collapse chart sections on phones? | Collapsed by default on phones / Always expanded + lazy / Collapsible everywhere, remembered | Collapsed by default on phones |
| Desktop columns? | 3 from ~1200px / Up to 4 / Stay at 2 | 3 from ~1200px |
| Touch tooltips? | Tap to show, tap away to hide / Keep current | Tap to show, tap away to hide |

## Accessibility pass scope

| Question | Options | Selected |
|---|---|---|
| Strictness? | Targeted + automated check / Full WCAG 2.2 AA / Only the handoff's three items | Targeted + automated check |
| Non-colour series signals? | Direct labels + distinct markers / Hatched patterns / Rely on table view | Direct labels + distinct markers |

## Claude's Discretion
- Technical speed levers (deferring jspdf/qrcode, script defer, bundle split, skeleton design)
- "As of" hint copy and placement; collapsed header copy
- Cache key and storage for the cached-first render

## Deferred Ideas
- Remove v1 dashboard code (owner-triggered backlog todo)
- Real-device iPad timing (not chosen)
