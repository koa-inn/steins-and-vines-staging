---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
reviewed: 2026-11-11T00:00:00Z
depth: deep
diff_range: 11f122ac..HEAD (HEAD = 144af9e3)
files_reviewed: 10
files_reviewed_list:
  - zoho-middleware/routes/pos.js
  - zoho-middleware/lib/recipe-sale-lines.js
  - zoho-middleware/routes/pos-recipe.js
  - zoho-middleware/lib/brewpad-integration.js
  - zoho-middleware/lib/authTiers.js
  - js/kiosk-core.js
  - js/kiosk.js
  - js/admin.js
  - css/kiosk.css
  - zoho-middleware/lib/kiosk-sale-catalog.js
findings:
  critical: 0
  high: 3
  medium: 5
  low: 4
  info: 0
  total: 12
status: issues_found
---

# Phase 101: Code Review Report

**Reviewed:** 2026-11-11
**Depth:** deep (traced the client wire bodies → `/cart-quote`, `/sale`, `/sale/confirm` → `computeCartPricing` → `recipe-sale-lines`)
**Files Reviewed:** 10
**Status:** issues_found

## Summary

The server's pricing core holds up. `/cart-quote`, `/sale` and `/confirm` all go through the same `computeCartPricing`. Recipe tax is merged per rate group before rounding (entity_level). Package adjustments are worked out per recipe and summed. Product percentage discounts go to Zoho as numbers. Recipe errors after a charge are tagged so the card is voided. The stock 409 releases the sale idempotency lock, so a resubmit with override works. The recipe wire fields (`recipe_id`, `sale_type`, `mill_grain`, `target_volume_l`, `modified_ingredients`) now match `validateRecipeEntries` on both surfaces and every tender, after a8828ab8.

The defects found are at the edges:

1. **Reconcile PUT drops custom-line text (new in mixed carts).** The invoice re-balance PUT re-sends the lines without `description`. Before this phase the PUT only ran on recipe-only invoices. Now it can hit custom and canning-bundle lines, which carry their text only in `description`.
2. **Imported Sales Order ignores recipes.** Recipe entries can sit next to an imported Sales Order, and the SO payment path drops them without telling anyone. The recipe is never charged.
3. **Same class as a8828ab8 (client and server disagree).** The client tests mock `/cart-quote` with a `subtotal` the server never sends, so a recipe cart shows the wrong Subtotal. Adding a custom item or gift card in kiosk.js/admin.js never asks the server for a new price, so the next checkout is always rejected as "Totals changed".

Already known and not re-reported: a8828ab8 (`modified_ingredients: null` rejected) and the empty-ingredient-catalog 503 (fixed in 144af9e3). One remaining trigger of that issue is noted in WR-04.

Severity mapping: critical/high = BLOCKER, medium/low = WARNING.

## Narrative Findings (AI reviewer)

## High (BLOCKER)

### HI-01: Invoice re-balance PUT strips `description` from custom and canning-bundle lines on mixed invoices

**File:** `zoho-middleware/lib/recipe-sale-lines.js:297-307` (called from `zoho-middleware/routes/pos.js:2251`)
**Issue:** `reconcileRecipeInvoice` rebuilds `line_items` from Zoho's echo using only `line_item_id, item_id, name, quantity, rate, discount, tax_id`. Two kinds of line carry their text only in `description` and have no `item_id`:
- custom lines (`pos.js` computeCartPricing custom branch)
- canning-bundle lines (`kiosk-bundles.js:125-136`: `custom: true, description: 'Canning Bundle — …'`)

Before Phase 101 this PUT only ran on recipe-only invoices, which never had such lines. Now it runs on every recipe-bearing invoice, whenever Zoho's total is off by half a cent or more. That is the rounding drift the function exists for (INV-000238).

**Failure scenario:** One sale holds a recipe, a "Bottle rental $5" custom line and a canning bundle. It is paid by card. Zoho's total is $0.01 off, so the PUT re-sends the custom and bundle lines with no `item_id`, no `name` and no `description`. One of two things happens:
- **(a) Zoho rejects the PUT** ("item name or description required"). `reconcileRecipeInvoice` rejects, and the outer catch voids the card. The customer is charged and then refunded, and a draft invoice is left behind with nothing paid against it.
- **(b) Zoho accepts it.** The lines lose their text in the books, including the canning-bundle label that Phase 90 batch/invoice linking reads.

RESEARCH Pitfall 9 / A1 only looked at the `discount` echo, not missing fields. No test sends a custom or bundle line through a reconcile that needs a re-balance.

