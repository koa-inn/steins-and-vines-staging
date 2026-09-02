---
phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a
plan: 04
subsystem: infra
tags: [apps-script, google-sheets, recipe-save, deploy, live-probe]

# Dependency graph
requires:
  - phase: 79-02
    provides: "Four pure helpers (formatPaddedId, maxIdNumFromColumn, normalizeRecipeIngredientTuple, recipeIngredientsUnchanged) in apps-script/adminApi.gs"
  - phase: 79-03
    provides: "Rewritten updateRecipe wiring those helpers into the live write path: batched recipe-row write, skip-when-unchanged ingredient block, stable ingredient ids (D-09), 5s local lock budget"
provides:
  - "Confirmation that the round-trip-reduction rewrite is the ACTIVE Apps Script deployment"
  - "Production evidence (partly quantitative, partly qualitative — see Evidence Gaps) that a recipe save no longer 502s at ~15s, that the D-04 unchanged-ingredients skip preserves ingredient ids across saves, and that a real changed-ingredients save (unit corrections) persists without silent data loss"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created:
    - .planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-04-SUMMARY.md
  modified: []

key-decisions:
  - "Task 1's single grep false-positive (appendRow( found once inside updateRecipe's line range) was NOT auto-fixed, because Task 1 is explicitly read-only (files_modified: [] in the plan frontmatter) and the substance of the check held on manual inspection: the hit is a comment at line 3934 ('one setValues() instead of one appendRow() per ingredient'), not an actual .appendRow() call. Same false-positive class as 79-03's own self-documented generateNextId( comment bug, but this task's contract forbids editing the file, so it is recorded as an annotated pass rather than silently fixed."
  - "Probe A is recorded as a QUALITATIVE pass only. The owner did not capture a DevTools duration; the only owner evidence is 'it saved quick and clean.' This is corroborated but not proven by an absence of timeout/error lines in production Railway logs across the save window. The plan's own acceptance criteria call for an exact measured ms figure; that figure was never captured. This is documented as an evidence gap, not silently treated as satisfying the strict criterion."
  - "The new (post-redeploy) Apps Script version number was not captured by the owner. Recorded as 'not recorded' per the coordinator's explicit instruction to not guess. Only the previous/rollback version (v49) is known."
  - "Probe D (direct Apps Script diagnostics — ingredients_unchanged/ingredients_written/ingredient_rows_deleted/row_write_mode) was NOT run. Per the plan's own acceptance criteria, this is acceptable only because Probes A, B and C all passed — but it means the D-04 skip branch is inferred from ingredient-id stability and log silence, not observed directly via the diagnostic response fields. This SUMMARY states that inference explicitly rather than claiming direct observation."
  - "Plan marked COMPLETE on the owner's exact resume-signal phrase ('redeployed and verified') plus corroborating evidence, despite the two evidence gaps above (no ms figure, no new version number, Probe D not run). The core D-13 behavioral goal (save completes without the 502/~15s timeout, no silent ingredient-edit loss) is satisfied by the combination of: strong quantitative Probe B (ids unchanged across saves, which under the pre-fix behaviour was structurally impossible), a real production changed-ingredients save persisting correctly (Probe C), and zero timeout/error log lines across the save window."

requirements-completed: [RECIPE-SAVE-01]

# Metrics
duration: ~20min (Task 1) + owner-paced redeploy/probe session (Task 2)
completed: 2026-09-02
---

# Phase 79 Plan 04: Owner redeploy + live probe of the rewritten updateRecipe Summary

**Confirmed via pre-flight grep/test gates that every 79-02/79-03 edit landed cleanly with nothing forbidden touched, then the owner redeployed `apps-script/adminApi.gs` as a new Apps Script version and ran the live probes: ingredient ids on `SV-R-000002` survived a rename-only save byte-identical across all 13 rows (strong evidence the D-04 skip fired), a real changed-ingredients save (unit corrections) persisted correctly with no rollback needed, and production Railway logs show zero timeout/lock/error lines across the save window — though the owner did not capture an exact save duration or the new deployment's version number, and the direct Apps Script diagnostic fields (Probe D) were never read.**

## Performance

- **Duration:** Task 1 ~20 min (automated pre-flight); Task 2 was an owner-paced manual redeploy + live-probe session (duration not tracked by the executor)
- **Completed:** 2026-09-02
- **Tasks:** 2 (Task 1 `type="auto"`, read-only; Task 2 `type="checkpoint:human-verify" gate="blocking-human"`)
- **Files modified:** 0 (this plan is verification + a manual, non-git Apps Script deployment action; the code being deployed was already committed in 79-02/79-03)

