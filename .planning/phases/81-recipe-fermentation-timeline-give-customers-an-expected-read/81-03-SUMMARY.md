---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 03
subsystem: ui
tags: [frontend, vanilla-js, css, catalog, beer, recipe-card, copywriting]

requires:
  - phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read (plan 02)
    provides: "recipe.ferment_days on GET /api/recipes public payload"
provides:
  - "fermentTimeDisplay(recipe) helper in js/modules/07-catalog-kits.js"
  - "Conditional second .price-col ('Ready in / about N weeks / from brew day') on buildRecipeCard"
  - ".ferment-time-value/.ferment-time-weeks/.ferment-time-start CSS rules"
  - "Rewritten beer.html How-It-Works step 4 + FAQ timeline answer, both naming brew day as the start point"
affects: []

tech-stack:
  added: []
  patterns:
    - "Second .price-col appended conditionally after the existing priceCol, before card.appendChild(footer) — mirrors the buildLabelPriceFooter 1-vs-2-column precedent without calling it"
    - "createElement/textContent only inside buildRecipeCard (T-74-12); innerHTML forbidden and re-verified via grep"

key-files:
  created: []
  modified:
    - js/modules/07-catalog-kits.js
    - css/styles.css
    - css/styles.min.css
    - js/main.js
    - js/main.min.js
    - beer.html
    - tests/frontend/catalog-recipe-block.test.js

key-decisions:
  - "fermentTimeDisplay omits the column entirely (returns null) for any ferment_days that rounds below 1 week — never renders '0 weeks' (D-09)"
  - "Ready-in value uses --font-body/--color-muted-dark, never --font-condensed (Oswald fallback bug) or --color-burgundy, and declares no opacity (would drop below 4.5:1 AA)"
  - "beer.html's buildLabelPriceFooter acceptance-criterion grep (whole-file count = 0) does not match the codebase: buildBeerCard already calls it twice for kit cards, pre-existing on the base commit. buildRecipeCard's own body was verified to contain zero calls — the actual D-07 requirement — via an isolated grep on the extracted function body"

patterns-established:
  - "Public recipe-card feature columns: read one derived integer from the payload, guard-null on anything non-finite/non-positive/sub-threshold, build via two explicit spans rather than one wrapped string when the phrase won't fit on one line at card width"

requirements-completed: [OPS-05]

duration: 6min
completed: 2026-09-05
---

# Phase 81 Plan 03: Recipe Fermentation Timeline — Customer-Visible Card & Copy Summary

**Beer recipe cards now show "Ready in / about N weeks / from brew day" beside the price, and both `beer.html` passages that used to defer the timeline to the consult now name the ale/lager week split and brew day as the start point.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-09-05T10:23:47-07:00
- **Completed:** 2026-09-05T10:29:08-07:00
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- `fermentTimeDisplay(recipe)` — pure helper resolving the D-05 nearest-week rounding and the D-09 unusable-value floor in one place, exported from `js/modules/07-catalog-kits.js`
- `buildRecipeCard` appends a conditional second `.price-col` ("Ready in") using `createElement`/`textContent` only; the innerHTML-free constraint (T-74-12) was re-verified with a grep scoped to the function body
- ~10 lines of additive CSS reusing existing tokens (`--font-body`, `--color-muted-dark`) with no opacity and no `--font-condensed`, matching the UI-SPEC's explicit AA-contrast and Oswald-fallback constraints
- Both `beer.html` timeline passages rewritten verbatim per UI-SPEC §2 — neither defers to the consult anymore, both name "counted from your brew day"
- CSP confirmed unchanged by direct inspection: `beer.html`'s `default-src`/`script-src` diffed byte-identical against sibling `wine.html`

## Task Commits

Each task was committed atomically (TDD: RED → GREEN for Task 1):

1. **Task 1 RED — failing tests** - `eaffc506` (test)
2. **Task 1 GREEN — fermentTimeDisplay + second .price-col + CSS + rebuilt bundles** - `6d975b27` (feat)
3. **Task 2 — rewrite both beer.html timeline passages** - `bdc63321` (docs)

