# Phase 101: Kiosk mixed recipe carts and full tenders - Pattern Map

**Mapped:** 2026-11-10
**Files analyzed:** 17 (new/modified source + test files)
**Analogs found:** 16 / 17

Line numbers are from the tree at commit 9b782e84. Re-grep before citing in a plan if pos.js, pos-recipe.js or kiosk-core.js change.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `zoho-middleware/lib/recipe-sale-lines.js` (NEW) | service (pure pricing lib) + I/O catalog load | transform | `zoho-middleware/lib/kiosk-bundles.js` + code moved from `routes/pos-recipe.js` | exact (extraction precedent) |
| `zoho-middleware/routes/pos-recipe.js` (MOD: re-export moved helpers, `/recipe-sale` -> 410, keep confirm + usage event) | route | request-response | itself (L1650-1655 export block) | exact |
| `zoho-middleware/routes/pos.js` `/api/kiosk/sale` (MOD: `recipes[]`) | route | request-response (initiate) | itself: bundle handling `prepareBundleContext` (pos.js L80, L580) | exact |
| `zoho-middleware/routes/pos.js` `/api/kiosk/sale/confirm` (MOD) | route | request-response (invoice + payment + void) | itself: `__bundleInvalid` tagged-error idiom (L1293-1302, L2004-2014) | exact |
| `zoho-middleware/routes/pos.js` `POST /api/kiosk/cart-quote` (NEW) | route | request-response, read-only | `GET /api/kiosk/recipe-quote` (`pos-recipe.js` L975-1070) | role-match |
| `zoho-middleware/lib/brewpad-integration.js` `detectRecipeSale` `opts.unit_total` (MOD) | service | event-driven (fire-and-forget) | existing `detectRecipeSale` L855 and `createBatchesFromSale` L372 | exact |
| `zoho-middleware/lib/authTiers.js` (MOD: add `/api/kiosk/cart-quote`) | config | request-response | itself L54-65 | exact |
| `js/kiosk-core.js` (MOD: recipe entries list, grouped block, cart-quote client, tender unskip, shared 409 override) | component/controller | event-driven (cart state + render) | itself: `.kiosk-bundle-group` render L2515-2528 | exact |
| `js/kiosk.js`, `js/admin.js` (MOD: env bridge rename) | config (env bridge) | request-response | existing `getRecipeContext/setRecipeContext` bridge (kiosk.js L54-55, admin.js L10661) | exact |
| `css/kiosk.css` (MOD: `.kiosk-cart-recipe-block`) | style | n/a | `.kiosk-bundle-group` / `.kiosk-bundle-note` (kiosk.css L3001-3002) | exact |
| `zoho-middleware/__tests__/recipe-sale-lines.test.js` (NEW) | test (pure lib) | transform | `__tests__/kiosk-bundles.test.js` | exact |
| `zoho-middleware/__tests__/pos-sale-recipes-*.test.js` (NEW: sale/confirm mixed, tenders, 409+override, parity) | test (route) | request-response | `__tests__/pos-cash-tender.test.js` (pos.js handler capture) and `__tests__/pos-recipe-money-path.test.js` (recipe mocks) | exact |
| `zoho-middleware/__tests__/pos-recipe-characterization.test.js` (NEW, Wave 0 oracle) | test (route) | request-response | `__tests__/pos-recipe-money-path.test.js` (callHandler harness on `/recipe-sale` + confirm) | exact |
| `zoho-middleware/__tests__/pos-cart-quote.test.js` (NEW) | test (route) | request-response | `__tests__/pos-cash-tender.test.js` harness + `pos-auth-tier.test.js` for the tier | role-match |
| `tests/frontend/kiosk-mixed-recipe-cart.test.js` (NEW, replaces `kiosk-recipe-cart-guard.test.js`) | test (jsdom) | event-driven | `tests/frontend/kiosk-recipe-cart-guard.test.js` / `kiosk-recipe-client-totals.test.js` | exact |
| Updated existing tests (D-20 list in RESEARCH.md) | test | n/a | n/a | n/a |
| `docs/API.md`, `docs/RUNBOOK.md` | docs | n/a | existing sections | no code analog |

## Pattern Assignments

### `zoho-middleware/lib/recipe-sale-lines.js` (service, transform)

**Analogs:** `zoho-middleware/lib/kiosk-bundles.js` (module shape) and `zoho-middleware/routes/pos-recipe.js` (the code to move).

