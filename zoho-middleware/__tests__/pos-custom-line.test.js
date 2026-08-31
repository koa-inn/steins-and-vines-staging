'use strict';

// Mock all dependencies before requiring the module
jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn(), put: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({ idempotencyKey: 'idem-1' }),
    pollTerminalResult: jest.fn().mockResolvedValue({
      approved: true,
      transactionId: 'txn-test-123',
      authorizationCode: 'AUTH1',
      cardType: 'Visa'
    }),
    voidTransaction: jest.fn().mockResolvedValue({}),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-so-1'),
    // 50-03 (M-A3): captured-amount readback, added by plan 50-03 to the
    // plain-terminal confirm path. No default — set per-test below with the
    // SAME total the test's own cart already establishes.
    getCardTransactionById: jest.fn()
  };
});
jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn().mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } }),
    zohoPut: jest.fn()
  };
});
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1)
  };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/mailer', function () { return { sendVoidFailureAlert: jest.fn() }; });
jest.mock('../lib/inventory-ledger', function () {
  return {
    decrementStock: jest.fn().mockResolvedValue({}),
    reconcileFromZoho: jest.fn()
  };
});
jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      KIOSK_PRODUCTS: 'test:kiosk-products',
      RECENT_ORDERS: 'test:recent-orders',
      KIOSK_IDEM_PREFIX: 'test:idem:',
      KIOSK_SALESORDERS: 'test:kiosk-salesorders',
      KIOSK_DISCOUNT_PRESETS: 'test:kiosk-discount-presets',
      CONSIGNMENT_REPORT_PREFIX: 'test:consignment:report:'
    },
    LEDGER_KEYS: {},
    RATE_LIMIT_PREFIX: 'test:rl:'
  };
});

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

// Catalog that includes a 5%-GST item (sales_tax_rule_id = ZOHO_TAX_SERVICES_RULE)
// Used to test auto-discovery of the GST tax_id.
var CATALOG_WITH_GST = [
  {
    item_id: 'item-gst',
    name: 'Wine Kit',
    rate: 100.00,
    stock_on_hand: 10,
    tax_id: 'tax-gst-5',
    sales_tax_rule_id: process.env.ZOHO_TAX_SERVICES_RULE || '109900000000033417',
    tax_percentage: 5,
    custom_fields: []
  }
];

// Catalog that has NO item with ZOHO_TAX_SERVICES_RULE — for fail-closed tests.
var CATALOG_NO_GST = [
  {
    item_id: 'item-standard',
    name: 'Standard Kit',
    rate: 80.00,
    stock_on_hand: 5,
    tax_id: 'tax-pst-12',
    sales_tax_rule_id: process.env.ZOHO_TAX_STANDARD_RULE || '109900000000033423',
    tax_percentage: 12,
    custom_fields: []
  }
];

// ---------------------------------------------------------------------------
// Test harness (mirrors pos-tax.test.js exactly)
// ---------------------------------------------------------------------------

