# Phase 74: Beer/Wine catalogue pages under Ferment-in-Store - Pattern Map

**Mapped:** 2026-09-01
**Files analyzed:** 14 (new + modified)
**Analogs found:** 12 / 14 (2 are net-new with no direct file analog, but reuse existing CSS/JS primitives — see "No Analog Found")

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `wine.html` (NEW) | route/page (static HTML) | request-response | `products/ferment-in-store.html` | exact (scaffold source, per RESEARCH's own recommendation) |
| `beer.html` (extend) | route/page (static HTML) | request-response | `products/ferment-in-store.html` (for the `#product-catalog` block only) | role-match |
| `products/ferment-in-store.html` (rewrite) | route/page (static HTML) | request-response | itself (pre-rewrite) — this is a subtractive/additive edit, not a fresh build | exact (self) |
| `js/modules/07-catalog-kits.js` — `loadProducts(categoryFilter)` | component/utility (catalogue loader) | CRUD (read) | itself, `loadProducts()` current unscoped body | exact (extend in place) |
| `js/modules/07-catalog-kits.js` — `buildBeerCard()` action tail | component | event-driven (click → cart) → (click → anchor scroll) | `setupBeerWaitlistForm()` CTA markup in `beer.html:135` + `js/modules/12-checkout.js:1689` | role-match |
| `js/modules/07-catalog-kits.js` — `buildFilterRow()` per-category call list | component | transform (derive unique values → chips) | itself, existing call list at `07-catalog-kits.js:194-201` | exact (extend in place) |
| `js/modules/07-catalog-kits.js` — recipe card builder (NEW) | component | transform (API JSON → DOM card) | `buildDefaultCard()`, `07-catalog-kits.js:882-1063` | role-match (closest existing card builder using the plain `.product-card` idiom, not the bottle-label idiom) |
| `js/modules/07-catalog-kits.js` — recipe block renderer / `loadRecipes()` (NEW) | service/utility (fetch + render) | request-response (fetch `/api/recipes`) | `loadProducts()`'s fetch+render+skeleton+error pattern, `07-catalog-kits.js:129-310` | role-match |
| `js/modules/13-init.js` — `page === 'wine'`/`'beer'` dispatch branches | route/page-init dispatcher | event-driven (DOMContentLoaded dispatch) | existing `page === 'products' \|\| ... \|\| 'ferment-in-store' \|\| 'ingredients-supplies'` gate, `13-init.js:331-349` | exact |
| `zoho-middleware/routes/recipes.js` — `GET /api/recipes` status guard | route (Express handler) | request-response | `zoho-middleware/routes/catalog.js:628-698` (`isAdminGrade` + `GET /api/ingredients?include_internal=1`) | exact (documented precedent for optional-auth-richer-for-staff) |
| `zoho-middleware/routes/recipes.js` — `GET /api/recipes/:id` status guard | route (Express handler) | request-response | same as above | exact |
| `package.json` — `stamp:pages` array | config | batch (build-time file rewrite) | itself, existing array entry pattern | exact |
| `sitemap.xml` — `/wine` entry | config/data | batch | itself, existing `<url>` block for `/beer` | exact |
| `css/styles.css` — `.product-grid--compact`, `.hub-categories`/`.hub-category-item` | config/style | n/a | itself, `.product-grid` (:1526-1531) and `.catalog-section` (:1502-1516) | exact (additive modifier next to source rule) |

## Pattern Assignments

### `wine.html` (route/page, request-response)

**Analog:** `products/ferment-in-store.html` (full scaffold — head, header/nav, cart sidebar/drawer, catalogue markup)

**CSP `<meta>` pattern — copy from `beer.html` (most recently verified against `docs/TRACKING.md`, per UI-SPEC Assumption A3), lines 19:**
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://tracker.metricool.com https://connect.facebook.net https://www.googleadservices.com https://googleads.g.doubleclick.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://www.googletagmanager.com https://www.google-analytics.com https://www.facebook.com https://www.google.com https://www.google.ca https://googleads.g.doubleclick.net https://*.google-analytics.com; connect-src 'self' https://docs.google.com https://*.googleusercontent.com https://script.google.com https://sheets.googleapis.com https://www.googleapis.com https://svmiddleware-production.up.railway.app https://svmiddleware-staging.up.railway.app https://o4511012754358272.ingest.de.sentry.io https://www.google-analytics.com https://www.googletagmanager.com https://*.analytics.google.com https://tracker.metricool.com https://www.facebook.com https://www.google.com https://googleads.g.doubleclick.net https://www.googleadservices.com https://*.google-analytics.com; frame-src 'self' https://www.googletagmanager.com https://www.google.com https://td.doubleclick.net">
```
Also copy `<body data-page="wine">` (the dispatch key `13-init.js` reads).

**Catalogue block markup to copy verbatim (with wine-only filter rows), `products/ferment-in-store.html:173-261`:**
```html
<section class="catalog-section">
  <div class="container">
    <div class="catalog-layout">
      <div id="product-catalog">
        <div class="catalog-controls" id="catalog-controls-kits">
          <input type="text" class="catalog-search" id="catalog-search" placeholder="Search kits..." inputmode="search" autocomplete="off">
          <div class="catalog-view-toggle"> ... </div>
          <button type="button" class="catalog-toggle" id="catalog-toggle" aria-expanded="false"> ... </button>
          <div class="catalog-collapsible" id="catalog-collapsible">
            <div class="catalog-filter-row" id="filter-type"></div>
            <div class="catalog-filter-row" id="filter-brand"></div>
            <div class="catalog-filter-row" id="filter-manufacturer"></div>
            <div class="catalog-filter-row" id="filter-subcategory"></div>
            <div class="catalog-filter-row" id="filter-time"></div>
            <div class="catalog-filter-row" id="filter-body"></div>
            <div class="catalog-filter-row" id="filter-oak"></div>
            <div class="catalog-filter-row" id="filter-sweetness"></div>
            <div class="catalog-filter-row" id="filter-sale"></div>
            <div class="catalog-filter-row"> ... sort select ... </div>
          </div>
          <div class="filter-summary hidden" id="filter-summary"></div>
        </div>
        <noscript><p>Please enable JavaScript to view our product catalog.</p></noscript>
      </div>
      <aside class="cart-sidebar" id="cart-sidebar"> ... </aside>
      <div class="cart-drawer-backdrop" id="cart-drawer-backdrop"></div>
      <div class="cart-drawer" id="cart-drawer"> ... </div>
    </div>
  </div>
</section>
```
**IMPORTANT — one omission per UI-SPEC/CONTEXT D-01/D-02:** unlike the hub, `/wine` does NOT include the `.product-tabs` (`#product-tabs`, kits/ingredients tab switcher) — that's a hub-only artifact being removed everywhere (§8 of UI-SPEC). `/wine` renders the kit block directly, plus (per D-01/D-04) a suppressed-when-empty recipe block below it.

**Script tags — copy from `products/ferment-in-store.html:294-299` (NOT from `beer.html`, which is missing `fuse.min.js`/`17-search-overlay.min.js` — RESEARCH Pitfall 5):**
```html
<script src="../js/vendor/sentry.min.js"></script>
<script src="../js/sentry-init.js"></script>
<script src="../js/vendor/fuse.min.js" defer></script>
<script src="../js/sheets-config.js" defer></script>
<script src="../js/main.min.js?v=mtdhhxun" defer></script>
<script src="../js/modules/17-search-overlay.min.js?v=mtdhhxun" defer></script>
```
Note: `wine.html` is a ROOT sibling (D-09), same tier as `beer.html` and `products.html` — do NOT use the `../` relative prefixes shown above (those are specific to `products/*.html`'s one-level-deep path). Use `beer.html`'s root-relative asset paths (`js/...`, `images/...`) instead, while still sourcing the CSP and the fuse/search-overlay script tags as listed.

**Nav dropdown — must add a Wine entry to all 17 nav-carrying pages, matching the existing Beer entry pattern (`beer.html:102-113`):**
```html
<li class="nav-dropdown-indent"><a href="beer.html" class="active">Beer</a></li>
```
On `wine.html` itself, add a parallel `<li class="nav-dropdown-indent"><a href="wine.html" class="active">Wine</a></li>` and mark it active; on all other 16 pages, add the same `<li>` (non-active) alongside the existing Beer entry.

---

### `beer.html` (extend, request-response)

**Analog:** `products/ferment-in-store.html`'s `#product-catalog` markup (for the catalogue block only) + `beer.html`'s own existing section-divider rhythm (for insertion point).

**Insertion contract (UI-SPEC §9) — exact seam, `beer.html:170-176` (current "What's Included" → divider → "Ready to Brew?" boundary):**
```html
<!-- existing, unmodified -->
<section class="intro">
  <div class="container">
    <h2>What&rsquo;s Included</h2>
    ...
  </div>
</section>

<div class="section-icon">
  <img src="images/Icon_wine.svg" alt="" aria-hidden="true" loading="lazy">
</div>

<!-- INSERT HERE: new catalogue section, then a new divider, before <section id="waitlist"> -->

<section class="content" id="waitlist">
  ...
```
New section wraps in `.container`/`.catalog-section` per UI-SPEC — same vertical rhythm as every other section, no distinct background.

**Missing script tags to add (RESEARCH Pitfall 5), copy from `products/ferment-in-store.html:296,299` (root-relative, no `../`):**
```html
<script src="js/vendor/fuse.min.js" defer></script>
<script src="js/modules/17-search-overlay.min.js?v=mt8x50y5" defer></script>
```
Insert alongside `beer.html`'s existing script block (`beer.html:263-266`).

**Beer card action CTA — copy the exact existing string/link target, `beer.html:135`:**
```html
<a href="#waitlist" class="btn">Join the Waitlist</a>
```
This is what `buildBeerCard()`'s new action tail (see below) must produce as a DOM node — same class, same anchor target, same copy.

---

### `products/ferment-in-store.html` (rewrite — hub)

**Analog:** itself, pre-rewrite. This is a subtractive edit (remove `#product-catalog`, lines 173-261) + additive edit (new `.hub-categories` section).

**Preserve verbatim — landing-copy block, lines 128-171 (D-10 requires zero paraphrasing):**
```html
<section class="landing-copy" id="landing-copy">
  <div class="container">
    <h2>Make Your Own Wine in Squamish</h2>
    <p>Steins &amp; Vines is Squamish's ferment-on-premise winemaking studio, ...</p>
    ...
    <div class="landing-copy-detail" id="landing-copy-detail"> ... </div>
  </div>
</section>
```

**Remove entirely — `#product-catalog` section, lines 173-261** (both the kits tab AND the Ingredients & Supplies tab — UI-SPEC §8, "Open for owner sign-off" item; planner must confirm before implementing).

**New hub-categories section (net-new; CSS given in UI-SPEC §8) — reuses existing primitives, no new card chrome:**
```css
.hub-categories { display: flex; flex-wrap: wrap; gap: 2rem; justify-content: center; }
.hub-category-item { flex: 1 1 280px; max-width: 340px; text-align: center; }
```
Markup pattern per item (3 total: Wine → `/wine`, Beer → `beer.html`, Ingredients → `products/ingredients-supplies.html`):
```html
<div class="hub-category-item">
  <h3>Wine</h3>
  <p>Wine kits, ready to ferment in-store.</p>
  <a href="../wine.html" class="btn-secondary">Explore Wine</a>
</div>
```
`.btn-secondary` class comes from `css/styles.css:809` (existing, reused as-is — no new button style).

---

### `js/modules/07-catalog-kits.js` — `loadProducts(categoryFilter)` (utility, CRUD-read)

**Analog:** itself — this is an in-place extension of the existing function, not a new file.

**Two call sites that need a category-aware branch, `07-catalog-kits.js:123-128` and `:168-173` (near-identical duplicate):**
```js
var cat = (obj.category || obj._zoho_category || obj.type || '').toLowerCase();
if (!cat) return false;
return KIT_CATEGORIES.some(function (kc) { return cat.indexOf(kc) !== -1; });
```
Change to check a single passed-in `categoryFilter` string when truthy, falling back to today's combined `KIT_CATEGORIES.some(...)` behavior when falsy (so `products.html`/`products/ingredients-supplies.html`'s existing all-category calls stay unaffected):
```js
function loadProducts(categoryFilter) {
  ...
  return KIT_CATEGORIES.some(function (kc) {
    if (categoryFilter) return kc === categoryFilter && cat.indexOf(kc) !== -1;
    return cat.indexOf(kc) !== -1;
  });
```
(Illustrative — planner should verify exact shape against the live function; RESEARCH already confirmed this is a 2-line diff per call site, not a rewrite.)

**Skeleton loading pattern to reuse for the recipe fetch too, `07-catalog-kits.js:148-150`:**
```js
var catalog = document.getElementById('product-catalog');
if (catalog) {
  showCatalogSkeletons(catalog, 6);
}
```

**Error state pattern to mirror for the NEW per-block recipe error (UI-SPEC "independent per-block error handling"), `07-catalog-kits.js:290-309`:**
```js
.catch(function () {
  // Both middleware and snapshot failed — show error state with retry
  var catalogEl = document.getElementById('product-catalog');
  if (catalogEl) {
    catalogEl.innerHTML = '';
    var errorDiv = document.createElement('div');
    errorDiv.className = 'catalog-error';
    var errorMsg = document.createElement('p');
    errorMsg.textContent = "Couldn't load products. Check your connection and try again.";
    var retryBtn = document.createElement('button');
    retryBtn.className = 'btn-retry btn-outline';
    retryBtn.type = 'button';
    retryBtn.textContent = 'Try again';
    retryBtn.addEventListener('click', function () {
      loadProducts();
    });
    errorDiv.appendChild(errorMsg);
    errorDiv.appendChild(retryBtn);
    catalogEl.appendChild(errorDiv);
  }
});
```
For the recipe block, scope this to the recipe block's own container (not `#product-catalog` wholesale) and use the copy from UI-SPEC: *"Couldn't load recipes right now. Check your connection and try again."*

---

### `js/modules/07-catalog-kits.js` — `buildFilterRow()` per-category call list (transform)

**Analog:** itself — existing call list, `07-catalog-kits.js:194-201`:
```js
buildFilterRow('filter-type', 'type', 'Type:');
buildFilterRow('filter-brand', 'brand', 'Brand:');
buildFilterRow('filter-manufacturer', 'manufacturer', 'Producer:');
buildFilterRow('filter-subcategory', 'subcategory', 'Style:');
buildFilterRow('filter-time', 'time', 'Production Time:');
buildFilterRow('filter-body', 'body', 'Body:');
buildFilterRow('filter-oak', 'oak', 'Oak:');
buildFilterRow('filter-sweetness', 'sweetness', 'Sweetness:');
buildSaleFilter();
```
**Full function body (self-suppresses via `.hidden` when zero unique values — confirmed live, `07-catalog-kits.js:314-378`, key excerpt at :369):**
```js
function buildFilterRow(containerId, field, label) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var labelSpan = document.createElement('span');
  labelSpan.className = 'catalog-filter-label';
  labelSpan.textContent = label;
  container.appendChild(labelSpan);

  var uniqueValues = [];
  allProducts.forEach(function (r) {
    var val = r[field] || '';
    if (val && uniqueValues.indexOf(val) === -1) uniqueValues.push(val);
  });

  // field-specific sort branches: 'time' (numeric), 'subcategory' (wine-only
  // styleOrder array — CONDITION THIS ON category for beer reuse, see below),
  // 'body' (bodyOrder array), 'sweetness' (sweetOrder array), else alphabetical

  if (uniqueValues.length === 0) {
    container.classList.add('hidden');
    return;
  }
  var allBtn = createFilterButton('All', containerId, field);
  allBtn.classList.add('active');
  container.appendChild(allBtn);
  uniqueValues.forEach(function (val) {
    var count = allProducts.filter(function (p) { return p[field] === val; }).length;
    container.appendChild(createFilterButton(val, containerId, field, count));
  });
}
```
**Wine-only sort order to condition on category (UI-SPEC §7 risk), `07-catalog-kits.js:337-345`:**
```js
} else if (field === 'subcategory') {
  var styleOrder = ['red', 'white', 'rosé', 'rose', 'fruit', 'specialty'];
  uniqueValues.sort(function (a, b) {
    var aIdx = styleOrder.indexOf(a.toLowerCase());
    var bIdx = styleOrder.indexOf(b.toLowerCase());
    if (aIdx === -1) aIdx = styleOrder.length;
    if (bIdx === -1) bIdx = styleOrder.length;
    return aIdx - bIdx;
  });
}
```
Beer's "Style:" reuse of this same field must NOT apply `styleOrder` — gate it on the active category (e.g. `field === 'subcategory' && category !== 'beer'`), falling back to plain `.sort()` for beer per UI-SPEC's explicit recommendation.

**Numeric-sort precedent for the NEW `abv` field (D-13), `07-catalog-kits.js:331-336`:**
```js
if (field === 'time') {
  uniqueValues.sort(function (a, b) {
    var numA = parseFloat(a) || 0;
    var numB = parseFloat(b) || 0;
    return numA - numB;
  });
}
```
Mirror this exact numeric-parse-and-compare shape for `abv` (values are strings like `"5.8"`/`"5.8%"` — `parseFloat` already strips the `%` correctly).

**Beer call list (new, per UI-SPEC §7) — Style + ABV only, no Body/Oak/Sweetness:**
```js
buildFilterRow('filter-subcategory', 'subcategory', 'Style:');
buildFilterRow('filter-abv', 'abv', 'ABV:');
```
Also add `abv` to `activeFilters` (`:33`) and both `fields` arrays used by `matchesFilters`/`applyFilters` (`:453`, `:463`) — none of these currently reference `abv`.

---

### `js/modules/07-catalog-kits.js` — `buildBeerCard()` action tail (event-driven, click → waitlist)

**Analog:** the card's OWN current tail (existing code that must be replaced, not a different file) — `07-catalog-kits.js:882-902` (mirrors `buildWineCard()`'s identical tail at `:786-793`, which stays unchanged since D-12 doesn't touch wine):
```js
// CURRENT — must be replaced for D-12:
var reserveWrap = document.createElement('div');
reserveWrap.className = 'reserve-link product-reserve-wrap';
var productKey = getProductKey(product);
reserveWrap._reserveProduct = product;
reserveWrap._reserveKey = productKey;
reserveWrap._reserveRenderer = renderReserveControl;
renderReserveControl(reserveWrap, product, productKey);
card.appendChild(reserveWrap);

var kitBuyWrapBeer = document.createElement('div');
kitBuyWrapBeer.className = 'reserve-link reserve-link--secondary product-reserve-wrap';
kitBuyWrapBeer._reserveProduct = product;
kitBuyWrapBeer._reserveKey = productKey;
kitBuyWrapBeer._reserveRenderer = renderKitBuyControl;
renderKitBuyControl(kitBuyWrapBeer, product);
card.appendChild(kitBuyWrapBeer);
```
**Replace with (illustrative — copy the exact `beer.html:135` CTA string/target):**
```js
var waitlistLink = document.createElement('a');
waitlistLink.className = 'btn';
waitlistLink.href = 'beer.html#waitlist'; // or '#waitlist' if the card only ever renders on beer.html itself
waitlistLink.textContent = 'Join the Waitlist';
card.appendChild(waitlistLink);
```
Same replacement logic applies to the NEW recipe card's footer slot (below its price line, per UI-SPEC §6).

---

### `js/modules/07-catalog-kits.js` — recipe card builder (NEW, transform)

**Analog:** `buildDefaultCard()`, `07-catalog-kits.js:882-1063` — the plain `.product-card` idiom (NOT `buildWineCard()`/`buildBeerCard()`'s bottle-label idiom, per UI-SPEC §4's explicit "recipes must not read as products" instruction).

**Header pattern to copy, `07-catalog-kits.js:906-928`:**
```js
var header = document.createElement('div');
header.className = 'product-card-header';

var cardBrand = document.createElement('p');
cardBrand.className = 'product-brand';
cardBrand.textContent = product.brand; // recipe analog: N/A, omit or reuse for style

var cardName = document.createElement('h4');
cardName.textContent = product.name; // recipe analog: recipe.name
header.appendChild(cardName);

card.appendChild(header);
```
For the recipe card: `h4` = `recipe.name`, `.product-card-category` (styles.css:1624, "0.75rem/muted") = `recipe.style` (per UI-SPEC §5 anatomy — style sits where `buildDefaultCard()`'s `.product-detail-row` sits, but as `.product-card-category` since it's a single field, not a multi-field row).

**Price-box pattern to copy for the recipe price line, `07-catalog-kits.js:1004-1024` (reuse `.product-price-box`/`.product-price-value` classes, but recipe pricing SOURCE is different — see below, do not reuse the `retail_instore`/`retail_kit` computation, only the DOM/class shape):**
```js
var instoreBox = document.createElement('div');
instoreBox.className = 'product-price-box';
instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-value">' + formatCurrency(instore) + plusSign + '</span>';
priceRow.appendChild(instoreBox);
```
Recipe card price SOURCE (per UI-SPEC §5, NOT from `retail_instore`/`retail_kit` — recipes have their own `pricing_mode`/`computed_price`/`locked_price` fields from `GET /api/recipes`):
- `pricing_mode: 'dynamic'` → `recipe.computed_price` (already fee-inclusive); if `null`, show label **"Price set when you book"** instead of a price.
- `pricing_mode: 'locked'` → `recipe.locked_price + recipe.service_fee + recipe.materials_fee`.

**Description/blurb pattern — new territory (no existing JS references `.service-description` per RESEARCH's `grep` confirmation), but the CSS class already exists at `css/styles.css:1866`:**
```html
<p class="service-description">...</p>
```
Omit this element entirely if `recipe.description` is empty (D-07/UI-SPEC — never render empty `<p>` or placeholder text).

**Field order (UI-SPEC §5, deliberately price-before-blurb, opposite of kit cards): name → style → price → blurb → "Join the Waitlist" link.**

---

### `js/modules/07-catalog-kits.js` — recipe block renderer / `loadRecipes()` (NEW, request-response)

**Analog:** `loadProducts()`'s own fetch/skeleton/error/render shape (see excerpts above) — no separate module exists for recipes today; author this alongside the kit renderer in the same file, sharing its skeleton (`.catalog-skeleton-grid`, styles.css:1218) and error (`.catalog-error`/`.btn-retry.btn-outline`) conventions.

**Fetch target:** `GET {SHEETS_CONFIG.MIDDLEWARE_URL}/api/recipes?status=active` — no auth header (public read, matches D-05/D-06's contract). Do NOT pass `status=all` from any public page.

**`renderSection()` reuse for BOTH blocks (kit + recipe), `07-catalog-kits.js:1064-1075` (`renderSection` already early-returns on zero items — D-04's suppression mechanism, exactly as UI-SPEC §10 requires):**
```js
function renderSection(catalog, title, items, extraClass) {
  if (items.length === 0) return;
  var wrapper = document.createElement('div');
  wrapper.className = 'catalog-section' + (extraClass ? ' ' + extraClass : '');
  var sectionHeader = document.createElement('div');
  sectionHeader.className = 'catalog-section-header';
  var sectionHeading = document.createElement('h2');
  sectionHeading.className = 'catalog-section-title';
  sectionHeading.textContent = title;
  sectionHeader.appendChild(sectionHeading);
  ...
}
```
Call twice: `renderSection(catalog, 'Wine Kits'/'Beer Kits', kitItems)` and `renderSection(catalog, 'Beer Recipes', recipeItems)` — headings and sub-copy per UI-SPEC's Copywriting Contract. Both fetches (`/api/products` and `/api/recipes`) must settle BEFORE either paints (UI-SPEC §10 — no reflow-on-arrival), and order/tie-break is `kitCount >= recipeCount → [Kits, Recipes]` else reversed (UI-SPEC §3, LOCKED).

**`.product-grid--compact` application (UI-SPEC §2) — apply to the grid `<div>` inside `renderSection`'s output whenever `items.length <= 3`:**
```css
/* NEW — additive, next to .product-grid at styles.css:1526-1531 */
.product-grid--compact {
  grid-template-columns: repeat(auto-fit, minmax(280px, 320px));
  justify-content: start;
}
@media (max-width: 480px) {
  .product-grid--compact { grid-template-columns: 1fr; justify-content: stretch; }
}
```

---

### `js/modules/13-init.js` — `page === 'wine'`/`'beer'` dispatch branches

**Analog:** the existing multi-branch `page` gate, `13-init.js:331-349`:
```js
var page = document.body.getAttribute('data-page');
...
if (page === 'products' || page === 'ingredients' || page === 'ferment-in-store' || page === 'ingredients-supplies') {
  loadProducts();
  initReservationBar();
  initCartDrawer();
  initMobileBottomControls();
  initProductTabs();
  initCatalogViewToggle();
  if (_allIngredients.length === 0) loadIngredients(function () {});
  var tabParam = new URLSearchParams(window.location.search).get('tab');
  if (tabParam) { ... }
  else if (page === 'ingredients' || page === 'ingredients-supplies') { ... }
}
```
**New branches (illustrative shape — planner decides exact call signature):**
```js
if (page === 'wine') {
  loadProducts('wine');
  loadRecipes('wine'); // will resolve to zero (no wine recipes exist today — D-04 suppresses)
  initReservationBar();
  initCartDrawer();
  initMobileBottomControls();
  initCatalogViewToggle();
}
if (page === 'beer') {
  loadProducts('beer');
  loadRecipes('beer');
  initReservationBar();
  initCartDrawer();
  initMobileBottomControls();
  initCatalogViewToggle();
  setupBeerWaitlistForm(); // beer.html's existing waitlist form, unchanged
}
```
Note `initProductTabs()` is NOT called on either — the kits/ingredients tab switcher is a hub-only artifact per UI-SPEC §8 and doesn't apply once the hub's `#product-catalog` (with its tabs) is removed. Once the hub's `#product-catalog` block is removed, `'ferment-in-store'` should also be removed from the ORIGINAL gate's condition list (RESEARCH Open Question 2 recommendation, UI-SPEC confirms).

---

### `zoho-middleware/routes/recipes.js` — `GET /api/recipes` / `GET /api/recipes/:id` status guard (route, request-response)

**Analog:** `zoho-middleware/routes/catalog.js:628-698` — `isAdminGrade()` + its call site on `GET /api/ingredients?include_internal=1`. This is the established "public by default, richer for staff, self-resolves credential, never rejects" pattern in this codebase.

**The exact precedent to replicate, `zoho-middleware/routes/catalog.js:628-635`:**
```js
// Admin gate for the include_internal=1 mode (46-04). Internal-only items are
// not PII, but exposing them is staff-only. Resolves the request's own credential
// tier (this GET route is exempt from the global guard, so req.authTier is never
// set) and accepts legacy|session only — a kiosk device token must NEVER unlock
// Internal Only items (D-46-02, T-46-03b). Async because session lookup is async;
// callers must consume the returned Promise<boolean>.
function isAdminGrade(req) {
  return authTiers.resolveTier(req).then(function (tier) {
    return authTiers.allowAdmin(tier);
  });
}
```
**Call-site shape, `zoho-middleware/routes/catalog.js:693-698`:**
```js
router.get('/api/ingredients', function (req, res) {
  if (req.query && req.query.include_internal === '1') {
    return isAdminGrade(req).then(function (isAdmin) {
      if (isAdmin) return serveFullIngredients(res);
      return servePublicIngredients(req, res);
    });
  }
  return servePublicIngredients(req, res);
});
```
**`authTiers.js` primitives being reused, unchanged — `zoho-middleware/lib/authTiers.js:100-107`, `:116-138`:**
```js
function allowKiosk(tier) {
  return tier === 'legacy' || tier === 'device' || tier === 'session';
}
function allowAdmin(tier) {
  return tier === 'legacy' || tier === 'session';
}
async function resolveTier(req) {
  var headers = (req && req.headers) || {};
  if (apiKeyGuard.matches(headers['x-api-key'])) return 'legacy';
  if (deviceToken.matches(headers['x-device-token'])) return 'device';
  var headerToken = headers['x-session-token'];
  var sid = (req && req.cookies && req.cookies.sv_session) ||
    (typeof headerToken === 'string' ? headerToken : '');
  if (sid) {
    var payload = await session.getSession(sid);
    if (payload) { ...; return 'session'; }
  }
  return null;
}
```
D-06's rationale ("unauthenticated callers get active only; staff tiers may still request drafts") maps directly onto `allowKiosk(tier)` (legacy/device/session all count as staff for THIS purpose — unlike the admin-only ingredients gate, kiosk devices should also be able to see draft recipes, since BrewPad recipe-building happens at the kiosk).

**Current handler to modify, `zoho-middleware/routes/recipes.js:254-269` (status defaults to `'all'` with zero guard today — this is the exact bug D-06 fixes):**
```js
router.get('/api/recipes', function (req, res) {
  var status = req.query.status || 'all';
  var limit  = parseInt(req.query.limit, 10) || 0;
  var offset = parseInt(req.query.offset, 10) || 0;
  var cacheKey = C.CACHE_KEYS.RECIPES + ':' + status + ':' + limit + ':' + offset;
  ...
```
**Recommended shape (RESEARCH's own illustrative fix, matches the `isAdminGrade` precedent's structure):**
```js
router.get('/api/recipes', function (req, res) {
  return authTiers.resolveTier(req).then(function (tier) {
    var isStaff = authTiers.allowKiosk(tier);
    var requestedStatus = req.query.status || 'all';
    var status = isStaff ? requestedStatus : 'active'; // D-06
    var limit  = parseInt(req.query.limit, 10) || 0;
    var offset = parseInt(req.query.offset, 10) || 0;
    var cacheKey = C.CACHE_KEYS.RECIPES + ':' + status + ':' + limit + ':' + offset;
    // ...rest of existing handler body, unchanged
  });
});
```
Cache-key shape is preserved (`RECIPES + ':' + status + ...`), so `bustRecipeCache()`'s existing `['all','draft','active','inactive']` loop (`recipes.js:51`) already busts the right keys — no cache-invalidation changes needed.

**`GET /api/recipes/:id` (`recipes.js:293-325`) needs the same treatment per RESEARCH Open Question 4 — it currently returns FULL ingredient detail regardless of status, a bigger leak than the list endpoint. Flag to planner: apply the identical `resolveTier`/`allowKiosk` gate, returning 404 (not the recipe) when status is non-active and caller isn't staff — matches this route's existing 404-on-not-found shape (`recipes.js:313`) rather than introducing a new 403 response shape for a route that's supposed to look like "recipe doesn't exist" to an unauthorized enumerator.**

---

### `zoho-middleware/__tests__/` — D-06 regression test (test, request-response)

**Analog:** `zoho-middleware/__tests__/catalog-bust-auth.test.js` — closest existing test for "optional-auth GET route, unmocked `authTiers`, assert unauth vs staff-tier behavior differs."

**Mock/harness shape to copy, `catalog-bust-auth.test.js:1-45` (note: `../lib/authTiers` is deliberately NOT mocked — "the real requireTiers/apiKeyGuard logic is exercised"):**
```js
var mockRouteHandlers = {};
jest.mock('express', function () {
  var router = {
    get: jest.fn(function (path, handler) { mockRouteHandlers[path] = handler; }),
    post: jest.fn(function (path, handler) { mockRouteHandlers[path] = handler; })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
// lib/cache, lib/logger mocked; lib/authTiers NOT mocked
```
**Test shape to copy, `catalog-bust-auth.test.js:105-119`:**
```js
test('NO credential → active-only, drafts excluded, no computed_price leak', function () {
  return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: {} }).then(function (res) {
    // assert res._body.recipes contains no draft-status recipe
  });
});
test('WITH a valid legacy/device/session credential → status=draft honored', function () {
  return callHandler('GET', '/api/recipes', { query: { status: 'draft' }, headers: { 'x-api-key': API_KEY } }).then(function (res) {
    // assert drafts ARE returned — no regression to BrewPad's own admin recipe list
  });
});
```
`recipes.test.js`'s OWN `resetAndLoadRecipes()`/`callHandler()` helpers (`recipes.test.js:49-72`, method-keyed `mockRouteHandlers['GET:' + path]`, not path-only like `catalog-bust-auth.test.js`) should be reused/extended rather than duplicated — the new D-06 tests belong inside the existing `describe('GET /api/recipes', ...)` block (`recipes.test.js:78`) or a new adjacent `describe` in the same file, using the same jest.mock setup already in place (note: this file currently mocks `express`/`axios`/`cache`/`logger`/`constants` but NOT `authTiers` — confirm this stays unmocked when adding the new tests, matching `catalog-bust-auth.test.js`'s approach).

---

### `tests/frontend/` — category-filter + beer-card-action regression tests (test, transform)

**Analog:** `tests/frontend/catalog-kits-proto-guard.test.js` — the only existing test that loads `07-catalog-kits.js` in Node via `require()`, using the browser-global-stub pattern.

**Full stub/require pattern to copy, `catalog-kits-proto-guard.test.js:1-21`:**
```js
global.KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];
global.document = { getElementById: function () { return null; } };
global.fetch = function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } }); };
global.localStorage = { getItem: function () { return null; }, setItem: function () {} };
global.SHEETS_CONFIG = { MIDDLEWARE_URL: '' };
global.window = global.window || {};
global.showCatalogSkeletons = function () {};

var mod = require('../../js/modules/07-catalog-kits.js');
```
**IMPORTANT gap to close:** `module.exports` at `07-catalog-kits.js:1522-1524` currently exposes ONLY `flattenCustomFields`:
```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { flattenCustomFields: flattenCustomFields };
}
```
To test `loadProducts(categoryFilter)`'s category-scoping and `buildBeerCard()`'s new action tail in isolation (RESEARCH's stated testing obligation), this export list must be extended — but `loadProducts`/`buildBeerCard` are currently declared INSIDE `loadProducts()`'s own closure or as sibling functions at module scope (verify exact scope at edit time: `buildBeerCard` is module-scope per the `renderSection`'s dispatch call at `:1427-1436`; `loadProducts` is itself the outer function). Planner should size "extend `module.exports`" as its own small task, not assume it's free.

---

## Shared Patterns

### CSP meta tag (all new/modified public pages)
**Source:** `beer.html:19` (see full excerpt above)
**Apply to:** `wine.html` (new page — copy verbatim per CLAUDE.md rule 12 / `docs/TRACKING.md`)

### `.catalog-section` / `.catalog-section-header` / `.catalog-section-title` block wrapper
**Source:** `css/styles.css:1502-1516`, `renderSection()` at `07-catalog-kits.js:1064-1075`
**Apply to:** every rendered block on `/wine` and `/beer` — kit block AND the new recipe block, called twice per page.

### `.catalog-skeleton-grid` loading state
**Source:** `css/styles.css:1218`, invoked at `07-catalog-kits.js:148-150`
**Apply to:** both the kit fetch and the new recipe fetch — size the skeleton to the expected 1-3 card count on `/beer` (UI-SPEC §10).

### `.catalog-error` / `.btn-retry.btn-outline` error state
**Source:** `07-catalog-kits.js:290-309` (kit-block pattern, currently monolithic/all-or-nothing)
**Apply to:** kit block (reuse as-is) AND independently to the new recipe block (must NOT be shared/monolithic — a recipe-fetch failure must not blank a successfully-loaded kit block, per UI-SPEC §10).

### `authTiers.resolveTier(req)` / `allowKiosk(tier)` optional-auth pattern
**Source:** `zoho-middleware/lib/authTiers.js:100-138`, precedent call site `zoho-middleware/routes/catalog.js:628-698`
**Apply to:** `GET /api/recipes` and `GET /api/recipes/:id` (D-06). Do NOT use `requireTiers()` — it rejects when no credential is present, wrong for a route that must stay public.

### `.btn` / `.btn-secondary` CTA classes
**Source:** `css/styles.css:771` (`.btn`), `:809` (`.btn-secondary`)
**Apply to:** beer card's "Join the Waitlist" link (`.btn`), hub category entry links (`.btn-secondary`) — both already satisfy the 44px touch-target minimum and inherit sitewide focus-visible styling with zero new CSS.

### Node test-env global-stub harness for `07-catalog-kits.js`
**Source:** `tests/frontend/catalog-kits-proto-guard.test.js:1-21`
**Apply to:** any new frontend test exercising `loadProducts(categoryFilter)`, `buildFilterRow()`'s category-conditioned sort, or `buildBeerCard()`'s new action tail.

### `resetAndLoadRecipes()` / `callHandler()` middleware test harness
**Source:** `zoho-middleware/__tests__/recipes.test.js:49-72`
**Apply to:** new D-06 status-guard tests — reuse this file's existing harness (method-keyed handler map) rather than `catalog-bust-auth.test.js`'s path-only variant, since `recipes.js` registers both `GET`/`POST`/`PUT`/`DELETE` on overlapping paths.

## No Analog Found

| File/Component | Role | Data Flow | Reason |
|---|---|---|---|
| Recipe card markup (`.product-card` + `.service-description` + `.service-price` wiring) | component | transform | No existing JS wires these specific CSS classes today (confirmed by RESEARCH's `grep`: zero JS references to `service-description`/`service-price`). CSS itself exists and is documented above under `buildDefaultCard()`'s pattern — this is a "reuse dead CSS, write new JS" situation, not a from-scratch design. |
| `.hub-categories`/`.hub-category-item` navigational section | component | n/a (static content) | No existing 3-item link-out grid exists anywhere on the site; UI-SPEC's own CSS (2 rules) is the closest thing to an "analog" — it's new but trivially small and reuses `.product-grid`'s established `2rem`/`280px` rhythm rather than inventing new spacing values. |

## Metadata

**Analog search scope:** `js/modules/07-catalog-kits.js`, `js/modules/13-init.js`, `js/modules/12-checkout.js`, `zoho-middleware/routes/recipes.js`, `zoho-middleware/routes/catalog.js`, `zoho-middleware/lib/authTiers.js`, `zoho-middleware/__tests__/`, `tests/frontend/`, `products/ferment-in-store.html`, `beer.html`, `package.json`, `sitemap.xml`, `css/styles.css`
**Files scanned:** 18 (13 read in full or targeted sections this session; 5 more already fully read and cited by 74-RESEARCH.md/74-UI-SPEC.md and reused here without re-reading)
**Pattern extraction date:** 2026-09-01
