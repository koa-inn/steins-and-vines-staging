# Phase 79: Apps Script recipe-save performance — Pattern Map

**Mapped:** 2026-09-02
**Files analyzed:** 3 (1 must-modify, 1 forbidden-to-modify but read for shared-helper context, 1 discretionary)
**Analogs found:** 3 / 5 fix-points have a real in-file analog; 2 (D-04 change-detection, D-05 in-memory ID) do **not** — this phase introduces those patterns into `adminApi.gs` for the first time.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps-script/adminApi.gs` — `updateRecipe` (3583-3681) | controller/action-handler (single-file RPC dispatch, no framework) | CRUD (request-response over `doPost`) | `updateSchedule` (1126-1151) / `updateHomepage` (1157-1195) for batched writes; `addBatchTask` (2703-2760) for in-memory max-computation shape; **no analog** for change-detection or in-memory ID hoisting | role-match (batching), no-analog (skip-write, ID hoist) |
| `apps-script/adminApi.gs` — `generateNextId` (1241-1263) | utility (shared ID minting) | CRUD (called synchronously, one Sheets read per call) | itself is the only implementation; no in-file caller ever hoists it out of a loop | no-analog |
| `apps-script/adminApi.gs` — `acquireScriptLock` (1235-1239) | utility (concurrency guard) | request-response | 12 call sites all pass a literal ms constant to the same helper — this **is** the existing pattern, just tuned inconsistently | exact (helper exists; only the call-site constant needs retuning) |
| `apps-script/adminApi.gs` — `findRowById` (1369-1411) | utility (indexed-ish lookup w/ per-request cache) | CRUD | `sheetToObjects` (1319-1355, not read in full but is `findRowById`'s sibling — same `_sheetCache` mechanism) | exact (already used by `updateRecipe`, no change needed) |
| `apps-script/adminApi.gs` — `ensureRecipesPricingModeColumn` (3472-3481) | utility (self-migrating schema helper) | CRUD | used identically by both `createRecipe` (3534) and `updateRecipe` (3620) already — internally consistent | exact |
| `zoho-middleware/routes/recipes.js` — `callAppsScriptPost` (25-42), PUT handler (627-672) | route/controller | request-response (HTTP proxy to Apps Script) | **Not to be modified** per D-02 (timeout must not be raised). Read only as the shared caller of `update_recipe`. | n/a — read-only reference |
| `js/brewpad.js` — `buildRecipePayload` (775-793) | transform/utility (payload builder) | request-response (client-side payload shaping) | itself — discretionary tweak is "stop always including `ingredients`" | exact (self-analog; see Shared Patterns) |

## Pattern Assignments

### `apps-script/adminApi.gs` — `updateRecipe` (controller, CRUD, lines 3583-3681)

This is the file being changed. The five ordered fixes (D-04 through D-08) map onto five different existing patterns in the same file — some strong analogs exist, some do not. Treat this section as "here is what to copy" per fix, not as one single analog.

---

**D-06/D-08 — Batch the recipe-row field writes and the ingredient inserts.**

**Analog:** `updateSchedule` (1126-1151) and `updateHomepage` (1157-1195) — both do a full-sheet `clearContents()` + single `setValues()` instead of per-cell writes. This is the only existing "batch instead of loop" write pattern in the file.

```javascript
// apps-script/adminApi.gs:1136-1148 (updateSchedule)
var ss = SpreadsheetApp.getActiveSpreadsheet();
var sheet = ss.getSheetByName(SCHEDULE_SHEET_NAME);
if (!sheet) return { ok: false, error: 'sheet_not_found' };

// Sanitize all string values to prevent XSS
var sanitizedValues = values.map(function(row) {
  return row.map(function(cell) {
    return typeof cell === 'string' ? sanitizeInput(cell) : cell;
  });
});

