'use strict';

/**
 * pos-idem-lock-release.test.js — Regression tests for Phase 50-03 (H4 / SC#2)
 *
 * `runConfirm`'s outer `.catch` voids the charge and returns an error but
 * NEVER releases `confirmIdemKey`. The lock lives for the full
 * IDEMPOTENCY_KEY_TTL (300s). Staff retry the same sale, the client sends
 * the same key, and `acquireIdempotencyLock` returns `contention` → 409
 * "Confirm already in progress" — for five minutes, mid-transaction, after
 * the charge was already voided.
 *
 * D-50-03: on response finish, if `res.statusCode >= 400` AND
 * `res.locals.__keepIdemLock !== true`, release the lock. The exception is
 * load-bearing: when the void itself FAILED (`_voidFailed === true` — the
 * customer is still charged), the lock must stay HELD so a retry cannot
 * charge a second time on top of a live, unvoided first charge.
 *
 * These tests use MOTO tender deliberately: it gives every case a real,
 * void-able `transaction_id` via the pre-existing (unrelated to this plan)
 * 70-02 verifyMotoCharge gate, WITHOUT depending on plan 50-03's OWN new
 * M-A3 captured-amount check (which explicitly skips tender:'moto' — see
 * pos-confirm-amount-drift.test.js). This keeps the two new regression
 * suites decoupled: a failure in one plan-50-03 feature cannot mask or
 * fake-pass the other.
 *
 * `../lib/money-path` is REAL here (not mocked) for `acquireIdempotencyLock`
 * and `voidWithTimeout` — a fully-mocked `acquireIdempotencyLock` would
 * always resolve 'acquired' regardless of whether the lock was actually
 * released, making case 8 (retry re-acquires) vacuously true even against
 * the CURRENT, unfixed source. Real lock semantics, backed by a small
 * stateful in-memory `cache` mock, are required to prove the fix.
 *
 * RED phase: cases 7, 8, 9 FAIL against current source — no releaseLock
 * call exists anywhere in runConfirm's catch, so the lock is held on every
 * failure (case 7/8 wrongly expect a held lock to have been released; case
 * 9 accidentally already "passes" release-not-called only because NOTHING
 * ever releases, which is why case 9 also asserts the retained-state
 * response shape — needs_manual_review / payment_voided — to stay
 * meaningful once case 7/8 flip the default to "release on failure").
 * Case 10 already passes (nothing is released on success today either).
 */

// =============================================================================
// Mocks
// =============================================================================

jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

jest.mock('axios', function () {
  return { get: jest.fn(), post: jest.fn() };
});

jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({ idempotencyKey: 'idem-lockrelease-1' }),
    pollTerminalResult: jest.fn(),
    initializeCheckout: jest.fn().mockResolvedValue({ checkoutToken: 'tok-lockrelease-test' }),
    getCardTransactionById: jest.fn(),
    voidTransaction: jest.fn(),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-lockrelease-so-1'),
    cancelTerminal: jest.fn().mockResolvedValue({})
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn(),
    zohoPut: jest.fn()
  };
});

// Stateful in-memory cache mock — required so the REAL moneyPath.acquireIdempotencyLock
// exhibits genuine lock/contention/release semantics (see file docstring).
jest.mock('../lib/cache', function () {
  var store = {};
  var locks = {};
  return {
    get: jest.fn(function (key) {
      return Promise.resolve(Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null);
    }),
    set: jest.fn(function (key, val) {
      store[key] = val;
      return Promise.resolve('OK');
    }),
    del: jest.fn(function (key) {
      delete store[key];
      return Promise.resolve(1);
    }),
    acquireLock: jest.fn(function (key) {
      if (locks[key]) return Promise.resolve(false);
      locks[key] = true;
      return Promise.resolve(true);
    }),
    releaseLock: jest.fn(function (key) {
      delete locks[key];
      return Promise.resolve();
    })
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
  return { decrementStock: jest.fn().mockResolvedValue({}), reconcileFromZoho: jest.fn() };
});

jest.mock('../lib/brewpad-integration', function () {
  return { createBatchesFromSale: jest.fn(), detectRecipeSale: jest.fn() };
});

jest.mock('../lib/discount-match', function () {
  return { classifyCatalogItem: jest.fn().mockReturnValue([]), matches: jest.fn().mockReturnValue(false) };
});

jest.mock('../lib/checkout-helpers', function () {
  return { buildContactPayload: jest.fn(), withTimeout: function (p) { return p; } };
});

// Partial-real: acquireIdempotencyLock + voidWithTimeout are the REAL
// implementations (see file docstring); everything else from the real
// module is preserved too so no export is silently missing.
jest.mock('../lib/money-path', function () {
  var actual = jest.requireActual('../lib/money-path');
  return actual;
});

jest.mock('@sentry/node', function () {
  return { init: jest.fn(), setupExpressErrorHandler: jest.fn(), captureException: jest.fn() };
});

jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      KIOSK_PRODUCTS:              'test:kiosk-products',
      RECENT_ORDERS:               'test:recent-orders',
      KIOSK_IDEM_PREFIX:           'test:idem:',
      KIOSK_SALESORDERS:           'test:kiosk-salesorders',
      KIOSK_DISCOUNT_PRESETS:      'test:kiosk-discount-presets',
      CONSIGNMENT_REPORT_PREFIX:   'test:consignment:report:',
      KIOSK_PENDING_CHARGE_PREFIX: 'test:kiosk:pending-charge:',
      INGREDIENTS_ALL:             'zoho:ingredients:all'
    },
    LOCK_KEYS: { RECIPE_SALE: 'recipe-sale' },
    LEDGER_KEYS: {},
    RATE_LIMIT_PREFIX: 'test:rl:'
  };
});

