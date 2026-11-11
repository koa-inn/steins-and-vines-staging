---
title: Phase 101 pre-production review fixes (6 findings) + staging re-test
status: pending
created: 2026-11-11
source: .planning/phases/101-kiosk-mixed-recipe-carts-and-full-tenders/101-REVIEW.md
area: kiosk money path
priority: high
blocks: Plan 101-15 (production release)
---

## Where things stand (2026-11-11)

- Plans 101-01..101-14 complete. Staging D-17 gate PASSED (INV-000267: airlock + recipe, one invoice, $100.09 == charge). Owner voided the INV-000266/267 card payments in Helcim; check the Zoho invoices are voided too.
- Staging fixes already live: `a8828ab8` (accept `modified_ingredients: null`), `144af9e3` (getIngredientCatalog rebuilds the catalog instead of 503 when Redis + file are empty).
- Code review: `101-REVIEW.md` (12 findings, 0 critical). Verification: `101-VERIFICATION.md` (11/11 requirements, human_needed).
- Plan 101-15 (prod release) NOT started. It needs owner go-ahead.

## Fix before production (owner agreed to the list, not yet started)

Each fix: regression test first, one commit per fix, full frontend + middleware suites + lint, push to staging only.

1. **HI-01** `zoho-middleware/lib/recipe-sale-lines.js:~297` `reconcileRecipeInvoice`: the cent re-balance PUT re-sends lines without `description`. Custom and canning-bundle lines keep their text only there. Result: Zoho rejects the PUT (card voided, draft invoice left) or blanks those lines. Keep `description` (and any other line fields) on the re-sent lines. Confirm Zoho's behaviour with one staging check.
2. **HI-02** `js/kiosk-core.js:~5490` / `~3301`: recipe entries survive a Sales Order import, and recipes can be added after one. The SO checkout charges only the SO items, so the recipe is unpaid (no invoice or batch) and leaks into the next customer's cart. Clear or block recipe entries on SO import, and block adding recipes in SO mode.
3. **HI-03** `zoho-middleware/routes/pos.js:~2557/2591`: on a manual confirm, a `__recipeInvalid` (or `__taxUnresolved` / `__bundleInvalid`) error thrown before `verifyManualCharge` resolves the real Helcim id voids the literal `'manual-confirm'`. The customer stays charged and the sale goes to manual review. Resolve the real txn id first, or treat `'manual-confirm'` as "no known txn" and route it to the pending-charge sweep with a clear error.
4. **WR-03** Add-to-cart double tap adds the recipe twice, so double charge and two BrewPad batches. Add a re-entrancy guard on the recipe add-to-cart (disable until done).
5. **WR-02** The custom-item and gift-card modals in `js/kiosk.js` and `js/admin.js` (6 sites) never call `kioskRequestCartQuote`. A recipe cart keeps a stale quote and checkout fails with "Totals changed". Request a new quote after these adds.
6. **WR-01** cart-quote `subtotal` is products-only and already discounted, but the client renders it as the gross subtotal (recipe-only cart shows "Subtotal $0.00"). The client test mocks a shape the server can't produce. Align the server field with the client (or render from the right fields) and add a contract test that uses a real server response.

## Then

- Owner staging re-test: one mixed card sale + one cash sale on a recipe cart (verification also suggests gift card and phone order, a duplicate recipe with a discount, and a look at the admin POS).
- Then Plan 101-15 (prod release, middleware first). After the deploy, confirm recipe pricing works (the `144af9e3` fix should self-heal the empty catalog).

## Deferred (follow-up, not blocking)

WR-04 (stock check reads the last refresh snapshot after each sale's cache bust), WR-05 (generic "check connection" message for every quote error), LO-01..LO-04. Also: `docs/DEPLOYMENT.md` lists the dead staging host `staging-api.steinsandvines.ca`; the real one is `svmiddleware-staging.up.railway.app`.
