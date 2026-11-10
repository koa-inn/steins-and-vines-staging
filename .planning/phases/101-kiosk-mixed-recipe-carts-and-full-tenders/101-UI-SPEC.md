---
phase: 101
slug: kiosk-mixed-recipe-carts-and-full-tenders
status: approved
reviewed_at: 2026-11-10
shadcn_initialized: false
preset: none
created: 2026-11-10
---

# Phase 101 - UI Design Contract

> Small delta on the existing staff-facing kiosk/POS (iPad, touch). Reuse `css/kiosk.css` tokens and classes. No new design system. Both `kiosk.html` and `admin.html` POS tab render through `js/kiosk-core.js` and must look identical. ES5 vanilla JS, plain CSS. New CSS goes in `css/kiosk.css` only (not inline styles; the old inline-style recipe note and tender note are deleted, not restyled).

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (shadcn gate not applicable: static HTML, not React/Vite) |
| Preset | not applicable |
| Component library | none (hand-written CSS in `css/kiosk.css`) |
| Icon library | none (text glyphs: the existing "×" remove glyph) |
| Font | `--font-body` Lato / Helvetica Neue / Arial; `--font-display` Georgia (headings only, unchanged) |

Source: detected from `css/kiosk.css` `:root`. Pre-populated; nothing re-asked.

---

## Spacing Scale

Existing tokens in `css/kiosk.css`: `--sp-1` = 4px, `--sp-2` = 8px, `--sp-4` = 16px, `--sp-6` = 24px, `--sp-8` = 32px (`--sp-3` = 12px exists but is not used here). New rules use only these.

| Token | Value | Usage in this phase |
|-------|-------|---------------------|
| --sp-1 | 4px | Gap between ingredient sub-lines |
| --sp-2 | 8px | Padding inside recipe block header and notes |
| --sp-4 | 16px | Gap between recipe block and next cart line; panel padding |
| --sp-6 | 24px | Gap between cart sections |
| --sp-8 | 32px | not used |

Exceptions: touch targets are 44px minimum (existing standard): the recipe block "×" and the Sell anyway / Back to cart buttons use `min-height: 44px; min-width: 44px`. The existing `.kiosk-cart-remove-btn` (4px 8px padding, ~28px tall) is too small for the block remove: give `.kiosk-recipe-remove` the 44px minimum. `.kiosk-bundle-group` uses 3px left border (existing exception, reused).

---

## Typography

Reuse existing sizes; declare exactly these for the new elements:

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Label / meta (batch size, sale type, ingredient and fee lines, "Fee" tags) | 12px | 400 | 1.3 |
| Body (recipe block name, recipe total, button labels, error text) | 14px | 400; 700 for block name and total | 1.3 |
| Heading (low-stock panel title) | 16px | 700 | 1.2 |
| Display (cart grand total) | 16px | 700 | 1.2 |

Ingredient lines are 12px (the old 0.85rem exception is dropped). The existing `.kiosk-total-grand` (1.1rem) is an untouched existing style outside this phase's contract; if it is edited, use 16px bold. Weights used: 400 and 700 only. Inputs stay at 16px (iOS zoom rule, unchanged).

---

## Color

Existing tokens only; no new colors.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `--cellar-canvas` #e8e2ca / `--cellar-surface` #f5f1e6 | Page and cart surface |
| Secondary (30%) | `--cellar-raised` #faf8f2 | Recipe block card background, low-stock panel |
| Accent (10%) | `--barrel` #77462d | See reserved list |
| Group rule | `--cork` #9a7358 | 3px left border on recipe block (same as `.kiosk-bundle-group`) |
| Warning | `--batch-warning` #b87a1a on `--batch-warning-bg` | Low-stock panel and "Sell anyway" button |
| Destructive | `--batch-danger` #a83232 on `--batch-danger-bg` | Quote-failed error only. Remove "×" keeps its existing hover/active red |

Accent (`--barrel`) reserved for: recipe block total (same as `.kiosk-cart-line-total`), and the existing Checkout button. Not for sale-type tags, notes or secondary buttons.