describe('pos routes — custom line items', function () {
  var cache, zohoApi, helcimLib, router, handlers;

  function getHandlers() {
    jest.resetModules();
    cache = require('../lib/cache');
    zohoApi = require('../lib/zoho-api');
    helcimLib = require('../lib/helcim');
    require('../routes/pos');
    router = require('express').Router();
    handlers = {};
    router.post.mock.calls.forEach(function (call) {
      handlers[call[0]] = call[call.length - 1];
    });
    router.get.mock.calls.forEach(function (call) {
      handlers[call[0]] = call[call.length - 1];
    });
    router.put.mock.calls.forEach(function (call) {
      handlers[call[0]] = call[call.length - 1];
    });
  }

  function mockRes() {
    var res = { json: jest.fn(), status: jest.fn(), headersSent: false };
    res.status.mockReturnValue(res);
    return res;
  }

  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_TAX_RATE = '0.05';
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    process.env.ZOHO_TAX_SERVICES_RULE = '109900000000033417';
  });

  afterEach(function () {
    delete process.env.KIOSK_TAX_RATE;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.ZOHO_TAX_SERVICES_RULE;
    delete process.env.KIOSK_GST_TAX_ID;
  });

  // ---------------------------------------------------------------------------
  // /api/kiosk/sale — taxable custom line
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale — taxable custom line', function () {

    test('taxable custom line: grandTotal includes 5% GST and sale is accepted', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_GST);

      var req = {
        body: {
          items: [
            { custom: true, description: 'Repair', note: 'broke airlock', quantity: 1, rate: 100, taxable: true }
          ]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.pending).toBe(true);
          expect(body.reference).toBeTruthy();
          var termCall = helcimLib.terminalPurchase.mock.calls[0];
          // rate=100, qty=1, tax=5% => grandTotal=105
          expect(termCall[0]).toBe(105);
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('taxable custom line: not rejected by catalog check (no item_id)', function (done) {
      // Empty catalog — no items. A catalog line with no match would normally be rejected.
      cache.get.mockResolvedValue([]);
      // But KIOSK_GST_TAX_ID is set so fail-closed won't trigger
      process.env.KIOSK_GST_TAX_ID = 'tax-gst-override';

      var req = {
        body: {
          items: [
            { custom: true, description: 'Labour', note: '', quantity: 2, rate: 50, taxable: true }
          ]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.pending).toBe(true);
          // rate=50, qty=2, subtotal=100, tax=5% => grandTotal=105
          var termCall = helcimLib.terminalPurchase.mock.calls[0];
          expect(termCall[0]).toBe(105);
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // /api/kiosk/sale — tax-exempt custom line
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale — tax-exempt custom line', function () {

    test('tax-exempt custom line (taxable:false): grandTotal = rate*qty only, no tax', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_GST);

      var req = {
        body: {
          items: [
            { custom: true, description: 'Deposit', note: '', quantity: 1, rate: 50, taxable: false }
          ]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.pending).toBe(true);
          var termCall = helcimLib.terminalPurchase.mock.calls[0];
          // No tax: grandTotal = 50
          expect(termCall[0]).toBe(50);
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // /api/kiosk/sale — fail-closed: no GST tax_id resolvable
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale — fail-closed GST', function () {

    test('taxable custom line + no KIOSK_GST_TAX_ID + catalog with no 5% item => 400 with actionable error', function (done) {
      // CATALOG_NO_GST has no item with ZOHO_TAX_SERVICES_RULE
      cache.get.mockResolvedValue(CATALOG_NO_GST);
      // Ensure KIOSK_GST_TAX_ID is not set
      delete process.env.KIOSK_GST_TAX_ID;

      var req = {
        body: {
          items: [
            { custom: true, description: 'Repair', note: '', quantity: 1, rate: 100, taxable: true }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;
      var responseBody = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            responseBody = body;
            try {
              expect(statusCode).toBe(400);
              expect(responseBody.error).toMatch(/KIOSK_GST_TAX_ID|tax.exempt/i);
              // terminalPurchase must NOT have been called
              expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected a 400 status response but got res.json directly'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // /api/kiosk/sale/confirm — GST auto-discovery
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale/confirm — GST tax_id on Zoho invoice line', function () {

    test('GST auto-discovery: taxable custom line uses catalog item tax_id when KIOSK_GST_TAX_ID unset', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_GST);
      delete process.env.KIOSK_GST_TAX_ID;
      zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-2', invoice_number: 'INV-002' } });
      // 50-03 (M-A3): rate=100, taxable:true, 5% GST -> grandTotal=105
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 105.00 });

      var req = {
        body: {
          items: [
            { custom: true, description: 'Repair', note: 'broke airlock', quantity: 1, rate: 100, taxable: true }
          ],
          transaction_id: 'txn-auto-discovery'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.ok).toBe(true);
          var invoiceCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0] === '/invoices';
          });
          expect(invoiceCall).toBeTruthy();
          var payload = invoiceCall[1];
          var customLine = payload.line_items.find(function (li) {
            return !li.item_id;
          });
          expect(customLine).toBeTruthy();
          // Auto-discovered tax_id from CATALOG_WITH_GST item
          expect(customLine.tax_id).toBe('tax-gst-5');
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale/confirm'](req, res);
    });

    test('KIOSK_GST_TAX_ID env override: resolved tax_id equals the env value, no catalog scan needed', function (done) {
      // Even CATALOG_NO_GST is fine when env override is set
      cache.get.mockResolvedValue(CATALOG_NO_GST);
      process.env.KIOSK_GST_TAX_ID = 'tax-gst-env-override';
      zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-3', invoice_number: 'INV-003' } });
      // 50-03 (M-A3): rate=75, taxable:true, 5% GST -> grandTotal=78.75
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 78.75 });

      var req = {
        body: {
          items: [
            { custom: true, description: 'Special Charge', note: '', quantity: 1, rate: 75, taxable: true }
          ],
          transaction_id: 'txn-env-override'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.ok).toBe(true);
          var invoiceCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0] === '/invoices';
          });
          expect(invoiceCall).toBeTruthy();
          var payload = invoiceCall[1];
          var customLine = payload.line_items.find(function (li) {
            return !li.item_id;
          });
          expect(customLine).toBeTruthy();
          expect(customLine.tax_id).toBe('tax-gst-env-override');
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale/confirm'](req, res);
    });

    test('tax-exempt custom line: Zoho invoice line has no tax_id', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_GST);
      zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-4', invoice_number: 'INV-004' } });
      // 50-03 (M-A3): rate=50, taxable:false -> grandTotal=50
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 50.00 });

      var req = {
        body: {
          items: [
            { custom: true, description: 'Deposit', note: '', quantity: 1, rate: 50, taxable: false }
          ],
          transaction_id: 'txn-exempt'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.ok).toBe(true);
          var invoiceCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0] === '/invoices';
          });
          expect(invoiceCall).toBeTruthy();
          var payload = invoiceCall[1];
          var customLine = payload.line_items.find(function (li) {
            return !li.item_id;
          });
          expect(customLine).toBeTruthy();
          // tax-exempt: no tax_id on the invoice line
          expect(customLine.tax_id).toBeUndefined();
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale/confirm'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // Description shaping (D-04)
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale/confirm — description shaping (D-04)', function () {

    test('description + note => Zoho line description is "Description — Note"', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_GST);
      zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-5', invoice_number: 'INV-005' } });
      // 50-03 (M-A3): rate=100, taxable:true, 5% GST -> grandTotal=105
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 105.00 });

      var req = {
        body: {
          items: [
            { custom: true, description: 'Repair', note: 'broke airlock', quantity: 1, rate: 100, taxable: true }
          ],
          transaction_id: 'txn-desc-note'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function () {
        try {
          var invoiceCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0] === '/invoices';
          });
          var payload = invoiceCall[1];
          var customLine = payload.line_items.find(function (li) { return !li.item_id; });
          expect(customLine.description).toBe('Repair — broke airlock');
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale/confirm'](req, res);
    });

    test('blank note => Zoho line description is just the description', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_GST);
      zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-6', invoice_number: 'INV-006' } });
      // 50-03 (M-A3): rate=60, taxable:true, 5% GST -> grandTotal=63
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 63.00 });

      var req = {
        body: {
          items: [
            { custom: true, description: 'Labour', note: '', quantity: 1, rate: 60, taxable: true }
          ],
          transaction_id: 'txn-desc-only'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function () {
        try {
          var invoiceCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0] === '/invoices';
          });
          var payload = invoiceCall[1];
          var customLine = payload.line_items.find(function (li) { return !li.item_id; });
          expect(customLine.description).toBe('Labour');
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale/confirm'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // Negative rate and net-zero guard (D-03)
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale — negative rate / grandTotal guards', function () {

    test('negative custom rate + catalog item keeping grandTotal>0 is accepted', function (done) {
      // catalog item rate=200, custom rate=-10, total before tax = 190
      var catalogWithItem = [
        {
          item_id: 'item-big',
          name: 'Big Kit',
          rate: 200.00,
          stock_on_hand: 5,
          tax_id: 'tax-gst-5',
          sales_tax_rule_id: '109900000000033417',
          tax_percentage: 5,
          custom_fields: []
        }
      ];
      cache.get.mockResolvedValue(catalogWithItem);
      process.env.KIOSK_GST_TAX_ID = 'tax-gst-5';

      var req = {
        body: {
          items: [
            { item_id: 'item-big', name: 'Big Kit', quantity: 1 },
            { custom: true, description: 'Discount', note: '', quantity: 1, rate: -10, taxable: false }
          ]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.pending).toBe(true);
          // item-big: 200 + 5% = 210; custom -10 exempt: grandTotal = 210 - 10 = 200
          var termCall = helcimLib.terminalPurchase.mock.calls[0];
          expect(termCall[0]).toBe(200);
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('cart where grandTotal nets <= 0 is rejected by the existing grandTotal>0 guard', function (done) {
      process.env.KIOSK_GST_TAX_ID = 'tax-gst-5';
      // empty catalog, single custom line with negative rate
      cache.get.mockResolvedValue([]);

      var req = {
        body: {
          items: [
            { custom: true, description: 'Credit', note: '', quantity: 1, rate: -100, taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toMatch(/greater than zero/i);
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 status response'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // Large rate validation (D-03, T-43-01)
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale — large rate server-side cap', function () {

    test('custom line rate > 10000 (abs) is rejected with a clear error before terminal charge', function (done) {
      cache.get.mockResolvedValue([]);

      var req = {
        body: {
          items: [
            { custom: true, description: 'Huge Charge', note: '', quantity: 1, rate: 10001, taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toBeTruthy();
              expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 status response for large rate'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('custom line negative rate beyond -10000 is rejected', function (done) {
      cache.get.mockResolvedValue([]);

      var req = {
        body: {
          items: [
            { custom: true, description: 'Big Credit', note: '', quantity: 1, rate: -10001, taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toBeTruthy();
              expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 status response for large negative rate'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation: description / quantity (D-05)
  // ---------------------------------------------------------------------------

  describe('/api/kiosk/sale — custom line validation (D-05)', function () {

    test('missing description is rejected', function (done) {
      cache.get.mockResolvedValue([]);

      var req = {
        body: {
          items: [
            { custom: true, description: '', note: '', quantity: 1, rate: 50, taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toBeTruthy();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 for missing description'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('description over 100 chars is rejected', function (done) {
      cache.get.mockResolvedValue([]);
      var longDesc = 'A'.repeat(101);

      var req = {
        body: {
          items: [
            { custom: true, description: longDesc, note: '', quantity: 1, rate: 50, taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toBeTruthy();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 for description > 100 chars'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('quantity 0 is rejected', function (done) {
      cache.get.mockResolvedValue([]);
      process.env.KIOSK_GST_TAX_ID = 'tax-gst-5';

      var req = {
        body: {
          items: [
            { custom: true, description: 'Valid', note: '', quantity: 0, rate: 50, taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toBeTruthy();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 for quantity 0'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('quantity 101 is rejected', function (done) {
      cache.get.mockResolvedValue([]);
      process.env.KIOSK_GST_TAX_ID = 'tax-gst-5';

      var req = {
        body: {
          items: [
            { custom: true, description: 'Valid', note: '', quantity: 101, rate: 50, taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toBeTruthy();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 for quantity 101'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('non-numeric rate is rejected', function (done) {
      cache.get.mockResolvedValue([]);

      var req = {
        body: {
          items: [
            { custom: true, description: 'Valid', note: '', quantity: 1, rate: 'abc', taxable: false }
          ]
        }
      };
      var res = mockRes();
      var statusCode = null;

      res.status.mockImplementation(function (code) {
        statusCode = code;
        return {
          json: function (body) {
            try {
              expect(statusCode).toBe(400);
              expect(body.error).toBeTruthy();
              done();
            } catch (e) { done(e); }
          }
        };
      });
      res.json.mockImplementation(function () {
        done(new Error('Expected 400 for non-numeric rate'));
      });

      handlers['/api/kiosk/sale'](req, res);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveDiscount — D-08: custom lines excluded from all discount presets
  // ---------------------------------------------------------------------------

  describe('resolveDiscount — D-08: custom lines excluded from discounts', function () {
    var resolveDiscount;

    beforeEach(function () {
      resolveDiscount = require('../routes/pos').resolveDiscount;
    });

    test('type-scope discount: custom line receives no discount and is not counted in matchedSubtotal', function () {
      var CATALOG_OBJ = {
        'w': { item_id: 'w', cf_type: 'wine', rate: 100 }
      };
      cache.get.mockResolvedValue([{
        id: 'd1',
        name: 'Wine 10%',
        type: 'percentage',
        value: 10,
        scope: 'type',
        applies_to: ['kit:wine'],
        active: true
      }]);

      var li = [
        { item_id: 'w', quantity: 1, rate: 100 },
        { custom: true, description: 'Repair', quantity: 1, rate: 50, taxable: true }
      ];

      return resolveDiscount({ discount: { preset_id: 'd1' } }, li, 150, CATALOG_OBJ).then(function (r) {
        // catalog item gets discount
        expect(li[0].discount).toBe('10%');
        // custom line must NOT have any discount
        expect(li[1].discount).toBeUndefined();
        // subtotal: wine discounted to 90, custom line 50 unchanged => 140
        expect(r.subtotal).toBe(140);
      });
    });

    test('cart-scope discount: custom line receives no discount share', function () {
      var CATALOG_OBJ = {
        'w': { item_id: 'w', cf_type: 'wine', rate: 100 }
      };
      cache.get.mockResolvedValue([{
        id: 'd2',
        name: 'Cart $20 off',
        type: 'fixed',
        value: 20,
        scope: 'cart',
        active: true
      }]);

      var li = [
        { item_id: 'w', quantity: 1, rate: 100 },
        { custom: true, description: 'Repair', quantity: 1, rate: 50, taxable: true }
      ];

      return resolveDiscount({ discount: { preset_id: 'd2' } }, li, 150, CATALOG_OBJ).then(function (r) {
        // custom line must NOT have a discount assigned by the cart-scope preset
        expect(li[1].discount).toBeUndefined();
      });
    });
  });
});
