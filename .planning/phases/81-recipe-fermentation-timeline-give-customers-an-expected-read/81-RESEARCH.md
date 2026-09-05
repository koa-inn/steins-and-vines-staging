# Phase 81: Recipe fermentation timeline — Research

**Researched:** 2026-09-05
**Domain:** Google Apps Script (sheet-backed API) + Express middleware + vanilla-ES5 frontend, linking two existing sheet-backed concepts (`Recipes`, `FermSchedules`) that were never connected
**Confidence:** MEDIUM-HIGH — code paths are fully verified by direct file citation; the one genuinely unverifiable fact (live `FermSchedules` sheet contents) is disclosed as unverifiable below, not guessed at.

## Summary

This phase wires two sheets that already exist and already ship in production (`Recipes`, `FermSchedules`) together, adds one derived public field, and touches five files across three deploy surfaces (Apps Script, middleware, frontend). Nothing here is architecturally novel: `ensureRecipesPricingModeColumn` (`apps-script/adminApi.gs:3592`) is a byte-for-byte precedent for the safe self-migrating `schedule_id` column, `sheetToObjects`/`findRowById` are proven header-name-based (never positional) so an 18th column is safe everywhere `Recipes` is read, and `buildLabelPriceFooter` (`js/modules/04-label-cards.js:104`) is a live, shipped, owner-approved precedent for the exact 1-vs-2-`.price-col` visual case D-09 needs (confirmed: it is a *sibling* pattern to copy, not a function `buildRecipeCard` can call — they operate on different data shapes in different modules).

The one fact this research could **not** verify is also the one CONTEXT.md flagged as highest-value: whether any `FermSchedules` row has `category === 'beer'`. No credential exists in this working copy's `zoho-middleware/.env` for `APPS_SCRIPT_URL`/`APPS_SCRIPT_SERVER_TOKEN` (checked directly — the file has zero lines matching `APPS_SCRIPT`), and no cached JSON snapshot of the sheet exists anywhere in the repo. This is disclosed honestly below with the exact command the owner (who does have interactive/owner access) can run to answer it in under a minute, and with what the plan should do in each branch.

Independently, this research surfaced four **new, verified pitfalls** not called out in CONTEXT.md's `<code_context>`: (1) `fermSchedulesData` is lazy-loaded only by the Batches tab, so opening the Recipes tab directly leaves the new schedule picker's options empty; (2) BeerXML import's `confirmBeerXMLImport` builds a fresh object for `populateRecipeForm` that does not carry a `schedule_id` field through, so D-12's dropdown selection would be silently discarded on "Confirm Import" unless wired explicitly; (3) editing a `FermSchedules` template via `update_ferm_schedule` never busts the Apps Script's own `'gfs'` CacheService key (unlike every batch-mutating action, which does) — so D-15's "changing day offsets will change what customers are told" claim has an existing, pre-phase, up-to-5-minute staleness window even before any new middleware cache is added; (4) the middleware's recipes route never fetches schedules today (only `get_recipes`/`get_recipe`/`create_recipe`/`update_recipe`/`delete_recipe` — confirmed by grep), but the fetch it needs already has a zero-Apps-Script-change path available via the existing GET+`server_token` bypass in `doGet`, reusing a pattern already proven at `zoho-middleware/routes/pos.js:3323`.

**Primary recommendation:** Follow the `pricing_mode` precedent exactly for `schedule_id` (self-migrating column, header-name persistence, no manual pre-add step needed — this is *not* the Waitlist/Phase-80 fail-closed case), fetch schedules in the middleware via a new `axios.get` call (not a `doPost` change), and before writing a single line of code, have the owner run the one-line curl check below to close the D-10 scope question.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `schedule_id` persistence on a recipe | Database / Storage (`Recipes` sheet via Apps Script) | API / Backend (Apps Script `createRecipe`/`updateRecipe`) | The link is data, not logic; Apps Script is this project's only write path to Sheets |
| `ferment_days` derivation (schedule → integer) | API / Backend (`zoho-middleware/routes/recipes.js`) | — | D-16 locks this server-side so a copy tweak never needs a Railway deploy; the frontend must never see step data |
| "about N weeks from brew day" phrasing | Browser / Client (`js/modules/07-catalog-kits.js`) | — | D-16 explicitly reserves wording to the frontend so it's an HTML/JS edit, not a middleware deploy |
| Schedule template CRUD + blast-radius warning | API / Backend (Apps Script `createFermSchedule`/`updateFermSchedule`) | Browser / Client (`renderScheduleForm`, warning text) | Templates are staff data; Apps Script owns the write, the browser owns the warning copy |
| BeerXML timing extraction (display-only) | Browser / Client (`parseBeerXML`, `js/admin.js`) | — | Parsing happens client-side today (DOMParser on the uploaded file); no reason to introduce a server round-trip for a display-only value |
| Batch schedule pre-selection (D-04) | Browser / Client (`#batch-schedule-select`/`#sa-schedule-select`) | — | Default-value behavior on an already-existing, already-client-rendered control |
| Public field allowlisting (`ferment_days` visibility) | API / Backend (`toPublicRecipe`/`PUBLIC_RECIPE_FIELDS`) | — | Build-by-allowlist (T-74-04) is the established access-control mechanism; this is where `schedule_id`/step data get stopped from leaking |

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** The figure counts to ready-to-package (customer comes in to can/bottle). Conditioning after packaging is not counted and not promised.
- **D-02 (superseded by D-03):** ~~Store one total in days on the Recipes sheet, excluding `AGE`.~~
- **D-03:** The recipe carries a `schedule_id` pointing at a `FermSchedules` template. The customer-facing figure is derived as the largest `day_offset` among that template's non-packaging steps. No `ferment_days` column on `Recipes`.
- **D-04:** Batch creation and activation pre-select the recipe's schedule template in the existing `#batch-schedule-select`/`#sa-schedule-select` dropdowns. Staff can still change it.
- **D-05:** Days round to the nearest week and render as "about N weeks." Day 24 → "about 3 weeks"; day 26 → "about 4 weeks." Never an exact date.
- **D-06:** The phrase itself names the start point — e.g. "about 3 weeks from brew day."
- **D-07:** On the recipe card the figure is a second label/value column in the existing `.price-footer`, reusing the `.price-col` idiom. `buildRecipeCard` is `createElement`-only (T-74-12); the new column must stay that way.
- **D-08:** Both `beer.html` timeline passages are rewritten: How It Works (`beer.html:179`) and the FAQ "How long until it's ready?" (`beer.html:318`). Does not conflict with Phase 80 D-14 (queue-order copy, different sentence).
- **D-09:** A recipe with no schedule attached (or whose template yields no usable non-packaging offset) omits the "Ready in" footer column entirely. No "TBD", no "—", no "0 weeks."
- **D-10:** The 3 active recipes get their schedule attached by hand. Creating suitable beer templates (ale, lager) in `FermSchedules` is IN SCOPE if none exist or only a generic one does. Release gate: all 3 active recipes render a timeline on the day this ships.
- **D-11:** The recipe editor warns but does not block when an `active` recipe has no schedule.
- **D-12:** `parseBeerXML` reads `PRIMARY_AGE`/`SECONDARY_AGE`/`TERTIARY_AGE` and surfaces the total in the review modal's meta line. Import informs; it never decides. A schedule-template dropdown is added to the review modal so staff choose with the source number visible.
- **D-13:** No auto-suggestion. The dropdown does not pre-select the nearest-matching template.
- **D-14:** When a template is chosen, the modal shows both figures side by side — "BeerXML: 35 days · Template: 21 days" — with no warning threshold and no judgement.
- **D-15:** The schedule-template editor notes its blast radius — "Used by N public recipes; changing day offsets will change what customers are told." Does not block.
- **D-16:** `GET /api/recipes` exposes one derived integer, `ferment_days`, added to `PUBLIC_RECIPE_FIELDS`. The middleware resolves the template server-side. `schedule_id`, step titles, transfer flags and template names never appear in a public response. This amends Phase 74 D-07.

