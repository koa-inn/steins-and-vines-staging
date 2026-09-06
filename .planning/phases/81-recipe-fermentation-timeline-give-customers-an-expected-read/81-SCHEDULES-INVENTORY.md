---
plan: 81-07
task: 1
status: recorded
recorded: 2026-09-05
recorded_by: hello@steinsandvines.ca (live read via admin panel, staging.steinsandvines.ca/admin.html)
decision: Branch A
---

# FermSchedules Inventory — Phase 81 (D-10 branch decision)

## How this was read

The plan's primary route (`curl` against the Apps Script deployment with the server
token) was not usable: the credential is deliberately absent from this working copy,
and hitting the `/exec` URL from a signed-in browser returns
`{"ok":false,"error":"unauthorized","message":"Could not determine user email..."}` —
`checkAuthorization` validates an OAuth access token via Google's tokeninfo endpoint,
and `Session.getActiveUser().getEmail()` comes back empty through the
`script.googleusercontent.com/macros/echo` hop.

Instead the data was read through the **live admin panel**, which performs the GIS
OAuth handshake and calls `adminApiGet('get_ferm_schedules')` itself. The values below
were extracted from the rendered `.schedule-card` DOM in the Batches → Schedule
Templates tab, which `renderScheduleList` builds directly from `fermSchedulesData` —
i.e. the unmodified `get_ferm_schedules` response payload.

No secret appears in this file. Nothing was written to the sheet; nothing was deployed
by this task.

## Derivation used

Identical predicate to the shipped middleware helper
(`zoho-middleware/routes/recipes.js` → `maxNonPackagingOffset`):

```js
step.is_packaging !== true && typeof step.day_offset === 'number'
```

Packaging steps and non-numeric offsets are skipped, never coerced. Steps were read as
a set and the maximum taken explicitly, not by reading the last row.

## Full inventory — 10 templates

| schedule_id | name | category | steps | max_non_packaging_offset |
|-------------|------|----------|-------|--------------------------|
| FS-0001 | 4 Week Wine | wine | 4 | 28 |
| FS-0002 | 8 Week Red Wine | wine | 7 | 56 |
| FS-0003 | 8 Week White Wine | wine | 4 | 56 |
| FS-0004 | 6 Week Wine | wine | 4 | 45 |
| FS-0005 | 5 Week Wine | wine | 4 | 35 |
| FS-0006 | Cider | cider | 4 | 14 |
| FS-0007 | Basic Seltzer | seltzer | 10 | 20 |
| FS-0008 | Standard Lager | (blank) | 10 | 35 |
| FS-0009 | Cider from Juice | cider | 7 | 27 |
| FS-0010 | Basic Ale (No Dry Hop) | beer | 10 | 21 |

Note: in all 10 templates the packaging step is `Bottling / Packaging` with a **TBD**
(non-numeric) offset. It is therefore excluded twice over — by `is_packaging` and by
the numeric-offset guard. The packaging-exclusion half of the derivation is not
load-bearing against today's data, but remains correct and should stay.

## Decision: **Branch A** — a usable beer-suitable template already exists

Both halves of the branch-A test are satisfied, and neither needs creating:

- **Ale (~21 days):** `FS-0010` Basic Ale (No Dry Hop), category `beer`, max
  non-packaging offset **21**.
- **Lager (~35 days):** `FS-0008` Standard Lager, category `(blank)`, max
  non-packaging offset **35**.

`FS-0008`'s blank category does **not** disqualify it — the plan states blank is a
normal, reachable state (`renderScheduleForm` offers a "None" category option) and a
beer recipe may legitimately reuse a generic template.

Plan 81-08 therefore **attaches existing templates**. It does not create any.

### Step detail for the two templates being attached

`FS-0010` Basic Ale (No Dry Hop) — max non-packaging offset **21**
```
Day 0   Brew, Cast, and Pitch      Day 17  Crash to 6ºC
Day 3   Ramp to 23ºC               Day 18  Crash to 0ºC
Day 14  Crash to 18ºC              Day 20  Keg Transfer
Day 15  Crash to 14ºC              Day 21  Carbonate
Day 16  Crash to 10ºC              TBD     Bottling / Packaging  [packaging]
```

