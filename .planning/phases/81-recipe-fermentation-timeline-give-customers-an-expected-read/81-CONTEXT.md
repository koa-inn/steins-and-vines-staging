# Phase 81: Recipe fermentation timeline — give customers an expected ready date - Context

**Gathered:** 2026-09-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Every public beer recipe answers *"when do I get my beer?"* on the recipe card and on
`beer.html`, instead of deflecting to "it depends on the style, we'll tell you at your consult".

**The central discovery of this discussion:** the number already exists in the system. The
`FermSchedules` sheet holds reusable fermentation schedule templates whose steps each carry a
`day_offset`, and every template ends with a step flagged `is_packaging` that deliberately has
**no** date ("always last, date TBD until all other steps are done") because the packaging session
is booked with the customer. The last non-packaging `day_offset` **is** days-to-ready-to-package.

So this phase does **not** add a new fermentation-time number. It **links recipes to the schedule
templates staff already maintain**, derives the customer-facing figure from that link, and renders
it. This is a deliberate departure from the ROADMAP scope sketch, which proposed a standalone
`ferment_days` column — see D-03.

**In scope:** a `schedule_id` column on `Recipes`; a schedule picker in the recipe editor and in the
BeerXML review modal; `parseBeerXML` reading the timing fields for display only; a derived
`ferment_days` in the public API projection; a "Ready in" column on the recipe card; rewritten
`beer.html` timeline copy; pre-selecting the recipe's schedule at batch creation; creating beer
schedule templates if none suitable exist; attaching schedules to the 3 active recipes.

**Out of scope:** hop timing, mash steps, hop-unit normalization (Phase 66); stage-by-stage
fermentation data on the recipe; any change to `schedule_snapshot` / live batch behaviour;
computing or displaying an expected packaging *date* on a batch.

</domain>

<decisions>
## Implementation Decisions

### What the number means

- **D-01:** The figure counts to **ready to package** — the date the customer comes in to can or
  bottle. That is the concrete, bookable event and the moment they physically take beer home.
  Conditioning after packaging is explicitly not counted and not promised.
- **D-02:** ~~Store one total in days on the Recipes sheet, excluding `AGE`.~~ **SUPERSEDED by
  D-03.** Recorded because it shows the reasoning that led there: the discussion first settled on a
  single total (deliberately excluding BeerXML's `AGE`, which is post-packaging conditioning and
  therefore after our handoff), and only then found that `FermSchedules` already encodes exactly
  that total.
- **D-03:** **The recipe carries a `schedule_id` pointing at a `FermSchedules` template. The
  customer-facing figure is derived as the largest `day_offset` among that template's
  non-packaging steps.** No `ferment_days` column on `Recipes`. Rationale: a separate number would
  be a second copy of a value staff already maintain, and the two drift the first time someone tunes
  a template. Single source of truth.
  - *Decision history:* the ROADMAP scope sketch proposed a standalone `ferment_days` column and
    the discussion initially followed it. The owner redirected — "there is already a concept of
    batch schedules, this should actually be connected to that" — and that reframing is correct and
    now locked.
- **D-04:** **Batch creation and activation pre-select the recipe's schedule template** in the
  existing `#batch-schedule-select` / `#sa-schedule-select` dropdowns. It is a default value in a
  control that already exists; staff can still change it. The recipe→schedule link therefore does
  real internal work, not just decorative display.

### Wording and placement

- **D-05:** Days round to the **nearest week** and render as **"about N weeks"**. Day 24 reads
  "about 3 weeks"; day 26 reads "about 4 weeks". The vagueness is honest — fermentation does not
  hit a day — and it matches how staff say it out loud. Never an exact date.
- **D-06:** **The phrase itself names the start point** — e.g. "about 3 weeks from brew day" / "in
  the tank". Beer is booked ahead off a waitlist, so a bare "ready in about 3 weeks" would be read
  as three weeks from today. Carrying the start point in the phrase means the card cannot be
  misread standalone, screenshotted, or shared out of context.
- **D-07:** On the recipe card the figure is a **second label/value column in the existing
  `.price-footer`**, reusing the `.price-col` idiom: "Ready in" over "about 3 weeks from brew day",
  beside "Ferment in store" over the price. Price and time — the two questions a customer has — sit
  together. `buildRecipeCard` is `createElement`-only (T-74-12); the new column must stay that way.
