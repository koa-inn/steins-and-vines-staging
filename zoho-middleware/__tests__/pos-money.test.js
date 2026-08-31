'use strict';

/**
 * pos-money.test.js — Regression tests for D-12 money-path hardening on pos.js
 *
 * Task 1: atomic idempotency (acquireIdempotencyLock) + required key + deterministic Helcim key
 * Task 2: confirm propagates payment-recording failure so the outer void fires (no 201 ok:true)
 *
 * RED phase: these tests fail before the pos.js changes; GREEN phase: they pass after.
 */

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
      transactionId: 'txn-pos-money-123',
      authorizationCode: 'AUTH1',
      cardType: 'Visa'
    }),
    voidTransaction: jest.fn().mockResolvedValue({}),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-pos-1'),
    cancelTerminal: jest.fn().mockResolvedValue({}),
    // 50-03 (M-A3): captured-amount readback, added by plan 50-03 to the
    // plain-terminal confirm path. No default — configured per-test/describe
    // block below with the SAME total the test's own cart/catalog already
    // establishes, so the new verification step is transparent (no drift)
    // to every pre-existing scenario in this file.
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
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    acquireLock: jest.fn().mockResolvedValue(true)
  };
});

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

jest.mock('../lib/eventLog', function () {
  return { logEvent: jest.fn() };
});

jest.mock('../lib/mailer', function () {
  return { sendVoidFailureAlert: jest.fn().mockResolvedValue({}) };
});

jest.mock('../lib/inventory-ledger', function () {
  return {
    decrementStock: jest.fn().mockResolvedValue({}),
    reconcileFromZoho: jest.fn()
  };
});

jest.mock('../lib/brewpad-integration', function () {
  return { createBatchesFromSale: jest.fn() };
});

jest.mock('../lib/discount-match', function () {
  return { classifyCatalogItem: jest.fn().mockReturnValue([]), matches: jest.fn().mockReturnValue(false) };
});

jest.mock('../lib/checkout-helpers', function () {
  return {
    buildContactPayload: jest.fn(),
    // withTimeout pass-through so voidWithTimeout works in unit tests
    withTimeout: function (p) { return p; }
  };
});

