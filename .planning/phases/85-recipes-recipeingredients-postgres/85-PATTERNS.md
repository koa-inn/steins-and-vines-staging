# Phase 85: Recipes + RecipeIngredients -> Postgres - Pattern Map

**Mapped:** 2026-10-07
**Files analyzed:** 27 new/modified files
**Analogs found:** 26 / 27 (one partial: coalescing mirror worker has only a role-match)

All paths are relative to `/Users/koa/dev/steins-and-vines-website`. Middleware code is ES5 (`var`, `function`, no arrow functions); `js/admin.js` and `js/brewpad.js` are ES5 too.

Key rule from 85-RESEARCH.md that shapes every analog choice: **copy the Phase 84 shape, do not generalise it.** Phase 84's dual leg re-runs Apps Script ops and compares results. Phase 85's dual leg is (a) a state-copy mirror and (b) a price comparison. So `gift-card-store.js` is the analog for the facade skeleton, mode switch, `strip`, and transport, but NOT for `afterWrite`/`project`/`chainForCert` semantics.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `zoho-middleware/migrations/0003_recipes.sql` (NEW) | migration | batch (DDL) | `zoho-middleware/migrations/0002_gift_cards.sql` | exact |
| `zoho-middleware/lib/recipe-pg.js` (NEW) | service (atomic SQL) | CRUD (transactional) | `zoho-middleware/lib/gift-card-pg.js` | exact |
| `zoho-middleware/lib/recipe-store.js` (NEW) | service (facade) | CRUD + dual-mode dispatch | `zoho-middleware/lib/gift-card-store.js` | role-match (dual semantics differ) |
| `zoho-middleware/lib/recipe-sanitize.js` (NEW) | utility | transform | `apps-script/adminApi.gs` `sanitizeInput` (L3913) - line-for-line ES5 port | exact (port) |
| `zoho-middleware/lib/recipe-mirror.js` (NEW) | service (worker) | event-driven (coalescing retry) | `lib/gift-card-store.js` `chainForCert`/`afterWrite` + `lib/reconcile.js` `recordGiftCardReconcileFailure`/`sweepGiftCardPending` | role-match |
| `zoho-middleware/routes/recipes.js` (MODIFIED) | route/controller | request-response | itself (L25-42, L401-463, L710-800) | exact |
| `zoho-middleware/routes/pos-recipe.js` (MODIFIED) | route/controller | request-response (money path) | itself (L29-43, L167-199, L715-745) | exact |
| `zoho-middleware/server.js` (MODIFIED - one `setInterval` sweep) | config/bootstrap | event-driven (timer) | `server.js` L905-915 gift-card sweep | exact |
| `zoho-middleware/lib/reconcile.js` (MODIFIED, optional, if mirror failure reuses it) | service | event-driven | `reconcile.js` `recordGiftCardReconcileFailure` L649 | exact |
| `zoho-middleware/scripts/backfill/specs/recipes.js` (NEW) | config (spec) | batch | `scripts/backfill/specs/gift-cards.js` | exact |
| `zoho-middleware/scripts/backfill/recipes-backfill.js` (NEW) | script (CLI) | batch (file I/O -> DB) | `scripts/backfill/gift-cards-backfill.js` | exact |
| `zoho-middleware/scripts/backfill/recipes-verify.js` (NEW) | script (CLI) | batch (read-only compare) | `scripts/backfill/gift-cards-verify.js` | exact |
| `zoho-middleware/scripts/backfill/recipes-replay-to-sheet.js` (NEW) | script (CLI) | batch -> HTTP | `scripts/backfill/gift-cards-replay-to-sheet.js` | exact |
| `apps-script/adminApi.gs` NEW `mirror_recipe_state`, `mirror_recipe_delete`, `recipe_batch_ref_count` (MODIFIED) | controller (doPost action) | request-response / file-I/O | `mirrorGiftCardState` (L5350) + dispatch at L334 + recipe dispatch L280-309 | role-match |
| `js/admin.js` `saveRecipe`/`deleteRecipe` (MODIFIED) | component | request-response | itself L8940-9043 | exact |
| `js/brewpad.js` `submitRecipeSave`/`deleteRecipe` (MODIFIED) | component | request-response | itself L3226-3310 | exact |
| `js/admin.min.js`, `js/brewpad.min.js` (BUILD ARTIFACTS) | build output | - | `npm run build` (never hand-edit) | n/a |
| `docs/RUNBOOK.md` "Recipes -> Postgres (Phase 85)" (MODIFIED) | docs | - | `docs/RUNBOOK.md` L519-700 "Gift cards -> Postgres (Phase 84)" | exact |
| `.planning/phases/85-.../85-DUAL-LOG.md` (NEW) | docs | - | `.planning/phases/84-giftcards-postgres/84-DUAL-LOG.md` | exact |
| `zoho-middleware/__tests__/db/recipe-pg.test.js` (NEW) | test (real PG) | CRUD | `__tests__/db/gift-card-pg.test.js` | exact |
| `zoho-middleware/__tests__/db/recipes-backfill.test.js` (NEW) | test (real PG) | batch | `__tests__/db/gift-cards-backfill.test.js` | exact |
| `zoho-middleware/__tests__/db/recipes-rename-latency.test.js` (NEW) | test (real PG, timing) | CRUD | `__tests__/db/gift-card-pg.test.js` harness section | role-match |
| `zoho-middleware/__tests__/recipes-store-mode.test.js` (NEW) | test (unit) | request-response | `__tests__/gift-cards-store-mode.test.js` | exact |
| `zoho-middleware/__tests__/pos-recipe-store.test.js` (NEW) | test (unit) | request-response | `__tests__/pos-giftcard-store.test.js` | exact |
| `zoho-middleware/__tests__/recipe-store.test.js`, `recipe-mirror.test.js`, `recipe-dual-price.test.js` (NEW) | test (unit) | - | `__tests__/gift-card-store.test.js` | role-match |
| `zoho-middleware/__tests__/recipe-pg-parity.test.js` (NEW) | test (unit, `.gs` harness) | transform | `tests/frontend/adminapi-recipe-pure.test.js` (`new Function` over adminApi.gs) | exact |
| `zoho-middleware/__tests__/backfill/recipes-backfill-plan.test.js`, `recipes-verify.test.js`, recipes spec-headers test (NEW) | test (unit) | batch | `__tests__/backfill/gift-cards-backfill-plan.test.js`, `gift-cards-verify.test.js`, `spec-headers.test.js` | exact |
| `tests/frontend/adminapi-recipe-mirror.test.js` (NEW) | test (jsdom/fake Sheets) | file-I/O | `tests/frontend/adminapi-giftcard-mirror.test.js` | exact |
| new admin/brewpad stale-save tests (NEW, do not edit existing) | test (jsdom) | request-response | `tests/frontend/brewpad-recipe-save-resilience.test.js`, `admin-recipes.test.js` | role-match |

