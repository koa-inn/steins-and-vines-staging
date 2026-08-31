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
    // SAME total the test's own cart/catalog already establishes.
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
jest.mock('../lib/eventLog', function () {
  return { logEvent: jest.fn() };
});
jest.mock('../lib/mailer', function () {
  return { sendVoidFailureAlert: jest.fn() };
});
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

// Catalog items used in tests
var CATALOG_WITH_TAX = [
  {
    item_id: 'item-gst',
    name: 'Wine Kit',
    rate: 100.00,
    stock_on_hand: 10,
    tax_id: 'tax-gst-5',
    tax_name: 'GST 5%',
    tax_percentage: 5,
    custom_fields: []
  },
  {
    // no tax_percentage, no tax_id, no sales_tax_rule_id — CONTEXT.md: a
    // genuinely unresolvable tax must fail closed (Phase 67), not guess 5%.
    item_id: 'item-zero',
    name: 'Gift Card',
    rate: 50.00,
    stock_on_hand: 20,
    tax_id: '',
    tax_name: '',
    custom_fields: []
  },
  {
    item_id: 'item-zero-rated',
    name: 'Zero Rated Ingredient',
    rate: 40.00,
    stock_on_hand: 20,
    tax_id: 'tax-zero-rated',
    tax_name: 'Zero Rated',
    sales_tax_rule_id: process.env.ZOHO_TAX_ZERO_RULE || '109900000000033411',
    custom_fields: []
  },
  {
    item_id: 'item-pst',
    name: 'Cider Kit',
    rate: 80.00,
    stock_on_hand: 5,
    tax_id: 'tax-gst-pst-12',
    tax_name: 'GST+PST 12%',
    tax_percentage: 12,
    custom_fields: []
  }
];