**Fix:** Copy every field the original payload line had, matching echo lines to payload lines by position (`line_items` keep their order). At minimum:
```js
updated.line_items = invoice.line_items.map(function (li) {
  var out = { line_item_id: li.line_item_id, quantity: li.quantity, rate: li.rate,
              discount: li.discount, tax_id: li.tax_id };
  if (li.item_id) out.item_id = li.item_id;
  if (li.name) out.name = li.name;
  if (li.description) out.description = li.description;
  return out;
});
```
Add a `pos-confirm-recipes` test where Zoho returns a total that is 1 cent off, with a custom line and a bundle line in the cart. Assert that the PUT body keeps both descriptions. Also consider voiding or deleting the draft invoice when reconcile rejects; today it is left as an unpaid orphan (this predates the phase, but mixed carts make it more likely).

### HI-02: Recipe entries survive a Sales Order import, and the SO checkout charges the SO only, dropping the recipes without warning

**File:** `js/kiosk-core.js:5490-5543` (kioskImportSoToCart), `js/kiosk-core.js:3301-3350` (SO checkout fork), `js/kiosk-core.js:5767-5772` (SO "new sale"), `js/kiosk-core.js:1734` (kioskAddRecipeToCart)
**Issue:** Recipes used to be cart keys, so an SO import's "Replace current cart?" prompt plus `setCart(newCart)` removed them. Recipes now live in `getRecipeEntries()`, but:
- `kioskImportSoToCart` only checks `Object.keys(getCart()).length`, so a recipe-only cart gets no prompt.
- It never calls `setRecipeEntries([])`.
- `kioskAddRecipeToCart` has no `_kioskImportedSoId` guard.
- `kioskProceedToPayment` sends any cart with `_kioskImportedSoId` set to `/api/kiosk/salesorder-update` with `items` only, then `kioskCollectPayment(soId)`.

**Failure scenario:** Staff add House Pale (in-store, $180), then import SO-001234 ($60) for the same customer. The cart shows both, and the displayed total comes from a cart-quote that includes the recipe. Checkout updates the SO with its items and charges the SO balance of $60. The recipe is never charged, never invoiced and no BrewPad batch is created, but the customer brews or takes the ingredients. After the SO receipt, "New sale" (5770) runs `setCart({})` and leaves the recipe entries in place, so the next customer's cart starts with House Pale already in it.

**Fix:** In `kioskImportSoToCart`, count recipe entries as "cart not empty" for the confirm prompt and call `_kcEnv.setRecipeEntries([])` + `kioskRequestCartQuote()` when replacing the cart. In `kioskAddRecipeToCart`, refuse with a toast when `_kioskImportedSoId` is set (recipes in SOs are out of scope per CONTEXT). Before the SO checkout fork, add a defensive check: `if (_kioskImportedSoId && _kcEnv.getRecipeEntries().length) { kioskShowError(...); return; }`. Replace the 5770 `setCart({})` with `kioskClearCart()`.

### HI-03: Manual-confirm of a recipe cart that fails to re-price "voids" the literal string `'manual-confirm'` and leaves the real charge in place

**File:** `zoho-middleware/routes/pos.js:2557` (tagged-error branch), `pos.js:1866-1880` (recipe re-price throws before `verifyManualCharge`)
**Issue:** Recipe re-pricing on the confirm leg (`confirmRecipeErr`, missing fee item, `computeCartPricing` failing with 422/400/403/503) throws `__recipeInvalid` before `verifyManualCharge` has turned `'manual-confirm'` into the real Helcim id. The outer catch handles tagged errors as "no charge" only when `!body.transaction_id`. A manual confirm sends `transaction_id: 'manual-confirm'` (kiosk-core.js:3899), so the error falls through to the void path with `_txnIdForVoid = 'manual-confirm'`. The Helcim void of that id fails, `needs_manual_review` is set, and the idempotency lock is held. The customer's real charge is not voided.

The same hole exists for `__taxUnresolved` / `__bundleInvalid`, but Phase 101 adds many new triggers that can only fail after the charge:
- the ingredient catalog is cold (now a Zoho refresh after 144af9e3, which can fail)
- the recipe was deactivated between the two legs
- a unit mismatch
- the fee item is missing from the last-good catalog

The slow-approval memory notes that manual confirm is a common path on this terminal.

**Failure scenario:** The terminal approves after the poll gives up. Staff tap manual confirm. The ingredient refresh fails, so a 503 is thrown. The kiosk shows "Payment was taken but could not be recorded" with `needs_manual_review`. The card is still charged, and the only way out is the reconcile sweep or a manual refund.