- **D-08:** **Both** `beer.html` timeline passages are rewritten: How It Works (`beer.html:179`) and
  the FAQ "How long until it's ready?" (`beer.html:318`). Both currently say the timeline comes at
  the consult. Leaving that on a page whose cards now state weeks makes the page contradict itself.
  New copy: typical ales ~3 weeks / lagers ~5, each recipe shows its own on its card, and the exact
  packaging date is booked with the customer.
  - *Note:* this does not conflict with Phase 80 D-14, which froze the **queue-order** copy
    ("we work through the list in order"). Different sentences, different subject.

### Missing values and backfill

- **D-09:** A recipe with no schedule attached (or whose template yields no usable non-packaging
  offset) **omits the "Ready in" footer column entirely**. Nothing looks broken, nothing is
  promised. This is how the card already treats a missing style or description.
- **D-10:** The 3 active recipes get their schedule **attached by hand** in the recipe editor.
  **Creating suitable beer templates (an ale and a lager) in `FermSchedules` is IN SCOPE** if none
  exist or only a generic one does. **Release gate: all 3 active recipes render a timeline on the
  day this ships** — otherwise the phase delivers an empty feature.
- **D-11:** The recipe editor **warns but does not block** when an `active` recipe has no schedule
  ("this recipe won't show a timeline"). No new way for a save to fail on a form staff use under
  time pressure, and D-09 keeps the page correct either way.

### Import trust and correction

- **D-12:** `parseBeerXML` reads `PRIMARY_AGE`, `SECONDARY_AGE`, `TERTIARY_AGE` and surfaces the
  total in the review modal's meta line (e.g. "Czech Lager · 5.2% · 30 L · BeerXML: 35 days
  ferment"). **The import informs; it never decides.** A **schedule-template dropdown is added to
  the review modal** so staff choose with the source number visible. This is the D-09 review-table
  pattern applied to a recipe-level field.
- **D-13:** **No auto-suggestion.** The dropdown does not pre-select the nearest-matching template.
  Pre-selecting from a value that is frequently the exporting software's untouched default is how a
  wrong timeline gets confirmed by reflex.
- **D-14:** When a template is chosen, the modal **shows both figures side by side** —
  "BeerXML: 35 days · Template: 21 days" — with **no warning threshold and no judgement**. The
  disagreement is visible; a human decides what it means. A threshold would imply the BeerXML value
  is authoritative, which is exactly what the review step exists to deny, and would cry wolf on
  every file carrying a default.
- **D-15:** The schedule-template editor **notes its blast radius** — "Used by N public recipes;
  changing day offsets will change what customers are told." Live batches are already safe (they
  hold a frozen `schedule_snapshot`), but public marketing copy is not. Warn before the save, same
  shape as D-11. Does not block.

### Public API shape

- **D-16:** `GET /api/recipes` exposes **one derived integer, `ferment_days`**, added to
  `PUBLIC_RECIPE_FIELDS`. The middleware resolves the template server-side. `schedule_id`, step
  titles, transfer flags and template names **never** appear in a public response — no internal
  process detail leaves the building. The frontend owns the "about N weeks from brew day" phrasing,
  so a copy tweak is an HTML edit, not a Railway deploy.
  - This is a conscious, minimal amendment to **Phase 74 D-07** (public card = name, style, price,
    description and nothing else). `ferment_days` is not margin-derivable, so the rule's purpose is
    intact.

### Claude's Discretion

- Exact column name for the recipe's schedule reference (`schedule_id` assumed, matching `Batches`).
- Exact CSS/markup for the second `.price-col`, and its behaviour at narrow widths.
- Precise final wording of the rewritten `beer.html` passages, within D-06 and D-08.
- Where the schedule picker sits in the recipe editor form (`admin.html:508-521` holds the
  Batch Size / ABV / IBU / Colour group).
- Rounding implementation detail (e.g. `Math.round(days / 7)`), and the floor below which a value
  is treated as unusable for D-09.
- How the template's usable offset is computed when steps are stored out of order — take the max,
  do not assume array order.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and prior locked decisions
- `.planning/ROADMAP.md` § "Phase 81" (~line 1321) — goal, the Phase 66 scope split, the three open
  decisions this discussion closed, and the three known constraints. **Note:** its "Storage — one
  new column on the Recipes sheet" scope sketch is superseded by D-03.