## Pattern Assignments

### `zoho-middleware/migrations/0003_recipes.sql` (migration, DDL)

**Analog:** `zoho-middleware/migrations/0002_gift_cards.sql` (61 lines)

**Header/comment convention + sequence** (0002 L1-16): header comment explaining additive-only and that the sequence seed is applied at backfill time via `setval` because the allowlist rejects `AlterSeqStmt` and bare `SELECT`.
```sql
-- Up Migration
create sequence gift_card_cert_seq start 1 minvalue 1;

create table gift_cards (
  cert_number text primary key check (cert_number ~ '^GC-[0-9]{6}$'),
  ...
  created_at timestamptz not null default now(),
  last_updated timestamptz not null default now()
);
```

**FK + composite index + down migration** (0002 L32-61):
```sql
create table gift_card_transactions (
  id bigserial primary key,
  cert_number text not null references gift_cards (cert_number),
  tx_ref text not null unique,
  ...
);
create index gift_card_transactions_cert_created_idx on gift_card_transactions (cert_number, created_at);

-- Down Migration
drop table gift_card_transactions;
drop table gift_cards;
drop sequence gift_card_cert_seq;
```

**Planner notes:** The full recommended DDL is already in 85-RESEARCH.md Pattern 1 (two sequences, `recipe_id` default `'SV-R-' || lpad(nextval(...)::text, 6, '0')`, `position integer not null`, `unique (recipe_id, position)`, NO `unique (recipe_id, item_id)`). Differences from 0002 to respect: unconstrained `numeric` (not `numeric(10,2)`), `on delete cascade` on the ingredient FK, drop order is child table, parent table, then both sequences. Keep SQL PG16-grammar-compatible (allowlist parser is `libpg-query@16.7.3`). Run `cd zoho-middleware && npm run migrate:guard` after writing.

---

### `zoho-middleware/lib/recipe-pg.js` (atomic SQL layer, transactional CRUD)

**Analog:** `zoho-middleware/lib/gift-card-pg.js` (612 lines)

**Module contract** (L1-29 header): never requires `pg`, never creates a pool; every function receives `client` from `db.withTransaction`; `$n` placeholders only; numerics read back through `Number()`; write results carry underscore-prefixed `_` keys for the mirror which the facade strips.

**SQL as module-level constants, `for update` lock first** (L33-52):
```javascript
var LOCK_CARD_SQL =
  'select cert_number, face_value, current_balance, status, zoho_invoice_number, ' +
  'issued_date, issued_by, notes, void_reason, created_at, last_updated ' +
  'from gift_cards where cert_number = $1 for update';
...
var NEXTVAL_SQL = "select nextval('gift_card_cert_seq') as n";
```
For recipes: `select ... from recipes where recipe_id = $1 for update` is the D-03 stale-check lock point (research Pattern 6: compare `row.updated_at.getTime()` to `new Date(expectedUpdatedAt).getTime()`).

**Pure helper style** (L76-130): small `normalizeX`, `orNull(value)`, validators returning a reason string or null. Reuse the `orNull` idiom for NULL-on-empty. Recipes need a `rowToRecipe`/`rowToIngredient` serializer that does `Number()` on every numeric (NULL to `''`), `toISOString()` on timestamps, NULL text to `''`, key order = sheet column order, and no `position` key leaked (Pitfall 1).