---

## Surface Contracts

### 1. Cart: recipe block (D-01, D-02, D-07)

New class `.kiosk-recipe-group` (modelled on `.kiosk-bundle-group`: `border-left: 3px solid var(--cork); padding-left: 8px; background: var(--cellar-raised); margin: 8px 0; border-radius: 0 6px 6px 0`).

Structure, top to bottom:
1. **Header row** (flex, like `.kiosk-cart-line`, no steppers): `[Recipe name 14px bold, 2-line clamp]  [recipe total, barrel, bold, right]  [× 44x44]`.
2. **Meta row** (12px, `--ink-tertiary`): `{batch size} · {sale type}`. Sale type text is exactly one of: `Brew in store`, `Take-out`; add ` · Milled` when milling chosen. Example: `23 L · Brew in store · Milled`.
3. **Detail lines** (12px, `--ink-secondary`, indented 8px, no total column except fees): one line per ingredient `{qty} {unit} {ingredient name}` and per fee `{fee name}` with its amount right-aligned. Ingredient lines show no price (the recipe total covers them) unless the existing recipe cart already shows per-line prices; if so, keep them but right-aligned in `--ink-tertiary`. Detail lines are not interactive: no stepper, no per-line ×.
4. Duplicate disambiguation: when the same recipe appears more than once, append ` #1`, ` #2` ... in entry order to the block name (`House Pale #1`, `House Pale #2`). Single entry shows no number. Numbers renumber when one is removed.

