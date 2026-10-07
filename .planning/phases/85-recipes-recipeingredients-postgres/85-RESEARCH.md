# Phase 85: Recipes + RecipeIngredients → Postgres - Research

**Researched:** 2026-10-07
**Domain:** Sheets→Postgres store migration (Node/Express middleware + Google Apps Script + ES5 admin/BrewPad editors), money-path pricing parity
**Confidence:** HIGH on current code/data flow and reuse patterns (direct reads, file:line cited, real prod snapshot inspected); MEDIUM on a few design choices flagged in the Assumptions Log / Open Questions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Carried forward from Phases 83/84 (already decided — do not re-open)**
- `RECIPES_STORE` is a Railway env var only (`lib/store-flag.js` already lists it); invalid value refuses to boot; unset = `sheets`.
- The sheet mirror is production-only and not overridable; staging has no sheet leg (Phase 83 D-07, `lib/sheet-mirror.js`). It is permanent on production (milestone decision).
- Discrepancies are reported through `lib/dual-write-compare.js` → Sentry (Phase 83 D-08).
- Backfill: owner-downloaded `.xlsx`, run from the owner's Mac over the Railway tunnel, rejects block promotion, PII files never committed, `--file=PATH` equals-form flags, DB-name prompt on promote (Phase 83 D-09..D-13; Phase 84 tooling and runbook).
- Deploy-time migrations additive only (Phase 83 D-04).
- In `dual`, **Postgres is authoritative** for reads and writes; on a discrepancy the business keeps running and Sentry alerts; each discrepancy is recorded as *explained* or *bug*; a bug fix restarts the window; no auto-rollback (Phase 84 D-01/D-03 pattern).
- Production cutover is after hours with a read-only verify script before opening (Phase 84 D-15).
- When any store is `dual`/`postgres`, `database:false` fails the gated-deploy smoke check (Phase 84 D-10).

**Sheet side during dual**
- **D-01:** In `dual`, Postgres performs the save; the **finished recipe + its ingredient rows are then copied onto the sheet** (state copy), rather than re-running Apps Script's `create_recipe`/`update_recipe`/`delete_recipe` logic. The Phase 79 rewrite rules (D-04 skip-when-unchanged, D-09 id-honouring) only need to be correct in the Postgres path. Nothing else in Apps Script reads the recipe tabs (verified 2026-10-07: only the recipe CRUD functions reference `RECIPES_SHEET_NAME`/`RECIPE_INGREDIENTS_SHEET_NAME`), so the sheet is a human-readable backup. Agreement is proven by the verify script (and D-05's live price check), not by per-save re-execution. Needs new Apps Script mirror action(s) + a redeploy (record rollback version).
- **D-02:** If the sheet copy fails (Apps Script busy, lock timeout, unreachable), the **save still succeeds** for the user; the mirror write is retried in the background, and a persistent failure raises a Sentry alert and is caught by the verify script. A sheet problem must never block a recipe edit.

**Two people editing the same recipe**
- **D-03:** A save from an **out-of-date editor is rejected** with a clear message ("this recipe was changed since you opened it — reload to see the latest") and overwrites nothing. Applies to update and delete. Mechanism (e.g. `updated_at`/version check sent by the admin editor) is the planner's choice; the admin editor must surface the message and offer a reload.
- **D-04:** In `sheets` mode, behaviour stays exactly as today (last save wins) — D-03 is a Postgres-path guarantee and must not change `sheets` behaviour.

**Proving prices match**
- **D-05:** During `dual`, **every real kiosk recipe quote/sale is priced on both stores** (Postgres, and the recipe as read back through the sheet path) and any difference is reported via `dual-write-compare` → Sentry. This is in addition to, not instead of, the parity tests (DB-04: Phase 73 unit guard, Phase 79 D-04 change comparison and D-09 id-honouring identical on Postgres; a kiosk recipe sale prices identically on both stores).
- **D-06:** If the two prices differ during a sale, the **sale charges the Postgres price** and Sentry alerts for same-day investigation. The comparison must never block or delay the sale (fire-and-forget; a sheet-side failure is not a price mismatch).

**When it's safe to switch**
- **D-07:** Flip bar: **≥7 consecutive days in `dual`** AND at least one real-or-scripted instance of each action — **create, edit with an ingredient change, delete, kiosk recipe sale, public recipe list/detail** — with **zero unexplained discrepancies**. A scripted test recipe (created, edited, sold, deleted, then cleaned up) may cover any action not seen naturally; the plan provides the runsheet. The owner decides the flip.
- **D-08:** **Production dual for recipes starts only after gift cards have flipped to `postgres`** (one production dual window at a time). Phase 85 may be built, tested and fully rehearsed on staging (including staging `dual`) while Phase 84's window runs.

### Claude's Discretion
- Table/column design, types, indexes and sequences (within the locked constraints: `ingredient_id` sole key, no `unique (recipe_id, item_id)`, IDs unchanged and sequence-backed, `schedule_id` and `pricing_mode` columns preserved).
- Caching: whether `sv:recipes` / `sv:recipes:ts` and `/api/recipes/bust-cache` stay, change or go in `postgres` mode — subject to the rename-under-2 s criterion and public API shape unchanged.
- How the state-copy mirror and the verify script are structured (reuse Phase 84 patterns).
- Recipe delete semantics: keep today's behaviour (no new soft-delete/archive design).
- Whether `dual`-mode list/detail reads also run a sheet-read comparison.
- Plan/wave breakdown, test layout, runsheet wording.

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope. (Out of scope per the phase boundary: FermSchedules/Vessels/Config — Phase 86, `schedule_id` stays a plain column with no FK; Batches — Phase 87, batches keep their own `recipe_snapshot`; any new recipe features.)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DB-04 | Recipes + ingredients relational and transactional, `ingredient_id` sole key, IDs unchanged; list/detail/public API/pricing/admin editor flagged; Phase 73/79 pricing and unit behaviour proven identical by parity tests; dual then flip | Schema (§Architecture Pattern 1), store facade + PG module (Patterns 2-3), D-04/D-09 port + `.gs`-harness parity (Pattern 4), mirror (Pattern 5), D-03 (Pattern 6), D-05 (Pattern 7), backfill/verify (Pattern 8), landmines (Pitfalls), Validation Architecture |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Static ES5 frontend (`js/admin.js`, `js/brewpad.js`: **no arrow functions / let / const / template literals**); middleware code in this repo is also written ES5-style (`var`, `function`) — follow it.
- Before every commit: `npm test` (root) AND `cd zoho-middleware && npm test`, plus `npm run lint` — never commit failing tests. Middleware has its own lint (`npm run lint`, `--max-warnings 0`).
- **Do NOT modify existing tests** unless explicitly asked (rule 10). Consequence for this phase: `RECIPES_STORE` unset/`sheets` must leave `routes/recipes.js` / `pos-recipe.js` behaviour (including the axios call sequence the existing tests mock) byte-for-byte unchanged; all new coverage goes in NEW test files.
- Bug-fix rule (regression test first) applies to anything found while building.
- Never edit `js/main.js` / `js/main.min.js`; after any `js/modules/` change run `npm run build`. `js/admin.js` / `js/brewpad.js` edits need `npm run build` so the `*.min.js` artifacts regenerate (artifact-drift CI job).
- After changing shared utilities (`zoho-middleware/lib/*.js`) run the FULL suites for both frontend and middleware.
- Security: no `.env`/credentials committed; CSP rules are not touched by this phase.
- Deployment: ALL changes to staging first (`git push origin main`); production only after staging approval. The Apps Script deployment is **shared by staging and production** (no staging isolation) — new actions must be additive.
- Global rule: the `gemini` CLI is broken — use grep + Read (this research did).

## Summary

Today every recipe read and write goes through exactly two middleware files — `routes/recipes.js` (list/detail/availability/create/update/delete/bust-cache) and `routes/pos-recipe.js` (`get_recipe` at L168 for quotes, L721 for sale confirm) — each with a private `callAppsScriptPost` copy, and through two ES5 editors that talk only to the middleware (`js/admin.js` L8940-9040 and `js/brewpad.js` L3193-3330). Nothing else in Apps Script, the middleware, or the frontend reads the `Recipes`/`RecipeIngredients` tabs (grep-verified), which is what makes D-01's "sheet is just a backup" safe. The Phase 84 shape (facade `lib/<x>-store.js` → atomic `lib/<x>-pg.js`, `store-flag`, `sheet-mirror`, `dual-write-compare`, dedicated backfill + verify CLIs, RUNBOOK + DUAL-LOG) maps over cleanly, but **it must be copied and adapted, not generalised**: Phase 84's dual leg *re-runs* Apps Script ops and compares results, whereas Phase 85 D-01 is a *state copy* plus a *price comparison*, and both are different from anything in `gift-card-store.js`.