describe('pos routes — per-item tax on line items', function () {
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
  });

  afterEach(function () {
    delete process.env.KIOSK_TAX_RATE;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.ZOHO_TAX_ZERO_ID;
  });

  // --- processSale tests ---

  describe('/api/kiosk/sale — processSale per-item tax', function () {

    test('returns 202 pending and pushes to terminal with correct total (item with tax_id)', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_TAX);

      var req = {
        body: {
          items: [{ item_id: 'item-gst', name: 'Wine Kit', quantity: 1 }]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.pending).toBe(true);
          expect(body.reference).toBeTruthy();
          var termCall = helcimLib.terminalPurchase.mock.calls[0];
          expect(termCall[0]).toBe(105); // 100 + (100 * 0.05)
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

    // Phase 67 (CLAUDE.md rule 10 exception, per CONTEXT.md): this test pinned
    // the OLD documented KIOSK_TAX_RATE 5%-fallback behavior. Decision "Remove
    // all three silent 5% fallbacks" removes it — an item with no
    // tax_percentage, no tax_id, and no matching tax rule is now a fail-closed
    // data error, not a guessed 5% charge.
    test('returns 400 rejected for item with unresolvable tax (no tax_percentage, no tax_id, no rule) — fail-closed, not a 5% guess', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_TAX);

      var req = {
        body: {
          items: [{ item_id: 'item-zero', name: 'Gift Card', quantity: 1 }]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.error).toMatch(/Gift Card|item-zero/i);
          expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        expect(code).toBe(400);
        return res;
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    // Phase 67 review fix (CR-02): rebuildKioskCatalog now serves a genuinely
    // unresolvable tax as tax_percentage: null (it previously fabricated 0,
    // which made this fail-closed branch unreachable in production). Pin the
    // EXACT shape the real builder emits so these tests stay representative.
    test('CR-02: real builder output shape (tax_percentage: null, empty tax_id/rule) is rejected fail-closed', function (done) {
      cache.get.mockResolvedValue([
        {
          item_id: 'item-null-tax',
          name: 'Unconfigured Import',
          rate: 75.00,
          stock_on_hand: 10,
          tax_id: '',
          tax_name: '',
          tax_percentage: null,     // ← what rebuildKioskCatalog serves for a missing tax
          sales_tax_rule_id: '',
          custom_fields: []
        }
      ]);

      var req = {
        body: {
          items: [{ item_id: 'item-null-tax', name: 'Unconfigured Import', quantity: 1 }]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.error).toMatch(/Unconfigured Import|item-null-tax/i);
          expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        expect(code).toBe(400);
        return res;
      });

      handlers['/api/kiosk/sale'](req, res);
    });

    test('legitimate 0% catalog item (real zero-rate tax rule) still sells with tax 0', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_TAX);

      var req = {
        body: {
          items: [{ item_id: 'item-zero-rated', name: 'Zero Rated Ingredient', quantity: 1 }]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.pending).toBe(true);
          var termCall = helcimLib.terminalPurchase.mock.calls[0];
          expect(termCall[0]).toBe(40.00); // rate 40, 0% real zero-rate rule — no tax added
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

    test('grandTotal computed using per-item tax_percentage from catalog (not flat 0.05)', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_TAX);
      zohoApi.zohoPost.mockResolvedValue({
        invoice: { invoice_id: 'inv-3', invoice_number: 'INV-003' }
      });

      // item-pst has rate=80, tax_percentage=12 => tax=9.60, total=89.60
      var req = {
        body: {
          items: [{ item_id: 'item-pst', name: 'Cider Kit', quantity: 1 }]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function () {
        try {
          // terminalPurchase should have been called with grandTotal = 89.60
          var termCall = helcimLib.terminalPurchase.mock.calls[0];
          expect(termCall[0]).toBe(89.60); // 80 + (80 * 0.12) = 89.60
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

    // Phase 67 (CLAUDE.md rule 10 exception, per CONTEXT.md): pinned the OLD
    // documented KIOSK_TAX_RATE 5%-fallback. Note the fixture below has NO
    // tax_percentage key at all (not `tax_percentage: 0`) — a truly missing
    // value is the genuine data error the new NaN-preserving resolution
    // detects; an explicit 0 stays a valid resolved rate (see the
    // legitimate-0% test above).
    test('sale is rejected (no 5% applied) when catalogItem has no tax_id AND no tax_percentage', function (done) {
      var catalogNoTax = [{
        item_id: 'item-notax',
        name: 'Mystery Item',
        rate: 100.00,
        stock_on_hand: 10,
        tax_id: '',
        tax_name: '',
        custom_fields: []
      }];
      cache.get.mockResolvedValue(catalogNoTax);

      var req = {
        body: {
          items: [{ item_id: 'item-notax', name: 'Mystery Item', quantity: 1 }]
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.error).toMatch(/Mystery Item|item-notax/i);
          expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        expect(code).toBe(400);
        return res;
      });

      handlers['/api/kiosk/sale'](req, res);
    });
  });

  // --- confirm endpoint tests ---

  describe('/api/kiosk/sale/confirm — per-item tax', function () {

    test('confirm endpoint lineItems include tax_id same as processSale', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_TAX);
      zohoApi.zohoPost.mockResolvedValue({
        invoice: { invoice_id: 'inv-5', invoice_number: 'INV-005' }
      });
      // 50-03 (M-A3): item-gst qty2 (100*2 + 5%=10) + item-pst qty1 (80 + 12%=9.60) = 299.60
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 299.60 });

      var req = {
        body: {
          items: [
            { item_id: 'item-gst', name: 'Wine Kit', quantity: 2 },
            { item_id: 'item-pst', name: 'Cider Kit', quantity: 1 }
          ],
          transaction_id: 'manual-confirm-test'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function () {
        try {
          var invoiceCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0] === '/invoices';
          });
          expect(invoiceCall).toBeTruthy();
          var payload = invoiceCall[1];
          // item-gst should have tax_id
          var gstItem = payload.line_items.find(function (li) { return li.item_id === 'item-gst'; });
          expect(gstItem.tax_id).toBe('tax-gst-5');
          // item-pst should have tax_id
          var pstItem = payload.line_items.find(function (li) { return li.item_id === 'item-pst'; });
          expect(pstItem.tax_id).toBe('tax-gst-pst-12');
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

    test('F3: exempt custom line is tagged with ZOHO_TAX_ZERO_ID so Zoho does not default-tax it', function (done) {
      // 45-09 UAT: a tax-exempt custom line has no backing Zoho item, so an
      // un-tagged line (tax_percentage:0 only, no tax_id) gets DEFAULT-taxed by
      // Zoho — leaving the invoice partially_paid (phantom GST). The fix attaches
      // the explicit Zero Rate tax_id so Zoho books the line at a real 0%.
      process.env.ZOHO_TAX_ZERO_ID = 'tax-zero-test';
      cache.get.mockResolvedValue(CATALOG_WITH_TAX);
      zohoApi.zohoPost.mockResolvedValue({
        invoice: { invoice_id: 'inv-f3', invoice_number: 'INV-F3' }
      });
      // 50-03 (M-A3): custom line rate=10, taxable:false -> grandTotal=10
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 10.00 });

      var req = {
        body: {
          items: [
            { custom: true, description: 'Test', rate: 10, quantity: 1, taxable: false }
          ],
          transaction_id: 'manual-confirm-f3',
          reference_number: 'KIOSK-F3'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function () {
        try {
          var invoiceCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0] === '/invoices';
          });
          expect(invoiceCall).toBeTruthy();
          var customLine = invoiceCall[1].line_items.find(function (li) { return li.custom; });
          expect(customLine).toBeTruthy();
          expect(customLine.tax_id).toBe('tax-zero-test');
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

    test('confirm endpoint computes grandTotal with per-item tax', function (done) {
      cache.get.mockResolvedValue(CATALOG_WITH_TAX);
      zohoApi.zohoPost.mockResolvedValue({
        invoice: { invoice_id: 'inv-6', invoice_number: 'INV-006' }
      });
      // 50-03 (M-A3): grandTotal = 194.60 (see comment below)
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 194.60 });

      // item-gst: rate=100, qty=1, tax=5% => subtotal=100, tax=5
      // item-pst: rate=80, qty=1, tax=12% => subtotal=80, tax=9.60
      // Total subtotal=180, total tax=14.60, grandTotal=194.60
      var req = {
        body: {
          items: [
            { item_id: 'item-gst', name: 'Wine Kit', quantity: 1 },
            { item_id: 'item-pst', name: 'Cider Kit', quantity: 1 }
          ],
          transaction_id: 'manual-confirm-tax'
        }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          // grandTotal = 180 + 14.60 = 194.60
          expect(body.total).toBe(194.60);
          expect(body.tax_total).toBe(14.60);
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

  // --- salesorder-pay SO-to-Invoice tests ---

  describe('/api/kiosk/salesorder-pay — SO-to-Invoice conversion', function () {

    test('salesorder-pay calls zohoPost with /invoices/fromsalesorder after payment recording', function (done) {
      var soData = {
        salesorder: {
          salesorder_id: 'so-123',
          salesorder_number: 'SO-001',
          customer_id: 'cust-1',
          balance: 150.00,
          order_status: 'open'
        }
      };

      // zohoGet returns SO data
      zohoApi.zohoGet.mockResolvedValue(soData);

      // Track zohoPost calls in order
      var postCallIndex = 0;
      zohoApi.zohoPost.mockImplementation(function (url) {
        postCallIndex++;
        if (url.indexOf('/customerpayments') !== -1) {
          return Promise.resolve({ payment: { payment_id: 'pay-1' } });
        }
        if (url.indexOf('/invoices/fromsalesorder') !== -1) {
          return Promise.resolve({ invoice: { invoice_id: 'inv-from-so', invoice_number: 'INV-FROM-SO-001' } });
        }
        if (url.indexOf('/status/sent') !== -1) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      var req = {
        body: { salesorder_id: 'so-123' }
      };
      var res = mockRes();

      res.json.mockImplementation(function (body) {
        try {
          expect(body.ok).toBe(true);
          // Verify fromsalesorder was called
          var fromsalesorderCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0].indexOf('/invoices/fromsalesorder') !== -1;
          });
          expect(fromsalesorderCall).toBeTruthy();
          expect(fromsalesorderCall[0]).toContain('salesorder_id=so-123');

          // Verify the invoice was finalized via /status/sent (NOT /submit)
          var finalizeCall = zohoApi.zohoPost.mock.calls.find(function (c) {
            return c[0].indexOf('/invoices/inv-from-so/status/sent') !== -1;
          });
          expect(finalizeCall).toBeTruthy();

          // Verify kiosk products cache was busted
          var delCalls = cache.del.mock.calls.map(function (c) { return c[0]; });
          expect(delCalls).toContain('test:kiosk-products');

          done();
        } catch (e) { done(e); }
      });
      res.status.mockImplementation(function (code) {
        if (code >= 400) {
          return { json: function (body) { done(new Error('Got status ' + code + ': ' + JSON.stringify(body))); } };
        }
        return res;
      });

      handlers['/api/kiosk/salesorder-pay'](req, res);
    });

    test('salesorder-pay VOIDS the charge + returns 502 when invoice finalize fails (fail-closed)', function (done) {
      // Behavior change (phase-71 twin fix): the invoice is no longer optional —
      // the payment must apply to a finalized invoice. If finalize/apply fails
      // AFTER the terminal charge, the route reverses the charge (void) and
      // returns 502 rather than silently marking the SO paid via an advance.
      var soData = {
        salesorder: {
          salesorder_id: 'so-456',
          salesorder_number: 'SO-002',
          customer_id: 'cust-2',
          balance: 200.00,
          order_status: 'open',
          invoices: []
        }
      };

      zohoApi.zohoGet.mockResolvedValue(soData);

      zohoApi.zohoPost.mockImplementation(function (url) {
        if (url.indexOf('/invoices/fromsalesorder') !== -1) {
          return Promise.reject(new Error('Zoho API error: rate limited'));
        }
        if (url.indexOf('/customerpayments') !== -1) {
          return Promise.resolve({ payment: { payment_id: 'pay-2' } });
        }
        return Promise.resolve({});
      });

      var req = {
        body: { salesorder_id: 'so-456' }
      };
      var res = mockRes();

      res.status.mockImplementation(function (code) {
        return { json: function (body) {
          try {
            expect(code).toBe(502);
            expect(body.payment_voided).toBe(true);
            expect(body.voided_transaction_id).toBe('txn-test-123');
            // Charge was reversed — no charge without a booked invoice
            expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-test-123');
            // Payment must NOT have been applied (finalize failed first)
            var payCall = zohoApi.zohoPost.mock.calls.find(function (c) {
              return c[0].indexOf('/customerpayments') !== -1;
            });
            expect(payCall).toBeUndefined();
            done();
          } catch (e) { done(e); }
        } };
      });
      res.json.mockImplementation(function () {
        done(new Error('should not reach the ok path — invoice finalize failed'));
      });

      handlers['/api/kiosk/salesorder-pay'](req, res);
    });
  });
});
