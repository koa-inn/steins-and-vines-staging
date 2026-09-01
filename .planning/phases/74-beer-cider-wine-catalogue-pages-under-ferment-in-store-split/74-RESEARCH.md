# Phase 74: Beer/Wine catalogue pages under Ferment-in-Store - Research

**Researched:** 2026-09-01
**Domain:** Static ES5 frontend catalogue rendering + Express/Zoho middleware public API exposure
**Confidence:** HIGH on all live-verifiable claims (queried production directly); MEDIUM–LOW on the two genuinely open design questions (tie-break ordering, hub/ingredients-tab disposition)

## Summary

Two things this research found change the shape of the phase materially from how `74-CONTEXT.md` frames them, and both make the phase **smaller and more concrete** than "unknown sizing" suggested.

First, the sizing question is answered with a **live, right-now** query against production (`GET https://svmiddleware-production.up.railway.app/api/recipes`, read-only, no auth required today — this is D-06's own finding). As of 2026-09-01 there are **10 total recipes, of which exactly 1 is `status: active`** ("Czech Lager", SV-R-000002). All 10 recipes — active and draft alike — are beer/lager/ale styles; **zero wine recipes exist**, and the recipe schema itself (`ibu`, `colour_srm`, `batch_size_l`, brewing-specific `abv`) has no wine-shaped fields and no category field of any kind. Recipes are, structurally, a beer/cider brewing concept in this codebase today. This means: the D-08 content pass is **one blurb, not a batch** (Czech Lager's `description` is currently an empty string — it needs to be *written*, not edited-down from staff jargon), and the wine page's recipe block will be **empty and correctly unrendered** (D-04) at ship time.

Second, verifying the kit side live confirms CONTEXT's "238 kits" figure exactly and additionally quantifies beer: **238 Wine kits, 11 Cider kits, 1 Beer kit** (`cf_type` custom field, a reliable structured category — unlike recipes). The one beer kit ("Festa Brew West Coast IPA Kit", $80, 1 in stock) is *already* rendering today, unscoped, with full add-to-cart machinery, on `products/ferment-in-store.html` — because the shared catalogue JS (`loadProducts()` in `07-catalog-kits.js`) has **no category-scoping at all** currently; it loads all `KIT_CATEGORIES` (wine+beer+cider+seltzer) combined on every page that calls it. `buildBeerCard()` already exists as CONTEXT states, but it currently wires `renderReserveControl` + `renderKitBuyControl` — the same purchase/add-to-cart buttons wine gets — which **directly contradicts D-12** ("beer cards lead to the waitlist"). This card needs a real behavior change, not just reuse.

**Primary recommendation:** category-scope `loadProducts()` with an optional parameter, dispatched by the existing `data-page` → `page` pattern already used in `js/modules/13-init.js` (the same mechanism that already special-cases `ferment-in-store`/`ingredients-supplies`/`products`/`ingredients`) — this is Claude's-discretion option 3 in CONTEXT and is the path of least resistance because the dispatch table already exists. For D-06, replicate the existing optional-auth precedent at `zoho-middleware/routes/catalog.js:628-635` (`isAdminGrade`) rather than inventing a new pattern.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Category-scoped kit listing (wine/beer) | Browser/Client (`07-catalog-kits.js`) | API/Backend (`GET /api/products`, unchanged) | Category filter (`cf_type`) is already present on every item the API returns; scoping is a client-side filter concern, matching the existing (unscoped) implementation's architecture — no API contract change needed for kits |
| Public recipe listing + status enforcement | API/Backend (`GET /api/recipes`) | — | D-06 is explicitly an endpoint-level control; a page-side filter is stated as insufficient. This is the one capability that MUST move server-side in this phase |
| Public recipe card rendering | Browser/Client (net-new) | — | No existing public recipe card exists; must be authored from scratch, reusing the label-card visual idiom `buildBeerCard`/`buildWineCard` establish |
| Per-category filter dimensions (D-13) | Browser/Client (`07-catalog-kits.js`) | — | Filter UI is entirely client-rendered from `allProducts`; no backend involvement |
| Card action routing (add-to-cart vs waitlist) | Browser/Client (`07-catalog-kits.js` + `12-checkout.js`) | — | `renderReserveControl`/`renderKitBuyControl` (cart) vs `setupBeerWaitlistForm` (waitlist) are both existing client-side machinery; this phase wires which one a card uses |
| Hub page content (SEO/landing copy) | Static HTML/CDN | — | No JS involved; a content/structure edit to `products/ferment-in-store.html` |
| New page scaffolding (`/wine`) | CDN/Static (GitHub Pages) | Browser/Client (catalogue JS reused) | New root-level static HTML file + existing shared JS bundle, no new build tooling |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

- **D-01:** Every category page lists both kits and recipes — two blocks, not one mixed grid.
- **D-02:** The two blocks are separate and labelled.
- **D-03:** Block order is dynamic by count — whichever set has more items leads. No per-category ordering config.
- **D-04:** A block with zero items is not rendered at all — never a bare heading over empty space.
- **D-05:** Public pages list active recipes only (`?status=active`), reusing the existing BrewPad `draft`/`active` flag. No new published/public field.
- **D-06:** The endpoint itself (`GET /api/recipes`) must enforce active-only for unauthenticated callers; staff tiers may still request drafts. A page-side filter alone is not a control.
- **D-07:** A public recipe card exposes name, style, price, short blurb — never ingredient lists, per-item costs, or margin-derivable data.
- **D-08:** A content pass over all active recipes' descriptions is in scope and gates release. Size was unknown at CONTEXT time (now resolved by this research — see Summary).
- **D-09:** Category pages are root siblings: `/beer` stays exactly where it is; `/wine` joins it. No move under `/products/`.
- **D-10:** `products/ferment-in-store.html` becomes a neutral hub covering the categories, but keeps a substantial wine section retaining its existing "Make Your Own Wine in Squamish" phrasing. The wine catalogue *grid* moves to `/wine`. Only one wine catalogue exists, so no canonical-tag problem.
- **D-11:** `beer.html`'s existing launch copy is kept, not replaced. Order: hero → What It Is → How It Works → What's Included → catalogue → waitlist → FAQ.
- **D-12:** Card actions vary by category. Wine kits keep add-to-cart (live revenue, do not regress). Beer cards lead to the waitlist. The shared card component needs a per-category action config.
- **D-13:** Per-category filter sets. Wine keeps `body`/`oak`/`sweetness`/`abv`. Beer gets style/abv. The Phase 77 chip panel renders whatever set it is handed, so the panel itself likely needs no change — a per-category config does. **(This research corrects the Phase 77 attribution — see Canonical References below.)**

