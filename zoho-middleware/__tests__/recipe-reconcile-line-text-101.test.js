'use strict';

/**
 * Phase 101 review HI-01: reconcileRecipeInvoice re-sends the lines Zoho
 * echoed. Custom and canning-bundle lines have no item_id and keep their text
 * only in `description`, so the PUT must carry it.
 */

jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn(), zohoDelete: jest.fn() };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

var zohoApi = require('../lib/zoho-api');
var recipeLines = require('../lib/recipe-sale-lines');

var ECHO_LINES = [
  { line_item_id: 'li-1', item_id: '', name: '', description: 'Bottle rental', quantity: 1, rate: 5, discount: 0, tax_id: 'tax-gst' },
  { line_item_id: 'li-2', item_id: '', name: '', description: 'Canning Bundle — Beer 25 L (473 mL)', quantity: 1, rate: 40, discount: 0, tax_id: 'tax-std' },
  { line_item_id: 'li-3', item_id: 'can-473', name: 'Can 473 mL', description: '', quantity: 52, rate: 0, discount: 0, tax_id: 'tax-std' },
  { line_item_id: 'li-4', item_id: 'ing-grain-1', name: 'Pale Malt 2-Row', description: 'Base malt', quantity: 5.5, rate: 3.5, discount: 0, tax_id: 'tax-gst' }
];

test('the re-balance PUT keeps custom and bundle descriptions and omits empty item ids', function () {
  zohoApi.zohoPut.mockResolvedValue({ invoice: { total: 100.00 } });
  var created = { invoice: { invoice_id: 'inv-9', invoice_number: 'INV-009', total: 99.99, line_items: ECHO_LINES } };
  var payload = { line_items: [], adjustment: 10 };
  return recipeLines.reconcileRecipeInvoice(created, payload, 100.00).then(function () {
    var put = zohoApi.zohoPut.mock.calls[0][1];
    expect(put.adjustment).toBe(10.01);
    expect(put.line_items).toEqual([
      { line_item_id: 'li-1', description: 'Bottle rental', quantity: 1, rate: 5, discount: 0, tax_id: 'tax-gst' },
      { line_item_id: 'li-2', description: 'Canning Bundle — Beer 25 L (473 mL)', quantity: 1, rate: 40, discount: 0, tax_id: 'tax-std' },
      { line_item_id: 'li-3', item_id: 'can-473', name: 'Can 473 mL', quantity: 52, rate: 0, discount: 0, tax_id: 'tax-std' },
      { line_item_id: 'li-4', item_id: 'ing-grain-1', name: 'Pale Malt 2-Row', description: 'Base malt', quantity: 5.5, rate: 3.5, discount: 0, tax_id: 'tax-gst' }
    ]);
  });
});
