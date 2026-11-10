# Phase 101: Kiosk mixed recipe carts and full tenders - Research

**Researched:** 2026-11-10
**Domain:** Express/Zoho money path (zoho-middleware `routes/pos.js`, `routes/pos-recipe.js`) + vanilla ES5 kiosk client (`js/kiosk-core.js`, `js/kiosk.js`, `js/admin.js`)
**Confidence:** HIGH on the code map (read directly, cited file:line); MEDIUM on the recommended design (several items are Claude's-discretion calls flagged in the Assumptions Log)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** A sale can hold SEVERAL recipes. No cap was requested.
- **D-02:** The same recipe can appear more than once, as SEPARATE entries (e.g. 2x House Pale = two entries). Each entry keeps its own batch size, ingredient edits, sale type and milling choice, and creates its own BrewPad batch.
- **D-03:** In-store vs take-out (and mill-grain) is chosen PER RECIPE, exactly as on today's recipe screen. One sale can mix a brew-in-store recipe and a take-out recipe.
- **D-04:** Wine kits (with their maker/materials fees) are allowed in the same sale as recipes. Kit pricing and kit fee behaviour are unchanged.
- **D-05:** Canning bundles are allowed with recipes (today they are blocked: `kioskAddCanningBundle` returns `recipe_cart`). Bundle pricing is unchanged.
- **D-06:** Gift-card issue and reload lines are allowed with recipes; activation still happens only after payment succeeds (existing Phase 44 behaviour).
- **D-07:** In the cart, each recipe renders as ONE grouped block: recipe name, batch size, sale type and recipe total, with its ingredient and fee lines listed beneath. Recipe lines have no +/- stepper and no per-line x. One x on the block removes that whole recipe (and only that recipe).
- **D-08:** Changing a recipe after adding it = remove the block and add the recipe again. No in-place editing in this phase.
- **D-09:** Sales containing recipes allow ALL tenders: card terminal, cash, phone order (MOTO), and gift card alone or split with card / cash / phone order. The tender panel must no longer be skipped for recipe sales.
- **D-10:** Cash on a recipe sale behaves exactly like cash today (tendered + change-due calculator, no manager PIN, books to Zoho as cash). BrewPad batches are created the same as for a card sale.
- **D-11:** Discounts keep today's rules, applied per line across the whole mixed cart: a `scope: 'cart'` preset covers every line (products, kits, recipes, fees); a `scope: 'type'` preset hits only matching lines (e.g. `applies_to: ['recipe']` discounts only recipe parts, `'service'` only fee lines). The charge must equal the sum of what the invoice books.
- **D-12:** Short recipe-ingredient stock keeps today's override prompt, but it must NAME which recipe(s) are short. It happens before any charge. Staff can override (sell anyway - negative stock is an intentional oversell override in this business) or go back and remove that recipe.
- **D-13:** Stock is checked when a recipe is added (today's recipe-screen banner) AND again at checkout across ALL recipes in the cart combined - two recipes can share an ingredient that only covers one.
- **D-14:** If payment succeeds but booking the sale in Zoho fails, keep today's money-path rule: void/refund the WHOLE payment (one sale = one invoice; nothing half-booked). Cash: show the error, nothing booked. Existing idempotency, pending-charge sentinel, manual-confirm verification and orphan-reconcile behaviour must cover recipe-bearing sales exactly as they cover product sales today.
- **D-15:** Both the standalone kiosk and the admin POS get mixed recipe carts (shared `js/kiosk-core.js`; same behaviour on both).
- **D-16:** Straight swap: no on/off switch. The old recipe-only sale route is removed in this phase. (The `BEER_SALES_ENABLED` gate that recipe sales use today must still gate recipe components - see discretion.)
- **D-17:** Production gate: ONE real card sale on the staging terminal containing a recipe + a product, checked in Zoho (one invoice, correct total, stock drop) and BrewPad (batch created), then voided/refunded. The rest is covered by automated tests.

### Claude's Discretion
- How the combined request body carries recipe components (e.g. a `recipes: [...]` array alongside `items`) and how pos.js reuses pos-recipe.js pricing (shared lib extraction vs calling exported helpers). Pricing for a recipe-only cart must stay byte-for-byte equal to today's recipe-sale result.
- Removal mechanics for the old route: deploys of Pages (frontend) and Railway (middleware) are not atomic and kiosk iPads cache JS. Removal must never orphan an in-flight charge - e.g. keep `/api/kiosk/recipe-sale/confirm` (or a safe 410 on the initiate route only) until no old-route charge can still be pending. Keep `GET /api/kiosk/recipe-quote` (still needed for the recipe screen).
- Whether the recipe Redis mutex (`RECIPE_SALE` lock) is kept, generalised, or replaced by the standard sale's idempotency lock.
- Invoice line ordering and the package-price `adjustment` handling when a locked-price recipe shares an invoice with other lines (adjustment must still make the invoice total equal the charge).
- How batches from several recipes plus kits are created (brewpad-integration `detectRecipeSale` / `createBatchesFromSale`), keeping the 97-10 customer-email carry-through.
- Keep `BEER_SALES_ENABLED` gating recipe components inside the combined sale.

### Deferred Ideas (OUT OF SCOPE)
- Tap a recipe block in the cart to edit its batch size / ingredient edits in place (D-08 chose remove-and-re-add for now).
- Importing Sales Orders that contain recipes.
- Out of scope per Phase Boundary: any change to how recipes are scaled, priced or taxed (a recipe-only cart must price identically to today).
</user_constraints>

<phase_requirements>
## Phase Requirements

No IDs are assigned in ROADMAP/REQUIREMENTS yet (ROADMAP.md:1452 says TBD; REQUIREMENTS.md has no Phase 101 block). **Proposed IDs for the planner to add to REQUIREMENTS.md** (new block "v5.0 follow-up - Phase 101", same format as Phase 99's RESP/PERF IDs):

| ID | Description | Research Support |
|----|-------------|------------------|
| MIXR-01 | One kiosk/admin-POS cart holds N recipe entries (same recipe repeatable, each with own batch size/edits/sale type/milling) alongside products, kits, bundles, custom items and gift-card lines; adding a recipe never clears the cart (D-01..D-06, D-08) | Frontend state map (section "Frontend"), `recipes[]` body contract |
| MIXR-02 | `/api/kiosk/sale` + `/confirm` price recipe components server-side with the SAME recipe pricing/unit conversion/discount/tax; a recipe-only cart prices byte-for-byte as today (characterization tests) | Lib extraction + pricing core ("Cleanest reuse") |
| MIXR-03 | One Zoho invoice and one payment per mixed sale; combined entity-level tax; summed package-price adjustment; invoice total == charge | Tax/adjustment sections, `reconcileRecipeInvoice` generalisation |
| MIXR-04 | Every kiosk tender works for recipe-bearing sales: terminal, cash, MOTO, gift card alone/split (D-09, D-10) | Tender branch map; tender panel unskip |
| MIXR-05 | Discount presets apply per line across the mixed cart (cart vs type scopes, `recipe`/`service` tokens) and charge == invoice (D-11) | Discount design |
| MIXR-06 | Pre-charge combined stock check across all recipes; 409 names the short recipe(s); override works on every tender (D-12, D-13) | Stock section |
| MIXR-07 | Money-path parity for recipe-bearing sales: idempotency, pending-charge sentinel, manual-confirm + MOTO/captured-amount verification, void-whole-payment on booking failure, orphan reconcile (D-14) | Confirm map |
| MIXR-08 | One BrewPad batch per in-store recipe entry (duplicates of one recipe all created), kit batches unaffected, kiosk customer_email carried to recipe batches | Batch section (`unit_total` pitfall) |
| MIXR-09 | Old recipe-only initiate route removed without orphaning in-flight charges; `BEER_SALES_ENABLED` gates recipe components (D-16) | Removal mechanics |
| MIXR-10 | bbca0f28 recipe-cart guard removed on kiosk and admin POS; docs updated (D-15) | Frontend section |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Treat as locked (same authority as CONTEXT decisions):
- Frontend is **vanilla ES5** (no `let/const/arrow/template literals`) in `js/`. **Never edit `js/main.js` / `js/main.min.js`**; `js/kiosk-core.js`, `js/kiosk.js`, `js/admin.js` ARE source files (bbca0f28 edited them) - after any JS/CSS change run `npm run build` (regenerates `*.min.js`, `*.min.css`, and the `?v=` stamps in `kiosk.html`/`admin.html`).
- **Before every commit:** `npm test` AND `cd zoho-middleware && npm test` (middleware: use Node 24 - `source ~/.nvm/nvm.sh && nvm exec 24 npm test`; the vancouver-timezone test fails on Node 20) AND `npm run lint`.
- **Bug-fix rule:** regression test FIRST, then fix; ONE logical change per commit.
- **Rule 10: do NOT modify existing tests unless explicitly asked.** This phase unavoidably invalidates many existing tests (list in "Existing tests") - the planner MUST put an explicit "owner approval to update/replace these tests" checkpoint in the plan. Owner already approved removing the bbca0f28 guard tests (CONTEXT canonical_refs); the rest need explicit mention.
- Rule 7: after changing a shared utility (`zoho-middleware/lib/*.js`, `js/lib/*.js`) run the FULL suites for both frontend and middleware.
- Rule 12: no new public page / third-party domain is introduced - CSP not touched.
- Staging first (`git push origin main`), never push to production without staging approval. Middleware has its own `node_modules`: always `cd zoho-middleware` first.
- Memory constraints: negative Zoho stock is an intentional oversell override (never "fix" it); Zoho Inventory quota is 1,000 calls/day shared staging+prod; Zoho tax rounding is `entity_level` (round per rate group across the invoice); the `gemini` CLI is broken (use grep + Read).

## Summary

The two sale routes are structurally parallel (initiate -> terminal push + pending-charge sentinel -> poll -> confirm -> invoice -> payment -> void on failure) but diverge in the pricing core: `/api/kiosk/sale` prices lines from the **kiosk products catalog** (`zoho:kiosk-products`) with a per-line discount (`resolveDiscount`, pos.js:157) and Zoho-rate-group tax (`computeTax`, pos.js:250), whereas the recipe route prices from the **ingredients catalog** (`INGREDIENTS_ALL`, Redis then file fallback, pos-recipe.js:69) with unit conversion (`ingredientLineCost`), recipe-level discount (`computeRecipeDiscount`, pos-recipe.js:115), a locked-package `adjustment` and a post-create `reconcileRecipeInvoice` (pos-recipe.js:275). The recipe route has NO cash/MOTO/gift-card support, always captures on the terminal, and is the only route with a stock gate (409 + override) and an inventory mutex.

The cleanest merge is: (1) extract the pure recipe helpers from `pos-recipe.js` into a new `zoho-middleware/lib/recipe-sale-lines.js` (pricing wrapper, line builder, discount math, tax contributions, stock check, invoice-line assembly) with `pos-recipe.js` re-exporting them so existing tests keep passing untouched; (2) add an optional `recipes: [...]` array to the `/sale` and `/confirm` bodies, lazily `require`d only when non-empty so the ~10 existing pos.js test files that mock modules are unaffected; (3) price recipe entries into extra invoice lines + a per-recipe pre-tax total, merge their tax into the SAME rate-group map as product lines **before** rounding (entity-level rounding across the whole invoice), sum per-recipe package adjustments into the single invoice `adjustment`, and run the generalised `reconcileRecipeInvoice` when any recipe is present. All existing tender branches, idempotency, manual-confirm / MOTO / captured-amount verification, gift-card redemption, void-on-failure and orphan reconcile then apply to recipe sales with no extra code, because they only see `grandTotal`.

Four non-obvious hazards decide the plan structure: **(a)** `createBatchesFromSale` + Maker's Fee detection would misread recipe fee/ingredient lines - recipe lines must be excluded from it; **(b)** two entries of the same recipe collide on the BrewPad dedup key (invoice + SKU) unless `unit_total` is passed (D-02 breaks otherwise); **(c)** tax must be grouped across recipe AND product lines before rounding or totals drift a cent; **(d)** the confirm leg must never bare-4xx after a charge for recipe-specific failures (old recipe confirm did exactly that for the 403 gate and the stock 409). A server-side `POST /api/kiosk/cart-quote` is recommended so the client displays exactly what the server will charge for multi-recipe discounted carts (otherwise the Phase-67 total assertion cannot safely block recipe carts).

**Primary recommendation:** Extract `lib/recipe-sale-lines.js`, add `recipes[]` to `/sale` + `/confirm` (lazy-required), add a read-only `/api/kiosk/cart-quote`, convert the client's single `_kioskRecipeContext` into a list of recipe entries rendered as grouped blocks, then replace `/api/kiosk/recipe-sale` with a 410 while keeping `/recipe-sale/confirm` (+ usage event) for an in-flight soak window, and write recipe-only characterization tests BEFORE touching pricing.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Recipe pricing, unit conversion, discount, tax, stock check | API / Backend (lib) | - | Server-authoritative; client totals are never trusted (pos.js:336-362) |
| Mixed-cart display totals | API / Backend (`cart-quote`) | Browser (renders, debounces) | Entity-level tax + cross-unit discount cannot be mirrored exactly client-side |
| Cart state (recipe entries list), grouped block rendering | Browser / Client | - | `js/kiosk-core.js` shared by kiosk + admin POS |
| Tender selection (terminal/cash/MOTO/gift) | Browser / Client | API (tender branch) | Existing panel (`kgcr-*`), server branches pos.js:860-1019 |
| Idempotency, pending-charge sentinel, void-on-failure | API / Backend | Redis | Existing money-path; unchanged |
| Invoice + payment booking | API / Backend -> Zoho Books | - | One `POST /invoices`, `/submit`, `/customerpayments` |
| Stock decrement (Zoho) | Zoho (via invoice submit) | Redis ledger (products only) | Converted quantities on invoice lines drive Zoho deduction (Phase 73) |
| BrewPad batch creation | API / Backend (brewpad-integration) -> Postgres/Apps Script | - | Fire-and-forget after confirm |
| Old-route retirement / deploy ordering | API / Backend + CDN (Pages) | - | Non-atomic deploys, cached iPad JS |

## Standard Stack

No new libraries. **No `## Package Legitimacy Audit` needed** - this phase installs no external packages (slopcheck not applicable). All reuse is internal:

### Core (existing, reuse - do not fork)
| Module | Purpose | Note |
|--------|---------|------|
| `zoho-middleware/lib/recipe-scaling.js` (`scaleIngredients`, `computeScaledRecipeTotal`, `computeModifiedRecipeTotal`, `checkScaledStock` L188, `ingredientLineCost` L387) | Recipe pricing + unit conversion | Reuse verbatim [VERIFIED: code read] |
| `zoho-middleware/lib/money-path.js` (`acquireIdempotencyLock`, `voidWithTimeout`, `CHECKOUT_IDEMPOTENCY_TTL=600`) | Idempotency/void | Unchanged |
| `zoho-middleware/lib/kiosk-sale-catalog.js` (`getKioskCatalogForSale`) | Last-good kiosk catalog | `rebuild:false` for quote/confirm |
| `zoho-middleware/lib/brewpad-integration.js` (`detectRecipeSale` L855, `createBatchesFromSale` L372) | Batches | Needs a small `unit_total` extension |
| `zoho-middleware/lib/discount-match.js` | `classifyCatalogItem`/`matches` for type-scope | Recipe tokens `recipe`/`service` are handled by recipe helpers, not this classifier |
| `zoho-middleware/lib/kiosk-bundles.js` | Server-built canning bundle | Unchanged |
| Jest (frontend jsdom + middleware) | Tests | Existing harnesses |

### New internal module
| Module | Purpose |
|--------|---------|
| `zoho-middleware/lib/recipe-sale-lines.js` | Pure/pricing helpers moved out of `pos-recipe.js` (see "Cleanest reuse") |

**Installation:** none. **Version verification:** n/a (no packages).

## Architecture Patterns

### System Architecture Diagram

```
Kiosk / Admin POS (js/kiosk-core.js)
  cart{} products/kits/bundle/custom/gift_cert  +  recipeEntries[] (grouped blocks)
        |  (debounced, only when recipeEntries non-empty)
        +--> POST /api/kiosk/cart-quote {items, recipes, discount}  --> server totals + stock + per-recipe totals
        |       (read-only: no lock, no charge, no invoice, rebuild:false catalog)
        v
  tender panel (terminal | cash | moto | gift card alone/split)  -- no longer skipped
        |
        v
POST /api/kiosk/sale  {items, recipes[], tender, gift_card, discount, override,
        |              client_grand_total, idempotency_key, reference_number, customer_*}
        v
  tender allow-list -> idempotency lock (300s) -> res.on('finish') releases lock on >=400
        v
  validate: items OR recipes non-empty; BEER_SALES_ENABLED if recipes (403)
        v
  resolve kiosk catalog (isUsable also requires fee item ids when recipes have fees)
        +--> non-recipe lines (bundle/custom/gift_cert/product)   [existing code, unchanged]
        +--> lib/recipe-sale-lines: per recipe entry -> loadRecipe (Postgres) -> priceRecipe(no discount)
        |        ingredient catalog loaded ONCE per request (Redis -> file fallback; no Zoho call)
        v
  combined stock check (aggregate per item_id across recipes)  --409 {conflicts[+recipes]}-->  client override prompt
        v
  unified discount (per-line for products; recipe base units; fixed = cart-wide allocation)
        v
  unified tax: merge rate-group maps (products + recipe ingredients + fee lines) -> round per group
        v
  grandTotal = products_discounted + sum(recipe preTax) + tax ; assertion vs client_grand_total
        v
  tender branch: cash(202 pending:false) | moto(HelcimPay init) | terminal(push + pending sentinel) | gift-only
        v   ... poll /api/kiosk/sale/status (unchanged) ...
POST /api/kiosk/sale/confirm  {items, recipes[], transaction_id|none, tender, ...}
        v
  confirm idem lock -> re-price everything server-side (same core) -> verify manual-confirm / MOTO / captured amount
        v
  ONE invoice: [product lines][recipe 1 ingredient+fee lines][recipe 2 ...] + adjustment(sum) -> reconcile(if recipes)
        v  /submit -> customerpayments (cash|creditcard) -> gift-card payment -> gift-card store last step
        v
  cache bust (KIOSK_PRODUCTS, + INGREDIENTS/INGREDIENTS_ALL/RECIPES_TS if recipes) ; ledger.decrementStock(product lines only)
        v
  batches: createBatchesFromSale(product/kit lines ONLY)  +  detectRecipeSale per in-store entry (unit_total)
        v
  clear pending sentinel ; cache result ; 201 receipt   --failure after charge--> void WHOLE payment (existing outer catch)
```

### Recommended Project Structure
```
zoho-middleware/
├── lib/recipe-sale-lines.js      # NEW: moved helpers + mixed-cart recipe pricing/invoice-line assembly
├── routes/pos-recipe.js          # keeps /recipe-quote (+ legacy /recipe-sale 410, /recipe-sale/confirm soak); re-exports moved helpers
├── routes/pos.js                 # /sale + /confirm accept recipes[] (lazy require of the lib); new /cart-quote
├── lib/brewpad-integration.js    # detectRecipeSale gains optional {unit_total}
└── lib/authTiers.js              # add '/api/kiosk/cart-quote'
js/kiosk-core.js                  # recipe entries list, grouped block, cart-quote client, tender unskip
js/kiosk.js, js/admin.js          # env bridge: getRecipeEntries/setRecipeEntries (replaces getRecipeContext)
css/kiosk.css                     # .kiosk-cart-recipe-block styles (then npm run build)
```

### Complete map 1: `/api/kiosk/sale` (pos.js) - what must be preserved

| Stage | Where | Behaviour |
|---|---|---|
| Tender allow-list | pos.js:369-386 | `terminal` (default)/`cash`/`moto`; terminal needs `isTerminalEnabled()`, moto needs `isEnabled()` |
| Idempotency | pos.js:395-420 | `KIOSK_IDEM_PREFIX + key` (required in prod), `acquireIdempotencyLock(..., 300s)`; replay -> 201 cached; contention/failclosed -> 409 |
| Lock release on failure | pos.js:486-492 | `res.on('finish')` releases lock on any status >= 400 (so a 409 stock conflict can be resubmitted with the same key) |
| Validation | pos.js:494-534 | `items` non-empty (**must be relaxed to "items OR recipes"**), <=50, bundle/custom/gift_cert/product structural checks |
| Catalog | pos.js:543-575 | `getKioskCatalogForSale` w/ `isUsable` = every cart item present; rebuild on miss; stale fallback |
| Bundle | pos.js:80, 580 | `prepareBundleContext` (400 pre-charge) |
| Gift-cert guards / custom GST | pos.js:587-620 | 503/400 pre-charge |
| Line build | pos.js:625-696 | bundle/bundle-can/custom/gift_cert/product lines from catalog (client rate ignored) |
| Discount | pos.js:157-228, 700 | `resolveDiscount`: cart/type scope, % per line or fixed allocated with last-line remainder; custom/gift_cert excluded (D-08) |
| Tax | pos.js:250-293, 711 | `computeTax`: per rate group, `_TAX_RULE_PCT` override, entity-level rounding; fail-closed on unresolved tax |
| Totals | pos.js:716, 739-744 | `grandTotal = round(subtotal+tax)`; 400 if <=0 or >10000 (**new limit for recipe sales**) |
| Pre-charge assertion | pos.js:755-783 | **BLOCKS** (400 + lock release + `kiosk.total_mismatch`) if `|client_grand_total - grandTotal| > 0.01` |
| Gift card | pos.js:793-852 | clamp to grandTotal; real-balance lookup (503 prod unavailable); `terminal_amount = grandTotal - gift_amount` |
| Cash | pos.js:860-882 | 202 `{pending:false,cash:true}`; no sentinel |
| MOTO | pos.js:883-945 | `initializeCheckout(terminal_amount)`; sentinel with `tender:'moto'`; 502 + lock release on failure |
| Terminal | pos.js:946-998 | `terminalPurchase(terminal_amount, ref, sha256(idempotency_key))`; sentinel `KIOSK_PENDING_CHARGE_PREFIX+ref` (7d TTL); 502 + lock release on failure |
| Gift-only | pos.js:999-1019 | 202 `{pending:false, gift_card_only:true}` |

### Complete map 2: `/api/kiosk/sale/confirm` (pos.js:1196)

| Stage | Where | Behaviour |
|---|---|---|
| Confirm idem key | pos.js:1210-1243 | seed = idempotency_key -> transaction_id -> reference_number; `confirm:` prefix; replay only when cached `.ok === true` |
| Failure lock release | pos.js:1257-1263 | `res.on('finish')` releases on >=400 unless `res.locals.__keepIdemLock` (void failed) |
| Catalog | pos.js:1268-1291 | `rebuild:false`; 400 if a cart item missing |
| Tagged-error idiom | pos.js:1297-1302, 1425-1431, 1981-2014 | `__bundleInvalid`, `__taxUnresolved`: 400 only when `!body.transaction_id`, else fall into void path. **Recipe failures must use this same idiom.** |
| Re-price | pos.js:1340-1433 | same builders as /sale (re-derived, never trusted) |
| Invoice payload | pos.js:1449-1480 | `line_items` (gift_cert fields stripped), notes, `customer_id` contact or `KIOSK_CONTACT_ID`, consignment custom fields |
| Gift card | pos.js:1482-1583 | re-clamp, real-balance lookup, `ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID` fail-closed (voids terminal charge) |
| Manual-confirm verify | pos.js:1593-1609 | `pollTerminalResult(refNumber)`; `__manualVerify` -> 400 declined / 409 unverified, nothing booked |
| MOTO verify | pos.js:1625-1676 | txn APPROVED + amount == terminalApplied (+-0.01) |
| Captured-amount verify | pos.js:1690-1723 | strict both directions; mismatch -> 402 + void |
| Invoice/payments | pos.js:1725-1790 | `POST /invoices` -> `/submit` -> cash or creditcard payment -> gift-card `others` payment (clearing account) |
| Gift-card store last step | pos.js:1793-1908 | redeem / issue / reload AFTER all Zoho calls; failures set `gift_card_activation_failed` |
| Payment-record failure | pos.js:1910-1916 | **rethrown -> outer void** |
| Post-success | pos.js:1919-1962 | `cache.del(KIOSK_PRODUCTS)`, `ledger.decrementStock(lineItems)`, `createBatchesFromSale(lineItems,...)`, sentinel delete, cache result, 201 |
| Outer catch / void | pos.js:1981-2088 | `__manualVerify`; tagged pre-charge 400; else void real txn id (`__capturedTxnId` preferred) via `moneyPath.voidWithTimeout`; `payment_voided`, `needs_manual_review`, `__keepIdemLock` on void failure |

### Complete map 3: recipe route (pos-recipe.js) - what moves, what stays

| Piece | Where | Disposition |
|---|---|---|
| Ingredient catalog (Redis then file fallback) | pos-recipe.js:69-82 | Move to lib. **Load once per request**, share across entries |
| `computeRecipeDiscount(preset, grandTotal, feePortion)` | :115 | Move (still re-exported - tests import it) |
| `distributeRecipeDiscount(lines, feeIds, preset, amount)` | :155 | Move |
| `recipeFeeItemIds()` | :197 | Move (`MAKERS_FEE_ITEM_ID`, `MATERIALS_FEE_ITEM_ID`, `MILLING_FEE_ITEM_ID`) |
| `buildRecipeLineItems(recipe, scaled, catalogMap, saleType, millGrain)` | :210 | Move. Converted qty rounded to 3dp (`:224`); fee lines `Brewing Fee`/`Materials Fee` (in-store) or `Milling Fee` (take-out+mill) |
| `reconcileRecipeInvoice(created, payload, grandTotal)` | :275 | Move + generalise (see below) |
| `recipeLineAmount`, `getFeeCatalogMap`, `computeRecipeTax` | :320-392 | Move. **Split** into `recipeTaxGroups()` returning un-rounded `{byRate}` so it can merge with product tax before rounding |
| `priceRecipe(data, rawTarget, saleType, millGrain, modifiedIngredients, discountReq)` | :602 | Move; mixed cart calls it with `discountReq=null` (discount is applied at cart level). Contains: active check, `batch_size_l`>0, `target_volume_l` (<=10x), scaling, D-02 pre-charge unit-conversion fail-closed (422), `checkScaledStock`, `computeScaledRecipeTotal`/`computeModifiedRecipeTotal`, milling, `feePortion`, rejects with `{status, body}` |
| `scheduleDualPriceCompare` | :544 | Keep per recipe entry (observational, fire-and-forget; D-06 always charge Postgres price) |
| `computeRecipeQuote` | :764 | Keep (recipe screen + `GET /recipe-quote`) |
| `POST /recipe-sale` initiate | :779-967 | **Replace with 410** (after the merged route is live). Behaviours to carry over: BEER_SALES_ENABLED 403 (:781), stock 409 + override (:846), RECIPE_SALE mutex (:887), kiosk-reference as sentinel key (:896), Helcim idem key from client key (:903), sentinel with `amount` (:927) |
| `GET /recipe-quote` | :975 | **Keep** unchanged |
| `POST /recipe-sale/confirm` | :1078-1648 | **Keep for the soak window** (usage event), then delete (see "Removal mechanics") |

### Cleanest reuse: pricing core design

**Request body contract (additive, backwards compatible):**
```
recipes: [ { recipe_id, sale_type: 'in-store'|'take-out', mill_grain: bool,
             target_volume_l, modified_ingredients: [...]|omitted } ]
override: bool                      // stock override, same meaning as the old recipe route
customer_name, contact_id, customer_email   // email only used for recipe batches (97-10)
```
Server ignores any client price for recipes (re-derives from the recipe store). Defensive bounds: `recipes.length` <= 25 (server sanity cap; CONTEXT says no *product* cap requested - [ASSUMED] harmless, see Assumptions).

**Per-request flow in the lib** (`priceRecipeEntries(recipes, kioskCatalogMap)`):
1. Load the ingredient catalog ONCE (`getIngredientCatalog`), then for each entry `loadRecipe` (Postgres via `recipe-store.get`, no Zoho) and call the moved `priceRecipe(..., discountReq = null)`. A rejection `{status, body}` is propagated as a tagged error (pre-charge: plain `res.status`; confirm: tagged -> void path).
2. Each entry yields `{recipe, scaledIngredients, catalogMap, grandTotal(pre-discount,pre-tax), feePortion, pricingMode, stockCheck, lines = buildRecipeLineItems(...)}`.
3. Pass the kiosk catalogMap as the **fee map** (fee tax lives on the kiosk catalog, pos-recipe.js:324-343) instead of calling `getFeeCatalogMap()` again - saves a catalog resolution (and a possible Zoho rebuild).

**Discount (D-11).** Keep `resolveDiscount` byte-identical for product-only carts; add an optional 5th parameter `recipeUnits` (undefined = today's behaviour). Units per recipe entry: `base = {product: grandTotal - feePortion, fee: feePortion}`; a unit is targeted per `computeRecipeDiscount`'s rule (`scope cart` -> product+fee; `type` -> `recipe` token = product portion, `service` = fee portion). Then:
- **percentage:** product lines per-line as today (`round2(lt*pct/100)`); each recipe entry `amount_r = round2(base_r * pct / 100)` (exactly `computeRecipeDiscount`, so a recipe-only cart is identical to today, including single rounding over product+fee).
- **fixed:** `fixed = min(value, nonRecipeMatchedSubtotal + sum(base_r))`; allocate over the ordered units `[product lines..., recipe units...]` with the existing `allocateFixedDiscount` (pseudo-line `{quantity:1, rate: base_r}`, last unit absorbs the cent remainder). A single recipe gets `min(value, base)` == today.
- Per recipe, apply its `amount_r` through the moved `distributeRecipeDiscount` over that recipe's invoice lines (numeric `li.discount`).
- `discountApplied` = merged `{preset_id,name,type,value,scope,applies_to,amount: total}`.

**Tax (entity_level, critical).** Zoho rounds tax per rate group across the whole invoice. Today product tax (`computeTax` pos.js:250) and recipe tax (`computeRecipeTax` pos-recipe.js:352) each round their own groups; summing two rounded totals can drift one cent when the same rate (12%, 5%) appears in both. Refactor both into group-collectors (`taxGroups(lines, catalogMap) -> {byRate}|{error}`; `computeTax`/`computeRecipeTax` become thin wrappers with unchanged results) and in the mixed path merge `byRate` maps, then `Object.keys(byRate).reduce(round2 per group)`. Keep each side's own rate resolution (products use `_TAX_RULE_PCT` first; recipe ingredient lines use `tax_percentage`, fee lines use the kiosk catalog and fail closed). [VERIFIED: pos.js:289-292, pos-recipe.js:386-388]

**Package-price `adjustment` with several locked recipes.** Zoho has one invoice-level `adjustment` (untaxed). Today `adjustment = preTaxTotal - Sum(recipeLineAmount(lines))` for the one recipe (pos-recipe.js:1436-1442). Mixed: compute it **per recipe** (`preTax_r_after_discount - Sum lineAmount(r lines after discount)`) and SUM the per-recipe values into the single `invoicePayload.adjustment` (`adjustment_description: 'Recipe package price'`). Do NOT compute a cart-wide `grandTotal - lineSum`: product lines are summed unrounded in pos.js (`discountedLineTotal`, pos.js:221-226) while recipe lines are cent-rounded per line, so a global diff would inject spurious cents into product-only-looking remainders. Then apply the generalised `reconcileRecipeInvoice` (re-read Zoho's total, rebalance <= $1 gap, else reject -> void) **only when `recipes.length > 0`** so product-only carts keep today's exact behaviour.

**Invoice line ordering:** product/kit/bundle/custom/gift lines first (existing order), then each recipe in cart order: ingredient lines, then its fee lines. Put recipe labels in `notes` (`'Kiosk sale. Recipes: House Pale (in-store, 20 L), ... Ref: ...'`), not new line fields, to keep line shapes identical to what `pos-recipe-zoho-line-fidelity.test.js` pins.

**Phase 67 assertion unification (decision needed).**
- *Recommended (Option A):* add read-only `POST /api/kiosk/cart-quote` using the same core; client displays server totals for any cart containing recipes (disabling Checkout until the quote is fresh) and sends that as `client_grand_total`. The assertion then stays **blocking for all carts** (equality by construction; also protects the new-client/old-middleware deploy order - an old `/sale` would 400 on a total that includes unseen recipes).
- *Fallback (Option B, smaller):* assertion blocking when no recipes, **log-only + `kiosk.total_mismatch` event (with `has_recipes:true`)** when recipes are present, mirroring today's recipe route (pos-recipe.js:857-884); client mirrors totals using per-entry quotes. Cannot be exact for multi-recipe fixed discounts or cross-group tax, so display drift is possible.

### Combined stock check (D-12 / D-13)
`checkScaledStock` (recipe-scaling.js:188) works per call and per line. For the cart: accumulate `needed` per `item_id` using each line's `ingredientLineCost(...).convertedQty` across **all** entries (and all lines - today a hop listed twice is checked per line, not summed; summing is the correct D-13 semantic and is a deliberate, small strictness increase), compare with `catalogMap[item_id].stock_on_hand`, and return conflicts `{item_id, item_name, needed(combined), stock, unit, recipes:['House Pale','Saison']}` plus `recipes_short: [{index, recipe_id, name}]`. A non-convertible unit stays a conflict (fail closed, as today). Respond `409 {error:'Insufficient stock for scaled batch', conflicts, recipes_short}` from `/sale` BEFORE any tender branch (cash and gift-only must be gated too) and from `/cart-quote` as `stock`. Honour `body.override === true`. At `/confirm` do **not** 409 on stock (a charge may exist; the old recipe confirm did - pos-recipe.js:1344-1350 - and would leave a captured card un-voided): log + `eventLog` only. [VERIFIED: code read]

### Batches (brewpad-integration)
- **Exclude recipe lines from `createBatchesFromSale`.** `detectKitItems` -> `findMakersFeeItem` matches on `MAKERS_FEE_ITEM_ID` (checkout-helpers.js:170-180); recipe in-store fee lines use the SAME item id (pos-recipe.js:246), and every ingredient line would otherwise look like a "kit". Pass only the non-recipe line array (`lineItems` before recipe lines are appended). Kit batch counts/`unit_total`/label sync stay exactly as today.
- **`unit_total` for duplicate recipes (D-02).** The batch dedup key is `zoho_so_number + product_sku` with `allowedUnits = unit_total || 1` (batch-rules.js:305-333, batch-pg-create.js:112-117, apps-script/adminApi.gs:2558). `detectRecipeSale` uses `product_sku: recipeId` and sends no `unit_total` (brewpad-integration.js:858-871), so the 2nd entry of the same recipe on one invoice is rejected as `duplicate_so_number` and ends in the retry queue. Extend `detectRecipeSale(..., customerEmail, opts)` with `opts.unit_total` = number of in-store entries with that `recipe_id` in this sale.
- Create one batch per **in-store** entry (take-out creates none - existing D-09/D-10 rule, pos-recipe.js:1517). Snapshot per entry (`typedSnapshotIngredients`, `snapshotGravity`) exactly as today (pos-recipe.js:1518-1535). Pass the validated kiosk `customer_email` to recipe batches only (97-10, pos-recipe.js:1536-1562); kit batches keep omitting it (D-09 privacy).
- Known limitation to accept/flag: the Zoho `cf_batch_status` label sync in `createBatchesFromSale` counts kit batches only; recipe batches never synced it (unchanged).

### Removal mechanics for the old route (D-16)
Failure modes: (1) new JS + old middleware -> `/sale` would book a sale without the recipes. Mitigated by deploying the **middleware first** and by the blocking assertion / `cart-quote` 404 (client refuses to check out a recipe cart when `cart-quote` is unavailable). (2) old cached iPad JS + new middleware -> old client calls `/recipe-sale`. (3) a charge in flight on the old route during the deploy -> its `/recipe-sale/confirm` must still be served or the card is charged-but-unbooked (the orphan reconcile sweep would later void it, `lib/reconcile.js` is keyed on `KIOSK_PENDING_CHARGE_PREFIX` + invoice-reference lookup and is route-agnostic - no change needed there).

Plan: **Release N** = new `/sale` recipes support + `cart-quote` + new client; `POST /recipe-sale` returns `410 {error:'Recipe checkout has been updated - reload the kiosk'}` (pre-charge, no money moves); `POST /recipe-sale/confirm` stays as-is, emits `eventLog('kiosk.recipe_sale_legacy_confirm')` each use; `GET /recipe-quote` stays. **Release N+1** (only after prod soak: >=24h, 0 legacy-confirm events, no `kiosk:pending-charge:RECIPE-*`-style records from the old route outstanding) deletes the legacy confirm + its helper copy + `RECIPE_SALE` lock key. `authTiers.js:54-56` and server.js mount stay until then. If the owner insists on D-16 "removed in this phase" literally, make N+1 the final plan gated on soak and say so explicitly (see Open Questions).

### RECIPE_SALE mutex (discretion): recommend DROP
It is a global 30 s Redis lock taken before the terminal push and (mostly) already expired by the time a slow approval (~56 s incidents) reaches confirm (pos-recipe.js:887, constants.js:112). It reserves no stock (oversell is intentional), blocks the second station (kiosk + admin POS) with a 503, and duplicate-charge protection already comes from the client idempotency lock + the deterministic Helcim idempotency key (pos.js:955-957). Replace with the standard sale idempotency lock; keep the `LOCK_KEYS.RECIPE_SALE` constant until N+1 (the legacy confirm still releases it; ~10 existing pos tests mock it).

### Frontend (kiosk-core.js / kiosk.js / admin.js)

**Current state to replace.** One env value `getRecipeContext/setRecipeContext` (kiosk-core.js:68-69, 97; kiosk.js:54-55, 564; admin.js:10638, 10661-10662), a single module var `_kioskQuote` (kiosk-core.js:415) tied to the recipe SCREEN, `_kcEnv.getModifiedIngredients()` for the screen's edits, and recipe lines stored INSIDE `cart{}` as `recipe-ing-N-*`, `recipe-fee-*`, `recipe-total` (kiosk-core.js:1738-1863) after `_kcEnv.setCart({})` wipes everything (:1738).

**Target model.** Rename the bridge to `getRecipeEntries/setRecipeEntries` (array, default `[]`; both consumers + the `bridgedFns` list at :96-98). Each entry (snapshot at add time): `{entry_id, recipe_id, recipe_name, sale_type, mill_grain, target_volume_l, modified_ingredients|null, pricing_mode, locked_price, lines:[{name, amount, qty_text}] (from the entry's /recipe-quote), fee_lines:[...], total_before_discount}`. Recipe lines no longer live in `cart{}` (this also removes interaction with the kit-fee sync `kioskSyncKitFees`/`kioskIsKitFee`, kiosk-core.js:800). `_kioskQuote` stays recipe-screen-only.

**Specific change sites:**
- `kioskAddRecipeToCart` (:1724): delete the cart guard (:1731-1736) and `_kcEnv.setCart({})` (:1738); push an entry instead of writing cart keys; no wipe.
- Remove `kioskCartHasRecipe`/`kioskWarnRecipeCart` (:2163-2169) and their guards in `kioskAddToCart` (:2172), `kioskSetQty` (:2204), `kioskRemoveFromCart` (:2238); `kioskAddCanningBundle` `recipe_cart` return (:2339) and its opener hiding (:2410); `kiosk.js:795` `recipe_cart` message.
- `kioskRenderCart` (:2428): the "empty" branch (:2451) tests `keys.length === 0` - must also require no recipe entries; add grouped recipe blocks (D-07: name, litres, sale type, total; ingredient/fee lines beneath without stepper; one `×` -> `kioskRemoveRecipeEntry(entryId)`); delete the `isRecipeCart` qty/footer fork (:2494, 2529, 2554-2569) so Custom/Bundle/Gift-card openers always render.
- `kioskClearCart` (:2256): also clear entries; **reset `_kioskStockOverride = false`** (see pitfall).
- `kioskCalcTotals` (:815): with recipe entries use the server cart-quote result (Option A) for subtotal/discount/tax/total; without recipes keep today's code untouched. Remove the `recipeContext` branches (:829-838, 905-908, 933-935).
- `kioskProceedToPayment` (:2983): `items` build excludes recipes; add `recipes: entries.map(toWire)`; the phantom-product guard (:3055) can now run (it was skipped for recipe carts because ingredients lived in the cart); fork at :3214-3264 (`isRecipeSale`, `recipeSaleBody`) and the recipe confirm branch (:3308-3360) are deleted - everything goes through `standardSaleBody` and `/api/kiosk/sale/confirm`, both bodies gain `recipes`, `override`, `customer_email` (:3228-3230 pattern). Payment screen item rows (:3162-3169) and `kioskShowReceipt(..., items, ...)` (:4235) need recipe rows (they iterate `items`).
- Tender panel: delete the `isRecipeSale` branch (:3783-3797, the "card terminal only" note) so the GC/Cash/Phone-Order panel (:3798+) always injects; remove `isRecipeSale` from `_kioskPushToTerminal` (:3400, 3405, 3420).
- **409 override must be shared by all tenders.** Today the conflict UI exists only in `_kioskPushToTerminal`'s result handler (:3488-3510); `_kioskGoCash` (:3611) and `_kioskGoMoto` (:3681) would show "Cash Sale Error" for a stock 409 and never offer override. Extract one `handleSaleResponse409(result, retry)` used by all three; render conflicts naming recipes (`c.recipes.join(', ')` / `recipes_short`); the existing DOM ids `kiosk-stock-conflict`, `kiosk-stock-override-btn` stay.
- `js/kiosk.js`: env bridge (:54-55), var (:564), message table (:795). `js/admin.js`: var (:10638) + bridge (:10661-10662) - the admin copy mirrors kiosk.js; admin has no canning-bundle modal (`showCanningBundleModal: null`).
- CSS: add `.kiosk-cart-recipe-block` styles in `css/kiosk.css` (then `npm run build`; kiosk.html/admin.html `?v=` stamps change).

### Anti-Patterns to Avoid
- **Appending recipe lines to the standard `lineItems` before `computeTax`/`resolveDiscount`/`createBatchesFromSale`/`decrementStock`.** `computeTax` dereferences `catalogMap[li.item_id].tax_percentage` (pos.js:273) -> TypeError for ingredient ids not in the kiosk catalog; ledger would decrement ingredient SKUs; batch detection misfires. Keep recipe lines in a separate list and assemble the invoice at the end.
- **Rounding product tax and recipe tax separately then adding** (cent drift vs Zoho entity-level rounding).
- **Computing the package adjustment as one cart-wide difference** (see above).
- **Bare 4xx in `/confirm` for any recipe failure when `body.transaction_id` exists** (gate 403, recipe 404/inactive, 422 unit mismatch, 503 ingredient catalog, milling not configured, tax unresolved). Throw a tagged `__recipeInvalid {status, message}` handled exactly like `__bundleInvalid` (pos.js:2004-2014): plain 4xx + lock release only when no charge exists, otherwise fall through to the void block.
- **Trusting client recipe quote totals** - body carries parameters only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Recipe scaling/pricing/unit conversion | New math | `lib/recipe-scaling.js` via moved `priceRecipe` | Phase 35/36/73 rules; byte-for-byte requirement |
| Idempotency/void/alert | New lock/void code | `moneyPath.acquireIdempotencyLock`, `voidWithTimeout`, existing outer catch | Audit H5/L18: one void path |
| Per-line discount distribution | New algorithm | `allocateFixedDiscount` (pos.js:108) + `distributeRecipeDiscount` | Cent-exact parity with client rounding |
| Tax rounding | Sum-then-round | rate-group map merge | Zoho `entity_level` rounding |
| Orphan handling for the merged route | New sweep | existing `KIOSK_PENDING_CHARGE_PREFIX` sentinel + `lib/reconcile.js` | Route-agnostic, keyed on invoice reference |
| Batch dedup for repeat recipes | Custom dedup | `unit_total` param already honoured by Postgres + Apps Script | batch-rules.js:305 |

**Key insight:** every money-moving behaviour in the merged route already exists in `/sale` + `/confirm`; the only genuinely new code is "turn `recipes[]` into extra priced lines + a summed adjustment", the combined stock check, and the client state/UI.

## Runtime State Inventory

Not a rename/migration phase - **omitted** except these deploy-state notes: (a) a recipe charge in flight at deploy time (7-day sentinel `kiosk:pending-charge:<ref>` + confirm idem keys, route-agnostic reconcile) - covered by keeping `/recipe-sale/confirm`; (b) iPad-cached `kiosk.min.js` - covered by the 410 message; (c) no stored data, OS registrations or env var renames. `BEER_SALES_ENABLED`, `MAKERS_FEE_ITEM_ID`, `MATERIALS_FEE_ITEM_ID`, `MILLING_FEE_ITEM_ID`, `KIOSK_GIFT_CARD_ITEM_ID` env names are unchanged.

## Common Pitfalls

### Pitfall 1: Maker's Fee collision in batch creation
**What goes wrong:** passing recipe lines to `createBatchesFromSale` makes ingredient lines "kits" and the recipe Brewing Fee the "Maker's Fee" -> wrong/extra batches or inflated slots. **Avoid:** pass only non-recipe lines. **Warn:** a mixed test sale creates >1 batch per kit.

### Pitfall 2: Duplicate recipe batch rejected (D-02)
**What goes wrong:** second entry of the same recipe on the invoice -> `duplicate_so_number`, queued for retry, never created. **Avoid:** `unit_total` in `detectRecipeSale`. **Test:** two identical in-store entries -> two `create` calls each carrying `unit_total: 2`.

### Pitfall 3: Entity-level tax drift (see Tax)
**Warn:** Zoho invoice total != charge by $0.01 -> payment 400 (INV-000226 class). The generalised reconcile masks it silently by moving the cent into `adjustment`, so assert in tests that `taxTotal` equals Zoho's own grouping for mixed fixtures.

### Pitfall 4: Fee tax needs the fee item in the kiosk catalog
`computeRecipeTax` fails closed when a fee item is missing from the kiosk catalog (pos-recipe.js:370-373). In a recipe-only cart `items` is empty, so `findMissingCatalogItem` returns null for ANY cached array - including an empty/cold one - and `isUsable` would accept a catalog lacking the fee items. **Avoid:** `isUsable` must also require the fee ids when any entry is in-store (Maker/Materials) or take-out+mill (Milling).

### Pitfall 5: Sticky stock override
`_kioskStockOverride` is only reset on the recipe screen (:1474, 1498, 1524). In a merged flow it would silently oversell a later sale. **Avoid:** reset in `kioskClearCart` and at the top of `kioskProceedToPayment`; the resubmit path re-reads it (:3398-3402) and must keep doing so.

### Pitfall 6: Override resubmit blocked by the idempotency lock
The old `_runRecipeSale` returns the 409 stock conflict WITHOUT releasing the idempotency lock (pos-recipe.js:846-851; no `res.on('finish')` hook) while the client resubmits with the same `idempotency_key`, so the resubmit hits `contention` -> 409 "already in progress" (verified by reading; **not** reproduced by running). The merged route inherits pos.js's finish-hook (pos.js:486-492) which fixes it - add a regression test (409 then same-key resubmit with `override:true` succeeds) for every tender.

### Pitfall 7: Recipe confirm leg swallows payment-recording failure
The old recipe confirm fires `/submit` + `/customerpayments` fire-and-forget and only logs a payment failure (pos-recipe.js:1490-1503) - an invoice booked but unpaid with the card captured. The merged route inherits the standard behaviour (failure rethrown -> void whole payment, pos.js:1910-1916), which is what D-14 wants. Surface to the owner: recipe sales get stricter on payment-recording failure.

### Pitfall 8: Sale total limits now apply
`processSaleWithPrices` rejects `grandTotal <= 0` and `> 10000` (pos.js:739-744); the recipe route had neither. A 100%-discounted recipe-only cart (or large multi-recipe sale) now 400s. Decide/document; do not silently raise the cap.

### Pitfall 9: Reconcile re-sends discount in Zoho's format
`reconcileRecipeInvoice` re-sends the lines it reads back, including `li.discount` (pos-recipe.js:296-308). Product lines may carry `'10%'` strings (pos.js:176); whether Zoho echoes that as `10%`, `10`, or an amount is unverified. **Avoid:** in recipe-bearing sales convert product percentage discounts to numeric per-line amounts (`round2(lt*pct/100)`, the same value the client mirrors) before posting, so the re-sent value is unambiguous. Cover by a unit test with a mocked Zoho echo and verify once on staging with a discounted mixed sale. [ASSUMED - see A1]

### Pitfall 10: Cached-JS / deploy-order
New client + old middleware under-charging is prevented only by the blocking assertion / `cart-quote` availability gate. Deploy middleware first, keep `/recipe-sale/confirm`. Never ship the client alone.

### Pitfall 11: Cart empty-state and kit-fee sync
`kioskRenderCart` treats `keys.length===0` as an empty cart (:2451) - a recipe-only cart would render "No items" and disable checkout (:2486) unless the condition includes entries. Likewise `kioskUpdateDiscountDisplay` and the discount button enablement must count recipe entries.

### Pitfall 12: Existing tests mock modules - eager `require` breaks them
~10 pos tests mock `constants/cache/logger` etc. and load `routes/pos.js`. Requiring `lib/recipe-sale-lines` (-> `recipe-store` -> Postgres stack, `fs`, etc.) at pos.js top-level would pull unmocked modules into every one of them. **Avoid:** lazy `function recipeLines() { return require('../lib/recipe-sale-lines'); }` (same idiom as `batchProxy()` pos.js:24) and only call it when `body.recipes` is a non-empty array.

## Code Examples

### Lazy recipe pricing hook inside `processSale` (shape, not final code)
```javascript
// Source: pattern from pos.js:24 (batchProxy lazy require) + pos-recipe.js priceRecipe
var hasRecipes = Array.isArray(body.recipes) && body.recipes.length > 0;
if (hasRecipes && (process.env.BEER_SALES_ENABLED || 'false').toLowerCase() !== 'true') {
  return res.status(403).json({ error: 'Recipe sales are not enabled' });
}
// ... after kiosk catalogMap + non-recipe lineItems are built ...
var recipePromise = hasRecipes
  ? recipeLines().priceRecipeEntries(body.recipes, catalogMap)   // one ingredient-catalog load; N Postgres reads; 0 Zoho calls
  : Promise.resolve(null);
```

### Tagged confirm-leg error (never bare 4xx after a charge)
```javascript
// Source: pos.js:1297-1302 (__bundleInvalid) and :2004-2014 handler
var e = new Error(msg); e.__recipeInvalid = true; e.__status = status; throw e;
// outer catch:
if (err && (err.__taxUnresolved || err.__bundleInvalid || err.__recipeInvalid) && !(body && body.transaction_id)) {
  if (confirmIdemKey) cache.releaseLock(confirmIdemKey).catch(function () {});
  return res.status(err.__status || 400).json({ error: err.message });
}
// else: falls through to the existing void-on-failure block
```

### Summed package adjustment
```javascript
// per recipe (after its discount was distributed): adjustment_r = round2(preTax_r - sum(recipeLineAmount(line)))
invoicePayload.adjustment = round2(adjustments.reduce(add, 0));   // only set when !== 0
invoicePayload.adjustment_description = 'Recipe package price';
// then reconcileRecipeInvoice(created, invoicePayload, grandTotal) when recipes present
```

### Merged tax groups
```javascript
// Source: pos.js:289-292 / pos-recipe.js:386-388 (rounding per rate group)
var byRate = mergeGroups(productGroups.byRate, recipeIngredientGroups.byRate, recipeFeeGroups.byRate);
var taxTotal = round2(Object.keys(byRate).reduce(function (s, k) { return s + round2(byRate[k]); }, 0));
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Recipe sale on its own terminal-only route | One standard sale route with `recipes[]` | Phase 101 | Full tenders, mixed carts |
| Recipe tax 0 / log-only assertion | Fee tax charged, entity-level groups | 2026-10-13 / Phase 67 | Merge must keep group rounding |
| Recipe stock 409 only on initiate | Combined stock check on all tenders | Phase 101 | Override on cash/MOTO too |

**Deprecated after this phase:** `POST /api/kiosk/recipe-sale` (410), `_kioskRecipeContext`/`getRecipeContext`, the bbca0f28 guard, "card terminal only" note.

## Existing tests that pin old behaviour (CLAUDE.md rule 10 - needs owner approval to modify)

**Middleware (`zoho-middleware/__tests__/`)** - tests that POST `/api/kiosk/recipe-sale` (will get 410; must be re-pointed at `/api/kiosk/sale` with `recipes[]` or retired): `pos-recipe.test.js` (27 initiate refs, 2154 lines - split between pure helper/quote tests that stay valid and route tests that need re-pointing), `pos-recipe-money-path.test.js`, `pos-recipe-confirm-verification.test.js`, `pos-recipe-catalog-fallback.test.js`, `pos-recipe-captured-amount.test.js`, `pos-recipe-invoice-reconcile.test.js`, `pos-recipe-fee-lastgood.test.js`, `pos-recipe-fee-tax.test.js`, `pos-recipe-sale-reference.test.js`, `pos-recipe-numeric-txn-id.test.js`, `pos-recipe-payment-after-submit.test.js`, `pos-recipe-zoho-line-fidelity.test.js`, `pos-recipe-store.test.js`, `recipe-dual-price.test.js`. Tests that only hit `/recipe-sale/confirm` or `/recipe-quote` stay green while those routes stay (`kiosk-recipe-batch-email-97.test.js`, `pos-recipe-snapshot-gravity.test.js`, quote refs). Pure-helper tests (`computeRecipeDiscount`, `distributeRecipeDiscount`, `_dualPriceStats`) stay green because `pos-recipe.js` re-exports them. Tests that merely mock `LOCK_KEYS.RECIPE_SALE` (cash/moto/precharge/etc.) need no change.
**Plan rule:** do the lib extraction as a *pure move* first (all of the above still pass untouched), add NEW characterization/mixed tests in NEW files, and only then (final wave, with explicit owner approval) re-point/retire the initiate-route tests.

**Frontend (`tests/frontend/`)** - reference `recipe-sale`/`RecipeContext` and must change: `kiosk-recipe-cart-guard.test.js` (replace; owner-approved), `kiosk-recipe-client-totals.test.js`, `kiosk-recipe-fee-tax.test.js`, `kiosk-recipe-sale-email-97.test.js`, `kiosk-canning-bundle.test.js` (`recipe_cart` expectation), `kiosk-core-parity.test.js` (env contract / `bridgedFns`, 7 refs), `kiosk-client-error-beacon.test.js`, `kiosk-recipe-quote.test.js`, `kiosk-recipe-modify.test.js`, `admin-recipe-modify.test.js`, `brewpad-recipe-attach-modify.test.js`, `brewpad-recipe-volume-factor.test.js`, plus the test hooks `_getRecipeContext/_setRecipeContext` (kiosk-core.js:7103-7104) they use.

## Zoho Inventory quota impact

Per mixed sale the Zoho call count equals today's: `POST /invoices`, `/submit`, `/customerpayments` (+1 for gift-card payment, +1 for a reconcile `PUT` when Zoho's total differs). N recipes add **zero** Zoho calls: recipes read from Postgres (`recipe-store.get`), the ingredient catalog comes from Redis/file (`getIngredientCatalog`, loaded once per request), fee tax reuses the already-resolved kiosk catalog. Watch-outs: `cache.del(INGREDIENTS_ALL)` + `KIOSK_PRODUCTS` after a sale makes the next catalog read hit the file cache / a kiosk-catalog rebuild (existing behaviour; do not add more busting). `cart-quote` and `confirm` must use `getKioskCatalogForSale({rebuild:false})` so a read-only quote never burns quota; `/sale` keeps today's rebuild-on-miss. A pending reconcile check is `GET /invoices?reference_number=` only in the orphan sweep (unchanged). [VERIFIED: code read]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Zoho echoes line `discount` in a form that is unsafe to re-send for `%` strings; converting product % discounts to numeric amounts in recipe-bearing sales is safe | Pitfall 9 | Reconcile PUT could change line discounts -> total still off -> void. Verify once on staging (D-17 variant with a discount) |
| A2 | Zoho accepts several lines with the same `item_id` (two Brewing Fee lines, same hop across recipes) on one invoice | Invoice ordering | Existing recipe invoices already repeat item_ids (hop additions, kiosk-core.js:1772 comment) so very likely fine; verify in D-17 |
| A3 | Dropping the `RECIPE_SALE` mutex is acceptable | RECIPE_SALE | If owner wants single-flight recipe sales, keep it only for recipe-bearing carts and release on every failure path |
| A4 | A server `cart-quote` endpoint is wanted (adds one route + client plumbing) rather than client mirroring | Assertion unification | Scope; fallback Option B exists |
| A5 | Summing needed qty per `item_id` across lines (not just recipes) is the right D-13 semantic | Stock | Slightly stricter than today for recipes that list one item twice |
| A6 | Server sanity cap of 25 recipes/sale is invisible to the owner | Body contract | Pick any bound or none |
| A7 | Legacy `/recipe-sale/confirm` soak of >=24h with 0 events is enough before deletion | Removal | Longer soak if iPads are rarely reloaded |
| A8 | Kit sales mixed with recipes keep kit fee lines distinct from recipe fee lines (same Zoho fee item ids, different lines) | Batches | Maker's Fee slot math if recipe lines leaked into `createBatchesFromSale` |

## Open Questions (RESOLVED)

1. **Literal D-16 vs safe soak.** CONTEXT wants the old route "removed in this phase", discretion allows keeping `/recipe-sale/confirm` until nothing is pending.
   - Known: initiate -> 410 is safe immediately; confirm must outlive in-flight charges.
   - Recommendation: Release N keeps legacy confirm with a usage event; schedule deletion as the last plan, executed after prod soak (or record as an explicit follow-up). Planner must get the owner's nod.
   - **RESOLVED by D-18:** initiate returns a safe 410 now; `/recipe-sale/confirm` stays with a usage event; deletion is a pending todo after ~1 week of zero use (Plan 13).
2. **Option A (cart-quote) vs Option B (client mirror + log-only for recipe carts).** Recommendation A; confirm scope appetite.
   - **RESOLVED by D-19:** Option A — `POST /api/kiosk/cart-quote` (Plans 07, 10, 11); assertion stays blocking for every cart.
3. **Sale cap `> $10,000` / `<= 0` now applies to recipe sales** (Pitfall 8) - confirm acceptable.
   - **RESOLVED by D-21:** limits apply to recipe-bearing sales (Plan 05).
4. **Recipe-only stricter payment-failure behaviour** (Pitfall 7) - confirm the owner is happy that a failed `customerpayments` post now voids the card for recipe sales.
   - **RESOLVED by D-21:** a failed payment record after a charge voids the charge (Plan 06).
5. **Kit + recipe on one invoice - batch label** (`cf_batch_status`) counts kit batches only; accept?
   - **RESOLVED: ACCEPT.** The status label counts kit batches only; recipe batches are tracked in BrewPad, not in that Zoho label. Plan 07 records this as an accepted limitation so the executor does not change it.
6. **Does the admin POS need the cart-quote auth tier?** `authTiers.js` KIOSK_ROUTES is the allowlist; add `/api/kiosk/cart-quote` there (admin session also passes kiosk-scoped routes - verify in the auth test).
   - **RESOLVED (Plan 02):** `/api/kiosk/cart-quote` is added to the exact-path KIOSK_ROUTES list — same auth tier as `/api/kiosk/sale`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 24 (nvm) | Middleware tests (vancouver tz test) | per CLAUDE.md / task note | 24 | Node 20 fails one known tz test |
| Jest (root + zoho-middleware) | Tests | existing | - | - |
| Staging Helcim terminal + Zoho staging org | D-17 gate | owner-operated | - | none (manual gate) |
| Railway Postgres (staging) | recipe store | live (Phase 85) | PG 18.6 | tests use postgres:16 |

No new external services. Not re-probed in this session (environment facts taken from CLAUDE.md/memory).

## Security Domain

`security_enforcement: true` (config.json:40).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (existing) | Device token / admin session on `KIOSK_ROUTES` (`lib/authTiers.js`); add `cart-quote` to the allowlist deliberately |
| V4 Access Control | yes | Explicit exact-path allowlist; no new prefix |
| V5 Input Validation | yes | Validate `recipes[]` server-side: array bound, `recipe_id` string <=64, `sale_type` enum, `target_volume_l` numeric (existing 10x cap), `modified_ingredients` array (1 MB body limit, server.js:75-76), `override` boolean; **client prices ignored** |
| V6 Cryptography | no new | Helcim idempotency hash reused (sha256, pos.js:955) |
| V8 Data protection | yes | `customer_email` validated (regex + <=254) and never logged (97-10) |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Client-forged recipe price/total | Tampering | Server re-derives everything; blocking `client_grand_total` assertion; captured-amount verify |
| Duplicate charge / double booking | Tampering | Client idempotency lock + Helcim idem key + confirm lock + sentinel |
| Charged-but-unbooked orphan | Repudiation/DoS | Sentinel + reconcile sweep; void-on-failure; tagged confirm errors (no bare 4xx after charge) |
| Stock-override abuse | Elevation | Override only a boolean the kiosk operator sets; negative stock is business-accepted; logged event recommended (`kiosk.stock_override`) |
| Body-size / array amplification | DoS | `recipes` cap + existing 1 MB limit; one ingredient-catalog load per request |
| Cart-quote abuse (read-only) | DoS | Keep under device-token auth; no Zoho calls (`rebuild:false`) |

## Suggested plan breakdown (waves)

**Wave 0 - Safety net (tests first, no behaviour change)**
1. NEW characterization tests (new files) capturing today's recipe-only outputs for `/recipe-sale` + `/confirm`: invoice payload lines, adjustment, tax, charge for locked/dynamic x in-store/take-out x milling x discount (cart %, cart fixed, type recipe/service). These become the byte-for-byte oracle.
2. Pure move: `lib/recipe-sale-lines.js` extraction; `pos-recipe.js` re-exports; tax collectors split (`taxGroups`); all existing tests untouched and green. Commit.

**Wave 1 - Server `/sale` (pre-charge)**
3. Body validation (items OR recipes, bounds, 403 gate), lazy recipe pricing, kiosk-catalog `isUsable` incl. fee ids, combined stock check + 409 payload naming recipes, unified discount, merged tax, totals, assertion rule; all tender branches already work. Regression tests: 409 + same-key override resubmit on terminal/cash/moto; gift-only; fixed discount across recipe+product; two same-recipe entries.

**Wave 2 - Server `/confirm` + `cart-quote`**
4. Re-price, tagged recipe errors, invoice assembly (order, notes, numeric discounts, summed adjustment), generalised reconcile, ledger/batches/cache-bust, receipt shape `{recipes:[...]}`, pending-charge/idempotency/void parity tests per tender.
5. `detectRecipeSale` `unit_total`; batch tests (kit + recipe, duplicate recipe, take-out none, email carry-through).
6. `POST /api/kiosk/cart-quote` + `authTiers.js` + docs/openapi.

**Wave 3 - Frontend (kiosk-core, kiosk.js, admin.js, CSS)**
7. Entries state + bridge rename; `kioskAddRecipeToCart` no-wipe; remove bbca0f28 guard code; grouped block + remove-by-block; cart-quote client; `kioskCalcTotals`; sale/confirm bodies; shared 409 override for all tenders; tender panel unskip; sticky-override reset; payment/receipt recipe rows; bundle opener enabled. Replace the guard tests; update env-contract/total tests (owner-approved list above). `npm run build`.

**Wave 4 - Swap + verify**
8. `/recipe-sale` -> 410, legacy confirm retained + event; docs (`docs/API.md`, `docs/RUNBOOK.md` deploy-order note: middleware first), update/re-point the middleware tests listed above (owner approval checkpoint).
9. Staging deploy -> D-17 manual gate (one card sale recipe + product; verify one invoice, total, stock drop in Zoho, BrewPad batch; refund). Include one discounted mixed sale if cheap (A1/A2).
10. Prod release (middleware before frontend) -> soak -> **Release N+1** deletes legacy confirm + `RECIPE_SALE` constant/mutex remnants.

## Sources

### Primary (HIGH confidence) - direct code reads this session
- `zoho-middleware/routes/pos.js` L1-1033, L1180-2089 (sale, confirm, tax, discount, tenders, void)
- `zoho-middleware/routes/pos-recipe.js` L1-1655 (full file)
- `zoho-middleware/lib/brewpad-integration.js` (detectKitItems, planKitBatches, createBatchesFromSale, detectRecipeSale); `lib/batch-rules.js` dedupDecision; `lib/batch-pg-create.js`; `apps-script/adminApi.gs` L2547-2600
- `zoho-middleware/lib/money-path.js`, `lib/inventory-ledger.js` (decrementStock), `lib/kiosk-sale-catalog.js`, `lib/discount-match.js`, `lib/recipe-scaling.js`, `lib/reconcile.js` L85-150, `lib/authTiers.js`, `lib/checkout-helpers.js` (findMakersFeeItem), `server.js` mounts/limiters
- `js/kiosk-core.js` L40-110, 440-550, 800-950, 1590-1880, 2160-2290, 2428-2660, 2983-3970; `git show bbca0f28`
- `.planning/phases/101-.../101-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md:1449-1457`, `.planning/config.json`, project `CLAUDE.md`, user memory index

### Secondary / Tertiary
- None (no web/Context7 lookups needed: internal code phase, no new libraries). Zoho echo behaviour for line `discount` (A1) is untested - tagged ASSUMED.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new packages; all reuse is internal and read in full.
- Architecture: MEDIUM-HIGH - code map is exact; the `cart-quote`/mutex/soak decisions are recommendations flagged in Assumptions/Open Questions.
- Pitfalls: HIGH for 1-6, 10-12 (derived from read code); MEDIUM for 9 (Zoho response format unverified).

**Research date:** 2026-11-10
**Valid until:** ~2026-12-10 (code-state dependent; re-check if pos.js / pos-recipe.js / kiosk-core.js change on main before planning completes - commits since bbca0f28 touched only .planning docs)