### Claude's Discretion

- Exact hub layout and section ordering, beyond D-10's requirement that wine stay prominent and keep its ranking phrasing.
- Card markup and CSS, provided it reuses existing catalogue components.
- How the per-category config is expressed (constants, data attributes, or page-level init) — planner/researcher to choose from existing patterns. **This research recommends the page-level `data-page` dispatch already used in `13-init.js` — see Architecture Patterns.**
- Sort options per category (not discussed).

### Deferred Ideas (OUT OF SCOPE)

- `/cider` catalogue page — 11 cider kits in stock, `cider.html` deleted 2026-08-27, launch intent unconfirmed.
- Cider launch-announcement copy.
- Ingredient lists on public cards — deliberately excluded by D-07.
- Hub/wine SEO follow-up — moving wine copy entirely off the hub is a later option if `/wine` builds its own authority.

</user_constraints>

<phase_requirements>
## Phase Requirements

This phase's scope is defined entirely by `74-CONTEXT.md`'s decisions D-01 through D-13 (owner direction 2026-08-25, refined 2026-08-31) rather than a `REQUIREMENTS.md` ID set — this phase sits outside the v4.5/v4.6/v4.7/v4.8 requirement ladder in `.planning/REQUIREMENTS.md` (those cover the "Security & Money-Path Closeout" milestone; Phase 74 is a separate owner-driven product feature tracked only in the roadmap/CONTEXT).

| ID | Description | Research Support |
|----|-------------|------------------|
| D-01/D-02 | Two labelled blocks (kits + recipes) per category page | Confirmed no existing dual-block renderer exists; `renderCatalog`/`renderSection` in `07-catalog-kits.js` currently render one flat kit grid. Net-new rendering logic needed for the recipe block; kit block reuses existing `renderSection`. |
| D-03/D-04 | Dynamic order-by-count, zero-item suppression | Live counts obtained: wine recipes=0 (suppressed), beer recipes=1 active + up to 1 kit (near-tie — see Open Questions for tie-break gap). |
| D-05/D-06/D-07 | Public recipe read contract | `GET /api/recipes` confirmed live to have no tier guard and to serve `computed_price` on drafts today. Fix pattern identified (`catalog.js:628-635` precedent). |
| D-08 | Content pass gates release | Sized: 1 active recipe, empty `description` field — must be authored, not edited. |
| D-09 | `/wine` as root sibling of `/beer` | Confirmed `sitemap.xml` uses clean root URL for beer (`/beer`, no `.html`); same pattern applies to `/wine`. |
| D-10 | Hub rewrite | Read the live file; wine landing copy + boundaries identified line-by-line (see Hub Rewrite section). |
| D-11 | Beer page section order kept | Confirmed live `beer.html` section order matches D-11's spec exactly already (hero → What It Is → How It Works → What's Included → [catalogue inserted here] → waitlist → FAQ). |
| D-12 | Per-category card actions | Confirmed `buildBeerCard()` currently uses cart machinery, not waitlist — this is a real code change, not a no-op. |
| D-13 | Per-category filter sets | Confirmed `body`/`oak`/`sweetness` exist as filter rows today (wine-scoped); confirmed `abv` does **not** exist as a filterable field anywhere in `07-catalog-kits.js` today — D-13's "beer gets abv" is **net-new filter engineering**, not config-only. |

</phase_requirements>

## Standard Stack

No new libraries. This phase is entirely within the existing static ES5 stack (`js/modules/07-catalog-kits.js`, `13-init.js`, `12-checkout.js`) and the existing Express middleware (`zoho-middleware/routes/recipes.js`, `lib/authTiers.js`). No `npm install` of any kind is implicated.

**Package Legitimacy Audit:** N/A — this phase introduces zero new external packages (frontend or middleware). No slopcheck/registry verification is required.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────┐
                     │  Zoho Inventory (kits)                   │
                     │  cf_type = Wine|Beer|Cider|Seltzer        │
                     └──────────────────┬────────────────────────┘
                                         │ GET /api/products (public, unauth, existing)
                                         ▼
