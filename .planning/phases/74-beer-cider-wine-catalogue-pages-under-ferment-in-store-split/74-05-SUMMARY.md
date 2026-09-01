---
phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
plan: 05
subsystem: frontend (static HTML routes)
tags: [hub, beer, wine, catalogue, homepage-cta, D-10, D-11, D-12, D-13]
dependency-graph:
  requires:
    - "wine.html and its .hub-categories/.hub-category-item/#catalog-blocks CSS (plan 74-04)"
  provides:
    - "products/ferment-in-store.html as a neutral routing hub (no catalogue, no cart)"
    - "beer.html catalogue block (#catalog-blocks / #product-catalog / #recipe-catalog) with Style+ABV filters only"
    - "index.html hero CTA repointed to /wine"
  affects:
    - "plan 74-06 (JS dispatch wiring for beer.html's catalogue, catalogue-init gate cleanup, single npm run build)"
tech-stack:
  added: []
  patterns:
    - "Hub-and-spoke routing section (.hub-categories / .hub-category-item) reused verbatim from plan 74-04's CSS, no new rules needed"
    - "Two-block DOM contract (#catalog-blocks wrapping #product-catalog + empty #recipe-catalog) reproduced on beer.html, matching wine.html's shape from plan 74-04"
key-files:
  created: []
  modified:
    - products/ferment-in-store.html
    - beer.html
    - index.html
decisions:
  - "Task 1 owner sign-off: remove-both-and-repoint selected — both sub-decisions below"
  - "(a) Ingredients tab: REMOVED along with the kits tab. The entire #product-catalog block (product-tabs, catalog-controls with all 9 wine filter rows, cart-sidebar, cart-drawer, filter-status live region) came out as one unit. Ingredients access is preserved via the existing products/ingredients-supplies.html, linked from the hub's new 'Ingredients & Supplies' routing card and already reachable from site nav as 'All Ingredients'."
  - "(b) Homepage hero CTA: REPOINTED to wine.html. Changed only the href on index.html's hero anchor (data-content=\"hero-cta\") from products/ferment-in-store.html to wine.html. Label text 'Reserve Your Kit' was left untouched per the plan's explicit instruction — content/home.json overwrites this element's text at runtime (Phase 72-02 precedent), and editing content/home.json was out of scope for this plan."
metrics:
  duration: "~25 min"
  completed: 2026-09-01
---

# Phase 74 Plan 05: Hub rewrite, beer catalogue append, homepage CTA repoint Summary

Rewrote `products/ferment-in-store.html` into a neutral hub that keeps its "Make Your Own Wine in Squamish" ranking copy but routes to Wine/Beer/Ingredients via three plain link cards, appended a Style+ABV-only catalogue block to `beer.html` between its "What's Included" and waitlist sections without disturbing the existing launch narrative, and repointed `index.html`'s primary hero CTA from the (now catalogue-less) hub to `/wine`.

## What Was Built

### Task 1 (resolved by owner prior to this agent's spawn): remove-both-and-repoint
Both sub-decisions from the checkpoint are recorded above under `decisions`. This continuation agent did not re-present the checkpoint — it was resolved before spawn and is recorded here per the plan's acceptance criteria (separate entries for the ingredients-tab disposition and the homepage-CTA target).

### Task 2: `products/ferment-in-store.html` rewritten into the neutral hub (D-10)
- Removed the entire `section.catalog-section` `#product-catalog` block: the `#product-tabs` kits/ingredients switcher, all 9 wine filter rows plus sort, `#cart-sidebar`, `#cart-drawer-backdrop`, `#cart-drawer`, and the trailing `#filter-status` live region.
- Preserved `section.landing-copy#landing-copy` byte-for-byte, including the `h2` "Make Your Own Wine in Squamish" and the full `#landing-copy-detail` block — confirmed via `git diff | grep -c '^-.*landing-copy'` returning 0.
- Added a `h2` "Browse by Category" + `div.hub-categories` with exactly 3 `div.hub-category-item` entries (Wine → `../wine.html`, Beer → `../beer.html`, Ingredients & Supplies → `ingredients-supplies.html`), reusing plan 74-04's existing `.hub-categories`/`.hub-category-item`/`.btn-secondary` CSS classes with no new styling.
- No Cider entry added (out of scope, no live page).
- `index.html`: changed only the `href` of the `data-content="hero-cta"` anchor from `products/ferment-in-store.html` to `wine.html`. Label text unchanged.

### Task 3: catalogue block appended to `beer.html` (D-11, D-13)
- Inserted a new `section.catalog-section` immediately after the existing divider between "What's Included" and the "Ready to Brew?" waitlist section, followed by a new divider — preserving the page's alternating section/divider rhythm. Confirmed via byte-offset check: `What's Included` offset (11411) < `#product-catalog` offset (12188) < `#waitlist` offset (17133).
- Reproduced the two-block DOM contract from `wine.html`: `#catalog-blocks` wrapping `#product-catalog` (search, view toggle, filter/sort controls, filter-summary, noscript fallback) and an empty `#recipe-catalog`, with `#cart-sidebar`/`#cart-drawer-backdrop`/`#cart-drawer` as siblings of `#catalog-blocks` inside `.catalog-layout`.
- Filter rows limited to exactly `#filter-subcategory` (Style) and `#filter-abv` (ABV) per D-13 — none of the 8 wine-only filter-row ids appear.
- Sort `<select>` carries the same option values as `wine.html` minus `time-asc`/`time-desc` (beer.html has no `filter-time` row).
- Search placeholder changed to "Search beer...".
- Added `div[role=status][aria-live=polite]#filter-status` after the new divider.
- Added `js/vendor/fuse.min.js` (before `js/sheets-config.js`) and `js/modules/17-search-overlay.min.js?v=mt8x50y5` (after `js/main.min.js`) to the existing script block, both `defer`, both root-relative, no new third-party origin.
- Hero banner, "What It Is", "How It Works", "What's Included", the waitlist section (`#beer-waitlist-form`, `#beer-waitlist-email`, `#beer-waitlist-confirm`), FAQ, and the final "Back to Home" section are byte-identical — confirmed via `git diff beer.html | grep '^-'` returning zero deletion lines (pure insertion).

