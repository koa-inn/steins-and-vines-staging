# Phase 74: Beer/Wine catalogue pages under Ferment-in-Store - Context

**Gathered:** 2026-08-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Build category-scoped catalogue pages for **wine and beer**, and rewrite
`products/ferment-in-store.html` into an informational hub that links to them.

Each category page lists BOTH kits and recipes. This phase also creates the
first public-facing surface for recipes, which until now have been staff-only
in BrewPad — including the public read contract and what a recipe may expose.

**In scope:** `/wine` (new), `/beer` (extend the existing page), the
`ferment-in-store.html` hub rewrite, category-scoping in the shared kit
catalogue JS, a public recipe listing path, per-category filter sets, and a
content pass over active recipe descriptions.

**Out of scope:** `/cider` (deferred — see `<deferred>`), ingredient lists on
public cards, any change to kit purchasing/cart behaviour for wine.

> **⚠ ROADMAP.md is stale for this phase.** Its title and goal say
> "Beer/Cider/Wine catalogue pages" and describe rebuilding `beer.html` and
> `cider.html` by "replacing the announcement hero". All three are now wrong:
> cider is deferred, `cider.html` no longer exists, and beer's announcement
> hero is explicitly **kept** (D-10). Its "remove the top-level Beer/Cider nav
> from 72-02" item is already done. Planner: trust this CONTEXT over ROADMAP.

</domain>

<decisions>
## Implementation Decisions

### Product model — what a page lists

- **D-01:** Every category page lists **both kits and recipes**. A "product"
  is not one type — the page shows two blocks.
- **D-02:** The two blocks are **separate and labelled**, not one mixed grid.
  Recipes and kits are distinct things and must not read as duplicates of
  each other.
- **D-03:** Block **order is dynamic by count** — whichever set has more items
  leads. No per-category ordering config. (Consequence the user accepted:
  page order can change on its own as stock and recipe counts move.)
- **D-04:** A block with **zero items is not rendered at all** — never a bare
  heading over empty space. Beer with no active recipes shows only its kit
  block, and vice versa.

### Public recipe exposure

- **D-05:** Public pages list **active recipes only** (`?status=active`),
  reusing the existing BrewPad `draft`/`active` flag. **No new published/public
  field** — BrewPad activation is the single visibility control.
- **D-06:** **The endpoint itself must enforce this, not just the page.**
  `GET /api/recipes` currently defaults to `status=all` with no tier guard, so
  draft recipes are publicly fetchable today *with computed prices*. Change:
  unauthenticated callers get active only; staff tiers may still request
  drafts. A page-side filter alone is not a control — a query-string edit
  would defeat it.
- **D-07:** A public recipe card exposes **name, style, price, short blurb**
  and nothing else. Explicitly NOT: ingredient lists, per-item costs, or
  anything from which margin is derivable.
- **D-08:** Recipe descriptions in BrewPad were written for staff. A
  **content pass over all active recipes' descriptions is IN SCOPE and gates
  release.** Size is unknown until the active-recipe count is established
  (see `<code_context>` open question).

### URLs, hub, and page structure

- **D-09:** Category pages are **root siblings**: `/beer` stays exactly where
  it is; `/wine` joins it. No move under `/products/`. Rationale: `beer.html`
  shipped 2026-08-31 at the root, is listed in `sitemap.xml`, and is linked
  from 17 pages — moving it needs a redirect, and GitHub Pages has no
  server-side redirects. Accepted trade: inconsistent with
  `products/*.html` catalogue pages.
- **D-10:** `products/ferment-in-store.html` becomes a **neutral hub** covering
  the categories, **but keeps a substantial wine section retaining its existing
  "Make Your Own Wine in Squamish" phrasing**. The wine catalogue *grid* moves
  to `/wine`. Only one wine catalogue exists, so there is no duplicate-content
  or canonical-tag problem.
  - *Decision history:* the user first chose to defer this rewrite entirely,
    then reopened it once the deferral was shown to create page duplication.
    The hedged version above is the settled answer.

### Beer page composition

- **D-11:** `beer.html`'s existing launch copy is **kept, not replaced**. Order:
  hero → What It Is → How It Works → What's Included → **catalogue** →
  waitlist → FAQ. The announcement framing must reach the visitor before the
  products do, because beer is booked-ahead rather than walk-in.
- **D-12:** **Card actions vary by category.** Wine kits keep add-to-cart
  (existing behaviour, do not regress it — it is live revenue). Beer cards
  lead to the waitlist. The shared card component needs a per-category action
  config.
- **D-13:** **Per-category filter sets.** Wine keeps `body` / `oak` /
  `sweetness` / `abv`; beer gets style / abv. The Phase 77 chip panel renders
  whatever set it is handed, so the panel itself likely needs no change — a
  per-category config does.

### Claude's Discretion

- Exact hub layout and section ordering, beyond D-10's requirement that wine
  stay prominent and keep its ranking phrasing.
- Card markup and CSS, provided it reuses existing catalogue components.
- How the per-category config is expressed (constants, data attributes, or
  page-level init) — planner/researcher to choose from existing patterns.
- Sort options per category (not discussed).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Recipe data + public exposure
- `zoho-middleware/routes/recipes.js` — `GET /api/recipes` (line ~254, **no
  tier guard**), `GET /api/recipes/:id`, and `enrichListPrices()` (line ~161)
  which sets `computed_price` on `pricing_mode === 'dynamic'` recipes. This is
  the endpoint D-05/D-06/D-07 constrain.