┌────────────────────────────────────────────────────────────────────┐
│ zoho-middleware  (Express, Railway)                                 │
│                                                                       │
│  GET /api/products  ── unchanged, already returns cf_type per item  │
│                                                                       │
│  GET /api/recipes   ── TODAY: no tier guard, status defaults 'all', │
│                         computed_price leaks on drafts (D-06 bug)   │
│                         AFTER: unauth → forced status=active,       │
│                         staff tiers (legacy/device/session) → honor │
│                         requested status. Pattern: authTiers        │
│                         .resolveTier(req) inline, NOT requireTiers  │
│                         (never reject — this route is public)        │
└──────────────────────────────┬───────────────────────────────────────┘
                                │ fetch()
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Browser — /wine, /beer (new/extended static pages)                  │
│                                                                       │
│  13-init.js: page = document.body[data-page]                        │
│    'wine' → loadProducts('wine')  ─┐                                 │
│    'beer' → loadProducts('beer')  ─┼─► 07-catalog-kits.js            │
│                                     │     - filters allProducts by   │
│                                     │       category (cf_type)       │
│                                     │     - buildFilterRow() calls   │
│                                     │       become per-category      │
│                                     │     - card dispatch:            │
│                                     │       wine → buildWineCard      │
│                                     │         (renderReserveControl)  │
│                                     │       beer → buildBeerCard      │
│                                     │         (NEW: waitlist link,    │
│                                     │         not cart)               │
│                                     │                                 │
│    NEW: loadRecipes('beer'|'wine') │──► GET /api/recipes?status=active
│         renders 2nd labelled block │     (no auth header — public)   │
│         order-by-count vs kit block│                                 │
│         zero-suppressed (D-04)     │                                 │
└────────────────────────────────────────────────────────────────────┘
```

### Recommended Approach for Category-Scoping (Claude's Discretion, D-01/D-13 mechanism)

**Recommendation: page-level init dispatch, extending the existing `data-page` pattern — not a new constants config, not data attributes.**

`js/modules/13-init.js:331` already gates catalogue init on an explicit `page` string:
```js
// Source: js/modules/13-init.js:330-336 (current, unmodified)
if (page === 'products' || page === 'ingredients' || page === 'ferment-in-store' || page === 'ingredients-supplies') {
  loadProducts();
  initReservationBar();
  initCartDrawer();
  initMobileBottomControls();
  initProductTabs();
  initCatalogViewToggle();
  if (_allIngredients.length === 0) loadIngredients(function () {});
  ...
}
```
`page` is read from `document.body.getAttribute('data-page')` (confirmed via `<body data-page="beer">` on `beer.html` and `<body data-page="ferment-in-store">` on the hub). Adding `page === 'wine'` / `page === 'beer'` branches that call `loadProducts('wine')` / `loadProducts('beer')` (new optional parameter) is a **minimal-diff extension of an established, already-multi-branch pattern** — not a new mechanism. This avoids inventing a constants-config layer or DOM data-attribute scheme that nothing else in the codebase uses.

**Why not the other two discretion options:**
- A constants config (e.g. `CATEGORY_FILTER_CONFIG` in `js/lib/constants.js`) would be reasonable but has no precedent in this codebase for *page-scoped* behavior (constants.js currently holds only cross-cutting values like `KIT_CATEGORIES`, not per-page dispatch tables).
- Data attributes on the page (e.g. `<div id="product-catalog" data-category="wine">`) would work but duplicates information already carried by `data-page` on `<body>`, and would require `loadProducts()` to do its own DOM read instead of receiving an explicit argument — less testable in isolation than a parameter.

### Category filter implementation point (mechanical)

`07-catalog-kits.js` has exactly two places that currently apply the *combined* `KIT_CATEGORIES` filter (wine+beer+cider+seltzer, unscoped) — both need a category-aware branch:
```js
// Source: js/modules/07-catalog-kits.js:123-128 (loadFromMiddleware path)
// and :168-173 (near-identical duplicate in the dataPromise.then() chain)
var cat = (obj.category || obj._zoho_category || obj.type || '').toLowerCase();
if (!cat) return false;
return KIT_CATEGORIES.some(function (kc) { return cat.indexOf(kc) !== -1; });
```
Recommendation: change `KIT_CATEGORIES.some(...)` to check against a single passed-in `categoryFilter` string when one is provided (falsy → today's combined behavior, preserving `products.html`'s existing all-category view untouched). This is a **2-line diff per call site**, not a rewrite.

### Card action routing (D-12) — concrete change required

```js
// Source: js/modules/07-catalog-kits.js:1427-1436 (existing dispatch, unmodified)
var productType = (product.type || '').toLowerCase();
var card;
if (productType.indexOf('wine') !== -1) {
  card = buildWineCard(product);
} else if (productType.indexOf('beer') !== -1) {
  card = buildBeerCard(product);
} else {
  card = buildDefaultCard(product);
}
```
```js
// Source: js/modules/07-catalog-kits.js:882-889 (buildBeerCard's CURRENT tail — this is
// the part that must change for D-12; it is wired IDENTICALLY to wine's add-to-cart today)
var reserveWrap = document.createElement('div');
reserveWrap.className = 'reserve-link product-reserve-wrap';
...
reserveWrap._reserveRenderer = renderReserveControl;   // <-- cart machinery
renderReserveControl(reserveWrap, product, productKey); // <-- cart machinery
card.appendChild(reserveWrap);

var kitBuyWrapBeer = document.createElement('div');
...
kitBuyWrapBeer._reserveRenderer = renderKitBuyControl;  // <-- cart machinery ("Buy Kit")
```
**Finding:** `buildBeerCard()` "already exists" (as CONTEXT states) but its action buttons are the same Reserve/Buy-Kit cart controls wine uses — not a waitlist link. D-12 requires replacing this tail with a link/button to `beer.html#waitlist` (or equivalent), gated by a category flag, not adding new logic from scratch onto an unwired card. Treat this as a genuine behavior change, sized like one.

### Per-category filter rows (D-13) — two distinct sub-problems

1. **Suppression of non-applicable filter rows.** `buildFilterRow()` unconditionally appends its label span before checking whether any product has a value for that field:
   ```js
   // Source: js/modules/07-catalog-kits.js:314-329
   function buildFilterRow(containerId, field, label) {
     var container = document.getElementById(containerId);
     if (!container) return;
     var labelSpan = document.createElement('span');
     labelSpan.className = 'catalog-filter-label';
     labelSpan.textContent = label;
     container.appendChild(labelSpan);          // <-- always runs
     var uniqueValues = [];
     allProducts.forEach(...)                    // <-- may be empty for beer
     ...
   }
   ```
   If `/beer`'s `allProducts` (beer-only) has no `body`/`oak`/`sweetness` values (near-certain — these are wine tasting-profile custom fields), calling `buildFilterRow('filter-body', 'body', 'Body:')` on the beer page renders a bare "Body:" label with zero buttons — a visible UI defect. **The per-category config must be a call-list** (which `buildFilterRow()` invocations happen for which category), not a data-driven auto-suppression — the function itself doesn't self-hide.

