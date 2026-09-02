---
phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a
verified: 2026-09-02T16:14:29Z
status: passed
score: 8/8 must-haves verified
overrides_applied: 0
---

# Phase 79: Apps Script recipe-save performance Verification Report

**Phase Goal:** Make recipe saves complete well inside the middleware's 15s Apps Script timeout. `updateRecipe` in `apps-script/adminApi.gs` performed ~54 Sheets round-trips for a 13-ingredient recipe and reliably exceeded the ceiling, so `PUT /api/recipes/:id` returned 502 and no recipe could be saved at all. Target: ~54 round-trips → ~5.

**Verified:** 2026-09-02T16:14:29Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Round-trip reduction is real (~54 → ~5-6) | ✓ VERIFIED | Read `updateRecipe` (`apps-script/adminApi.gs:3686-3969`) directly. Unchanged-ingredients path: `ensureRecipesPricingModeColumn` header read (1) + `findRowById` full read (1) + row-values read (1) + `getFormulas()` read (1) + one batched row `setValues()` (1) + one `RecipeIngredients.getDataRange().getValues()` (1) = **6 real Sheets I/O calls**, matches SUMMARY's own disclosed 6-7 count. Changed-ingredients path adds 1-2 `deleteRows()` + 1 `setValues()` insert (+ occasional `insertRowsAfter()`) = **9-11**. Grepped the full `updateRecipe` body (`awk 'NR==3686,NR==3969'`) for `setValue(`, `appendRow(`, `.deleteRow(`, `generateNextId(` — the only per-row loop remaining is the formula-safety fallback (capped at ~14 calls, only triggers if a formula is detected in the span, same cost as the old code, not a new N+1). No stray per-ingredient loop was missed. |
| 2 | D-04 fails safe (every ambiguity resolves to "changed") | ✓ VERIFIED | Read `normalizeRecipeIngredientTuple` and `recipeIngredientsUnchanged` (`adminApi.gs:1264-1366`) directly. No case-folding of `item_id`/`unit`. Non-finite quantity produces sentinel `'!nonfinite'`, and `recipeIngredientsUnchanged` explicitly forces `false` if **either side** carries that sentinel — even two identical `!nonfinite` sentinels never match (`adminApi.gs` comparison loop: `if (a[i].indexOf('!nonfinite') !== -1 \|\| b[i].indexOf('!nonfinite') !== -1) return false;`). Comparison is order-sensitive and length-sensitive (direct index equality, no sorting/matching by identity) — a reordered or resized list is "changed". Quantity keys round to 9 decimals only to absorb float drift (0.1+0.2), not to blur real differences. 38 Jest tests in `tests/frontend/adminapi-recipe-pure.test.js` exercise both the silent-edit-loss direction and the dead-optimisation direction; all pass against the file's real source. Sheets type coercion (number vs string) is mirrored explicitly: `Number(rawQty)` on both sides normalizes numeric-vs-string mismatches without breaking real differences. |
| 3 | D-09 id-honouring is correctly bounded | ✓ VERIFIED | Read the D-09 block (`adminApi.gs:3889-3907`). `storedIdSet` is built only from `RecipeIngredients` rows where `ridCol === payload.recipe_id` (recipe-scoped), so a foreign recipe's id is never in the set. An incoming id is honoured only if `storedIdSet[id]` is true AND `!claimedIds[id]` (not already used by an earlier row in the same payload); otherwise a fresh id is minted and immediately added to `claimedIds`. Duplicate `item_id` values (confirmed live: three `RecipeIngredients` rows on SV-R-000002 share `item_id 109900000000621293`) cannot cause mis-assignment because the id-honouring logic keys on `ingredient_id`, not `item_id` — duplication of `item_id` is irrelevant to this code path. Production Probe B (79-04-SUMMARY) independently confirms this: all 13 `RI-000171`..`RI-000183` ids and all `item_id` values (including the triplicate) survived multiple real saves unchanged. |
| 4a | Safeguard: `insertRowsAfter` before the batched insert | ✓ VERIFIED | `adminApi.gs:3938-3944`: computes `needed = (startRow + rows.length - 1) - ingSheet.getMaxRows()`, calls `ingSheet.insertRowsAfter(ingSheet.getMaxRows(), needed)` when `needed > 0`, before `getRange(startRow, 1, rows.length, 6).setValues(rows)`. Comment explicitly documents the `getRange()`-beyond-`getMaxRows()`-throws risk this guards against. |
| 4b | Safeguard: `getFormulas()` check with per-cell fallback | ✓ VERIFIED | `adminApi.gs:3796-3809`: reads `getFormulas()` for the exact `[minCol,maxCol]` span before writing; if any cell in that span holds a formula, falls back to a per-cell `setValue()` loop (`rowWriteMode = 'per_cell'`) instead of the batched `setValues()` (`rowWriteMode = 'batched'`). This correctly prevents a ranged `setValues()` from flattening a formula in an unmutated cell. |
| 5 | D-08 ordering (pricing-mode column ensured before row read, unconditionally) | ✓ VERIFIED | `adminApi.gs:3725-3728`: `ensureRecipesPricingModeColumn(recipesSheet)` runs immediately after the sheet is fetched, followed by `invalidateSheetCache(RECIPES_SHEET_NAME)`, and only then `findRowById(...)`. Not wrapped in any `if` — confirmed by direct read of the surrounding code (no conditional branch around this call). |
| 6a | Negative guardrail: middleware timeout unchanged (D-02) | ✓ VERIFIED | `grep -n "timeout: 15000" zoho-middleware/routes/recipes.js` → line 37, present. `git log --oneline -- zoho-middleware/routes/recipes.js` shows no phase-79 commit touched this file (last touch was `5ac9c026`, an unrelated pre-phase-79 fix). |
| 6b | Negative guardrail: `recipe-scaling.js` untouched (D-14) | ✓ VERIFIED | `git log --oneline -- js/lib/recipe-scaling.js` shows zero commits from this phase's session (`84e9dbde`, `9e8ffc77`, `1a9378f6`, `2ec965ff` do not appear). |
| 6c | Negative guardrail: `generateNextId(` file-wide count exactly 13 | ✓ VERIFIED | `grep -c "generateNextId(" apps-script/adminApi.gs` → **13** (1 definition + 12 remaining call sites; `updateRecipe`'s own call site removed, no other call site touched). |
| 7 | Evidence honesty (no overstatement of live-probe certainty) | ✓ VERIFIED | `79-04-SUMMARY.md` and `.planning/ROADMAP.md` (Phase 79 section, lines 1236-1244) both explicitly state: Probe A is "qualitative only... no millisecond figure was captured", Probe D "was NOT run... the D-04 skip is inferred... not directly observed", and the new deployment's version number is "not recorded — the owner confirmed the deploy completed but did not capture the new version number. Recorded honestly rather than guessed." No artifact claims a stronger evidentiary basis than what was actually gathered. |
| 8 | Test integrity — real source evaluated, no existing test modified, no mock hides behaviour | ✓ VERIFIED | `tests/frontend/adminapi-recipe-pure.test.js` uses `fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'))` and evaluates it with `new Function` — confirmed by direct read of the harness (`loadAdminApi()`/`evaluateSourceOnly()`), not a copy or reimplementation. `git log --oneline -- tests/frontend/adminapi-recipe-pure.test.js` shows only 2 commits, both from this phase, creating/extending the same new file — no pre-existing test was touched (satisfies CLAUDE.md rule 10). Ran the suite directly: 38/38 tests pass. |

**Score:** 8/8 must-haves verified (grouped from the roadmap goal + PLAN frontmatter must_haves across 79-01/02/03/04; see per-truth mapping above)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps-script/adminApi.gs` — rewritten `updateRecipe` | Batched writes, skip-when-unchanged, batched delete/insert, hoisted id minting, stable ingredient ids, retuned lock, diagnostic response fields | ✓ VERIFIED | Read in full (lines 3686-3969). All D-04/05/06/07/08/09/10 elements present and correctly ordered. |
| `apps-script/adminApi.gs` — 4 pure helpers (`formatPaddedId`, `maxIdNumFromColumn`, `normalizeRecipeIngredientTuple`, `recipeIngredientsUnchanged`) | Locally-testable pure functions, no Apps Script globals | ✓ VERIFIED | Read in full (lines 1264-1366). No `SpreadsheetApp`/`LockService`/etc. references (also asserted by 4 purity tests in the Jest suite, all passing). |
| `tests/frontend/adminapi-recipe-pure.test.js` | Jest harness loading the real `.gs` file, 38 tests covering syntax gate + all 4 helpers + purity | ✓ VERIFIED | Ran directly: 38/38 pass. Confirmed it reads the real file via `fs.readFileSync`, not a copy. |
| `zoho-middleware/routes/recipes.js` (unchanged, D-02) | `timeout: 15000` preserved | ✓ VERIFIED | Line 37, present; generic `data.ok === false → 422` handling (line 661-662) already correctly surfaces the new `lock_timeout` result without any middleware change needed. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `updateRecipe` ingredient block | `recipeIngredientsUnchanged` / `maxIdNumFromColumn` / `formatPaddedId` (79-02) | Direct call, fed by the single `RecipeIngredients.getDataRange()` read | ✓ WIRED | `adminApi.gs:3880` calls `recipeIngredientsUnchanged(incomingKeys, storedKeys)`; `adminApi.gs:3887` calls `maxIdNumFromColumn(ingData.slice(1), idCol, 'RI-')`; `adminApi.gs:3903` calls `formatPaddedId('RI-', ++maxIdNum, 6)`. All three consume data from the single `ingData` read at line 3829 — no second read. |
| BrewPad "Save Recipe" | deployed `updateRecipe` | `PUT /api/recipes/:id` → middleware `callAppsScriptPost` → Apps Script `update_recipe` action | ✓ WIRED (production-confirmed) | Middleware route unchanged and already routes to `update_recipe`; 79-04's live probes (owner-executed, documented in `79-04-SUMMARY.md`) confirm real production saves against the redeployed script succeeded, with `RecipeIngredients` id-stability evidence (Probe B) that is structurally impossible under the pre-fix code. |
| Recipe-row write | Recipes sheet row | `ensureRecipesPricingModeColumn` → `findRowById` → single ranged `setValues()`/per-cell fallback | ✓ WIRED | Verified ordering and cache-invalidation sequencing directly in source (lines 3725-3810). |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|----------------|--------------|--------|----------|
| RECIPE-SAVE-01 | 79-01, 79-03, 79-04 | Recipe saves must complete well inside the middleware's 15s Apps Script timeout | ✓ SATISFIED | Round-trip count reduced from ~54 to ~6-11 by direct code inspection; production live-probe evidence (owner-executed, id-stability + zero timeout/error log lines) corroborates the fix is active and functioning, with evidence gaps honestly disclosed (see Truth #7). |

No orphaned requirements found for this phase (`grep -E "Phase 79" .planning/REQUIREMENTS.md` — RECIPE-SAVE-01 is a phase-local id per the ROADMAP note, no separate REQUIREMENTS.md entry exists to cross-reference; this matches the ROADMAP's own statement: "no formal requirement id existed, so the phase-local id RECIPE-SAVE-01 stands in").

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps-script/adminApi.gs` | 1404, 1885, 1997, 2022 | `TBD` (packaging-date domain term) | ℹ️ Info | Pre-existing since 2026-02-18 (`git blame`), outside `updateRecipe`, untouched by this phase's commits. Not a debt marker — "TBD" here is a literal business-domain value (an undated packaging task), not a placeholder comment. Not a blocker. |

No `FIXME`/`XXX`/`HACK`/`PLACEHOLDER` markers, no `return null`/`return {}`/empty stub handlers, and no hardcoded-empty-data patterns found in the modified code (`updateRecipe`, the 4 helpers, or the new test file).

### Behavioral Spot-Checks

`apps-script/adminApi.gs` executes only inside Google's Apps Script runtime and cannot be invoked locally (no `SpreadsheetApp` outside Google) — this constraint is explicit in the phase's own D-11 decision. Step 7b spot-checks were not run by this verifier for that reason (no local runnable entry point). Instead:

- Ran `npx jest tests/frontend/adminapi-recipe-pure.test.js` directly: **38/38 tests pass**.
- Ran full `npm test` (frontend): **93/93 suites, 1305/1305 tests pass**.
- Ran full `cd zoho-middleware && npm test`: **102/102 suites, 1527/1527 tests pass**.
- Production behavioral evidence (owner-executed, not re-run by this verifier — cannot be, requires live Apps Script + Sheets access) is documented in `79-04-SUMMARY.md` Probes A/B/C and independently cross-checked against the source code logic above; the code-level mechanism that would produce those observed results (id stability, no rewrite on rename) is directly verified in the source, not merely asserted by the SUMMARY.

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist for this phase; the phase's "probes" (Probe A/B/C/D) are manual, owner-executed live checks against production Google Sheets/Apps Script, which cannot be executed by this verifier (no local Apps Script runtime, no direct Sheets API credentials in this environment). These are documented, not re-run — consistent with D-11's stated verification model ("cannot be verified locally... plan for a live probe after deploy, not test-suite proof").

### Human Verification Required

None. The phase's designated human checkpoint (owner redeploy + live probe, `79-04` Task 2, `gate="blocking-human"`) already executed and reached an explicit resume signal ("redeployed and verified") with owner sign-off, documented in `79-04-SUMMARY.md`. No further human action is required to close this phase.

### Gaps Summary

No blocking gaps found. Three informational evidence-completeness notes are carried forward (already disclosed honestly in `79-04-SUMMARY.md` and `ROADMAP.md`, not hidden or overstated):

1. Probe A (save latency) has no captured millisecond figure — only a qualitative owner report ("quick and clean") corroborated by an absence of timeout/error lines in production logs.
2. Probe D (direct `ingredients_unchanged`/`row_write_mode` diagnostics) was not run; the D-04 skip-branch behaviour is inferred from ingredient-id stability (Probe B) rather than directly observed.
3. The new (post-redeploy) Apps Script version number was not captured by the owner (only the rollback target, v49, is known).

None of these affect the code-level correctness verified independently in this report (round-trip reduction, fail-safe comparison, bounded id-honouring, both safeguards, correct ordering, guardrails intact, test integrity). They narrow the strength of the production-evidence trail from "directly observed" to "strongly corroborated," exactly as the phase's own SUMMARY states — this verifier finds no artifact overstates that distinction.

---

_Verified: 2026-09-02T16:14:29Z_
_Verifier: Claude (gsd-verifier)_
