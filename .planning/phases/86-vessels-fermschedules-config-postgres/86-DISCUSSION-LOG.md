# Phase 86: Vessels + FermSchedules + Config → Postgres - Discussion Log

**Date:** 2026-10-07
**Phase:** 86-vessels-fermschedules-config-postgres
**Areas discussed:** Staff Access screen, Vessels screen, Rollout and dual windows, Ferm schedules behaviour
**Todo folded:** Restore staff attribution on admin writes (admin-write-attribution-kiosk-middleware.md)

---

## Staff Access screen

| Question | Options | Selected |
|----------|---------|----------|
| Where the list lives | Postgres + env break-glass / Postgres only / Keep the env var | Postgres + env break-glass |
| Who may edit | Owner accounts only / Any signed-in staff | Owner accounts only |
| Safeguards (multi) | Can't remove yourself / Can't remove last owner / Removal ends sessions now / Audit log | All four |
| Config `staff_emails` row | Retire it / Keep it in sync | Retire it |

## Vessels screen

| Question | Options | Selected |
|----------|---------|----------|
| Location | Admin tab / BrewPad / Both | Admin tab |
| Editable fields (multi) | Name/label / Shelf + bin / Type/capacity / Status override | All four |
| Retire | Archive only / Archive, delete if never used | Archive only |
| Vessel ID changeable | No, fixed / Yes, with cascade | No, fixed |

## Rollout and dual windows

| Question | Options | Selected |
|----------|---------|----------|
| Windows | One window, all three / Staff list separate / Three separate | One window, all three |
| Mirror staff list to sheet | No, never / Emails only | No, never |
| Flip bar | ≥7 days / ≥3 days | ≥7 days |
| Overlap with recipes window | No, keep the queue / Yes | No, keep the queue |

## Ferm schedules behaviour

| Question | Options | Selected |
|----------|---------|----------|
| Propagate partial failure | Keep save, list failures + Retry / Roll back | Keep save, list failures + Retry |
| Delete a referenced schedule | Block, offer archive / Delete and clear references | Block, offer archive |
| Stale-save protection for vessels + schedules | Yes, same as recipes / No | Yes |

## Claude's Discretion
Table/column design, sequences, migration naming, store module layout, mirror payloads, admin tab layout, role representation.

## Deferred Ideas
- Remove dead Apps Script staff-email check + Config row: Phase 88.
- Vessel editor in BrewPad: not now.