2. **ABV filtering is net-new, not config.** `abv` does not appear in `activeFilters` (`js/modules/07-catalog-kits.js:33`), `matchesFilters`'s `fields` array (:453), `applyFilters`'s `fields` array (:463), or as a `buildFilterRow` call anywhere. D-13's "beer gets style/abv" requires: adding `abv` to `activeFilters`, both `fields` arrays, a new `buildFilterRow('filter-abv', 'abv', 'ABV:')` call, a new `<div class="catalog-filter-row" id="filter-abv"></div>` in the beer page markup, and (since `abv` values are strings like `"5.8"` or `"5.8%"` — confirmed via the live recipe/kit payloads) a numeric-bucket or exact-match filter design decision the planner must make (not specified by CONTEXT). Flag this to the planner explicitly — it's real filter engineering, not a config toggle.

3. **"Style" filter reuse has a hidden wine-specific sort order.** The existing `subcategory` field (rendered as "Style:" — see `filterLabels` at :578, and `buildFilterRow('filter-subcategory', 'subcategory', 'Style:')` at :194) has a **wine-specific** custom sort order baked into `buildFilterRow`:
   ```js
   // Source: js/modules/07-catalog-kits.js:337-345
   } else if (field === 'subcategory') {
     var styleOrder = ['red', 'white', 'rosé', 'rose', 'fruit', 'specialty'];
     uniqueValues.sort(function (a, b) { ... });
   }
   ```
   Reusing `subcategory` for beer's "style" filter (IPA/Lager/Stout/etc., taken from the `cf_subcategory` custom field the same way wine's is) will apply this wine-only ordering to beer styles unless conditioned on category. Minor, but a real correctness gap if unaddressed — beer styles would sort by matching zero entries in `styleOrder`, falling back to array-insertion order (effectively unsorted/arbitrary), which is a worse UX regression than "no sort" would suggest at a glance.

### Recommended Project Structure (files touched, not new directories)

```
beer.html                          # extended: add #product-catalog markup + fuse.min.js script tag
wine.html                          # NEW: full page, scaffold copied from products/ferment-in-store.html
products/ferment-in-store.html     # rewritten: hub — landing copy kept, #product-catalog block removed
js/modules/07-catalog-kits.js      # loadProducts(categoryFilter), buildBeerCard() action tail, filter-row call-list, abv support
js/modules/13-init.js              # page==='wine'/'beer' branches; remove 'ferment-in-store' from the catalogue-init gate (see Open Questions)
zoho-middleware/routes/recipes.js  # GET /api/recipes tier-aware status default; GET /api/recipes/:id same treatment
zoho-middleware/lib/authTiers.js   # no change needed — resolveTier()/allowKiosk()/allowAdmin() already sufficient
package.json                       # stamp:pages array: add 'wine.html'
sitemap.xml                        # add <loc>https://steinsandvines.ca/wine</loc>
17 nav-carrying HTML pages         # manual dropdown edit to add a Wine link (see New Page Mechanics)
```

### Anti-Patterns to Avoid

- **Client-side-only recipe status filtering.** D-06 explicitly rejects this — CONTEXT is correct and this research confirms the vulnerability is real and live today (verified: `GET /api/recipes?status=all` returns all 9 drafts with `computed_price` to an anonymous curl request right now).
- **Using `requireTiers()` on `GET /api/recipes`.** `requireTiers()` rejects (401/403) when no credential is present — wrong for a route that must stay public for anonymous visitors. Use the `resolveTier()`-without-reject pattern instead (see below).
- **Assuming `recipe.style` can double as a category field.** It is free text (`<input type="text" placeholder="e.g. American Pale Ale">` in `brewpad.html:185`) with no controlled vocabulary — do not build wine/beer/cider inference logic against it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Optional server-side auth (public route, richer behavior for staff) | A new middleware or a bespoke tier-check | `authTiers.resolveTier(req)` called directly (not wrapped in `requireTiers`), exactly as `zoho-middleware/routes/catalog.js:628-635`'s `isAdminGrade(req)` already does for the `include_internal=1` ingredients gate | This exact pattern (GET route exempt from the global `/api` guard at `server.js:288`, self-resolves its own credential, never rejects) is already established and tested in this codebase for an equivalent "public by default, richer for staff" need |
| Category-scoped catalogue rendering | A second copy of `07-catalog-kits.js`, or a new catalogue framework | Extend the existing `loadProducts()`/`renderCatalog()`/`buildFilterRow()` functions with an optional category parameter | The shared module already handles caching (`MW_CACHE_KEY`), snapshot fallback, Fuse search, sort, and stock filtering — duplicating it for wine/beer would fork logic CLAUDE.md explicitly asks to avoid ("don't touch unrelated code," "flag design smells") and would double the maintenance surface for a money-path-adjacent module |
| New public page boilerplate | Hand-authoring `/wine`'s `<head>`, CSP, schema.org block from scratch | Copy `products/ferment-in-store.html`'s scaffold (it already has the cart-sidebar/cart-drawer markup `/wine` needs, unlike `beer.html`) and `beer.html`'s CSP `<meta>` (most recently verified against `docs/TRACKING.md`) | Matches CLAUDE.md's explicit instruction: "new public pages copy their CSP from a sibling page" |

**Key insight:** Every piece of machinery this phase needs (kit rendering, cart, waitlist form, recipe read API, staff tier resolution) already exists in some form. The work is *scoping* and *routing* existing machinery per category, plus one genuinely new piece (the public recipe card/block) — not building new subsystems. This should keep the phase's task count in "wire together" territory rather than "invent" territory.