// Clear existing data and write new
sheet.clearContents();
if (sanitizedValues.length > 0) {
  var numCols = sanitizedValues[0].length;
  sheet.getRange(1, 1, sanitizedValues.length, numCols).setValues(sanitizedValues);
}
```

Note this analog is a *whole-sheet* rewrite (fits `updateSchedule`'s use case: the entire tab is one config table). `updateRecipe`'s ingredient batch is narrower — a contiguous `getRange(startRow, 1, n, 6).setValues(rows)` for just the recipe's own rows, per D-15's fixed column order:

```
ingredient_id | recipe_id | item_id | item_name | quantity | unit
```

For the recipe-row field batch (D-08), there is no existing "read-mutate-write-once" analog for a *single row* — the closest structural precedent is `updateRecipe`'s own current per-field loop (3601-3626), which already does header-lookup writes; the fix converts each `sheet.getRange(row, col+1).setValue(x)` call into one `sheet.getRange(row, 1, 1, lastCol).getValues()[0]` read, in-memory mutation, then one `setValues([[...]])`. `ensureRecipesPricingModeColumn` (below) must run first since it can widen the row.

---

**D-04 — Skip the ingredient rewrite when incoming ingredients match stored rows.**

**No analog exists in `adminApi.gs`.** Grepped for `unchanged`, `identical`, `deepEqual`, and `JSON.stringify(...) ===` — zero matches anywhere in the 4,116-line file. Every write action in this file writes unconditionally; none compares payload against existing sheet state first. This is a genuinely new pattern for this codebase, not a "follow existing style" change. The planner should treat it as net-new logic, reviewed carefully (per CONTEXT.md's own discretion note about type-coercion false-"changed" verdicts — Sheets returns numbers as JS `number` but the payload may carry `"0.5"` as a string).

The nearest *shape* to imitate for the comparison itself is `findRowById`'s existing read of `RecipeIngredients` inside `updateRecipe` (3641-3654) — it already builds a `rowsToDelete` array by scanning `ingData` for matching `recipe_id`. The new code reuses that same scan but also captures `(item_id, quantity, unit)` per matched row for comparison, rather than immediately queuing every match for deletion.

---

**D-05 — Hoist `generateNextId` out of the insert loop.**

**No analog exists** for computing a max ID once and incrementing in memory. `generateNextId` (1241-1263) always does a fresh full-column `getRange(2, 1, lastRow-1, 1).getValues()` scan, and every call site in the file (`createRecipe` 3509 and 3549, `updateRecipe` 3660, `addBatchTask` 2730, `propagateFermSchedule` 3190) calls it exactly this way — including inside loops.

The **closest structural precedent** (not for IDs, but for "scan once, compute max in memory, increment locally") is `addBatchTask`'s step-numbering logic:

```javascript
// apps-script/adminApi.gs:2718-2726 (addBatchTask)
// Find highest step_number for this batch to auto-number
var existingTasks = sheetToObjects(BATCH_TASKS_SHEET_NAME).filter(function (t) {
  return String(t.batch_id) === String(payload.batch_id);
});
var maxStep = 0;
existingTasks.forEach(function (t) {
  var sn = Number(t.step_number) || 0;
  if (sn > maxStep) maxStep = sn;
});
```

Copy this shape for ID hoisting in `updateRecipe`: read the `RecipeIngredients` id column once (the same read already needed for D-04's comparison — `ingData` from `ingSheet.getDataRange().getValues()` at 3642 already contains every `ingredient_id`), compute `maxNum` in memory using the same prefix-strip-and-`parseInt` logic `generateNextId` uses internally (1253-1258), then increment locally for each new row instead of calling `generateNextId` per row.

`propagateFermSchedule` (3200-3201) is a *near-miss* worth flagging to the planner as a cautionary example, not a pattern to copy: it still calls `generateNextId` per new row (full scan each time) and only pushes the newly-minted id into a local `allTasks` array to prevent a *different* new call from re-reading stale state — it does not hoist the scan itself. Do not copy this half-measure.

---

**D-09 — Honour incoming `ingredient_id` for existing rows; mint new IDs only for new rows.**

No direct analog (no other action in this file receives client-supplied IDs it might reuse — `createRecipe`/`createBatch`/etc. always mint fresh IDs for every new row). This folds into the same D-04 comparison loop: when a stored row is matched, keep its existing `ingredient_id` in the untouched-or-updated-in-place row; only rows with no match (or no incoming `ingredient_id`) get `generateNextId`/the hoisted-max increment.

---

### `apps-script/adminApi.gs` — `acquireScriptLock` retune (D-10)

**Analog:** the helper itself (1235-1239) — already a single well-factored function; the "pattern" here is the 12 call sites, not the helper body.

```javascript
// apps-script/adminApi.gs:1235-1239
function acquireScriptLock(timeoutMs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 10000);
  return lock;
}
```

**All 12 call sites**, with enclosing function and current timeout:

| Line | Enclosing function | Timeout arg |
|---|---|---|
| 2107 | `createBatch` | `15000` |
| 2728 | `addBatchTask` | `10000` |
| 2858 | `addPlatoReading` | `10000` |
| 3130 | `propagateFermSchedule` | `15000` |
| 3501 | `createRecipe` | `15000` |
| **3588** | **`updateRecipe`** | **`15000`** |
| 3695 | `deleteRecipe` | `15000` |
| 3843 | `issueGiftCard` | `15000` |
| 3925 | `redeemGiftCard` | `15000` |
| 3985 | `reloadGiftCard` | `15000` |
| 4032 | `voidGiftCard` | `15000` |

That is 9 explicit `15000`s + 2 explicit `10000`s = 11 call sites; the "12th"/default referenced in CONTEXT.md is the `timeoutMs || 10000` fallback inside the helper itself (1237) — no call site currently omits the argument, so today that default is dead code, not an active 12th caller. Confirm this against CONTEXT.md's count before scoping: CONTEXT.md says "9 at 15000, 2 at 10000, plus a 10000 default" — matches exactly what's shown here (9 + 2 + the helper's own fallback branch).

**Blast-radius decision the plan must make explicit:** `updateRecipe` is one of 9 sites sharing the literal `15000`. A **local** change (edit only line 3588) is low-risk and fully addresses D-13's success criterion. A **helper-level** change (e.g., changing the `|| 10000` default, or adding a second parameter) touches nothing at other call sites unless their literals are also edited — so a helper-level *signature* change is safe, but a helper-level *default-value* change alone does nothing for `updateRecipe` since it explicitly passes `15000` and would need editing regardless. Recommend: local edit at 3588 only, scoped to this phase; leave the other 11 call sites untouched (they are out of CONTEXT.md's stated scope — recipe save, not batch/gift-card locking).

---

### `apps-script/adminApi.gs` — `ensureRecipesPricingModeColumn` ordering (D-08 constraint)

**Analog:** `createRecipe` already calls it in the correct position relative to a row write:

```javascript
// apps-script/adminApi.gs:3533-3536 (createRecipe)
// Persist pricing_mode by header lookup (column is self-migrated if missing)
var pmCol = ensureRecipesPricingModeColumn(recipesSheet);
recipesSheet.getRange(recipesSheet.getLastRow(), pmCol + 1)
  .setValue(normalizePricingMode(payload.pricing_mode));
