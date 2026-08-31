'use strict';

// ---------------------------------------------------------------------------
// Phase 50 Plan 02 — regression coverage for the salesorder-pay double-charge
// defect (audit H8 / M-A1 / roadmap SC#4).
//
// Mirrors the mocking conventions of __tests__/kiosk-salesorders.test.js
// (route-registry harness via a mocked express.Router) plus the fuller
// cache mock (acquireLock/releaseLock) used by __tests__/pos-money.test.js
// and __tests__/harden03-idem-redis-down.test.js, since kiosk-salesorders'
// own cache mock has no lock primitives (that route currently has none).
// ---------------------------------------------------------------------------

// --- Mocks must be declared before any require() ---

jest.mock('../lib/helcim', function () { return {
  isTerminalEnabled: jest.fn().mockReturnValue(true),
  terminalPurchase: jest.fn().mockResolvedValue({ ok: true }),
  pollTerminalResult: jest.fn().mockResolvedValue({
    status: 'APPROVED', transactionId: 'txn-999', approved: true, cardType: 'VISA'
  }),
  generateIdempotencyKey: jest.fn().mockReturnValue('test-idem-key'),
  voidTransaction: jest.fn().mockResolvedValue({ ok: true })
}; });

jest.mock('../lib/zoho-api', function () { return {
  zohoGet: jest.fn(),
  zohoPost: jest.fn(),
  zohoPut: jest.fn()
}; });

jest.mock('../lib/cache', function () { return {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  acquireLock: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(),
  isConnected: jest.fn().mockReturnValue(true)
}; });

jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/logger', function () { return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; });
jest.mock('../lib/mailer', function () { return {
  sendVoidFailureAlert: jest.fn().mockResolvedValue()
}; });
jest.mock('../lib/inventory-ledger', function () { return {
  decrementStock: jest.fn().mockResolvedValue()
}; });

var helcimLib = require('../lib/helcim');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var crypto = require('crypto');

// ---------------------------------------------------------------------------
// Mock express.Router and capture route registrations (same harness as
// kiosk-salesorders.test.js so requiring routes/pos.js registers handlers
// without booting a real Express app).
// ---------------------------------------------------------------------------
var _routeRegistry = { get: [], post: [], put: [] };