`FS-0008` Standard Lager — max non-packaging offset **35**
```
Day 0   Brew, Cast, and Yeast Pitch   Day 17  Lower to 4ºC
Day 2   Ramp to 12ºC                  Day 32  Crash to 0ºC
Day 14  Lower to 10ºC                 Day 34  Keg Transfer
Day 15  Lower to 8ºC                  Day 35  Carbonate
Day 16  Lower to 6ºC                  TBD     Bottling / Packaging  [packaging]
```

## Sanity check against the owner's figures

The owner's stated expectation is ales ~3 weeks, lagers ~5 weeks. Applying
`fermentTimeDisplay`'s `Math.round(days / 7)`:

| Template | offset | rounds to | owner's figure | verdict |
|----------|--------|-----------|----------------|---------|
| FS-0010 Basic Ale | 21 | about 3 weeks | ~3 weeks | exact match |
| FS-0008 Standard Lager | 35 | about 5 weeks | ~5 weeks | exact match |

No discrepancy. No template is producing a number that would need to be raised rather
than adopted.

## Per-recipe mapping for plan 81-08

All three active recipes confirmed live in the admin Recipes tab (status `active`);
every other recipe in the sheet is `draft`.

| recipe_id | name | style | template to attach | resulting figure |
|-----------|------|-------|--------------------|------------------|
| SV-R-000011 | West Coast IPA | Portland Style WC-IPA | `FS-0010` Basic Ale (No Dry Hop) | about 3 weeks |
| SV-R-000003 | Hazy Pale Ale | Hazy Pale Ale | `FS-0010` Basic Ale (No Dry Hop) | about 3 weeks |
| SV-R-000002 | Czech Lager | Czech Lager | `FS-0008` Standard Lager | about 5 weeks |

## Open note for the owner (not a blocker)

`FS-0010` is named **"Basic Ale (No Dry Hop)"**, but both ales it is being attached to
— West Coast IPA and Hazy Pale Ale — are dry-hopped styles. The 21-day timeline is
still the right customer-facing number (a dry-hop addition sits inside the existing
fermentation window rather than extending it), so this does not change the figure or
block the release gate.

It is recorded because the *name* will look wrong to staff opening the picker, and
because if a dry-hop schedule is ever added it should be attached to these two recipes
instead. Owner's call; no action required for this phase.

## Task 2 — Apps Script deployment record

Deployed 2026-09-05 from the Apps Script editor for project
`1uD14PTT2lMWV06FAKcEs6Z_YKsEvnUuk9fOFycu7emiOPyh9jC0KTvUH` ("SV Website").

| Field | Value |
|-------|-------|
| **Rollback target (previous version)** | **Version 55, Sep 4 2026 1:42 PM** |
| New version deployed | **Version 56, Sep 5 2026 2:11 PM** |
| Version description | `Phase 81-01: schedule_id self-migration + gfs cache-bust` |
| Deployment ID | `AKfycbw_t1zzpa3AQxvzPqo2wAg-cBU3IdevmyEz8P-dL205VrO2jx4s3DP30WxYoVUSDI968g` (unchanged) |
| Web app URL | unchanged — no `js/admin-config.js` or Railway env update needed |

### Pre-paste drift check (why the paste was safe)

Before overwriting the editor's `adminApi.gs`, its content was hashed in place via the
editor's Monaco model and compared against git:

```
editor  SHA-256 625ea2ef2a2692865329a771493ba46e013901e3e8696a44bbbe65a5e2bf16c6
cd73146 SHA-256 625ea2ef2a2692865329a771493ba46e013901e3e8696a44bbbe65a5e2bf16c6  <-- exact match
```

