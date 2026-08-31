# Phase 74: Beer/Wine catalogue pages under Ferment-in-Store - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-31
**Phase:** 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
**Areas discussed:** Kits vs recipes per category, What's publicly listed, URLs and page locations, Fate of the beer launch copy

---

## Kits vs recipes per category

**Q1 — What should each category page actually list?**

| Option | Description | Selected |
|--------|-------------|----------|
| Per-category source | Wine/cider list kits, beer lists recipes | |
| Recipes everywhere | All three list recipes; kits an implementation detail | |
| Kits everywhere | All three list kits; cheapest, reuses catalogue as-is | |
| Both, on every page | Kits and recipes together on each page | ✓ |

**Notes:** Chosen despite being flagged as the most complex option, with the
highest risk of duplicate-looking entries. Q2 was asked specifically to
resolve that risk.

**Q2 — How should a customer tell kits and recipes apart?**

| Option | Description | Selected |
|--------|-------------|----------|
| Two labelled sections | "Kits" and "Our Recipes" with explainers | |
| One grid, badged cards | Single mixed grid, Kit/Recipe badges | |
| Recipes first, kits below | Recipes top billing, kits secondary block | ✓ |

**Notes:** Flagged at the time that this may be wrong for wine, where 238
kits are the main event. Q3 resolved that.

**Q3 — Should that ordering apply to all pages, or flip per category?**

| Option | Description | Selected |
|--------|-------------|----------|
| Flip per category | Beer/cider recipes-first, wine kits-first | |
| Recipes first everywhere | Uniform; demotes 238 wine kits | |
| Whichever has more | Larger set leads, dynamic by count | ✓ |

**Notes:** Trade accepted — page order can change on its own as stock moves,
which is unpredictable for returning visitors.

**Q4 — What happens when a section is empty or nearly empty?**

| Option | Description | Selected |
|--------|-------------|----------|
| Hide the empty section | No bare heading over blank space | ✓ |
| Show with a message | "More coming soon" + waitlist prompt | |
| Merge into one grid | Collapse to badged grid when sparse | |

---

## What's publicly listed

**Context surfaced before the questions:** `GET /api/recipes` was found to have
no tier guard and to run `enrichListPrices()` before responding — so it already
serves recipe names *with computed prices* publicly. It defaults to
`?status=all`, and BrewPad creates recipes as `draft`, meaning draft recipes
are publicly fetchable today. This reframed the area from "build a public
catalogue" to "constrain the one that already exists".

**Q1 — Which recipes should appear publicly?**

| Option | Description | Selected |
|--------|-------------|----------|
| Active only | Reuse existing BrewPad draft/active flag | ✓ |
| New 'public' flag | Separate website-visibility field | |
| Curated list | Hand-picked per category | |

**Q2 — Should the endpoint be constrained, or just the page's request?**

| Option | Description | Selected |
|--------|-------------|----------|
| Default public to active | Unauth → active only; staff may request drafts | ✓ |
| Leave endpoint, filter on page | Page asks for active; drafts still reachable | |
| Separate public endpoint | New public route, staff route untouched | |

**Notes:** Chosen on the reasoning that a page-side filter is a convention,
not a control. Closes today's draft exposure as a side effect.

**Q3 — What should a public recipe card expose?**

| Option | Description | Selected |
|--------|-------------|----------|
| Name, style, price, blurb | No ingredients, nothing cost-derivable | ✓ |
| Add the ingredient list | Good content/SEO; publishes the recipes | |
| No price, detail only | Safest on data; leaves beer priceless | |

**Q4 — Are staff-written recipe descriptions customer-ready?**

| Option | Description | Selected |
|--------|-------------|----------|
| Use as-is, fix later | Nothing blocks the phase | |
| Content pass first | Rewrite descriptions as part of this phase | ✓ |
| Separate public field | Staff notes private, opt-in public copy | |

**Notes:** Accepted as a release gate. Size unknown — active recipe count
could not be established during discussion; flagged for research.