**Error contract:** business rejections resolve `{ok:false, error:'...'}` (never throw); infra invariants throw so the transaction rolls back (header L14-24 steps 3-5). Map to the Apps Script error vocabulary: `missing_fields`, `not_found`, `invalid_data`, plus new `stale_recipe`.

**Ingredient D-09 / D-04 port:** use the snippet in 85-RESEARCH.md "D-09 / D-04 in the PG module" (honour an incoming `ingredient_id` only if it is in this recipe's stored rows and not yet claimed; else let the column default mint from `recipe_ingredient_id_seq`). The source of truth for semantics is `apps-script/adminApi.gs` `updateRecipe` (L4192, D-09 block ~L4396-4417), `normalizeRecipeIngredientTuple` (L1695), `recipeIngredientsUnchanged` (L1723), `createRecipe` (L4091), `deleteRecipe` (L4487).

---

### `zoho-middleware/lib/recipe-store.js` (facade, dual-mode dispatch)

**Analog:** `zoho-middleware/lib/gift-card-store.js` (517 lines). Copy: imports, `getMode`, `isConfigured`, `callAppsScript`, `runPg`, `strip`, per-op mode switch, "never fall back to sheet read" rule. Do NOT copy: `mintTxRef`, `project`, `afterWrite` re-run semantics, `handleInfraFailure` (recipes have no post-charge write).

**Imports** (L41-46):
```javascript
var axios = require('axios');
var storeFlag = require('./store-flag');
var db = require('./db');
var giftCardPg = require('./gift-card-pg');
var sheetMirror = require('./sheet-mirror');
var dualWriteCompare = require('./dual-write-compare');
```
Recipes equivalent: `recipePg`, `sheetMirror`, `recipeMirror`; `dualWriteCompare` is used only in the pos-recipe D-05 price compare, not inside the CRUD facade.

**Mode + config** (L58-68):
```javascript
function getMode() {
  return storeFlag.resolveStoreMode('GIFT_CARDS_STORE');   // -> 'RECIPES_STORE'
}
function isConfigured() {
  var mode = getMode();
  if (mode === 'sheets') {
    return !!(process.env.APPS_SCRIPT_URL && process.env.APPS_SCRIPT_SERVER_TOKEN);
  }
  return db.isConfigured();
}
```

**Apps Script transport with defensive `Promise.resolve`** (L87-106). For recipes use the route's existing 15 s timeout and return `resp.data` untouched so existing `recipes.test.js`/`pos-recipe*.test.js` (which mock `axios`) stay green and unmodified (CLAUDE.md rule 10). Note the route copies today (`routes/recipes.js` L25-42, `routes/pos-recipe.js` L29-43) throw `Apps Script not configured` when env is missing and use `timeout: 15000`; keep that exact behaviour in `sheets` mode:
```javascript
function runPg(opName, params) {
  return db.withTransaction(function (client) {
    return giftCardPg[opName](client, params);
  });
}
function strip(result) {   // drops underscore-prefixed keys before returning to caller
  ...
}
```

**Per-op skeleton** (L227-253 `redeem`): sheets-mode short-circuit first, then PG, then post-write side effect only when `raw.ok`, then `strip(raw)`:
```javascript
if (mode === 'sheets') { return callAppsScript('redeem_gift_card', {...}); }
return runPg('redeem', pgParams).then(function (raw) {
  if (raw.ok) { afterWrite(mode, 'redeem', cert, raw, function () {...}); }
  return strip(raw);
});
```
Recipes: replace `afterWrite(...)` with `recipeMirror.schedule(raw._recipeId)` (same for `dual` and `postgres`, D-01). The facade returns the exact Apps Script response shapes (`{ok:true,data:{recipes,total,filtered}}`, `{ok:true,data:{recipe,ingredients}}`, `{ok:true,recipe_id}`, `{ok:false,error,message}`) so route diffs are a one-line swap.

**Read rule** (L399-403, 404-430): "Never falls back to a sheet read when Postgres fails (D-09)" - a DB outage rejects so the route maps it to 502.

**Exports shape** (L502-517): flat object of `getMode`, `isConfigured`, ops. Recipes: `getMode, isConfigured, list, get, create, update, remove, hasBatchReferences`.

---

### `zoho-middleware/lib/recipe-mirror.js` (worker, coalescing state-copy)

**Analogs (composite, role-match):**
1. `lib/gift-card-store.js` L48-54 and L130-141, serialised per-key tail chain:
```javascript
var certTails = {};
function chainForCert(cert, fn) {
  var prevTail = certTails[cert] || Promise.resolve();
  var tail = prevTail.then(fn, fn);
  certTails[cert] = tail;
  tail.then(
    function () { if (certTails[cert] === tail) delete certTails[cert]; },
    function () { if (certTails[cert] === tail) delete certTails[cert]; }
  );
  return tail;
}
```
2. `lib/sheet-mirror.js` L70-92 `mirrorFireAndForget(label, fn)`: the ONLY allowed production gate (never re-implement `isProductionEnvironment`). Wrap every sheet-leg call:
```javascript
sheetMirror.mirrorFireAndForget('recipes.mirror', function () {
  return chainForRecipe(recipeId, function () { return mirrorLatest(recipeId); });
});
```
3. `lib/reconcile.js` L649-700 `recordGiftCardReconcileFailure` (Redis record keyed by a stable id, never rejects, 30-day `VOID_FAILURE_TTL`) and L734-770 `sweepGiftCardPending` (`cache.getClient()` + `c.keys(PREFIX + '*')`, then `cache.get(key)` per record) for the durable Redis dirty-marker `recipe:mirror-dirty:<id>` and its 5-minute sweep.

**What is new (no analog):** the "read state from PG at send time, clear marker only if not re-set" coalescing loop and the 2 s / 10 s / 60 s / 5 min backoff then Sentry error (`component: 'recipes-mirror'`). Use `sentryCapture.captureExceptionSafe(err, { level: 'error', tags: {...} })` as in `sheet-mirror.js` L70-72. Staging is a no-op by construction because the gate is inside `mirrorFireAndForget`.

---

### `zoho-middleware/lib/recipe-sanitize.js` (utility, transform)

**Analog:** `apps-script/adminApi.gs` `sanitizeInput` (L3913), a line-for-line ES5 port, not an improvement. Parity proof via the harness in `tests/frontend/adminapi-recipe-pure.test.js` (see parity test below). Include `normalizePricingMode` (anything but `'dynamic'` becomes `'locked'`) and the tuple helpers if kept here.

---

### `zoho-middleware/routes/recipes.js` (MODIFIED, route/controller)

**Analog:** itself. Replace each `callAppsScriptPost(...)` call with `recipeStore.*` while leaving `sheets` mode byte-identical.

**Imports to extend** (L3-11): add `var recipeStore = require('../lib/recipe-store');` beside `var scaling = require('../lib/recipe-scaling');`. Pitfall 10: `recipes.test.js` mocks `constants` with only a few `CACHE_KEYS`; the new require must not read missing constants at module load.

**Call sites to swap** (current lines):
- L439 list: `callAppsScriptPost('get_recipes', { status: status, limit: limit, offset: offset })`
- L506 detail: `callAppsScriptPost('get_recipe', { recipe_id: recipeId })`
- L549 availability: `callAppsScriptPost('get_recipe', { recipe_id: recipeId })`
- L320 `enrichListPrices` per-dynamic-recipe `get_recipe`
- L717 create, L768 update, L789 delete

**Cache bypass in PG modes (Pitfall 8):** cache read/write at L429-449 (`cache.get(cacheKey)`, `cache.set(...)`) and detail cache L471-505 must be skipped when `recipeStore.getMode() !== 'sheets'`; `bustRecipeCache` (L48-58) stays harmless and `POST /api/recipes/bust-cache` (L806) stays working.

**Save-time guard stays store-agnostic and BEFORE any store write** (L713, L764, `validateIngredientUnits` L659-703, activation guardrail L746-762):
```javascript
return validateIngredientUnits(payload.ingredients).then(function (rejection) {
  if (rejection) { return res.status(422).json(rejection); }
  return callAppsScriptPost('create_recipe', payload).then(function (data) {
    if (!data.ok) {
      return res.status(422).json({ error: data.message || data.error || 'Create failed', code: 'save_failed' });
    }
    ...
```

**D-03 stale handling to add** (only when `getMode() !== 'sheets'`; D-04 keeps sheets as last-save-wins). Pass `expected_updated_at` (PUT body) / `?expected_updated_at=` (DELETE query) into the store; map `error === 'stale_recipe'` to:
```javascript
return res.status(409).json({ error: 'This recipe was changed since you opened it - reload to see the latest', code: 'stale_recipe' });
```
Insert before the existing `422 save_failed` mapping. Error handling for store/DB failures stays the existing `.catch` returning 502 (L725-728, L776-779, L796-799).

**Unchanged:** `toPublicRecipe`/`PUBLIC_RECIPE_FIELDS` allow-list (L85-100), `enrichFermentDays` (L379-394, only needs `schedule_id` truthiness, so the store must serialise NULL `schedule_id` as `''`), `isRecipeStaff` (L108).

---

### `zoho-middleware/routes/pos-recipe.js` (MODIFIED, money path)

**Analog:** itself.

**Seams** (research Pattern 7): refactor `computeRecipeQuote` (L167-199+) into `loadRecipe(recipeId)` and `priceRecipe(recipe, ingredients, rawTarget, ...)`; the body from L170 on stays unchanged. Current head:
```javascript
function computeRecipeQuote(recipeId, rawTarget, saleType, millGrain, modifiedIngredients, discountReq) {
  return callAppsScriptPost('get_recipe', { recipe_id: recipeId })
    .then(function (data) {
      if (!data || !data.ok || !data.data || !data.data.recipe) {
        return Promise.reject({ status: 404, body: { error: 'Recipe not found' } });
      }
      var recipe = data.data.recipe;
      var ingredients = data.data.ingredients || [];
      if (recipe.status !== 'active') { ... 400 'Recipe is not active' }
```
Second call site `_runRecipeConfirm` L721-727:
```javascript
return callAppsScriptPost('get_recipe', { recipe_id: body.recipe_id })
  .then(function (data) {
    if (!data || !data.ok || !data.data || !data.data.recipe) {
      return res.status(404).json({ error: 'Recipe not found' });
    }
    var recipe = data.data.recipe;
    var ingredients = data.data.ingredients || [];
```
Both must go through `recipeStore.get(recipeId)` returning this exact `{ok,data:{recipe,ingredients}}` shape. Pitfall 9: a PG outage at `/confirm` lands in the same existing `.catch` (~L1089) as an Apps Script error; keep identical, no sheet fallback.

**D-05 dual price compare** (after the PG-priced result exists): wrap in `sheetMirror.mirrorFireAndForget('recipes.price', ...)` and call `dualWriteCompare.compareAndReport` using the call shape from Phase 84 (`lib/gift-card-store.js` L187-193):
```javascript
dualWriteCompare.compareAndReport({
  store: 'recipes', operation: 'quote',   // or 'sale'
  sheets: priceProjection(sheetResult),
  postgres: priceProjection(pgResult),
  reportValuesFor: ['grandTotal', 'feePortion', 'quantity']
});
```
Gate: skip when recipe `updated_at` < 60 s old or `recipe:mirror-dirty:<id>` exists (research Pattern 7). The sale charges the PG price (D-06) and the compare never awaits on the request path. Pricing math (`lib/recipe-scaling.js`: `classifyUnit`, `ingredientLineCost`, `computeScaledRecipeTotal`) is untouched.

---

### `zoho-middleware/server.js` (MODIFIED, one sweep timer)

**Analog:** `server.js` L905-915.
```javascript
// Phase 84 D-11: Gift-card pending-write reconciliation sweep.
setInterval(function () {
  reconcile.sweepGiftCardPending().catch(function (err) {
    log.error('[reconcile] Gift-card pending sweep failed: ' + err.message);
  });
}, 5 * 60 * 1000);
log.info('[reconcile] Gift-card pending sweep registered: every 5 minutes');
```
Add a sibling `recipeMirror.sweep()` timer. `isDatabaseRequired()` (L173+) already iterates `storeFlag.STORE_ENV_NAMES` and `RECIPES_STORE` is already listed in `lib/store-flag.js` - no change needed there.

---

### `zoho-middleware/scripts/backfill/specs/recipes.js` (spec)

**Analog:** `scripts/backfill/specs/gift-cards.js` (and `plato-readings.js` column-spec shape per 84-PATTERNS). Do NOT register in `specs/index.js` (two-table job, Phase 84 Pitfall 3). Pin real headers in a new spec-headers test following `__tests__/backfill/spec-headers.test.js` (`REAL_SHEET_HEADERS` map; update spec AND list together). Recipes = 18 columns (`recipe_id ... pricing_mode, schedule_id`), RecipeIngredients = 6 columns.

---

### `zoho-middleware/scripts/backfill/recipes-backfill.js` (CLI)

**Analog:** `scripts/backfill/gift-cards-backfill.js` (801 lines). Structure to copy:

**Imports** (L28-44): `fs`, `readline`, `../../lib/db`, `./read-xlsx`, `./normalize` (`normalizeRow`, `normalizeNumeric`), `./rejects`, spec, and from `./backfill` the `EXIT`, `assertSnapshotSafePath`, `checkHeaders`.

**Pure planner exported separately from the CLI** (L300 `buildGiftCardBackfillPlan`), pure with no I/O, with the CLI behind `require.main === module` (L792). Recipes planner adds: `position` = 1-based order of the recipe's rows in sheet order; reject (never coerce) bad status/pricing_mode/timestamps (this will catch `SV-R-000001`'s swapped `created_at`/`created_by`), orphan ingredients, duplicate `ingredient_id`/`recipe_id`; never dedupe on `(recipe_id, item_id)`.

