# Phase 85: Recipes + RecipeIngredients → Postgres - Context

**Gathered:** 2026-10-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Move the `Recipes` and `RecipeIngredients` sheets into Postgres (`recipes`, `recipe_ingredients`)
behind the existing `RECIPES_STORE` flag (`sheets` | `dual` | `postgres`), so a recipe save —
ingredient rewrite included — is one transaction with stable ingredient IDs, and every kiosk
recipe pricing and unit rule that protects customers today is proven unchanged.

In scope (ROADMAP Phase 85 / DB-04): both tables together; `ingredient_id` as the sole ingredient
key with NO `unique (recipe_id, item_id)` (`SV-R-000002` has three same-item rows that must
backfill intact); `SV-R-`/`RI-` IDs kept and sequence-backed; `routes/recipes.js` list/detail/
availability/create/update/delete, public `/api/recipes` (`ferment_days` preserved),
`routes/pos-recipe.js` pricing (`get_recipe` call sites) and the admin recipe editor all honouring
`RECIPES_STORE`; parity tests; backfill; dual ≥1 week; flip; recipe rename < 2 s on production.

Out of scope: FermSchedules/Vessels/Config (Phase 86 — `schedule_id` stays a plain column, no FK);
Batches (Phase 87 — batches keep their own `recipe_snapshot`); any new recipe features.

</domain>

<decisions>
## Implementation Decisions

### Carried forward from Phases 83/84 (already decided — do not re-open)
- `RECIPES_STORE` is a Railway env var only (`lib/store-flag.js` already lists it); invalid value
  refuses to boot; unset = `sheets`.
- The sheet mirror is production-only and not overridable; staging has no sheet leg (Phase 83 D-07,
  `lib/sheet-mirror.js`). It is permanent on production (milestone decision).
- Discrepancies are reported through `lib/dual-write-compare.js` → Sentry (Phase 83 D-08).
- Backfill: owner-downloaded `.xlsx`, run from the owner's Mac over the Railway tunnel, rejects
  block promotion, PII files never committed, `--file=PATH` equals-form flags, DB-name prompt on
  promote (Phase 83 D-09..D-13; Phase 84 tooling and runbook).
- Deploy-time migrations additive only (Phase 83 D-04).
- In `dual`, **Postgres is authoritative** for reads and writes; on a discrepancy the business
  keeps running and Sentry alerts; each discrepancy is recorded as *explained* or *bug*; a bug fix
  restarts the window; no auto-rollback (Phase 84 D-01/D-03 pattern).
- Production cutover is after hours with a read-only verify script before opening (Phase 84 D-15).
- When any store is `dual`/`postgres`, `database:false` fails the gated-deploy smoke check
  (Phase 84 D-10).