## Common Pitfalls

### Pitfall 1: Treating `buildBeerCard()` as "done" because it exists
**What goes wrong:** A plan assumes D-12 is satisfied because `buildBeerCard()` is already dispatched for beer-type products.
**Why it happens:** CONTEXT's canonical_refs describes it as "already exists," which is true but incomplete — its *action buttons* are wired for cart/purchase, not waitlist.
**How to avoid:** Explicitly task the reserve/buy-control tail replacement in `buildBeerCard()` (lines ~882-902) as its own unit of work with its own test.
**Warning signs:** A beer kit card on `/beer` showing "Reserve to Ferment In-Store" or "Buy Kit" buttons instead of a waitlist CTA.

### Pitfall 2: Assuming recipes have a category field somewhere not yet found
**What goes wrong:** A plan spends time searching for or designing around a `recipe.category`/`recipe.type` field that doesn't exist.
**Why it happens:** Every other product-ish entity in this codebase (kits, via `cf_type`) has one, so it's a reasonable but wrong assumption.
**How to avoid:** This research confirms via the live `Recipes` sheet schema (`apps-script/adminApi.gs:3768` header row: `recipe_id, name, style, description, status, locked_price, service_fee, materials_fee, batch_size_l, abv, ibu, colour_srm, notes, created_at, created_by, updated_at, pricing_mode`) that no category column exists, and via live data that all 10 existing recipes are beer-styled. Given zero counter-examples exist today, the simplest correct design is: **recipes render on `/beer` only; the wine recipe block is always empty (and therefore never rendered, per D-04) until a wine recipe is ever created.** Do not build style-keyword inference (e.g., matching `style` against a wine-word list) — it's speculative complexity for a case with no live data to validate against, and CONTEXT's D-05 explicitly resists adding new fields.
**Warning signs:** A plan task titled "infer recipe category from style text" or "add category column to Recipes sheet."

### Pitfall 3: Silent empty filter-row labels on the beer page
**What goes wrong:** Reusing the wine page's full `buildFilterRow()` call list on `/beer` renders "Body:", "Oak:", "Sweetness:" labels with no buttons beneath them.
**Why it happens:** `buildFilterRow()` always appends its label before checking for data (see Architecture Patterns above) — there's no self-suppression.
**How to avoid:** Make the `buildFilterRow()` call list itself category-conditional (an explicit if/else per page, or a small per-category array of `[containerId, field, label]` tuples), not just trust that empty data produces an empty-looking row.
**Warning signs:** Visual QA on `/beer` showing orphaned filter labels with no chips.

### Pitfall 4: `products.html`'s redirect masking scope
**What goes wrong:** Assuming `products.html` is a second, independent catalogue page that also needs category-scoping or a `/wine` link update.
**Why it happens:** It appears in nav/link searches and has its own `<title>`/CSP/schema.org block.
**How to avoid:** `products.html:5` is a pure client-side redirect stub (`location.replace('products/ferment-in-store.html'+q)`) — it has no `#product-catalog` DOM and is not a live rendering surface. Its own nav dropdown (containing a "Beer" link) does still need the same manual nav edit as the other 16 files, but no catalogue-JS work targets it directly.
**Warning signs:** A task that tries to add `#product-catalog` markup to `products.html`.