`cd731469` is the last commit touching `apps-script/adminApi.gs` before Phase 81. The
editor was therefore byte-identical to committed source with **no uncommitted in-editor
drift**, so pasting destroyed nothing. Post-paste the editor hashed to
`6584237b34f7a47a8074d4e5bab87c66ee3da1da26a724568a6320412b9b74d8`, matching phase-81
`HEAD` exactly (`ensureRecipesScheduleIdColumn` x4, `remove('gfs')` x3).

Recommend repeating this hash check before any future Apps Script deploy — it is cheap
and it is the only guard against silently clobbering editor-only edits.

### Post-deploy verification (must_have: "get_recipes and get_ferm_schedules both still answer ok:true")

| Endpoint | Result | Evidence |
|----------|--------|----------|
| `get_recipes` | **ok** | `GET https://svmiddleware-production.up.railway.app/api/recipes` returned `{"source":"apps-script",...}` — `source: apps-script` means a cache miss went live to the Version 56 deployment via the server-token path and succeeded. All 3 active recipes returned. |
| `get_tasks_upcoming` | **ok:true** | Captured directly off the wire in the admin panel post-deploy: HTTP 200, `{"ok":true,"data":{"tasks":[...]}}`, 16807 bytes. Confirms `doPost` dispatch, `checkAuthorization` token validation and `handleReadAction` all work on v56. |
| `get_ferm_schedules` | **ok:true** | Captured directly off the wire during probe (d): HTTP 200, `{"ok":true,...}` with all 10 templates. |
| (c) self-migration fires | **PASS** | See below. |
| (d) `'gfs'` eviction | **PASS** | See below. |

The `/api/recipes` payload correctly contains **no** `ferment_days` field yet — the 81-02
middleware code is not deployed. That is plan 81-08's work and confirms current state is
as designed.

### Probe (c) — `schedule_id` self-migration against real Sheets

A no-op save on `SV-R-000002` (Czech Lager) in Admin → Recipes returned "Recipe saved."
Inspecting the live `Recipes` sheet afterwards:

| Column | Q | **R** | S |
|--------|---|-------|---|
| Header | `pricing_mode` | **`schedule_id`** | *(empty — end of range)* |

- Header cell reads exactly `schedule_id`, spelled as expected.
- It is the **last** column; `pricing_mode` is unshifted at Q and no other column moved.
- All `schedule_id` values are empty `''`, as predicted for a fresh migration.
- `SV-R-000002.updated_at` bumped to 2026-09-06, confirming the write landed.

The column did not exist before this save. `ensureRecipesScheduleIdColumn` created it with
no manual header pre-add — the self-healing behaviour works against the real Sheets API,
not just the test fake.

### Probe (d) — `'gfs'` cache eviction on template update

Run against `FS-0010` (Basic Ale) because it has **zero active batches** — see the finding
below. Sequence:

1. Set `FS-0010.description` = `gfs-probe-81-07`, saved → "Schedule updated".
2. Re-opened the editor: the form loaded `gfs-probe-81-07`, i.e. the post-save
   `loadScheduleTemplates()` refetch already returned the new value **and re-cached it under
   `'gfs'` with a fresh 300s TTL**.
3. Reverted `description` to `''` and saved. Captured off the wire:
   - `update_ferm_schedule` → HTTP 200, `ok:true`
   - `get_ferm_schedules` → HTTP 200, `ok:true`, `FS-0010.description === ""`

Roughly **one second** elapsed between the write and the read, against a TTL that had just
been reset to 300s holding `gfs-probe-81-07`. Returning `''` is only reachable if
`remove('gfs')` evicted the key. The cache-bust is confirmed.

`FS-0010.description` is back to its original `''`. No net data change from this probe.

## Staging verification (pre-backfill) — plan 81-08 Task 1

Deployed `ab6e1841..cc054ad9` (55 commits) via `git push origin main` on 2026-09-05.
Railway staging middleware confirmed redeployed by `uptime` resetting from 58355s to 11s.
GitHub Pages published.

