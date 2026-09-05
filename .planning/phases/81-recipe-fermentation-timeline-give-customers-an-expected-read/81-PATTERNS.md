# Phase 81: Recipe fermentation timeline — Pattern Map

**Mapped:** 2026-09-05
**Files analyzed:** 11 modified files (0 new files — this phase is additive-within-existing-files only) + 4 test files to extend
**Analogs found:** 11 / 11 (every file has a direct, verified in-repo analog; several files serve as their own analog for a sibling change)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps-script/adminApi.gs` — `ensureRecipesScheduleIdColumn` (new fn) | migration | CRUD (schema self-migration) | `ensureRecipesPricingModeColumn` (`apps-script/adminApi.gs:3592-3601`) | exact |
| `apps-script/adminApi.gs` — `createRecipe` (~3607) persist `schedule_id` | controller (Apps Script action handler) | CRUD (write) | same function's own `pmCol`/`normalizePricingMode` block (`:3648-3651`) | exact |
| `apps-script/adminApi.gs` — `updateRecipe` (~3703) persist `schedule_id` | controller | CRUD (write) | same function's own `pmCol` self-migration + `stringFields` array (`:3736-3746`, `:3777`) | exact |
| `apps-script/adminApi.gs` — `createFermSchedule`/`updateFermSchedule`/`deleteFermSchedule` cache-bust (discretionary, Pitfall 3) | service (mutation handler) | event-driven (cache invalidation) | `_invalidateBatchCache` (`apps-script/adminApi.gs:3433-3440`) | role-match (function to call, not copy) |
| `zoho-middleware/routes/recipes.js` — `fetchFermSchedules()` (new fn, GET+server_token) | service | request-response (outbound HTTP) | `dedupPromise` GET block in `zoho-middleware/routes/pos.js:3317-3339` | exact |
| `zoho-middleware/routes/recipes.js` — `maxNonPackagingOffset()` + `enrichFermentDays()` (new fns) | transform | transform (pure derivation + list enrichment) | `enrichWithComputedPrice`/`enrichListPrices` (`zoho-middleware/routes/recipes.js:158-260`) | exact |
| `zoho-middleware/routes/recipes.js` — `PUBLIC_RECIPE_FIELDS`/`toPublicRecipe` (~line 71-91) | transform | transform (allowlist projection) | itself — extend the existing array/function, don't create a new one | exact (self) |
| `zoho-middleware/lib/constants.js` — new `CACHE_KEYS.FERM_SCHEDULES` entry | config | — | `CACHE_KEYS.KIOSK_PRODUCTS`/`RECIPE_AVAILABILITY` entries (`zoho-middleware/lib/constants.js:23`, `:83`) | exact |
| `js/modules/07-catalog-kits.js` — `buildRecipeCard` 2nd `.price-col` + `fermentTimeDisplay()` helper | component | transform (DOM builder) | `buildLabelPriceFooter()` (`js/modules/04-label-cards.js:104-159`) — **copy the idiom, never call the function** | exact (sibling pattern) |
| `css/styles.css` — `.ferment-time-value`/`.ferment-time-weeks`/`.ferment-time-start` | config (styling) | — | `.label-beer .price-value`/`.price-col`/`.price-label` (`css/styles.css:4714-4718`) | exact |
| `beer.html` (lines 179, 318) | template (static copy) | — | itself — in-place text replacement, no structural analog needed | exact (self) |
| `admin.html` — recipe editor schedule picker field (~508-521) | component (form field) | CRUD (form input) | the sibling Batch Size/ABV/IBU/Colour fields in the same `.recipes-form-grid--narrow` block (`admin.html:507-521`) | exact |
| `js/admin.js` — `populateRecipeForm()` load + `saveRecipe()` save (schedule_id round-trip) | controller (form load/save) | CRUD | same functions' own `pricing_mode`/`status` field handling (`js/admin.js:8784-8785`, `:9082`) | exact (self) |
| `js/admin.js` — recipe-editor D-11 warning span | component | event-driven (form-state → inline message) | `renderAvailabilityBanner()` (`js/admin.js:8789` on) | role-match |
| `js/admin.js` — `initRecipesTab()` schedule-data lazy-load fix (Pitfall: `fermSchedulesData` empty) | controller (tab lifecycle) | event-driven | `triggerBatchLoad()`/`initTabNavigation` batch hook (`js/admin.js:8487-8503`) | exact |
| `js/admin.js` — `#batch-schedule-select`/`#sa-schedule-select` pre-selection (D-04) | component | CRUD (default value) | the dropdowns' own existing option-building loops (`js/admin.js:6997-7000`, `:7346-7352`) | exact (self) |
| `js/admin.js` — `showBeerXMLReviewModal()` meta-line + template dropdown + D-14 compare | component (modal builder) | request-response (client-side, no network) | its own existing `metaLine` conditional-segment pattern (`js/admin.js:9508-9511`) | exact (self) |
| `js/admin.js` — `confirmBeerXMLImport()` carry `schedule_id` through | controller | CRUD (form population) | its own existing `populateRecipeForm({...})` object literal (`js/admin.js:9702-9709`) | exact (self) |
| `js/admin.js` — `parseBeerXML()` timing-field extraction | transform | transform (XML → JS object) | its own existing `EST_ABV`/`BATCH_SIZE`/`IBU`/`EST_COLOR` field reads (`js/admin.js:9313-9318`) | exact (self) |
| `js/admin.js` — `renderScheduleForm()` D-15 blast-radius note | component (modal builder) | event-driven (informational banner) | `.availability-banner--low` reuse, same shape as the recipe-editor D-11 warning above | role-match |
| Test: `zoho-middleware/__tests__/recipes-public-guard.test.js` (extend) | test | — | itself, `describe('Public recipe read contract (D-05/D-06/D-07)', ...)` at line 152 | exact |
| Test: `zoho-middleware/__tests__/recipes.test.js` (extend) | test | — | itself, `describe('GET /api/recipes', ...)` at line 90 | exact |
| Test: `tests/frontend/catalog-recipe-block.test.js` (extend) | test | — | itself, `describe('buildRecipeCard', ...)` at line 63 | exact |
| Test: `tests/frontend/admin-beerxml.test.js` (extend) | test | — | itself, `describe('parseBeerXML', ...)` at line 116 | exact |