### Pitfall 5: Missing script tags on `beer.html` when adding the catalogue
**What goes wrong:** The beer catalogue's search box silently falls back to substring match (functionally fine but inconsistent), or filter/cart JS throws on a missing dependency.
**Why it happens:** `beer.html` currently loads only `js/vendor/sentry.min.js`, `js/sentry-init.js`, `js/sheets-config.js`, and `js/main.min.js` — it is missing `js/vendor/fuse.min.js` (fuzzy search, used by `07-catalog-kits.js`'s `_kitsFuse`) and `js/modules/17-search-overlay.min.js` (header search overlay), both of which `products/ferment-in-store.html` loads.
**How to avoid:** When adding the catalogue markup to `beer.html`, also add the `fuse.min.js` script tag (matches the sibling page pattern). The search-overlay script is for the header magnifying-glass search, not the in-page catalogue filter — lower priority, but note the gap.
**Warning signs:** `_kitsFuse` staying `null` on `/beer` (harmless — code already guards `typeof Fuse !== 'undefined'`) but inconsistent search UX vs `/wine`.

### Pitfall 6: Regressing the homepage's primary revenue CTA
**What goes wrong:** `index.html`'s hero CTA ("Reserve Your Kit", `data-content="hero-cta"`) points at `products/ferment-in-store.html`. After D-10's hub rewrite removes the wine catalogue grid from that page, a customer clicking this CTA lands on a page with no add-to-cart grid — they must click through again to `/wine`.
**Why it happens:** This link isn't mentioned in CONTEXT and is easy to overlook since it's not in the nav dropdown search pattern.
**How to avoid:** Flag explicitly for the planner/owner: either repoint this CTA to `/wine` directly, or accept the extra hop as a deliberate trade (CONTEXT does not decide this — see Open Questions).
**Warning signs:** Post-launch conversion-rate dip on the homepage CTA, or a UAT click-through that lands on a hub with no buy button.

## Code Examples

### D-06 fix — recommended shape (not yet written, illustrative)
```js
// Illustrative pattern, modeled directly on the verified precedent at
// zoho-middleware/routes/catalog.js:628-635 (isAdminGrade)
router.get('/api/recipes', function (req, res) {
  return authTiers.resolveTier(req).then(function (tier) {
    var isStaff = tier === 'legacy' || tier === 'device' || tier === 'session';
    var requestedStatus = req.query.status || 'all';
    var status = isStaff ? requestedStatus : 'active'; // D-06: unauth forced to active-only
    // ...rest of existing handler body, unchanged, using `status` in place of
    // the current `req.query.status || 'all'` read at line 255
  });
});
```
This preserves the existing cache-key shape (`RECIPES + ':' + status + ...`), so no cache invalidation logic changes are needed — an unauth request simply always hits the `...:active:...` cache key, which is already busted correctly by `bustRecipeCache()`'s existing `['all','draft','active','inactive']` loop (`recipes.js:51`).

### Live verification commands used (repeatable by planner/executor)
```bash
# Recipe sizing — safe, read-only, matches D-04's own audit method from Phase 73
curl -s "https://svmiddleware-production.up.railway.app/api/recipes?status=active"
curl -s "https://svmiddleware-production.up.railway.app/api/recipes?status=all"

# Kit category counts (cf_type breakdown) — safe, read-only
curl -s "https://svmiddleware-production.up.railway.app/api/products" | python3 -c "
import json,sys
from collections import Counter
items = json.load(sys.stdin)['items']
c = Counter()
for it in items:
    t = next((f.get('value_formatted','') for f in (it.get('custom_fields') or []) if f.get('api_name')=='cf_type'), '')
    c[t] += 1
print(c)
"
```
**Re-run these at plan/execute time** — active-recipe count and kit stock levels are live business data that can change between research and execution (BrewPad staff activate recipes independently of this phase).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `products.html` as the live catalogue page | `products.html` → client-side redirect to `products/ferment-in-store.html` | Undated (pre-existing at research time) | `/wine`'s new scaffold should be based on `ferment-in-store.html`, not `products.html` |
| Ferment-in-store filter panel: fixed 40rem width, unbounded height | Full-width chips, 60vh-capped scrollable panel | Phase 77, shipped to prod 2026-08-28 | Already live; Phase 74 builds on top of it with no coordination needed (see Deprecated/outdated below) |

**Deprecated/outdated:**
- CONTEXT's framing of Phase 77 as "the chip panel" that "renders whatever set it is handed" slightly over-attributes to Phase 77. **Correction:** Phase 77 (`77-01-SUMMARY.md`) was a **CSS-only** change (`.catalog-collapsible`, `.catalog-collapsible.open`, `.catalog-filter-row` — width/overflow rules) with explicitly "no JS/HTML change." The "renders whatever set it's handed" property is a pre-existing behavior of `07-catalog-kits.js`'s `buildFilterRow()` (loops over `allProducts` to derive unique values per field), which predates Phase 77. The practical conclusion CONTEXT draws is still correct (no panel *rendering-logic* changes needed for D-13), but Phase 77 itself is irrelevant to sequencing — it is **already complete and deployed to production** as of 2026-08-28, so there is no coexistence or ordering risk with Phase 74.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The single existing beer kit ("Festa Brew West Coast IPA Kit") should be *excluded* from `/wine`'s kit block and *included* in `/beer`'s, per its `cf_type=Beer` value — CONTEXT doesn't explicitly discuss this item, but it follows directly from D-01/D-09's category-scoping intent. | Summary, Standard Stack | Low — this is the direct, intended consequence of category-scoping; flagging only because CONTEXT never names this specific item and a plan author might not realize it's *already live and purchasable today*, unscoped, before this phase ships. |
| A2 | No wine recipe will exist for the foreseeable future, so a style-keyword inference mechanism for recipe category is unnecessary complexity. | Common Pitfalls #2 | Medium — if BrewPad staff activate a wine-flavored recipe (kit-based winemaking doesn't typically use BrewPad's brewing-schedule recipe model, but nothing technically prevents it), it would silently render on `/beer` since there's no category field to route it elsewhere. This is a real architectural gap, not fully resolved by this phase — see Open Questions. |
| A3 | `beer.html`'s CSP (not `ferment-in-store.html`'s) is the correct sibling to copy for `/wine`, since it's the most recently verified against `docs/TRACKING.md` (2026-08-31). | Don't Hand-Roll | Low — the two pages' CSPs were near-identical at read time (both allow GTM, Metricool, Facebook Pixel, Google Ads, Sentry, the Railway middleware origins); the practical difference is `beer.html` additionally has `apple-mobile-web-app-*` meta tags and a `manifest.json` link `ferment-in-store.html` lacks — cosmetic, not CSP-relevant. |

**If this table is empty:** N/A — see entries above.

## Open Questions

