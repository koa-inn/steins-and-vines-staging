# Phase 101: Kiosk mixed recipe carts and full tenders - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-10
**Phase:** 101-kiosk-mixed-recipe-carts-and-full-tenders
**Areas discussed:** What can share a cart, Payment options, Low stock & failures, Rollout & surfaces

---

## What can share a cart

| Question | Options | Selected |
|----------|---------|----------|
| Recipes per sale | One recipe per sale (Recommended) / Several recipes per sale | Several recipes per sale |
| Wine kit + recipe | Yes, allow it (Recommended) / No, keep kits separate | Yes |
| Canning bundle + recipe | Yes, allow it (Recommended) / No, keep it blocked | Yes |
| Gift card issue/reload + recipe | Yes, allow it (Recommended) / No | Yes |
| Same recipe twice | Separate entries (Recommended) / As a quantity / No | Separate entries |
| Sale type | Per recipe (Recommended) / One for the whole sale | Per recipe |
| Cart look | Grouped block per recipe (Recommended) / Flat lines like today | Grouped block |
| Edit after adding | Remove and re-add (Recommended) / Tap to edit in place | Remove and re-add |

**Notes:** Owner went against the recommendation on recipes per sale (several, not one).

---

## Payment options

| Question | Options | Selected |
|----------|---------|----------|
| Tenders for recipe sales | All of them (Recommended) / All except phone order / Card + cash only | All of them |
| Cash on recipe sales | Same as cash today (Recommended) / Needs a manager PIN | Same as today |
| Discounts on mixed carts | Same rules as today, per line (Recommended) / Let me explain | Same rules, per line |

---

## Low stock & failures

| Question | Options | Selected |
|----------|---------|----------|
| Short ingredient stock | Same override prompt, naming the recipe (Recommended) / Block, no override | Override prompt naming the recipe |
| When to check stock | When added AND at checkout (Recommended) / Only at checkout | Both |
| Booking fails after payment | Void the whole payment (Recommended) / Keep payment, book what we can | Void the whole payment |

---

## Rollout & surfaces

| Question | Options | Selected |
|----------|---------|----------|
| Surfaces | Both kiosk and admin POS (Recommended) / Kiosk only | Both |
| Switch-on | On/off switch, old route kept (Recommended) / Straight swap | Straight swap |
| Prod gate | Real small sales x4 then refunded (Recommended) / One card sale is enough | One card sale |

**Notes:** Owner chose the leaner options for rollout (straight swap, single staging card sale).

---

## Claude's Discretion

- Request shape and how pos.js reuses pos-recipe.js pricing.
- Safe removal of the old route without orphaning an in-flight charge; keep recipe-quote.
- Recipe mutex vs standard idempotency lock.
- Invoice ordering and package-price adjustment on a shared invoice.
- Batch creation for several recipes plus kits.
- Keep BEER_SALES_ENABLED gating recipe components.

## Deferred Ideas

- Tap-to-edit a recipe already in the cart.
- Importing Sales Orders that contain recipes.
