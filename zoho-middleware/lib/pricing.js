/**
 * Shared price calculation module.
 *
 * Server is authoritative — these functions are the single source of truth
 * for all price/tax/total computations. The client displays estimates only;
 * the server always recomputes authoritative totals before charging or
 * creating orders.
 *
 * Exports:
 *   computeLineItem(product, qty)           → { unitPrice, qty, subtotal, taxRate, taxAmount, total }
 *   computeCartTotals(lineItems, makersFee) → { subtotal, taxTotal, makersFee, grandTotal }
 *   formatCurrency(amount)                  → '$12.50'
 */

'use strict';

/**
 * Format a numeric amount as a currency string.
 * @param {number} amount
 * @returns {string} e.g. '$12.50'
 */
function formatCurrency(amount) {
  var num = typeof amount === 'number' ? amount : parseFloat(String(amount).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(num)) return '$0.00';
  return '$' + num.toFixed(2);
}

/**
 * Compute a single line item's pricing from catalog data.
 *
 * The discount field on the product is intentionally ignored on the server
 * (C3: server never trusts client-supplied discount). Discounts must be
 * computed server-side from authoritative data — pass discountPct explicitly
 * if a server-side discount applies.
 *
 * taxRate is expressed as a decimal fraction (e.g. 0.05 for 5%, 0.12 for 12%).
 * If the product has no taxRate, it defaults to 0 (zero-rated / tax-exempt).
 *
 * @param {object} product        - Catalog product with at minimum { rate }
 * @param {number} qty            - Quantity (positive integer or decimal for weight items)
 * @param {object} [options]
 * @param {number} [options.discountPct=0]  Server-side discount percentage (0-100)
 * @param {number} [options.taxRate=0]      Tax rate as a decimal fraction (e.g. 0.05)
 * @returns {{ unitPrice: number, qty: number, subtotal: number, taxRate: number, taxAmount: number, total: number }}
 */
function computeLineItem(product, qty, options) {
  options = options || {};

  var unitPrice = Number((product && product.rate) || 0);
  qty = Number(qty) || 0;

  // Discount — must be server-supplied; client discount is never trusted
  var discountPct = (typeof options.discountPct === 'number' && options.discountPct > 0 && options.discountPct < 100)
    ? options.discountPct
    : 0;

  var effectiveUnitPrice = discountPct > 0
    ? unitPrice * (1 - discountPct / 100)
    : unitPrice;

  // Subtotal: pre-tax line total, rounded to cents to avoid float drift
  var subtotal = Math.round(effectiveUnitPrice * qty * 100) / 100;

  // Tax
  var taxRate = (typeof options.taxRate === 'number' && options.taxRate >= 0) ? options.taxRate : 0;
  var taxAmount = Math.round(subtotal * taxRate * 100) / 100;
  var total = Math.round((subtotal + taxAmount) * 100) / 100;

  return {
    unitPrice: Math.round(effectiveUnitPrice * 100) / 100,
    qty: qty,
    subtotal: subtotal,
    taxRate: taxRate,
    taxAmount: taxAmount,
    total: total
  };
}

/**
 * Compute cart-level totals from an array of computed line items.
 *
 * Each lineItem should be the output of computeLineItem() (with subtotal,
 * taxAmount, total fields), OR a plain object with at minimum { subtotal }.
 * If taxAmount is absent it defaults to 0 (tax-exempt items).
 *
 * The makersFee is treated as a pre-tax amount and added to the subtotal
 * before computing the grand total. It does NOT have additional tax applied
 * here — the Makers Fee service item carries its own tax in Zoho.
 *
 * @param {Array}  lineItems   - Array of objects with at minimum { subtotal, taxAmount? }
 * @param {number} [makersFee=0] - Makers Fee amount (pre-tax, server-computed)
 * @returns {{ subtotal: number, taxTotal: number, makersFee: number, grandTotal: number }}
 */
function computeCartTotals(lineItems, makersFee) {
  if (!Array.isArray(lineItems)) lineItems = [];

  makersFee = (typeof makersFee === 'number' && makersFee > 0) ? makersFee : 0;

  var subtotal = 0;
  var taxTotal = 0;

  for (var i = 0; i < lineItems.length; i++) {
    var li = lineItems[i];
    subtotal += Number(li.subtotal) || 0;
    taxTotal += Number(li.taxAmount) || 0;
  }

  // Round after accumulation to prevent floating-point drift (Item #5)
  subtotal  = Math.round(subtotal  * 100) / 100;
  taxTotal  = Math.round(taxTotal  * 100) / 100;
  makersFee = Math.round(makersFee * 100) / 100;

  var grandTotal = Math.round((subtotal + taxTotal + makersFee) * 100) / 100;

  return {
    subtotal:   subtotal,
    taxTotal:   taxTotal,
    makersFee:  makersFee,
    grandTotal: grandTotal
  };
}

module.exports = {
  formatCurrency:    formatCurrency,
  computeLineItem:   computeLineItem,
  computeCartTotals: computeCartTotals
};