Remove: one "×" in the header, `aria-label="Remove {name} from cart"`, removes that entry only, no confirm dialog (same as today's per-line ×; the block is re-addable). Removing the last recipe leaves other lines untouched.

Mixed content: recipe blocks render in add order, interleaved with other lines in the order added. Products, kits with their fee lines, canning bundle (`.kiosk-bundle-group`), custom items and gift-card lines keep today's markup unchanged. Recipe blocks and bundle groups must not nest. Delete the "Recipe sale: checked out on its own, card terminal only." note (bbca0f28) and show "+ Add custom item" always.

Receipt/cart parity: block order and names match the receipt.

### 2. Recipe screen "Add to cart" (D-01, D-02)

- Label stays `Add to cart` (existing). Adds a new entry without touching the cart. Never clears, never blocks, no "Check out or clear..." toast.
- After add, same navigation as today (return to cart view) and toast `Added {recipe name} to cart` (success style, existing `showToast`).
- Disabled rules unchanged (`cannot_brew` / `unknown` availability).
- The kiosk recipe-in-cart replace-on-re-add behaviour is removed: adding the same recipe again always makes a new entry.

### 3. Checkout and tender panel (D-09)

- Recipe carts go through `#kiosk-gc-panel` exactly like any other cart: Apply Gift Card, Cash, Phone order, card terminal. No recipe-specific tender text.
- Delete the "Recipe sales are card terminal only..." note and the recipe fork that skips the panel.
- Cash: existing tendered / change-due UI unchanged.

### 4. Low-stock override prompt (D-12, D-13)

Reuse the existing `#kiosk-stock-conflict` panel with its `#kiosk-stock-override-btn`; restyle with a class (`.kiosk-stock-conflict`) on `--batch-warning-bg` with 3px `--batch-warning` left border, padding 16px (`--sp-4`), radius 6px. Shown before any charge, on card, cash and phone-order paths alike (one shared handler; paths must not each render their own).

Content:
- Title (16px bold): `Not enough stock`
- Body, grouped by recipe (12px detail, 14px recipe name bold):
  ```
  House Pale #2
  - Pale malt: need 5 kg, have 3 kg
  - Cascade hops: need 100 g, have 40 g
  ```
  When two recipes share one short ingredient, list it under each recipe that uses it, with the combined shortfall noted once at the end: `Combined need is more than we have.` Plain text, not JSON ids; use item names (fall back to id only if name missing).
- Actions (side by side, wrap on narrow; each min-height 44px, min-width 120px):
  - `Sell anyway` (warning button: `--batch-warning` fill, white text, not accent; check contrast is at least 4.5:1 and darken the fill if not): resubmits with override. Label for the existing Override button.
  - `Back to cart` (secondary, outline): closes panel, returns to cart with payment not started; nothing charged.
- Nothing else is tappable behind the panel while it is open. Panel has `role="alert"`.

### 5. Server-priced total (D-19)

- Applies to any cart containing a recipe (cart-quote call). Product-only carts keep today's behavior.
- **Pending:** while the quote call runs, the grand-total row shows `Calculating…` (existing wording and style from line ~481, `--ink-tertiary`) in place of the amount, and the Checkout button is disabled (`disabled` attr plus `aria-busy="true"`, 50% opacity). Do not show a client-computed number as final. Re-quote after any cart change (add, remove, qty, discount); debounce is implementation's choice, but the button stays disabled until the latest response arrives. Stale responses are discarded.
- **Success:** show the server total; line totals for recipe blocks use the server amounts.
- **Failure / cart changed underneath** (network error, non-2xx, or total on payment screen differs from what was quoted): inline error row under the totals, `.kiosk-quote-error` on `--batch-danger-bg` with 3px `--batch-danger` left border, 14px text, role="alert": `Couldn't price this cart. Check the connection and try again.` with a `Try pricing again` button (44px, outline style: transparent fill, 1px `--batch-danger` border, `--batch-danger` text) that re-runs the quote. Checkout stays disabled. If the server rejects at charge time because the total moved (client_grand_total mismatch): `The total changed. Review the cart and check out again.` and return to the cart; nothing charged; use `kioskShowError`.
- Never fall back to charging a client-computed total.

### 6. Receipt

Rendered through the existing `kioskShowReceipt`, same typography as today's receipt. Each recipe is a section in cart order:
- Section heading line: recipe name (with ` #n` if duplicated), then `{batch size} · {sale type}` beneath (12px), recipe total right-aligned.
- Ingredient and fee lines indented beneath, name + amount as on today's receipt (no steppers obviously).
- Other items follow their usual lines. Discounts, tax and grand total at the bottom as today, one total, one payment line (tender label as today: Card / Cash / Phone order / Gift card split).

### Focal points

- Cart view: the grand total row plus the Checkout button (bottom of the cart column).
- Override view: the "Not enough stock" panel; it is the only active element until Sell anyway or Back to cart is tapped.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA (recipe screen) | Add to cart |
| Primary CTA (cart) | Checkout (existing, unchanged) |
| Add confirmation toast | Added {recipe name} to cart |
| Empty cart | unchanged (existing copy) |
| Pricing pending | Calculating… |
| Quote error | Couldn't price this cart. Check the connection and try again. |
| Quote retry button | Try pricing again |
| Total changed at charge | The total changed. Review the cart and check out again. |
| Low-stock title | Not enough stock |
| Low-stock confirm | Sell anyway |
| Low-stock cancel | Back to cart |
| Remove recipe | "×" with aria-label `Remove {name} from cart` (no confirm; re-add to undo) |
| Stale-kiosk old-route response (D-18) | This kiosk is out of date. Refresh the page and try again. (no charge made) |
| Destructive confirmation | Remove recipe: none required (single tap, no money moved). Sell anyway: the panel itself is the confirmation. |

Copy removed: "Check out or clear the items in the cart before adding a recipe.", "Recipe sale: checked out on its own, card terminal only.", "Recipe sales are card terminal only. Cash, gift cards and phone orders are not available for recipes yet."

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable (no shadcn) |
| third-party | none | not applicable |

---

## Assumptions Recorded (no owner questions needed)

- Duplicate recipes distinguished by `#n` suffix (inferred from D-02; no visual choice needed).
- No confirm on removing a recipe block (matches current × behavior).
- "Sell anyway" label replaces "Override" for plainness; behavior is the existing override flag.

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
