'use strict';

/**
 * Regression: the 87-18 staging parity gate found 175 get_batches differences, all
 * data.batches[].product_sku. Sheets stores an all-digit SKU as a number cell, so Apps Script
 * emits a JSON number; Postgres stores text and serializeBatch emitted a string. product_sku must
 * follow the bin_id rule (87-DESIGN Q4), without turning leading-zero text into a different value.
 */

var rules = require('../lib/batch-rules');

function rowWithSku(sku) {
  return { batch_id: 'SV-B-000001', status: 'primary', product_sku: sku };
}

describe('serializeBatch product_sku typing (sheet parity)', function () {
  it('emits an all-digit SKU as a JSON number, like the sheet', function () {
    expect(rules.serializeBatch(rowWithSku('1234567')).product_sku).toBe(1234567);
  });

  it('keeps a non-numeric SKU as text', function () {
    expect(rules.serializeBatch(rowWithSku('PCB-055')).product_sku).toBe('PCB-055');
  });

  it('keeps a leading-zero SKU as text so its value is unchanged', function () {
    expect(rules.serializeBatch(rowWithSku('00123')).product_sku).toBe('00123');
  });

  it('emits blank as an empty string', function () {
    expect(rules.serializeBatch(rowWithSku(null)).product_sku).toBe('');
    expect(rules.serializeBatch(rowWithSku('')).product_sku).toBe('');
  });
});