## Verification

- `node -e` automated verify scripts for both Task 2 and Task 3: PASS (exact text from plan)
- All Task 2 acceptance-criteria greps: PASS (landing-copy count 1, landing-copy-detail count 1, 0 landing-copy diff deletions, product-catalog/product-tabs/cart-sidebar/cart-drawer/filter-status counts all 0, hub-category-item count 3, `../wine.html` and `ingredients-supplies.html` present, 0 "Cider" occurrences, CSP count 1)
- All Task 3 acceptance-criteria greps: PASS (catalog-blocks/recipe-catalog/filter-subcategory/filter-abv counts all 1, zero wine-only filter-row ids, byte-offset ordering confirmed, beer-waitlist-form count 1, "Join the Waitlist" count 2, beer-banner count unchanged at 3, fuse.min.js and 17-search-overlay.min.js counts 1 each, zero `../` paths, zero diff deletions, CSP count 1 and 0 CSP diff lines)
- `git diff --name-only` (base `e768384` vs HEAD): exactly `beer.html`, `index.html`, `products/ferment-in-store.html` — matches plan's `files_modified`
- `python3 html.parser` parse of both `beer.html` and `products/ferment-in-store.html`: exits 0, no errors
- `npm test`: 89 suites / 1188 tests passing (run twice, once after each task's edits)
- `npm run lint`: clean, 0 warnings (run twice)
- No file deletions in either commit (`git diff --diff-filter=D` empty both times)
- Worktree HEAD stayed on `worktree-agent-accb4ae5471b1aabf` throughout; base corrected via `git reset --hard` to `e768384` at start (agent's worktree had drifted onto unrelated phase-77 commits before this session — see Deviations)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking issue] Worktree base drift corrected before any edits**
- **Found during:** Startup branch-check step, before Task 2
- **Issue:** The worktree's HEAD was on unrelated phase-77 commits (`33b52dac` etc., BrewPad retry/cache fixes), not the expected phase-74 wave-1 merge base `e768384`. `git merge-base HEAD e768384` returned `33b52dac`, confirming the mismatch — this was a stale/reused worktree, not new work by a prior agent.
- **Fix:** Ran `git reset --hard e76838475301c4f43c3e8093adfcfd3b35630bc7` per the mandated worktree-branch-check protocol, exactly as instructed in the prompt's `<worktree_branch_check>` block. No file content was affected; this ran before any Read/Edit of the plan's target files.
- **Files modified:** None (git ref only)
- **Commit:** N/A (no code change)

**2. [Rule 1 - bug in verify script] Task 2's `git diff | grep '^[-+].*Reserve Your Kit'` acceptance check is structurally unsatisfiable for a same-line href edit**
- **Found during:** Task 2 verification of the index.html CTA repoint
- **Issue:** The plan's stated acceptance criterion for the CTA repoint asserts `git diff index.html | grep -c '^[-+].*Reserve Your Kit'` returns 0 ("label untouched"). Because the anchor's `href` and its visible text `Reserve Your Kit` sit on the same source line (`<a href="..." class="btn" data-content="hero-cta">Reserve Your Kit</a>`), any href-only edit necessarily produces one `-` line and one `+` line that both contain the string "Reserve Your Kit" in a standard line-based diff — this criterion cannot pass for any valid single-line href change, regardless of whether the label itself was touched.
- **Fix:** Verified label preservation by direct content inspection instead: `git diff index.html` shows exactly one changed line, with only the `href` value differing (`products/ferment-in-store.html` → `wine.html`); the text between the tags, `Reserve Your Kit`, is byte-identical on both sides of the diff. This satisfies the actual intent of the criterion (label untouched) even though the literal grep-based check as written cannot pass.
- **Files modified:** None beyond the already-planned `index.html` href change
- **Commit:** `7593b78a` (same commit as the intended Task 2 change; no separate fix needed)

None of the other deviation rules (2/4) applied — no missing critical functionality was discovered, and no architectural change was required.

## Known Stubs

None. Both the hub's category cards and beer.html's catalogue markup are fully wired to the same DOM-contract shape that plan 74-02/74-03's JS binds to on `wine.html`; no placeholder text, no hardcoded-empty data paths introduced. The catalogue's actual data population and dispatch wiring for `beer.html`/`data-page="beer"` remains plan 74-06's scope, as stated in this plan's objective — this is a known, planned deferral, not an unplanned stub.

## Threat Flags

None. All edits fall within the plan's own `<threat_model>` register (T-74-22 through T-74-27): no CSP disturbed on any of the three files (`Content-Security-Policy` count is 1 on both `beer.html` and `products/ferment-in-store.html`, 0 diff lines touching it on either), no new third-party origin introduced (the two added script tags are first-party `js/` assets already used by `wine.html`), and the hub's outbound routes were added before its catalogue/cart were removed.

## Self-Check: PASSED

- FOUND: products/ferment-in-store.html
- FOUND: beer.html
- FOUND: index.html
- FOUND commit: 7593b78a (Task 2)
- FOUND commit: 8d083920 (Task 3)