The real risks are not the SQL. They are (a) byte-identical API shape (the Sheets path returns `''` for every empty cell, JS numbers, ISO-ms timestamps, list `total` = *unfiltered* count, ingredients in sheet-row order, a 5-minute Apps Script-side cache); (b) behaviours hidden inside Apps Script that the Postgres path must reproduce — `sanitizeInput` on every string, the delete→**soft-deactivate when any Batch references the recipe** rule (Batches are still on Sheets until Phase 87, so Postgres delete needs a new Apps Script batch-reference lookup), create ignoring incoming `ingredient_id`, update only touching fields that are `!== undefined`; (c) real data defects found in the production snapshot (`SV-R-000001` has `created_at`/`created_by` swapped, which will reject at backfill; ingredient IDs are not monotonic in sheet order, so a `position` column is mandatory); and (d) D-05's comparison racing the D-01 mirror lag, which would manufacture false "bug" discrepancies unless the comparison is gated.

**Primary recommendation:** Build `lib/recipe-pg.js` (atomic SQL, one transaction per create/update/delete, ports of the `.gs` D-04/D-09 logic **proven against the real `adminApi.gs` functions via the existing `new Function` harness**) behind `lib/recipe-store.js` (sheets/dual/postgres facade that returns the exact Apps Script response shapes), mirror via a Redis-dirty-set + coalescing "mirror-latest" worker calling one new `mirror_recipe_state` Apps Script action, and gate D-05's price comparison on mirror-settled recipes; ship `0003_recipes.sql` with a `position` column and numeric-without-scale quantity columns.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Recipe persistence, ID minting, atomic ingredient rewrite | Database / Storage (Postgres) | API / Backend (`recipe-pg.js`) | One transaction is the whole point (SC2); sequences mint `SV-R-`/`RI-` |
| Store dispatch (`sheets`/`dual`/`postgres`), response-shape fidelity | API / Backend (`lib/recipe-store.js`) | — | Facade owns the mode switch exactly like `gift-card-store.js` |
| Unit guard on save (Phase 73 D-03 pre-flight), activation guardrail | API / Backend (`routes/recipes.js`, unchanged position) | — | Runs *before* any store write in every mode; must stay store-agnostic |
| Pricing (`computeRecipeQuote`, `recipe-scaling.js`) | API / Backend | — | Pure math stays untouched; only the recipe *source* changes |
| Sheet state-copy mirror + retries | API / Backend (worker) | Apps Script (`mirror_recipe_state`) | Postgres authoritative; Apps Script only writes cells |
| Batch-reference check for delete | Apps Script (Batches still on Sheets) | API / Backend (caller) | Batches move in Phase 87; keep a seam |
| `ferment_days` enrichment | API / Backend (`enrichFermentDays`, unchanged) | Apps Script (`get_ferm_schedules`, Phase 86 moves it) | Recipes store only carries `schedule_id` |
| Stale-save rejection UX (D-03) | Browser (admin.js + brewpad.js) | API (409 + token compare in tx) | Server enforces; both editors must surface message + reload |
| Public/anon projection | API / Backend (`toPublicRecipe`, unchanged) | — | Allow-list stays the boundary (T-74-04) |
| Dual-window evidence (verify script, runsheet, DUAL-LOG) | Owner-run CLI (Mac, Railway tunnel) | Sentry | Same as Phase 84 |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pg` | 8.23.1 (installed) | Postgres client via `lib/db.js` only | Already the only DB path; `withTransaction()` gives the one-transaction guarantee [VERIFIED: `node -e require('pg/package.json')`] |
| `node-pg-migrate` | 9.0.0 (installed) | `migrations/0003_recipes.sql` | Existing migration runner + additive-only allowlist [VERIFIED: local install] |
| `exceljs` | 4.4.0 (devDependency, installed) | Backfill/verify xlsx reads via existing `scripts/backfill/read-xlsx.js` | Already pinned for Phase 83/84 [VERIFIED: local install] |
| `@testcontainers/postgresql` / `testcontainers` | 11.14.0 | Real-Postgres tests (`npm run test:db`) | Existing harness; image is `postgres:18-alpine` (`__tests__/db/helpers/pg-harness.js:88`) [VERIFIED: file read] |
| Jest | ^29.7.0 | Unit + parity tests | Existing |

### Supporting (existing in-repo modules to reuse as-is)
| Module | Purpose | When to Use |
|--------|---------|-------------|
| `lib/store-flag.js` | Already lists `RECIPES_STORE` (L31); `server.js:173` `isDatabaseRequired()` already iterates `STORE_ENV_NAMES` | No change needed; `getMode()` = `storeFlag.resolveStoreMode('RECIPES_STORE')` |
| `lib/sheet-mirror.js` | `mirrorFireAndForget` — production-only gate | Wrap *every* sheet-leg call (mirror + D-05 sheet read) so staging has no sheet leg |
| `lib/dual-write-compare.js` | `compareAndReport({store:'recipes', operation, sheets, postgres, reportValuesFor})` | D-05 only (price), plus nothing else |
| `scripts/backfill/{read-xlsx,normalize,rejects,backfill}.js`, `lib/db.createPool` | Backfill/verify CLIs | New `recipes-backfill.js` / `recipes-verify.js` mirror `gift-cards-backfill.js` / `gift-cards-verify.js` |
| `__tests__/db/helpers/pg-harness.js` | `describeDb`, `startPostgres`, `applyMigrations`, `rollbackEachTest` | All real-PG tests |
| `tests/frontend/adminapi-recipe-pure.test.js` harness (`new Function` over `adminApi.gs`) and `adminapi-giftcard-mirror.test.js` fake-Sheets runtime | Parity of D-04/D-09/sanitize; test of new Apps Script actions | See Pattern 4 / Validation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Facade copied per store | A generic `createStore()` factory | Phase 84 rule: copy shape, don't generalise — each store's dual semantics differ (op re-run vs state copy vs price compare). Generalising now would be speculative. |
| `updated_at` as the D-03 token | integer `version` column | `updated_at` is already in every GET response and in both editors' state → zero API/UI-shape change. Needs ms-precision discipline (Pitfall 7). `version` is more robust but adds a response field. Recommend `updated_at`. |
| numeric(10,2)/(12,4) | unconstrained `numeric` for quantitative columns | Fixed scale silently *rounds* a 5-dp quantity (changes a price); unconstrained preserves the sheet's value exactly. Recommend unconstrained + `Number()` on read. |

**Installation:** none — no new packages. `exceljs`, `pg`, `node-pg-migrate`, testcontainers are all already installed and pinned.

**Version verification:** versions read from the local `node_modules` (above). No new dependency is proposed, so no registry lookup is required.

## Package Legitimacy Audit

No new external packages are recommended by this phase (every dependency listed above already exists in `zoho-middleware/package.json` and passed review in Phases 83/84). slopcheck was therefore not run; there is nothing to gate.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| (none new) | — | — | — | — | n/a | — |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
 Admin editor (js/admin.js)        BrewPad editor (js/brewpad.js)       Kiosk (kiosk-core.js)   Public site (07-catalog-kits.js)
   GET/POST/PUT/DELETE /api/recipes[/:id]  (+ expected_updated_at)          GET /api/recipes, /:id, /availability
   GET /api/kiosk/recipe-quote, POST /api/kiosk/recipe-sale[/confirm]
              │                                   │                                  │
              ▼                                   ▼                                  ▼
   ┌─────────────────────────── zoho-middleware ────────────────────────────────────────────────┐
   │ routes/recipes.js ── tier guard (isRecipeStaff) ── validateIngredientUnits (Phase 73 D-03)  │
   │ routes/pos-recipe.js ── computeRecipeQuote / _runRecipeConfirm (pricing math unchanged)     │
   │            │ every recipe read/write goes through ONE seam                                  │
   │            ▼                                                                                │
   │   lib/recipe-store.js  (getMode() per call)                                                 │
   │     'sheets'  → Apps Script get_recipe(s)/create/update/delete_recipe  (today, byte-same)   │
   │     'dual'    → lib/recipe-pg.js (authoritative) ─┬─► [prod only] mirror worker (D-01/D-02) │
   │                                                   └─► [prod only] D-05 sheet price compare │
   │     'postgres'→ lib/recipe-pg.js (authoritative) ───► [prod only] mirror worker             │
   │            │                                                                                │
   │            ▼   one db.withTransaction per create/update/delete                              │
   │   Postgres: recipes ◄── recipe_ingredients (FK, position, ingredient_id PK)                 │
   │   Redis: recipe:mirror-dirty:<id> (durable retry marker), sv:recipes:* (sheets mode only)   │
   └────────────────────────────────────────────────────────────────────────────────────────────┘
              │ mirror: mirror_recipe_state / mirror_recipe_delete  │ delete: recipe_batch_ref_count
              ▼                                                     ▼
   Apps Script adminApi.gs (shared staging+prod deployment) ── Recipes / RecipeIngredients / Batches tabs
   Owner Mac CLIs (Railway tunnel): recipes-backfill.js → recipes-verify.js (fresh .xlsx) → replay-to-sheet
```