Pre-push gates: frontend 1678/1678, middleware 1603/1603, both linters clean,
`npm run build` then `git status --porcelain js/main.js js/main.min.js` produced no output
(artifacts committed in sync).

### API contract — `https://svmiddleware-staging.up.railway.app`

`GET /api/recipes?status=active` → **HTTP 200**, `source: apps-script`, **3 recipes**:

| recipe_id | name | keys returned |
|-----------|------|---------------|
| SV-R-000011 | West Coast IPA | `recipe_id, name, style, description, price, price_from` |
| SV-R-000003 | Hazy Pale Ale | `recipe_id, name, style, description, price, price_from` |
| SV-R-000002 | Czech Lager | `recipe_id, name, style, description, price, price_from` |

| Assertion | Expected | Actual |
|-----------|----------|--------|
| `grep -c ferment_days` | 0 pre-backfill (D-09: absent, not `null`/`0`) | **0** |
| `grep -c -E 'schedule_id\|steps_parsed\|is_transfer'` | 0 (D-16 / T-74-04 boundary) | **0** |
| `grep -c -E '"steps"\|template\|day_offset\|is_packaging'` (broader sweep) | 0 | **0** |

### Anonymous status-guard (T-74-03 regression check)

| Query | Recipes returned | Non-active leaked | `status` key exposed |
|-------|------------------|-------------------|----------------------|
| `?status=active` | 3 (the active three) | 0 | no |
| `?status=all` | 3 (the active three) | 0 | no |
| `?status=draft` | 3 (the active three) | 0 | no |
| *(no param)* | 3 (the active three) | 0 | no |

`GET /api/recipes/SV-R-000001` (a draft) → **HTTP 404 `{"error":"Recipe not found"}`**.
The pre-existing guarantee has not regressed.

### Staging frontend

`curl` against `staging.steinsandvines.ca` returns **HTTP 403** — the static site sits behind
bot protection, unlike the Railway API host. Verified in a real browser instead:

| Check | Result |
|-------|--------|
| 81-03's rewritten copy live (`/brew day/i` in body text) | **true** |
| Old consult deflection (`/timeline at your consult/i`) gone | **true** (absent) |
| `fermentTimeDisplay` present in shipped bundle | **`typeof === "function"`** |
| `Ready in` rendered | **false** — correct, nothing attached yet |
| `.ferment-time-value` elements | **0** — correct pre-backfill baseline |

No leak, clean no-timeline baseline, new code confirmed live on both tiers. Task 1 acceptance
criteria all met; cleared to proceed to the Task 2 backfill.

## Backfill — plan 81-08 Task 2 (Branch A: attach only, nothing created)

Executed 2026-09-06 through the staging admin UI, which writes to the shared production
Sheet. Both templates were **re-verified live before attaching** rather than trusting the
81-07 record: `FS-0010` still max non-packaging offset **21** (10 steps), `FS-0008` still
**35** (10 steps). No template was created, edited or deleted.

### Attachments

| recipe_id | name | template attached | ferment_days | rendered |
|-----------|------|-------------------|--------------|----------|
| SV-R-000011 | West Coast IPA | `FS-0010` Basic Ale (No Dry Hop) | 21 | about 3 weeks |
| SV-R-000003 | Hazy Pale Ale | `FS-0010` Basic Ale (No Dry Hop) | 21 | about 3 weeks |
| SV-R-000002 | Czech Lager | `FS-0008` Standard Lager | 35 | about 5 weeks |

### Persistence confirmed at source

Live `Recipes` sheet, column **R** (`schedule_id`): `SV-R-000002` → `FS-0008`,
`SV-R-000003` → `FS-0010`, `SV-R-000011` → `FS-0010`. Every draft recipe's cell remains
blank — only the three active rows were written. `updated_at` on all three shows 2026-09-06.

### Post-backfill API contract (staging)

`GET /api/recipes?status=active` keys returned, identical for all three recipes:

```
recipe_id, name, style, description, ferment_days, price, price_from
```