```

`updateRecipe`'s current call (3619-3622) is conditional on `payload.pricing_mode !== undefined`, but per D-08 it must run **unconditionally first**, before the single read-mutate-write-once batch, because it may append a column and therefore change `lastCol`/row width for every subsequent read in the same call.

---

### `zoho-middleware/routes/recipes.js` (read-only reference — NOT modified)

**Explicitly forbidden to change** (D-02): raising `timeout: 15000` in `callAppsScriptPost` (line 37) is the exact anti-fix this phase exists to avoid.

```javascript
// zoho-middleware/routes/recipes.js:25-42
function callAppsScriptPost(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) {
    log.warn('[recipes] APPS_SCRIPT_URL or APPS_SCRIPT_SERVER_TOKEN not configured');
    return Promise.reject(new Error('Apps Script not configured'));
  }
  return axios.post(url, JSON.stringify(Object.assign({}, payload, {
    action: action,
    server_token: token
  })), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
    maxRedirects: 5
  }).then(function (resp) {
    return resp.data;
  });
}
```

Note this single helper is shared by **every** recipe action (`get_recipe`, `get_recipes`, `create_recipe`, `update_recipe`, `delete_recipe`) — the 15s ceiling is not `update_recipe`-specific, which reinforces why D-02 forbids touching it here: a bump would mask `updateRecipe` specifically but silently raise the ceiling for reads and creates too.

The PUT handler's error path (D-12's log line) is here, confirming the exact format to grep for in Railway:

```javascript
// zoho-middleware/routes/recipes.js:668-671
}).catch(function (err) {
  log.error('[api/recipes] PUT ' + req.params.id + ' failed: ' + err.message);
  res.status(502).json({ error: 'Unable to update recipe', code: 'save_failed' });
});
```

---

### `js/brewpad.js` — `buildRecipePayload` (discretionary, lines 775-793)

**Analog:** itself. Current unconditional inclusion:

```javascript
// js/brewpad.js:775-793
function buildRecipePayload(formData, ingredients) {
  var validIngredients = (ingredients || []).filter(function (ing) {
    return ing.item_id && ing.quantity > 0;
  });
  return {
    name: formData.name || '',
    style: formData.style || '',
    description: formData.description || '',
    batch_size_l: formData.batch_size_l || 0,
    abv: formData.abv || 0,
    ibu: formData.ibu || 0,
    colour_srm: formData.colour_srm || 0,
    pricing_mode: formData.pricing_mode || 'locked',
    locked_price: formData.locked_price || 0,
    service_fee: formData.service_fee != null ? formData.service_fee : 45,
    materials_fee: formData.materials_fee != null ? formData.materials_fee : 5,
    status: formData.status || 'draft',
    ingredients: validIngredients,          // <-- always present
    ingredient_count: validIngredients.length
  };
}
```

If taken, the change is conditional inclusion of `ingredients` (e.g. only when a dirty-flag is set), which is a genuinely new decision point in this function, not a copy of an existing conditional-field pattern elsewhere in the file — there is no existing "only send field X if it changed" precedent in `brewpad.js` either. If done, it is redundant with server-side D-04 (belt-and-braces only) and requires `npm run build` to regenerate `brewpad.min.js` per CLAUDE.md rule 9, plus updating `tests/frontend/brewpad-recipe-save-resilience.test.js` and any other test asserting on `buildRecipePayload`'s always-present `ingredients` key (grep before touching, per CLAUDE.md rule 6).

## Shared Patterns

### Script lock acquire/release
**Source:** `apps-script/adminApi.gs:1235-1239` (helper) — used identically at all 12 call sites: `var lock = acquireScriptLock(N); try { ... } finally { lock.releaseLock(); }`.
**Apply to:** `updateRecipe`'s existing lock (3588) stays in this exact try/finally shape; only the `N` argument changes per D-10.

### Batched setValues() over a contiguous range
**Source:** `apps-script/adminApi.gs:1126-1151` (`updateSchedule`) and `1157-1195` (`updateHomepage`).
**Apply to:** the recipe-row field batch (D-08) and the ingredient-insert batch (D-06). Pattern: build a plain 2D array of sanitized values in memory, then a single `sheet.getRange(startRow, startCol, numRows, numCols).setValues(arrayOfArrays)`.

### Per-request row cache to avoid duplicate sheet reads
**Source:** `apps-script/adminApi.gs:1369-1411` (`findRowById`) via the module-level `_sheetCache` object.
**Apply to:** no change needed — `updateRecipe` already calls `findRowById` once at 3590 and reuses `result.headers`/`result.sheet`/`result.row` throughout. Worth noting to the planner so they don't accidentally add a second `findRowById`/`sheetToObjects` call for the same recipe row when implementing D-04/D-05/D-09 (they should read `RecipeIngredients` once and reuse that array for the delete-scan, the comparison, and the max-ID computation — three uses of one read, not three reads).

### Self-migrating column helper, called before any row-width-dependent write
**Source:** `apps-script/adminApi.gs:3472-3481` (`ensureRecipesPricingModeColumn`), used by `createRecipe:3534` and (to be reordered) `updateRecipe:3620`.
**Apply to:** D-08's ordering constraint — call this first, unconditionally, before computing `lastCol` for the batched read/write.

### Owner-redeploy checkpoint + live probe (Phase 76-01 pattern, to reuse verbatim)
**Source:** `.planning/phases/76-brewpad-session-expiry-hardening-decouple-the-durable-7-day-/76-01-PLAN.md`

Structure to copy for Phase 79's plan frontmatter and task list:

```yaml
autonomous: false
user_setup:
  - service: google-apps-script
    why: "<why a .gs edit is inert until redeployed>"
    dashboard_config:
      - task: "Redeploy adminApi.gs as a New Version after the <fix> edit"
        location: "Apps Script editor → Deploy → Manage deployments → New version"