1. **Tie-break rule for D-03 when kit count equals recipe count.**
   - What we know: Live data shows `/beer` will launch with exactly 1 kit and 1 active recipe — a tie. D-03 says "whichever set has more items leads" but is silent on ties.
   - What's unclear: Does kits-first (matching wine's only-ever-had-kits precedent) or recipes-first (matching "beer is booked-ahead, recipe-first" per D-11's framing) win a tie? Or is a fixed default per category acceptable as a discretion call?
   - Recommendation: Planner should pick kits-first-on-tie as the simpler default (matches D-11's ordering intent that the *page* leads with booking/waitlist framing before showing products, and kits are the more "shop-ready" of the two given beer's recipe list is 1 empty-description item), and record it as a locked decision rather than leaving it implicit in whatever the sort happens to do.

2. **Disposition of the "Ingredients & Supplies" tab on the hub after the wine catalogue grid moves.**
   - What we know: `products/ferment-in-store.html`'s `#product-catalog` block currently hosts BOTH the wine kit grid (`tab-kits`) AND an "Ingredients & Supplies" tab (`tab-ingredients`) via the shared `product-tabs` component (`13-init.js:331-349`). D-10 says the wine catalogue *grid* moves to `/wine`, but says nothing about the ingredients tab.
   - What's unclear: Does the entire `#product-catalog` block (including the ingredients tab) move/disappear from the hub, or does the hub keep a slimmed-down ingredients-only catalogue with the kits tab removed? The site already has a dedicated `products/ingredients-supplies.html` page reachable from the nav ("All Ingredients"), so the ingredients tab on the hub may be redundant either way.
   - Recommendation: Simplest reading of D-10 ("neutral hub... wine catalogue grid moves to /wine") is that the entire `#product-catalog` block (both tabs) is removed from the hub, and the hub instead links out to `/wine`, `/beer`, and `products/ingredients-supplies.html` as its three "categories." This also resolves the `13-init.js:331` gate question (whether `'ferment-in-store'` should be removed from the `loadProducts()`-triggering page list — recommend removing it once the hub has no `#product-catalog` element).

3. **Homepage hero CTA repoint.**
   - What we know: `index.html`'s primary CTA ("Reserve Your Kit") points at `products/ferment-in-store.html`, which will no longer have a buy-capable grid after D-10.
   - What's unclear: Whether repointing it to `/wine` is in scope for this phase or a follow-up.
   - Recommendation: Flag to the owner at plan time; low-cost to include (one `href` edit) given the live-revenue stakes (238 kits) already motivating D-12's "don't regress" language.

4. **`GET /api/recipes/:id` treatment.**
   - What we know: CONTEXT's canonical_refs names this route alongside `GET /api/recipes` as something D-05/D-06/D-07 constrain, but the three lettered decisions only explicitly discuss the list endpoint's `status` default. `GET /api/recipes/:id` (recipes.js:293-325) has no tier guard either and returns full ingredient-level detail (`enrichWithComputedPrice`, `enrichIngredientGroups`) regardless of the recipe's status — a caller can fetch a *specific* draft recipe by ID with zero gating, which is a bigger leak per-recipe than the list endpoint (full ingredient list + cost, not just a computed price).
   - What's unclear: Whether the planner should extend the same fix here (block unauth fetch of non-active recipes by ID) as part of this phase, or whether it's understood to be out of scope because no public UI will ever link to an arbitrary recipe ID.
   - Recommendation: Treat this as in-scope for D-06 — the phase's own stated rationale ("a query-string edit would defeat" a page-only filter) applies with equal or greater force to guessing/enumerating recipe IDs against the detail endpoint, which currently returns full ingredient lists (a direct D-07 violation surface, worse than the list endpoint's `computed_price`-only leak).

## Environment Availability

Not applicable — this phase has no external tool/service dependencies beyond what's already configured (the Railway middleware, already live and already queried above; no new credentials, APIs, or CLIs are introduced).

## Validation Architecture

Skipped — `.planning/config.json` has `workflow.nyquist_validation: false`.

### Testing obligations that still apply (CLAUDE.md, independent of nyquist_validation)

**Existing coverage is thin and will NOT catch a category-scoping regression:**
- `tests/frontend/catalog-kits-proto-guard.test.js` — tests only `flattenCustomFields()` (prototype-pollution guard), not rendering/filtering.
- `tests/frontend/catalog-search.test.js` — tests Fuse fuzzy search in isolation, not category scoping.
- `tests/frontend/catalog-view.test.js` — tests `getCatalogViewMode()` (cards vs table), unrelated.
- **No e2e test** (`tests/e2e/`) touches `ferment-in-store.html`, `beer.html`, the catalogue, or the cart at all (confirmed via directory listing — the e2e suite is entirely kiosk/cart-DOM/producer focused).
- `zoho-middleware/__tests__/recipes.test.js` (1070 lines) — has coverage for `GET /api/recipes?status=active` and `?status=all` (line 92, 105) but **no test asserts tier-based access control** on this route (no test simulates an unauthenticated caller against a mix of draft+active recipes and asserts drafts are excluded).

