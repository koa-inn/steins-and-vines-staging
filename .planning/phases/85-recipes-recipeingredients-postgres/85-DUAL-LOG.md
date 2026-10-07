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

- 2026-10-07: staging push `57a44b84` (`git push origin main`); staging `/health` `database:true`.
- 2026-10-07: Apps Script deployed as version 60 (rollback 59) on deployment `…DI968g`. Pre-paste
  drift hash matched the pre-Phase-85 repo file; post-paste hash matched `apps-script/adminApi.gs`.
  `GET /api/recipes` 200 with 3 active recipes on production and staging afterwards.
- 2026-10-07: owner fixed SV-R-000001 (`created_at` / `created_by` swap) in the live Recipes tab.
- 2026-10-07 19:29Z: dry run on fresh snapshot: 10 recipe rows, 117 ingredient rows read;
  plan 10 recipes / 117 ingredients; sequence seeds recipe 13, ingredient 184; **0 rejects**.
- 2026-10-07 19:34Z: staging promote (owner terminal, tunnel): 0 rejects, **promoted 10 recipes,
  117 ingredients; sequences at 13 / 184**.
- 2026-10-07: `recipes-verify.js` on the same snapshot: **verified 10 recipes, 0 mismatches**.
- 2026-10-07 19:37Z: **staging `RECIPES_STORE=dual` started** (Railway CLI, staging `sv_middleware` only).
  `/health` `database_required:true`; startup log `store modes: {GIFT_CARDS_STORE:dual, RECIPES_STORE:dual}`
  and `Recipe mirror sweep registered: every 5 minutes`.
- 2026-10-07: T-85-63 ordering: GitHub Actions "Deploy Staging (filtered)" for `57a44b84` (contains the
  `stale_recipe` / `expected_updated_at` editor bundles) completed success 19:18Z, before dual at 19:37Z.
- 2026-10-07: API parity, staging (dual, `source: postgres`) vs production (sheets, `source: apps-script`):
  `GET /api/recipes` same 3 ids, 0 differing fields per recipe; `GET /api/recipes/SV-R-000011` 0 differing fields.

### Staging UAT (85-12 Task 3), 2026-10-07, driven in Chrome by Claude with owner sign-ins

| Step | Result | Evidence |
|------|--------|----------|
| 3. Runsheet create / activate / ingredient change / rename | PASS | SV-R-000014 created; activate PUT 200 310 ms; ingredient 4 to 5 kg PUT 200 301 ms (token sent); **rename PUT 200 332 ms** |
| 1. Admin two-tab D-03 | PASS | Tab A save 200; tab B stale save showed "This recipe was changed since you opened it, reload to see the latest" + Reload; Reload showed tab A's value; API stored tab A's value only |
| 2. BrewPad D-03 (desktop Chrome, owner-approved substitute for the iPad) | PASS | BrewPad created SV-R-000015 (POST 201); admin saved a change; BrewPad stale save PUT 409 `stale_recipe` with token, single request (no auto-retry), message offered Reload and no Retry, draft kept in sessionStorage; Reload showed admin's value. Restored draft after re-login also 409s (server treats a missing/old token as stale). Test recipe deleted (DELETE 200 3.7 s, then 404). iPad Safari cookie path remains the separate Phase 76 check |
| 2b. Kiosk quick-edit | NOT RUNNABLE | Admin's kiosk recipe prompt is kiosk-core's (no Edit Recipe button); admin's quick-edit prompt is reachable only via a test hook. Pre-existing (not Phase 85); 85-09 quick-edit token logic covered by unit tests only |
| 4. Public beer page | PASS | Test recipe card shown; ready times "about 3 weeks" / "about 5 weeks" on scheduled recipes; no separate detail page; `GET /api/recipes/:id` identical to production earlier |
| 5. Kiosk quotes vs production | PASS | 8/8 identical totals and ingredient lines (SV-R-000003, SV-R-000002 x 23/46 L x in-store/take-out) |
| 6. Delete test recipe | PASS (deleted, not deactivated) | DELETE 200 4.66 s (token sent); API 404 afterwards |
| Logs | PASS | No ERROR/WARN recipe/mirror/dual lines in staging logs during UAT |

Findings outside Phase 85 scope (pre-existing):
- **Production kiosk recipe quotes 503** ("Ingredient catalog not available") observed ~20:05Z: `zoho:ingredients:all` cache empty and `routes/pos-recipe.js` has no file-cache fallback (unlike `routes/recipes.js`). Cleared when the owner opened production admin. Same gap would fail a kiosk recipe sale.
- Admin Kiosk Sale, Recipes view sticks on "Loading recipes..." although the data loaded (render not re-run).

## Production prerequisites

## Production cutover

## Post-flip verification

---
*Phase: 85-recipes-recipeingredients-postgres*
*Template created: 2026-10-07 (Plan 85-11)*