| Assertion | Result |
|-----------|--------|
| `grep -c -E 'schedule_id\|steps_parsed\|is_transfer'` | **0** |
| `grep -c -E '"steps"\|template\|day_offset\|is_packaging'` | **0** |
| `grep -c -E 'FS-00'` (template ids) | **0** |
| `?status=all` / `?status=draft` anonymous | still only the 3 active |
| `GET /api/recipes/SV-R-000002` (detail path) | `ferment_days: 35`, same allowlist |

Exactly one new field crosses the public boundary, with real data flowing. D-16 / T-74-04 hold.

### D-10 release gate — MET on staging

All three active recipe cards on `staging.steinsandvines.ca/beer.html` render a timeline:

| Card | Rendered text |
|------|---------------|
| West Coast IPA | "about 3 weeks from brew day" |
| Hazy Pale Ale | "about 3 weeks from brew day" |
| Czech Lager | "about 5 weeks from brew day" |

Layout confirms D-07 — a second `.price-col` beside the price, so cost and timing read
together: `FERMENT IN STORE / From $108.80 │ READY IN / about 3 weeks / from brew day`.
D-06 confirmed: "from brew day" travels inside the phrase, so a screenshotted card cannot be
misread. The Beer Kits section below correctly shows no timeline (kits are not recipes).

Three `.ferment-time-value` elements present; zero before the backfill.

### Undo, if ever needed

Set the recipe's Fermentation Schedule picker back to "None" and save. That clears
`schedule_id`, `ferment_days` disappears from the payload (D-09: key absent, not `0`), and
the card returns to its single-column footer.

### Finding for plan 81-06 — a blast-radius warning already exists

Editing `FS-0001` (4 Week Wine) surfaced an existing in-app confirmation:

> "Apply template changes to 1 active batch? Completed tasks will not be changed."

This matters for **81-06**, whose objective is to "tell staff what a template edit will
change before they make it" (D-15). A version of that warning is already shipped — 81-06 is
therefore an *enhancement to an existing control*, not a greenfield build, and its executor
should read the current implementation before adding a second competing dialog.

Also note the dialog is Confirm/Cancel only — there is **no** "save the template but do not
propagate to batches" option. That is why probe (d) was deliberately re-targeted from
`FS-0001` (1 active batch) to `FS-0010` (0 active batches): running it on `FS-0001` would
have written to a live customer batch's tasks purely to satisfy a cache test. `FS-0001` was
cancelled with nothing saved.

## ⚠ Pre-existing finding — deployment config contradicts the documentation

The live deployment's Web app settings are **not** what the repository documents:

| Setting | Live (Versions 55 and 56) | `docs/APPS_SCRIPT.md` + `adminApi.gs` header |
|---------|---------------------------|----------------------------------------------|
| Execute as | `Me (hello@steinsandvines.ca)` | "User accessing the web app" (marked CRITICAL) |
| Who has access | `Anyone` | "Anyone with Google Account" |

This is **pre-existing and unrelated to Phase 81** — the settings were untouched by the
Version 56 deploy, which changed the version only.

Consequences, neither of which blocks this phase:

1. `Session.getActiveUser().getEmail()` returns empty under "Execute as: Me", so the
   `Session`-based limb of `checkAuthorization` is effectively **dead code in
   production**. This was confirmed empirically: a signed-in browser GET to the `/exec`
   URL returns `{"ok":false,"error":"unauthorized","message":"Could not determine user
   email..."}`.
2. Real authorization rests entirely on `checkAuthorization` validating an OAuth access
   token against Google's tokeninfo endpoint, plus the server-token bypass. That path
   works — the admin panel authenticates normally — so this is **not** an open endpoint.

The risk is documentary and latent rather than active: `docs/APPS_SCRIPT.md` misdescribes
the deployed security model, and any future read path that relies on `Session`-derived
identity as its only check would be unauthenticated. Deliberately **not** changed here:
it is a production auth boundary, outside 81-07's scope, and flipping it could break the
admin panel. Recommend a dedicated follow-up to either correct the deployment settings or
correct the documentation.