---

## URLs and page locations

**Q1 — Where should the category pages live?**

| Option | Description | Selected |
|--------|-------------|----------|
| Keep /beer, add siblings | Root URLs; no redirects, nothing breaks | ✓ |
| Move all under /products/ | Consistent, but /beer needs a redirect | |
| Hub owns them as sub-paths | Strongest hierarchy, deepest paths | |

**Notes:** `/beer` shipped earlier the same day, is in `sitemap.xml`, and is
linked from 17 pages; GitHub Pages offers no server-side redirects.

**Q2 — What happens to ferment-in-store.html?**

| Option | Description | Selected |
|--------|-------------|----------|
| Hub keeps the wine copy | Keeps prose + SEO, loses only the grid | |
| Rewrite hub as neutral | Even coverage; wine copy moves to /wine | ✓ (superseded, then reinstated) |
| Hub redirects to /wine | No hub at all | |

**Q3 — How aggressive should the rewrite be?**

| Option | Description | Selected |
|--------|-------------|----------|
| Neutral hub, wine kept prominent | Hedged; wine terms stay on ranking URL | ✓ (final) |
| Fully neutral, wine copy moves | Cleanest; accepts ranking dip | |
| Defer the hub rewrite | Zero SEO risk now; ship pages only | ✓ (initially) |

**Notes — decision reversal:** the user first selected **Defer the hub
rewrite**. A follow-up question about the duplicate-content consequence (wine
kits appearing on both `/wine` and the hub) was interrupted; the user replied
"actually can we rewrite", reopening it. Reading confirmed, and the settled
answer is **Neutral hub, wine kept prominent** — under which the wine
catalogue lives only on `/wine`, so no duplication and no canonical tag is
needed. The duplicate-content question was therefore never answered and is
moot.

---

## Fate of the beer launch copy

**Q1 — What happens to beer.html's existing copy?**

| Option | Description | Selected |
|--------|-------------|----------|
| Keep copy, add catalogue below | Announcement first, catalogue beneath | ✓ |
| Catalogue first, copy below | Matches wine/cider layout | |
| Collapse copy into 'Read more' | Identical structure, buries the waitlist | |

**Q2 — What should a card's action be?**

| Option | Description | Selected |
|--------|-------------|----------|
| Action varies by category | Wine → cart, beer → waitlist | ✓ |
| Recipes enquire, kits cart | Type-driven rather than category-driven | |
| Everything enquires for now | Simplest; regresses wine kit sales | |

**Q3 — Is cider in scope?**

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, catalogue only | /cider from 11 kits, no launch copy | |
| Yes, with launch copy | Beer treatment for cider | |
| Not this phase | Ship /wine + /beer + hub only | ✓ |

**Notes:** Raised because cider had been silently assumed in scope all along —
`cider.html` was deleted 2026-08-27 and launch intent was never confirmed.
Deferring it makes the phase title stale.

**Q4 — How should filtering work per category?**

| Option | Description | Selected |
|--------|-------------|----------|
| Per-category filter sets | Wine keeps body/oak/sweetness; beer style/abv | ✓ |
| Shared filters only | One set; regresses wine filtering | |
| Defer filters for new pages | Beer ships with none | |

---

## Claude's Discretion

- Exact hub layout and section ordering (beyond keeping wine prominent).
- Card markup/CSS, reusing existing catalogue components.
- How per-category config is expressed in the shared JS.
- Sort options per category — not discussed.

## Deferred Ideas

- `/cider` catalogue page and its launch copy.
- Ingredient lists on public cards.
- Moving wine copy off the hub entirely, once `/wine` has its own authority.

## Raised but out of scope

- `GET /api/recipes` serving draft recipes with prices to unauthenticated
  callers is a **live exposure today**, independent of this phase. D-06 closes
  it as a side effect, but the user was offered a separate look at what is
  currently exposed and that has not yet been actioned.