**Fix:** In the outer catch, when `body.transaction_id === 'manual-confirm'` and the error has no `__capturedTxnId`, resolve the real id with `helcimLib.pollTerminalResult(refNumber)` before voiding. Alternatively, run `verifyManualCharge` (and set `txnId`) before the recipe re-price and tag the recipe error with `__capturedTxnId`. Add a test: recipe cart, `transaction_id: 'manual-confirm'`, catalog returns null, and assert that `voidTransaction` is called with the polled id.

## Medium (WARNING)

### WR-01: Recipe-cart Subtotal shows products only, after discount (client and server disagree on what `subtotal` means)

**File:** `zoho-middleware/routes/pos.js:577` (`subtotal: pricing.subtotal`), `js/kiosk-core.js:930-937`, `tests/frontend/kiosk-cart-quote-client.test.js:35`
**Issue:** The server's `subtotal` is the discounted subtotal of the non-recipe lines only. The server test even asserts `subtotal + pre_tax + tax_total == total`. The client treats it as the gross cart subtotal and shows it next to a separate Discount row. The client tests mock `{ subtotal: 220, discount_total: 10, tax_total: 5.25, total: 215.25 }` (gross − discount + tax = total), which the server can never produce. This is the same kind of mismatch as a8828ab8: tests on each side passed against a contract the other side does not honour.
**Failure scenario:** On a recipe-only $200 cart the kiosk shows "Subtotal $0.00 · Tax $10.00 · Total $210.00". With a $100 product, a $200 recipe and 10% off it shows "Subtotal $90.00 · Discount −$30.00 · Total $283.50". That looks like a pricing error to the customer at the counter. The money is correct; the display is not.
**Fix:** Have `/cart-quote` return `subtotal = gross(products) + Σ recipe total_before_discount`, or add a `gross_subtotal` field and use that in `kioskCalcTotals`. Then fix the client test fixture to a shape the server really returns. A cheap guard against this class of bug: one contract test that feeds a real `/cart-quote` response from the server test into `kioskCalcTotals`.

### WR-02: Adding a custom item or gift card (kiosk.js / admin.js) never re-quotes, so the next recipe-cart checkout is always rejected as "Totals changed"

**File:** `js/kiosk.js:1104`, `js/kiosk.js:1249`, `js/kiosk.js:1287`, `js/admin.js:10857`, `js/admin.js:10895`, `js/admin.js:11220`
**Issue:** These modals write `_kioskCart[...]` directly and call `kioskRenderCart()`. None of them calls `KioskCore.requestCartQuote()`. In a recipe cart, the totals come only from `_kioskCartQuote`, which stays `status:'ok'` with the old total, so Checkout stays enabled. `client_grand_total` is then the old total, and `/sale` returns 400 "Totals changed" every time.
**Failure scenario:** Recipe in the cart, staff add a $50 gift card issue line. The display still shows the old total and the new line's amount is missing from it. Checkout fails with "Total Changed", which re-quotes, and the second attempt works. This fails safe (the blocking assertion catches it), but it happens on every such cart, and the customer is shown a wrong total until then. The `kiosk-mixed-recipe-*` tests drive KioskCore directly, so they never go through these modals.
**Fix:** Call `window.KioskCore.requestCartQuote()` after each of the six cart writes (or expose an `addLine` helper in KioskCore that does both). Add a test that opens the custom-item modal on a recipe cart and asserts the quote goes back to `pending`.

### WR-03: A double-tap on "Add to cart" now silently adds the recipe twice

**File:** `js/kiosk-core.js:1734-1832`
**Issue:** `kioskAddRecipeToCart` has no in-flight guard. Each tap starts its own `fetch('/api/recipes/:id')` and each one `push`es a new entry. Before this phase a second add replaced the recipe (fixed cart keys). With D-02 (duplicates allowed), the second entry is a real second recipe: it is charged and creates a second BrewPad batch (`unit_total: 2`). Phase 50-04 documented iPad double-tap registrations.
**Failure scenario:** A double-registered tap gives "House Pale #1" and "House Pale #2" at $180 each. If staff don't notice, the customer pays $360 and BrewPad gets two batches.
**Fix:** Set a `_kioskRecipeAddInFlight` flag (and disable the add button) on entry, and clear it in `processRecipeData` and in the `.catch`. Alternatively, drop a second add of the same `recipe_id` with identical parameters that arrives within about 1 s.

### WR-04: The confirm leg deletes `INGREDIENTS_ALL` after every recipe sale, so later stock checks read stale stock

