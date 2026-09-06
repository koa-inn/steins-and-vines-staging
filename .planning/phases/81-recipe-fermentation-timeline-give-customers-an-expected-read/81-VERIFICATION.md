---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
verified: 2026-09-06T05:20:00Z
status: gaps_found
score: 10/11 release-gate verification points passed; 1 defect blocks the production cutover
source: plan 81-08 Task 3 (operator release-gate verification on staging)
note: >
  This report was NOT produced by the gsd-verifier agent. Phase-level verification cannot run
  while plan 81-09 remains incomplete. It records the executed release-gate verification from
  plan 81-08 Task 3, whose plan text states that any failure there blocks the 81-09 production
  cutover. It exists so /gsd:plan-phase --gaps has a gap record to plan against.
overrides_applied: 0
gates:
  frontend_tests: "1678/1678 passing (109 suites)"
  middleware_tests: "1603/1603 passing (107 suites)"
  lint: "clean (both frontend and middleware)"
  build: "clean; js/main.js and js/main.min.js committed in sync"
  release_gate_D10: "MET — all 3 active recipes render a timeline on staging"
gaps:
  - id: GAP-01
    severity: blocking
    decision_ref: D-15
    title: "D-15 blast-radius note silently fails to render on a natural navigation path"
    where: "js/admin.js:7686-7693 (renderScheduleForm) and countRecipesUsingSchedule"
    status: OPEN
human_verification:
  - test: "D-04 positive leg — activate a batch whose recipe has a schedule attached"
    expected: "#sa-schedule-select opens with that recipe's template pre-selected"
    why_human: >
      Not verifiable with current data: no batch in the system carries a recipe_id with a
      schedule attached. The only three pending batches are Zoho-SKU wine products. Not a
      regression and not caused by this phase. Recorded so it is not mistaken for verified.
    status: OPEN
---

# Phase 81: Recipe Fermentation Timeline — Release-Gate Verification

**Phase Goal:** Give customers an expected ready-date on the public beer recipe cards, derived
from the fermentation schedule template a recipe is linked to.

**Status:** GAPS FOUND — the customer-facing goal is delivered and verified; one staff-facing
safeguard fails.

## The release gate is met

D-10's gate is unconditional: all three active recipes must render a timeline. On staging:

| Recipe | Rendered | Expected |
|--------|----------|----------|
| West Coast IPA | "about 3 weeks from brew day" | ~3 weeks (ale) |
| Hazy Pale Ale | "about 3 weeks from brew day" | ~3 weeks (ale) |
| Czech Lager | "about 5 weeks from brew day" | ~5 weeks (lager) |

Matching the owner's own stated figures exactly. Layout confirms D-07 (second `.price-col`
beside the price); D-06 confirmed ("from brew day" travels inside the phrase).

With real data flowing, the public payload carries exactly one new field — `ferment_days` —
and zero occurrences of `schedule_id`, `steps_parsed`, `is_transfer`, `day_offset` or template
ids. D-16 / T-74-04 hold.

Full evidence: `81-SCHEDULES-INVENTORY.md` § "Release-gate verification".

## GAP-01 (blocking) — D-15 note silently fails to render

**What is wrong.** `countRecipesUsingSchedule` counts over `_recipesState.list`. That array is
populated only by `loadRecipeList()`, called from `initRecipesTab()` — i.e. only once the
**Recipes tab has been opened**. The note is gated behind `if (usedByCount > 0)`
(`js/admin.js:7686-7693`).

**How it manifests.** A staff member opens Admin and goes straight to **Batches → Schedule
Templates**, a completely natural path. They edit a template that is attached to live public
recipes. The count silently evaluates to 0, so **no warning appears at all**.

**Evidence (confirmed both ways, not inferred from code):**
- Direct path → FS-0010 edit modal, no note present.
- Visit Recipes tab first (10 rows load), reopen the same FS-0010 modal → "Used by 2 public
  recipes. Changing day offsets will change what customers are told."

**Why it blocks.** D-15 exists because after this phase ships, a day-offset edit changes what
customers are told on `beer.html`. The warning's whole purpose is to fire *before* that edit.
It fails in exactly the situation it was built for. Plan 81-08 Task 3 states that any failure
there blocks the 81-09 production cutover.

**Note the surrounding behaviour is correct** — this is a load-order defect, not a logic one.
Once `_recipesState.list` is populated: correct count, correct singular/plural ("1 public
recipe" for FS-0008, "2 public recipes" for FS-0010), correctly absent on a 0-attached template
and on the create-new form, correct amber `availability-banner--low` styling.

**Closest analog for the fix.** This is the mirror image of the lazy-load gap plan 81-04 already
fixed for the recipe picker. There, `initRecipesTab()` calls `triggerBatchLoad()` because the
picker needs `fermSchedulesData` and that array is otherwise only filled by the Batches tab.
Here the dependency runs the other way: the schedule template editor needs `_recipesState.list`,
which is otherwise only filled by the Recipes tab. The same guarded-idempotent-load pattern
applies.

## What passed

10 of 11 release-gate points. Highlights:

- **D-09 proven, not assumed.** Cleared a schedule, confirmed the card degrades to a clean
  316px single-column footer with no `TBD` / em-dash / `0 weeks` / `null`, then re-attached and
  re-verified. `ferment_days` was absent from the payload, not `null` or `0`.
- **D-11 warn-don't-block.** Amber `rgb(184,122,26)`, never red, and **the save succeeded** —
  verified at the source, not by toast.
- **D-01 holds under test.** The BeerXML fixture carried `AGE 30` as a negative control; it
  appears nowhere. Only `PRIMARY_AGE + SECONDARY_AGE = 14` surfaces.
- **D-13/D-14 hold under a wide gap.** File claiming 14 days against a 21-day template: nothing
  pre-selected, compare line plain `rgb(107,84,66)`, no icon, no warning class.
- **D-08 copy** rewritten in both passages; no "timeline at your consult" anywhere; canning and
  Phase-80 queue-order copy intact.

## Next step

`/gsd:plan-phase 81 --gaps` → close GAP-01 → re-verify D-15 → then plan 81-09 (production
cutover) is unblocked.