// =============================================================================
// Test harness
// =============================================================================

var cache, helcimLib, zohoApi, router, handlers;

function getHandlers() {
  jest.resetModules();
  cache      = require('../lib/cache');
  helcimLib  = require('../lib/helcim');
  zohoApi    = require('../lib/zoho-api');
  require('../routes/pos');
  router   = require('express').Router();
  handlers = {};
  router.post.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
  router.get.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
}

// A mockRes that models the three pieces of real Express behaviour D-50-03's
// hook depends on: res.on('finish', cb) registration, res.statusCode tracking
// via res.status(code), and res.locals. 'finish' handlers fire synchronously
// as part of the res.json() call (which is when a real Express response is
// fully written) — before any test-supplied res.json assertion callback, so
// by the time a test observes the response it also observes any lock release
// the finish hook triggered.
function mockRes() {
  var r = { locals: {}, statusCode: 200, headersSent: false, _finishHandlers: [] };
  r.on = jest.fn(function (event, cb) {
    if (event === 'finish') { r._finishHandlers.push(cb); }
  });
  r.status = jest.fn(function (code) { r.statusCode = code; return r; });
  var userImpl = null;
  r.json = jest.fn(function (body) {
    r._finishHandlers.forEach(function (cb) { cb(); });
    if (userImpl) return userImpl(body);
  });
  r.json.mockImplementation = function (fn) { userImpl = fn; return r.json; };
  return r;
}

function motoCartItems() {
  return [{ custom: true, description: 'Lock Release Test Item', quantity: 1, rate: 100, taxable: false }];
}

function zohoPostRejectInvoices() {
  return function (endpoint) {
    if (endpoint === '/invoices') return Promise.reject(new Error('Zoho invoice API unavailable'));
    return Promise.resolve({});
  };
}

function zohoPostSucceeds() {
  return function (endpoint) {
    if (endpoint === '/invoices') {
      return Promise.resolve({ invoice: { invoice_id: 'inv-lockrelease-ok', invoice_number: 'INV-LR-OK' } });
    }
    return Promise.resolve({});
  };
}

