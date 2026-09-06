---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 08
status: complete_with_finding
completed: 2026-09-06
tasks_completed: 3
tasks_total: 3
autonomous: false
requirements: [OPS-05]
blocks_next_plan: true
---

# 81-08 Summary — Staging deploy, Branch A backfill, release gate

All three tasks executed. **The D-10 release gate is met.** One defect found during Task 3
verification that, per this plan's own instruction ("any failure blocks the production cutover
in plan 81-09"), blocks 81-09 until resolved.

## Task 1 — Deploy to staging, verify the contract first

Pushed `ab6e1841..cc054ad9` (55 commits) via `git push origin main`. Railway staging redeploy
confirmed by `uptime` resetting 58355s → 11s; GitHub Pages published.

Pre-push gates: frontend 1678/1678, middleware 1603/1603, both linters clean, and
`npm run build` followed by `git status --porcelain js/main.js js/main.min.js` produced no
output. (The working tree *looked* dirty after building — that is `?v=` cache stamps and
`BUILD_TIMESTAMP`, which the build rewrites every run. Verified the source churn contained
nothing else before discarding it.)

Pre-backfill baseline was clean: 3 active recipes, **no** `ferment_days` key, zero occurrences
of `schedule_id` / `steps_parsed` / `is_transfer` / `day_offset` / template ids, and the
anonymous status guard still refusing `?status=all` and `?status=draft`. A draft recipe's
detail endpoint returns 404.

Frontend verified in-browser rather than by `curl` — `staging.steinsandvines.ca` returns
**HTTP 403** to curl (bot protection); the Railway API host does not.

## Task 2 — Backfill (Branch A: attach only, nothing created)

Both templates re-verified live before attaching rather than trusting the 81-07 record:
`FS-0010` still 21 days, `FS-0008` still 35.

| recipe_id | name | template | ferment_days |
|-----------|------|----------|--------------|
| SV-R-000011 | West Coast IPA | FS-0010 Basic Ale (No Dry Hop) | 21 |
| SV-R-000003 | Hazy Pale Ale | FS-0010 Basic Ale (No Dry Hop) | 21 |
| SV-R-000002 | Czech Lager | FS-0008 Standard Lager | 35 |

Persistence confirmed in the sheet itself (column R), not just via the cached API. Every draft
recipe's cell remains blank — only the three active rows were written.

With real data flowing, the public payload carries exactly one new field. Full assertion table
in `81-SCHEDULES-INVENTORY.md`.

## Task 3 — Release gate

**D-10 MET.** All three cards on staging render: West Coast IPA and Hazy Pale Ale "about 3
weeks from brew day", Czech Lager "about 5 weeks from brew day" — matching the owner's own
~3-week / ~5-week figures exactly.

10 of 11 verification points pass. Full table, verbatim copy checks, and method notes are in
`81-SCHEDULES-INVENTORY.md` § "Release-gate verification". Highlights worth repeating:

- **D-09 was proven, not assumed.** Cleared a schedule, confirmed the card degrades to a clean
  316px single-column footer with no `TBD` / em-dash / `0 weeks`, then re-attached and
  re-verified. `ferment_days` was absent from the payload, not `null` or `0`.
- **D-01 holds under test.** The BeerXML fixture carried `AGE 30` as a negative control; it
  appears nowhere. Only `PRIMARY_AGE + SECONDARY_AGE = 14` is surfaced.
- **D-13/D-14 hold under a wide gap.** With the file claiming 14 days and the chosen template
  21, the compare line stayed plain `rgb(107,84,66)` with no icon and no warning class, and
  nothing was pre-selected.
- The BeerXML probe **wrote nothing** — recipe count 10 before and after.

## DEFECT — blocks 81-09

**The D-15 blast-radius note silently fails to render on a natural navigation path.**

`countRecipesUsingSchedule` reads `_recipesState.list`, populated only by `loadRecipeList()`
from `initRecipesTab()` — i.e. only once the Recipes tab has been opened. The note is gated on
`if (usedByCount > 0)` (`js/admin.js:7686-7693`). A staff member who goes straight to Batches →
Schedule Templates edits a template attached to live public recipes and sees no warning,
because the count evaluates to 0.

Confirmed empirically: no note on the direct path; correct note ("Used by 2 public recipes…")
after visiting Recipes first.

This is the mirror of the gap 81-04 fixed for the picker, and the fix pattern already exists in
the codebase (`initRecipesTab()` calls `triggerBatchLoad()` because the picker needs
`fermSchedulesData`). Here the dependency runs the other way.

Recommended: a small gap-closure plan before 81-09 — a guarded recipe-list load before the
template form renders.

## Also recorded, not fixed

- **D-04 positive leg not verifiable.** No batch carries a `recipe_id` with a schedule; the
  three pending batches are Zoho-SKU wine products. With 81-06's finding that the create-batch
  modal has no recipe identity at all, D-04 is verified in its negative case only.
- Pre-existing Apps Script deployment-config drift (from 81-07) remains open.

## Key files

- `.planning/phases/81-.../81-SCHEDULES-INVENTORY.md` — staging verification, backfill record,
  full release-gate table, defect write-up
- `docs/RUNBOOK.md` — Apps Script deploy/rollback section added in 81-07

## Self-Check: PASSED (with recorded defect)

- Task 1 acceptance: gates green, artifacts in sync, HTTP 200 with 3 recipes, `ferment_days`
  count 0 pre-backfill, leak greps 0, status guard intact, section recorded.
- Task 2 acceptance: `grep -q 'Backfill'` passes, `grep -q 'server_token='` returns nothing.
- Task 3 automated verify: `curl … | grep -c ferment_days` returns 3 (was 0 pre-backfill).
- D-10 release gate met on staging.
- The D-15 defect is recorded as blocking and is NOT represented as passing anywhere.
- No STATE.md / ROADMAP.md edits (orchestrator-owned).
