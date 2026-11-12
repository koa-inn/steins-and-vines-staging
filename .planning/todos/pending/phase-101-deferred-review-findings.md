---
title: Phase 101 deferred review findings (WR-04, WR-05, LO-01..LO-04)
status: pending
created: 2026-11-12
source: .planning/phases/101-kiosk-mixed-recipe-carts-and-full-tenders/101-REVIEW.md
area: kiosk recipe carts
priority: medium
---

## What

Six findings from the Phase 101 code review were deferred as not blocking the production release (`prod-20261111-1`, 2026-11-11). The six blocking ones are done (`.planning/todos/done/phase-101-pre-prod-review-fixes.md`). Full write-ups, failure scenarios and suggested fixes are in 101-REVIEW.md under the same ids.

Each fix: regression test first, one commit per fix, both suites + lint, staging first.

## Medium

1. **WR-04: stock checks read a stale snapshot after every recipe sale.** `zoho-middleware/routes/pos.js` (confirm leg, around the `INGREDIENTS_ALL` cache delete) and `getIngredientCatalog` in `zoho-middleware/lib/recipe-sale-lines.js`. Each recipe confirm deletes the Redis ingredient catalog, and a file hit is never written back to Redis, so later quotes and sales read the last-refresh file. Two recipe sales that together exceed stock both pass the stock gate with no override prompt, and the availability banner ignores today's sales. Since 144af9e3 a missing file also means the first post-sale confirm runs a Zoho refresh on the money path (shared quota; a failure voids the card). Fix direction: do not delete the key on confirm; subtract the sold quantities or apply `ledger.overlayStock` as `routes/catalog.js` does, and write file hits back to Redis.
2. **WR-05: every cart-quote failure shows "Check the connection".** `js/kiosk-core.js` `kioskRequestCartQuote` (`apply`) and the quote-error render. The server's actionable message (recipe not active, sales not enabled, unit mismatch, fee item missing, inactive discount, missing tax) is dropped, so staff retry something that can never succeed. The total also shows `$0.00` in the error state. Fix direction: keep and show `res.data.error`; reserve the connection wording for network failures; show a dash for the total.

## Low

3. **LO-01: cart-quote can still spend Zoho quota.** `getFeeCatalogMap` in `zoho-middleware/lib/recipe-sale-lines.js` calls `getKioskCatalogForSale()` with rebuild allowed, and every confirm deletes `KIOSK_PRODUCTS`, so the first in-store recipe quote after any sale rebuilds the kiosk catalog. Pass `rebuild:false` through, or reuse the catalog map the route already resolved. Related: [zoho quota is shared between staging and prod, 1,000 calls/day].
4. **LO-02: combined stock check ignores retail lines for the same item.** `checkCombinedStock` in `zoho-middleware/lib/recipe-sale-lines.js` sums recipe ingredients only; a retail line selling the same `item_id` is not counted.
5. **LO-03: `mill_grain` can stay true on an in-store entry.** `js/kiosk-core.js` recipe add: ticking Mill on take-out and then switching to in-store keeps the flag, so the cart, payment view and receipt show "Brew in store · Milled". The server ignores it. Store `mill_grain` only when the sale type is take-out.
6. **LO-04: stock-conflict 409 is swallowed when the panel element is missing.** `js/kiosk-core.js` stock-conflict render returns early when `#kiosk-stock-conflict` is absent, leaving the payment attempt open and the kiosk stuck. Latent: both shipped pages have the element. Fall back to `kioskShowError`.

## Also noted (not from the review)

- `docs/DEPLOYMENT.md` lists the dead staging host `staging-api.steinsandvines.ca`; the real one is `svmiddleware-staging.up.railway.app`.
- The invoice note reads "In-store kiosk sale (manual confirm)" on every kiosk sale, including phone orders and cash (seen on INV-000269 and INV-000271). Cosmetic, but misleading when reading the books.
- `kiosk.html` / `admin.html` are browser-cached for 10 minutes (`max-age=600`), so a plain reload right after a release can serve the old page (owner hit this on 2026-11-11). Either note "hard reload" in the release steps or have the kiosk detect a new build.

## Not needed

- HI-01 follow-up: none. The Zoho check on 2026-11-11 showed Zoho keeps omitted line fields on an update by `line_item_id`, so the original defect was not live; the fix stays.
