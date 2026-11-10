# Phase 101: Kiosk mixed recipe carts and full tenders - Context

**Gathered:** 2026-11-10
**Status:** Ready for planning

<domain>
## Phase Boundary

One kiosk sale can hold one or more recipes together with products, wine kits (and their maker/materials fees), canning bundles, custom items and gift-card issue/reload lines. It is paid with any tender the kiosk already supports (card terminal, cash, phone order / MOTO, gift card alone or split), and it produces ONE Zoho invoice and ONE payment.

Mechanism (owner-chosen 2026-11-10, "option 1"): the standard `/api/kiosk/sale` + `/api/kiosk/sale/confirm` route accepts recipe components and reuses the existing recipe pricing, unit conversion, package-price adjustment, discount distribution, tax, stock check / override, and BrewPad batch creation from `routes/pos-recipe.js`. The old recipe-only route is removed in this phase (straight swap).

This phase also removes the recipe-cart guard shipped in bbca0f28 (live on prod as prod-20261110-2): no more "check out or clear the cart first", no more blocked products, no more "card terminal only" notes.

Applies to BOTH surfaces that share `js/kiosk-core.js`: the standalone kiosk (`kiosk.html`) and the admin POS tab (`admin.html` / `js/admin.js`).

Out of scope: editing a recipe in place after adding it; importing a Sales Order that contains recipes; any change to how recipes are scaled, priced or taxed (pricing results must stay identical to today for a recipe-only cart).

</domain>

<decisions>
## Implementation Decisions

### What can share a cart
- **D-01:** A sale can hold SEVERAL recipes. No cap was requested.
- **D-02:** The same recipe can appear more than once, as SEPARATE entries (e.g. 2× House Pale = two entries). Each entry keeps its own batch size, ingredient edits, sale type and milling choice, and creates its own BrewPad batch.
- **D-03:** In-store vs take-out (and mill-grain) is chosen PER RECIPE, exactly as on today's recipe screen. One sale can mix a brew-in-store recipe and a take-out recipe.
- **D-04:** Wine kits (with their maker/materials fees) are allowed in the same sale as recipes. Kit pricing and kit fee behaviour are unchanged.
- **D-05:** Canning bundles are allowed with recipes (today they are blocked: `kioskAddCanningBundle` returns `recipe_cart`). Bundle pricing is unchanged.
- **D-06:** Gift-card issue and reload lines are allowed with recipes; activation still happens only after payment succeeds (existing Phase 44 behaviour).
- **D-07:** In the cart, each recipe renders as ONE grouped block: recipe name, batch size, sale type and recipe total, with its ingredient and fee lines listed beneath. Recipe lines have no +/− stepper and no per-line ×. One × on the block removes that whole recipe (and only that recipe).
- **D-08:** Changing a recipe after adding it = remove the block and add the recipe again. No in-place editing in this phase.

### Payment options
- **D-09:** Sales containing recipes allow ALL tenders: card terminal, cash, phone order (MOTO), and gift card alone or split with card / cash / phone order — the same choices as any other sale. The tender panel must no longer be skipped for recipe sales.
- **D-10:** Cash on a recipe sale behaves exactly like cash today (tendered + change-due calculator, no manager PIN, books to Zoho as cash). BrewPad batches are created the same as for a card sale.
- **D-11:** Discounts keep today's rules, applied per line across the whole mixed cart: a `scope: 'cart'` preset covers every line (products, kits, recipes, fees); a `scope: 'type'` preset hits only matching lines (e.g. `applies_to: ['recipe']` discounts only recipe parts, `'service'` only fee lines). The charge must equal the sum of what the invoice books.