**Batched parameterised insert** (L382-409):
```javascript
function buildInsertSql(table, columns, batch) { ... placeholders '$' + params.length ... }
function insertBatched(client, table, columns, rows) { ... INSERT_BATCH_SIZE = 500 ... }
```

**In-transaction invariant checks** (L415-449 `runPromoteChecks`): returns `{ok:false, failedCheck:'name'}` naming the check only, never row contents. Recipes checks: recipe count, ingredient count, per-recipe ingredient count, `SV-R-000002` has 3 rows of one `item_id`, both sequences >= max.

**DB-name prompt** (L451-463) and **promote flow** (L477-557): preconditions (tables exist and empty) OUTSIDE the transaction via `to_regclass`, then `BEGIN`, inserts parent then child, `setval` only when seed > 0, checks, `COMMIT` or `ROLLBACK`, always `client.release()` exactly once:
```javascript
.then(function () {
  if (plan.seqSeed > 0) {
    return client.query("select setval('gift_card_cert_seq', $1)", [plan.seqSeed]);
  }
})
```
Recipes does this twice (`recipe_id_seq` from max `SV-R-` suffix, `recipe_ingredient_id_seq` from max `RI-` suffix). Sequences seed from max, never from counts (IDs have gaps).

**CLI flags** (L561-571): equals-form `--file=PATH`, `--out-dir`, `--timezone`, `--dry-run`, `--promote`; database from `BACKFILL_DATABASE_URL` only, never argv (L585 error text); no `--accept-rejects` (any reject blocks). Pool via `db.createPool(process.env.BACKFILL_DATABASE_URL, { max: 2 })` (L770), never `new Pool()`. Output ids/field names/counts only (`created_by` can hold a staff email).

