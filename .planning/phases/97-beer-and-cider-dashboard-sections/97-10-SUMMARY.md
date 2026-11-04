---
phase: 97-beer-and-cider-dashboard-sections
plan: 10
subsystem: brewpad-ui, kiosk
tags: [brewpad, kiosk, recipe-sale, batches, cal-com]
requires:
  - phase: 97-02
    provides: pos-recipe snapshot builder
  - phase: 97-07
    provides: readyToBottleList() and shared empty copy
provides:
  - "Batches tab chip 'Ready to Bottle (N)' with always-visible live count"
  - "Kiosk in-store recipe batches carry customer_email when a customer with an email is selected"
affects: [97-06 email matching, 97-11, 97-12]
key-files:
  created:
    - tests/frontend/brewpad-ready-to-bottle-filter-97.test.js
    - tests/frontend/kiosk-recipe-sale-email-97.test.js
    - zoho-middleware/__tests__/kiosk-recipe-batch-email-97.test.js
  modified:
    - js/brewpad.js
    - js/brewpad.min.js
    - brewpad.html
    - js/kiosk-core.js
    - js/kiosk-core.min.js
    - kiosk.html
    - zoho-middleware/routes/pos-recipe.js
    - zoho-middleware/lib/brewpad-integration.js
key-decisions:
  - "Ready to Bottle count is readyToBottleRows().length (rows actually listed); equals the widget count when the batch list is loaded"
  - "Email validated server-side (trim, <=254, simple shape); invalid or absent keeps the exact five-argument detectRecipeSale call so pos-recipe test 12 stays green"
  - "Added _setCustomer test accessor to KioskCore, following the existing _set* idiom"
requirements-completed: [TODO-rtb-filter, D-13, D-03]
metrics:
  tasks: 2
  completed: 2026-11-04
---

# Phase 97 Plan 10: Ready to Bottle filter and kiosk recipe email Summary

Batches filter chip now reads "Ready to Bottle (N)" from the same source as the v2 widget, and new kiosk recipe batches keep the selected customer's email so Cal.com packaging bookings can match them.

## Tasks

| Task | Commit | Result |
|------|--------|--------|
| 1. Ready to Bottle (N) chip, live refresh, empty copy | ff562e90 | Badge removed for readyToBottle (pending badge unchanged); label refreshed on every renderBatchList; empty copy "No batches are ready to bottle." |
| 2. Kiosk recipe email pass-through | e0aaa139 | recipe-sale and confirm bodies send customer_email; pos-recipe validates and passes a sixth arg; detectRecipeSale sets batchPayload.customer_email |

## Verification

- Root `npm test` 248 suites / 3391 tests green; `npm run lint` clean; `npm run build` run.
- Middleware full suite under Node 24: 298 suites / 4048 tests green (includes pos-recipe*, brewpad-recipe, brewpad-integration unmodified).
- New tests were confirmed RED before implementation.
- Pinned tests (brewpad-bottled-refetch, brewpad-unlinked-filter, brewpad-pure, dashboard-v2-today, kiosk-recipe-client-totals) pass unmodified.

## Deviations from Plan

**1. [Rule 3 - Blocking] Customer test accessor.** The kiosk test harness had no way to set the selected customer, so I added `_setCustomer` to the KioskCore test-accessor block (same idiom as `_setRecipeContext`).

**2. [Scope note] confirm body.** The plan named recipeSaleBody, but the server reads the email on the `/confirm` leg, which sends its own `confirmBody`. customer_email is added to both bodies. The confirm-body contract is pinned by a source-slice assertion because the confirm leg is driven by the terminal poll.

No existing tests were modified. batch-pg-create.js and adminApi.gs untouched.

## Notes for the owner

- Kit sales (source 'kiosk') still blank customer_email in both create paths, by existing design, so kit-based beer batches will not match a booking by email. Separate question for you.
- Existing kiosk beer batches have no email (no backfill) and stay unmatched unless staff add one.
- Walk-in sales and customers without an email behave as before (no customer_email key).

## Known Stubs

None.

## Threat Flags

None beyond the plan's register (T-97-36a/b: validation and no-logging are tested).

## Self-Check: PASSED

Commits ff562e90 and e0aaa139 exist; all three new test files exist.