### Low stock & failures
- **D-12:** Short recipe-ingredient stock keeps today's override prompt, but it must NAME which recipe(s) are short. It happens before any charge. Staff can override (sell anyway — negative stock is an intentional oversell override in this business) or go back and remove that recipe.
- **D-13:** Stock is checked when a recipe is added (today's recipe-screen banner) AND again at checkout across ALL recipes in the cart combined — two recipes can share an ingredient that only covers one.
- **D-14:** If payment succeeds but booking the sale in Zoho fails, keep today's money-path rule: void/refund the WHOLE payment (one sale = one invoice; nothing half-booked). Cash: show the error, nothing booked. Existing idempotency, pending-charge sentinel, manual-confirm verification and orphan-reconcile behaviour must cover recipe-bearing sales exactly as they cover product sales today.

### Rollout & surfaces
- **D-15:** Both the standalone kiosk and the admin POS get mixed recipe carts (shared `js/kiosk-core.js`; same behaviour on both).
- **D-16:** Straight swap: no on/off switch. The old recipe-only sale route is removed in this phase. (The `BEER_SALES_ENABLED` gate that recipe sales use today must still gate recipe components — see discretion.)
- **D-17:** Production gate: ONE real card sale on the staging terminal containing a recipe + a product, checked in Zoho (one invoice, correct total, stock drop) and BrewPad (batch created), then voided/refunded. The rest is covered by automated tests.

### Claude's Discretion
- How the combined request body carries recipe components (e.g. a `recipes: [...]` array alongside `items`) and how pos.js reuses pos-recipe.js pricing (shared lib extraction vs calling exported helpers). Pricing for a recipe-only cart must stay byte-for-byte equal to today's recipe-sale result.
- Removal mechanics for the old route: deploys of Pages (frontend) and Railway (middleware) are not atomic and kiosk iPads cache JS. Removal must never orphan an in-flight charge — e.g. keep `/api/kiosk/recipe-sale/confirm` (or a safe 410 on the initiate route only) until no old-route charge can still be pending. Keep `GET /api/kiosk/recipe-quote` (still needed for the recipe screen).
- Whether the recipe Redis mutex (`RECIPE_SALE` lock) is kept, generalised, or replaced by the standard sale's idempotency lock.
- Invoice line ordering and the package-price `adjustment` handling when a locked-price recipe shares an invoice with other lines (adjustment must still make the invoice total equal the charge).
- How batches from several recipes plus kits are created (brewpad-integration `detectRecipeSale` / `createBatchesFromSale`), keeping the 97-10 customer-email carry-through.
- Keep `BEER_SALES_ENABLED` gating recipe components inside the combined sale.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Current code (the two routes being merged)
- `zoho-middleware/routes/pos.js` — `POST /api/kiosk/sale` (~L364: tenders, bundles, custom lines, gift card split, cash/MOTO branches) and `POST /api/kiosk/sale/confirm` (~L1196: idempotency, invoice build, payment, void-on-failure)
- `zoho-middleware/routes/pos-recipe.js` — `POST /api/kiosk/recipe-sale` (~L779), `_runRecipeSale` (~L836), `GET /api/kiosk/recipe-quote` (~L975), `POST /api/kiosk/recipe-sale/confirm` (~L1078); helpers `computeRecipeDiscount`, `distributeRecipeDiscount`, `buildRecipeLineItems`, `reconcileRecipeInvoice`, `computeRecipeTax`, `priceRecipe`, `computeRecipeQuote`
- `js/kiosk-core.js` — `kioskAddRecipeToCart` (~L1724), `kioskAddToCart`, `kioskSetQty`, `kioskRemoveFromCart`, `kioskRenderCart`, `kioskAddCanningBundle` (recipe_cart block), `kioskProceedToPayment` (~L2953; `isRecipeSale` fork ~L3184 and tender-panel skip ~L3753)
- `js/kiosk.js`, `js/admin.js` — the two surfaces wiring KioskCore (custom-item and gift-card-issue modals live in kiosk.js)
- `tests/frontend/kiosk-recipe-cart-guard.test.js` — the guard tests from bbca0f28; this phase replaces them (owner approved removing the guard)

### Prior phases whose rules must keep holding
- `.planning/phases/35-batch-scaling-engine/` — batch scaling
- `.planning/phases/36-cross-surface-selection-recipe-modification/` — ingredient modification (MOD-02)
- `.planning/phases/44-kiosk-gift-card-certificate-lifecycle/` — gift card split tender + activation after payment
- `.planning/phases/50-kiosk-money-path-defect-closeout/` — idempotency, re-entrancy, confirm lock rules
- `.planning/phases/67-kiosk-tax-quote-charge-correctness-pre-charge-total-assertio/` — client_grand_total pre-charge assertion (standard sale BLOCKS on divergence; recipe path was log-only)
- `.planning/phases/70-kiosk-tender-types-cash-tender-change-due-gift-card-split-an/` — cash, MOTO, tender-scoped idempotency keys
- `.planning/phases/73-recipe-dynamic-pricing-unit-conversion-correctness-unit-awar/` — unit conversion for Zoho stock deduction
- `.planning/phases/90-brewpad-batch-invoice-linking/` — canning bundle (D-11/D-16/D-22) and batch/invoice linking

### Project docs
- `docs/API.md` — middleware endpoint docs (update for the merged route)
- `docs/RUNBOOK.md` — deploy/rollback, Railway notes

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `zoho-middleware/lib/recipe-scaling.js` (`computeScaledRecipeTotal`, `computeModifiedRecipeTotal`): recipe pricing — reuse, don't fork.
- `zoho-middleware/lib/kiosk-bundles.js`: server-built canning bundle lines.
- `zoho-middleware/lib/money-path.js`: idempotency TTLs and shared money-path helpers.
- `zoho-middleware/lib/brewpad-integration.js` (`createBatchesFromSale`, `detectRecipeSale`): batch creation from a sale.
- `zoho-middleware/lib/kiosk-sale-catalog.js`: last-good catalog fallback used by both routes.
- `zoho-middleware/lib/gift-card-store.js`: gift card balance/activation.

### Established Patterns
- Two-phase sale: initiate (`/sale` → 202 + terminal push or cash/MOTO branch) then `/confirm` (invoice + payment). Never bare-400 after a charge; void on booking failure.
- Server re-prices everything; client totals are only checked (standard sale blocks on >$0.01 divergence; recipe path is log-only because of a historical pre-tax display). The merged route needs a single rule — decide in planning.
- Tender-scoped idempotency keys (`refNumber + ':cash'` / `':moto'`).
- Negative inventory is an intentional oversell override, not a bug.
- Zoho tax rounding is entity_level: round tax per rate group or totals drift a cent from the invoice.
- Zoho Inventory API quota (1,000 calls/day shared by staging+prod): don't add per-recipe Zoho calls carelessly.

### Integration Points
- Kiosk client `kioskProceedToPayment` sale-body build and tender panel.
- Cart state shape: recipe context is today a single `_kioskRecipeContext`; it must become a list of recipe entries, each with its own lines.
- Receipt rendering (`kioskShowReceipt`) and BrewPad batch creation after confirm.

</code_context>

<specifics>
## Specific Ideas

- Owner reports that started this (2026-11-10): "adding a recipe deletes everything in the existing cart" and "I wasn't getting the prompt for payment methods upon checkout". Both must be gone at the end of this phase.
- Example the owner accepted: brew one recipe in store and take another's ingredients home in the same sale.

</specifics>

<deferred>
## Deferred Ideas

- Tap a recipe block in the cart to edit its batch size / ingredient edits in place (D-08 chose remove-and-re-add for now).
- Importing Sales Orders that contain recipes.

### Reviewed Todos (not folded)
- `kiosk-cash-tender.md`, `kiosk-manual-card-entry-moto.md` — already delivered by Phase 70; stale todos, not this phase's scope.
- Other keyword matches (admin write attribution, beer/cider pages, BrewPad bottled status, checkout void ownership, GA4 staging, gated deploy, kiosk refresh/terminal lag, kit price row, limited releases, newsletter, tzdata, recipe OG/FG, v1 dashboard removal, gift-card ledger crash) — unrelated to mixed recipe carts.

</deferred>

---

*Phase: 101-kiosk-mixed-recipe-carts-and-full-tenders*
*Context gathered: 2026-11-10*
