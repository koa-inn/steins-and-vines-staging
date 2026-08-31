'use strict';

// ---------------------------------------------------------------------------
// reconcile-zoho-authoritative.test.js — Phase 50-05 (H3 / roadmap SC#1, D-50-07/D-50-08)
//
// Regression coverage for lib/reconcile.js's hasMatchingZohoOrder becoming
// Zoho-authoritative instead of deciding on a 300-second Redis key:
//   8.  A settled paid KIOSK SALE (invoice reference_number lookup succeeds)
//       is never voided, even when the confirm cache key has expired.
//   9.  A genuine orphan (empty invoices array) is still voided.
//   10. An unanswerable Zoho call fails CLOSED — do NOT void, leave the
//       pending record intact for the next sweep (D-50-07).
//   11. The cache fast path is preserved — no Zoho call when the confirm
//       idempotency key is still present.
//   12-14. THE INTEGRATION CASES (D-50-08): pending records are captured by
//       running the REAL POST /api/kiosk/salesorder-pay route (as hardened
//       by plan 50-02), not hand-built, so the shape under test is the one
//       the route actually writes. Prove the SO-pay surface (whose
//       fromsalesorder invoice never carries the kiosk payment reference,
//       pos.js:1907-class code) is verified against the SALES ORDER, not an
//       invoice lookup that would legitimately return an empty array for a
//       fully paid order.
//
// Mirrors reconcile.test.js's mocking conventions (cache/helcim/mailer) for
// cases 8-11, and pos-salesorder-pay-idempotency.test.js's express
// route-registry harness for cases 12-14 (drives the REAL routes/pos.js
// handler — routes/pos.js is NOT modified by this plan/file).
//
// Run alone: cd zoho-middleware && npx jest reconcile-zoho-authoritative
// ---------------------------------------------------------------------------

jest.mock('../lib/helcim');
jest.mock('../lib/mailer');
jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn() };
});
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(),
    del: jest.fn().mockResolvedValue(),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(),
    isConnected: jest.fn().mockReturnValue(true),
    getClient: jest.fn().mockResolvedValue({ keys: jest.fn().mockResolvedValue([]) })
  };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});
jest.mock('../lib/eventLog', function () {
  return { logEvent: jest.fn() };
});
jest.mock('../lib/inventory-ledger', function () {
  return { decrementStock: jest.fn().mockResolvedValue() };
});

var helcimLib = require('../lib/helcim');
var mailer    = require('../lib/mailer');
var cache     = require('../lib/cache');
var zohoApi   = require('../lib/zoho-api');
var C         = require('../lib/constants');

// ---------------------------------------------------------------------------
// Route-registry express mock (cases 12-14) — mirrors
// pos-salesorder-pay-idempotency.test.js so requiring routes/pos.js
// registers handlers without booting a real Express app. routes/pos.js is
// read-only here — this plan does not modify it (owned by sibling plan 50-03
// this wave).
// ---------------------------------------------------------------------------
var _routeRegistry = { get: [], post: [], put: [] };