### Claude's Discretion

- Exact column name for the recipe's schedule reference (`schedule_id` assumed, matching `Batches`).
- Exact CSS/markup for the second `.price-col`, and its behaviour at narrow widths.
- Precise final wording of the rewritten `beer.html` passages, within D-06 and D-08.
- Where the schedule picker sits in the recipe editor form (`admin.html:508-521`).
- Rounding implementation detail (e.g. `Math.round(days / 7)`), and the floor below which a value is treated as unusable for D-09.
- How the template's usable offset is computed when steps are stored out of order — take the max, do not assume array order.

### Deferred Ideas (OUT OF SCOPE)

- Auto-fill a computed expected-packaging date on the batch (natural follow-up once D-03/D-04 ship).
- Per-recipe timeline override (declined — fork the template instead).
- Stage-by-stage fermentation data on the recipe (Phase 66 territory, along with hop timing and mash steps).
- BeerXML `AGE` (post-packaging conditioning) as a second customer-facing number.
- A `category` field on recipes (Phase 74 already logged this as a future LOCKED decision; unrelated to this phase's `FermSchedules.category`).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OPS-05 (fermentation-time slice only) | Recipes carry a structured brewing schedule instead of free-text notes, surfaced to customers | This research confirms the existing `FermSchedules` mechanism (`getFermSchedules`, `apps-script/adminApi.gs:1784`) already provides structured data; the gap is purely the `Recipes.schedule_id` link, its middleware-side derivation, and its public exposure — all mapped below with exact file:line insertion points. Hop timing, mash steps and hop-unit normalization explicitly stay in Phase 66. |

## Project Constraints (from CLAUDE.md)

- Never edit `js/main.js` or `js/main.min.js` directly — edit `js/modules/07-catalog-kits.js`, then run `npm run build`.
- After changing `js/lib/*.js` or `zoho-middleware/lib/*.js`, run the FULL test suite for both frontend and middleware (this phase does not appear to need a shared-lib change, but `zoho-middleware/lib/constants.js` gains a new `CACHE_KEYS` entry — treat that as a shared-lib change and run both suites).
- Do NOT modify existing tests unless explicitly asked — extend `zoho-middleware/__tests__/recipes.test.js`, `recipes-public-guard.test.js`, `tests/frontend/catalog-recipe-block.test.js`, and `tests/frontend/admin-beerxml.test.js` rather than editing their existing cases.
- Write a regression test FIRST when fixing a bug (relevant if the plan chooses to also fix the pre-existing `'gfs'`/`_invalidateRecipeCache` cache-bust gap found below — that would be a bug fix, not new-feature work, and should get its own first-failing-test).
- CSP `<meta>` tags: confirmed (see below) — this phase adds no third-party service/origin, so no CSP edit is expected on any public page.
- `zoho-middleware` has its own `node_modules` — always `cd zoho-middleware` before running middleware commands.

## Standard Stack

No new libraries. This phase is entirely internal-code plumbing across three already-deployed surfaces (Apps Script `.gs`, Express middleware, vanilla ES5 frontend). No `npm install` of any kind is required.

### Package Legitimacy Audit

**Not applicable.** This phase installs no new npm, pip, or other external packages. Skip the slopcheck/registry-verification gate entirely — there is nothing to verify.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────────┐
                     │  Google Sheet (single source of truth)       │
                     │  ┌───────────┐        ┌──────────────────┐  │
                     │  │ Recipes   │──18th──▶│ FermSchedules    │  │
                     │  │ (+schedule│  col:   │ schedule_id,name,│  │
                     │  │  _id)     │schedule_│ category,steps   │  │
                     │  └───────────┘  id     │ (JSON: day_offset,│  │
                     │                         │ is_packaging)    │  │
                     │                         └──────────────────┘  │
                     └───────────────┬───────────────────────────────┘
                                     │ Apps Script (adminApi.gs)
                     ┌───────────────▼───────────────────────────────┐
                     │ doGet / doPost — server_token OR staff OAuth   │
                     │  • getRecipes/getRecipeDetail → schedule_id    │
                     │    passes through automatically (header-based) │
                     │  • getFermSchedules() → steps_parsed           │
                     │  • createRecipe/updateRecipe → persist         │
                     │    schedule_id via self-migrating column       │
                     └───────────────┬───────────────────────────────┘
                                     │ HTTPS (server_token GET/POST)
        ┌────────────────────────────▼────────────────────────────────┐
        │ Railway middleware (zoho-middleware/routes/recipes.js)       │
        │  1. GET /api/recipes[/:id] fetches recipe(s)                 │
        │  2. NEW: fetch/cache FermSchedules (axios.get + server_token,│
        │     doGet bypass — no Apps Script change needed)             │
        │  3. NEW: maxNonPackagingOffset(schedule) → ferment_days      │
        │  4. toPublicRecipe() — D-16 allowlist gains 'ferment_days'   │
        │     (schedule_id/steps/template name NEVER cross this line) │
        └───────────────┬───────────────────────┬──────────────────────┘
                         │ JSON                  │ JSON (staff/admin)
        ┌────────────────▼───────────┐  ┌────────▼─────────────────────┐
        │ Public: beer.html,          │  │ Staff-only: admin.html       │
        │ buildRecipeCard()           │  │  • recipe editor: schedule   │
        │  "Ready in / about 3 weeks  │  │    picker + D-11 warning     │
        │   from brew day" — 2nd      │  │  • BeerXML review modal:     │
        │  .price-col, createElement- │  │    template dropdown, D-14   │
        │  only (T-74-12)             │  │    side-by-side compare      │
        └─────────────────────────────┘  │  • FermSchedules editor:     │
                                          │    D-15 blast-radius note    │
                                          └───────────────────────────────┘
```

### Recommended "Project Structure" (files touched, not new folders — this is an established codebase)

```
apps-script/adminApi.gs           # ensureRecipesScheduleIdColumn (new), createRecipe/updateRecipe edits
zoho-middleware/routes/recipes.js # fetch+cache schedules, maxNonPackagingOffset, PUBLIC_RECIPE_FIELDS
zoho-middleware/lib/constants.js  # new CACHE_KEYS.FERM_SCHEDULES entry
js/modules/07-catalog-kits.js     # buildRecipeCard 2nd .price-col, fermentTimeDisplay() helper
css/styles.css                    # ~10 new lines next to .label-beer .price-value (see UI-SPEC §1)
beer.html                         # 2 copy passages (line 179, line 318)
admin.html                        # 1 new form field (~line 508-521)
js/admin.js                       # populateRecipeForm, saveRecipe, showBeerXMLReviewModal,
                                   # confirmBeerXMLImport, renderScheduleForm, parseBeerXML,
                                   # triggerBatchLoad wiring for the Recipes tab
```

### Pattern 1: Self-migrating sheet column (the `schedule_id` precedent)

**What:** A column that doesn't exist on old rows is added lazily, on first write, by header-name lookup — never by a manual pre-edit of the header row.
**When to use:** Adding any new field to `Recipes` that (a) has a sane empty-string default and (b) is read everywhere via `sheetToObjects`/`findRowById` (both confirmed header-based, never positional — verified by reading every `RECIPES_SHEET_NAME` call site in `apps-script/adminApi.gs`: lines 3516, 3562, 3624, 3629, 3685, 3730, 3743, 3745, 3969, 4002, 4026, 4052, 4069).
**Example — the exact precedent to copy** (`apps-script/adminApi.gs:3592-3601`):
```javascript
// Source: apps-script/adminApi.gs:3592 (verified in this session)
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
Write `ensureRecipesScheduleIdColumn(sheet)` as a structural copy of this, called from both `createRecipe` and `updateRecipe` **before** the row is read (see the `D-08 ordering` comment at `apps-script/adminApi.gs:3736-3744` — the self-migration MUST run and `invalidateSheetCache` MUST fire before `findRowById` reads the row, or a stale cached header width causes a short-row write). Add `'schedule_id'` to `updateRecipe`'s `stringFields` array (`apps-script/adminApi.gs:3763`) so it round-trips through the existing single-ranged-write path with no new code branch. `createRecipe` should call `ensureRecipesScheduleIdColumn` + a single `.setValue()` immediately after its positional `appendRow(...)`, mirroring the `pmCol`/`normalizePricingMode` calls already there.

**Why this is NOT the Phase 80 "add column first, redeploy second" case:** Phase 80's Waitlist migration needed a manual pre-redeploy header edit because `ensureWaitlistSheet()` (`apps-script/adminApi.gs:4874`) is a **fail-closed validator** — it returns `{ok:false, error:'waitlist_unavailable'}` if ANY of its 13 expected headers is missing, which would have taken down every public beer-waitlist signup the instant the new code deployed against an unmigrated sheet. `ensureRecipesPricingModeColumn`/`ensureRecipesScheduleIdColumn` are the opposite: **self-healing**, not validating — they add the missing column themselves, in the same call, with no separate step and no window where they refuse to work. This pattern is already live in production today (`pricing_mode` shipped this exact way), so the safe sequence for `schedule_id` is simpler than Phase 80's: write the code, redeploy once (recording the pre-redeploy version number as the rollback target, per the `80-06` precedent), and the column appears automatically the first time any recipe is saved — no separate "add the header row by hand" step is load-bearing here. (Recording the rollback version number is still good practice even though the risk is lower — see Common Pitfalls.)

### Pattern 2: Cross-runtime pure derivation function (must be written twice, kept in lockstep)

**What:** `maxNonPackagingOffset(schedule)` — given a `FermSchedules` row with `steps_parsed` (or a `steps` JSON string), return the largest `day_offset` among steps where `is_packaging !== true`, or `null`/`undefined` if there are no such steps.
**When to use:** This exact function is needed in TWO places, in two different JS runtimes that cannot share a module: (a) `zoho-middleware/routes/recipes.js` (Node, for D-16's server-side `ferment_days`) and (b) `js/admin.js` (browser, for D-14's live "BeerXML: 35 days · Template: 21 days" comparison, which must render before any save round-trips to the server). Both must apply identical semantics — exclude packaging, take the max, tolerate out-of-order arrays (per CONTEXT.md's Claude's-Discretion note) — or the number shown in the BeerXML review modal will disagree with the number that later appears on the live card, which would be exactly the kind of silent drift D-03 was written to prevent.
**Example:**
```javascript
// Pure, colocated with recipeDisplayPrice() (Node) or fermentTimeDisplay() (browser)
function maxNonPackagingOffset(schedule) {
  var steps = schedule && (schedule.steps_parsed ||
    (typeof schedule.steps === 'string' ? safeParse(schedule.steps) : schedule.steps)) || [];
  var max = null;
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    if (s && s.is_packaging !== true && typeof s.day_offset === 'number') {
      if (max === null || s.day_offset > max) max = s.day_offset;
    }
  }
  return max; // null when no usable step exists — D-09's floor
}
```
Recommend a code comment in BOTH copies cross-referencing the other's file:line, so a future edit to one is more likely to catch the other.

### Pattern 3: Reusing a CSS idiom without importing the function that draws it

**What:** `buildLabelPriceFooter()` (`js/modules/04-label-cards.js:104-159`) and `buildRecipeCard()` (`js/modules/07-catalog-kits.js:181-238`) are SIBLING implementations of the same `.price-footer`/`.price-col` visual idiom, not a shared function — `buildLabelPriceFooter` takes a `product` shape (kit pricing: `retail_instore`/`retail_kit`/`discount`) and `buildRecipeCard` takes a `recipe` shape (no discount/kit-only fields). **`buildRecipeCard` cannot call `buildLabelPriceFooter`** — confirmed by reading both functions in full; they are structurally parallel, not layered.
**When to use:** When a card component needs the "1 or 2 `.price-col` children, CSS draws the divider automatically" pattern, replicate the DOM-building code inline (as the UI-SPEC's §1 snippet already does) rather than attempting to import or generalize the two functions into one. Generalizing them is out of scope for this phase — it would touch a function used by every wine/cider kit card, disproportionate to a beer-recipe-card feature.
**Note on the `innerHTML` boundary:** `buildLabelPriceFooter` DOES use `.innerHTML` internally (for its strikethrough-discount case, `js/modules/04-label-cards.js:124`) — this is fine, because T-74-12's `createElement`-only constraint applies specifically to `buildRecipeCard`'s body (grep-verified as the mitigation for a past XSS-adjacent finding), not to every price-footer builder in the codebase. Do not let this precedent justify adding `innerHTML` to `buildRecipeCard`.

### Anti-Patterns to Avoid

- **Assuming `fermSchedulesData` is populated when the recipe editor opens.** It is only loaded by `triggerBatchLoad()` (`js/admin.js:8485`), wired to the Batches tab's `click`/`mouseenter` events (`js/admin.js:8493-8503`). The Recipes tab has its own, separate lazy-load hook (`triggerRecipesLoad()` → `initRecipesTab()`, `js/admin.js:8541-8562`) that does NOT call `triggerBatchLoad()`. **A staff member who opens Admin → Recipes without ever visiting Admin → Batches first will see an empty schedule picker even when templates exist.** Fix: call `triggerBatchLoad()` (idempotent — guarded by `_batchDataLoaded`/`_batchDataLoading`) from inside `initRecipesTab()`, or a narrower `loadScheduleTemplates()` call if `fermSchedulesData.length === 0`.
- **Trusting `confirmBeerXMLImport`'s `populateRecipeForm({...})` call to carry the BeerXML modal's schedule selection forward.** It doesn't today, and D-12's new `<select>` won't either unless explicitly added to that object literal (`js/admin.js:9702-9709` — verified, the object has exactly `name/style/abv/batch_size_l/ibu/colour_srm/status`, no `schedule_id`). Read `document.getElementById('beerxml-schedule-select').value` in `confirmBeerXMLImport` and add it to the literal.
- **Assuming a `FermSchedules` template edit is immediately visible everywhere.** `createFermSchedule`/`updateFermSchedule`/`deleteFermSchedule` (`apps-script/adminApi.gs:3140`, `3185`, `3357`) never call `CacheService.getScriptCache().removeAll([...])` for the `'gfs'` key or `_invalidateRecipeCache`'s `'gr:*'` keys — unlike every batch-mutating action, which routes through `_invalidateBatchCache` (`apps-script/adminApi.gs:3434`, whose key list already includes `'gfs'` — it's just never called from the schedule handlers). This is a pre-existing gap, not introduced by this phase, but it directly undercuts D-15's promised immediacy ("changing day offsets will change what customers are told") with up to a 300-second staleness window even before any new middleware-side cache exists. See Common Pitfalls and the open question below for the fix-or-accept decision.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Warn-but-don't-block staff UI | A new modal, toast pattern, or validation-error styling for D-11/D-15 | `.availability-banner`/`.availability-banner--low` (`css/admin.css:3054-3076`) | Already the established "soft warning" visual language for ingredient-stock warnings; reusing it keeps one consistent pattern instead of three |
| 1-vs-2-column price footer | New CSS grid/flex logic for "what if only one column exists" | `.price-footer`/`.price-col` + the existing `.price-col + .price-col` divider rule (`css/styles.css:4714-4716`) | Already proven, shipped, owner-approved (2026-09-01 UAT per UI-SPEC) for exactly this case on kit cards |
| Recipe-level review-before-save gate | A bespoke "confidence" UI for the BeerXML timing field | The existing D-08/D-09 BeerXML ingredient-review-table pattern (Phase 15), applied at the recipe level per D-12/D-13/D-14 | The review-as-control pattern (heuristics inform, human confirms) already exists and is proven; this is that same shape one level up |

**Key insight:** Every visual/interaction primitive this phase needs (warn-don't-block banner, 2-column price footer, human-confirms-the-import review step) already ships in production somewhere in this codebase. The work here is entirely in *wiring the data*, not inventing new UI vocabulary.

## Common Pitfalls

### Pitfall 1: Assuming `FermSchedules` is Apps-Script-readable without credentials in this environment

**What goes wrong:** Treating "the sheet holds beer templates" or "it doesn't" as a fact this research session can verify by code inspection alone.
**Why it happens:** `getFermSchedules()` (`apps-script/adminApi.gs:1784`) is real and reachable, but every path to it needs either interactive staff OAuth or the `APPS_SCRIPT_SERVER_TOKEN`. This working copy's `zoho-middleware/.env` has **zero** lines matching `APPS_SCRIPT` (checked directly with `grep -c`), and no cached JSON snapshot of `FermSchedules` exists anywhere in the repo (checked: `find . -iname "*ferm*"` returns only planning docs and product pages, no data files).
**How to avoid:** Don't guess. Have the owner (who has the credential) run one command before planning locks in D-10's scope as "create both templates" vs "attach existing ones":
```bash
curl -s "$APPS_SCRIPT_URL?action=get_ferm_schedules&server_token=$APPS_SCRIPT_SERVER_TOKEN" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const j=JSON.parse(d); const s=(j.data&&j.data.schedules)||[];
      console.log(s.map(x=>({id:x.schedule_id,name:x.name,category:x.category||'(blank)'})));
    })"
```
(Run from any machine with the two env vars — e.g. locally after populating `zoho-middleware/.env` from the owner's password manager, or directly from the Apps Script editor's `run getFermSchedules()` with `Logger.log(JSON.stringify(...))`.) This is the existing `doGet` server-token bypass (`apps-script/adminApi.gs:106-114`) — reachable non-interactively, it's just that the token isn't checked into or cached in this repo, by design (it's a secret).
**Warning signs:** Any plan that asserts "beer templates exist" or "beer templates don't exist" as fact without this command having been run is asserting an unverified claim as fact — exactly the failure mode this agent's philosophy exists to prevent.
**What the plan should do in each branch (from CONTEXT.md D-10, already decided regardless of the answer):**
- If ≥1 row has `category === 'beer'` and a sane step ladder: attach it to the 2 ale recipes (`SV-R-000011`, `SV-R-000003`), verify a lager-suitable template exists too (or create one) for `SV-R-000002`.
- If none exist, or only a generic/wine one does: create an ale template (~21 days) and a lager template (~35 days) via `renderScheduleForm` (`js/admin.js:7576`), matching the owner's own stated figures ("ales ~3 weeks, lagers ~5 weeks") as the sanity check — **if a beer template yields a wildly different number, the template is wrong, not the display** (CONTEXT.md `<specifics>`).
- Either way, the release gate (D-10) is unconditional: all 3 active recipes must render a timeline the day this ships. This is a testable, executable task regardless of which branch of the above is true.

### Pitfall 2: Blank `category` on existing FermSchedules rows

**What goes wrong:** Filtering the BeerXML modal's template dropdown (D-12) to `category === 'beer'` and getting an empty list, or silently excluding a usable wine-labeled or blank-category template that a beer recipe could legitimately reuse.
**Why it happens:** `renderScheduleForm` (`js/admin.js:7602-7606`) offers `<option value="">None</option>` alongside `wine|beer|cider|seltzer` — confirmed directly. A blank category is a normal, reachable state for any template created before this phase or created carelessly.
**How to avoid:** Filter-then-show, never hide-entirely. The UI-SPEC's §4 approach ("category-filtered to 'beer' first, with a divider before other categories — filtering, not hiding, since a beer recipe may legitimately reuse a generic template") is correct and should be followed for both the BeerXML modal dropdown and the plain recipe-editor schedule picker.
**Warning signs:** A dropdown that shows zero options for a real recipe attach/BeerXML-import flow because every existing template happens to have a blank category.

### Pitfall 3: `_invalidateBatchCache`'s key list already includes `'gfs'` — but nothing calls it from the schedule-CRUD handlers

**What goes wrong:** D-15 promises staff that editing a template's day-offsets "will change what customers are told," implying immediacy. Today, that's not quite true even one layer before this phase's own new middleware cache: `apps-script/adminApi.gs:3434`'s `_invalidateBatchCache(batchId)` removes `['gbl','gtu','gbds','gbi','gfs']` from `CacheService`, but this function is called only from batch-mutating actions (`create_batch`, `update_batch`, etc.) — never from `createFermSchedule`/`updateFermSchedule`/`deleteFermSchedule` (verified: those three functions, `apps-script/adminApi.gs:3140/3185/3357`, contain no `CacheService` call at all).
**Why it happens:** The `'gfs'` key was added to `_invalidateBatchCache`'s list for a different reason (batch-schedule-assignment flows that also touch schedules), and nobody wired the schedule-editor's OWN mutations to bust their own cache.
**How to avoid:** This is a pre-existing bug, not introduced by this phase — CLAUDE.md's regression-test-first rule applies if the plan chooses to fix it. Two honest options for the plan to choose between (flagged as an Open Question below, not decided here): (a) add `CacheService.getScriptCache().remove('gfs')` to all three schedule-CRUD handlers (cheap, ~3 lines, directly adjacent to what D-15 promises), or (b) accept the existing ≤300s staleness as consistent with this codebase's already-accepted "eventually consistent" tolerance elsewhere (e.g. the middleware's own 600s `RECIPES_CACHE_TTL`) and note it in the D-15 UI copy's implicit promise rather than the code.
**Warning signs:** A staff member edits a template's day-offset, immediately reloads the batch-schedule dropdown or the public beer page, and sees the old number for up to 5 minutes.

### Pitfall 4: The middleware doesn't fetch schedules today, and the obvious "just POST it" fix is wrong

**What goes wrong:** Assuming `zoho-middleware/routes/recipes.js`'s existing `callAppsScriptPost()` helper can simply be called with `action: 'get_ferm_schedules'`.
**Why it happens:** `callAppsScriptPost` POSTs to Apps Script's `doPost`, whose `server_token` branch (`apps-script/adminApi.gs:262-329`) is a **hardcoded if-chain** of explicitly allow-listed actions (`add_reservation`, `create_batch`, `create_recipe`, `update_recipe`, `delete_recipe`, `get_recipes`, `get_recipe`, gift-card actions, ...) — `get_ferm_schedules` is **not** in that list. POSTing it today returns `{ok:false, error:'invalid_action', message:'Unknown server action: get_ferm_schedules'}`.
**How to avoid:** Use a GET request instead, reusing the ALREADY-PROVEN pattern at `zoho-middleware/routes/pos.js:3323` (`axios.get(appsScriptUrl, {params: {action:'get_batches', server_token:...}})`). `doGet`'s server-token bypass (`apps-script/adminApi.gs:100-114`, `isServerAuth`) dispatches to `handleReadAction`, whose `case 'get_ferm_schedules'` (`apps-script/adminApi.gs:185-187`) is **already present and already cached** (`_cachedGet('gfs', 300, getFermSchedules)`) — **zero Apps Script code change is needed** for the middleware to start fetching schedules; only a new `axios.get` call in `recipes.js` and (recommended) a new middleware-side Redis cache key.
**Warning signs:** A plan that lists "add `get_ferm_schedules` to `doPost`'s server_token allow-list" as a task is solving a problem that doesn't need solving — flag this as unnecessary Apps Script surface area.

## Code Examples

### Deriving and exposing `ferment_days` in the middleware (D-16)

```javascript
// zoho-middleware/routes/recipes.js — new helper, colocated with callAppsScriptPost
function fetchFermSchedules() {
  return cache.get(C.CACHE_KEYS.FERM_SCHEDULES).then(function (cached) {
    if (cached) return cached;
    var url = process.env.APPS_SCRIPT_URL;
    var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
    if (!url || !token) return Promise.resolve([]);
    // GET, not POST — doPost's server_token allow-list does not include
    // get_ferm_schedules; doGet's bypass already does (adminApi.gs:185-187).
    // Pattern proven at zoho-middleware/routes/pos.js:3323.
    return axios.get(url, {
      params: { action: 'get_ferm_schedules', server_token: token },
      timeout: 12000
    }).then(function (resp) {
      var schedules = (resp.data && resp.data.data && resp.data.data.schedules) || [];
      cache.set(C.CACHE_KEYS.FERM_SCHEDULES, schedules, 300); // match Apps Script's own 'gfs' TTL
      return schedules;
    }).catch(function () { return []; }); // fail-open to "no timeline" (D-09), never fail the whole recipe list
  });
}

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

// Called before toPublicRecipe(), for both list and detail routes
function enrichFermentDays(recipes) {
  var needsSchedule = recipes.some(function (r) { return r.schedule_id; });
  if (!needsSchedule) return Promise.resolve(recipes);
  return fetchFermSchedules().then(function (schedules) {
    var byId = {};
    schedules.forEach(function (s) { byId[s.schedule_id] = s; });
    recipes.forEach(function (r) {
      var sched = r.schedule_id && byId[r.schedule_id];
      var offset = sched ? maxNonPackagingOffset(sched) : null;
      if (typeof offset === 'number' && offset > 0) r.ferment_days = offset;
    });
    return recipes;
  });
}
```
```javascript
// PUBLIC_RECIPE_FIELDS (zoho-middleware/routes/recipes.js:71) — the ONE line D-16 requires:
var PUBLIC_RECIPE_FIELDS = ['recipe_id', 'name', 'style', 'description', 'ferment_days'];
```

### Frontend rendering (D-05/D-06/D-07/D-09) — exact insertion point, verified against the live file

```javascript
// js/modules/07-catalog-kits.js — inside buildRecipeCard(), between the existing
// footer.appendChild(priceCol); and card.appendChild(footer); (verified at line ~230)
footer.appendChild(priceCol); // existing, unchanged

var fermTime = fermentTimeDisplay(recipe);
if (fermTime) {
  var timeCol = d.createElement('div');
  timeCol.className = 'price-col';
  var timeLabel = d.createElement('div');
  timeLabel.className = 'price-label';
  timeLabel.textContent = 'Ready in';
  timeCol.appendChild(timeLabel);
  var timeValue = d.createElement('div');
  timeValue.className = 'price-value ferment-time-value';
  var weeksLine = d.createElement('span');
  weeksLine.className = 'ferment-time-weeks';
  weeksLine.textContent = fermTime.weeks;
  var startLine = d.createElement('span');
  startLine.className = 'ferment-time-start';
  startLine.textContent = fermTime.start;
  timeValue.appendChild(weeksLine);
  timeValue.appendChild(startLine);
  timeCol.appendChild(timeValue);
  footer.appendChild(timeCol);
}

card.appendChild(footer); // existing, unchanged
```

### Apps Script — the `schedule_id` self-migration + persistence (D-03)

```javascript
// apps-script/adminApi.gs — structural copy of ensureRecipesPricingModeColumn (line 3592)
function ensureRecipesScheduleIdColumn(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = headers.indexOf('schedule_id');
  if (idx === -1) {
    sheet.getRange(1, lastCol + 1).setValue('schedule_id').setFontWeight('bold');
    return lastCol;
  }
  return idx;
}
// In updateRecipe (adminApi.gs:3703+): call BEFORE findRowById, same ordering
// rule already documented at the pricing_mode call site (D-08 comment,
// adminApi.gs:3736-3744) — self-migration must run and invalidateSheetCache
// must fire before the row is read, or a stale cached header width causes
// a short-row write.
// Then add 'schedule_id' to the existing stringFields array (adminApi.gs:3763):
var stringFields = ['name', 'style', 'description', 'status', 'notes', 'schedule_id'];
```

## Runtime State Inventory

> This phase is additive (new column, new endpoint field), not a rename/refactor/migration. Included briefly for completeness since it touches a live production sheet.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `Recipes` sheet gains an 18th column (`schedule_id`), self-migrated on first write — no backfill of historical rows needed (they read as `''`, treated as "no schedule" per D-09) | Code edit only (self-migrating); D-10's manual attach of 3 active recipes IS a data-migration task, explicitly in scope |
| Live service config | None — `FermSchedules` templates are staff-editable via the existing admin UI, no external service config involved | None |
| OS-registered state | None | None |
| Secrets/env vars | None — no new env var; the middleware's schedules fetch reuses the existing `APPS_SCRIPT_URL`/`APPS_SCRIPT_SERVER_TOKEN` pair | None |
| Build artifacts | `js/main.js`/`js/main.min.js` must be rebuilt (`npm run build`) after the `07-catalog-kits.js` edit | Rebuild, don't hand-edit |

## Deployment / Verification Reality (staging ≡ prod for this sheet)

**Staging and production share ONE Google Sheet.** Confirmed by `.planning/STATE.md`'s Phase 80 record (`80-06 Task 3`) and by the fact that Apps Script has exactly one deployment URL referenced from both environments' `admin-config.js`/Railway env. This means:

- The `schedule_id` column, once added (self-migrated on first save), exists for BOTH staging and production simultaneously — there is no isolated "staging sheet" to test against.
- D-10's backfill (attaching schedules to the 3 real active recipes) is **not a staging-only test action** — it is a live production data write the moment it happens, regardless of which environment's admin UI performed it. This is consistent with how Phase 80's UAT was run (against the real Waitlist sheet, explicitly confirmed "no UAT leg ever wrote to a real customer row" via disposable probe rows for OTHER data, but the 3 active-recipe backfill here has no disposable equivalent — there are only 3 real recipes, and attaching a schedule to them IS the deliverable, not a test of it).
- **Practical implication for the plan:** treat the D-10 backfill as a real, once-only production action taken carefully (verify the template's day-offsets against the owner's stated ~3-week/~5-week sanity check BEFORE attaching), not as a reversible staging experiment. Rollback is "detach the schedule_id" (trivial, one field edit) if a template turns out to be wrong.
- Apps Script code changes (the self-migrating column, `createRecipe`/`updateRecipe` edits) are similarly a single production release the instant the owner redeploys — but per Pattern 1 above, this specific change is backward-compatible with the currently-live code by design (exactly matching how `pricing_mode` shipped), so there is no destructive-ordering hazard requiring a separate "add column first" step the way Phase 80's Waitlist migration needed one.
- Middleware and frontend changes follow the normal `git push origin main` → Railway auto-deploy → staging verification → blessed `gated-deploy.yml` → production flow documented in `docs/RUNBOOK.md`. No Apps Script involvement in that path once the `schedule_id` column and `get_ferm_schedules`-reachability exist.

## Test Surfaces (extend, do not modify — CLAUDE.md rule 10)

| File | Currently Covers | Extend For |
|------|-------------------|------------|
| `zoho-middleware/__tests__/recipes-public-guard.test.js` | The D-05/D-06/D-07 public-recipe-read contract (status gating, field allowlist) against the CURRENT handlers | Add a case proving `ferment_days` appears in the public projection when present, and that `schedule_id`/step data never do |
| `zoho-middleware/__tests__/recipes.test.js` | GET/POST/PUT `/api/recipes` handler behavior (harness: mocked express/axios/cache/logger/constants) | Add cases for the new schedules-fetch call (mock `axios.get` returning a schedules array) and `enrichFermentDays`/`maxNonPackagingOffset` |
| `tests/frontend/catalog-recipe-block.test.js` | `buildRecipeCard` (lines 63-148 in the test file: field allowlist, DOM order, `.price-footer` structure) via `recipeDisplayPrice`/`buildRecipeCard`/`fetchActiveRecipes`/`renderRecipeBlock` | Add cases for the new `.price-col` appearing when `recipe.ferment_days` is set, and being absent when it isn't (D-09) |
| `tests/frontend/admin-beerxml.test.js` | `parseBeerXML` and the review-modal flow | Add cases for `PRIMARY_AGE`/`SECONDARY_AGE`/`TERTIARY_AGE`/`FERMENTATION_STAGES` extraction and the meta-line's "BeerXML: N days ferment" segment |

No test file currently references `schedule_id`, `ferment_days`, `FermSchedules`, or `maxNonPackagingOffset` (confirmed by grep across `tests/frontend/` and `zoho-middleware/__tests__/`) — all of the above are net-new test cases, not edits to existing ones.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `beer.html` says "it depends on the style, we'll tell you at your consult" | Each recipe card states its own "about N weeks from brew day"; `beer.html` states the ale/lager typical split | This phase | Customers get a concrete, honest expectation before booking instead of after |
| ROADMAP's sketched standalone `ferment_days` column on `Recipes` | `schedule_id` FK to `FermSchedules`, derived figure | Superseded during `/gsd:discuss-phase` on 2026-09-05 (D-03) | Single source of truth — a template edit propagates instead of drifting from a duplicated number |

**Deprecated/outdated:** The ROADMAP's original Phase 81 scope sketch (a standalone `ferment_days` column) is explicitly superseded — do not resurrect it even as a "simpler" fallback if the `FermSchedules` link proves harder than expected. D-03 already weighed and rejected that tradeoff.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | BeerSmith's default fermentation profile is commonly left untouched on export (cited from a homebrewtalk.com forum thread quoting BeerSmith's documented default: 4-day primary + 10-day secondary + 30-day age for 2-stage; 14-day primary + 30-day age for 1-stage) — used only as supporting color for D-13's rationale, not as a load-bearing spec fact | BeerXML Fermentation Timing Semantics | Low — D-13 (no auto-suggestion) is already locked regardless of this claim; if the default numbers are slightly different in practice, the review-step pattern (human confirms) absorbs the discrepancy with zero code impact |
| A2 | `FermSchedules` category enum values are exactly `wine\|beer\|cider\|seltzer` with no other live values in production (cited from `renderScheduleForm`'s hardcoded option list, `js/admin.js:7602-7606` — this IS verified against the code that writes new categories, but not against every historical row that might carry a hand-edited or legacy value) | Pitfall 2 | Low — the recommended "filter, don't hide" approach (show beer-category first, then a divider, then everything else) tolerates any unexpected category value gracefully |

**If this table is empty:** N/A — see above.

## Open Questions

1. **Does `FermSchedules` currently hold a usable `category === 'beer'` row?**
   - What we know: The mechanism exists and is populated with at least one schedule (owner-confirmed per CONTEXT.md). The category enum permits `beer`. No credential in this working copy can read the live sheet.
   - What's unclear: Whether that one-or-more schedule is beer, wine, or blank-category; whether its day-offset ladder matches the owner's ~3-week/~5-week expectation.
   - Recommendation: Run the Pitfall-1 command (or the Apps Script editor's `Logger.log(JSON.stringify(getFermSchedules()))`) before finalizing the plan's D-10 task list. This gates whether "create 2 new templates" or "attach 2-3 existing ones" is the correct task — both are already in-scope per D-10, so this doesn't block starting the plan, only its exact task shape.

2. **Should this phase also fix the pre-existing `'gfs'`/`_invalidateRecipeCache` cache-bust gap (Pitfall 3)?**
   - What we know: `createFermSchedule`/`updateFermSchedule`/`deleteFermSchedule` never bust the Apps Script CacheService `'gfs'` key today, creating a ≤300s staleness window that predates this phase.
   - What's unclear: Whether the owner considers this in-scope "since we're touching this exact code path" or explicitly out-of-scope as a pre-existing, unrelated defect (CLAUDE.md rule 3: "don't touch unrelated code — but do surface it").
   - Recommendation: Surface it as a discretionary, cheap (~3 line) fix the plan MAY include, gated on the D-15 warning text's implicit promise of immediacy — but do not treat it as blocking, since D-15 already says "warn, don't block" and a 5-minute staleness window is consistent with tolerances already accepted elsewhere in this codebase (e.g. the 600s public recipe cache TTL).

3. **Are there draft recipes beyond the 3 active ones that should also get a schedule attached during D-10's pass, even though they won't render publicly yet?**
   - What we know: Only 3 active recipes exist (verified live 2026-09-05 per CONTEXT.md); draft-status recipes are not publicly visible regardless of `ferment_days`.
   - What's unclear: Whether any draft recipes exist, and whether attaching schedules to them now (vs. at their own future activation time) is worth doing proactively.
   - Recommendation: Low priority — D-11's warn-don't-block behavior already handles an active recipe with no schedule gracefully, and a draft recipe's schedule can be attached whenever it's activated. Does not need to be resolved before planning starts.

## Sources

### Primary (HIGH confidence — direct file citation, this repository, this session)
- `apps-script/adminApi.gs` — `doGet`/`doPost` dispatch (lines 68-343), `getFermSchedules` (1784), `sheetToObjects`/`findRowById` (1439, 1489), `ensureRecipesPricingModeColumn`/`createRecipe`/`updateRecipe` (3592-3830), `createFermSchedule`/`updateFermSchedule`/`deleteFermSchedule` (3140-3372), `_invalidateBatchCache`/`_invalidateRecipeCache`/`_cachedGet` (3415-3506), `ensureWaitlistSheet` (4874), `setupRecipeTabs` (4064)
- `zoho-middleware/routes/recipes.js` — full file read; `callAppsScriptPost`, `PUBLIC_RECIPE_FIELDS`/`toPublicRecipe` (71-91), all 6 route handlers (305-703), `enrichListPrices`/`enrichWithComputedPrice` (158-230)
- `zoho-middleware/routes/pos.js` — `ADMIN_PROXY_ACTIONS`/`ADMIN_PROXY_READS` (3982-4033), the proven `axios.get` + `server_token` GET pattern (3323)
- `zoho-middleware/lib/constants.js` — full `CACHE_KEYS` enumeration (15-83)
- `js/admin.js` — `renderScheduleTemplates`/`renderScheduleForm` (7500-7620), `parseBeerXML` (9303-9400+), `showBeerXMLReviewModal`/`confirmBeerXMLImport` (9498-9730), `openRecipeDetail`/`populateRecipeForm`/`saveRecipe` (8713-9130), `triggerBatchLoad`/`initTabNavigation` batch hook (8475-8503), `triggerRecipesLoad`/`initRecipesTab` (8541-8563), `adminApiPost` (709-730), `fermSchedulesData`/`loadBatchInit`/`loadScheduleTemplates` (5591-5680)
- `js/modules/07-catalog-kits.js` — `buildRecipeCard` full body (181-238)
- `js/modules/04-label-cards.js` — `buildLabelPriceFooter` full body (104-159)
- `admin.html` — recipe editor form group (500-522)
- `docs/RUNBOOK.md` — full read; confirms Apps Script deploys are outside `gated-deploy.yml`'s scope entirely
- `.planning/STATE.md` — Phase 80/76 deploy history, staging↔prod shared-sheet confirmation
- `.planning/phases/80-.../80-CUTOVER.md` — the "add columns first" Waitlist precedent and its rationale (D-18, §2/§3 sequencing, rollback-version recording practice)
- `zoho-middleware/.env` (checked, not quoted) — confirmed zero `APPS_SCRIPT_*` entries present in this working copy

### Secondary (MEDIUM confidence — official spec fetched via WebFetch, paraphrased by an intermediate model, not directly viewed as raw text)
- `https://beerxml.com/beerxml.htm` — RECIPE RECORD field definitions for `PRIMARY_AGE`/`SECONDARY_AGE`/`TERTIARY_AGE`/`FERMENTATION_STAGES`/`AGE`/`AGE_TEMP`, confirming: primary/secondary/tertiary are "time spent in [vessel] in days" (additive, gated by `FERMENTATION_STAGES`'s 1-3 count), while `AGE` is explicitly "the time to age the beer in days after bottling" — i.e. post-packaging, confirming CONTEXT.md's D-01/D-02 assumption was correct

### Tertiary (LOW confidence — community/forum, used only as supporting color, not as a locked fact)
- `homebrewtalk.com` thread quoting BeerSmith's documented default fermentation profile (4d primary + 10d secondary + 30d age for 2-stage; 14d primary + 30d age for 1-stage) — supports but does not prove D-13's "often left at the exporting software's untouched default" rationale

## Metadata

**Confidence breakdown:**
- Standard stack: N/A — no new libraries
- Architecture: HIGH — every file:line citation above was read directly in this session, not recalled from training data
- FermSchedules live content (beer category presence): UNVERIFIABLE from this session — disclosed honestly, not guessed at; see Open Question 1
- BeerXML field semantics: MEDIUM-HIGH — sourced from the official spec page via WebFetch, cross-checked against the actual `parseBeerXML` code's existing field list (`EST_ABV`, `BATCH_SIZE`, etc., which already match BeerXML 1.0 naming exactly, giving confidence the spec fetched is the right version)
- Pitfalls: HIGH — all four newly-surfaced pitfalls (lazy-load gap, BeerXML-modal schedule-selection drop, cache-bust gap, doPost-vs-doGet allow-list) are demonstrated by direct code reading, not inference

**Research date:** 2026-09-05
**Valid until:** 30 days (stable, internal codebase — the only fast-moving unknown, live `FermSchedules` content, is resolved by a one-line command the owner can re-run at any time, not by research re-currency)