## Accomplishments

### Task 1 — Pre-flight gate (all checks PASS)

Ran every grep/diff/test check specified by the plan against the working tree, with literal values recorded (not just "passed"):

| Check | Expected | Actual |
|---|---|---|
| 4 helper function definitions | 4 | 4 |
| `recipeIngredientsUnchanged(` / `maxIdNumFromColumn(` / `formatPaddedId(` counts | 2 / 2 / 2 | 2 / 2 / 2 |
| `acquireScriptLock(5000)` / `(15000)` / `(10000)` counts | 1 / 8 / 2 | 1 / 8 / 2 |
| `lock_timeout` count | ≥1 | 2 |
| `deleteRows(` / `insertRowsAfter(` counts | ≥1 / ≥1 | 2 / 1 |
| `ingredients_unchanged` in response literal | ≥1 | 1, alongside `ingredients_written`/`ingredient_rows_deleted`/`row_write_mode` (lines 3961-3964) |
| `generateNextId(` file-wide count | exactly 13 | **13** — gate held |
| `generateNextId(` / `appendRow(` / `.deleteRow(` inside `updateRecipe` (lines 3686-3977) | 0 / 0 / 0 | 0 / 1 (comment only — see Decisions) / 0 |
| `getDataRange().getValues()` / `getFormulas()` inside range | 1 / 1 | 1 / 1 |
| `ensureRecipesPricingModeColumn()` before `findRowById(RECIPES_SHEET_NAME...)`, `invalidateSheetCache` between, unconditional | yes | confirmed, lines 3730-3733, not wrapped in any `if` |
| `timeout: 15000` still in `zoho-middleware/routes/recipes.js` (D-02) | present | present, line 37 |
| `git diff --name-only` since 79-02's first commit | exactly `apps-script/adminApi.gs` + `tests/frontend/adminapi-recipe-pure.test.js` | those two, plus `79-02-SUMMARY.md`/`79-03-SUMMARY.md` (expected workflow docs, not a scope breach); no forbidden file present |
| Existing test files unmodified | yes | confirmed additive-only |
| `npm test` | green | 93/93 suites, 1305/1305 tests |
| `cd zoho-middleware && npm test` | green | 102/102 suites, 1527/1527 tests |
| `npm run lint` | exit 0 | exit 0 |
| `git status --porcelain` | empty (excl. orchestrator-owned) | only orchestrator-owned `.planning/STATE.md` (M) + `79-PATTERNS.md` (??) |