**Module shape to copy** (`kiosk-bundles.js` L1-20, L61-63, L172-181): `'use strict'`, header doc comment naming the phase, decisions and the wire contract, "Pure module, no I/O", a tiny `fail(error)` helper returning `{ status, error }`, and a single `module.exports = { ... }` of named functions.
```javascript
'use strict';
/**
 * Server-owned canning bundles for the kiosk money path (Phase 90, D-11..D-16, D-22).
 * ...
 * Both /api/kiosk/sale and /api/kiosk/sale/confirm call these helpers so the two
 * rebuild sites cannot drift.
 */
function fail(error) { return { status: 400, error: error }; }
...
module.exports = { BUNDLES: BUNDLES, validateBundleCart: validateBundleCart, buildBundleLine: buildBundleLine, ... };
```
Apply the same "both routes call the same helpers" contract: `/sale`, `/confirm` and `/cart-quote` all call the one lib.

**Code to MOVE (pure move first, no behaviour change)** from `routes/pos-recipe.js`: `getIngredientCatalog` (L69), `computeRecipeDiscount` (L115), `distributeRecipeDiscount` (L155), `recipeFeeItemIds` (L197), `buildRecipeLineItems` (L210), `reconcileRecipeInvoice` (L275), `recipeLineAmount` (L320), `getFeeCatalogMap` (L330), `computeRecipeTax` (L352), `priceRecipe` (L602), `typedSnapshotIngredients`/`snapshotGravity` (L50-66).

**Imports in the moved code** (`pos-recipe.js` L3-22): it needs `cache`, `C`, `log`, `kioskSaleCatalog`, `scaling` (`../lib/recipe-scaling`), `recipeStore`, `zohoApi.zohoPut` (for reconcile), `fs`/`path` (ingredients file fallback, `INGREDIENTS_ALL_FILE_CACHE` L37). Inside `lib/` use `./` paths, not `../lib/`.

**Tax split pattern** - today each side rounds its own groups; the lib must expose un-rounded group collectors so pos.js can merge before rounding. Rounding loop to reuse as the single merge point (`pos-recipe.js` L384-388, identical to `pos.js` L289-292):
```javascript
taxByRate[String(pct)] = (taxByRate[String(pct)] || 0) + amount * (pct / 100);
...
var taxTotal = 0;
Object.keys(taxByRate).forEach(function (k) { taxTotal += round2(taxByRate[k]); });
```
Keep each side's own rate resolution: fee lines fail closed from the kiosk catalog (L368-373), ingredient lines use `entry.tax_percentage` with the `tax_id` zero-rate exception (L374-382). `computeTax`/`computeRecipeTax` stay as thin wrappers returning exactly the same `{taxTotal}|{error}`.

**Reconcile (generalise only by call site, not logic)** (`pos-recipe.js` L273-316): fail-closed on gap > `RECIPE_RECONCILE_MAX_GAP` (1.00), re-sends Zoho's own `line_items` including `tax_id` and `discount`, rejects if the PUT does not balance. Note Pitfall 9 in RESEARCH: convert product `%` discounts to numeric amounts when recipes are present, before the invoice POST.

---

### `zoho-middleware/routes/pos-recipe.js` (route, request-response)

**Re-export pattern (existing, L1650-1655)** - extend so every existing import of moved helpers keeps working untouched:
```javascript
module.exports = router;
module.exports.computeRecipeDiscount = computeRecipeDiscount;
module.exports.distributeRecipeDiscount = distributeRecipeDiscount;
module.exports._dualPriceStats = _dualPriceStats;
module.exports._resetDualPriceStats = _resetDualPriceStats;
```
Then `var lines = require('../lib/recipe-sale-lines')` at the top and `module.exports.computeRecipeDiscount = lines.computeRecipeDiscount;` etc.

**Feature gate to copy into `/sale`** (L779-783, repeated at L975-979):
```javascript
if ((process.env.BEER_SALES_ENABLED || 'false').toLowerCase() !== 'true') {
  return res.status(403).json({ error: 'Recipe sales are not enabled' });
}
```

**`/recipe-sale` -> 410 (D-18):** keep the route registration `router.post('/api/kiosk/recipe-sale', function (req, res) {...})` (L779) but respond immediately with a pre-charge status and no lock/terminal call. `/api/kiosk/recipe-sale/confirm` (L1078) stays; add `eventLog.logEvent('kiosk.recipe_sale_legacy_confirm', {...})` at the top, using the same `eventLog.logEvent(name, obj)` shape as pos.js L768. Keep `GET /api/kiosk/recipe-quote` (L975) unchanged. Keep `LOCK_KEYS.RECIPE_SALE` constant (tests mock it).