### Recommended Project Structure
```
zoho-middleware/
├── migrations/0003_recipes.sql                  # sequences + recipes + recipe_ingredients (additive)
├── lib/recipe-pg.js                             # atomic SQL; every fn takes (client, params); no pg import
├── lib/recipe-store.js                          # facade: sheets/dual/postgres; response shapes == Apps Script
├── lib/recipe-sanitize.js                       # ES5 port of Apps Script sanitizeInput (+ tuple fns) — parity-tested
├── lib/recipe-mirror.js                         # coalescing "mirror-latest" worker + Redis dirty marker + sweep
├── scripts/backfill/specs/recipes.js            # NOT registered in specs/index.js (two-table job, like gift-cards)
├── scripts/backfill/recipes-backfill.js         # dedicated CLI (plan + promote + setval both sequences)
├── scripts/backfill/recipes-verify.js           # read-only compare PG vs fresh xlsx (ids + field names only)
├── scripts/backfill/recipes-replay-to-sheet.js  # push all PG recipes to sheet via mirror action (rollback/resync)
├── __tests__/recipe-store.test.js, recipe-pg-parity.test.js, recipes-store-mode.test.js, pos-recipe-store.test.js, recipe-dual-price.test.js
├── __tests__/db/recipe-pg.test.js, recipes-backfill.test.js, recipes-rename-latency.test.js
└── __tests__/backfill/recipes-backfill-plan.test.js, recipes-verify.test.js, spec-headers (new file for Recipes headers)
apps-script/adminApi.gs                          # + mirror_recipe_state, mirror_recipe_delete, recipe_batch_ref_count
js/admin.js, js/brewpad.js                       # send expected_updated_at; surface stale_recipe (409) + reload
tests/frontend/adminapi-recipe-mirror.test.js    # fake-Sheets runtime test for the new Apps Script actions
docs/RUNBOOK.md                                  # "Recipes → Postgres (Phase 85)" section
.planning/phases/85-…/85-DUAL-LOG.md             # copy of 84 template with actions create/edit-ingredient/delete/sale/public list+detail
```

### Pattern 1: Schema (`0003_recipes.sql`) — exact column list inferred from the sheet and the live snapshot

Sheet columns (`adminApi.gs` setupRecipeTabs L4557-4600, plus self-migrated `pricing_mode` L4056 and `schedule_id` L4080). **Evidence from the prod snapshot `~/sv-backfill/prod-after.xlsx` (10 recipes, 117 ingredient rows, read 2026-10-07):** all numerics are JS numbers; `abv` up to 1 dp; ingredient `quantity` up to **4 dp** (e.g. `0.0055`); empty `notes`/`schedule_id` cells; `status` ∈ {draft, active}; `pricing_mode` all `locked` (**no dynamic recipe exists live — dynamic must be proven by tests only**); units ∈ {kg, g, pcs, ea}; no orphan ingredients; no duplicate `ingredient_id`.

```sql
-- Up Migration   (no backslashes, no triggers/functions — migration-allowlist.js; sequences are
-- seeded at backfill time via setval, because AlterSeqStmt/bare SELECT are rejected there)
create sequence recipe_id_seq start 1 minvalue 1;
create sequence recipe_ingredient_id_seq start 1 minvalue 1;

create table recipes (
  recipe_id text primary key
    default ('SV-R-' || lpad(nextval('recipe_id_seq')::text, 6, '0'))
    check (recipe_id ~ '^SV-R-[0-9]{6,}$'),
  name text not null,
  style text,
  description text,
  status text not null check (status in ('draft', 'active', 'inactive')),
  locked_price numeric,          -- nullable: createRecipe writes '' when undefined
  service_fee numeric,
  materials_fee numeric,
  batch_size_l numeric,
  abv numeric,
  ibu numeric,
  colour_srm numeric,
  notes text,
  created_at timestamptz not null,
  created_by text,
  updated_at timestamptz not null,   -- written by the app with ms precision (D-03 token)
  pricing_mode text not null default 'locked' check (pricing_mode in ('locked', 'dynamic')),
  schedule_id text                   -- plain column, NO FK (Phase 86 owns ferm_schedules)
);

create table recipe_ingredients (
  ingredient_id text primary key
    default ('RI-' || lpad(nextval('recipe_ingredient_id_seq')::text, 6, '0'))
    check (ingredient_id ~ '^RI-[0-9]{6,}$'),
  recipe_id text not null references recipes (recipe_id) on delete cascade,
  position integer not null,         -- sheet row order within the recipe (see Pitfall 3)
  item_id text not null,
  item_name text,
  quantity numeric not null default 0,
  unit text,
  unique (recipe_id, position)       -- NOT (recipe_id, item_id): SV-R-000002 has 3 rows of one item
);
create index recipe_ingredients_recipe_idx on recipe_ingredients (recipe_id, position);
create index recipes_status_created_idx on recipes (status, created_at desc);
-- Down Migration
drop table recipe_ingredients; drop table recipes; drop sequence recipe_ingredient_id_seq; drop sequence recipe_id_seq;
```
[CITED: `migrations/0002_gift_cards.sql` for the form; `scripts/migration-allowlist.js` L48-141 for what is allowed — `nextval`, `lpad`, `~`, `||`, `::text`, defaults, CHECK, FK, UNIQUE all allowed; the `default (... nextval ...)` ID idiom is explicitly blessed in the allowlist comment.]

Design notes (each is a Claude's-Discretion call; see Assumptions A1-A4):
- **Unconstrained `numeric`** for quantity/fees/abv/ibu/srm/batch size: a fixed scale would round a 5-dp value on insert and could change a price. Read back with `Number()` — `Number("0.075") === 0.075` is the same double the sheet held, so `recipe-scaling.js` arithmetic is bit-identical. pg returns `numeric` as a **string**; failing to convert is the #1 byte-shape bug (Pitfall 1).
- Store empty as `NULL`; the serializer emits `''` for NULL on text **and** numeric columns (Sheets returns `''` for empty cells — e.g. `schedule_id` must be `''` not `null`; `enrichFermentDays` only needs truthiness).
- Status CHECK is justified by live data (draft/active only) and the editors' closed pick-list; the backfill dry-run will surface any outlier.
- `updated_at`/`created_at` are written by the app (`new Date()`, ms precision), not `now()` (Pitfall 7).

### Pattern 2: Facade returns the **Apps Script response shapes**, not new ones
`lib/recipe-store.js` exports `getMode, list(limit,offset,status), get(recipeId), create(payload,actor), update(payload,actor,{expectedUpdatedAt}), remove(recipeId,actor,{expectedUpdatedAt})`. In `sheets` mode it performs the *same* `axios.post(APPS_SCRIPT_URL, {action, server_token, …})` the route does today (15 s timeout) and returns `resp.data` untouched, so `recipes.test.js` / `pos-recipe*.test.js` (which mock `axios`, `cache`, `logger`, `constants`) keep passing unmodified. In `dual`/`postgres` it returns the **same object the route currently receives** — `{ok:true, data:{recipes,total,filtered}}` / `{ok:true,data:{recipe,ingredients}}` / `{ok:true,recipe_id}` / `{ok:false,error,message}` — so the route diff is "replace `callAppsScriptPost('get_recipes', …)` with `recipeStore.list(…)`" and nothing else. Route-level Redis caching (`sv:recipes:*`) is **skipped in dual/postgres** (reads are two indexed queries; caching would serve a stale D-03 token) and unchanged in `sheets`. `enrichListPrices` currently fetches `get_recipe` per dynamic recipe on cache miss (recipes.js L316-326) — route that through `recipeStore.get` (or one `getIngredientsFor(ids)` query) in PG modes.

Key shape contract (verified against `getRecipes` L3979 / `getRecipeDetail` L4021):
- List: each recipe = the 18 header keys in column order **plus `ingredient_count`**; sorted `created_at` **descending** (string compare in Apps Script ⇒ chronological for ISO-Z); stable on ties (use `order by created_at desc, recipe_id asc`); `limit>0` → slice(offset, offset+limit), `limit==0 && offset>0` → slice(offset); returns `{recipes, total, filtered}` where **`total` is the count of ALL recipes ignoring the status filter** (staff list response passes `total` through; public list recomputes `total = filtered.length`). Status filter is case-insensitive.
- Detail: `{recipe: {18 keys, no ingredient_count}, ingredients: [{ingredient_id, recipe_id, item_id, item_name, quantity, unit}]}` in **sheet-row order** (use `position`), `quantity` a JS number, no `position` key leaked.
- Timestamps emitted as `Date.toISOString()` (`YYYY-MM-DDTHH:mm:ss.sssZ`) — identical to the strings already in the sheet.

### Pattern 3: Postgres write semantics = faithful port of Apps Script (cite each rule)
All inside one `db.withTransaction`, `$n` placeholders only (ASVS V5):
- **create** (`createRecipe` L4091): requires `name` (else `{ok:false,error:'missing_fields'}`); `status` default `'draft'`; `service_fee` default **45**, `materials_fee` default **5**; other numerics `Number(x)` if `!== undefined` else NULL; `pricing_mode` via `normalizePricingMode` (anything but `'dynamic'` ⇒ `'locked'`); `schedule_id`/strings via `sanitizeInput`; `created_by` = `'middleware'`; `created_at = updated_at = now` ; ingredient rows **always get fresh `RI-` ids — an incoming `ingredient_id` is ignored on create** (admin "Duplicate recipe" copies `ingredient_id`s into the POST body, admin.js L9055); `quantity !== undefined ? Number : 0`. Returns `{ok:true, recipe_id}`.
- **update** (`updateRecipe` L4192): `select … from recipes where recipe_id=$1 for update`; not found ⇒ `{ok:false,error:'not_found'}`; touch **only fields `!== undefined`** (strings: name, style, description, status, notes, schedule_id → `sanitizeInput`; numerics: locked_price, service_fee, materials_fee, batch_size_l, abv, ibu, colour_srm → `Number`); `pricing_mode` only if provided; **`updated_at` always bumped**; `schedule_id: null` from the admin editor ⇒ `sanitizeInput(null)` = `''` ⇒ stored NULL/'' (editor sends `null` when "None" is chosen, admin.js L8953). Ingredients: only when `payload.ingredients !== undefined`; string payload ⇒ `JSON.parse` (invalid ⇒ `{ok:false,error:'invalid_data'}`).
- **D-04** (`normalizeRecipeIngredientTuple` L1695 / `recipeIngredientsUnchanged` L1723): tuple = `trim(item_id) + ' ' + String(Math.round(Number(qty ?? 0)*1e9)/1e9) + ' ' + trim(unit)`; **no case folding**; any non-finite quantity ⇒ `'!nonfinite'` ⇒ forces "changed"; order- and length-sensitive. If unchanged ⇒ skip delete+insert entirely (so `item_name`-only changes do NOT refresh `item_name` — a documented accepted consequence). Stored-side tuples are built from the DB rows (not re-sanitised); incoming from sanitised payload values.
- **D-09**: honour an incoming `ingredient_id` only if it belongs to *this* recipe's stored rows **and** has not already been claimed earlier in the same payload; otherwise mint from `recipe_ingredient_id_seq`. A foreign or invented id is never honoured (would otherwise collide / hijack another recipe's key).
- **delete** (`deleteRecipe` L4487): not found ⇒ `{ok:false,error:'not_found'}`; **if any Batch has `recipe_id` = this recipe ⇒ soft-deactivate (`status='inactive'`, `updated_at` bump) and return `{ok:true, deactivated:true}`; else hard-delete rows**. The route returns bare `{ok:true}` in both cases (the editors show "Recipe deleted." even for a deactivation — existing quirk, preserve). Batches are still on Sheets ⇒ new Apps Script action `recipe_batch_ref_count` (Pitfall 4).
- Non-finite numerics (Sheets would have written `NaN`): reject in the PG path with `{ok:false,error:'invalid_data'}` → route 422 `save_failed` (Assumption A5).