---

### `zoho-middleware/scripts/backfill/recipes-verify.js` (CLI, read-only)

**Analog:** `scripts/backfill/gift-cards-verify.js` (292 lines). Copy: read-only transaction, constant SQL (L33-45), pure exported comparator with reports of `{id, field}` only (L63-95 `compareGiftCards`), reuse of the backfill planner for sheet-side normalisation, `BACKFILL_DATABASE_URL` only, `EXIT` codes. Recipes comparator: all 18 fields per recipe (timestamps by epoch-ms, numerics by `Number`, `''` equals NULL) and the ORDERED ingredient list `(ingredient_id, item_id, quantity, unit)`; flag missing-on-either-side and orphans. Test: `__tests__/backfill/gift-cards-verify.test.js` shape (`describe('compare...')`, `parseArgs`, `runVerify` with ExcelJS-built temp workbook).

---

### `zoho-middleware/scripts/backfill/recipes-replay-to-sheet.js` (CLI)

**Analog:** `scripts/backfill/gift-cards-replay-to-sheet.js` (288 lines). Dry-run default, `--apply` to push; each recipe goes through `mirror_recipe_state`. Required for dual to sheets rollback and for repairing a persistent D-02 failure.

---

### `apps-script/adminApi.gs` - `mirror_recipe_state`, `mirror_recipe_delete`, `recipe_batch_ref_count`