---

## Pattern Assignments

### `apps-script/adminApi.gs` — `ensureRecipesScheduleIdColumn` (new, migration)

**Analog:** `ensureRecipesPricingModeColumn` (`apps-script/adminApi.gs:3592-3601`)

**Full pattern to copy verbatim, renaming the column and function** (verified exact text):
```javascript
/**
 * Self-migrating helper: the Recipes sheet originally shipped without a
 * pricing_mode column, so the value was dropped on save and recipes always
 * reverted to 'locked'. Add the column (at the end) the first time we write,
 * so pricing_mode persists and round-trips via sheetToObjects' header mapping.
 * Existing rows read as '' which the frontend treats as 'locked'
 * (backward-compatible). Returns the zero-based column index.
 */
function ensureRecipesPricingModeColumn(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = headers.indexOf('pricing_mode');
  if (idx === -1) {
    sheet.getRange(1, lastCol + 1).setValue('pricing_mode').setFontWeight('bold');
    return lastCol; // zero-based index of the newly added column
  }
  return idx;
}
```
Write `ensureRecipesScheduleIdColumn(sheet)` as a byte-for-byte structural copy, substituting `'schedule_id'` for `'pricing_mode'` in the doc comment and the `indexOf`/`setValue` calls. No `normalizePricingMode`-equivalent is needed — `schedule_id` is a plain string, not an enum.

**Where it's called — `createRecipe`** (`apps-script/adminApi.gs:3607` region): the existing call site pattern (verified, `:3648-3651`):
```javascript
// Persist pricing_mode by header lookup (column is self-migrated if missing)
var pmCol = ensureRecipesPricingModeColumn(recipesSheet);
recipesSheet.getRange(recipesSheet.getLastRow(), pmCol + 1)
  .setValue(normalizePricingMode(payload.pricing_mode));
```
Copy this shape for `schedule_id`, dropping the normalize call: `.setValue(sanitizeInput(payload.schedule_id || ''))`.

**Where it's called — `updateRecipe`** (`apps-script/adminApi.gs:3730-3746`, exact verified text): the critical **ordering rule** is already documented inline and MUST be preserved for the new column:
```javascript
// D-08 ordering: run the self-migrating pricing_mode column BEFORE the row is read, and
// unconditionally (not gated on payload.pricing_mode being present) -- the column may
// need to migrate on any save. ensureRecipesPricingModeColumn() may append a header cell,
// widening the row; findRowById() returns headers from a stale, already-populated
// _sheetCache entry when one exists, so reading the row first would yield a short header
// array and the batched setValues() below would then write a stale-width row. Invalidate
// the cache immediately after so findRowById() below re-reads the (possibly new) width.
var pmCol = ensureRecipesPricingModeColumn(recipesSheet);
invalidateSheetCache(RECIPES_SHEET_NAME);

var result = findRowById(RECIPES_SHEET_NAME, payload.recipe_id);
```
Call `ensureRecipesScheduleIdColumn(recipesSheet)` in the SAME unconditional spot, before `invalidateSheetCache`. Then add `'schedule_id'` to the existing `stringFields` array (`apps-script/adminApi.gs:3777`, exact verified text):
```javascript
var stringFields = ['name', 'style', 'description', 'status', 'notes'];
```
→ becomes `['name', 'style', 'description', 'status', 'notes', 'schedule_id']`. This round-trips `schedule_id` through the existing single-ranged-write / formula-safety-fallback path (`:3803-3823`) with zero new branching — the same batched-`setValues`-with-per-cell-fallback logic already handles it.

**Why NOT the Phase 80 fail-closed pattern:** `ensureWaitlistSheet()` (`apps-script/adminApi.gs:4874`) is a validator that returns `{ok:false}` if any of 13 headers is missing — a different mechanism for a different risk profile (13 columns, all load-bearing at once). `ensureRecipesPricingModeColumn`/`ensureRecipesScheduleIdColumn` self-heal one column, no redeploy-ordering step required.

---

### `apps-script/adminApi.gs` — schedule-CRUD cache-bust (discretionary, Pitfall 3)