### Pattern 4: Parity of Phase 79 logic is proven **against the real `.gs` source, not a re-transcription**
`tests/frontend/adminapi-recipe-pure.test.js` already evals `adminApi.gs` via `new Function` and exposes `normalizeRecipeIngredientTuple`, `recipeIngredientsUnchanged`, `formatPaddedId`, `maxIdNumFromColumn`, `sanitizeInput`. A new **middleware** test (`__tests__/recipe-pg-parity.test.js`) can read `../../apps-script/adminApi.gs` the same way (fs read outside rootDir is fine), extract those functions, and run a shared vector table through BOTH the `.gs` function and `lib/recipe-sanitize.js`, asserting identical outputs (sanitize: `<script>`, `onclick=`, `javascript:`, nested `<scr<script>ipt>`, iframe/object/embed/style, non-string, null; tuples: trim, `'5'` vs `5`, `0.1+0.2`, `''`/null qty, `abc`). Then a real-PG test (`__tests__/db/recipe-pg.test.js`) drives scripted save sequences — unchanged payload ⇒ no row rewrite (assert ingredient rows' `xmin`/ids untouched), changed ⇒ rewrite with honoured ids, foreign id ⇒ minted, duplicate id in payload ⇒ second minted, `SV-R-000002`-style triple same-item rows survive a round trip — and a **sheet-model equivalence** test replaying the same sequence through a small in-memory model of `updateRecipe`'s ingredient logic extracted from the `.gs` (or the fake-Sheets runtime) to prove identical final id lists.

### Pattern 5: D-01 state-copy mirror — "mirror-latest", durable, coalescing
Per-write mirror payloads would race (an older retry could overwrite newer sheet state — Pitfall 5). Instead:
1. After the PG commit, `recipeMirror.schedule(recipeId)` sets Redis marker `recipe:mirror-dirty:<id>` (survives Railway redeploys; same idea as `giftcard:pending:*`, `lib/reconcile.js` L53/L649/L734) and wakes an in-process per-recipe worker (chain per recipe id, like `certTails` in `gift-card-store.js` L54).
2. The worker **reads the current state from PG at send time** (recipe + ordered ingredients, or "gone" ⇒ delete) and calls one Apps Script action; on success it clears the marker **only if no newer write set it again**; on failure it retries with backoff (e.g. 2 s, 10 s, 60 s, 5 min), then raises a Sentry **error** (`component: recipes-mirror`).
3. A 5-minute sweep (add one `setInterval` beside `server.js` L913-915's gift-card sweep) re-drives any surviving marker (covers restarts).
4. All of it inside `sheetMirror.mirrorFireAndForget` so staging does nothing; and it never awaits on the request path (D-02: save succeeds regardless).
5. `postgres` mode keeps the same worker (permanent mirror — milestone decision).

New Apps Script actions (server_token branch of `doPost`, next to `mirror_gift_card_state` at L334; additive ⇒ safe on the shared deployment): 
- `mirror_recipe_state` `{recipe:{18 fields}, ingredients:[{ingredient_id,item_id,item_name,quantity,unit}…]}` under `acquireScriptLock(15000)`: locate row by `recipe_id` (header-addressed — the sheet's column order is not guaranteed; `findRowById` uses column A), upsert the full row, then replace that recipe's ingredient rows (descending-run `deleteRows` + one batched `setValues`, exactly the Phase 79 D-06/D-07 technique but **without** re-running D-04/D-09 logic), `invalidateSheetCache(...)` for both tabs, **and `_invalidateRecipeCache(recipeId)`** (the existing handlers do this *outside* the function at L280-294 — the new dispatch must too, or `get_recipe` serves a 300 s stale copy and D-05 false-alarms).
- `mirror_recipe_delete` `{recipe_id}`: remove ingredient rows then the recipe row (idempotent if absent).
- `recipe_batch_ref_count` `{recipe_id}` → `{ok:true, count}` reading Batches fresh (not the `gbl` 300 s cache).
Write values verbatim (they were sanitised on the PG write); do **not** re-sanitise (non-idempotent for nested tags ⇒ spurious verify mismatches). Note the pre-existing formula-injection exposure of `appendRow`/`setValues` with user text (`=…`) — the mirror must not widen it; hardening is out of scope but flag it.
Deploy: follow RUNBOOK "Apps Script (`adminApi.gs`)" (L225-262): record active version (currently **59**, per §6) as rollback target, editor-drift hash check, paste, **new version on the existing deployment**, record in the Deploy-record table. Deployment is shared by staging and production, so deploy *before* any `dual` on either environment; the old middleware never calls the new actions.

### Pattern 6: D-03 optimistic concurrency with `updated_at`
- Both GET payloads already carry `recipe.updated_at` (ISO-ms) and both editors keep it in state (`_recipesState.currentRecipe`). Editors send it back as **`expected_updated_at`** in the PUT body and as a **query param** on DELETE (`?expected_updated_at=`; DELETE bodies are fragile through fetch/proxies).
- In the PG transaction after `select … for update`: compare epoch-ms (`row.updated_at.getTime() !== new Date(expected).getTime()` ⇒ stale). Stale ⇒ rollback, HTTP **409** `{error:'This recipe was changed since you opened it — reload to see the latest', code:'stale_recipe'}`. Never in `sheets` mode (D-04): the route only passes the token when `getMode() !== 'sheets'`, and Apps Script ignores the extra payload field.
- Missing token in dual/postgres: recommend **reject** with the same 409/`stale_recipe` (it means a stale cached JS bundle — "reload" is exactly the remedy); see Open Question 2. Frontend must ship before the middleware flag is flipped.
- `admin.js` `saveRecipe()` (L8940) currently swallows every error into one generic toast (`.catch` ignores the message) — add a `code === 'stale_recipe'` branch with a "Reload" action (re-run `openRecipeDetail`). `brewpad.js` `submitRecipeSave` (L3228) already propagates `err.status/err.code` (D-05 of Phase 73) — add the `stale_recipe` branch there, and **exclude 409 from the transient-retry set** (it already only retries 502/503/504). Delete handlers in both editors (`admin.js` L9019, `brewpad.js` L3300) also need the branch.

### Pattern 7: D-05 dual price comparison without touching the sale
Refactor `computeRecipeQuote` (pos-recipe.js L167) into `loadRecipe(recipeId)` (store read, returns the `{ok,data:{recipe,ingredients}}` shape) + `priceRecipe(recipe, ingredients, rawTarget, saleType, millGrain, modifiedIngredients, discountReq)` (the existing body from L170 on, unchanged). `_runRecipeConfirm` (L721) uses `loadRecipe` + its existing inline block the same way. In `dual`, **after** the PG-priced result exists (and after the response is committed to be sent), fire-and-forget inside `sheetMirror.mirrorFireAndForget('recipes.price', …)`: fetch the sheet-path recipe (`get_recipe` Apps Script), run the *same* `priceRecipe`, and `compareAndReport({store:'recipes', operation:'quote'|'sale', sheets:{pricingMode, baseVol, grandTotal, feePortion, lines:[{item_id,quantity,unit}]}, postgres:{…}, reportValuesFor:['grandTotal','feePortion','quantity']})`. Sale charges the PG price regardless (D-06). Rules:
- A sheet fetch error/timeout/`ok:false` is a *mirror failure* (existing `reportFailure` ⇒ Sentry warning, tag `sheet-mirror`), **not** a price discrepancy.
- **Skip (log "explained skip") when the recipe's `updated_at` is < 60 s old or its `recipe:mirror-dirty:<id>` marker exists** — otherwise an edit followed by a quick quote compares new-PG vs not-yet-mirrored-sheet and files a false "bug" that restarts the 7-day window. This gate is the single most important D-05 detail.
- Memoise the sheet fetch per recipe id for a few seconds (in-flight promise) so a chatty quote UI cannot hammer Apps Script (executions are cheap but quota-limited); still compare every quote.
- Staging: no sheet leg ⇒ D-05 is production-only by construction; staging `dual` proves only the PG leg.
- Dry-run price parity of both stores happens in tests with a stub Apps Script (axios mock) returning the same recipe; for a deliberate drift, assert Sentry capture + that the PG total is what the sale charges.

### Pattern 8: Backfill / verify / replay tooling (copy 84's shape)
- `recipes-backfill.js` (dedicated CLI; **do not register in `specs/index.js`** — Phase 84 Pitfall 3: the generic single-table path can't do two FK-linked tables + sequence seeding): reads `Recipes` and `RecipeIngredients` from one snapshot; headers checked with `checkHeaders` (pin real headers in a new `spec-headers` test, 18 + 6 columns); `normalizeRow` for timestamps/numerics; `position` = 1-based order of the recipe's rows in the sheet; reject (never coerce) bad status/pricing_mode/timestamps/orphan ingredients/duplicate `ingredient_id`/duplicate `recipe_id`; **never dedupe on `(recipe_id,item_id)`** (conversion note §6, `.planning/notes/sheets-to-postgres-data-conversion.md` L310-320); promote in one transaction with empty-target preconditions, then `setval('recipe_id_seq', max SV-R suffix)` and `setval('recipe_ingredient_id_seq', max RI suffix)` (only when > 0), then in-transaction invariant checks (recipe count, ingredient count, per-recipe ingredient count, `SV-R-000002` has 3 rows of one `item_id`, sequence ≥ max). DB-name prompt on promote; `BACKFILL_DATABASE_URL` only; output = ids/field names/counts only (created_by can hold a staff email).
- `recipes-verify.js` (read-only transaction, fresh `.xlsx`): compares per recipe all 18 fields (timestamps by epoch-ms, numerics by `Number`, `''`≡NULL) and the **ordered** ingredient list `(ingredient_id, item_id, quantity, unit)`; reports `{recipe_id|ingredient_id, field}` only; flags orphan/ missing-in-either-side.
- `recipes-replay-to-sheet.js`: push every PG recipe through `mirror_recipe_state` (dry-run default, `--apply`) — required for **dual→sheets rollback** and for repairing a persistent D-02 failure; needed because fire-and-forget mirrors can be missed and rolling back to `sheets` hands the sheet back as the authority.

### Pattern 9: Cutover & dual-window procedure (follow RUNBOOK §3-§9 shape; add "Recipes → Postgres (Phase 85)" section)
Order: (0) wait for Phase 84 flip (D-08) → (1) staging rehearsal incl. staging `dual` → (2) Apps Script redeploy (record version/rollback) → (3) prod deploy with `RECIPES_STORE` unset (migration 0003 applies) → (4) owner fixes the `SV-R-000001` cells (Pitfall 2) → (5) after hours: fresh xlsx, `--dry-run` (0 rejects), `--promote`, set `RECIPES_STORE=dual`, second fresh xlsx, `recipes-verify` = 0 mismatches before reopening → (6) 7-day window with DUAL-LOG and scripted runsheet → (7) flip → `recipes-verify` again + confirm a real edit's mirror lands on the sheet. Rollback dual→sheets: set flag, `recipes-verify`, if mismatch `recipes-replay-to-sheet --apply`, re-verify. Runsheet (D-07) must include a **rename stopwatch** (browser devtools PUT time < 2 s, SC4) and cleanup of any test recipe sale (staging/prod share the Zoho org + Helcim token ⇒ scripted sales land in live books; use cash tender / the INV-000229 reversal procedure from 84).

### Anti-Patterns to Avoid
- **Re-running Apps Script `create/update/delete_recipe` as the dual sheet leg** — explicitly rejected by D-01; the sheet leg is state copy only.
- **Per-write mirror payloads / fire-and-forget without ordering** — causes sheet regression on retry (Pitfall 5).
- **Returning pg `numeric` strings or `Date` objects** from the store — breaks `scaling.*`, JSON shape, `typeof recipe._scale_factor` etc. Always convert.
- **Falling back to a sheet read when Postgres fails** (84 D-09 precedent) — reject; routes already map store failures to 502.
- **Editing `updateRecipe` / `createRecipe` in Apps Script** (Phase 79 logic) — leave untouched; add new functions only.
- **Caching recipe reads in Redis in PG modes** — stale D-03 token and stale price vs sale (Pitfall 8).
- **Generalising `gift-card-store.js` into a shared factory** now.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Discrepancy detection + Sentry grouping | Custom diff/alert | `lib/dual-write-compare.js` `compareAndReport` | Handles ''/null, numeric-string vs number, date, TRUE/FALSE; never throws; PII-safe by default |
| Production-only gating + never-throw wrapper | `if (env==='production')` checks | `lib/sheet-mirror.js` `mirrorFireAndForget` | Exact-match env gate, not overridable; swallows + reports failures |
| Env flag parsing / boot refusal | New env reader | `lib/store-flag.js` `resolveStoreMode('RECIPES_STORE')` | Already lists it; `/health database_required` already honours it (`server.js:173`) |
| Transactions / pool | Own `pg` usage | `lib/db.js` `withTransaction` | Only module allowed to import `pg` |
| Unit conversion / line cost / stock | Re-implement | `lib/recipe-scaling.js` (`ingredientLineCost`, `classifyUnit`, `computeScaledRecipeTotal`, `checkScaledStock`) | Phase 73 money-path fix; pure — the PG path must feed it, not replace it |
| Timestamp/numeric/ID normalisation at backfill | Hand parsing | `scripts/backfill/normalize.js` (`normalizeRow`, `normalizeNumeric`, `normalizeTimestamp`, `normalizeId`) + `rejects.js`, `read-xlsx.js`, `backfill.js` helpers (`checkHeaders`, `assertSnapshotSafePath`, `EXIT`) | Rejects rather than coerces (Trap 1-4) |
| XSS stripping on stored strings | A "better" sanitiser | A line-for-line ES5 port of `sanitizeInput` (adminApi.gs L3913), parity-tested against the `.gs` | Behavioural identity is the requirement, not improvement |
| ID minting | App-side max()+1 | `recipe_id_seq` / `recipe_ingredient_id_seq` column defaults | SC1 says sequence-backed; avoids the sheet's reuse-after-delete-of-highest bug |
| Sweep/retry scheduling | New scheduler | The existing `setInterval` sweep pattern (`server.js` L877-915) + Redis marker pattern (`reconcile.js`) | Survives deploys, already operated |

**Key insight:** every hard part here is *fidelity* (shape, defaults, sanitisation, ordering, delete semantics), not mechanics. Anything that "improves" behaviour in the PG path becomes a false discrepancy or a silent customer-visible change.

## Runtime State Inventory

Not a rename phase, but a store migration with live data — the equivalent questions:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | Sheets `Recipes` (10 rows) + `RecipeIngredients` (117 rows) in the shared "STEINS AND VINES" workbook — authoritative until flip; Redis `sv:recipes:*`, `sv:recipes:ts`, `sv:recipe-availability:<id>`; Apps Script CacheService keys `gr:list:<status>:0:0`, `gr:<id>` (300 s) | Backfill (data migration); Redis keys die by TTL/bust — no migration; mirror action must evict GAS `gr:*` keys |
| Live service config | Apps Script deployment `AKfycb…DI968g` (v59) shared by staging+prod, no staging copy | Redeploy with 3 new actions (v60; rollback v59); additive |
| OS-registered state | None — Railway env var `RECIPES_STORE` only (unset today) | Set per environment at cutover; none otherwise |
| Secrets/env vars | `APPS_SCRIPT_URL`, `APPS_SCRIPT_SERVER_TOKEN`, `DATABASE_URL` already present; `RECIPES_STORE` is the only new variable | None new |
| Build artifacts | `js/admin.min.js`, `js/brewpad.min.js` must be rebuilt after editor edits (`npm run build`); CI `artifact-drift` fails otherwise | Build + commit artifacts |

**Nothing else:** batches hold `recipe_id` + `recipe_snapshot` (no live recipe read except `scheduleIdForRecipe` in admin.js L6965 and the BrewPad recipe picker, both via the middleware routes).

## Common Pitfalls

### Pitfall 1: pg `numeric`/`timestamptz` types leak into the API
**What goes wrong:** `quantity` arrives as `"1.87"`, `updated_at` as a `Date`; JSON differs from Sheets (`1.87`, `"2026-…Z"`), `typeof` checks and `Math.ceil` in `scaleIngredient` misbehave.
**How to avoid:** a single `rowToRecipe/rowToIngredient` serializer: `Number()` every numeric (NULL ⇒ `''`), `toISOString()` every timestamp, NULL text ⇒ `''`, key order = column order. Parity test: `JSON.stringify(pgResult) === JSON.stringify(sheetFixture)` for the 10 real recipes (anonymised fixture).
**Warning signs:** `recipe-scaling.test.js`-style assertions failing only in PG mode; list prices off by string concatenation.

### Pitfall 2: Real data defect — `SV-R-000001` has `created_at` and `created_by` swapped [VERIFIED: prod-after.xlsx]
`created_at = "middleware"`, `created_by = "2026-06-18T22:17:46.555Z"`. `normalizeTimestamp` rejects `"middleware"` and rejects block promotion unconditionally (84 D-13 precedent). **Action:** owner swaps the two cells in the live sheet before the cutover dry-run (add as an explicit runbook step + the dry-run is the gate); do **not** add silent special-casing. Side effect to document as *explained*: the Sheets list sorts the string `"middleware"` first under `created_at desc`; after the fix/backfill `SV-R-000001` (a draft) sorts last — staff list order for that row changes; kiosk shows only `active`, unaffected. Also `created_by` of `SV-R-000003` is a staff email ⇒ treat verify/rejects output as PII-bearing (ids + field names only).

### Pitfall 3: Ingredient order is meaningful and IDs are not monotonic [VERIFIED: ingredient_id order is non-monotonic in sheet order]
The editors render rows in sheet order; D-04 compares order-sensitively; D-09 keeps old ids at their (new) positions. `order by ingredient_id` would reorder rows and make every first post-flip save look "changed". Hence `position`, `order by position` everywhere, and the backfill derives it from sheet row order. Gaps in `recipe_id` (000005, 000009, 000012 are gone) and `RI-` (min 33, max 184) are normal — sequences are seeded from the **max**, never from counts. Behavioural delta to record as *explained*: sheet `generateNextId` reuses the highest id after that row is deleted; sequences never do.

### Pitfall 4: Delete's hidden Batches dependency
`deleteRecipe` (L4487) soft-deactivates when any `Batches.recipe_id` matches. Batches stay on Sheets until Phase 87, so the PG path cannot answer this from its own tables. Use the new `recipe_batch_ref_count` Apps Script action, called *before* opening the PG transaction (don't hold a row lock across an HTTP round trip). Residual race (a batch created between check and delete) is benign: batches carry `recipe_snapshot`. Wrap as a `hasBatchReferences(recipeId)` seam so Phase 87 swaps it for SQL. If Apps Script is unreachable ⇒ fail the delete (502) rather than risk a hard delete of a referenced recipe. Staging `dual` runs this against the shared production workbook (read-only action ⇒ safe).

### Pitfall 5: Mirror ordering/regression and D-05 false alarms
Two quick edits ⇒ two mirror payloads; a retried older one lands last ⇒ sheet regresses and verify/D-05 flag it. A quote 3 s after an edit compares fresh PG with unmirrored sheet ⇒ false "bug". **Mitigation:** mirror-latest worker + dirty marker (Pattern 5) and the 60 s/marker gate on D-05 (Pattern 7). Also GAS `_cachedGet` 300 s cache (`get_recipe`/`get_recipes`, adminApi.gs L219-227/L295-309) — the mirror dispatch must call `_invalidateRecipeCache`.

### Pitfall 6: Behavioural changes that are *improvements* still count as differences
Sheets-mode `get_recipe` can serve a ≤300 s stale recipe to a sale after an edit; PG serves current. Missing recipe: Sheets wraps `{ok:false}` inside `{ok:true,data:…}` so `GET /api/recipes/NOPE` returns **200 with an error object as `recipe` for staff** (recipes.js L506-512 checks only the outer `ok`); the PG path should return the 404 `Recipe not found` (pos-recipe already 404s). Log both in the DUAL-LOG "explained differences" list up front so they aren't mistaken for bugs.

### Pitfall 7: `updated_at` precision vs the D-03 token
If `updated_at` is written with `now()` (µs) and read as a JS `Date` (ms), the token round-trips lossy ⇒ every save looks stale. Write `updated_at` from the app as a ms `Date`, compare by epoch-ms, never as strings. BrewPad's auto-retry after a timed-out-but-committed save will now get a spurious 409 (token advanced): acceptable but test it; the toast copy must make "reload" obvious, and the draft-preservation (`saveRecipeDraftNow`) already protects the user's work.

### Pitfall 8: Redis caches in front of PG
Staff detail cached 10 min (recipes.js L471-505) serves an old `updated_at` ⇒ spurious 409s or silently overwritten edits; list cache serves old prices. In `dual`/`postgres` bypass `sv:recipes:*` reads/writes entirely (keep `bustRecipeCache` calls harmless and keep the `bust-cache` route working). `RECIPES_TS` has no other consumer (pos-recipe L988 only deletes it).

### Pitfall 9: Post-charge read at `/confirm`
`_runRecipeConfirm` re-reads the recipe *after* the card was approved (L721). A PG outage there lands in the same `.catch` (L1089) that handles Apps Script errors today — 502, lock released, pending-charge record already written for the reconcile sweep. Keep that branch identical; do not add a sheet fallback.

### Pitfall 10: Existing-test and lint constraints
`recipes.test.js` mocks `constants` with only a few `CACHE_KEYS`; the new facade must not read missing constants at module load. `store-flag.js` → `db.js` → `pg` loads fine under those mocks (Phase 84 precedent: `gift-cards.test.js`). Middleware lint is `--max-warnings 0` over `routes/ lib/ scripts/ server.js`.

## Code Examples

### Facade skeleton (shape only — mirrors `gift-card-store.js`)
```javascript
// Source: lib/gift-card-store.js L58-68, L110-114, L182-204 (pattern); adapt, do not copy ops
function getMode() { return storeFlag.resolveStoreMode('RECIPES_STORE'); }

function update(payload, opts) {
  var mode = getMode();
  if (mode === 'sheets') return callAppsScript('update_recipe', payload);   // byte-same as today
  return db.withTransaction(function (client) {
    return recipePg.update(client, payload, { actor: opts.actor, expectedUpdatedAt: opts.expectedUpdatedAt });
  }).then(function (result) {
    if (result.ok) recipeMirror.schedule(result.recipeId);   // wrapped in sheetMirror.mirrorFireAndForget inside
    return strip(result);
  });
}
```

### D-09 / D-04 in the PG module (port of adminApi.gs L4396-4417)
```javascript
// Source: apps-script/adminApi.gs updateRecipe (D-09); keep semantics identical
var claimed = {}, rows = [];
incoming.forEach(function (item, idx) {
  var id;
  if (item.ingredientId && storedIdSet[item.ingredientId] && !claimed[item.ingredientId]) {
    id = item.ingredientId;                       // honour only own, unclaimed ids
  } else {
    id = null;                                    // let the column default mint from recipe_ingredient_id_seq
  }
  if (id) claimed[id] = true;
  rows.push({ id: id, position: idx + 1, itemId: item.itemId, itemName: item.itemName, quantity: item.quantity, unit: item.unit });
});
```

### Stale check inside the transaction
```javascript
// after: select updated_at from recipes where recipe_id = $1 for update
if (opts.expectedUpdatedAt === undefined ||
    new Date(opts.expectedUpdatedAt).getTime() !== row.updated_at.getTime()) {
  return { ok: false, error: 'stale_recipe' };   // route → 409 {error, code:'stale_recipe'}; tx rolls back (no writes yet)
}
```

### Reading the real source in a middleware parity test
```javascript
// Source: tests/frontend/adminapi-recipe-pure.test.js L28-45 (pattern)
var src = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8');
var gs = new Function(src + '\nreturn {normalizeRecipeIngredientTuple: normalizeRecipeIngredientTuple,' +
  'recipeIngredientsUnchanged: recipeIngredientsUnchanged, sanitizeInput: sanitizeInput};')();
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Apps Script as recipe store with 5 s script lock, delete+reinsert per save (Phase 79 mitigations) | Postgres single transaction | This phase | Rename < 2 s trivially; D-04 skip rule retained only for behavioural parity |
| Sheet-side max()+1 IDs (reuse possible) | Sequence-backed IDs | This phase | No reuse; gaps allowed |
| Phase 84 dual = re-run op + compare | Phase 85 dual = state copy + live price compare | Phase 85 D-01/D-05 | Different facade internals; shared gates/compare |

**Deprecated/outdated:** the memory note "tests/CI use postgres:16" is out of date — the harness now uses `postgres:18-alpine` (`pg-harness.js:88`); only the migration-allowlist *parser* is still PG16 grammar (`libpg-query@16.7.3`) — keep migration SQL to plain PG16-compatible DDL. The `table hygiene` test already derives its allow-list from `migrations/` (commit 54948ad4), so the 84-era landmine does not recur.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Unconstrained `numeric` (not scaled) for quantity/fee/abv/ibu/srm/batch columns is preferable to `numeric(10,2)`/(12,4) | Pattern 1 | If owner wants 2-dp money enforcement, add write-time validation (new 422) — behaviour change |
| A2 | `status` CHECK limited to draft/active/inactive | Pattern 1 | A legacy odd value in the live sheet rejects at backfill (caught by dry-run) |
| A3 | `updated_at` (not a `version` int) as the D-03 token | Pattern 6 | If owner prefers a version column: API gains a field |
| A4 | Empty values stored as NULL, serialised back as `''` | Pattern 1 | If any consumer expects `null`, it would see `''` — matches Sheets today, so risk is low |
| A5 | PG path rejects non-finite numerics (`NaN`) with 422 where Sheets would write garbage | Pattern 3 | Tiny behaviour change; arguably a fix |
| A6 | Missing `expected_updated_at` in dual/postgres is rejected (409) rather than allowed | Pattern 6 | If allowed, a stale cached JS bundle bypasses D-03 |
| A7 | Missing-recipe GET returns 404 in PG modes (vs Sheets' 200+error-object quirk) | Pitfall 6 | Editor shows toast instead of blank form for a deleted id; log as explained |
| A8 | Apps Script request quotas tolerate one extra `get_recipe` per quote in dual (with 300 s GAS cache + per-recipe memo) | Pattern 7 | If throttled, D-05 gets sheet-failure warnings (not mismatches); reduce via the memo window |
| A9 | Mirror retry schedule (2 s/10 s/60 s/5 min) and 60 s settle window for D-05 | Patterns 5/7 | Tunable; wrong values only change alert noise |
| A10 | Docker daemon is not running on the dev machine right now (`docker info` failed) | Environment Availability | `npm run test:db` skips locally (D-14) but fails on CI if Docker absent — start Docker Desktop before executing real-PG tasks |

## Open Questions

1. **Delete when Apps Script is unreachable (PG mode).**
   - Known: the soft-deactivate rule needs the Batches tab; no PG equivalent until Phase 87.
   - Unclear: owner tolerance for "delete fails while Apps Script is down" vs risk of hard-deleting a referenced recipe.
   - Recommendation: fail closed (502, "try again") — matches today's behaviour when Apps Script is down.
2. **Strict vs lenient token requirement for D-03.**
   - Recommendation: strict in `dual`/`postgres`; ship both editors' change to staging first and verify before flipping any flag (see A6). Confirm with owner at plan time.
3. **Should staging `dual` also call `recipe_batch_ref_count` against the shared production workbook?**
   - It is read-only, so safe; it is the only way to exercise delete end-to-end on staging. Recommend yes.
4. **`SV-R-000001` swap:** owner fix in the live sheet (recommended) vs a one-off backfill transform. Recommend the sheet fix; the dry-run enforces it.
5. **Durable dirty-set vs in-memory-only retry.** CONTEXT D-02 only requires "retried in the background" + Sentry + verify catch. A Redis marker + sweep is the recommended robust form given frequent Railway redeploys; the minimal form (in-memory retries only) satisfies the letter but loses retries on restart. Planner to decide scope; recommendation above.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | all | ✓ | v20.20.2 | — |
| Docker daemon | `npm run test:db` (Testcontainers) | ✗ (client present, daemon not running) | Docker 28.0.2 client | Start Docker Desktop; locally tests self-skip (D-14), CI fails without it |
| Railway CLI | tunnel for backfill/verify | ✓ | 5.62.1 (≥5.x needed) | — |
| `psql` | optional manual checks | ✗ | — | Use the backfill CLIs / node `pg` |
| Railway Postgres staging+prod | dual/postgres | ✓ (per 83/84 records) | PG 18.6 | — |
| Apps Script editor access (owner) | 3 new actions + redeploy | ✓ (owner, manual) | current v59 | — |
| Prod snapshot (`~/sv-backfill/*.xlsx`) | backfill rehearsal/fixtures | ✓ (owner Mac; PII-bearing for other tabs; never commit) | 2026-10-06 | Re-download |

**Missing with no fallback:** none blocking research. **Missing with fallback:** Docker daemon (start it before executing).

## Validation Architecture

> `workflow.nyquist_validation` is `false` in `.planning/config.json`; included because the orchestrator requested it. Informational — planner is not bound to the sampling cadence.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest ^29.7.0 — middleware mocked suite, middleware real-PG suite (Testcontainers `postgres:18-alpine`), root jsdom suite |
| Config file | `zoho-middleware/jest.config.js`, `zoho-middleware/jest.db.config.js`, root `jest.config.js` |
| Quick run command | `cd zoho-middleware && npx jest recipe-store recipe-pg-parity recipes pos-recipe` |
| Full suite command | `npm test && cd zoho-middleware && npm test && npm run lint && npm run test:db` (+ root `npm run lint`, `npm run build`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DB-04 / SC1 | Tables, no `unique(recipe_id,item_id)`, sequence defaults, `SV-R-000002` triple rows backfill intact, IDs unchanged, sequences seeded ≥ max | real-PG | `npm run test:db -- recipes-backfill` / `recipe-pg` | ❌ Wave 0 |
| DB-04 / SC2 | create/update/delete atomic (mid-transaction failure leaves no partial ingredient set); concurrent saves serialise on `for update` | real-PG (dedicated pool clients, like `gift-card-pg.test.js`) | `npm run test:db -- recipe-pg` | ❌ Wave 0 |
| SC2 | list/detail/availability/public `/api/recipes` honour `RECIPES_STORE`; `ferment_days` preserved; public allow-list unchanged; `total` unfiltered quirk | unit (mocked store) | `npx jest recipes-store-mode` | ❌ Wave 0 |
| SC2 | sheets mode untouched (existing suites) | unit | `npx jest recipes.test recipes-public-guard pos-recipe` | ✅ existing (must stay green unmodified) |
| SC3 | Phase 73 unit guard identical: save-time `unit_mismatch` 422 pre-flight in all modes (no write occurs); read-path `pricing_error`; checkout fail-closed | unit | `npx jest recipes-store-mode recipe-scaling` | ❌ new cases / ✅ existing |
| SC3 | Phase 79 D-04 tuple compare + D-09 id honouring == `.gs` (shared vectors against real `adminApi.gs`) | unit (`new Function` harness) + real-PG sequences | `npx jest recipe-pg-parity` | ❌ Wave 0 |
| SC3 | `sanitizeInput` port identical | unit | `npx jest recipe-pg-parity` | ❌ Wave 0 |
| SC3 | A kiosk quote/sale prices identically on both stores (same recipe fixture through sheets path and PG path → same `grandTotal`, `feePortion`, scaled lines) incl. locked + dynamic, discount, modified ingredients | unit | `npx jest pos-recipe-store` | ❌ Wave 0 |
| D-01/D-02 | Mirror: state-copy payload, retry/backoff, coalescing latest-wins, failure never blocks save, staging no-op, Sentry on persistent failure | unit | `npx jest recipe-mirror` | ❌ Wave 0 |
| D-01 | New Apps Script actions (fake-Sheets runtime): upsert row, replace ingredients preserving ids/order, delete, cache eviction, idempotent | root unit | `npx jest adminapi-recipe-mirror` (root) | ❌ Wave 0 |
| D-03 | stale PUT/DELETE → 409 `stale_recipe`, nothing written; sheets mode ignores token; missing token policy | unit + real-PG | `npx jest recipes-store-mode`; `test:db -- recipe-pg` | ❌ Wave 0 |
| D-03 UI | admin.js + brewpad.js show message + reload on 409; 409 not auto-retried | root jsdom | `npx jest admin-recipes brewpad-recipe-save-resilience` (+ new files; do not edit existing) | ❌ new files |
| D-05/D-06 | Dual compares prices, reports mismatch via `compareAndReport`, sale charges PG price, sheet failure ≠ mismatch, skip within 60 s of edit / dirty marker, never delays response | unit | `npx jest recipe-dual-price` | ❌ Wave 0 |
| Backfill | plan/rejects (swapped timestamps, orphan, dup ids), position order, sequence seed, DB-name prompt, no PII in output | unit + real-PG | `npx jest backfill/recipes-backfill-plan`; `test:db -- recipes-backfill` | ❌ Wave 0 |
| Verify | field + ordered-ingredient compare, ids-only output | unit | `npx jest backfill/recipes-verify` | ❌ Wave 0 |
| SC4 | Rename latency (PUT with unchanged ingredients) well under 2 s on PG; mirror off the request path | real-PG timing (generous bound) + manual production stopwatch in runsheet | `npm run test:db -- recipes-rename-latency` | ❌ Wave 0 |
| Spec headers | Real 18+6 sheet headers pinned | unit | `npx jest backfill/spec-headers`-style new file | ❌ Wave 0 |
| Migration guard | `0003_recipes.sql` passes guard + allowlist | existing script | `cd zoho-middleware && npm run migrate:guard` | ✅ script exists |

### Sampling Rate
- **Per task commit:** the targeted `npx jest <file>` for the touched module (+ lint)
- **Per wave merge:** `cd zoho-middleware && npm test` and root `npm test`; `npm run test:db` at least once per wave (Docker start-up cost)
- **Phase gate:** root `npm test`, `npm run lint`, `npm run build`; middleware `npm test`, `npm run lint`, `npm run migrate:guard`, `npm run test:db` — all green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `migrations/0003_recipes.sql` (prerequisite for every real-PG test)
- [ ] `__tests__/recipe-pg-parity.test.js`, `recipe-store.test.js`, `recipes-store-mode.test.js`, `pos-recipe-store.test.js`, `recipe-dual-price.test.js`, `recipe-mirror.test.js`
- [ ] `__tests__/db/recipe-pg.test.js`, `recipes-backfill.test.js`, `recipes-rename-latency.test.js`
- [ ] `__tests__/backfill/recipes-backfill-plan.test.js`, `recipes-verify.test.js`, recipes spec-headers test
- [ ] `tests/frontend/adminapi-recipe-mirror.test.js` (fake Sheets runtime), new admin/brewpad stale-save tests
- [ ] Anonymised fixture of the real 10 recipes / 117 ingredients (strip names/emails) for shape-fidelity tests — never commit the xlsx

## Security Domain

> `security_enforcement: true`, ASVS level 1 (`.planning/config.json`).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | unchanged | Existing `authTiers` (`isRecipeStaff`, `requireTiers` on availability) — do not alter tiers; recipe routes' write guard lives in `server.js` global `/api` guard |
| V3 Session Management | no | — |
| V4 Access Control | yes | Public projection stays `toPublicRecipe` allow-list (T-74-04) built from the PG row, never `delete`-from-source; anon draft ⇒ 404 (T-74-02); `schedule_id`/steps never public; new `expected_updated_at` is not an authority, just a precondition |
| V5 Input Validation | yes | `$1..$n` placeholders only; ID regex CHECKs; `sanitizeInput` port on every stored string (stored-XSS parity); finite-number validation; payload size limits come from existing express body parser |
| V6 Cryptography | no | None new; `DATABASE_URL`/TLS unchanged |
| V9 Data Integrity | yes | Single transaction per mutation, `for update` row lock, FK + `unique(recipe_id, position)`, sequences |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via recipe name/ids/ingredient fields | Tampering | Parameterised queries only (db.js convention) |
| Stored XSS in name/description/notes/item_name | Tampering | Ported `sanitizeInput` (parity with Sheets) — admin/BrewPad escape on render (`escapeHTML`) remains the second layer |
| Hijacking another recipe's `ingredient_id` through the update payload | Tampering | D-09 rule (honour only own, unclaimed ids) + PK uniqueness |
| Lost update by a stale editor | Tampering/Repudiation | D-03 `expected_updated_at` compare under row lock |
| Anonymous enumeration of draft recipes | Info disclosure | Existing 404-indistinguishable behaviour preserved |
| Price drift between stores charging the wrong amount | Tampering (integrity) | D-05 dual compare, D-06 PG price charged, parity tests, Phase 73 `ingredientLineCost` fail-closed untouched |
| PII (staff email in `created_by`) leaking via verify/rejects/Sentry | Info disclosure | Output limited to ids/field names/counts; `compareAndReport` without `reportValuesFor` for text fields; rejects files stay outside the repo |
| Formula injection into the Sheet through the mirror (`=IMPORTRANGE(...)`) | Tampering | Pre-existing in `createRecipe`/`appendRow`; mirror must not widen it; note for a later hardening item (out of scope) |
| Shared Apps Script deployment: new actions reachable with the server token only | Elevation | Add inside the existing `payload.server_token` branch (L270-340); no new auth path; read-only `recipe_batch_ref_count` |

## Sources

### Primary (HIGH confidence — direct reads this session)
- `zoho-middleware/routes/recipes.js` (full), `routes/pos-recipe.js` L1-330, L376-545, L700-760, L1076-1103, `lib/recipe-scaling.js` L1-60, L120-200, L340-440, `lib/store-flag.js`, `lib/sheet-mirror.js`, `lib/dual-write-compare.js`, `lib/gift-card-store.js`, `lib/gift-card-pg.js` L1-120, `lib/db.js`, `scripts/migration-allowlist.js` L1-330, `migrations/0001_init.sql`, `0002_gift_cards.sql`, `scripts/backfill/*` (README, gift-cards-backfill.js, gift-cards-verify.js, normalize.js, specs/), `__tests__/db/helpers/pg-harness.js`, `__tests__/recipes.test.js` (header), `__tests__/gift-cards-store-mode.test.js` (header), `server.js` L165-200, L290-320, L870-920
- `apps-script/adminApi.gs`: doGet recipe dispatch L219-227, doPost server_token recipe/gift-card dispatch L262-340, staff dispatch L532-546, helpers L1441/L1615-1740/L1789-1890, `sanitizeInput` L3913, `_cachedGet` L3859, recipe CRUD L3955-4600, `mirrorGiftCardState` L5320-5430
- `js/admin.js` L8372-8575, L8930-9068, L9080-9100; `js/brewpad.js` L3193-3345, L5380-5420
- `docs/RUNBOOK.md` L225-282 (Apps Script deploy), L519-700 (Phase 84 procedure)
- `.planning/phases/84-giftcards-postgres/` 84-11-SUMMARY, 84-DUAL-LOG, 84-RESEARCH (validation/security/env sections), deferred-items; `.planning/notes/sheets-to-postgres-data-conversion.md` L310-320; ROADMAP Phase 85; REQUIREMENTS DB-04
- **Production snapshot `~/sv-backfill/prod-after.xlsx` (2026-10-06): Recipes + RecipeIngredients tabs only, read via exceljs** — counts, types, decimal places, defects
- Memory notes: recipe-pricing-unit-bug, railway-postgres-is-v18, phase-84-giftcards-status, phase-83-postgres-infra-status, zoho-tax-rounding-entity-level, MEMORY.md index

### Secondary (MEDIUM confidence)
- None required (no external library research — all in-repo patterns; no new packages).

### Tertiary (LOW confidence)
- Apps Script web-app quota behaviour under one extra `get_recipe` per quote (A8) — not verified against Google docs this session.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all versions read from the local install.
- Architecture: HIGH for data flow and reuse mapping (file:line evidence); MEDIUM for the mirror worker / D-05 gating design (new design, reasoned from Phase 84 patterns and the Apps Script cache behaviour).
- Pitfalls: HIGH — Pitfalls 2-4 are evidenced by the real snapshot and source; 5/7/8 are derived from read code paths.

**Research date:** 2026-10-07
**Valid until:** ~2026-11-06 for code references (phase is gated on Phase 84's flip; re-grep `routes/recipes.js` / `pos-recipe.js` line numbers if either file changes before planning executes); the prod-data findings (Pitfalls 2-3) must be re-checked against a fresh snapshot at cutover.