**Analog:** `mirrorGiftCardState` (L5350-5430+) and its dispatch (L332-336); recipe cache-eviction dispatch (L280-309).

**Dispatch registration** goes inside the same `server_token` branch, next to the gift-card mirror (additive, safe on the shared staging+prod deployment):
```javascript
// Phase 84 D-04: post-flip copy-state mirror. Postgres is authoritative; ...
if (action === 'mirror_gift_card_state') {
  return _jsonResponse(mirrorGiftCardState(payload));
}
```
**Cache eviction must be done by the dispatch (research Pattern 5):** the existing recipe handlers call `_invalidateRecipeCache` outside the function (L280-294):
```javascript
if (action === 'update_recipe') {
  var updateResult = updateRecipe(payload, 'middleware');
  _invalidateRecipeCache(payload.recipe_id);
  return _jsonResponse(updateResult);
}
```
The new `mirror_recipe_state`/`mirror_recipe_delete` dispatch must do the same, otherwise `get_recipe` (L304-309, `_cachedGet('gr:' + id, 300, ...)`) serves a 300 s stale copy and D-05 false-alarms.

**Function body pattern (lock + header-addressed write + cache invalidation)** from `mirrorGiftCardState` L5375-5409:
```javascript
var lock = acquireScriptLock(15000);
try {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };
  var existing = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
  ...
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var balCol = headers.indexOf('current_balance') + 1;       // header-addressed columns
  ...
  invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
```
Notes: `findRowById` (L1846) uses column A, so look up recipe rows by header index instead where the recipe_id column order is not guaranteed (research Pattern 5). Replace the recipe's ingredient rows with the Phase 79 D-06/D-07 technique (descending-run `deleteRows` plus one batched `setValues`) but WITHOUT re-running D-04/D-09. Write values verbatim; do NOT re-sanitise (non-idempotent for nested tags). `recipe_batch_ref_count` reads Batches fresh (not the `gbl` 300 s cache). Do not edit `createRecipe`/`updateRecipe`/`deleteRecipe`. Redeploy per RUNBOOK L225-262; record the rollback version (currently 59).

**Test:** `tests/frontend/adminapi-recipe-mirror.test.js` copying the fake-Sheets runtime of `tests/frontend/adminapi-giftcard-mirror.test.js` (L1-50: `ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs')`, `makeFakeSheet(headerRow)` with `getLastColumn/getLastRow/appendRow`, fake lock, injected as `new Function` parameters shadowing Apps Script globals).

---

### `js/admin.js` (MODIFIED) - D-03 stale-save UX

**Analog:** itself, `saveRecipe` L8940-9016 and `deleteRecipe` L9019-9043.

Current save error handling swallows every error (the problem to fix):
```javascript
.then(function (r) { return r.json(); })
.then(function (data) {
  if (!data.ok && data.error) throw new Error(data.error);
  ...
})
.catch(function () {
  showToast('Could not save recipe. Please try again.', 'error');
})
```
Needed: (1) include `expected_updated_at: _recipesState.currentRecipe && _recipesState.currentRecipe.updated_at` in `formData` for PUT (state populated at L8531: `_recipesState.currentRecipe = detail.recipe || detail;`); (2) append `?expected_updated_at=` to the DELETE URL (L9028); (3) read the HTTP status/`code` and add a `stale_recipe` branch that shows the message and offers a reload (re-run `openRecipeDetail(recipeId)`, L8492). ES5 only; no arrow functions. Follow with `npm run build` for `admin.min.js`.

---

