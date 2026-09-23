---
phase: 82-store-agnostic-prerequisites
plan: 01
subsystem: planning
tags: [owner-checks, migration-sizing, sheets, railway]
requires: []
provides: [owner-check-answers]
affects: [83, 84, 85, 86, 87, 88]
key-files:
  created: [.planning/phases/82-store-agnostic-prerequisites/82-01-SUMMARY.md]
  modified: []
duration: n/a (owner data collection)
completed: 2026-09-23
---

# Phase 82 Plan 01: Owner Pre-Migration Checks Summary

Owner-only checks (D-20, D-03) recorded so Phases 83-88 can size formula carry-over, backfills and backup strategy. Items 1, 4 and 5 were read directly from the production workbook ("STEINS AND VINES", `10BzcANc_…1JrM`) via the Google Drive connector and a read-only Chrome session (formula view toggled on and back off; no cells edited). Items 2 and 3 came from the owner. Counts and error classes only — no customer data recorded (T-82-01-01).

## Owner Check Answers

| # | Check | Answer | Source surface | Date checked |
|---|-------|--------|----------------|--------------|
| 1 | Formulas / named ranges / pivots / charts | **Formulas only on `Kits`** (see below); owner confirms every other tab is plain values. **No named ranges, no pivot tables, no charts.** | Owner + Chrome (Kits formula view) | 2026-09-23 |
| 2 | Apps Script Executions — failures | **2 failed in the last 7 days** — both `keepWarm` (time-driven), Sep 18 and Sep 20 2026, each ran ~1,920 s then ended with Google's generic "We're sorry, a server error occurred". `keepWarm` is a no-op (`return true;`, `apps-script/adminApi.gs:5780`) → Google-side infrastructure blips, not app faults. **90-day window not available** — the Executions dashboard only retains ~7 days (no linked GCP project/Cloud Logging). | Owner (script.google.com → Executions) | 2026-09-23 |
| 3 | Railway plan + Postgres backups / PITR | **Plan: Hobby (~$5/month).** Automated backups: **unconfirmed**. PITR: **unconfirmed**. Retention: **unconfirmed**. Owner requirement: *everything must stay backed up at least until the Postgres cutover has been operational for a while.* | Owner | 2026-09-23 |
| 4 | Live row count per tab | See table below | Drive export of production workbook | 2026-09-23 |
| 5 | Reservations / Holds latest activity (D-03) | **Reservations: active** — 6 rows, newest `submitted_at` 2026-09-22 (range 2026-07-10 → 2026-09-22), timeslots 2026-09-16 → 09-19, all `pending`, `last_updated` never set. **Holds: dormant** — 1 row, `created_at` 2026-02-06, still `pending`, never resolved. | Drive export | 2026-09-23 |

### Item 1 detail — Kits formulas (all per-row, same pattern rows 2..n)

| Column | Formula (row 2) | Meaning |
|--------|-----------------|---------|
| `tasting_notes` (L) | `=XLOOKUP(D2, rjs!B:B, rjs!G:G)` | Pulls tasting notes from the `rjs` supplier catalogue tab by product name |
| `abv` (V) | `=iferror(XLOOKUP($D2, rjs!$B:$B, rjs!F:F), "")` | ABV from `rjs` by name, blank if no match |
| `sweetness` (Z), `body` (AA), `oak` (AB) | `=iferror(XLOOKUP(...rjs...), "")` | Same lookup pattern into `rjs` |
| `instore_margin` (W) | `=1-(K2/H2)` | 1 − wholesale / retail_instore |
| `kit_only_margin` (X) | `=1-(K2/I2)` | 1 − wholesale / retail_kit |

`stock`, `on_hold`, `on_order`, `available` are **plain values** (not formulas), maintained by the app. Implication for the migration: the `rjs` tab is a hidden dependency of Kits (5 columns derive from it) — it must either migrate as a reference table with the joins done in SQL/code, or the looked-up values must be frozen into Kits at backfill time. The two margin columns are trivially computable.

### Item 4 detail — row counts (data rows, header excluded)

| Tab | Rows | Tab | Rows |
|-----|-----:|-----|-----:|
| Schedule | 723 | Recipes | 10 |
| VesselHistory | 310 | FermSchedules | 10 |
| vessels to export | 232 | Waitlist | 6 |
| Vessels | 225 | Reservations | 6 |
| BatchTasks | 176 | Homepage | 4 |
| RecipeIngredients | 116 | (form responses, legacy) | 4 |
| (event log: timestamp/event/sku/name) | 102 | Config | 2 |
| Kits | 81 | GiftCards | 1 |
| Batches | 73 | Holds | 1 |
| rjs (supplier wine catalogue) | 73 | GiftCardTransactions | 0 |
| PlatoReadings | 68 | | |
| Ingredients | 29 | | |
| Services | 17 | | |

Largest backfill is ~2,300 rows total — every tab is small enough for a single-transaction backfill. Tabs not referenced by `adminApi.gs` constants: `Vessels`, `vessels to export`, `Services`, `rjs`, an event-log tab (newest row 2026-04-27) and a legacy form-responses tab (newest 2026-02-06); Phase 83+ should decide per tab whether it migrates, stays, or is archived.

## Milestone Gap Noted

(D-21) The **Ingredients**, **Schedule** and **Homepage** sheets have no destination in Phases 83-88 — Phase 88 only covers Reservations/Holds/Kits and the public CSV reads. Schedule is the single largest tab (723 rows). Also unplanned: `rjs` (a live formula dependency of Kits), `Services`, `Vessels` / `vessels to export`. Needs an additive roadmap decision before Phase 88 planning.

## Follow-ups

- **Confirm Railway Hobby backup/PITR entitlement** before Phase 83 provisions Postgres; if Hobby lacks automated backups, plan either an upgrade or a scheduled `pg_dump` to durable storage, and keep the Google Sheet as the fallback source until the cutover has run clean for an agreed period (owner requirement).
- Holds tab is effectively unused since Feb 2026 → Phase 88 can likely retire the Holds half of the Reservations & Holds admin tab (owner to confirm).

## Deviations from Plan

- Item 2: 90-day window not obtainable (dashboard retention ~7 days); recorded 7-day result instead.
- Items 1/4/5 were collected by Claude via read-only Drive/Chrome access at the owner's request rather than typed in by the owner.

## Self-Check: PASSED
