---
phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a
plan: 01
subsystem: infra
tags: [railway, apps-script, axios, diagnosis, logs]

# Dependency graph
requires: []
provides:
  - "Confirmed root-cause diagnosis: PUT /api/recipes/:id 502s are an axios client-side timeout (`timeout of 15000ms exceeded`), not an auth/config/network/parse failure"
  - "Verbatim Railway production log evidence for the D-01 diagnosis, owner-acknowledged"
affects: [79-02, 79-03, 79-04]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created:
    - .planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-01-SUMMARY.md
  modified: []

key-decisions:
  - "CONFIRMED: the 502 on PUT /api/recipes/:id is the axios 15000ms client timeout named in D-01, not a different failure mode — 79-02/03/04 proceed as planned"
  - "Staging Railway environment had zero /api/recipes traffic in the harvested window; production is the only environment with direct evidence, which is sufficient since the reported failures were against production"

requirements-completed: [RECIPE-SAVE-01]

# Metrics
duration: ~10min
completed: 2026-09-02
---

# Phase 79 Plan 01: Diagnosis gate — Railway log confirmation Summary

**Read the live Railway production log and confirmed, verbatim, that `PUT /api/recipes/:id` 502s because axios's 15000ms client timeout fires (`timeout of 15000ms exceeded`) — not an auth, config, network, or parse failure — clearing 79-02/03/04 to proceed.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-09-02T14:22:00Z (approx.)
- **Completed:** 2026-09-02T14:32:33Z
- **Tasks:** 2 (Task 1 auto; Task 2 checkpoint:human-verify)
- **Files modified:** 0 (read-only diagnosis plan; this SUMMARY is the only file this plan creates)

## Accomplishments

- Confirmed `railway` CLI linkage: `Project: sv-middleware`, `Service: sv_middleware`, environments `production` (linked) and `staging`.
- Harvested bounded, non-interactive log windows from both environments via `railway logs -s sv_middleware -e <env> --since 5d --lines 5000`:
  - **production:** window 2026-09-02T04:11:48Z → 2026-09-02T14:26:49Z (hit the 5000-line cap, so true retention extends earlier; window fully covers the incident timestamps).
  - **staging:** only `Starting Container` / OAuth token-refresh noise in the window — no `/api/recipes` traffic at all.
- Found the exact emitter (`grep -F '[api/recipes] PUT'`) three times in production, all today, all on `SV-R-000002`:
  ```
  2026-09-02T13:36:09.670613361Z [ERRO] [api/recipes] PUT SV-R-000002 failed: timeout of 15000ms exceeded ts="2026-09-02T13:36:09.582Z" host="d193cfab54ae"
  2026-09-02T13:37:59.844612654Z [ERRO] [api/recipes] PUT SV-R-000002 failed: timeout of 15000ms exceeded ts="2026-09-02T13:37:56.883Z" host="d193cfab54ae"
  2026-09-02T13:40:50.608350657Z [ERRO] [api/recipes] PUT SV-R-000002 failed: timeout of 15000ms exceeded ts="2026-09-02T13:40:47.295Z" host="d193cfab54ae"
  ```
  Broader `grep -F '[api/recipes]'` found no other error-class lines in the window — only these three timeout errors plus routine `Cache hit status=all` info lines.
- **Verdict: CONFIRMED.** The message is the literal axios client-timeout string (`err.code === 'ECONNABORTED'`, `err.message === 'timeout of 15000ms exceeded'`) — matches the D-01 diagnosis exactly, not any of the listed contradicting patterns (auth/config/network/parse).
- Owner sign-off received on the checkpoint: "It was that and also toasts saying like ingredient is out of stock" — confirms the timeout message matches their experienced save failures.

## Task Commits

No commits were made — this plan's `files_modified` is empty by design (read-only diagnosis gate). No source file was created or changed; the only task-level artifact is this SUMMARY.

**Plan metadata:** (final metadata commit follows, per orchestrator's commit protocol)

## Files Created/Modified
- `.planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-01-SUMMARY.md` — this document (the plan's sole output)

No source files were modified. `git status --porcelain` at plan start and throughout showed only pre-existing orchestrator-owned changes (`.planning/STATE.md` modified, `79-PATTERNS.md` untracked) — untouched by this plan.

## Decisions Made

- **CONFIRMED verdict, no re-diagnosis needed.** The verbatim message is an exact match for the axios `ECONNABORTED` / `timeout of 15000ms exceeded` signature specified in the plan's `<interfaces>` section as the sole confirming signal. 79-02/03/04 (the round-trip-reduction fixes in `apps-script/adminApi.gs`) are unblocked.
- **Staging absence of evidence is not evidence of absence.** Staging's harvested window contained zero `/api/recipes` traffic, so it neither confirms nor contradicts anything — the diagnosis rests entirely on the three production matches, which is sufficient because the owner's reported failures were against production (`steinsandvines.ca`).

## Deviations from Plan

None — plan executed exactly as written. Task 1 found matching lines directly (no NOT IN RETENTION fallback needed), and Task 2's checkpoint was resolved by owner sign-off without needing a fresh reproduction (retention already covered a same-day failure).

## Issues Encountered

None.

## Carried-Forward Observation (NOT part of this plan's verdict, NOT new scope)

The owner also reported seeing **"ingredient is out of stock" toasts** alongside the save failures. Per the investigation note (`.planning/notes/recipe-save-performance-and-sheets-scaling.md`, Cause 2), a false "out of stock" banner is a **known symptom of an unconvertible ingredient unit**: the availability endpoint fails closed on a line it cannot convert (`needed = -1` → `batches = 0` → `status: 'out'` → summary `cannot_brew`), which displays as out-of-stock even when the item is actually in stock.

That note records the Lactic Acid 88% `L`→`kg` mismatch on `SV-R-000002` as already data-corrected as of 2026-09-01/02. Two possibilities, **neither investigated here**:

1. The owner is recalling the pre-correction state (the toast predates the data fix), or
2. A second ingredient line — on `SV-R-000002` or another recipe — is still carrying an unconvertible unit.

**This is logged as an open question for follow-up only.** It does not change the CONFIRMED verdict above (Phase 79's timeout diagnosis is independently confirmed by the Railway log evidence regardless of this toast), and it is explicitly out of scope for Phase 79, whose fixes target only `updateRecipe`'s round-trip count in `apps-script/adminApi.gs`. Per the resume-signal instruction, the orchestrator is checking the availability endpoint separately — no action taken here.

## User Setup Required

None — no external service configuration required. The `railway` CLI was already authenticated and linked (`sv-middleware` / `production`) from a prior session; nothing new was set up.

## Next Phase Readiness

- **79-02/03/04 are UNBLOCKED.** The diagnosis this whole plan exists to gate is CONFIRMED from the server's own error text, owner-acknowledged. The owner's single manual Apps Script redeploy (spent in a later plan) is now justified.
- **Do not fold the "out of stock" toast observation into 79-02/03/04.** It is a different code path (`validateIngredientUnits` / availability endpoint / unit conversion), not `updateRecipe`'s round-trip count. The orchestrator is tracking it separately.

---
*Phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a*
*Completed: 2026-09-02*

## Self-Check: PASSED

- Verified `.planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-01-SUMMARY.md` exists (this file, just written).
- No commit hashes to verify — this plan made zero source-file commits (files_modified: [] as specified). `git status --porcelain` confirmed no unexpected changes throughout execution.
- No secret values appear anywhere in this document or in the transcript that produced it.