### `js/brewpad.js` (MODIFIED) - D-03 stale-save UX

**Analog:** itself. `submitRecipeSave` (L3226-3300) already propagates `err.status`/`err.code`:
```javascript
if (!result.httpOk) {
  var httpErr = new Error((result.data && result.data.error) || ('Save failed (HTTP ' + result.status + ')'));
  httpErr.status = result.status;
  httpErr.code = result.data && result.data.code;
```
Add a `code === 'stale_recipe'` branch next to the existing `unit_mismatch` branch (~L3280-3286) and keep 409 out of the transient set (`var isTransient = !status || status === 502 || status === 503 || status === 504;` already excludes it - add a test proving it). Use the `showToast(msg, 'error', { actionLabel, onAction })` shape already used for Retry to offer "Reload". The `.catch` already calls `saveRecipeDraftNow()` so in-progress work is preserved. Delete handler at ~L3300 (`showConfirmSheet(...)` then `fetch(... 'DELETE' ...)`) swallows errors like admin.js and needs the same branch plus the DELETE query token.

---

### `docs/RUNBOOK.md` and `85-DUAL-LOG.md`

**Analogs:** RUNBOOK "Gift cards -> Postgres (Phase 84)" section L519-700 (headings: 1 Store flag, 2 Staging rehearsal, 3 After-hours cutover, 4 Dual window, 5 Scripted runsheet, 6 Flip, 7/8 Rollbacks, 9 D-10 deploy gate, 10 pending records, 11 open items, 12 release checklist) and `.planning/phases/84-giftcards-postgres/84-DUAL-LOG.md` (Header table, Op-coverage table, Discrepancy table). Recipes op-coverage rows: create, edit-with-ingredient-change, delete, kiosk recipe sale, public list/detail. Add: owner fixes `SV-R-000001` swapped cells before the dry-run; rename stopwatch (PUT < 2 s) in the runsheet; cleanup of any scripted recipe sale (staging and prod share the Zoho org and Helcim token); list of up-front "explained differences" (research Pitfall 6: missing recipe 404 vs 200+error object, Sheets 300 s stale reads, no ID reuse).

---

### Tests

**Real-Postgres tests** (`__tests__/db/recipe-pg.test.js`, `recipes-backfill.test.js`, `recipes-rename-latency.test.js`)
**Analog:** `__tests__/db/gift-card-pg.test.js` L1-60 and the harness (`__tests__/db/helpers/pg-harness.js`):
```javascript
var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('gift-card-pg atomic operations (ROADMAP SC1)', function () {
  ... // shared per-test BEGIN/ROLLBACK client via pgHarness.rollbackEachTest();
  ... // crash-then-retry and concurrency tests use their OWN dedicated pool clients (real BEGIN/COMMIT/ROLLBACK)
```
Run via `npm run test:db`; skipped locally without Docker (D-14), never skipped on CI; image is `postgres:18-alpine`. Docker daemon was down at research time.

**Route store-mode tests** (`recipes-store-mode.test.js`, `pos-recipe-store.test.js`)
**Analog:** `__tests__/gift-cards-store-mode.test.js` L1-60 - `jest.mock('express', ...)` capturing handlers from `router.get.mock.calls`, `jest.mock('axios')`, logger/eventLog/cache mocks, `jest.resetModules()` + `jest.doMock('../lib/<store>', ...)` before requiring the route; real facade for sheets mode, mocked store for dual/postgres. `routes/recipes.js` also needs `router.put`/`router.delete` in the express mock.

**Parity test** (`recipe-pg-parity.test.js`)
**Analog:** `tests/frontend/adminapi-recipe-pure.test.js` L28-45 `new Function` harness over the real `.gs`:
```javascript
var src = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8');
var gs = new Function(src + '\nreturn {normalizeRecipeIngredientTuple: normalizeRecipeIngredientTuple,' +
  'recipeIngredientsUnchanged: recipeIngredientsUnchanged, sanitizeInput: sanitizeInput};')();
```
Run a shared vector table through both the `.gs` function and `lib/recipe-sanitize.js`/the PG tuple code.

**Backfill/verify unit tests**
**Analog:** `__tests__/backfill/gift-cards-backfill-plan.test.js`, `gift-cards-verify.test.js` (`require('exceljs')`, `os`/`fs` temp files, `describe('compareGiftCards')`, `describe('parseArgs')`, `describe('runVerify')`), `spec-headers.test.js`.

## Shared Patterns

### Postgres access - single gateway
**Source:** `zoho-middleware/lib/db.js` (`withTransaction`, `createPool`, `isConfigured`)
**Apply to:** `recipe-store.js`, `recipes-backfill.js`, `recipes-verify.js`, all real-DB tests. Nothing else may `require('pg')` or `new Pool()`.

### Store-mode resolution
**Source:** `zoho-middleware/lib/store-flag.js` `resolveStoreMode`; `RECIPES_STORE` already in `STORE_ENV_NAMES`.
**Apply to:** `recipe-store.js` (every op, per call), `routes/recipes.js` (D-03 token passing and cache bypass), `routes/pos-recipe.js` (D-05 gate). Boot-time validation already exists, do not revalidate per request.