- `.planning/ROADMAP.md` line 142 § "Phase 66: Recipe Data Quality" — the sibling phase. Hop
  timing, mash steps and hop-unit normalization stay there; its criterion 1 was amended to exclude
  fermentation time.
- `.planning/phases/74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split/74-CONTEXT.md`
  — D-05/D-06/D-07 (public recipe exposure: active-only, endpoint-enforced, four-field allowlist),
  D-11 (`beer.html` section order), D-12 (recipe cards carry the waitlist CTA, not add-to-cart).
  **D-07 is amended by D-16 above.**
- `.planning/phases/80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c/80-CONTEXT.md`
  — D-14 (`beer.html` queue-order copy frozen; a different sentence to the ones D-08 rewrites).
- `.planning/REQUIREMENTS.md` line 122 — OPS-05. This phase closes the fermentation-time slice only.

### Deploy constraint
- `.planning/STATE.md` — Apps Script has no CI deploy path and **one deployment serves staging AND
  production**. Adding the `Recipes` column is a production release for that layer.
  **Add the column FIRST, redeploy SECOND** (Phase 80 lesson). Deploying first takes the live path
  down until the column exists.
- `docs/RUNBOOK.md` — deploy sequence and rollback.

### Tracking / CSP
- `docs/TRACKING.md` — required reading before touching any public HTML page's CSP meta tag. This
  phase adds no third-party service, so no CSP change is expected; confirm rather than assume.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`FermSchedules` sheet + `getFermSchedules()`** (`apps-script/adminApi.gs:1784`) — templates with
  `schedule_id, name, description, category (wine|beer|cider|seltzer), steps (JSON), is_active`.
  `steps_parsed` is already returned. **This is the source of the number** (D-03).
- **Schedule step shape** — `{ step_number, day_offset, title, description, is_transfer }`, plus a
  final `{ is_packaging: true }` step with no offset. The packaging step must be excluded from the
  max-offset calculation; the UI already calls it "always last, date TBD".
- **`ensureRecipesPricingModeColumn`** (`apps-script/adminApi.gs:3592`) — the safe-append precedent
  for adding a column to `Recipes`. Old code maps by header name and ignores unknown columns; rows
  predating the column read as `''`.
- **`renderScheduleForm`** (`js/admin.js:7576`) — the template editor. D-15's blast-radius note goes
  here. Also where new ale/lager templates (D-10) get created.
- **`buildRecipeCard`** (`js/modules/07-catalog-kits.js:181`) — card builder. The `.price-footer` /
  `.price-col` label+value idiom at the end is what D-07 extends.
- **`toPublicRecipe` / `PUBLIC_RECIPE_FIELDS`** (`zoho-middleware/routes/recipes.js:71`) —
  build-by-allowlist: a public recipe is a NEW object copying only allowlisted fields, so a new
  source field stays invisible until explicitly listed (T-74-04). `ferment_days` must be added
  deliberately (D-16).
- **`showBeerXMLReviewModal`** (`js/admin.js:9500`) — the review modal. Its `metaLine` (style · ABV ·
  L) is currently read-only and recipe-level fields have no correction affordance; D-12 adds the
  BeerXML total there and D-12/D-13 add the template dropdown.
- **`parseBeerXML`** (`js/admin.js:9307`) — reads name, style, `EST_ABV`, `BATCH_SIZE`, IBU,
  `EST_COLOR` and drops all timing. D-12 adds the age fields (display only).
- **Batch schedule dropdowns** — `#batch-schedule-select` (`js/admin.js:6997`) and
  `#sa-schedule-select` (`js/admin.js:7347`), both already populated from `fermSchedulesData`.
  D-04 only changes their default selection.

### Established Patterns

- **Build-by-allowlist for public data** (T-74-04) — never delete-from-source.
- **`createElement`-only card bodies** (T-74-12) — `buildRecipeCard` must stay free of `innerHTML`;
  the mitigation evidence is a grep. The new footer column must follow.
- **Import review as the control** (Phase 15 D-08/D-09) — heuristics may inform, a human confirms.
  D-12/D-13/D-14 are this pattern applied at recipe level.
- **Warn, don't block** — D-11 and D-15 both take this shape deliberately.
- **`schedule_snapshot` freezing** (`apps-script/adminApi.gs:2232`) — a batch copies the template's
  steps at activation, so template edits never disturb live batches. This is what makes D-03 safe
  and is precisely why D-15's warning is about *public copy*, not about batches.
