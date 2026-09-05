# Phase 81: Recipe fermentation timeline — give customers an expected ready date - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-05
**Phase:** 81-recipe-fermentation-timeline-give-customers-an-expected-read
**Areas discussed:** What the number means, Wording & placement, Missing value & backfill, Import trust & correction

---

## Area selection

| Option | Description | Selected |
|--------|-------------|----------|
| What the number means | Ready to package vs ready to drink; one total or stages kept separate | ✓ |
| Wording & placement | Phrasing, card placement, beer.html copy, and the waitlist clock problem | ✓ |
| Missing value & backfill | What a recipe with no value shows; how existing recipes get one | ✓ |
| Import trust & correction | Where imported values are reviewed; flagging suspicious defaults | ✓ |

**User's choice:** all four.

---

## What the number means

### Q1 — What event is "about 3 weeks" counting to?

| Option | Description | Selected |
|--------|-------------|----------|
| Ready to package | The date the customer comes in to can or bottle — bookable, verifiable, the moment they take beer home | ✓ |
| Ready to drink | Fermentation plus conditioning; matches the owner's figures but can't be verified or booked against | |
| Both, as two numbers | Most honest, but two numbers on a card and two fields to keep correct | |

**User's choice:** Ready to package.

### Q2 — What lands on the Recipes sheet, given BeerXML splits PRIMARY/SECONDARY/TERTIARY_AGE and AGE?

| Option | Description | Selected |
|--------|-------------|----------|
| One total in days | Sum the stages, ignore `AGE` (post-packaging conditioning, after our handoff) | ✓ |
| Total plus raw stages | Keep stage detail for future BrewPad use; more columns to sync | |
| Stages only, sum at render | Faithful to source, but every consumer does arithmetic | |

**User's choice:** One total in days.
**Notes:** **Superseded within the same area by Q3.** Retained because the reasoning — excluding
`AGE` because it falls after our handoff — still holds and informed D-01.

### Q3 — Where does the recipe's timeline come from?

Claude interrupted the planned question order here. The user's answer to Q4 (below, asked first)
was *"There is already a concept of batch schedules, this should actually be connected to that
probably"* — which prompted a scout of `FermSchedules` and reframed the data model before Q4 could
be re-put.

**Finding presented to the user:** `FermSchedules` templates carry steps with `day_offset`, and each
ends with an `is_packaging` step described in the UI as *"always last, date TBD until all other
steps are done"*. The largest non-packaging `day_offset` is therefore already days-to-ready-to-package.
Batches freeze a `schedule_snapshot` at activation, so template edits can't disturb live batches.

| Option | Description | Selected |
|--------|-------------|----------|
| Attach a template, derive the number | `schedule_id` on the recipe; public figure computed from the template. One source of truth | ✓ |
| Template plus per-recipe override | Same, but an explicit `ferment_days` wins when set | |
| Standalone `ferment_days` | What the ROADMAP originally sketched; simplest, but a second copy that will drift | |

**User's choice:** Attach a schedule template, derive the number.
**Notes:** This is a deliberate departure from the ROADMAP scope sketch, driven by the user's own
steer. It supersedes Q2.

### Q4 — Does anything besides public display consume this number?

Asked before Q3; the user declined the framing and redirected to batch schedules. Re-put after the
scout:

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-select the schedule at batch creation | A default value in the existing dropdown; staff can override | ✓ |
| Public display only | Link is decorative internally; smallest phase | |
| Pre-select and auto-fill an expected ready date | More useful, but adds a derived date to the batch view | |

**User's choice:** Pre-select the schedule.

---

## Wording & placement

### Q1 — How do day offsets become customer-facing text?

| Option | Description | Selected |
|--------|-------------|----------|
| Rounded weeks, "about 3 weeks" | Reads how staff say it; the vagueness is honest | ✓ |
| A range, "3–4 weeks" | Harder to over-promise, but a band invented from one number is a fiction | |
| Exact weeks with a qualifier | Closer to the data, but reads technical | |

**User's choice:** Rounded weeks.

### Q2 — Keeping the clock start honest, given beer is booked off a waitlist

| Option | Description | Selected |
|--------|-------------|----------|
| Name the start point in the phrase | "About 3 weeks from brew day" — card can't be misread standalone | ✓ |
| Short phrase, explain once nearby | Cleaner cards, but the clarification is easy to scroll past | |
| Both | Most honest, more copy to keep true | |

**User's choice:** Name the start point in the phrase.

### Q3 — Where on the recipe card?

| Option | Description | Selected |
|--------|-------------|----------|
| Second column in the footer | Reuses the existing `.price-col` idiom; price and time sit together | ✓ |
| Appended to the style line | Cheapest, but buries a headline fact in subtitle text | |
| Its own line under the description | Room to breathe, but belongs to neither neighbour | |

**User's choice:** Second column in the footer.

### Q4 — What happens to beer.html's two "timeline at your consult" passages?