### Sheet-mirror production gate
**Source:** `zoho-middleware/lib/sheet-mirror.js` L70-92 `mirrorFireAndForget(label, fn)`
**Apply to:** the CRUD state-copy mirror AND the D-05 sheet price read. Staging has no sheet leg by construction.

### Dual-write discrepancy reporting
**Source:** `zoho-middleware/lib/dual-write-compare.js` L179 `compareAndReport({store, operation, sheets, postgres, ignoreKeys, reportValuesFor})`
**Apply to:** D-05 price comparison only (research: nothing else in Phase 85 compares). A sheet fetch failure is a mirror failure (reportFailure to Sentry warning), NOT a price discrepancy.

### Durable failure recording / sweep
**Source:** `zoho-middleware/lib/reconcile.js` L649 `recordGiftCardReconcileFailure`, L734 `sweepGiftCardPending`; `server.js` L905-915 timer.
**Apply to:** `recipe-mirror.js` dirty-marker and its 5-minute sweep. Never log full params (may carry staff email).

### Response-shape fidelity (Phase 85 specific)
**Source:** `apps-script/adminApi.gs` `getRecipes` (L3979) / `getRecipeDetail` (L4021) shapes, summarised in 85-RESEARCH.md Pattern 2.
**Apply to:** `recipe-pg.js` serializer and `recipe-store.js`. Empty cell = `''`, numerics are JS numbers, timestamps `toISOString()`, list `total` is the UNFILTERED count, ingredients in `position` order, list sorted `created_at desc, recipe_id asc`, list recipes carry `ingredient_count`, detail recipe does not.

### Existing-test protection
**Source:** CLAUDE.md rule 10 and 85-RESEARCH.md "Project Constraints".
**Apply to:** every edit of `routes/recipes.js` / `routes/pos-recipe.js`: `sheets`/unset mode must keep the exact axios call sequence mocked by `__tests__/recipes.test.js`, `recipes-public-guard`, `pos-recipe*.test.js`. All new coverage goes in NEW test files.

### Build artifacts and lint
**Apply to:** `js/admin.js`, `js/brewpad.js` edits need `npm run build` (artifact-drift CI); middleware lint is `--max-warnings 0` over `routes/ lib/ scripts/ server.js`; run `cd zoho-middleware && npm test`, root `npm test`, `npm run lint`, `npm run migrate:guard`, `npm run test:db` before commit.

## No Analog Found

| File / Concern | Role | Data Flow | Reason |
|----------------|------|-----------|--------|
| Coalescing "mirror-latest" worker logic inside `lib/recipe-mirror.js` (read PG state at send time, clear marker only if not re-set, backoff schedule) | service | event-driven | Phase 84 mirrors are per-write payloads; nothing in the codebase coalesces. Use research Pattern 5 plus the `chainForCert` and reconcile-sweep pieces above as building blocks. |
| D-03 optimistic-concurrency check (`for update` + `updated_at` epoch-ms compare) | service | CRUD | No store has a stale-write guard. Use research Pattern 6; lock idiom from `gift-card-pg.js` `LOCK_CARD_SQL`. |
| Apps Script `recipe_batch_ref_count` | controller | request-response | Read-only count over the Batches tab; no existing server_token action returns a count. Shape `{ok:true, count}`. |
| D-05 live dual price compare gating (60 s / dirty-marker skip, per-recipe sheet-fetch memo) | service | request-response | New design; only `compareAndReport` and `mirrorFireAndForget` are reusable. |

## Metadata

**Analog search scope:** `zoho-middleware/lib/`, `zoho-middleware/routes/`, `zoho-middleware/migrations/`, `zoho-middleware/scripts/backfill/` (incl. `specs/`), `zoho-middleware/__tests__/` (incl. `db/`, `backfill/`), `zoho-middleware/server.js`, `apps-script/adminApi.gs`, `js/admin.js`, `js/brewpad.js`, `tests/frontend/`, `docs/RUNBOOK.md`, `.planning/phases/84-giftcards-postgres/`
**Files read (full or targeted):** `lib/gift-card-store.js` (full), `lib/gift-card-pg.js` (1-130), `migrations/0002_gift_cards.sql` (full), `routes/recipes.js` (14-62, 400-470, 705-819), `routes/pos-recipe.js` (24-54, 160-200, 715-745), `scripts/backfill/gift-cards-backfill.js` (1-120, 380-600), `scripts/backfill/gift-cards-verify.js` (1-95), `lib/sheet-mirror.js`, `lib/dual-write-compare.js` (179-190), `lib/reconcile.js` (623-770), `server.js` (165-180, 860-930), `apps-script/adminApi.gs` (274-345, 5337-5430), `js/admin.js` (8940-9044), `js/brewpad.js` (3220-3335), `__tests__/gift-cards-store-mode.test.js` (1-60), `__tests__/db/gift-card-pg.test.js` (1-60), `tests/frontend/adminapi-giftcard-mirror.test.js` (1-50), `84-DUAL-LOG.md` (1-40), `84-PATTERNS.md`, `85-CONTEXT.md`, `85-RESEARCH.md`
**Pattern extraction date:** 2026-10-07