**Analog:** `_invalidateBatchCache` (`apps-script/adminApi.gs:3433-3440`, exact verified text):
```javascript
function _invalidateBatchCache(batchId) {
  var cache = CacheService.getScriptCache();
  var keys = ['gbl', 'gtu', 'gbds', 'gbi', 'gfs'];
  if (batchId) {
    keys.push('gb:' + batchId);
    keys.push('gbp:' + batchId);
  }
  cache.removeAll(keys);
```
`'gfs'` is already in this list but `createFermSchedule`/`updateFermSchedule`/`deleteFermSchedule` (`:3140`, `:3185`, `:3357`, all verified — contain zero `CacheService` calls) never call it. If the plan takes this on: add `CacheService.getScriptCache().remove('gfs');` (one line, not the whole `_invalidateBatchCache` call — that function also busts batch keys that are irrelevant here) to the end of all three functions, mirroring `deleteFermSchedule`'s existing `sheet.getRange(...).setValue(...)` return-shape (`:3357-3372`, verified: soft-delete via `is_active`/`last_updated`, `return { ok: true, message: '...' }`).

---

### `zoho-middleware/routes/recipes.js` — `fetchFermSchedules()` (new, GET+server_token)

**Analog:** the dedup-fetch GET block in `zoho-middleware/routes/pos.js:3317-3339` (exact verified text):
```javascript
// --- Date-window mode ---
// Step 1: Dedup pre-check (D-10.1) — fetch existing batches from Apps Script
// CRITICAL: use server_token (not token) — adminApi.gs reads e.parameter.server_token (~line 95)
// e.parameter.token (~line 402) is Google OAuth-validated and WILL fail for server tokens.
var existingSoNumbers = {};
var appsScriptUrl = process.env.APPS_SCRIPT_URL;
var serverToken = process.env.APPS_SCRIPT_SERVER_TOKEN;

var dedupPromise;
if (appsScriptUrl && serverToken) {
  dedupPromise = axios.get(appsScriptUrl, {
    params: { action: 'get_batches', server_token: serverToken, status: 'all' },
    timeout: 12000
  }).then(function (resp) {
    var respData = resp.data || {};
    if (!respData.ok) {
      log.warn('[batch/scan-invoices] get_batches dedup returned ok:false — treating dedup set as empty (D-10.2 is backstop)');
      return;
    }
    var batches = (respData.data && respData.data.batches) || [];
    batches.forEach(function (b) {
      if (b.zoho_so_number) existingSoNumbers[b.zoho_so_number] = true;
    });
  }).catch(function (err) {
    log.warn('[batch/scan-invoices] get_batches dedup failed (non-fatal): ' + err.message + ' — treating dedup set as empty (D-10.2 is backstop)');
  });
}
```
**Copy the `axios.get(url, {params:{action, server_token, ...}, timeout:12000})` shape exactly.** Substitute `action: 'get_ferm_schedules'`, response shape `resp.data.data.schedules` (per `apps-script/adminApi.gs:185-192`'s `_cachedGet('gfs', 300, function(){ return getFermSchedules(); })` → `getFermSchedules()` returns `{schedules: [...]}`). **Do NOT use `callAppsScriptPost`** (the file's existing POST helper, `zoho-middleware/routes/recipes.js:24-38`) — `get_ferm_schedules` is not in `doPost`'s server_token allow-list (verified: `apps-script/adminApi.gs:262-329` hardcoded if-chain omits it); `doGet`'s bypass already dispatches it and is already cached server-side at 300s.

---

### `zoho-middleware/routes/recipes.js` — `maxNonPackagingOffset()` + `enrichFermentDays()`

**Analog:** `enrichWithComputedPrice`/`enrichListPrices` (`zoho-middleware/routes/recipes.js:158-260`, exact verified excerpt of the detail-path enrichment):
```javascript
function enrichWithComputedPrice(recipe, ingredients) {
  if (!recipe || recipe.pricing_mode !== 'dynamic') return Promise.resolve();
  return cache.get(C.CACHE_KEYS.INGREDIENTS_ALL).then(function (catalog) {
    if (!catalog || !Array.isArray(catalog)) return;
    ...
  }).catch(function () {});
}
```
Copy the **shape**, not the pricing logic: an early-return guard clause (`if (!recipe.schedule_id) return recipes;` equivalent), a `cache.get(...)` lookup with a graceful `.catch(function(){})` fallback that never throws, applied inside the existing GET-list (`enrichListPrices` is called at `:336`/`:352`) and GET-detail (`enrichWithComputedPrice` called at `:392`/`:408`) call sites — call the new `enrichFermentDays(recipes)` in the SAME places, before `sendRecipeList`/`sendRecipeDetail`/`toPublicRecipe` run, exactly mirroring how price enrichment already happens before the public projection.

**`maxNonPackagingOffset` — pure derivation, no I/O:**
```javascript
function maxNonPackagingOffset(schedule) {
  var steps = (schedule && (schedule.steps_parsed || [])) || [];
  var max = null;
  steps.forEach(function (s) {
    if (s && s.is_packaging !== true && typeof s.day_offset === 'number') {
      if (max === null || s.day_offset > max) max = s.day_offset;
    }
  });
  return max;
}
```
(RESEARCH.md's Code Examples section — already verified against `getFermSchedules()`'s `steps_parsed` shape at `apps-script/adminApi.gs:1784-1794`, confirmed: `s.steps_parsed = JSON.parse(s.steps)` when `steps` is a string.) **This exact function must ALSO be written in `js/admin.js` for D-14's client-side compare** — see the BeerXML modal section below. Keep both copies byte-identical; cross-reference each other's file:line in a comment, per RESEARCH.md Pattern 2.