**File:** `zoho-middleware/routes/pos.js:2450-2454`, `zoho-middleware/lib/recipe-sale-lines.js` `getIngredientCatalog`
**Issue:** After each recipe-bearing confirm, the Redis `INGREDIENTS_ALL` key is deleted. `getIngredientCatalog` never writes the file fallback back into Redis, so every later `/cart-quote`, `/sale` and `/confirm` reads `ingredients-all-cache.json`. That file holds the snapshot from the last refresh, taken before any of today's recipe sales. The legacy route did the same, but D-13's combined stock gate now depends on it. After 144af9e3 there is a second effect: when the file is missing (fresh Railway container), the first post-sale `/confirm` (post-charge) now runs a Zoho refresh on the money path, which uses shared quota and voids the card if it fails.
**Failure scenario:** 3 kg of base malt left. Sale A (2.5 kg) completes. Sale B (2.5 kg) passes the stock gate because it reads the 3 kg snapshot, so no override prompt appears. The same staleness hides the effect of today's sales from the recipe-screen availability banner.
**Fix:** Don't delete `INGREDIENTS_ALL` on confirm. Either subtract the sold converted quantities from the cached copy, or apply `ledger.overlayStock` in `getIngredientCatalog`, as `routes/catalog.js` already does for its readers. Also have `getIngredientCatalog` write a file hit back into Redis.

### WR-05: Any `/cart-quote` failure shows "Check the connection" and blocks checkout without saying why

**File:** `js/kiosk-core.js:3178-3215` (kioskRequestCartQuote `apply`), `js/kiosk-core.js:2598-2603`
**Issue:** Every non-2xx response becomes `status:'error'`, and the actionable server message is thrown away. Examples: 403 "Recipe sales are not enabled", 400 "Recipe is not active", 422 unit mismatch, 400 "Recipe fee item not found", 400 "Discount preset is inactive", 400 missing tax. Retrying always fails the same way, and Checkout stays disabled. The total row also shows `$0.00` in the error state, because `pending && !error` decides the "Calculating…" text.
**Failure scenario:** A recipe is deactivated in BrewPad while it is in a cart. Staff see "Couldn't price this cart. Check the connection and try again." and keep retrying, with no hint that the recipe needs removing.
**Fix:** Keep `res.data.error` in the error state and show it, so the "connection" wording is used only for network failures. Show "—" rather than `$0.00` for the total while in error.

## Low (WARNING)

### LO-01: `/cart-quote` can still spend Zoho quota through the fee-tax catalog lookup

**File:** `zoho-middleware/lib/recipe-sale-lines.js:330` (`getFeeCatalogMap` calls `getKioskCatalogForSale()` with rebuild allowed), reached from `priceRecipe` → `withRecipeTax` and from `recipeTaxGroups` in `computeCartPricing`
**Issue:** The route passes `rebuild:false` ("a quote must never spend Zoho quota", D-19). But every confirm deletes `KIOSK_PRODUCTS` (pos.js:2448), so the first in-store recipe quote after any sale triggers `rebuildKioskCatalog()` from inside the fee-tax lookup. The fee tax rate then comes from a freshly rebuilt catalog while product taxes come from the last-good copy.
**Fix:** Pass `{ rebuild: false }` down into `getFeeCatalogMap` (as a parameter) for the quote path, or reuse the `catalogMap` the route already resolved for fee tax.

### LO-02: Combined stock check ignores product lines that sell the same item as a recipe ingredient

**File:** `zoho-middleware/lib/recipe-sale-lines.js:697-745` (`checkCombinedStock`)
**Issue:** Only recipe ingredients are summed. If the cart also sells the same `item_id` as a retail line (for example a 1 kg bag of a malt the recipe uses), the combined need is understated. D-13's intent is "across the whole cart".
**Fix:** Add non-recipe `lineItems` quantities for any `item_id` that is present in the ingredient catalog map before comparing against stock.

### LO-03: `mill_grain` can stay `true` on an in-store entry

**File:** `js/kiosk-core.js:1799-1813`, `js/kiosk-core.js:2397-2402`
**Issue:** If staff tick Mill on take-out and then switch to in-store, `_kioskMillGrain` stays `true`. The server ignores it, but the cart, payment and receipt meta show "Brew in store · Milled".
**Fix:** Store `mill_grain: _kioskSaleType === 'take-out' && _kioskMillGrain`.

### LO-04: The stock-conflict 409 is swallowed when the panel element is missing

**File:** `js/kiosk-core.js:2956`
**Issue:** `if (!conflictEl) return;` returns before any UI change, and the callers have already hidden the spinner. The payment attempt is never ended (`_kioskPaymentInFlight` stays true) and the kiosk is stuck on the payment view. Both shipped pages have `#kiosk-stock-conflict` today, so this is latent.
**Fix:** Fall back to `kioskShowError('Not enough stock', <conflict text>, true)` when the element is absent.

---

_Reviewed: 2026-11-11_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