**Required before D-06 ships (CLAUDE.md rule 3 — regression test first):**
- A new middleware test: unauthenticated `GET /api/recipes` (no `status` param, or `status=all`/`status=draft` explicitly requested) returns only `status: active` recipes and never leaks `computed_price` on a draft. A second test: a staff-tier request (mock `legacy`/`session`/`device`) with `status=draft` still returns drafts (no regression to BrewPad's own admin recipe list).
- A new middleware test for `GET /api/recipes/:id` mirroring the above, if Open Question #4 is resolved as in-scope.

**Required before D-12/D-13 ship (frontend, no existing coverage to extend):**
- A new frontend test exercising `loadProducts('beer')`/`loadProducts('wine')`'s category filter in isolation (the module already exports via `module.exports` for Node test-env use — see `07-catalog-kits.js:1522-1524` — so this is straightforward to add alongside the existing `catalog-kits-proto-guard.test.js` pattern).
- A test asserting `buildBeerCard()`'s action tail no longer renders `renderReserveControl`/`renderKitBuyControl` output.

**Commands:**
```bash
npm test                          # frontend, run after any js/modules/07-catalog-kits.js or 13-init.js change
cd zoho-middleware && npm test    # middleware, run after any recipes.js/authTiers.js change
npm run lint                      # both — CLAUDE.md rule requires 0 warnings before commit
npm run build                     # regenerates js/main.js/main.min.js — required after ANY js/modules/*.js edit
```
Per CLAUDE.md rule 7, because `07-catalog-kits.js` is a shared module (used by `/wine`, `/beer`, and unaffected pages like `products/ingredients-supplies.html`), **both** the frontend and middleware full suites must run after any change to it — not just the frontend suite.

## Security Domain

`workflow.security_enforcement: true`, `security_asvs_level: 1` in `.planning/config.json` — this section is required.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | This phase doesn't touch login/session creation |
| V3 Session Management | No | Reuses existing `authTiers`/`session` machinery unchanged |
| V4 Access Control | **Yes** | D-06's core concern: `GET /api/recipes` (and per Open Question #4, `GET /api/recipes/:id`) must enforce a status-based access boundary. Standard control: server-side tier resolution via `authTiers.resolveTier()`, never a client-supplied flag |
| V5 Input Validation | Marginal | `?status=` query param already exists and is validated implicitly by cache-key construction; no new user input surfaces are introduced by this phase |
| V6 Cryptography | No | Not implicated |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Query-string tampering to bypass a client-side-only filter (`?status=all` on a page that "only shows active") | Elevation of Privilege / Information Disclosure | **This is D-06 itself.** Mitigation: enforce at the endpoint via `authTiers.resolveTier()`, ignoring/overriding the client's requested `status` value when the caller is unauthenticated. Already the phase's own stated design — this research confirms the vulnerability is real and currently live, not hypothetical. |
| Recipe-ID enumeration against `GET /api/recipes/:id` to read draft ingredient/cost detail | Information Disclosure | Same class of fix as above, applied to the detail route — currently unmitigated (see Open Question #4). Ingredient-level detail is a materially larger leak than the list endpoint's `computed_price`-only exposure. |
| Category-filter bypass via direct API call (e.g., a script hitting `GET /api/products` and rendering beer items on a wine-scoped page) | Information Disclosure (minor) | Not a security boundary — `GET /api/products` is, and should remain, fully public and unscoped (it's the existing behavior for `products.html`/`products/ingredients-supplies.html`). Category scoping is a *display* concern (client-side), not an access-control concern, since kit inventory data (price, stock, tasting notes) carries no sensitivity comparable to recipe cost/ingredient data. Do not over-engineer server-side category enforcement for kits — that would be solving a problem this phase's own D-06 rationale doesn't apply to (kits have no draft/active-equivalent visibility concern). |

## Sources

### Primary (HIGH confidence — live production queries, read-only, 2026-09-01)
- `GET https://svmiddleware-production.up.railway.app/api/recipes?status=active` — 1 active recipe (Czech Lager, empty description)
- `GET https://svmiddleware-production.up.railway.app/api/recipes?status=all` — 10 total recipes, all beer-styled, no category field
- `GET https://svmiddleware-production.up.railway.app/api/products` — 238 Wine / 11 Cider / 1 Beer kits via `cf_type` custom field

### Primary (HIGH confidence — direct file reads, this repo, this session)
- `zoho-middleware/routes/recipes.js` — full file read; confirmed `GET /api/recipes` (:254) and `GET /api/recipes/:id` (:293) have no `authTiers` call; `enrichListPrices` (:161) computes `computed_price` unconditionally on `pricing_mode:'dynamic'` recipes regardless of status
- `zoho-middleware/lib/authTiers.js` — full file read; `requireTiers()`, `resolveTier()`, `allowAdmin()`, `KIOSK_ROUTES` allowlist
- `zoho-middleware/server.js:243-342` — confirmed the global `/api` guard exempts ALL `GET` requests (`if (req.method === 'GET') return next();` at :288), explaining why `GET /api/recipes` is unauth-reachable today
- `zoho-middleware/routes/catalog.js:628-909` — confirmed the `isAdminGrade(req)` optional-auth precedent (:628-635) and the inline `requireTiers()` gate pattern on `?bust=1` (:909)
- `apps-script/adminApi.gs:3760-3785` — `setupRecipeTabs()`, confirming the Recipes sheet's 17-column header row has no category field
- `brewpad.html:184-185` — confirmed `style` is a free-text input, not a controlled vocabulary
- `js/modules/07-catalog-kits.js` — full file read (1524 lines); `loadProducts()`, `buildFilterRow()`, `applyFilters()`, `renderCatalog()`, `buildBeerCard()`, `renderKitBuyControl()`
- `js/modules/13-init.js:300-379` — page dispatch table including the `page === 'products' || ... || 'ferment-in-store' || 'ingredients-supplies'` gate
- `beer.html` — full file read; confirmed current section order matches D-11 exactly, confirmed missing `fuse.min.js`/`17-search-overlay.min.js` script tags, confirmed CSP content
- `products/ferment-in-store.html` — full file read; confirmed wine landing copy boundaries (lines 128-171) and the `#product-catalog`/tabs block (173-261)
- `package.json` — `stamp:pages` script array (:17), `concat:js` module order (:10), `build` pipeline (:18)
- `sitemap.xml:82` — confirmed `/beer` clean-URL pattern for the sibling `/wine` entry
- `.planning/phases/73-.../73-01-SUMMARY.md` — confirmed the "8 recipes" historical count (2026-08-25, now stale — superseded by this session's live 10-recipe count) and the precedent live-audit method this research replicated
- `.planning/phases/77-.../77-01-SUMMARY.md` — confirmed Phase 77 is CSS-only, complete, and deployed to production 2026-08-28
- `tests/frontend/` and `tests/e2e/` directory listings + `zoho-middleware/__tests__/recipes.test.js` — confirmed test coverage gaps

### Secondary (MEDIUM confidence)
- 20-file / 31-occurrence count of links into `products/ferment-in-store.html`, and 17-file count of the nav dropdown — obtained via `grep -rl`/`grep -rn`; exact counts could shift by the time of execution if other in-flight phases touch these files, but the *mechanism* (manual per-page HTML edit, no templating) is structurally certain.

## Metadata

**Confidence breakdown:**
- Recipe/kit sizing and category-field existence: HIGH — verified live against production, not inferred
- D-06 endpoint fix pattern: HIGH — direct precedent exists and was read in full (`catalog.js:628-635`)
- D-12/D-13 catalogue JS changes: HIGH — read the exact functions and line ranges that need to change
- Tie-break/hub-ingredients-tab/CTA-repoint questions: MEDIUM-LOW — genuinely underspecified by CONTEXT, flagged as Open Questions rather than guessed

**Research date:** 2026-09-01
**Valid until:** ~7 days for the live recipe/kit counts (fast-moving business data — BrewPad staff activate recipes independently of this phase; re-run the curl commands in Code Examples immediately before planning/execution if more than a few days have passed), ~30 days for the code-structure findings (stable unless another phase touches `07-catalog-kits.js`/`recipes.js` first)