---

### `zoho-middleware/routes/recipes.js` — `PUBLIC_RECIPE_FIELDS`/`toPublicRecipe` (extend, D-16)

**Analog:** itself — this is a one-line extension of an existing array, not a new pattern. Exact current text (`zoho-middleware/routes/recipes.js:71`, verified):
```javascript
var PUBLIC_RECIPE_FIELDS = ['recipe_id', 'name', 'style', 'description'];
```
→ `['recipe_id', 'name', 'style', 'description', 'ferment_days']`. The build-by-allowlist function itself (`:80-91`, verified) needs NO changes — it already copies only allowlisted fields generically:
```javascript
function toPublicRecipe(recipe) {
  var src = recipe || {};
  var out = {};
  PUBLIC_RECIPE_FIELDS.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(src, field)) {
      out[field] = src[field];
    }
  });
  ...
  return out;
}
```
`enrichFermentDays()` must run and set `recipe.ferment_days` on the SOURCE object BEFORE `toPublicRecipe` is called (list path: `:305-360`; detail path: `:367-421`, both verified) — otherwise `hasOwnProperty` finds nothing and the field silently never appears, exactly the T-74-04 "invisible until explicitly listed" mechanism working as intended in the other direction.

---

### `zoho-middleware/lib/constants.js` — new `CACHE_KEYS.FERM_SCHEDULES`

**Analog:** existing `RECIPES`/`RECIPE_AVAILABILITY` entries in the same block (`zoho-middleware/lib/constants.js:79-83`, verified):
```javascript
  // Recipes (Apps Script sourced, Redis cached)
  RECIPES:             'sv:recipes',
  RECIPES_TS:          'sv:recipes:ts',
  RECIPE_AVAILABILITY: 'sv:recipe-availability',  // append ':' + recipe_id (Phase 52-05 M8)
```
Add `FERM_SCHEDULES: 'sv:ferm-schedules',` in the same section, same naming convention (`sv:` prefix, kebab-case suffix). This is a **shared-lib change** per CLAUDE.md rule 7 — run the FULL frontend + middleware test suites after.

---

### `js/modules/07-catalog-kits.js` — `buildRecipeCard` 2nd `.price-col` + `fermentTimeDisplay()`

**Analog — the idiom to copy (NEVER call this function):** `buildLabelPriceFooter()` (`js/modules/04-label-cards.js:104-159`, exact verified excerpt showing the "1-or-2 `.price-col`, CSS draws the divider" pattern):
```javascript
function buildLabelPriceFooter(product, opts) {
  ...
  var footer = document.createElement('div');
  footer.className = 'price-footer';

  if (instore) {
    var col1 = document.createElement('div');
    col1.className = 'price-col';
    var lbl1 = document.createElement('div');
    lbl1.className = 'price-label';
    lbl1.textContent = 'Ferment in store';
    col1.appendChild(lbl1);
    var val1 = document.createElement('div');
    val1.className = 'price-value';
    ...
    col1.appendChild(val1);
    footer.appendChild(col1);
  }

  if (kit) {
    var col2 = document.createElement('div');
    col2.className = 'price-col';
    ...
    footer.appendChild(col2);
  }

  return footer;
}
```
**Why this is a sibling, not a callable dependency (RESEARCH.md Pattern 3, confirmed by reading both functions in full this session):** `buildLabelPriceFooter` takes a `product` shape (`retail_instore`/`retail_kit`/`discount`/`pricing_from`) and lives in `04-label-cards.js`; `buildRecipeCard` takes a `recipe` shape (no discount/kit fields) and lives in `07-catalog-kits.js`. They are structurally parallel implementations of the same CSS idiom, not a shared abstraction — `buildRecipeCard` must NOT import or call `buildLabelPriceFooter`. It also uses `.innerHTML` internally for its strikethrough case (`js/modules/04-label-cards.js:124`) — that is fine for THAT function; it is NOT license to add `innerHTML` to `buildRecipeCard`, which must stay `createElement`/`textContent`-only (T-74-12).

**Exact current `buildRecipeCard` body** (`js/modules/07-catalog-kits.js:181-238`, verified, insertion point marked):
```javascript
function buildRecipeCard(recipe, doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  var card = d.createElement('div');
  card.className = 'label-beer';
  card.setAttribute('data-recipe-id', recipe.recipe_id);
  var body = d.createElement('div');
  body.className = 'label-body';
  appendSvLogo(d, body);
  ...
  card.appendChild(body);

  var footer = d.createElement('div');
  footer.className = 'price-footer';
  var priceCol = d.createElement('div');
  priceCol.className = 'price-col';
  var priceLabel = d.createElement('div');
  priceLabel.className = 'price-label';
  priceLabel.textContent = 'Ferment in store';
  priceCol.appendChild(priceLabel);
  var priceValue = d.createElement('div');
  priceValue.className = 'price-value';
  priceValue.textContent = recipeDisplayPrice(recipe);
  priceCol.appendChild(priceValue);
  footer.appendChild(priceCol);
  card.appendChild(footer);          // <<< INSERT the new timeCol block BEFORE this line

  card.appendChild(buildWaitlistCtaLink(d));
  return card;
}
```
Insert the new `.price-col` (full snippet already locked in UI-SPEC.md §1) between `footer.appendChild(priceCol);` and `card.appendChild(footer);`. Colocate `fermentTimeDisplay(recipe)` near `recipeDisplayPrice()` in the same module (module already exports both via `module.exports` at the bottom of the file — check the export list and add `fermentTimeDisplay` alongside `recipeDisplayPrice`/`buildRecipeCard` so the test file's `require('../../js/modules/07-catalog-kits.js')` pattern picks it up, matching `tests/frontend/catalog-recipe-block.test.js`'s existing `mod.recipeDisplayPrice`/`mod.buildRecipeCard` usage).