describe('pos — 50-03 idempotency lock release on confirm failure (H4 / SC#2)', function () {

  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 100 });
  });

  afterEach(function () {
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.NODE_ENV;
  });

  // ---------------------------------------------------------------------
  // Case 7: Lock released on confirm failure (SC#2).
  // ---------------------------------------------------------------------

  test('Case 7: invoice POST fails, void SUCCEEDS → cache.releaseLock called with the confirm idem key', function (done) {
    zohoApi.zohoPost.mockImplementation(zohoPostRejectInvoices());
    helcimLib.voidTransaction.mockResolvedValue({ ok: true, transactionId: 'txn-lockrelease-7' });
    var req = {
      body: {
        items: motoCartItems(),
        tender: 'moto',
        transaction_id: 'txn-lockrelease-7',
        reference_number: 'KIOSK-LR-007'
      }
    };
    var res = mockRes();
    res.json.mockImplementation(function () {
      try {
        expect(res.statusCode).toBe(502);
        expect(cache.releaseLock).toHaveBeenCalledWith('test:idem:confirm:txn-lockrelease-7');
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  // ---------------------------------------------------------------------
  // Case 8: Retry after a failed confirm re-acquires the lock — the
  // user-visible assertion. This is the case that is vacuous against a
  // fully-mocked acquireIdempotencyLock; it is meaningful here because the
  // lock is REAL (see file docstring).
  // ---------------------------------------------------------------------

  test('Case 8: after a failed confirm releases the lock, an immediate retry with the SAME key reaches runConfirm (not 409)', function (done) {
    zohoApi.zohoPost.mockImplementation(zohoPostRejectInvoices());
    helcimLib.voidTransaction.mockResolvedValue({ ok: true, transactionId: 'txn-lockrelease-8' });

    var firstReq = {
      body: {
        items: motoCartItems(),
        tender: 'moto',
        transaction_id: 'txn-lockrelease-8',
        reference_number: 'KIOSK-LR-008'
      }
    };
    var firstRes = mockRes();
    firstRes.json.mockImplementation(function () {
      try {
        expect(firstRes.statusCode).toBe(502);
      } catch (e) { return done(e); }

      // Second attempt: SAME idempotency seed (transaction_id). If the lock
      // from the first attempt was not released, moneyPath.acquireIdempotencyLock
      // returns 'contention' and the handler responds 409 WITHOUT ever
      // reaching runConfirm (no zohoPost('/invoices') call is made).
      zohoApi.zohoPost.mockImplementation(zohoPostSucceeds());
      var invoiceCallsBefore = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; }).length;

      var secondReq = {
        body: {
          items: motoCartItems(),
          tender: 'moto',
          transaction_id: 'txn-lockrelease-8',
          reference_number: 'KIOSK-LR-008-RETRY'
        }
      };
      var secondRes = mockRes();
      secondRes.json.mockImplementation(function () {
        try {
          expect(secondRes.statusCode).not.toBe(409);
          var invoiceCallsAfter = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; }).length;
          expect(invoiceCallsAfter).toBeGreaterThan(invoiceCallsBefore);
          done();
        } catch (e) { done(e); }
      });
      handlers['/api/kiosk/sale/confirm'](secondReq, secondRes);
    });
    handlers['/api/kiosk/sale/confirm'](firstReq, firstRes);
  });

  // ---------------------------------------------------------------------
  // Case 9: Lock RETAINED when the void itself failed (D-50-03, fail-closed
  // exception). The customer is still charged — releasing here would let a
  // retry charge a second time on top of a live, unvoided first charge.
  // ---------------------------------------------------------------------

  test('Case 9: invoice POST fails AND void FAILS (unconfirmed) → cache.releaseLock NOT called for the confirm key; needs_manual_review true, payment_voided false', function (done) {
    zohoApi.zohoPost.mockImplementation(zohoPostRejectInvoices());
    var unconfirmedVoidErr = new Error('Helcim reversal response carried no positive reversal signal');
    unconfirmedVoidErr.isUnconfirmedVoid = true;
    helcimLib.voidTransaction.mockRejectedValue(unconfirmedVoidErr);

    var req = {
      body: {
        items: motoCartItems(),
        tender: 'moto',
        transaction_id: 'txn-lockrelease-9',
        reference_number: 'KIOSK-LR-009'
      }
    };
    var res = mockRes();
    res.json.mockImplementation(function (body) {
      try {
        expect(res.statusCode).toBe(502);
        expect(body.needs_manual_review).toBe(true);
        expect(body.payment_voided).toBe(false);
        var releaseCalls = cache.releaseLock.mock.calls.filter(function (c) {
          return c[0] === 'test:idem:confirm:txn-lockrelease-9';
        });
        expect(releaseCalls.length).toBe(0);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  // ---------------------------------------------------------------------
  // Case 10: Lock NOT released on success — the cached receipt under the
  // same key is the replay signal (unchanged behaviour).
  // ---------------------------------------------------------------------

  test('Case 10: a clean confirm (201) does NOT call cache.releaseLock for the confirm key', function (done) {
    zohoApi.zohoPost.mockImplementation(zohoPostSucceeds());
    var req = {
      body: {
        items: motoCartItems(),
        tender: 'moto',
        transaction_id: 'txn-lockrelease-10',
        reference_number: 'KIOSK-LR-010'
      }
    };
    var res = mockRes();
    res.json.mockImplementation(function (body) {
      try {
        expect(res.statusCode).toBe(201);
        expect(body.ok).toBe(true);
        var releaseCalls = cache.releaseLock.mock.calls.filter(function (c) {
          return c[0] === 'test:idem:confirm:txn-lockrelease-10';
        });
        expect(releaseCalls.length).toBe(0);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

});