```

Task list shape: one `type="auto"` task that makes the code edit (with a `<verify><automated>grep ...</automated></verify>` block proving the edit landed), followed by exactly one `type="checkpoint:human-verify" gate="blocking-human"` task with:
- `<what-built>` — plain-language summary of the inert-until-redeployed change
- `<how-to-verify>` — numbered steps: (1) redeploy as new version and confirm it's the active deployment, (2) a live POST probe against `APPS_SCRIPT_URL` proving the specific behavior changed (Phase 76 probed for `invalid_action` disappearing; Phase 79 should probe for `updateRecipe`'s round-trip time / response time on a real or throwaway recipe, and confirm a rename no longer touches ingredient rows)
- `<acceptance_criteria>` — concrete pass/fail per probe
- `<resume-signal>` — exact phrase the owner types back (Phase 76 used `"redeployed and verified"`)

Also copy the `T-76-01-03`-style threat-register line acknowardging staging+prod share one Google Sheet, so any live probe must use a throwaway/no-op-safe recipe, not a real one — directly relevant here since `updateRecipe`'s live probe will exercise a real save.

For Phase 79 specifically, fold in D-12 (read the Railway `[api/recipes] PUT SV-R-000002 failed: <message>` log line) as a task **before** the code-edit task, since CONTEXT.md flags it as "not yet read" and the one missing piece of direct confirmation — this differs from Phase 76-01's structure, which had no pre-existing-evidence-gathering step.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `apps-script/adminApi.gs` — D-04 skip-write-if-unchanged logic | controller (inline in `updateRecipe`) | CRUD | Grepped the entire 4,116-line file for `unchanged`, `identical`, `deepEqual`, `JSON.stringify(...) ===` — zero hits. No action anywhere compares incoming payload against stored rows before writing; every write is unconditional. This is new logic, not a copy of an existing style. |
| `apps-script/adminApi.gs` — D-05 in-memory max-ID hoisting | utility (inline in `updateRecipe`) | CRUD | `generateNextId` is always called fresh, everywhere, including inside every loop in the file (`createRecipe`, `updateRecipe`, `addBatchTask`, `propagateFermSchedule`). No caller ever hoists the scan. Closest shape is `addBatchTask`'s in-memory `maxStep` computation (2718-2726), which computes a max from an already-fetched array but is for a `step_number` field, not an ID, and doesn't touch `generateNextId` at all. |

## Testing Reality for `apps-script/*.gs`

**Confirmed: there is no test harness of any kind for `apps-script/adminApi.gs`.**

- `find`/`grep` across `tests/`, `zoho-middleware/__tests__/`, and the repo root for any `.gs` test shim, mock `SpreadsheetApp`, or Apps Script test runner returned nothing. There is exactly one `.gs` file in the repo (`apps-script/adminApi.gs`) and no sibling test file.
- `zoho-middleware/__tests__/recipes.test.js` (PUT suite at lines 465-570, D-03 suite at 576+) tests the **middleware route**, not the Apps Script code: it mocks `axios.post` entirely (`jest.mock('axios', ...)` at line 21) and asserts on the middleware's own guard/cache/error-formatting logic. `mocks.axios.post.mockResolvedValue({ data: { ok: true } })` stands in for the *entire* Apps Script round-trip — the round-trip-count bug this phase fixes is invisible to this test suite by construction, since it never actually calls `updateRecipe`.
- This confirms D-11's framing is correct: CLAUDE.md rule 3 ("write a regression test first") cannot be honored for the `.gs` changes themselves — there is no local execution environment for `SpreadsheetApp`/`LockService`. The plan must fall back to the live-probe-after-deploy model (D-11), with the Phase 76-01 checkpoint structure above as the concrete mechanism. Any regression test that *can* be written locally (e.g. a new/updated case in `recipes.test.js` asserting the PUT handler's behavior, or a pure-JS unit test if the comparison/max-ID logic is factored into a small pure helper function within the `.gs` file body) should still be written where possible, but it cannot cover the actual Sheets round-trip reduction — only a live probe can.

## Metadata

**Analog search scope:** `apps-script/adminApi.gs` (full file, 4,116 lines, read via targeted non-overlapping ranges); `zoho-middleware/routes/recipes.js` (lines 1-70, 600-690); `zoho-middleware/__tests__/recipes.test.js` (lines 1-90, 465-580); `js/brewpad.js` (lines 760-830); `.planning/phases/76-*/76-01-PLAN.md` (full).
**Files scanned:** 5 source files + 1 prior-phase plan.
**Pattern extraction date:** 2026-09-02