**After editing this module, run `npm run build`** — `js/main.js`/`js/main.min.js` are build artifacts (CLAUDE.md rule 8/9).

---

### `css/styles.css` — new ferment-time value classes

**Analog:** `.label-beer .price-value`/`.price-col`/`.price-label` (`css/styles.css:4713-4718`, exact verified text):
```css
.label-beer .price-footer { width: 100%; display: flex; border-top: 1px solid var(--color-gold); background: rgba(184,150,62,0.06); }
.label-beer .price-col { flex: 1; padding: 0.6rem 0.5rem; text-align: center; }
.label-beer .price-col + .price-col { border-left: 1px solid rgba(184,150,62,0.3); }
.label-beer .price-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-gold-dark); font-weight: 700; }
.label-beer .price-value { font-family: var(--font-condensed); font-size: 1.1rem; font-weight: 600; color: var(--color-burgundy); }
```
**No changes needed to these 5 lines** — `.price-col + .price-col`'s divider fires automatically the instant a 2nd `.price-col` exists in the DOM (already proven on kit cards). Add ONLY the new modifier classes adjacent to this block (exact CSS is locked in UI-SPEC.md §1 — `.ferment-time-value`/`.ferment-time-weeks`/`.ferment-time-start`, using `--font-body` NOT `--font-condensed`, and `--color-muted-dark` NOT `--color-burgundy`, per the UI-SPEC's visual-hierarchy and Oswald-fallback-bug rationale).

---

### `beer.html` — copy passages (lines 179, 318)

**Analog:** self — plain in-place text replacement inside existing `<p>` tags. Exact replacement copy is fully locked in CONTEXT.md's `<specifics>` and UI-SPEC.md §2 (verbatim, do not re-derive). No CSP change (confirmed against `docs/TRACKING.md`'s trigger list — no new third-party origin).

---

### `admin.html` — recipe editor schedule picker field (~508-521)

**Analog:** sibling fields in the same `.recipes-form-grid.recipes-form-grid--narrow` block (`admin.html:507-521`, exact verified text):
```html
<div class="recipes-form-grid recipes-form-grid--narrow">
  <div class="recipes-form-field">
    <label for="recipe-batch-size">Batch Size (L)</label>
    <input type="number" id="recipe-batch-size" class="admin-input" step="0.1" min="0" inputmode="decimal" />
  </div>
  <div class="recipes-form-field">
    <label for="recipe-abv">ABV (%)</label>
    <input type="number" id="recipe-abv" class="admin-input" step="0.1" min="0" inputmode="decimal" />
  </div>
  <div class="recipes-form-field">
    <label for="recipe-ibu">IBU</label>
    <input type="number" id="recipe-ibu" class="admin-input" step="1" min="0" inputmode="numeric" />
  </div>
  <div class="recipes-form-field">
    <label for="recipe-colour">Colour (SRM)</label>
    <input type="number" id="recipe-colour" class="admin-input" step="1" min="0" inputmode="numeric" />
  </div>
</div>
```
Add a 5th `.recipes-form-field` (exact markup locked in UI-SPEC.md §3) to this SAME grid — CSS already handles a 5th item wrapping onto a new row at `repeat(4, 1fr)` (`css/admin.css:3020-3022`, verified), no grid-template change needed. The `<select>`'s option-building loop copies `#batch-schedule-select`'s loop (`js/admin.js:6997-7000`, verified):
```javascript
html += '<div class="form-group"><label>Fermentation Schedule</label><select id="batch-schedule-select" class="admin-select"><option value="">Select a template...</option>';
fermSchedulesData.forEach(function (s) {
  html += '<option value="' + s.schedule_id + '">' + s.name + (s.category ? ' (' + s.category + ')' : '') + '</option>';
});
html += '</select></div>';
```

---

### `js/admin.js` — `populateRecipeForm()` load / `saveRecipe()` save (schedule_id round-trip)

**Analog:** these functions' own existing field-handling lines — no external analog needed, extend in place.

