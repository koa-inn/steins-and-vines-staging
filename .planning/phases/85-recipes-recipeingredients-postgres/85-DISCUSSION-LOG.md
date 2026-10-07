# Phase 85: Recipes + RecipeIngredients → Postgres - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-07
**Phase:** 85-recipes-recipeingredients-postgres
**Areas discussed:** Sheet side during dual, Two people editing at once, Proving prices match, When it's safe to switch

---

## Sheet side during dual

| Option | Description | Selected |
|--------|-------------|----------|
| Copy the saved recipe | Postgres saves; finished recipe + ingredients written onto the sheet; verify check compares | ✓ |
| Re-run the real sheet save and compare | Apps Script repeats the save independently (gift-card style); stronger proof, reintroduces slow sheet saves | |

**User's choice:** Copy the saved recipe

| Option | Description | Selected |
|--------|-------------|----------|
| Save succeeds, retry + alert | Postgres has the recipe; sheet write retried in background; persistent failure alerts | ✓ |
| Block the save | Staff see an error and retry; sheet strictly in step | |

**User's choice:** Save succeeds, retry + alert

---

## Two people editing at once

| Option | Description | Selected |
|--------|-------------|----------|
| Reject it: 'changed — reload' | Out-of-date save rejected, nothing overwritten | ✓ |
| Last save wins (as today) | Later save overwrites | |

**User's choice:** Reject it: 'changed — reload'

---

## Proving prices match

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, check every sale | Price each real kiosk recipe sale on both stores during dual; alert on difference | ✓ |
| Tests only | Parity tests + verify check only | |

**User's choice:** Yes, check every sale

| Option | Description | Selected |
|--------|-------------|----------|
| Charge the Postgres price + alert | Sale proceeds at the authoritative price; Sentry alert | ✓ |
| Stop the sale | Block recipe sales until the mismatch is fixed | |

**User's choice:** Charge the Postgres price + alert

---

## When it's safe to switch

| Option | Description | Selected |
|--------|-------------|----------|
| 7 days + each action once, test recipe OK | ≥7 days; create, edit w/ ingredient change, delete, kiosk sale, public list; scripted test recipe allowed | ✓ |
| 7 days, real activity only | Only real edits/sales count | |

**User's choice:** 7 days + each action once, test recipe OK

| Option | Description | Selected |
|--------|-------------|----------|
| After gift cards switch fully | Build/test on staging now; production dual only after gift cards are postgres-only | ✓ |
| As soon as it's ready | Overlap two production dual windows | |

**User's choice:** After gift cards switch fully

---

## Claude's Discretion

- Table/column design, indexes, sequences (within locked constraints)
- Recipe cache (`sv:recipes`) and bust-cache handling in postgres mode
- Mirror + verify structure (reuse Phase 84 patterns)
- Delete semantics: keep today's behaviour
- Whether dual list/detail reads also compare against the sheet
- Plan breakdown, tests, runsheet

## Deferred Ideas

None.