jest.mock('express', function () {
  var router = {
    get:  jest.fn(function (path, handler) { _routeRegistry.get.push({ path: path, handler: handler }); }),
    post: jest.fn(function (path, handler) { _routeRegistry.post.push({ path: path, handler: handler }); }),
    put:  jest.fn(function (path, handler) { _routeRegistry.put.push({ path: path, handler: handler }); })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

require('../routes/pos');

function findHandler(method, path) {
  var entries = _routeRegistry[method] || [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].path === path) return entries[i].handler;
  }
  throw new Error('No ' + method.toUpperCase() + ' handler registered for ' + path);
}

var paySalesorderHandler = findHandler('post', '/api/kiosk/salesorder-pay');

var reconcile = require('../lib/reconcile');

function makeReq(body) {
  return { body: body || {}, query: {}, headers: {}, id: 'req-test' };
}

function makeRes() {
  var res = { _status: null, _json: null, headersSent: false };
  res.status = jest.fn(function (code) { res._status = code; return res; });
  res.json = jest.fn(function (data) { res._json = data; res.headersSent = true; return res; });
  return res;
}

function flushPromises() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function flushN(n) {
  var p = Promise.resolve();
  for (var i = 0; i < n; i++) { p = p.then(flushPromises); }
  return p;
}

// Same happy-path Zoho fetch/invoice/payment chain as
// pos-salesorder-pay-idempotency.test.js's mockHappyZoho.
function mockHappyZoho(soId, soNumber, balance) {
  zohoApi.zohoGet.mockImplementation(function (path) {
    if (path === '/salesorders/' + soId) {
      return Promise.resolve({ salesorder: {
        salesorder_id: soId, salesorder_number: soNumber,
        balance: balance, status: 'confirmed', customer_id: 'CUST-1', invoices: []
      } });
    }
    if (path === '/invoices/INV-SO-1') {
      return Promise.resolve({ invoice: { invoice_id: 'INV-SO-1', balance_due: balance } });
    }
    return Promise.resolve({});
  });
  zohoApi.zohoPost.mockImplementation(function (endpoint) {
    if (endpoint.indexOf('/invoices/fromsalesorder') === 0) return Promise.resolve({ invoice: { invoice_id: 'INV-SO-1' } });
    if (/^\/invoices\/.+\/status\/sent$/.test(endpoint)) return Promise.resolve({});
    if (endpoint === '/customerpayments') return Promise.resolve({ payment: { payment_id: 'PAY-1' } });
    return Promise.resolve({});
  });
}

// Helper: hand-built pending context (kiosk/sale-shaped, 15 min old = "late approval")
function oldPendingCtx(overrides) {
  return Object.assign({
    reference_number: 'KIOSK-TEST-001',
    amount: 70.00,
    idempotency_key: 'idem-test-abc',
    created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()  // 15 min ago
  }, overrides || {});
}

function deps() {
  return { helcim: helcimLib, mailer: mailer };
}

// ---------------------------------------------------------------------------
// Cases 8-11: hasMatchingZohoOrder driven with a hand-built pending record
// and a directly-mocked zohoGet.
// ---------------------------------------------------------------------------

describe('hasMatchingZohoOrder — Zoho-authoritative (D-50-07)', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    cache.isConnected.mockReturnValue(true);
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue();
    cache.del.mockResolvedValue();
    cache.acquireLock.mockResolvedValue(true);
    cache.releaseLock.mockResolvedValue();
    cache.getClient.mockResolvedValue({ keys: jest.fn().mockResolvedValue([]) });

    helcimLib.voidTransaction.mockResolvedValue({ ok: true, transactionId: 'txn-001', status: 'voided' });
    mailer.sendVoidFailureAlert.mockResolvedValue({ id: 'mail-001' });
    zohoApi.zohoGet.mockReset();
  });

  // -------------------------------------------------------------------------
  // Case 8: a settled paid KIOSK SALE is never voided (roadmap SC#1's regression)
  // -------------------------------------------------------------------------
  test('8. a settled paid kiosk-sale charge (confirm cache key expired, Zoho invoice found) is NOT voided — the money-taking-back bug', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-101',
      invoiceNumber: 'KIOSK-TEST-101',
      cardType: 'Visa',
      amount: 70
    });

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-101') {
        return Promise.resolve(oldPendingCtx({
          reference_number: 'KIOSK-TEST-101',
          amount: 70,
          idempotency_key: 'idem-101'
        }));
      }
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-101') {
        return Promise.resolve(null); // confirm key EXPIRED
      }
      return Promise.resolve(null);
    });

    zohoApi.zohoGet.mockImplementation(function (path) {
      expect(path).toBe('/invoices?reference_number=KIOSK-TEST-101');
      return Promise.resolve({ invoices: [{ invoice_id: 'INV-101', reference_number: 'KIOSK-TEST-101' }] });
    });

    return reconcile.reconcilePendingCharge('txn-101', deps()).then(function () {
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      expect(cache.del).toHaveBeenCalledWith(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-101');
    });
  });

  // -------------------------------------------------------------------------
  // Case 9: a genuine orphan is still voided (anti-regression backstop)
  // -------------------------------------------------------------------------
  test('9. confirm key absent AND Zoho reports no invoices -> genuine orphan is still voided', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-102',
      invoiceNumber: 'KIOSK-TEST-102',
      cardType: 'Visa',
      amount: 55
    });

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-102') {
        return Promise.resolve(oldPendingCtx({
          reference_number: 'KIOSK-TEST-102',
          amount: 55,
          idempotency_key: 'idem-102'
        }));
      }
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-102') {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    zohoApi.zohoGet.mockResolvedValue({ invoices: [] });

    return reconcile.reconcilePendingCharge('txn-102', deps()).then(function () {
      expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-102');
      expect(cache.del).toHaveBeenCalledWith(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-102');
    });
  });

  // -------------------------------------------------------------------------
  // Case 10: Zoho lookup unavailable -> fail CLOSED, do NOT void (D-50-07)
  // -------------------------------------------------------------------------
  test('10. an unanswerable Zoho lookup (rejects) fails CLOSED — no void, pending record left intact', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-103',
      invoiceNumber: 'KIOSK-TEST-103',
      cardType: 'Visa',
      amount: 42
    });

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-103') {
        return Promise.resolve(oldPendingCtx({
          reference_number: 'KIOSK-TEST-103',
          amount: 42,
          idempotency_key: 'idem-103'
        }));
      }
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-103') {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    zohoApi.zohoGet.mockRejectedValue(new Error('Zoho API unreachable'));

    return reconcile.reconcilePendingCharge('txn-103', deps()).then(function () {
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalledWith(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-103');
    });
  });

  // -------------------------------------------------------------------------
  // Case 11: cache fast path preserved — no Zoho call at all
  // -------------------------------------------------------------------------
  test('11. confirm key PRESENT -> settled via the cache fast path, no Zoho call, no void', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-104',
      invoiceNumber: 'KIOSK-TEST-104',
      cardType: 'Visa',
      amount: 33
    });

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-104') {
        return Promise.resolve(oldPendingCtx({
          reference_number: 'KIOSK-TEST-104',
          amount: 33,
          idempotency_key: 'idem-104'
        }));
      }
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-104') {
        return Promise.resolve({ invoice_number: 'INV-104', status: 201 }); // confirm ran
      }
      return Promise.resolve(null);
    });

    return reconcile.reconcilePendingCharge('txn-104', deps()).then(function () {
      expect(zohoApi.zohoGet).not.toHaveBeenCalled();
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      expect(cache.del).toHaveBeenCalledWith(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-104');
    });
  });
});