jest.mock('express', function () {
  var router = {
    get: jest.fn(function (path, handler) { _routeRegistry.get.push({ path: path, handler: handler }); }),
    post: jest.fn(function (path, handler) { _routeRegistry.post.push({ path: path, handler: handler }); }),
    put: jest.fn(function (path, handler) { _routeRegistry.put.push({ path: path, handler: handler }); })
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeReq(body) {
  return { body: body || {}, query: {}, headers: {}, id: 'req-test' };
}

function makeRes() {
  var res = { _status: null, _json: null, headersSent: false };
  res.status = jest.fn(function (code) { res._status = code; return res; });
  res.json = jest.fn(function (data) {
    res._json = data;
    res.headersSent = true;
    return res;
  });
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

// Sets up the happy-path Zoho fetch/invoice/payment chain (SO fetch,
// invoice-from-salesorder, finalize, customerpayments) exactly like
// kiosk-salesorders.test.js's happy-path test.
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

describe('POST /api/kiosk/salesorder-pay — idempotency hardening (50-02)', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    helcimLib.isTerminalEnabled.mockReturnValue(true);
    helcimLib.terminalPurchase.mockResolvedValue({ ok: true });
    helcimLib.pollTerminalResult.mockResolvedValue({
      status: 'APPROVED', transactionId: 'txn-999', approved: true, cardType: 'VISA'
    });
    helcimLib.voidTransaction.mockResolvedValue({ ok: true });
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue('OK');
    cache.del.mockResolvedValue(1);
    cache.acquireLock.mockResolvedValue(true);
    cache.releaseLock.mockResolvedValue();
  });

  // ---- Case 1: the headline double-charge defect ----
  test('double-submit: second concurrent request is rejected 409, terminal charged exactly once', function () {
    mockHappyZoho('SO1', 'SO-001', 100);
    cache.acquireLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    var req1 = makeReq({ salesorder_id: 'SO1' });
    var res1 = makeRes();
    var req2 = makeReq({ salesorder_id: 'SO1' });
    var res2 = makeRes();

    paySalesorderHandler(req1, res1);
    paySalesorderHandler(req2, res2);

    return flushN(8).then(function () {
      expect(helcimLib.terminalPurchase).toHaveBeenCalledTimes(1);
      expect(res2._status).toBe(409);
    });
  });

  // ---- Case 2: lock is the money-path primitive ----
  test('lock is acquired via the shared money-path primitive on a kiosk:idem:sopay: key', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    var req = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(8).then(function () {
      expect(cache.acquireLock).toHaveBeenCalledWith(
        expect.stringMatching(/^kiosk:idem:sopay:/), expect.anything()
      );
    });
  });

  // ---- Case 3: client key honoured (D-50-01) ----
  test('a client-supplied idempotency_key becomes the lock key verbatim', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    var req = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(8).then(function () {
      expect(cache.acquireLock).toHaveBeenCalledWith('kiosk:idem:sopay:ABC', expect.anything());
    });
  });

  // ---- Case 4: fallback lock never 400s (D-50-01, no-staging-middleware guarantee) ----
  test('no client key falls back to an SO-scoped lock and still proceeds (never a 400)', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    var req = makeReq({ salesorder_id: 'SO1' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(8).then(function () {
      expect(cache.acquireLock).toHaveBeenCalledWith('kiosk:idem:sopay:so:SO1', expect.anything());
      expect(res._status).not.toBe(400);
    });
  });

  // ---- Case 5: fallback never replays a cached receipt (D-50-01) ----
  test('fallback key never serves a cached receipt — a replay hit is 409, not 200', function () {
    mockHappyZoho('SO1', 'SO-001', 100);
    cache.get.mockResolvedValue({ ok: true, transaction_id: 'stale-txn' });

    var req = makeReq({ salesorder_id: 'SO1' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(8).then(function () {
      expect(res._status).toBe(409);
      expect(res._json && res._json.ok).not.toBe(true);
    });
  });

  // ---- Case 6: deterministic Helcim key (D-50-01a) ----
  test('terminalPurchase is called with a deterministic sha256-derived Helcim key', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    var req = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(8).then(function () {
      var expectedKey = crypto.createHash('sha256').update('ABC').digest('hex').substring(0, 25);
      expect(helcimLib.terminalPurchase).toHaveBeenCalled();
      var call = helcimLib.terminalPurchase.mock.calls[0];
      expect(call[2]).toBe(expectedKey);
    });
  });

  test('two attempts with the same client key produce the SAME Helcim key', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    var req1 = makeReq({ salesorder_id: 'SO1', idempotency_key: 'SAME' });
    var res1 = makeRes();
    paySalesorderHandler(req1, res1);

    return flushN(8).then(function () {
      jest.clearAllMocks();
      helcimLib.isTerminalEnabled.mockReturnValue(true);
      helcimLib.terminalPurchase.mockResolvedValue({ ok: true });
      helcimLib.pollTerminalResult.mockResolvedValue({
        status: 'APPROVED', transactionId: 'txn-999', approved: true, cardType: 'VISA'
      });
      cache.get.mockResolvedValue(null);
      cache.set.mockResolvedValue('OK');
      cache.del.mockResolvedValue(1);
      cache.acquireLock.mockResolvedValue(true);
      cache.releaseLock.mockResolvedValue();
      mockHappyZoho('SO1', 'SO-001', 100);

      var req2 = makeReq({ salesorder_id: 'SO1', idempotency_key: 'SAME' });
      var res2 = makeRes();
      paySalesorderHandler(req2, res2);
      return flushN(8);
    }).then(function () {
      var expectedKey = crypto.createHash('sha256').update('SAME').digest('hex').substring(0, 25);
      var call = helcimLib.terminalPurchase.mock.calls[0];
      expect(call[2]).toBe(expectedKey);
    });
  });

  // ---- Case 7: unique reference per attempt (D-50-01b) ----
  test('the terminal reference is unique per attempt, not the bare soNumber', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    var req = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(8).then(function () {
      expect(helcimLib.terminalPurchase).toHaveBeenCalled();
      var call = helcimLib.terminalPurchase.mock.calls[0];
      var refNumber = call[1];
      expect(refNumber).not.toBe('SO-001');
      expect(refNumber.indexOf('SO-001-')).toBe(0);
      // D-50-01b format pin, direct (not a mirror of the sha256 derivation):
      // soNumber + '-' + exactly 6 lowercase-hex chars, nothing more. This is
      // the property pos-giftcard.test.js's expectedSoPayRefNumber helper
      // CANNOT catch a regression in, since that helper reimplements the same
      // derivation rather than asserting its shape independently.
      expect(refNumber).toMatch(/^SO-001-[0-9a-f]{6}$/);
      expect(helcimLib.pollTerminalResult).toHaveBeenCalledWith(refNumber);
    });
  });

  // ---- Case 8: pending-charge record written after push, deleted on success (SC#4) ----
  test('a pending-charge record is written right after the terminal push and deleted on success', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    var req = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(8).then(function () {
      expect(helcimLib.terminalPurchase).toHaveBeenCalled();
      var refNumber = helcimLib.terminalPurchase.mock.calls[0][1];
      var pendingKey = 'kiosk:pending-charge:' + refNumber;

      var setCall = cache.set.mock.calls.find(function (c) { return c[0] === pendingKey; });
      expect(setCall).toBeTruthy();
      expect(setCall[1]).toMatchObject({
        reference_number: refNumber,
        amount: 100,
        salesorder_id: 'SO1',
        idempotency_key: 'ABC'
      });
      expect(setCall[1].created_at).toEqual(expect.any(String));

      expect(cache.del).toHaveBeenCalledWith(pendingKey);
    });
  });

  // ---- Coordinator follow-up: the two pending-charge write sites must agree
  // on what idempotency_key means. The success-path write (terminal push OK)
  // and the 90s-timeout-path write are two separate code branches that both
  // persist a pending-charge record for the SAME kind of attempt — they must
  // store the SAME value (effectiveKey, the attempt's idempotency key — what
  // a client retry varies) rather than one storing effectiveKey and the other
  // storing helcimIdemKey (the derived Helcim API key). A field that means two
  // different things depending on which failure mode fired is a trap for
  // whoever reads it next (plan 50-05's D-50-08 discriminator).
  test('the timeout-path pending record stores the SAME idempotency_key shape as the success-path record (effectiveKey, not the derived Helcim key)', function () {
    mockHappyZoho('SO1', 'SO-001', 100);

    // Success-path record for one attempt.
    var reqSuccess = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var resSuccess = makeRes();
    paySalesorderHandler(reqSuccess, resSuccess);

    return flushN(8).then(function () {
      var successRefNumber = helcimLib.terminalPurchase.mock.calls[0][1];
      var successPendingKey = 'kiosk:pending-charge:' + successRefNumber;
      var successSetCall = cache.set.mock.calls.find(function (c) { return c[0] === successPendingKey; });
      expect(successSetCall).toBeTruthy();
      expect(successSetCall[1].idempotency_key).toBe('ABC');

      // Reset just enough state to run a second, independent attempt that
      // hits the 90s-timeout branch instead (terminalPurchase itself rejects
      // with the exact timeout message, mirroring kiosk-salesorders.test.js's
      // 'terminal timeout returns 504' convention).
      cache.set.mockClear();
      cache.acquireLock.mockResolvedValue(true);
      helcimLib.terminalPurchase.mockRejectedValueOnce(new Error('Terminal timeout after 90s'));

      var reqTimeout = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
      var resTimeout = makeRes();
      paySalesorderHandler(reqTimeout, resTimeout);

      return flushN(8).then(function () {
        expect(resTimeout._status).toBe(504);
        var timeoutSetCall = cache.set.mock.calls.find(function (c) {
          return typeof c[0] === 'string' && c[0].indexOf('kiosk:pending-charge:') === 0;
        });
        expect(timeoutSetCall).toBeTruthy();
        // Same effective key -> same idempotency_key value across BOTH branches.
        expect(timeoutSetCall[1].idempotency_key).toBe(successSetCall[1].idempotency_key);
        expect(timeoutSetCall[1].idempotency_key).toBe('ABC');
        // And explicitly NOT the derived Helcim key (sha256 hex slice), which
        // is what the timeout branch used to store before this fix.
        var crypto2 = require('crypto');
        var derivedHelcimKey = crypto2.createHash('sha256').update('ABC').digest('hex').substring(0, 25);
        expect(timeoutSetCall[1].idempotency_key).not.toBe(derivedHelcimKey);
      });
    });
  });

  // ---- Case 9: honest void reporting (depends on 50-01) ----
  test('an unconfirmed void is reported honestly: payment_voided false, needs_manual_review true', function () {
    mockHappyZoho('SO1', 'SO-001', 100);
    zohoApi.zohoPost.mockImplementation(function (endpoint) {
      if (endpoint.indexOf('/invoices/fromsalesorder') === 0) return Promise.resolve({ invoice: { invoice_id: 'INV-SO-1' } });
      if (/^\/invoices\/.+\/status\/sent$/.test(endpoint)) return Promise.resolve({});
      if (endpoint === '/customerpayments') return Promise.reject(new Error('Zoho payment API error'));
      return Promise.resolve({});
    });
    var unconfirmedErr = new Error('Helcim void not confirmed (status=none)');
    unconfirmedErr.isUnconfirmedVoid = true;
    helcimLib.voidTransaction.mockRejectedValue(unconfirmedErr);

    var req = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(10).then(function () {
      expect(res._status).toBe(502);
      expect(res._json.payment_voided).toBe(false);
      expect(res._json.needs_manual_review).toBe(true);
    });
  });

  // ---- Case 10: void goes through the hardened primitive ----
  test('the void path calls moneyPath.voidWithTimeout rather than calling helcimLib.voidTransaction unwrapped', function () {
    var moneyPath = require('../lib/money-path');
    var voidSpy = jest.spyOn(moneyPath, 'voidWithTimeout');

    mockHappyZoho('SO1', 'SO-001', 100);
    zohoApi.zohoPost.mockImplementation(function (endpoint) {
      if (endpoint.indexOf('/invoices/fromsalesorder') === 0) return Promise.resolve({ invoice: { invoice_id: 'INV-SO-1' } });
      if (/^\/invoices\/.+\/status\/sent$/.test(endpoint)) return Promise.resolve({});
      if (endpoint === '/customerpayments') return Promise.reject(new Error('Zoho payment API error'));
      return Promise.resolve({});
    });

    var req = makeReq({ salesorder_id: 'SO1', idempotency_key: 'ABC' });
    var res = makeRes();
    paySalesorderHandler(req, res);

    return flushN(10).then(function () {
      expect(voidSpy).toHaveBeenCalled();
      voidSpy.mockRestore();
    });
  });
});