`populateRecipeForm()` (`js/admin.js:8771-8787`, exact verified text — the line to add sits right after `recipe-colour`):
```javascript
function populateRecipeForm(recipe) {
  var r = recipe || {};
  document.getElementById('recipe-name').value = r.name || '';
  document.getElementById('recipe-style').value = r.style || '';
  document.getElementById('recipe-description').value = r.description || '';
  document.getElementById('recipe-batch-size').value = r.batch_size_l || '';
  document.getElementById('recipe-abv').value = r.abv || '';
  document.getElementById('recipe-ibu').value = r.ibu || '';
  document.getElementById('recipe-colour').value = r.colour_srm || '';
  // NEW: document.getElementById('recipe-schedule-select').value = r.schedule_id || '';
  document.getElementById('recipe-locked-price').value = r.locked_price || '';
  ...
  var pricingModeSelect = document.getElementById('recipe-pricing-mode');
  if (pricingModeSelect) pricingModeSelect.value = r.pricing_mode || 'locked';
  _recipesState.previousStatus = r.status || 'draft';
  document.getElementById('recipe-status-error').textContent = '';
  // NEW: call renderScheduleWarning() here too (see D-11 below), since re-populating
  // the form after a schedule change should refresh the warning immediately.
}
```
`saveRecipe()`'s `formData` object literal (`js/admin.js:9074-9093`, exact verified text):
```javascript
var formData = {
  name: document.getElementById('recipe-name').value.trim(),
  style: document.getElementById('recipe-style').value.trim(),
  description: document.getElementById('recipe-description').value.trim(),
  batch_size_l: parseFloat(document.getElementById('recipe-batch-size').value) || 0,
  abv: parseFloat(document.getElementById('recipe-abv').value) || 0,
  ibu: parseInt(document.getElementById('recipe-ibu').value, 10) || 0,
  colour_srm: parseInt(document.getElementById('recipe-colour').value, 10) || 0,
  // NEW: schedule_id: document.getElementById('recipe-schedule-select').value || null,
  pricing_mode: document.getElementById('recipe-pricing-mode') ? document.getElementById('recipe-pricing-mode').value : 'locked',
  ...
};
```
Follow the exact same `document.getElementById(...).value` idiom used by every other field here — no new helper function needed for this part.

---

### `js/admin.js` — D-11 recipe-editor warning span

**Analog:** `renderAvailabilityBanner()` (`js/admin.js:8789` on, verified structure — a live, non-blocking, form-state-driven inline message):
```javascript
function renderAvailabilityBanner(availability) {
  var banner = document.getElementById('recipes-availability-banner');
  if (!banner) return;
  if (!availability) { banner.innerHTML = ''; return; }
  var classMap = { all_ok: 'availability-banner--ok', some_low: 'availability-banner--low', ... };
  var msgMap = { all_ok: 'All ingredients in stock', ... };
  var cls = classMap[availability.summary] || 'availability-banner--loading';
  var msg = msgMap[availability.summary] || 'Checking stock...';
  ...
}
```
Copy the shape: a small function reading current form state (`recipe-status` value + `recipe-schedule-select` value) and setting `#recipe-schedule-warning`'s `textContent` (per UI-SPEC.md §3's exact copy string), called from `populateRecipeForm()` and from `change` listeners on both the status select and schedule select. **CSS: add one line** reusing the existing warning token — `.recipes-inline-error--warning { color: var(--batch-warning); }` — layered on the existing `.recipes-inline-error` base rule (`css/admin.css:3046-3051`, verified: currently `color: var(--batch-danger)` red; the new modifier overrides only the color for this non-blocking case). **Must NOT be added to `validateActivation()`** (`js/admin.js:9060-9067`, verified — the actual save-blocking gate for locked-price/ingredient-count) — this is the load-bearing "warn, don't block" boundary from D-11.

---

### `js/admin.js` — `initRecipesTab()` schedule-data lazy-load fix

**Analog:** `triggerBatchLoad()` + its `initTabNavigation` hook (`js/admin.js:8487-8503`, exact verified text):
```javascript
function triggerBatchLoad() {
  if (_batchDataLoaded || _batchDataLoading) return;
  _batchDataLoading = true;
  _batchDataLoaded = true;
  loadBatchInit();
}

var _origInitTabNav = initTabNavigation;
initTabNavigation = function () {
  _origInitTabNav();
  var tabBtns = document.querySelectorAll('.admin-tab-btn');
  tabBtns.forEach(function (btn) {
    if (btn.getAttribute('data-tab') === 'batches') {
      btn.addEventListener('click', triggerBatchLoad);
      btn.addEventListener('mouseenter', triggerBatchLoad);
    }
  });
};
```
`triggerBatchLoad` is already idempotent (guarded by `_batchDataLoaded`/`_batchDataLoading`). The Recipes tab's OWN lazy-load hook (`js/admin.js:8541-8562`, exact verified text):
```javascript
function triggerRecipesLoad() {
  if (_recipesDataLoaded || _recipesDataLoading) return;
  _recipesDataLoading = true;
  _recipesDataLoaded = true;
  initRecipesTab();
}

function initRecipesTab() {
  initRecipesControls();
  loadIngredientCatalogForRecipes();
  loadRecipeList();
}
```
**Fix: add `triggerBatchLoad();` as a 4th line inside `initRecipesTab()`.** Since `triggerBatchLoad` is idempotent and cheap to call redundantly, this guarantees `fermSchedulesData` (populated by `loadBatchInit()` → `apps-script`'s combined `get_batch_init` response, verified at `js/admin.js:5636-5652`: `fermSchedulesData = (data.schedules && data.schedules.schedules) || []`) is populated before the recipe editor's schedule `<select>` renders, regardless of which tab the staff member opens first. This is the exact fix RESEARCH.md's Pitfall/Anti-Pattern section recommends.

---

### `js/admin.js` — `#batch-schedule-select`/`#sa-schedule-select` pre-selection (D-04)

**Analog:** the dropdowns' own existing option-building loops (`js/admin.js:6997-7000` and `:7346-7352`, both verified above in full). No new markup — after the existing `fermSchedulesData.forEach(...)` loop that builds `<option>`s, add one line: `select.value = recipe.schedule_id || '';` (where `recipe` is whatever recipe object the batch-create/activate flow already has in scope for that modal — confirm exact variable name at the call site during planning, since this file wasn't re-read past line ~7360 in this pass).