// ---------------------------------------------------------------------------
// Cases 12-14: THE INTEGRATION CASES (D-50-08) — pending records captured
// from the REAL /api/kiosk/salesorder-pay route, not hand-built.
// ---------------------------------------------------------------------------

describe('hasMatchingZohoOrder — salesorder-pay integration (D-50-08)', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    helcimLib.isTerminalEnabled.mockReturnValue(true);
    helcimLib.terminalPurchase.mockResolvedValue({ ok: true });
    helcimLib.pollTerminalResult.mockResolvedValue({
      status: 'APPROVED', transactionId: 'txn-sopay-1', approved: true, cardType: 'VISA'
    });
    helcimLib.voidTransaction.mockResolvedValue({ ok: true });
    helcimLib.getCardTransactionById.mockResolvedValue({});
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue('OK');
    cache.del.mockResolvedValue(1);
    cache.acquireLock.mockResolvedValue(true);
    cache.releaseLock.mockResolvedValue();
    cache.isConnected.mockReturnValue(true);
    cache.getClient.mockResolvedValue({ keys: jest.fn().mockResolvedValue([]) });
    mailer.sendVoidFailureAlert.mockResolvedValue({ id: 'mail-sopay' });
  });

  // Drives the REAL salesorder-pay route to a full success and captures the
  // exact pending-charge object it writes via cache.set — the shape under
  // test is the one the route ACTUALLY writes, not one the test author
  // imagined (D-50-08).
  function captureRealSoPayPendingRecord(soId, soNumber, balance, idemKey) {
    mockHappyZoho(soId, soNumber, balance);
    var req = makeReq({ salesorder_id: soId, idempotency_key: idemKey });
    var res = makeRes();
    paySalesorderHandler(req, res);
    return flushN(10).then(function () {
      var refNumber = helcimLib.terminalPurchase.mock.calls[0][1];
      var pendingKey = 'kiosk:pending-charge:' + refNumber;
      var setCall = cache.set.mock.calls.find(function (c) { return c[0] === pendingKey; });
      if (!setCall) throw new Error('salesorder-pay route did not write a pending-charge record — cannot build integration fixture');
      return { ctx: setCall[1], refNumber: refNumber, pendingKey: pendingKey };
    });
  }

  // -------------------------------------------------------------------------
  // Case 12: a settled, paid SALESORDER-PAY charge is never voided
  // -------------------------------------------------------------------------
  test('12. a settled, paid salesorder-pay charge (invoice lookup legitimately empty, SO balance paid) is NOT voided', function () {
    return captureRealSoPayPendingRecord('SO1', 'SO-001', 100, 'ABC-12').then(function (fixture) {
      expect(fixture.ctx.salesorder_id).toBe('SO1'); // D-50-08 discriminator present, real route wrote it

      // Reset mocks to drive reconcile.reconcilePendingCharge directly
      // against the captured record — simulating the success-path cache.del
      // having failed (Redis blip), so the record survives to be swept.
      jest.clearAllMocks();
      helcimLib.getCardTransactionById.mockResolvedValue({
        status: 'APPROVED',
        transactionId: 'txn-sopay-12',
        invoiceNumber: fixture.refNumber,
        cardType: 'Visa',
        amount: 100
      });
      cache.get.mockImplementation(function (key) {
        if (key === fixture.pendingKey) return Promise.resolve(Object.assign({}, fixture.ctx, {
          created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()
        }));
        return Promise.resolve(null); // confirm key never written by sopay
      });
      cache.del.mockResolvedValue();
      cache.set.mockResolvedValue();
      cache.acquireLock.mockResolvedValue(true);
      cache.releaseLock.mockResolvedValue();

      // A naive invoice-only implementation would see {invoices: []} here
      // for a fully paid SO-pay charge (fromsalesorder never sets
      // reference_number) and wrongly void it — this is what D-50-08 exists
      // to prevent. A real tenant would answer exactly like this.
      zohoApi.zohoGet.mockImplementation(function (path) {
        if (path === '/invoices?reference_number=' + encodeURIComponent(fixture.refNumber)) {
          return Promise.resolve({ invoices: [] });
        }
        if (path === '/salesorders/SO1') {
          return Promise.resolve({ salesorder: { salesorder_id: 'SO1', balance: 0, status: 'closed' } });
        }
        return Promise.resolve({});
      });

      return reconcile.reconcilePendingCharge('txn-sopay-12', deps()).then(function () {
        expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Case 13: a genuinely orphaned SALESORDER-PAY charge is still voided
  // -------------------------------------------------------------------------
  test('13. a genuinely orphaned salesorder-pay charge (SO balance still outstanding) is still voided', function () {
    return captureRealSoPayPendingRecord('SO2', 'SO-002', 75, 'ABC-13').then(function (fixture) {
      jest.clearAllMocks();
      helcimLib.getCardTransactionById.mockResolvedValue({
        status: 'APPROVED',
        transactionId: 'txn-sopay-13',
        invoiceNumber: fixture.refNumber,
        cardType: 'Visa',
        amount: 75
      });
      cache.get.mockImplementation(function (key) {
        if (key === fixture.pendingKey) return Promise.resolve(Object.assign({}, fixture.ctx, {
          created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()
        }));
        return Promise.resolve(null);
      });
      cache.del.mockResolvedValue();
      cache.set.mockResolvedValue();
      cache.acquireLock.mockResolvedValue(true);
      cache.releaseLock.mockResolvedValue();

      zohoApi.zohoGet.mockImplementation(function (path) {
        if (path === '/invoices?reference_number=' + encodeURIComponent(fixture.refNumber)) {
          return Promise.resolve({ invoices: [] });
        }
        if (path === '/salesorders/SO2') {
          // Payment never landed — balance still equals the charged amount
          return Promise.resolve({ salesorder: { salesorder_id: 'SO2', balance: 75, status: 'confirmed' } });
        }
        return Promise.resolve({});
      });

      return reconcile.reconcilePendingCharge('txn-sopay-13', deps()).then(function () {
        expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-sopay-13');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Case 14: the SO branch is chosen by the record, not the test
  // -------------------------------------------------------------------------
  test('14. a salesorder_id-bearing record queries /salesorders/..., never /invoices?reference_number=...; a plain kiosk/sale record does the reverse', function () {
    return captureRealSoPayPendingRecord('SO3', 'SO-003', 60, 'ABC-14').then(function (fixture) {
      jest.clearAllMocks();
      helcimLib.getCardTransactionById.mockResolvedValue({
        status: 'APPROVED',
        transactionId: 'txn-sopay-14',
        invoiceNumber: fixture.refNumber,
        cardType: 'Visa',
        amount: 60
      });
      cache.get.mockImplementation(function (key) {
        if (key === fixture.pendingKey) return Promise.resolve(Object.assign({}, fixture.ctx, {
          created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()
        }));
        return Promise.resolve(null);
      });
      cache.del.mockResolvedValue();
      cache.set.mockResolvedValue();
      cache.acquireLock.mockResolvedValue(true);
      cache.releaseLock.mockResolvedValue();
      zohoApi.zohoGet.mockResolvedValue({ salesorder: { salesorder_id: 'SO3', balance: 0, status: 'closed' }, invoices: [] });

      return reconcile.reconcilePendingCharge('txn-sopay-14', deps()).then(function () {
        var pathsCalled = zohoApi.zohoGet.mock.calls.map(function (c) { return c[0]; });
        expect(pathsCalled.some(function (p) { return p.indexOf('/salesorders/') === 0; })).toBe(true);
        expect(pathsCalled.some(function (p) { return p.indexOf('/invoices?reference_number=') === 0; })).toBe(false);
      }).then(function () {
        // Reverse: a plain kiosk/sale record (no salesorder_id) must use the
        // invoice lookup, never /salesorders/...
        jest.clearAllMocks();
        helcimLib.getCardTransactionById.mockResolvedValue({
          status: 'APPROVED',
          transactionId: 'txn-sale-14',
          invoiceNumber: 'KIOSK-TEST-14',
          cardType: 'Visa',
          amount: 20
        });
        cache.get.mockImplementation(function (key) {
          if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-14') {
            return Promise.resolve(oldPendingCtx({
              reference_number: 'KIOSK-TEST-14',
              amount: 20,
              idempotency_key: 'idem-14'
            }));
          }
          return Promise.resolve(null);
        });
        cache.del.mockResolvedValue();
        zohoApi.zohoGet.mockResolvedValue({ invoices: [{ invoice_id: 'INV-14' }] });

        return reconcile.reconcilePendingCharge('txn-sale-14', deps()).then(function () {
          var pathsCalled2 = zohoApi.zohoGet.mock.calls.map(function (c) { return c[0]; });
          expect(pathsCalled2.some(function (p) { return p.indexOf('/invoices?reference_number=') === 0; })).toBe(true);
          expect(pathsCalled2.some(function (p) { return p.indexOf('/salesorders/') === 0; })).toBe(false);
        });
      });
    });
  });
});