No plan-metadata commit in this worktree run — STATE.md/ROADMAP.md updates are owned by the orchestrator after merge.

## Files Created/Modified
- `js/modules/07-catalog-kits.js` — `fermentTimeDisplay()` added (colocated with `recipeDisplayPrice`), exported; `buildRecipeCard` gained the conditional second column
- `css/styles.css` / `css/styles.min.css` — `.label-beer .price-value.ferment-time-value` / `.ferment-time-weeks` / `.ferment-time-start` rules added immediately after the existing `.label-beer .price-value` rule
- `js/main.js` / `js/main.min.js` — rebuilt via `npm run build` from the module source (never hand-edited)
- `beer.html` — How It Works step 4 and the FAQ "How long until it's ready?" answer rewritten; nothing else on the page touched
- `tests/frontend/catalog-recipe-block.test.js` — new `describe('fermentTimeDisplay', ...)` (11 tests) and new `describe('buildRecipeCard — Ready-in second .price-col (D-07/D-09)', ...)` (5 tests); the pre-existing `describe('buildRecipeCard', ...)` block was not touched

## Decisions Made
- Reused the D-09 single-vs-two-column pattern already proven by `buildLabelPriceFooter` (kit cards) without calling that function from `buildRecipeCard` — copied the idiom, not the call, per the plan's explicit instruction (different data shape, different module, permits `innerHTML` internally which `buildRecipeCard` must not)
- Kept the CSP verification as an inspection step (diff against `wine.html`), not an assumption — confirmed identical, no edit made, per T-81-15's mitigation requirement

## Deviations from Plan

None — plan executed exactly as written. One plan **acceptance-criterion inaccuracy** is worth flagging (not a deviation in the code, since no plan text or code was changed to work around it):

**Plan's Task 1 acceptance criterion `grep -c "buildLabelPriceFooter" js/modules/07-catalog-kits.js` returns 0 does not hold** — the file already contains 2 pre-existing calls to `buildLabelPriceFooter` from `buildBeerCard` (kit cards), present on the base commit before this plan touched the file (`git show a8d85b7c:js/modules/07-catalog-kits.js | grep -c buildLabelPriceFooter` = 2). The plan's actual behavioral requirement — "`buildRecipeCard` must not call `buildLabelPriceFooter`" — was verified instead by extracting `buildRecipeCard`'s own function body and grepping that in isolation, which returns 0. No code change was needed; this is purely a stale/overbroad acceptance-criterion grep in the plan text, worth correcting in any future plan that reuses this criterion pattern.

## Issues Encountered
- `npm run build` regenerates cache-busting `?v=` query-string stamps and a `BUILD_TIMESTAMP` across every public/admin HTML page and `js/admin.js`/`js/admin.min.js`, not just the files this plan touches. Reverted all of that unrelated churn (`git checkout --`) before staging, keeping only `css/styles.css`/`css/styles.min.css`, `js/main.js`/`js/main.min.js`, and `js/modules/07-catalog-kits.js` in the Task 1 commit — `beer.html`'s own stamp churn was reverted too, since its content wasn't edited until Task 2, whose subsequent `git diff --stat` shows exactly 2 changed lines as required.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The public-facing deliverable of Phase 81 (D-06/D-07/D-09) is complete: a live `ferment_days` from the middleware renders a two-line "Ready in" column, and both `beer.html` passages match the cards' wording
- Remaining phase scope (per `81-PLAN.md` roadmap) is the three staff-only admin surfaces (recipe editor schedule picker, BeerXML review modal, FermSchedules template editor) — none of that is touched by this plan and none of it blocks this plan's own verification
- Frontend suite: baseline 1643/1643 → now 1660/1660 (+17, all new); lint clean; `npm run build` completes cleanly

---
*Phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read*
*Completed: 2026-09-05*

## Self-Check: PASSED
All created/modified files verified present on disk; all commit hashes (eaffc506, 6d975b27, bdc63321, eea1eb35) verified in git log.