- **Numbered modules** — `js/modules/07-catalog-kits.js` is a source module; `js/main.js` and
  `js/main.min.js` are build artifacts. Run `npm run build` after any module change.

### Integration Points

- `Recipes` sheet — new `schedule_id` column, safe-appended (18th column).
- `createRecipe` / `updateRecipe` (`apps-script/adminApi.gs:3607`, `:3730`) — persist it.
- `admin.html:508-521` + `js/admin.js:8776-8779` / `:9079-9082` — recipe editor form group and its
  load/save pair; the schedule picker joins them.
- `zoho-middleware/routes/recipes.js` — derive `ferment_days`, extend the allowlist, and bust the
  recipe cache keys (`invalidate` helper at the top of the file).
- `js/modules/07-catalog-kits.js` — the card footer.
- `beer.html:179`, `beer.html:318` — the two copy passages.

### Open questions for research

1. **Does `FermSchedules` currently hold usable beer templates?** The category enum includes `beer`,
   but the sheet's contents need staff/admin auth to read and were not verifiable during discussion.
   D-10 makes creating them in-scope if not. **This gates whether the phase can ship anything
   visible** — resolve it first.
2. Whether any **draft** recipes exist beyond the 3 active ones (only the public endpoint was
   readable). Affects backfill size, not design.
3. Whether `sheetToObjects` header-mapping tolerates the 18th column everywhere `Recipes` is read
   (the `pricing_mode` precedent says yes; confirm rather than assume).

</code_context>

<specifics>
## Specific Ideas

- Owner's own figures, from the source direction: **"ales will be ~3 weeks and lagers ~5 weeks"**.
  These are the sanity check for whatever the templates produce — if a beer template yields a
  wildly different number, the template is wrong, not the display.
- Production has exactly **3 active recipes** (verified live during discussion, 2026-09-05):
  `SV-R-000011` West Coast IPA, `SV-R-000003` Hazy Pale Ale, `SV-R-000002` Czech Lager. Two ales and
  a lager — the owner's split exactly. This is the whole backfill.
- Card footer target reading: "Ferment in store / $X" beside "Ready in / about 3 weeks from brew day".
  *(Corrected 2026-09-05 during `/gsd:ui-phase`: earlier drafts of D-07 and this line used "~3 weeks"
  as shorthand, which contradicted D-05's locked "about N weeks". D-05 is the wording the owner
  actually selected and governs. The card and `beer.html` now use the same word.)*
- The FAQ answer being replaced reads, in full: *"It depends on the style. We'll give you a timeline
  at your consult."* The How It Works line reads: *"We look after your batch while it ferments — how
  long depends on the style, and we'll give you a timeline at your consult."*

</specifics>

<deferred>
## Deferred Ideas

- **Auto-fill a computed expected-packaging date on the batch.** Considered and declined for this
  phase (it was the third option under D-04). Now cheap to add later, since D-03/D-04 establish the
  recipe→schedule link and batch activation already computes step dates. A natural follow-up.
- **Per-recipe timeline override.** Considered under D-03 (option 2) and declined — a recipe whose
  timeline genuinely differs from its template should get its own template rather than a field that
  silently outranks one. Revisit only if forking templates turns out to be routine.
- **Stage-by-stage fermentation data on the recipe** (primary/secondary/tertiary kept separate) —
  Phase 66 territory, along with hop timing and mash steps.
- **BeerXML `AGE` / post-packaging conditioning as a second customer-facing number** ("best after
  another 2 weeks") — declined under D-01 as it is after our handoff and unverifiable.
- **A `category` field on recipes.** Phase 74 already logged this as a LOCKED future decision: if a
  wine recipe is ever created it needs an explicit category field, never a style-keyword heuristic
  (`js/modules/07-catalog-kits.js:245`). Unchanged by this phase, but D-10's template categories
  brush against it.

### Reviewed Todos (not folded)

15 pending todos were cross-referenced; none fall in this phase's scope. All matched at the
keyword-noise baseline (score 0.6) — the closest, `beer-cider-launch-pages.md`, describes work
already shipped. Nothing folded, nothing lost.

</deferred>

---

*Phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read*
*Context gathered: 2026-09-05*