| Option | Description | Selected |
|--------|-------------|----------|
| Rewrite both | Otherwise the page contradicts its own cards; replacing that line is the phase's goal | ✓ |
| Rewrite the FAQ only | Less copy, but How It Works still deflects three sections above the cards | |
| Leave both | Minimum risk to a recently rewritten page, but keeps deflecting an answerable question | |

**User's choice:** Rewrite both.

---

## Missing value & backfill

**Live data gathered mid-area:** production has exactly 3 active recipes — West Coast IPA, Hazy Pale
Ale, Czech Lager. Two ales and a lager, matching the owner's 3-week/5-week split. Backfill is small.

### Q1 — What does a card with no schedule show?

| Option | Description | Selected |
|--------|-------------|----------|
| Omit the footer column entirely | Nothing broken, nothing promised; same as a missing style/description | ✓ |
| Show "Timeline at your consult" | Structurally consistent, but puts a non-answer in a data slot | |
| Hide the card until it has a schedule | Strongest guarantee, but a data gap becomes lost revenue | |

**User's choice:** Omit the column.

### Q2 — How do existing recipes get a schedule, and what if no beer template exists?

| Option | Description | Selected |
|--------|-------------|----------|
| Attach by hand, create templates if missing | Template creation in scope; release gated on all 3 rendering a timeline | ✓ |
| Attach by hand, templates a prerequisite | Cleaner boundary, but risks shipping nothing visible | |
| Script a style-keyword guess | The style-inference heuristic Phase 74 explicitly rejected | |

**User's choice:** Attach by hand, create templates if missing.

### Q3 — Require a schedule before a recipe can go active?

| Option | Description | Selected |
|--------|-------------|----------|
| Warn, don't block | Informs without a save that can fail under time pressure | ✓ |
| Hard-require | Guarantees every public card answers the question, at the cost of blocked saves | |
| No validation | Least code, but a recipe goes public silently unanswered | |

**User's choice:** Warn, don't block.

---

## Import trust & correction

### Q1 — What should the BeerXML timing fields do, now that the recipe stores a `schedule_id`?

| Option | Description | Selected |
|--------|-------------|----------|
| Show them, pick the template at import | Meta line shows the BeerXML total; a template dropdown is added to the review modal | ✓ |
| Show them, auto-suggest the closest template | Faster on honest files; risks reflex-confirming an exporter default | |
| Drop the timing parse entirely | Cheaper, nothing untrustworthy enters — but blind to data sitting in the file | |

**User's choice:** Show them, and pick the template at import.

### Q2 — When BeerXML and the chosen template disagree?

| Option | Description | Selected |
|--------|-------------|----------|
| Show both side by side, no judgement | Disagreement visible, human decides; no threshold to tune | ✓ |
| Warn beyond a one-week gap | Harder to overlook, but implies BeerXML is authoritative and cries wolf on defaults | |
| Say nothing | Simplest, but staff must hold both numbers in their head | |

**User's choice:** Show both side by side.

### Q3 — Guarding template edits that change public copy

| Option | Description | Selected |
|--------|-------------|----------|
| Note the blast radius in the schedule editor | "Used by N public recipes"; one line of derived text | ✓ |
| Accept it, no guard | Cheapest, but the beer page changes and nobody knows | |
| Snapshot the number onto the recipe | Stable copy, but re-introduces the second source of truth just eliminated | |

**User's choice:** Note the blast radius.

### Q4 — What the public API exposes

| Option | Description | Selected |
|--------|-------------|----------|
| One derived integer, `ferment_days` | No internal process detail leaves; frontend owns the phrasing | ✓ |
| A ready-made `ready_text` string | One phrasing everywhere, but a copy tweak becomes a Railway deploy | |
| Expose `schedule_id`, resolve client-side | Makes the internal schedule catalogue publicly fetchable | |

**User's choice:** One derived integer.

---

## Claude's Discretion

- Column name for the recipe's schedule reference (`schedule_id` assumed).
- Markup/CSS for the second `.price-col` and its narrow-width behaviour.
- Final wording of the rewritten `beer.html` passages, within D-06 and D-08.
- Placement of the schedule picker within the recipe editor form group.
- Rounding implementation and the floor below which a value is unusable.
- Computing the template's usable offset when steps are stored out of order (take the max).

## Deferred Ideas

- Auto-filling a computed expected-packaging date on the batch (declined under D-04, now cheap later).
- A per-recipe timeline override (declined under D-03 — fork a template instead).
- Stage-by-stage fermentation data on the recipe (Phase 66).
- Post-packaging conditioning as a second customer-facing number (declined under D-01).
- An explicit `category` field on recipes (pre-existing Phase 74 locked future decision).

## Todos reviewed

15 pending todos cross-referenced; none in scope. All matched at the keyword-noise baseline; the
closest, `beer-cider-launch-pages.md`, describes already-shipped work. None folded.
