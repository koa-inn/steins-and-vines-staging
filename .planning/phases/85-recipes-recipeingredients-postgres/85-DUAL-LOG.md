# Phase 85 — Recipes Dual-Window Log

Owner-maintained log for the `RECIPES_STORE=dual` window (D-01/D-02/D-05/D-07). See
`docs/RUNBOOK.md` § "Recipes → Postgres (Phase 85)" for the full procedure this log supports.
No secrets, no names, no recipe values: recipe ids, ingredient ids and classifications only.

## Header

| Field | Value |
|-------|-------|
| Environment | production |
| `RECIPES_STORE=dual` set at | |
| Window day 1 date | |
| Current window start (resets to day 1 on any bug-classified discrepancy) | |

## Op-coverage table

One row per op. "First seen at" is the first time the op ran (real traffic or the RUNBOOK §7
scripted test-recipe runsheet) during the CURRENT window. "Sentry clean?" is yes only if zero
unexplained discrepancies were raised for that op during the current window.

| Op | First seen at | Real or scripted | Sentry clean? |
|----|----------------|-------------------|----------------|
| create | | | |
| edit with ingredient change | | | |
| delete | | | |
| kiosk recipe sale | | | |
| public list / detail | | | |
| rename < 2 s (SC4 stopwatch) | | | |

## Discrepancy table

One row per Sentry `[dual-write] recipes.*` event, `recipes-mirror` error or manually found
`recipes-verify.js` mismatch. Every row must be classified before the flip bar can be met.

| Date/time | Sentry link | Op | Recipe id | Classification (explained/bug) | Root cause | Fix commit | Window restarted? |
|-----------|--------------|----|-----------|----------------------------------|-------------|-------------|--------------------|
| | | | | | | | |

## D-05 compare coverage

One row per window day. Counts come from Railway logs: `[dual-price] compared` and
`[dual-price] skip` lines (split by `reason=settle` / `reason=dirty`), or the latest running
totals.

| Date | compared | skipped settle | skipped dirty | sheet fetch failures | `recipes-dual-price` stale-dirty warnings | notes |
|------|----------|----------------|---------------|----------------------|--------------------------------------------|-------|
| | | | | | | |

## Explained differences (known up front)

Copy of RUNBOOK §12.

- A missing recipe detail returns 404 in Postgres modes (Sheets returned 200 with an error object).
- Postgres serves current data where Sheets could serve up to 300 s stale.
- Ids are never reused after deleting the highest id.
- SV-R-000001 sorts last after its cell fix.
- Invalid status / NaN numerics now return 422 instead of being stored.
- Invalid ingredients JSON writes nothing (Sheets wrote the row fields first).
- D-05 skips within 60 s of an edit are logged, not compared.
- Delete TOCTOU: a batch created between the `recipe_batch_ref_count` check and the Postgres delete
  is not seen; the batch keeps a dangling `recipe_id` until Phase 87 (log as explained).

## Flip-decision block

Filled in once the flip bar (at least 7 consecutive days, all ops in the Op-coverage table
observed, zero unexplained discrepancies) is met and the owner decides to flip to `postgres`.

| Field | Value |
|-------|-------|
| Owner | |
| Date | |
| Decision | |

## Staging rehearsal

## Production prerequisites

## Production cutover

## Post-flip verification

---
*Phase: 85-recipes-recipeingredients-postgres*
*Template created: 2026-10-07 (Plan 85-11)*