jest.mock('axios', function () {
  return { post: jest.fn().mockResolvedValue({ data: { ok: true } }) };
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

// D-12: mock money-path so acquireIdempotencyLock and voidWithTimeout are spyable.
// voidWithTimeout calls through to helcimLike.voidTransaction so wrapper side-effects in pos.js run.
jest.mock('../lib/money-path', function () {
  return {
    acquireIdempotencyLock: jest.fn().mockResolvedValue({ status: 'acquired' }),
    voidWithTimeout: jest.fn().mockImplementation(function (helcimLike, txnId) {
      // Call through to helcimLike (pos.js wrapper) so _voidFailed tracking + cache.set fires
      return helcimLike.voidTransaction(txnId)
        .then(function () {})
        .catch(function () {}); // always resolves (mirrors real voidWithTimeout contract)
    }),
    CHECKOUT_IDEMPOTENCY_TTL: 600
  };
});

// ─── Test harness ─────────────────────────────────────────────────────────────

// Simple catalog item with no tax — rate = grandTotal
var SIMPLE_CATALOG = [
  {
    item_id: 'test-item-001',
    name: 'Test Kit',
    rate: 100.00,
    stock_on_hand: 10,
    tax_id: '',        // no tax: grandTotal = rate
    tax_percentage: 0,
    custom_fields: []
  }
];

var cache, zohoApi, helcimLib, ledger, moneyPath, router, handlers;

function getHandlers() {
  jest.resetModules();
  cache = require('../lib/cache');
  zohoApi = require('../lib/zoho-api');
  helcimLib = require('../lib/helcim');
  ledger = require('../lib/inventory-ledger');
  moneyPath = require('../lib/money-path');
  require('../routes/pos');
  router = require('express').Router();
  handlers = {};
  router.post.mock.calls.forEach(function (call) {
    handlers[call[0]] = call[call.length - 1];
  });
  router.get.mock.calls.forEach(function (call) {
    handlers[call[0]] = call[call.length - 1];
  });
}

function mockRes() {
  var r = { json: jest.fn(), status: jest.fn(), headersSent: false };
  r.status.mockReturnValue(r);
  return r;
}

// Helper: capture the last status code set on res
function captureStatus(res) {
  var captured = { code: null };
  res.status.mockImplementation(function (code) {
    captured.code = code;
    return res;
  });
  return captured;
}

// ─── Task 1: atomic idempotency + required key + deterministic Helcim key ─────

describe('pos — D-12 Task 1: atomic idempotency + required key (sale)', function () {
  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_TAX_RATE = '0';
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    // catalog lookup returns SIMPLE_CATALOG; idempotency keys return null (miss)
    cache.get.mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(SIMPLE_CATALOG);
      return Promise.resolve(null);
    });
    cache.acquireLock.mockResolvedValue(true);
    moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'acquired' });
  });

  afterEach(function () {
    delete process.env.KIOSK_TAX_RATE;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.NODE_ENV;
  });

  test('T1: missing idempotency_key in production → 400 with idempotency_key error', function (done) {
    process.env.NODE_ENV = 'production';
    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }]
        // no idempotency_key
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(400);
        expect(body.error).toMatch(/idempotency_key/i);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  test('T2: sale contention (acquireIdempotencyLock returns "contention") → 409', function (done) {
    moneyPath.acquireIdempotencyLock.mockResolvedValueOnce({ status: 'contention' });
    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }],
        idempotency_key: 'sale-dup-key-001'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(409);
        expect(body.error).toBeTruthy();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  test('T3: sale failclosed (acquireIdempotencyLock returns "failclosed") → 409', function (done) {
    moneyPath.acquireIdempotencyLock.mockResolvedValueOnce({ status: 'failclosed' });
    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }],
        idempotency_key: 'sale-failclosed-key'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(409);
        expect(body.error).toBeTruthy();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  test('T4: sale acquireIdempotencyLock called with KIOSK_IDEM_PREFIX key', function (done) {
    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }],
        idempotency_key: 'client-key-abc'
      }
    };
    var res = mockRes();
    captureStatus(res);
    res.json.mockImplementation(function () {
      try {
        expect(moneyPath.acquireIdempotencyLock).toHaveBeenCalledWith(
          cache,
          'test:idem:client-key-abc',
          expect.any(Number)
        );
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  test('T5: terminalPurchase receives deterministic Helcim key derived from client idempotency_key', function (done) {
    var clientKey = 'client-idem-key-deterministic';
    var crypto = require('crypto');
    var expectedHelcimKey = crypto.createHash('sha256').update(clientKey).digest('hex').substring(0, 25);

    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }],
        idempotency_key: clientKey
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function () {
      try {
        if (statusCapture.code >= 400) {
          done(new Error('Unexpected status ' + statusCapture.code));
          return;
        }
        expect(helcimLib.terminalPurchase).toHaveBeenCalled();
        var callArgs = helcimLib.terminalPurchase.mock.calls[0];
        // Third arg is the deterministic Helcim idempotency key
        expect(callArgs[2]).toBe(expectedHelcimKey);
        // Verify same client key always maps to same Helcim key (determinism)
        var sameKey = crypto.createHash('sha256').update(clientKey).digest('hex').substring(0, 25);
        expect(callArgs[2]).toBe(sameKey);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });
});

describe('pos — D-12 Task 1: atomic idempotency + required key (confirm)', function () {
  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_TAX_RATE = '0';
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    cache.get.mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(SIMPLE_CATALOG);
      return Promise.resolve(null);
    });
    cache.acquireLock.mockResolvedValue(true);
    moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'acquired' });
    zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
    // 50-03 (M-A3): captured-amount readback now runs on every plain-terminal
    // confirm. SIMPLE_CATALOG rate=100, qty=1, KIOSK_TAX_RATE=0 -> grandTotal=100
    // for every test in this describe block — matching capture, no drift.
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 100.00 });
  });

  afterEach(function () {
    delete process.env.KIOSK_TAX_RATE;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.NODE_ENV;
  });

  test('T6: confirm missing idempotency_key in production — falls back to transaction_id seed, proceeds to 201 (CR-01)', function (done) {
    // CR-01 fix: the old code bare-400'd here, orphaning any charge already made.
    // After the fix, the server derives the idem seed from body.transaction_id and
    // proceeds normally — NEVER returns a bare 400 on the confirm path.
    process.env.NODE_ENV = 'production';
    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }],
        transaction_id: 'txn-001',
        reference_number: 'REF-001'
        // no idempotency_key — CR-01: must NOT 400; falls back to transaction_id seed
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        // Must NOT 400 — the terminal was already charged; bare 400 = orphan charge
        expect(statusCapture.code).toBe(201);
        expect(body.ok).toBe(true);
        // Confirm must have derived seed from transaction_id
        expect(moneyPath.acquireIdempotencyLock).toHaveBeenCalledWith(
          cache,
          'test:idem:confirm:txn-001',
          expect.any(Number)
        );
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('T7: confirm contention → 409', function (done) {
    moneyPath.acquireIdempotencyLock.mockResolvedValueOnce({ status: 'contention' });
    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }],
        transaction_id: 'txn-dup',
        reference_number: 'REF-DUP',
        idempotency_key: 'confirm-dup-key-001'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(409);
        expect(body.error).toBeTruthy();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('T8: confirm acquireIdempotencyLock called with "confirm:" prefixed key', function (done) {
    var req = {
      body: {
        items: [{ item_id: 'test-item-001', name: 'Test Kit', quantity: 1 }],
        transaction_id: 'txn-001',
        reference_number: 'REF-001',
        idempotency_key: 'confirm-client-key-abc'
      }
    };
    var res = mockRes();
    captureStatus(res);
    res.json.mockImplementation(function () {
      try {
        expect(moneyPath.acquireIdempotencyLock).toHaveBeenCalledWith(
          cache,
          'test:idem:confirm:confirm-client-key-abc',
          expect.any(Number)
        );
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });
});

// ─── Task 2: confirm propagates payment-recording failure ─────────────────────

describe('pos — D-12 Task 2: confirm propagates payment recording failure', function () {
  // Custom (tax-exempt) line bypasses catalog check; rate=100 → grandTotal=100, terminalApplied=100
  var CONFIRM_BODY_BASE = {
    items: [{ custom: true, description: 'Test Item', quantity: 1, rate: 100, taxable: false }],
    transaction_id: 'txn-confirm-task2-001',
    reference_number: 'KIOSK-CONFIRM-TASK2',
    idempotency_key: 'confirm-propagate-key-task2'
  };

  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_TAX_RATE = '0';
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    // idempotency keys: null (miss → acquired); catalog: null (custom items bypass check)
    cache.get.mockResolvedValue(null);
    cache.acquireLock.mockResolvedValue(true);
    moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'acquired' });
    // Invoice creation succeeds; payment recording FAILS (the bug we're fixing)
    zohoApi.zohoPost.mockImplementation(function (path) {
      if (path === '/invoices') {
        return Promise.resolve({ invoice: { invoice_id: 'inv-task2', invoice_number: 'INV-TASK2-001' } });
      }
      if (path.indexOf('/submit') !== -1) {
        return Promise.resolve({});
      }
      if (path === '/customerpayments') {
        return Promise.reject(new Error('Zoho customerpayment recording 500'));
      }
      return Promise.resolve({});
    });
    helcimLib.voidTransaction.mockResolvedValue({}); // default: void succeeds
  });

  afterEach(function () {
    delete process.env.KIOSK_TAX_RATE;
    delete process.env.KIOSK_CONTACT_ID;
  });

  test('T9: payment recording failure → non-2xx response (not 201 ok:true)', function (done) {
    var req = { body: Object.assign({}, CONFIRM_BODY_BASE) };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        // Must NOT be a 201 success response
        expect(statusCapture.code).not.toBe(201);
        expect(body.ok).not.toBe(true);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('T10: payment recording failure → moneyPath.voidWithTimeout called with transaction_id', function (done) {
    var req = { body: Object.assign({}, CONFIRM_BODY_BASE) };
    var res = mockRes();
    captureStatus(res);
    res.json.mockImplementation(function () {
      try {
        expect(moneyPath.voidWithTimeout).toHaveBeenCalled();
        var callArgs = moneyPath.voidWithTimeout.mock.calls[0];
        // Second arg is the txnId to void
        expect(callArgs[1]).toBe(CONFIRM_BODY_BASE.transaction_id);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('T11: payment recording failure → ledger.decrementStock NOT called', function (done) {
    var req = { body: Object.assign({}, CONFIRM_BODY_BASE) };
    var res = mockRes();
    captureStatus(res);
    res.json.mockImplementation(function () {
      try {
        expect(ledger.decrementStock).not.toHaveBeenCalled();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('T12: void failure after recording failure → 502 with needs_manual_review + sv:void-failure cached', function (done) {
    helcimLib.voidTransaction.mockRejectedValue(new Error('Helcim void 503'));

    var req = { body: Object.assign({}, CONFIRM_BODY_BASE) };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(502);
        expect(body.needs_manual_review).toBe(true);
        // sv:void-failure: record must be persisted
        var cacheSetCalls = cache.set.mock.calls;
        var voidFailureRecord = cacheSetCalls.find(function (c) {
          return typeof c[0] === 'string' && c[0].indexOf('sv:void-failure:') === 0;
        });
        expect(voidFailureRecord).toBeTruthy();
        expect(voidFailureRecord[1].needs_manual_review).toBe(true);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('T13: void success after recording failure → 502 with payment_voided:true, no needs_manual_review', function (done) {
    helcimLib.voidTransaction.mockResolvedValue({ ok: true });

    var req = { body: Object.assign({}, CONFIRM_BODY_BASE) };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(502);
        expect(body.payment_voided).toBe(true);
        expect(body.needs_manual_review).toBeUndefined();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });
});
