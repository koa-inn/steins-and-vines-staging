# Phase 79: Apps Script recipe-save performance — Context

**Gathered:** 2026-09-02
**Status:** Ready for planning
**Source:** Investigation note (`.planning/notes/recipe-save-performance-and-sheets-scaling.md`) + owner decisions 2026-09-02

<domain>
## Phase Boundary

Make `updateRecipe` in `apps-script/adminApi.gs` complete well inside the middleware's 15s
Apps Script timeout, so recipes can be saved at all.

**Current state (production blocker):** `PUT /api/recipes/:id` returns 502 for every save,
including a pure rename. Two independent saves of `SV-R-000002` were measured in-browser at
**15287 ms** and **15313 ms** against `timeout: 15000` (`zoho-middleware/routes/recipes.js:37`).
Payload is 4.7 KB / 13 ingredients — size is not the cause.

**In scope:** the round-trip count inside `updateRecipe`, ingredient-ID stability on that same
write path, and the script-lock budget that shares the same 15s ceiling as the middleware.

**Out of scope:** the Sheets→Postgres migration (deferred 2026-09-02; separate research in
flight), density / cross-family unit conversion (considered and rejected 2026-09-02), and
raising the middleware timeout.

</domain>

<decisions>
## Implementation Decisions

### Root cause and non-negotiable constraint

- **D-01:** The failure is **N+1 Sheets round-trips**, not data volume. `updateRecipe` performs
  **~54 round-trips** for a 13-ingredient recipe and would be equally slow on an empty sheet.
  Fix the round-trip count.
- **D-02:** **Do NOT raise the middleware's 15s timeout.** That hides a fragile write. The
  target is ~54 round-trips → **~5**.
- **D-03:** A save currently rewrites the whole ingredient list whenever
  `payload.ingredients !== undefined`, and `buildRecipePayload` (`js/brewpad.js:775`) **always**
  sends it — which is why renaming a recipe deletes and recreates all 13 ingredient rows.

### The five fixes, ordered by value-per-risk (all in `updateRecipe`)

- **D-04:** **(1) Skip the ingredient rewrite entirely when the incoming ingredients match the
  stored rows.** Compare incoming `(item_id, quantity, unit)` tuples against existing rows; if
  identical, skip the delete+insert. This is the single biggest win for the reported symptom —
  it makes a rename near-free.
- **D-05:** **(2) Hoist `generateNextId` out of the insert loop.** It currently reads an entire
  column on every call (`adminApi.gs:1241`), once per ingredient — 13 full column scans per save.
  Compute the max once, then increment in memory.
- **D-06:** **(3) Batch the inserts** — one `getRange(start, 1, n, 6).setValues(rows)` instead of
  13 `appendRow()` calls.
- **D-07:** **(4) Batch the deletes** — collapse consecutive rows into `deleteRows(start, count)`.
  Recipe ingredient rows are appended together so they are usually contiguous; this typically
  collapses to a single call.
- **D-08:** **(5) Batch the recipe-row field writes.** ~14 individual `setValue` calls become one
  read + one `setValues()`. **Ordering constraint:** call `ensureRecipesPricingModeColumn`
  (`adminApi.gs:3472`) *first* — it may append a column — then read the row once, mutate in
  memory, write once.

### Owner decisions taken 2026-09-02

- **D-09 (ingredient ID stability — IN SCOPE):** The payload sends `ingredient_id`
  (e.g. `RI-000171`) but `updateRecipe` discards it and mints a fresh ID on every save, so
  **nothing can hold a durable reference to a recipe ingredient**. Honour the incoming
  `ingredient_id` when present; mint new IDs only for genuinely new rows. Folded into this
  phase because D-04 already requires comparing incoming rows against stored ones — same code
  path, and deferring means touching `updateRecipe` twice and paying for a second owner redeploy.
- **D-10 (script-lock budget — RETUNE):** `acquireScriptLock(15000)` (`adminApi.gs:1235`) waits up
  to 15s for a **global** script lock — the exact same budget as the middleware timeout — so under
  contention the middleware gives up at the moment the lock might be granted. Retune so the lock
  wait is meaningfully shorter than the middleware's 15s ceiling, and so a lock-wait failure
  surfaces as a **distinguishable, fast error** rather than masquerading as the timeout just fixed.
  There are **12 `acquireScriptLock` call sites** (9 at `15000`, 2 at `10000`, plus the `10000`
  default) — decide deliberately whether this is a `updateRecipe`-local change or a helper-level
  one, and state the blast radius either way.

### Deployment and verification model

- **D-11:** `apps-script/adminApi.gs` is vendored in this repo but **executes in Google's
  environment**. It cannot be verified locally and **requires a manual owner redeploy**. Plan for
  a **live probe after deploy**, not test-suite proof. Include an explicit owner-redeploy
  checkpoint task (`[autonomous:false]`), following the Phase 76-01 pattern.