**Existing 409 stock response to carry over** (initiate route ~L846): `409 {error: 'Insufficient stock for scaled batch', conflicts}`; the new one adds `recipes_short` and per-conflict `recipes`, and must be sent from `/sale` before any tender branch.

---

### `zoho-middleware/routes/pos.js` `/api/kiosk/sale` (route, request-response)

**Analog:** the existing bundle integration in the same function (additive optional body feature with its own pre-charge validation).

**Lazy require idiom (pos.js L23-26)** - REQUIRED so the ~10 mocked pos tests are unaffected (Pitfall 12):
```javascript
// Phase 87-12: lazy so route tests that mock constants/cache/logger are unaffected.
function batchProxy() { return require('../lib/batch-proxy'); }
function batchStore() { return require('../lib/batch-store'); }
function batchFlag() { return require('../lib/batch-flag'); }
```
Add `function recipeLines() { return require('../lib/recipe-sale-lines'); }` next to them and only call it when `Array.isArray(body.recipes) && body.recipes.length > 0`.

**Validation to relax** (pos.js L494-499):
```javascript
if (!body || !Array.isArray(body.items) || body.items.length === 0) {
  return res.status(400).json({ error: 'Cart is empty' });
}
if (body.items.length > 50) {
  return res.status(400).json({ error: 'Too many items in cart' });
}
```
Change to "items OR recipes non-empty"; validate `recipes[]` per RESEARCH V5 (array bound, `recipe_id` string, `sale_type` enum, numeric `target_volume_l`, `modified_ingredients` array, `override` boolean).

**Idempotency lock release on failure (L486-492) - this is what fixes Pitfall 6; keep and rely on it:**
```javascript
if (idempotencyKey && res && typeof res.on === 'function') {
  res.on('finish', function () {
    if (res.statusCode >= 400 && !(res.locals && res.locals.__keepIdemLock)) {
      cache.releaseLock(idempotencyKey).catch(function () {});
    }
  });
}
```

**Totals limits that now apply to recipe sales (D-21)** (L739-744):
```javascript
if (grandTotal <= 0) { return res.status(400).json({ error: 'Sale total must be greater than zero' }); }
if (grandTotal > 10000) { return res.status(400).json({ error: 'Sale total exceeds maximum' }); }
```

**Phase 67 assertion stays BLOCKING for all carts (D-19)** (L755-783): copy as is; recipe carts only differ in that the client sends the `cart-quote` total as `client_grand_total`. Include `has_recipes` in the `eventLog.logEvent('kiosk.total_mismatch', {...})` payload.

**Tax merge** (anti-pattern: never append recipe lines to `lineItems` before `computeTax` - `computeTax` dereferences `catalogMap[li.item_id].tax_percentage` at L273 and throws on ingredient ids). Keep recipe lines in a separate list.

**Where tender branches live (nothing to change, only gate them after the stock check):** cash L860-882, MOTO L883-945, terminal L946-998, gift-only L999-1019.

---

### `zoho-middleware/routes/pos.js` `/api/kiosk/sale/confirm` (route, request-response)

**Analog:** `__bundleInvalid` tagged-error idiom. Recipe failures after a charge must NEVER bare-4xx.

**Throw site (L1293-1302):**
```javascript
var bundleCtxConfirm = prepareBundleContext(body.items, catalogMap);
if (bundleCtxConfirm.error) {
  var bundleInvalidErr = new Error(bundleCtxConfirm.error);
  bundleInvalidErr.__bundleInvalid = true;
  throw bundleInvalidErr;
}
```
For recipes: `e.__recipeInvalid = true; e.__status = status;`, thrown for gate 403, recipe 404/inactive, 422 unit mismatch, 503 ingredient catalog, milling not configured, unresolved fee tax.

**Handler site (L2004-2014) - extend the condition with `err.__recipeInvalid` and use `err.__status || 400`:**
```javascript
if (err && (err.__taxUnresolved || err.__bundleInvalid) && !(body && body.transaction_id)) {
  if (res.headersSent) return;
  if (confirmIdemKey) { cache.releaseLock(confirmIdemKey).catch(function () {}); }
  return res.status(400).json({ error: err.message });
}
log.error('[pos/kiosk/sale/confirm] Error: ' + err.message);   // falls through to void-on-failure
```