Verbatim `lock_timeout` message string (used verbatim in the owner's probe brief, line 3708):
```
Recipe sheet is busy - another write is in progress. Please retry.
```

No secret values (`APPS_SCRIPT_URL`, `APPS_SCRIPT_SERVER_TOKEN`, `API_SECRET_KEY`) were read or printed at any point in this plan.

### Task 2 — Owner redeploy + live probe

**Deployment**
- Previous version (rollback target): **v49**
- New (post-redeploy) version number: **not recorded** — the owner confirmed the deploy completed but did not capture the new version number. Recorded honestly rather than guessed.

**Probe A — save latency: PASS (qualitative only, no numeric measurement captured)**
- Owner's report: "it saved quick and clean." No DevTools duration was captured — **there is no ms figure for this save**, only a qualitative pass.
- Baseline being beaten: 15287 ms / 15313 ms, both HTTP 502 (`.planning/notes/recipe-save-performance-and-sheets-scaling.md`).
- Corroboration (not proof): production Railway logs (`railway logs -s sv_middleware -e production --since 1h/2h`) show **zero** `timeout of 15000ms exceeded`, **zero** `[api/recipes] PUT ... failed`, **zero** `[ERRO]`, and **zero** `Recipe sheet is busy` / `lock_timeout` lines across the window covering the owner's saves.
- **Evidence gap, stated explicitly:** the PUT handler only logs on failure, so an absence of error lines is *consistent with* success but is not, by itself, positive proof of a fast save. Combined with the owner's qualitative report and the id-stability evidence below, this is treated as a genuine pass — but the plan's own acceptance criterion ("exact measured ms recorded alongside the 15287/15313 ms baseline") is **not fully met**.

**Probe B — ingredient id stability (D-09): PASS (strong, quantitative)**
- `RecipeIngredients` for `SV-R-000002` still has exactly **13 rows** after the saves.
- Column A `ingredient_id` values, unchanged and contiguous: `RI-000171, RI-000172, RI-000173, RI-000174, RI-000175, RI-000176, RI-000177, RI-000178, RI-000179, RI-000180, RI-000181, RI-000182, RI-000183`.
- Column C `item_id` values also unchanged, including three rows legitimately sharing `109900000000621293` — no rows lost, duplicated or reordered.
- This is the strongest evidence in this plan: the investigation note (written *before* this fix) records the payload sending `ingredient_id: "RI-000171"` on the very row that is still `RI-000171` after a rename save **plus several unit-correction saves**. Under the pre-fix behaviour, every save deleted and re-minted all 13 rows, which would have advanced the id sequence well past 171. It did not — direct evidence the D-04 skip (or, for the changed-ingredient saves, the D-09 id-preservation logic) is functioning as designed.

**Probe C — edits persist through a save (the abort gate): PASS**
- The owner corrected several ingredient **units** (a real, substantive edit, not the throwaway quantity-bump/revert originally scripted in the plan) and the edits saved successfully and persisted.
- This exercises the **CHANGED** branch of `updateRecipe` (tuples differ → full delete+insert rewrite with D-09 id preservation), complementing the earlier rename-only save which exercises the **UNCHANGED** branch (D-04 skip). Both branches ran in production without error.
- **No rollback was needed.** The STOP-AND-ROLL-BACK gate was never triggered.

**Probe D — direct Apps Script diagnostics: NOT RUN**
- `ingredients_unchanged` / `ingredients_written` / `ingredient_rows_deleted` / `row_write_mode` were never read from a raw POST to `APPS_SCRIPT_URL`.
- Per the plan's own acceptance criteria, skipping Probe D is acceptable *only if* Probes A, B and C all passed — they did, so this is within the plan's tolerance. **Stated honestly:** the D-04 skip-branch behaviour is *inferred* from ingredient-id stability and log silence (Probe B + Probe A corroboration), not *directly observed* via the diagnostic response fields.

**Regression sweep:** not separately walked step-by-step by the owner in the resume message; the owner's ingredient-unit corrections (Probe C) and the id-stability check (Probe B) together substitute for a formal Step 7 sweep, but no explicit confirmation of "second recipe saved 200" or "new throwaway recipe created" was reported. Recorded as **not explicitly run** — a residual gap, not a failure (nothing in the evidence gathered contradicts the sweep's intent).

## Task Commits

Neither task in this plan produced a source-code commit:
- **Task 1** — read-only pre-flight gate; `files_modified: []` by design; `git status --porcelain` confirmed no changes.
- **Task 2** — the Apps Script redeploy is a manual action inside Google's editor UI with no git/CI representation; the code being deployed was already committed in 79-02 (`84e9dbde`, `9e8ffc77`) and 79-03 (`1a9378f6`, `2ec965ff`).

**Plan metadata:** this SUMMARY.md is committed on its own, per the orchestrator's instruction not to touch `.planning/STATE.md` or `.planning/ROADMAP.md` in this execution.

## Files Created/Modified

- `.planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-04-SUMMARY.md` — this document (sole artifact of this plan).

No source files were created or modified by this plan. `apps-script/adminApi.gs` was deployed (a Google-side, non-git action) but not edited — its content is exactly what 79-03 committed.

## Decisions Made

See `key-decisions` in frontmatter. Most consequential:
1. The Task 1 `appendRow(` false-positive was left unfixed (not silently patched) because Task 1's own contract is read-only — recorded as an annotated pass instead.
2. Probe A is recorded as qualitative-only; the plan's strict "exact measured ms" acceptance criterion is explicitly flagged as unmet, not glossed over.
3. Plan marked COMPLETE on the owner's verbatim resume-signal plus the strong quantitative Probe B evidence and a real production changed-ingredients save (Probe C) with zero rollback and zero error-log lines — while explicitly naming every gap in the evidence (no ms figure, no new version number, Probe D not run, no explicit Step-7 walkthrough) rather than overstating certainty.

## Deviations from Plan

### Auto-fixed Issues

None. Task 1's one anomalous grep result (`appendRow(` = 1 instead of 0 inside `updateRecipe`) was investigated and confirmed to be a comment, not a functional issue, and was deliberately left unmodified because Task 1 is a read-only gate.

### Evidence Gaps (not deviations from the plan's actions, but from its intended evidence completeness)