- **D-12:** Read the Railway log line `[api/recipes] PUT SV-R-000002 failed: <message>` to confirm
  the timeout diagnosis before/alongside the fix — it has not been read yet and is the one piece
  of direct confirmation still missing.
- **D-13:** Success criterion is behavioural: open any recipe in BrewPad, click **Save Recipe**,
  and the PUT completes well inside 15s and returns 200 — including a pure rename, which was the
  originally reported symptom ("remove 30L from the West Coast IPA name").

### Guardrails

- **D-14:** Do **not** weaken the Phase 73 unit-conversion fail-closed guard in
  `recipe-scaling.js`. It refuses to guess a density and that behaviour prevented a ~20x
  overcharge.
- **D-15:** `RecipeIngredients` column order is
  `ingredient_id | recipe_id | item_id | item_name | quantity | unit` — required for any batched
  `setValues()` write.

### Claude's Discretion

- Whether to *also* stop `buildRecipePayload` (`js/brewpad.js:775`) from unconditionally sending
  the ingredient list. The server-side skip (D-04) makes it unnecessary, but it is a cheap
  belt-and-braces that reduces payload size. If taken, it is a frontend change and requires
  `npm run build` + a `brewpad.min.js` rebuild per CLAUDE.md rule 9.
- How to structure the comparison in D-04 (normalisation of numeric/string types coming back from
  Sheets vs. JSON) — the comparison must not produce false "changed" verdicts from type coercion,
  or the optimisation silently never fires.
- Whether `generateNextId`'s full-column scan is worth fixing at the helper level (it is also used
  elsewhere and degrades forever as rows accumulate) or only hoisted locally for this call path.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The investigation
- `.planning/notes/recipe-save-performance-and-sheets-scaling.md` — full diagnosis, captured
  evidence (timings, payload, round-trip accounting), the ordered fix plan, and the
  Sheets→Postgres assessment. **This is the primary source for this phase.**

### Code under change
- `apps-script/adminApi.gs` — `updateRecipe` (line 3583), `generateNextId` (1241),
  `acquireScriptLock` (1235), `findRowById` (1369), `ensureRecipesPricingModeColumn` (3472)
- `zoho-middleware/routes/recipes.js` — `callAppsScriptPost`, `timeout: 15000` (line 37)
- `js/brewpad.js` — `buildRecipePayload` (line 775), save path (line 3002)

### Prior art for the deploy pattern
- `.planning/phases/76-brewpad-session-expiry-hardening-decouple-the-durable-7-day-/76-01-PLAN.md`
  — the Apps-Script owner-redeploy checkpoint + live-probe pattern to reuse

### Project rules
- `CLAUDE.md` — regression-test-first on bug fixes (rule 3), one logical change per commit
  (rule 4), never edit build artifacts (rule 8), rebuild after JS module changes (rule 9),
  Apps Script needs manual redeploy

</canonical_refs>

<specifics>
## Specific Ideas

**Round-trip accounting for one save of a 13-ingredient recipe (measured, not estimated):**

| Operation | Count |
|---|---|
| `getRange().setValue()` — one per field, 12 fields + pricing_mode + updated_at | ~14 |
| `getDataRange().getValues()` on RecipeIngredients | 1 |
| `deleteRow()` — one per ingredient | 13 |
| `generateNextId()` — **full column scan per ingredient** | 13 |
| `appendRow()` — one per ingredient | 13 |
| **Total** | **≈54** |

At Apps Script's typical 100–500 ms per Sheets operation that is 5–25 s. Observed: >15 s.

**Reproduction:** open any recipe in BrewPad, click **Save Recipe** without changing anything,
watch the Network tab — the PUT takes ~15.3 s and returns 502.

**Verification caveat:** Cloudflare 403s `curl` against `steinsandvines.ca` and
`staging.steinsandvines.ca`. CLI probes of front-end assets return misleading results — verify
in a real browser. (The middleware host `svmiddleware-*.up.railway.app` *is* curl-able.)

</specifics>

<deferred>
## Deferred Ideas

- **Sheets → Postgres migration.** Assessed 2026-09-02 and deferred: this timeout is caused by
  round-trip count, not data volume, and the same N+1 patterns would likely be carried into any
  new store. The genuine long-term drivers are the global script lock, absence of transactions,
  and unindexed scans — not row counts. Deeper research is in flight separately; revisit after
  this phase's measurements.
- **Density / cross-family unit conversion (`L`↔`kg`).** Considered and rejected 2026-09-02 —
  creates a permanent data-integrity obligation (a density per liquid, sourced from SDS sheets,
  that silently mis-prices if stale). Owner decision: stay weight-only. Revisit only if items
  genuinely sold by volume start being stocked.
- **Raising the middleware timeout.** Explicitly rejected — hides a fragile write.

</deferred>

---

*Phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a*
*Context gathered: 2026-09-02 from investigation note + owner decisions*
