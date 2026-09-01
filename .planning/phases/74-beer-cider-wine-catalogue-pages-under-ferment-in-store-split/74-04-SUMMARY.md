---
phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
plan: 04
subsystem: frontend (static HTML routes, nav, CSS)
tags: [wine, catalogue, nav, sitemap, css, csp]
dependency-graph:
  requires: []
  provides:
    - "wine.html — /wine root-level catalogue page with the two-block DOM contract"
    - "Wine nav entry on all 17 nav-carrying pages + wine.html itself (18 total)"
    - "sitemap.xml /wine entry"
    - "package.json stamp:pages registration for wine.html"
    - "css/styles.css: #catalog-blocks, .product-grid--compact (+480px override), .hub-categories, .hub-category-item"
  affects:
    - "plans 74-03 and 74-05 (both consume the CSS this plan owns; 74-05 consumes the nav pattern and #catalog-blocks contract)"
    - "plan 74-06 (single npm run build after wine.html + module edits land; wine.html already registered in stamp:pages)"
tech-stack:
  added: []
  patterns:
    - "Root-level public page scaffolded from products/ferment-in-store.html's markup, with beer.html's root-relative asset-path convention and byte-identical CSP"
    - "Two-block DOM contract: #catalog-blocks wraps #product-catalog + empty #recipe-catalog, cart sidebar/drawer remain direct children of .catalog-layout"
key-files:
  created:
    - wine.html
  modified:
    - about.html
    - beer.html
    - contact.html
    - custom-labels.html
    - hops.html
    - index.html
    - ingredients.html
    - package.json
    - products.html
    - products/additives.html
    - products/equipment.html
    - products/ferment-in-store.html
    - products/grains.html
    - products/hops.html
    - products/ingredients-supplies.html
    - products/packaging.html
    - products/yeast.html
    - reservation.html
    - sitemap.xml
    - css/styles.css
decisions:
  - "Plan's Task 2 automated verify script asserted 17 total files with a Wine nav entry; corrected to 18 (see Deviations) — the 8-file products/ subset check and the beer.html/ferment-in-store.html 1-insertion-each check both pass exactly as specified."
metrics:
  duration: "~35 min"
  completed: 2026-09-01
---

# Phase 74 Plan 04: Wine page, site-wide nav, sitemap/build registration, and phase CSS Summary

Created `/wine` as a root-level public catalogue page (CSP byte-identical to `beer.html`, two-block DOM contract for the future recipe-block renderer), wired a Wine nav entry into all 17 nav-carrying pages plus `wine.html`'s own active link, registered the page in `sitemap.xml` and `package.json`'s `stamp:pages`, and added the four additive CSS rules (`#catalog-blocks`, `.product-grid--compact` + its 480px override, `.hub-categories`/`.hub-category-item`) that plans 74-03 and 74-05 depend on.

## What Was Built

### Task 1: `wine.html` at the repository root
- New root-level page (267 lines), scaffolded from `products/ferment-in-store.html`'s catalogue/head/footer structure with every asset path rewritten root-relative (matching `beer.html`'s convention — zero `../` paths).
- `<meta http-equiv="Content-Security-Policy">` copied byte-for-byte from `beer.html` — verified via a programmatic string-equality check (`node -e` comparing the two extracted meta tags), not eyeballed.
- `<body data-page="wine">` — the exact dispatch key `js/modules/13-init.js` reads (plan 74-06 wires the dispatch branch).
- Two-block DOM contract: `div#catalog-blocks` wraps `div#product-catalog` (search/view-toggle/filters/sort/noscript) and a second, empty `div#recipe-catalog` sibling inside it. `aside.cart-sidebar`, `.cart-drawer-backdrop`, `.cart-drawer` remain direct children of `.catalog-layout`, outside `#catalog-blocks`, per the interfaces contract.
- Wine filter row set: `filter-type`, `filter-brand`, `filter-manufacturer`, `filter-subcategory`, `filter-time`, `filter-body`, `filter-oak`, `filter-sweetness`, `filter-sale`, plus the sort row with all 12 existing `#catalog-sort` options.
- `#product-tabs` (kits/ingredients tab switcher) intentionally omitted — hub-only artifact per D-01/D-02.
- Lead paragraph under the page header is new copy that does not reuse the hub's "Make Your Own Wine in Squamish" phrase or its `landing-copy`/`landing-copy-detail`/"Read more" block (D-10 keeps that exclusively on the hub).
- Script block ordering follows `products/ferment-in-store.html` (includes `fuse.min.js` + `17-search-overlay.min.js`), not `beer.html` (which is missing them) — per Research Pitfall 5.
- Nav on `wine.html` itself already carries the active Wine entry (`class="active"`), positioned between "Ferment in Store" and "Beer".

### Task 2: Registration — nav, sitemap, build
- Inserted a `<li class="nav-dropdown-indent"><a href="[prefix]wine.html">Wine</a></li>` immediately before the existing Beer entry on all 17 target files: 9 root-level pages (bare `wine.html` href) + 8 pages under `products/` (`../wine.html` href) — each file's own existing Beer-anchor prefix was read and mirrored, not assumed.
- `beer.html` and `products/ferment-in-store.html` received ONLY this one-line nav insertion (1 insertion, 0 deletions each, confirmed via `git diff --stat`) — their body content is plan 74-05's scope, untouched here.
- `sitemap.xml`: new `/wine` url block (weekly changefreq, priority 0.8 — reflecting it as the primary shopping surface for 238 live kits) placed adjacent to the existing `/beer` block. The pre-existing `/cider` entry was left untouched.
- `package.json`: `'wine.html'` added to the `stamp:pages` array immediately before `'beer.html'`, so `npm run build` will stamp its cache-busting `?v=` params (build itself deferred to plan 74-06).