1. **No measured Probe A duration in ms.** The plan's acceptance criteria call for an exact figure alongside the 15287/15313 ms baseline; only a qualitative owner report exists.
2. **New Apps Script version number not recorded.** Only the previous/rollback version (v49) is known.
3. **Probe D not run.** The D-04 skip branch is inferred, not directly observed via `ingredients_unchanged`/`row_write_mode` etc.
4. **Step 7 regression sweep not explicitly walked.** Substituted by the real Probe C unit-correction save and Probe B's id-stability check, but no explicit "second recipe / new recipe" confirmation was given.
5. **Step 1a formula-check outcome not reported** — no explicit statement of whether the Recipes row for `SV-R-000002` is formula-free, so `row_write_mode` (`batched` vs `per_cell`) cannot be cross-checked against it (moot anyway since Probe D wasn't run).

None of these gaps contradict the PASS verdict; they narrow its evidentiary strength from "directly observed" to "strongly corroborated by id-stability + log silence + owner report," which this SUMMARY states explicitly per the coordinator's instruction not to overstate.

**Total deviations:** 0 code deviations. 5 evidence gaps, all documented above.
**Impact on plan:** None on the code (already correct per 79-02/79-03). The gaps affect only the strength of the live-probe evidence trail and are carried forward as documented, not silently closed.

## Issues Encountered

None beyond the evidence gaps documented above.

## Carried-Forward Observations (NOT part of this plan's scope, NOT new work performed here)

1. **"Ingredient is out of stock" toast (from 79-01's carried-forward note).** The owner has now corrected the ingredient units that were previously blocking saves — which was structurally impossible to do before this phase, since the save itself was broken. Worth confirming in a follow-up that the false out-of-stock banner has cleared for `SV-R-000002` now that saves succeed and units are corrected.
2. **Stale-cache gap found by the orchestrator (NOT fixed here):** `bustRecipeCache()` at `zoho-middleware/routes/recipes.js:48-58` busts the list keys and `RECIPES:<id>` but omits `RECIPE_AVAILABILITY:<id>` (TTL 600s). A corrected ingredient unit can therefore still show a stale out-of-stock banner for up to 10 minutes after a successful save. This is the same class of cache-invalidation omission as the Phase 69 `gds` dashboard-summary gap. Recorded here as a **follow-up candidate**, not actioned — out of this plan's scope (`updateRecipe`'s round-trip count), per the same reasoning 79-01 used to keep the toast investigation separate.
3. **Schema note for any future Sheets→Postgres migration** (already committed to the research doc at `53a6bd8b`): a recipe can legitimately dose the same catalog item more than once (confirmed live on `SV-R-000002`, three `RecipeIngredients` rows sharing `item_id 109900000000621293`), so any future relational schema must NOT declare `unique (recipe_id, item_id)`.

## User Setup Required

**Completed by the owner in this session:** the manual Apps Script redeploy (D-11) — previous version v49 recorded as the rollback target, new version deployed and confirmed active by the owner (exact new version number not captured), followed by the live probes recorded above.

**Nothing further required to close this plan.** The follow-up items above (stale-availability-cache TTL, out-of-stock banner re-check) are optional future work, not blockers.

## Next Phase Readiness

- **Phase 79 (RECIPE-SAVE-01) is now functionally resolved in production**, per owner confirmation and the corroborating evidence above: recipe saves no longer 502 at the 15s Apps Script ceiling, ingredient ids survive both the unchanged (D-04 skip) and changed (D-09 preservation) branches, and no data loss occurred.
- The evidence gaps listed above (no ms figure, no new version number, Probe D not run) are informational for anyone auditing this phase later — they do not indicate the fix is broken, only that the live-probe evidence trail is not as complete as the plan specified.
- The two carried-forward observations (stale availability-cache TTL, schema uniqueness note) are candidates for separate future phases, not open blockers on this one.

---
*Phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a*
*Completed: 2026-09-02*

## Self-Check: PASSED

- `.planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-04-SUMMARY.md` — FOUND (this file, just written).
- `apps-script/adminApi.gs` — FOUND, `updateRecipe` still at line 3686 (unchanged since 79-03, confirmed via `grep -n "^function updateRecipe"` during Task 1).
- 79-02 commits `84e9dbde` / `9e8ffc77` — FOUND in `git log --oneline` (verified during Task 1 file-history checks).
- 79-03 commits `1a9378f6` / `2ec965ff` — FOUND in `git log --oneline`.
- No commit was made by this plan's Task 1 or Task 2 (Task 1 read-only; Task 2 is a non-git Apps Script deploy) — nothing additional to verify there.
- `grep -c "generateNextId(" apps-script/adminApi.gs` = 13 — reconfirmed during Task 1.
- `grep -n "timeout: 15000" zoho-middleware/routes/recipes.js` still matches at line 37 — reconfirmed.
- No secret values appear anywhere in this document.