**Post-success block to extend (L1919-1962):**
```javascript
cache.del(KIOSK_PRODUCTS_CACHE_KEY);
ledger.decrementStock(lineItems, 'kiosk:' + (invoiceNumber || 'unknown')).catch(function () {});
...
brewpadIntegration.createBatchesFromSale(lineItems, invoiceNumber, body.customer_name || '', body.contact_id || '', catalogMap, invoiceId);
```
`lineItems` here must stay the non-recipe lines only (Pitfall 1: Maker's Fee item id collision with recipe in-store fee line). Add per in-store recipe entry `brewpadIntegration.detectRecipeSale(..., customerEmail, { unit_total: n })`. Also bust `INGREDIENTS_ALL`/`RECIPES_TS` when recipes were sold (copy the cache-bust lines from `recipe-sale/confirm`, `pos-recipe.js` L1078+). Result object (L1932-1936) gains a `recipes: [...]` field for receipt rendering.

**Payment-record failure is rethrown -> outer void (L1910-1916)**: this is the behaviour D-21 / Pitfall 7 wants; do not copy the old fire-and-forget payment from `pos-recipe.js` L1490-1503.

**Package adjustment:** per-recipe `round2(preTax_r - sum(recipeLineAmount(line)))`, summed into the single `invoicePayload.adjustment` with `adjustment_description: 'Recipe package price'`; then `reconcileRecipeInvoice(created, invoicePayload, grandTotal)` only when recipes exist. Copy the existing computation from `pos-recipe.js` ~L1436-1442.

---

### `zoho-middleware/routes/pos.js` `POST /api/kiosk/cart-quote` (route, request-response, read-only)

**Analog:** `GET /api/kiosk/recipe-quote` (`pos-recipe.js` L975-1070). Copy: feature gate, validation 400s, `.then(build response)`, and the catch idiom:
```javascript
.catch(function (err) {
  if (err && err.status) {
    return res.status(err.status).json(err.body);
  }
  log.error('[pos-recipe/recipe-quote] Error: ' + (err && err.message));
  res.status(502).json({ error: 'Failed to fetch recipe. Please try again.' });
});
```
Differences: POST body `{items, recipes, discount}`, no idempotency lock, no terminal/Helcim/Zoho calls, catalog via `kioskSaleCatalog.getKioskCatalogForSale({rebuild:false})` (quota rule). Response mirrors the `/sale` computation: `subtotal`, `tax_total`, `total`, `discount`, per-recipe totals, `stock: {ok, conflicts, recipes_short}` (same shape as `recipe-quote` `stock` L1057-1060). Share the pricing function with `/sale` so equality is by construction.

**Registration (authTiers.js L54-65):** add `'/api/kiosk/cart-quote',` to the exact-path `KIOSK_ROUTES` list next to `'/api/kiosk/recipe-quote'`. No prefix.
```javascript
  '/api/kiosk/recipe-quote',
  '/api/kiosk/recipe-sale',
  '/api/kiosk/recipe-sale/confirm',
  '/api/kiosk/sale',
```
Keep `recipe-sale` entries until the follow-up deletion.

---

### `zoho-middleware/lib/brewpad-integration.js` (service, event-driven)

**Analog:** the existing `detectRecipeSale` (L855-871, sends `product_sku: recipeId`, no `unit_total`). Add optional trailing `opts` param (`opts.unit_total` = number of in-store entries with the same `recipe_id` in the sale) and include it in the create payload only when > 1 to keep old payloads byte-identical. Dedup key is invoice + `product_sku` with `allowedUnits = unit_total || 1` (batch-rules.js ~L305, batch-pg-create.js ~L112). The kit path already sets `unit_total` - copy how `createBatchesFromSale` (L372) passes it. Tests: mirror `__tests__/kiosk-recipe-batch-email-97.test.js` (97-10 customer-email carry-through; recipe batches get email, kit batches do not).

---

### `js/kiosk-core.js` cart rendering (component, event-driven)

**Analog (grouped block):** `.kiosk-bundle-group` rendering inside `kioskRenderCart` (L2515-2528). Copy the HTML-string ES5 style (no template literals), `escapeHTML`, `kioskFmt`, the `kiosk-cart-remove-btn` class with `data-id`:
```javascript
if (id === KIOSK_BUNDLE_LINE_KEY && item.bundle_key) {
  html += '<div class="kiosk-cart-line kiosk-bundle-group">';
  html += '<div class="kiosk-cart-line-name" title="' + escapeHTML(item.name || '') + '">' + escapeHTML(item.name || '') +
    '<div class="kiosk-bundle-note">' + KIOSK_BUNDLE_TAX_PCT + '% tax</div></div>';
  html += '<div class="kiosk-cart-qty"><span class="kiosk-qty-val">1</span></div>';
  html += '<div class="kiosk-cart-line-total">' + kioskFmt(lineTotal) + '</div>';
  html += '<button class="kiosk-cart-remove-btn" data-id="' + id + '">&times;</button>';
  html += '</div>';
  return;
}
```
New recipe block: wrapper `.kiosk-cart-recipe-block` (visual contract is in 101-UI-SPEC.md), header row with name, litres, sale type and total, child rows with no stepper, ONE `&times;` button with a distinct attribute (`data-recipe-entry="<entry_id>"`) wired in the same delegated click handler area (after L2641 `capOkBtn` wiring pattern) to `kioskRemoveRecipeEntry(entryId)`.

**Guard code to delete (replaced by tests):** `kioskCartHasRecipe`/`kioskWarnRecipeCart` (L2163-2169) and their callers at the top of `kioskAddToCart` (L2172), `kioskSetQty`, `kioskRemoveFromCart`; `recipe_cart` return in `kioskAddCanningBundle`; `isRecipeCart` qty fork in `kioskRenderCart` (L2530 `if (isRecipeCart) {...}`). Replace the empty-cart test `keys.length === 0` (L2451) to also require no recipe entries (Pitfall 11).

**Env bridge (kiosk.js L54-55, admin.js L10661-10662, kiosk-core.js L68-69 and `bridgedFns` L96-98):** rename `getRecipeContext/setRecipeContext` to `getRecipeEntries/setRecipeEntries`; test hooks at kiosk-core.js ~L7103-7104 (`_getRecipeContext/_setRecipeContext`) become `_getRecipeEntries/_setRecipeEntries`. Parity is pinned by `tests/frontend/kiosk-core-parity.test.js` (update, owner-approved).

**Shared 409 override:** extract the conflict UI from `_kioskPushToTerminal`'s result handler (~L3488-3510) into one function used by `_kioskGoCash` (~L3611) and `_kioskGoMoto` (~L3681). Keep the DOM ids `kiosk-stock-conflict` and `kiosk-stock-override-btn`. Reset `_kioskStockOverride = false` in `kioskClearCart` and at the top of `kioskProceedToPayment` (Pitfall 5).

**Sale body:** delete the `isRecipeSale` fork (~L3214-3264) and recipe confirm branch (~L3308-3360); add `recipes`, `override`, `customer_email` to `standardSaleBody` following the existing `customer_email` pattern (~L3228-3230); unskip the tender panel (~L3783-3797 note removed).

---

### `css/kiosk.css` (style)

**Analog (L3000-3002):**
```css
/* ===== Phase 90: canning bundle (cart rows + opener) ===== */
.kiosk-bundle-group { border-left: 3px solid var(--cork); padding-left: 0.5rem; }
.kiosk-bundle-note { font-size: 12px; font-weight: 700; color: var(--ink-tertiary); }
```
Add a "Phase 101" section next to it using the same CSS variables (`--cork`, `--ink-tertiary`, `--sp-*`); the exact values come from 101-UI-SPEC.md. After any css/js change run `npm run build` (never edit `*.min.*`).

---

### Test files

**Pure lib test `zoho-middleware/__tests__/recipe-sale-lines.test.js`** - analog `__tests__/kiosk-bundles.test.js`: plain `require('../lib/...')`, a shared fixtures file (`__tests__/fixtures/canning-bundle-carts.js` is the precedent; create `fixtures/recipe-mixed-carts.js`), a `mapOf(catalog)` helper, env save/restore in `beforeEach`/`afterEach`:
```javascript
var kb = require('../lib/kiosk-bundles');
var fx = require('./fixtures/canning-bundle-carts');
function mapOf(catalog) { var m = {}; catalog.forEach(function (p) { m[p.item_id] = p; }); return m; }
```

**Route tests on pos.js (`/sale`, `/confirm`, `/cart-quote`)** - analog `__tests__/pos-cash-tender.test.js`. NOTE: the repo does NOT use supertest for pos routes. It mocks `express` so `Router()` returns a shared stub, loads the route with `jest.resetModules()`, then reads handlers from `router.post.mock.calls` and invokes them with a mock `res`:
```javascript
jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
...
jest.resetModules();
cache = require('../lib/cache'); helcimLib = require('../lib/helcim'); zohoApi = require('../lib/zoho-api');
moneyPath = require('../lib/money-path'); ledger = require('../lib/inventory-ledger');
require('../routes/pos');
router = require('express').Router();
handlers = {};
router.post.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
function mockRes() {
  var r = { json: jest.fn(), status: jest.fn(), headersSent: false };
  r.status.mockReturnValue(r);
  return r;
}
```
Also copy the module mocks for `../lib/helcim` (`isTerminalEnabled`, `isEnabled`, `terminalPurchase`, `pollTerminalResult`, `voidTransaction`), `../lib/zoho-api` (`zohoPost` resolving `{invoice:{invoice_id, invoice_number}}`), `../lib/cache` (`acquireLock`, `releaseLock`, `get`, `set`, `del`). The `res.on('finish')` hook needs `on: jest.fn()` (or a real emitter) on the mock res when testing lock release (see `pos-idem-lock-release.test.js` for the finish-hook pattern).

**Recipe-specific mocks to add on top** - from `__tests__/pos-recipe-money-path.test.js` L29-120: `jest.mock('../routes/catalog', ... rebuildKioskCatalog returning fee items with tax_percentage 5/12/12)`, `jest.mock('../lib/constants', ...)` including `INGREDIENTS_ALL`, `RECIPES_TS`, `KIOSK_IDEM_PREFIX`, `KIOSK_PENDING_CHARGE_PREFIX`, `LOCK_KEYS: {RECIPE_SALE}`, `jest.mock('../lib/brewpad-integration', ...detectRecipeSale, createBatchesFromSale)`, and the fixtures `MOCK_INGREDIENTS_CATALOG`, `MOCK_RECIPE_RESPONSE` (L96-135). Note that harness captures handlers in a keyed map (`mockRouteHandlers['POST:' + path]`) and uses `callHandler(method, path, req)` returning a promise resolved on `res.json`. Either harness is acceptable; for new mixed-cart tests use the `mockRouteHandlers` keyed form since it already supports both routes and recipes.

**Characterization oracle (Wave 0, must be written FIRST per D-20)** - analog `pos-recipe-money-path.test.js` + `pos-recipe-zoho-line-fidelity.test.js` + `pos-recipe-invoice-reconcile.test.js`: run `/recipe-sale` and `/recipe-sale/confirm` through the same harness for locked/dynamic x in-store/take-out x milling x discount (cart %, cart fixed, type recipe/service) and snapshot invoice payload lines, `adjustment`, tax, charge. These become the expected values that the new `/sale` recipes path must equal.

**Auth tier test** - analog `__tests__/pos-auth-tier.test.js`: add `/api/kiosk/cart-quote` assertions beside the existing route lists.

**Frontend jsdom tests** - analog `tests/frontend/kiosk-recipe-client-totals.test.js` L1-70 and `kiosk-recipe-cart-guard.test.js` (load helper + DOM ids). Copy this harness verbatim:
```javascript
global.window = global.window || {};
global.navigator = global.navigator || { userAgent: 'test' };
global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
global.fetch = jest.fn(...); global.alert = jest.fn();
global.SHEETS_CONFIG = { MIDDLEWARE_URL: 'http://localhost:3001', MW_API_KEY: 'test-key', ... SERVER_TOKEN: 'test-token' };
var DEVICE_TOKEN_KEY = 'sv_kiosk_device_token';
function load() {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  require('../../js/kiosk.js');
  var core = global.window.KioskCore;
  ['kiosk-toast-container', 'kiosk-cart-items', 'kiosk-cart-totals', 'kiosk-checkout-btn',
    'kiosk-checkout-total', 'kiosk-product-grid', 'kiosk-payment-items', 'kiosk-payment-amount',
    'kiosk-terminal-msg', 'kiosk-spinner'].forEach(function (id) { injectEl(id); });
  return core;
}
```
Usage: `localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token')`, `core._setCart({...})`, `core._setRecipeContext(...)` (becomes `_setRecipeEntries`), `core.calcTotals()`, `core.proceedToPayment(); await flushPromises();`, then find the call with `global.fetch.mock.calls.find(c => c[0].indexOf('/api/kiosk/sale') !== -1)` and `JSON.parse(c[1].body)`. Also load `js/admin.js` via the `loadSurface(path)` form in client-totals (L45-52) for the admin-parity assertion (D-15).

## Shared Patterns

### Money-path idempotency + void-on-failure
**Source:** `zoho-middleware/lib/money-path.js` (`acquireIdempotencyLock`, `voidWithTimeout`, `CHECKOUT_IDEMPOTENCY_TTL`), used by `pos.js` sale (L395-420) and confirm (L1210-1263, L2015+).
**Apply to:** the merged `/sale` + `/confirm` only. Do not add new lock/void code; recipes inherit it because they change only `grandTotal` and lines. `LOCK_KEYS.RECIPE_SALE` mutex is dropped from the new path.

### Tagged pre-charge error (never bare 4xx after a charge)
**Source:** `pos.js` L1297-1302 and L2004-2014.
**Apply to:** every recipe-specific failure in `/confirm` (see excerpt above).

### Lazy require for pos.js dependencies
**Source:** `pos.js` L23-26.
**Apply to:** `recipe-sale-lines` inside pos.js.

### Kiosk catalog resolution with last-good fallback
**Source:** `lib/kiosk-sale-catalog.js` `getKioskCatalogForSale`, used at `pos.js` L543-575 (`/sale`, rebuild on miss) and L1268-1291 (`/confirm`, `rebuild:false`); fee map precedent `getFeeCatalogMap` (`pos-recipe.js` L330-343).
**Apply to:** `/sale` (rebuild allowed, `isUsable` must also require fee item ids when recipes need them), `/confirm` and `/cart-quote` (`rebuild:false`). Mirrors the `source === 'stale'` event tagging at pos.js L1926.

### Event logging
**Source:** `eventLog.logEvent('kiosk.total_mismatch', {...})` (pos.js L768), `'kiosk.sale_completed'` (L1927).
**Apply to:** legacy confirm usage (`kiosk.recipe_sale_legacy_confirm`), stock override (`kiosk.stock_override`).

### Frontend ES5 conventions
**Source:** project CLAUDE.md. `var`, `function`, string concatenation only, no arrow functions or template literals in `js/`; edit `js/modules/*` or `js/kiosk-core.js`/`kiosk.js`/`admin.js` sources only, never `js/main.js`/`main.min.js`; run `npm run build` after changes.

### Test-change discipline
**Source:** CLAUDE.md rule 10 plus D-20: new characterization tests in NEW files first; modify/retire existing tests only in the final wave with the explicit file list from RESEARCH.md ("Existing tests that pin old behaviour").

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Combined multi-recipe stock aggregation (inside `recipe-sale-lines.js`) | service | transform | `checkScaledStock` (`lib/recipe-scaling.js` L188) works per recipe call; aggregate-by-`item_id` across entries with `ingredientLineCost(...).convertedQty` (L387) is new. Start from `checkScaledStock` and its conflict shape (`{item_id, item_name, needed, stock, unit}`), add `recipes: []` naming. |
| Cart-wide fixed-discount allocation across product lines and recipe units | service | transform | `allocateFixedDiscount` (`pos.js` L108) and `resolveDiscount` (L157-228) handle product lines only; extend with pseudo-lines `{quantity:1, rate: base_r}` per RESEARCH "Discount (D-11)". Characterization tests must prove recipe-only and product-only results are unchanged. |
| Client `cart-quote` debounce/freshness gate | component | request-response | No existing debounced server-quote client in `kiosk-core.js`. Closest is the recipe screen's quote fetch (`_kioskQuote`, ~L415; `kiosk-recipe-quote.test.js`). Follow its fetch + staleness handling and disable Checkout until the quote is fresh. |

## Metadata

**Analog search scope:** `zoho-middleware/lib`, `zoho-middleware/routes/pos.js`, `zoho-middleware/routes/pos-recipe.js`, `zoho-middleware/__tests__`, `js/kiosk-core.js`, `css/kiosk.css`, `tests/frontend`.
**Files scanned:** about 25 (targeted reads and greps; pos.js 4.9k lines and pos-recipe.js 1.6k lines read by section only).
**Pattern extraction date:** 2026-11-10
**Correction to the brief:** pos route tests in this repo use a mocked `express.Router` plus captured handlers, not supertest.
