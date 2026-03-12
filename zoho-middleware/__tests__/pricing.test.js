'use strict';

var pricing = require('../lib/pricing');
var formatCurrency  = pricing.formatCurrency;
var computeLineItem = pricing.computeLineItem;
var computeCartTotals = pricing.computeCartTotals;

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------
describe('formatCurrency', function () {
  test('formats a simple positive number', function () {
    expect(formatCurrency(12.5)).toBe('$12.50');
  });

  test('formats zero', function () {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  test('formats a whole number', function () {
    expect(formatCurrency(100)).toBe('$100.00');
  });

  test('rounds to 2 decimal places', function () {
    expect(formatCurrency(9.999)).toBe('$10.00');
    expect(formatCurrency(9.994)).toBe('$9.99');
  });

  test('handles negative amounts', function () {
    expect(formatCurrency(-5)).toBe('$-5.00');
  });

  test('returns $0.00 for NaN/invalid input', function () {
    expect(formatCurrency(NaN)).toBe('$0.00');
    expect(formatCurrency(Infinity)).toBe('$0.00');
  });

  test('accepts numeric strings', function () {
    expect(formatCurrency('14.99')).toBe('$14.99');
  });
});

// ---------------------------------------------------------------------------
// computeLineItem
// ---------------------------------------------------------------------------
describe('computeLineItem', function () {
  test('basic calculation: price × qty', function () {
    var result = computeLineItem({ rate: 10 }, 3);
    expect(result.unitPrice).toBe(10);
    expect(result.qty).toBe(3);
    expect(result.subtotal).toBe(30);
    expect(result.taxRate).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(30);
  });

  test('zero price item', function () {
    var result = computeLineItem({ rate: 0 }, 5);
    expect(result.unitPrice).toBe(0);
    expect(result.subtotal).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(0);
  });

  test('zero quantity returns zero subtotal', function () {
    var result = computeLineItem({ rate: 20 }, 0);
    expect(result.qty).toBe(0);
    expect(result.subtotal).toBe(0);
    expect(result.total).toBe(0);
  });

  test('discount reduces unit price', function () {
    // 10% discount on $100 → effectiveUnitPrice = $90
    var result = computeLineItem({ rate: 100 }, 2, { discountPct: 10 });
    expect(result.unitPrice).toBe(90);
    expect(result.subtotal).toBe(180);
    expect(result.total).toBe(180);
  });

  test('discount of 0 has no effect', function () {
    var result = computeLineItem({ rate: 50 }, 1, { discountPct: 0 });
    expect(result.unitPrice).toBe(50);
    expect(result.subtotal).toBe(50);
  });

  test('discount of 100 or more is ignored (not applied)', function () {
    // discountPct must be > 0 AND < 100 to be applied
    var result = computeLineItem({ rate: 50 }, 1, { discountPct: 100 });
    expect(result.unitPrice).toBe(50);
  });

  test('negative discount is ignored', function () {
    var result = computeLineItem({ rate: 50 }, 1, { discountPct: -10 });
    expect(result.unitPrice).toBe(50);
  });

  test('tax rate applied correctly (5% GST)', function () {
    var result = computeLineItem({ rate: 100 }, 1, { taxRate: 0.05 });
    expect(result.taxRate).toBe(0.05);
    expect(result.taxAmount).toBe(5);
    expect(result.total).toBe(105);
  });

  test('tax rate 12% (GST + PST)', function () {
    var result = computeLineItem({ rate: 100 }, 2, { taxRate: 0.12 });
    expect(result.subtotal).toBe(200);
    expect(result.taxAmount).toBe(24);
    expect(result.total).toBe(224);
  });

  test('weight item: fractional quantity (0.5 kg)', function () {
    var result = computeLineItem({ rate: 8 }, 0.5);
    expect(result.qty).toBe(0.5);
    expect(result.subtotal).toBe(4);
    expect(result.total).toBe(4);
  });

  test('weight item: fractional quantity with tax', function () {
    var result = computeLineItem({ rate: 10 }, 0.75, { taxRate: 0.05 });
    expect(result.subtotal).toBe(7.50);
    expect(result.taxAmount).toBe(0.38); // 7.50 * 0.05 = 0.375 → rounds to 0.38
    expect(result.total).toBe(7.88);
  });

  test('discount combined with tax', function () {
    // 20% off $50 → $40 per unit × 3 qty = $120 subtotal
    // 5% tax on $120 = $6 → total $126
    var result = computeLineItem({ rate: 50 }, 3, { discountPct: 20, taxRate: 0.05 });
    expect(result.unitPrice).toBe(40);
    expect(result.subtotal).toBe(120);
    expect(result.taxAmount).toBe(6);
    expect(result.total).toBe(126);
  });

  test('rounding: avoids float drift on classic 0.1+0.2 case', function () {
    // $14.99 × 3 = $44.97 (not $44.970000000000006)
    var result = computeLineItem({ rate: 14.99 }, 3);
    expect(result.subtotal).toBe(44.97);
  });

  test('handles missing product gracefully (defaults to rate 0)', function () {
    var result = computeLineItem(null, 2);
    expect(result.unitPrice).toBe(0);
    expect(result.subtotal).toBe(0);
  });

  test('handles undefined qty (defaults to 0)', function () {
    var result = computeLineItem({ rate: 20 }, undefined);
    expect(result.qty).toBe(0);
    expect(result.subtotal).toBe(0);
  });

  test('taxRate defaults to 0 if not provided', function () {
    var result = computeLineItem({ rate: 50 }, 1);
    expect(result.taxRate).toBe(0);
    expect(result.taxAmount).toBe(0);
  });

  test('negative taxRate is ignored (defaults to 0)', function () {
    var result = computeLineItem({ rate: 50 }, 1, { taxRate: -0.05 });
    expect(result.taxRate).toBe(0);
    expect(result.taxAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeCartTotals
// ---------------------------------------------------------------------------
describe('computeCartTotals', function () {
  test('empty cart returns all zeros', function () {
    var result = computeCartTotals([]);
    expect(result.subtotal).toBe(0);
    expect(result.taxTotal).toBe(0);
    expect(result.makersFee).toBe(0);
    expect(result.grandTotal).toBe(0);
  });

  test('null lineItems treated as empty', function () {
    var result = computeCartTotals(null);
    expect(result.grandTotal).toBe(0);
  });

  test('single item no tax', function () {
    var li = computeLineItem({ rate: 29.99 }, 2);
    var result = computeCartTotals([li]);
    expect(result.subtotal).toBe(59.98);
    expect(result.taxTotal).toBe(0);
    expect(result.grandTotal).toBe(59.98);
  });

  test('multiple items accumulate correctly', function () {
    var li1 = computeLineItem({ rate: 10 }, 2);  // subtotal 20
    var li2 = computeLineItem({ rate: 5 }, 4);   // subtotal 20
    var result = computeCartTotals([li1, li2]);
    expect(result.subtotal).toBe(40);
    expect(result.grandTotal).toBe(40);
  });

  test('tax totals accumulate from line items', function () {
    var li1 = computeLineItem({ rate: 100 }, 1, { taxRate: 0.05 }); // tax 5
    var li2 = computeLineItem({ rate: 100 }, 1, { taxRate: 0.12 }); // tax 12
    var result = computeCartTotals([li1, li2]);
    expect(result.taxTotal).toBe(17);
    expect(result.subtotal).toBe(200);
    expect(result.grandTotal).toBe(217);
  });

  test('zero-tax items contribute 0 taxAmount', function () {
    var li1 = computeLineItem({ rate: 50 }, 1);           // no tax
    var li2 = computeLineItem({ rate: 50 }, 1, { taxRate: 0.05 }); // 5% tax
    var result = computeCartTotals([li1, li2]);
    expect(result.taxTotal).toBe(2.50);
    expect(result.subtotal).toBe(100);
    expect(result.grandTotal).toBe(102.50);
  });

  test('makers fee added to grand total', function () {
    var li = computeLineItem({ rate: 100 }, 1);
    var result = computeCartTotals([li], 50);
    expect(result.makersFee).toBe(50);
    expect(result.subtotal).toBe(100);
    expect(result.grandTotal).toBe(150);
  });

  test('makers fee of 0 does not affect total', function () {
    var li = computeLineItem({ rate: 100 }, 1);
    var result = computeCartTotals([li], 0);
    expect(result.makersFee).toBe(0);
    expect(result.grandTotal).toBe(100);
  });

  test('negative makers fee is ignored (treated as 0)', function () {
    var li = computeLineItem({ rate: 100 }, 1);
    var result = computeCartTotals([li], -50);
    expect(result.makersFee).toBe(0);
    expect(result.grandTotal).toBe(100);
  });

  test('makers fee combined with tax', function () {
    var li = computeLineItem({ rate: 100 }, 1, { taxRate: 0.05 }); // subtotal 100, tax 5
    var result = computeCartTotals([li], 50); // makers fee 50
    expect(result.subtotal).toBe(100);
    expect(result.taxTotal).toBe(5);
    expect(result.makersFee).toBe(50);
    expect(result.grandTotal).toBe(155);
  });

  test('rounding after accumulation prevents float drift', function () {
    // Use prices that cause floating-point accumulation issues
    var li1 = computeLineItem({ rate: 0.1 }, 1);
    var li2 = computeLineItem({ rate: 0.2 }, 1);
    var result = computeCartTotals([li1, li2]);
    // Without rounding, 0.1 + 0.2 = 0.30000000000000004
    expect(result.subtotal).toBe(0.30);
    expect(result.grandTotal).toBe(0.30);
  });

  test('line items without taxAmount field treated as zero-tax', function () {
    var li = { subtotal: 75 }; // no taxAmount field
    var result = computeCartTotals([li]);
    expect(result.taxTotal).toBe(0);
    expect(result.grandTotal).toBe(75);
  });

  test('high-value cart rounds correctly', function () {
    // Simulate a large order: 10 items at $149.99 each
    var items = [];
    for (var i = 0; i < 10; i++) {
      items.push(computeLineItem({ rate: 149.99 }, 1, { taxRate: 0.05 }));
    }
    var result = computeCartTotals(items);
    expect(result.subtotal).toBe(1499.90);
    // 5% of 1499.90 = 74.995 → each item rounds to 7.50 × 10 = 75.00
    expect(result.taxTotal).toBe(75.00);
    expect(result.grandTotal).toBe(1574.90);
  });
});
