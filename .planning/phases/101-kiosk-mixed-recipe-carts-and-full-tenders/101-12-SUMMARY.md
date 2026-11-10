---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 12
subsystem: kiosk-ui
tags: [kiosk, admin-pos, recipes, ui, stock-override]
requires: ["101-10", "101-11"]
provides:
  - Grouped recipe cart blocks (.kiosk-recipe-group) in add order
  - Quote pending ("Calculating…") and error row with retry
  - Shared kioskHandleStockConflict for card, cash and phone order
  - Recipe sections on the payment screen and receipt
affects: [js/kiosk-core.js, css/kiosk.css, kiosk.html, admin.html]
key-files:
  created: [tests/frontend/kiosk-mixed-recipe-ui.test.js]
  modified: [js/kiosk-core.js, css/kiosk.css, kiosk.html, admin.html, js/admin.js, js/kiosk-core.min.js, js/admin.min.js, css/kiosk.min.css]
decisions:
  - "Sell anyway fill darkened to #8a5a10 (white on --batch-warning is 3.6:1; this is about 5.9:1)"
  - "Stock panel is lifted to document.body as a fixed overlay on show, because its markup lives in the recipe screen, which is hidden during payment"
  - "Recipe remove button keeps the legacy kiosk-recipe-entry-remove class and the group keeps kiosk-recipe-entry so the Plan 08 cart test passes unmodified"
metrics:
  completed: 2026-11-10
  tasks: 2
  commit: 43f79531
---

# Phase 101 Plan 12: Mixed recipe cart UI Summary

Grouped, individually removable recipe blocks, server-quote pending/error states, one shared "Not enough stock" panel for all tenders, and recipe sections on payment and receipt, identical on the kiosk and admin POS.

## What changed

- **Cart:** items and recipe entries sort by `added_seq` (legacy lines first); each recipe is one `.kiosk-recipe-group` block (name with `#n` only when duplicated, `{L} · Brew in store|Take-out[ · Milled]`, server `pre_tax` total, ingredient and fee lines, a single 44px × with `aria-label`). Add-custom, bundle opener and gift-card buttons always show.
- **Quote states:** total row shows `Calculating…` while pending; on error a `.kiosk-quote-error[role=alert]` row with `Try pricing again`; Checkout stays disabled.
- **Stock panel:** `kioskHandleStockConflict(result, retryFn)` is called from the card, cash and phone-order 409 paths. It groups short items under each recipe, adds "Combined need is more than we have." when an item spans recipes, and offers Sell anyway (same idempotency key, override true) and Back to cart (nothing charged). `#kiosk-stock-conflict`, `.kiosk-stock-conflict-msg`, `#kiosk-stock-override-btn` ids are unchanged.
- **Total mismatch:** a 400 "Totals changed…" on any tender shows "The total changed. Review the cart and check out again." and re-requests the quote.
- **Payment and receipt:** a section per recipe, then other items, one total.
- All names pass through `escapeHTML` (tested with an `<img onerror>` payload).

## Deviations from Plan

- **Both tasks committed together (43f79531).** The cart and panel changes share the same render, CSS and build artifacts, so one green commit was used instead of two (never commit failing tests).
- **[Rule 1 - Bug] Stock panel was invisible during payment.** Its markup is inside the recipe screen (hidden while the payment view shows), so the pre-existing card-path panel could not be seen. Fixed by reparenting to body and styling as a fixed overlay with backdrop (also satisfies "nothing tappable behind it").
- No existing tests were modified; `kiosk-core-parity.test.js` passed as is.
- `js/kiosk.min.js` was unchanged by the build. Other public pages' cache-bust stamp diffs were restored.

## Verification

- New suite: 30 tests (15 per surface) pass. Frontend 3558 tests, middleware 4366 tests (Node 24), lint and build all green.

## Known Stubs

None.

## Self-Check: PASSED
- tests/frontend/kiosk-mixed-recipe-ui.test.js present; commit 43f79531 present.