### Sheet side during dual
- **D-01:** In `dual`, Postgres performs the save; the **finished recipe + its ingredient rows are
  then copied onto the sheet** (state copy), rather than re-running Apps Script's
  `create_recipe`/`update_recipe`/`delete_recipe` logic. The Phase 79 rewrite rules (D-04 skip-when-
  unchanged, D-09 id-honouring) only need to be correct in the Postgres path. Nothing else in Apps
  Script reads the recipe tabs (verified 2026-10-07: only the recipe CRUD functions reference
  `RECIPES_SHEET_NAME`/`RECIPE_INGREDIENTS_SHEET_NAME`), so the sheet is a human-readable backup.
  Agreement is proven by the verify script (and D-05's live price check), not by per-save
  re-execution. Needs new Apps Script mirror action(s) + a redeploy (record rollback version).
- **D-02:** If the sheet copy fails (Apps Script busy, lock timeout, unreachable), the **save still
  succeeds** for the user; the mirror write is retried in the background, and a persistent failure
  raises a Sentry alert and is caught by the verify script. A sheet problem must never block a
  recipe edit.

### Two people editing the same recipe
- **D-03:** A save from an **out-of-date editor is rejected** with a clear message ("this recipe was
  changed since you opened it — reload to see the latest") and overwrites nothing. Applies to
  update and delete. Mechanism (e.g. `updated_at`/version check sent by the admin editor) is the
  planner's choice; the admin editor must surface the message and offer a reload.
- **D-04:** In `sheets` mode, behaviour stays exactly as today (last save wins) — D-03 is a
  Postgres-path guarantee and must not change `sheets` behaviour.

### Proving prices match
- **D-05:** During `dual`, **every real kiosk recipe quote/sale is priced on both stores** (Postgres,
  and the recipe as read back through the sheet path) and any difference is reported via
  `dual-write-compare` → Sentry. This is in addition to, not instead of, the parity tests (DB-04:
  Phase 73 unit guard, Phase 79 D-04 change comparison and D-09 id-honouring identical on
  Postgres; a kiosk recipe sale prices identically on both stores).
- **D-06:** If the two prices differ during a sale, the **sale charges the Postgres price** and
  Sentry alerts for same-day investigation. The comparison must never block or delay the sale
  (fire-and-forget; a sheet-side failure is not a price mismatch).

### When it's safe to switch
- **D-07:** Flip bar: **≥7 consecutive days in `dual`** AND at least one real-or-scripted instance of
  each action — **create, edit with an ingredient change, delete, kiosk recipe sale, public recipe
  list/detail** — with **zero unexplained discrepancies**. A scripted test recipe (created,
  edited, sold, deleted, then cleaned up) may cover any action not seen naturally; the plan provides
  the runsheet. The owner decides the flip.
- **D-08:** **Production dual for recipes starts only after gift cards have flipped to
  `postgres`** (one production dual window at a time). Phase 85 may be built, tested and fully
  rehearsed on staging (including staging `dual`) while Phase 84's window runs.

### Claude's Discretion
- Table/column design, types, indexes and sequences (within the locked constraints: `ingredient_id`
  sole key, no `unique (recipe_id, item_id)`, IDs unchanged and sequence-backed, `schedule_id` and
  `pricing_mode` columns preserved).
- Caching: whether `sv:recipes` / `sv:recipes:ts` and `/api/recipes/bust-cache` stay, change or go
  in `postgres` mode — subject to the rename-under-2 s criterion and public API shape unchanged.
- How the state-copy mirror and the verify script are structured (reuse Phase 84 patterns).
- Recipe delete semantics: keep today's behaviour (no new soft-delete/archive design).
- Whether `dual`-mode list/detail reads also run a sheet-read comparison.
- Plan/wave breakdown, test layout, runsheet wording.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` — Phase 85 section (goal, success criteria 1–4) and the v4.9 milestone overview
- `.planning/REQUIREMENTS.md` — DB-04

### Patterns to reuse (Phase 83/84)
- `.planning/phases/84-giftcards-postgres/84-CONTEXT.md` — dual/flip/discrepancy/cutover decisions this phase inherits
- `.planning/phases/84-giftcards-postgres/84-RESEARCH.md` and `84-PATTERNS.md` — store facade, dual-write compare, backfill/verify tooling patterns
- `.planning/phases/84-giftcards-postgres/84-DUAL-LOG.md` — dual-window log format (op coverage, discrepancy classification, flip block)
- `.planning/phases/84-giftcards-postgres/84-11-SUMMARY.md` — production cutover lessons (`--file=` syntax, tunnel in owner's terminal, proxy-addr audit gate)
- `docs/RUNBOOK.md` — Phase 83 (Railway Postgres, tunnel, backups) and Phase 84 (cutover/dual/flip/rollback) sections
- `zoho-middleware/scripts/backfill/README.md` — backfill CLI procedure

### Pricing/unit rules that must be proven unchanged
- `.planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-CONTEXT.md` — D-04 (skip rewrite when unchanged) and D-09 (ingredient id stability)
- Phase 73 (recipe pricing unit bug) — `zoho-middleware/lib/recipe-scaling.js` unit classification/guard (`classifyUnit`, non-convertible pair fails closed)
- Memory note: recipe pricing unit bug (~20x overcharge) — why D-05 exists

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `zoho-middleware/lib/store-flag.js`: already lists `RECIPES_STORE`.
- `zoho-middleware/lib/sheet-mirror.js`: production-only mirror gate.
- `zoho-middleware/lib/dual-write-compare.js`: discrepancy reporting (`[dual-write] <store>.<op>` warning + Sentry).
- `zoho-middleware/lib/gift-card-store.js` / `gift-card-pg.js`: the facade + Postgres-module shape to copy for a `recipe-store.js`.
- `zoho-middleware/scripts/backfill/` (`backfill.js`, `gift-cards-backfill.js`, `gift-cards-verify.js`, `read-xlsx.js`, `normalize.js`, `specs/`): backfill/verify tooling to extend with a recipes spec.
- `zoho-middleware/lib/db.js`, `migrations/` (node-pg-migrate, additive-only guard + allowlist).

### Established Patterns
- Sheet schema (`apps-script/adminApi.gs` ~4560–4590): `Recipes` 17 columns (`recipe_id, name, style, description, status, locked_price, service_fee, materials_fee, batch_size_l, abv, ibu, colour_srm, notes, created_at, created_by, updated_at, pricing_mode`) plus a later `schedule_id` column (`ensureRecipesScheduleIdColumn`); `RecipeIngredients` 6 columns (`ingredient_id, recipe_id, item_id, item_name, quantity, unit`).
- `updateRecipe` (adminApi.gs ~4192) carries the Phase 79 D-04/D-09 rewrite logic and a 5 s script lock; `create_recipe`, `update_recipe`, `delete_recipe`, `get_recipe(s)` are the Apps Script actions.
- `ferment_days` is derived in the middleware (`enrichFermentDays`, `routes/recipes.js` ~371) from `recipe.schedule_id` + FermSchedules (still on Sheets) — the recipes store only has to carry `schedule_id`.
- Public recipe fields are allow-listed (`PUBLIC_RECIPE_FIELDS`, `routes/recipes.js` ~76).

### Integration Points
- `zoho-middleware/routes/recipes.js` — GET list/detail/availability, POST/PUT/DELETE, bust-cache (Redis `sv:recipes`, `sv:recipes:ts`).
- `zoho-middleware/routes/pos-recipe.js` — `get_recipe` at ~168 (`computeRecipeQuote`) and ~721 (recipe sale confirm).
- `js/admin.js` recipe editor (~8299–8600: `loadRecipeList`, `openRecipeDetail`, `populateRecipeForm`, save) — needs the D-03 stale-save message; also `scheduleIdForRecipe`/`countRecipesUsingSchedule`.
- Batches store `recipe_id` + `recipe_snapshot` at sale time (no live read of the recipe tabs).

</code_context>

<specifics>
## Specific Ideas

- `SV-R-000002` (three rows for the same item) is the canonical backfill fixture.
- The live price check (D-05) exists because recipe pricing has caused a real customer overcharge
  before (Phase 73) — it should be loud, not sampled.
- Staging and production share the Zoho org and Helcim token: scripted test recipe sales on either
  environment land in the live books and need cleanup (as with INV-000229).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Pending todos matched only on generic keywords;
none concern recipes, so none were folded or reviewed.)

</deferred>

---

*Phase: 85-recipes-recipeingredients-postgres*
*Context gathered: 2026-10-07*