- `zoho-middleware/lib/authTiers.js` — `requireTiers()` and the `KIOSK_ROUTES`
  allowlist; the tier model D-06's guard must fit into.
- `js/brewpad.js` — recipe `status` values (`draft` at :1777/:2815, `active` at
  :2953) and the `recipe-name` / `recipe-style` / `recipe-description` form
  fields (:2508-2510) that D-07's card maps onto.

### Catalogue infrastructure
- `js/modules/07-catalog-kits.js` — the shared kit catalogue; `buildBeerCard()`
  (~:796) already exists, and the wine filter dimensions `body`/`oak`/
  `sweetness` live at :515-517. This is what D-13 scopes per category.
- `js/lib/constants.js:41` — `KIT_CATEGORIES = ['wine','beer','cider','seltzer']`.
- `products/ferment-in-store.html` — today both the wine catalogue and the
  SEO landing page; the subject of D-10.
- `beer.html` — the page D-11 extends. Its waitlist depends on
  `setupBeerWaitlistForm()` in `js/modules/12-checkout.js:1689` and
  `POST /api/waitlist` in `zoho-middleware/server.js:211`.
- `css/styles.css` — `.beer-waitlist-*` styles (~:1401-1470) and `.hidden`
  (:5164), both already present and in use by beer.html.

### Project rules that bind this phase
- `CLAUDE.md` — §"Build Artifacts" (never edit `js/main.js`/`main.min.js`;
  run `npm run build` after module changes) and §"Security" rule 12 (every
  public page needs a CSP `<meta>`; new pages copy it from a sibling).
- `docs/TRACKING.md` — CSP/tracking-domain requirements for public pages.

### Prior context
- `.planning/todos/pending/beer-cider-launch-pages.md` — the Phase 72 source
  todo; its placeholder list is now satisfied for beer.
- `.planning/todos/pending/remove-dead-beer-waitlist-handler.md` — **now
  invalid.** It proposes deleting `setupBeerWaitlistForm()` as dead code;
  `beer.html` depends on it. Should be closed, not actioned.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Public recipe read path already exists.** `GET /api/recipes` is
  unauthenticated and already price-enriched. The roadmap assumed a public
  recipe catalogue had to be built from scratch; most of the read path is
  there. The work is constraining it (D-06) and consuming it, not building it.
- **Waitlist stack is intact and live** — frontend handler, rate-limited
  endpoint, and all `.beer-waitlist-*` CSS. D-12's beer card action can point
  at machinery that already works.
- **Phase 77's filter panel** is chip-based and scrollable and renders whatever
  set it is given — D-13 likely needs config, not panel changes.
- `buildBeerCard()` already exists in the kit catalogue.

### Established Patterns
- Frontend is **ES5 only**, concatenated from `js/modules/NN-*.js` into
  `js/main.js` by the build. Never edit the built artifacts.
- Catalogue JS (`07-catalog-kits.js`, `13-init.js`) is **money-path-adjacent
  and shared** — CLAUDE.md requires full frontend AND middleware test runs
  after changes to shared utilities.
- New public pages copy their CSP from a sibling page.

### Integration Points
- `/wine` is a new public page: needs CSP, sitemap entry, `stamp:pages`
  registration, and a nav link (the Products → Ferment in Store dropdown,
  where beer was added 2026-08-31).
- D-06 modifies a shared middleware route — full middleware suite required.

### Open question for research (sizing)
- **How many recipes are `active`, and how are they distributed across wine
  and beer?** This determines (a) the size of D-08's content pass, which gates
  release, and (b) whether the wine page's recipe block is meaningful or
  near-empty. Recipes come from Apps Script via Redis and could not be counted
  during discussion.

</code_context>

<specifics>
## Specific Ideas

- Beer must not read as walk-in. D-11's ordering exists specifically so
  "booked ahead, join the waitlist" lands before a visitor sees products and
  tries to buy one.
- The wine catalogue is live revenue (238 kits, add-to-cart). D-12 exists to
  make sure category-scoping does not regress it.
- The user's earlier decision to defer beer pricing "to the Phase 74
  catalogue" is what makes public recipe pricing (D-07) load-bearing rather
  than optional — beer has no published price until this ships.

</specifics>

<deferred>
## Deferred Ideas

- **`/cider` catalogue page** — out of this phase. 11 cider kits are in stock,
  but `cider.html` was deleted 2026-08-27 and launch intent is unconfirmed.
  The infrastructure built here will make adding it cheap later.
- **Cider launch-announcement copy** (100% Okanagan juice, seasonal note) —
  needs the same content decisions beer just went through.
- **Ingredient lists on public cards** — deliberately excluded by D-07 to
  avoid publishing recipes and cost-derivable data. Revisit only as a
  conscious transparency choice.
- **Hub/wine SEO follow-up** — D-10 hedges by keeping wine terms on the hub.
  If `/wine` builds its own authority, moving the wine copy off the hub
  entirely becomes a later option.

### Reviewed Todos (not folded)
- `beer-cider-launch-pages.md` — matched this phase, but its beer half was
  satisfied on 2026-08-31 and its cider half is deferred. Not folded.
- The other 11 pending todos matched only on generic keywords (kiosk money
  path, BrewPad batch views, CI deploy) and are unrelated to this phase.

</deferred>

---

*Phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split*
*Context gathered: 2026-08-31*