---

### `js/admin.js` — `showBeerXMLReviewModal()` meta-line + dropdown + D-14 compare (D-12/D-13/D-14)

**Analog:** the function's own existing conditional `metaLine` segment builder (`js/admin.js:9508-9511`, exact verified text):
```javascript
var metaLine = '';
if (parsed.style) metaLine += escapeHTML(parsed.style);
if (parsed.abv) metaLine += (metaLine ? ' &middot; ' : '') + parsed.abv.toFixed(1) + '% ABV';
if (parsed.batch_size_l) metaLine += (metaLine ? ' &middot; ' : '') + parsed.batch_size_l.toFixed(1) + ' L';
```
Add a 4th conditional segment for `parsed.ferment_days_beerxml` following this EXACT `metaLine ? ' &middot; ' : ''` join idiom (already locked in RESEARCH.md's Code Examples and UI-SPEC.md §4). The `bodyHTML` template-string builder (`js/admin.js:9515-9526`, verified — string concatenation, not DOM building, since this is a modal body) is where the new `<div class="form-group">` schedule dropdown + `<p id="beerxml-schedule-compare">` are inserted, per UI-SPEC.md §4's exact markup. **D-13 hard requirement:** the `<select>` defaults to its empty option; do not add any nearest-match pre-selection logic even though the data (`parsed.ferment_days_beerxml` vs each template's max offset) would make it easy to compute.

**D-14 compare needs its OWN copy of `maxNonPackagingOffset`** (browser runtime, cannot `require()` the middleware's Node copy) — same function body as the middleware version above, colocated near `parseBeerXML`/`renderScheduleForm` in `js/admin.js`. Cross-reference both copies' file:line in comments (RESEARCH.md Pattern 2).

---

### `js/admin.js` — `confirmBeerXMLImport()` carry `schedule_id` through

**Analog:** the function's own existing `populateRecipeForm({...})` call — this is the fix target itself, not a pattern to copy elsewhere. Exact current text (`js/admin.js:9695-9709`, verified — confirms RESEARCH.md's Pitfall claim precisely):
```javascript
function confirmBeerXMLImport(parsedRecipe, confirmedRows) {
  var modalContent = document.querySelector('.admin-modal-content');
  if (modalContent) modalContent.classList.remove('admin-modal-content--wide');
  closeModal();
  openRecipeDetail(null);
  populateRecipeForm({
    name:         parsedRecipe.name,
    style:        parsedRecipe.style,
    abv:          parsedRecipe.abv,
    batch_size_l: parsedRecipe.batch_size_l,
    ibu:          parsedRecipe.ibu,
    colour_srm:   parsedRecipe.colour_srm,
    status:       'draft'
    // NEW: schedule_id: document.getElementById('beerxml-schedule-select').value || ''
  });
  ...
}
```
Read `document.getElementById('beerxml-schedule-select').value` BEFORE `closeModal()` runs (closeModal likely tears down the modal DOM — verify ordering during planning) and add it to the object literal. Without this one line, D-12's dropdown selection is silently discarded on "Confirm Import" exactly as RESEARCH.md's Pitfall 2 predicts.

---

### `js/admin.js` — `parseBeerXML()` timing-field extraction (D-12)

**Analog:** the function's own existing field-read idiom (`js/admin.js:9312-9318`, exact verified text):
```javascript
var parsed = {
  name: getTagText(recipe, 'NAME'),
  style: style,
  abv: parseFloat(getTagText(recipe, 'EST_ABV')) || 0,
  batch_size_l: parseFloat(getTagText(recipe, 'BATCH_SIZE')) || 0,
  ibu: parseFloat(getTagText(recipe, 'IBU')) || parseFloat(getTagText(recipe, 'EST_IBU')) || 0,
  colour_srm: parseFloat(getTagText(recipe, 'EST_COLOR')) || 0,
  ingredients: []
};
```
Add fields using the identical `getTagText(recipe, 'TAG_NAME')` + `parseFloat(...) || 0` idiom for `PRIMARY_AGE`/`SECONDARY_AGE`/`TERTIARY_AGE`, then sum non-zero values into `ferment_days_beerxml` (display-only per D-01 — never written to the recipe, only shown in the meta-line). Omit the field entirely (don't set to 0) when all three tags are absent, matching this function's own existing convention of `|| 0` defaults being distinguished from "field was present" at the call site (the meta-line's `if (parsed.ferment_days_beerxml)` guard, matching the `if (parsed.abv)` guard already in `showBeerXMLReviewModal`).

---

### `js/admin.js` — `renderScheduleForm()` D-15 blast-radius note

**Analog:** the function's own existing field-block insertion order (`js/admin.js:7576-7607`, verified — Name → Description → Category, each a `html +=` append) PLUS the `.availability-banner--low` reuse already established for D-11 above. Exact insertion point (verified, right after the Category `<select>` closes, before `<h4>Fermentation Steps</h4>`):
```javascript
html += '</select></div>';   // end of Category field, verified exact text

// NEW — D-15 (only when isEdit AND usedByCount > 0):
// html += '<p class="availability-banner availability-banner--low" ...>Used by N public recipe(s). Changing day offsets will change what customers are told.</p>';

html += '<h4>Fermentation Steps</h4>';   // existing, unchanged
```
`usedByCount` needs a small new helper counting `Recipes` rows whose `schedule_id` matches — this is a NEW helper with no direct in-repo analog; write it as a simple filter over whatever recipe list is already loaded client-side (`_recipesState.list`, verified to exist at `js/admin.js:8511` region) rather than a new network call.

---

## Shared Patterns

### Self-migrating sheet column (Apps Script)
**Source:** `ensureRecipesPricingModeColumn` (`apps-script/adminApi.gs:3592-3601`)
**Apply to:** the new `ensureRecipesScheduleIdColumn`. This is the ONLY correct precedent for this phase's `Recipes.schedule_id` addition — do not reach for `ensureWaitlistSheet`'s fail-closed validator pattern (`apps-script/adminApi.gs:4874`), which solves a different problem (13 interdependent headers, not 1 independent one).

### GET + server_token bypass for a `doPost`-unlisted Apps Script action
**Source:** `zoho-middleware/routes/pos.js:3323` (`axios.get(url, {params:{action, server_token}, timeout:12000})`)
**Apply to:** `fetchFermSchedules()` in `zoho-middleware/routes/recipes.js`. Never attempt to add `get_ferm_schedules` to `doPost`'s hardcoded allow-list (`apps-script/adminApi.gs:262-329`) — that surface area is unnecessary; `doGet`'s bypass + `handleReadAction`'s existing `case 'get_ferm_schedules'` (`apps-script/adminApi.gs:185-187`) already works today with zero Apps Script changes.

### Build-by-allowlist for public data (T-74-04)
**Source:** `PUBLIC_RECIPE_FIELDS`/`toPublicRecipe` (`zoho-middleware/routes/recipes.js:71-91`)
**Apply to:** the one-line `ferment_days` addition (D-16). Never delete-from-source; a field is invisible in the public shape until explicitly allowlisted.

### `createElement`-only card bodies (T-74-12)
**Source:** `buildRecipeCard` (`js/modules/07-catalog-kits.js:181-238`), contrasted against `buildLabelPriceFooter`'s permitted `.innerHTML` use (`js/modules/04-label-cards.js:124`)
**Apply to:** the new "Ready in" `.price-col` — `createElement`/`textContent` only, no exceptions, even though the sibling function in the OTHER module uses `innerHTML` for its own (different) reason.

### Warn-don't-block inline banner
**Source:** `.availability-banner`/`.availability-banner--low` (`css/admin.css:3054-3076`), and its JS driver `renderAvailabilityBanner()` (`js/admin.js:8789` on)
**Apply to:** BOTH D-11 (recipe editor, no schedule on an active recipe) and D-15 (schedule editor, blast-radius note) — one consistent warning visual language across both surfaces, never a second bespoke style.

### Cross-runtime pure derivation kept in lockstep
**Source:** none pre-existing — this is a NEW pattern this phase introduces, named explicitly so it isn't mistaken for accidental duplication
**Apply to:** `maxNonPackagingOffset(schedule)` must be written once in `zoho-middleware/routes/recipes.js` (Node, server-side `ferment_days`) and once in `js/admin.js` (browser, D-14's live compare) — same exact body, cross-referenced by comment, so a future edit to the "exclude packaging, take the max" rule doesn't silently drift between the two.

---

## No Analog Found

None. Every file/change in this phase's scope has a direct, verified, in-repo precedent — this phase is explicitly "wiring existing mechanisms together," not introducing new architecture (confirmed by RESEARCH.md's own framing: "Nothing here is architecturally novel").

---

## Metadata

**Analog search scope:** `apps-script/adminApi.gs` (full-file grep + 6 targeted reads), `zoho-middleware/routes/recipes.js` (full file, verified in this session), `zoho-middleware/routes/pos.js` (targeted read of the GET+server_token block), `zoho-middleware/lib/constants.js` (CACHE_KEYS block), `js/modules/07-catalog-kits.js` + `js/modules/04-label-cards.js` (both card-builder functions in full), `css/styles.css` (price-footer rule block), `admin.html` (recipe editor form group), `js/admin.js` (12 targeted non-overlapping reads across schedule dropdowns, tab-load hooks, form load/save, BeerXML modal, parseBeerXML, renderScheduleForm), `css/admin.css` (recipes-form + availability-banner blocks), plus 4 existing test files' `describe` blocks.
**Files scanned:** 11 source files + 4 test files, all read directly in this session (not recalled from CONTEXT.md/RESEARCH.md citations alone — independently re-verified against the live repository).
**Pattern extraction date:** 2026-09-05
