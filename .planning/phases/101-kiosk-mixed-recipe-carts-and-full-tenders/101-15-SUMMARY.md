---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 15
subsystem: deploy / production release
tags: [production, deploy, kiosk, recipes, d-18]
requires: [101-14]
provides:
  - "Phase 101 live on production (prod-20261111-1)"
  - "D-18 soak started 2026-11-11"
key-files:
  modified:
    - docs/RUNBOOK.md
    - .planning/STATE.md
decisions:
  - "Owner chose release-now on 2026-11-11 after the staging re-test and the HI-01 Zoho check"
metrics:
  completed: 2026-11-11
requirements-completed: [MIXR-09]
---

# Phase 101 Plan 15: Production release Summary

Phase 101 and its six pre-production review fixes are live on production as `280eae3e` (tag `prod-20261111-1`), pushed middleware first. The owner confirmed the production kiosk and the first real mixed sale (INV-000271) booked correctly.

## Tasks

1. **Task 1 (owner decision): release-now.** The owner said "on-screen checks passed, go ahead with prod" on 2026-11-11, after the staging re-test (INV-000268 mixed card sale, INV-000269 cash sale on a recipe cart, both verified in Zoho and since deleted) and the HI-01 Zoho behaviour check (draft INV-000270, deleted).
2. **Task 2 (release): done.**
   - Gates on HEAD `280eae3e`: frontend 262 suites / 3595 tests, middleware 315 / 4390 (Node 24), lint clean, build produced stamp-only changes (restored). Commits after the staging-verified `170266fd` are docs-only.
   - Rollback target recorded before the push: `bbca0f28` (prod-20261110-2).
   - 19:09Z `git push production fd4813e2:main --force` (fast-forward); Railway `72fe2707`; health ok with uptime 7 s at 19:11:55Z; unauthenticated cart-quote 403.
   - 19:12Z `git push production main --force` (fast-forward); Railway `78807aa2-4534-4d0c-adb3-79cc412506a1` SUCCESS; health ok with uptime 5 s at 19:14:25Z, quota 774/1000.
   - Tag `prod-20261111-1` on `280eae3e`, pushed to production and origin.
   - Smoke: `/api/products` 200; ingredient catalog warmed (`/api/ingredients` 200); production `kiosk.html` serves `?v=mwch9sxx` and the served `kiosk-core.min.js`, `kiosk.min.js` and `admin.min.js` hash-match the built files.
   - RUNBOOK Deploy History row and STATE line added.
3. **Task 3 (owner verifies production): done 2026-11-11.** After a hard reload (the first load still served the cached old page and showed the old "clear the cart before adding a recipe" toast; kiosk.html is cached for 10 minutes), the owner reported recipes adding next to products and put through a combined phone order. Verified in Zoho and BrewPad:
   - **INV-000271** (Bauman, Ted, ref KIOSK-1794424754241): ONE invoice, $175.33 = sub-total 164.47 + tax 10.53 + adjustment 0.33; paid in full by ONE creditcard payment of $175.33 (Helcim 58160515).
   - Lines: canning bundle "Beer 25 L (355 mL)" $40 with 66 cans at $0, Custom Label Setup Fee $10, 66 labels, then recipe Bavarian Style Lager (in-store, 28 L) with Brewing Fee $45 (GST) and Materials Fee $5 (PST+GST). Non-recipe lines first, then the recipe, as designed.
   - Production BrewPad batch **SV-B-000254** created for the customer, linked to INV-000271, status pending.

## Deviations from Plan

**1. Review fixes rode this release.** The plan predates 101-REVIEW.md. HI-01, HI-03, HI-02, WR-03, WR-02 and WR-01 were fixed with regression tests and re-tested on staging before the release (see `.planning/todos/done/phase-101-pre-prod-review-fixes.md`).

**2. Weak probes.** Unauthenticated `cart-quote` and `recipe-sale` both return 403 because the auth guard runs before routing, so they do not prove the routes exist. The uptime reset after each push and the bundle hash match are the evidence.

**3. Window between the two pushes (about 3 minutes).** Production ran the new middleware with the old frontend, whose recipe checkout uses the retired initiate route. A recipe checkout in that window would have been refused with the refresh message (fail safe, nothing charged). Whether one was attempted was not checked.

## Open items

- Any kiosk iPad or POS tab not yet reloaded still runs the old page until it is hard-reloaded.
- Helcim test transactions 58155163, 58155497 and 58158593: voided by the owner (reported 2026-11-12).
- D-18: delete the legacy `/recipe-sale/confirm` after the soak (`.planning/todos/pending/delete-legacy-recipe-sale-confirm.md`).
- Deferred review findings WR-04, WR-05, LO-01..LO-04 and the stale `docs/DEPLOYMENT.md` host: recorded in `.planning/todos/pending/phase-101-deferred-review-findings.md`.
