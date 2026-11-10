---
title: Delete legacy /api/kiosk/recipe-sale/confirm (Phase 101 D-18 step 2)
status: pending
created: 2026-11-10
source: Phase 101 D-18
area: kiosk money path
priority: medium
---

## What

Phase 101 retired `POST /api/kiosk/recipe-sale` (now a 410 stub) but kept
`POST /api/kiosk/recipe-sale/confirm` so a charge started by a stale cached kiosk
can still be booked. Once the soak is clean, delete:

- the `/api/kiosk/recipe-sale/confirm` route and the 410 initiate stub in `zoho-middleware/routes/pos-recipe.js`
- both `authTiers` entries for those routes
- `LOCK_KEYS.RECIPE_SALE` and its test mocks
- the legacy tests in `pos-recipe-payment-after-submit` (and other tests that drive the legacy confirm)
- the dual-price compare machinery in `pos-recipe.js` (`_dualPriceStats`, `_resetDualPriceStats`, `scheduleDualPriceCompare` and helpers) if it becomes dead code once the legacy confirm is gone, together with `recipe-dual-price.test.js`

## When

After about 1 week on prod with zero `kiosk.recipe_sale_legacy_confirm` events and
no outstanding `kiosk:pending-charge:*` records from the old route.

## How to check

- Search the event stream / Railway logs for `kiosk.recipe_sale_legacy_confirm` over the last 7 days.
- Confirm no `kiosk:pending-charge:` keys older than the soak start remain unreconciled.