### Task 3: New CSS rules
- `#catalog-blocks` (`flex: 1; min-width: 0;`) placed immediately after `#product-catalog` at its flex-layout site (styles.css ~5612) — takes over the flex slot as a direct child of `.catalog-layout`.
- `.product-grid--compact` (+ `@media (max-width: 480px)` override) placed immediately after `.product-grid` (styles.css ~1526) — the UI-SPEC-locked fix for the 1-2 card grid-stretch defect.
- `.hub-categories` / `.hub-category-item` — navigational row for the rewritten hub (plan 74-05), reusing the `.product-grid`'s existing `2rem`/`280px` rhythm.
- All four rules are purely additive: `git diff css/styles.css` shows only the diff header on the `-` side (0 actual line removals), 32 insertions total. `npx cleancss -o /dev/null css/styles.css` confirms the stylesheet still parses.

## Verification

- CSP string-equality check: PASS (`node -e` comparison, wine.html vs beer.html)
- `wine.html` acceptance criteria: all PASS (data-page count 1, catalog-blocks/recipe-catalog count 1 each, product-tabs count 0, hub-copy-reuse count 0, all 4 wine-only filter rows present, catalog-sort count 1, zero `../` paths, fuse.min.js present, GTM count 2, canonical → `https://steinsandvines.ca/wine`)
- Nav registration: 17 target files each carry exactly one Wine entry with the correct href prefix; `beer.html`/`products/ferment-in-store.html` diffs are 1 insertion / 0 deletions each; `package.json` still parses; `sitemap.xml` still parses (`xml.dom.minidom`)
- CSS acceptance criteria: all 4 rules present, `.product-grid--compact`'s 480px override present, 0 existing lines removed, `cleancss` parses cleanly
- `git diff --name-only` (base commit vs HEAD): exactly the 21 files named in the plan's `files_modified` — no unexpected files touched
- `npm test` (frontend): **1166/1166 passing**, 88 suites
- `cd zoho-middleware && npm test`: **1514/1514 passing**, 101 suites (middleware `node_modules` was not yet installed in this fresh worktree — ran `npm ci` from the existing lockfile, no new/changed dependencies, to satisfy CLAUDE.md's before-every-commit test gate; `node_modules/` remains gitignored, `git status` is clean)
- `npm run lint`: clean, 0 warnings
- `node -e "require('./package.json')"`: exits 0
- No edits to `js/main.js`, `js/main.min.js`, `css/styles.min.css`, or any `*.min.js` — `npm run build` intentionally NOT run (plan 74-06 owns the single rebuild)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Task 2's automated verify command had a shell-quoting bug and an off-by-one expected count**
- **Found during:** Task 2 verification
- **Issue:** The plan's `<verify><automated>` command for Task 2 (`node -e "...cp.execSync('grep -rl \"nav-dropdown-indent\\\"><a href=\\\"[^\\\"]*wine.html\\\"\" --include=*.html . | ...')..."`) has unbalanced quote escaping that, once the outer bash/JS/shell quoting layers are unwound, produces an invalid shell command (`grep -rl "nav-dropdown-indent"><a href="[^"]*wine.html"" ...`) — the stray `>` is parsed as a shell redirect, causing a syntax error. Separately, the script hardcodes an expected count of exactly 17, but the same grep pattern also matches `wine.html`'s own self-referential active Wine nav entry (added in Task 1 per the plan's own interfaces contract — `<li class="nav-dropdown-indent"><a href="wine.html" class="active">Wine</a></li>`), so a correctly-run version of this exact pattern over the whole repo legitimately returns **18**, not 17.
- **Fix:** Ran a corrected, equivalent grep (`grep -rlE 'nav-dropdown-indent"><a href="[^"]*wine\.html"' --include='*.html' .`) and confirmed: 18 total matching files (17 registered in Task 2 + `wine.html` itself), of which exactly 8 use the `../wine.html` prefix (the `products/` subset — matches the plan's separate, correctly-scoped 8-file assertion) and 10 use the bare `wine.html` prefix (9 root target files + `wine.html` itself). The narrower, unambiguous acceptance criteria (8-file products/ subset, 1-insertion diff on beer.html/ferment-in-store.html, package.json/sitemap.xml parsing) all pass exactly as written — only the single broad "17" total count needed reinterpretation.
- **Files modified:** None (verification-only; no production code affected)
- **Commit:** N/A (no code change; documented here per deviation-tracking requirement)

None of the other deviation rules (2/3/4) applied — the plan's action items, read_first sources, and acceptance criteria fully covered implementation; no missing critical functionality, no blocking issues requiring a fix, no architectural changes needed.

## Known Stubs

None — `wine.html` is CSP-clean and content-complete at launch (kits-only catalogue, no "coming soon" placeholder; per UI-SPEC §1 this is the intended launch shape since the empty recipe block never enters the DOM — that suppression logic itself is plan 74-02/74-03's JS work, not this plan's).

## Threat Flags

None — this plan introduces zero new network endpoints, auth paths, or trust-boundary-crossing behavior. The one new public surface (`wine.html`) is CSP-mitigated per the plan's own threat register (T-74-17/18/19), verified via the string-equality gate.
