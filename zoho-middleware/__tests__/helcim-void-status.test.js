'use strict';

// ---------------------------------------------------------------------------
// helcim-void-status.test.js
//
// Regression coverage for M-A2 / audit H5 (roadmap SC#3, phase 50 MONEY-02):
//
// ROOT DEFECT: voidTransaction() resolved { ok: true } on ANY 2xx response
// from Helcim /payment/reverse, without inspecting whether Helcim actually
// reversed the charge (lib/helcim.js:144-157). Every void-on-failure path —
// kiosk confirm, salesorder-pay, checkout, reconcile sweep — trusts that
// boolean. A failed-but-200 reversal told staff "Payment Voided" while the
// customer stayed charged.
//
// FIX (D-50-02): voidTransaction now inspects the response body for a
// positive reversal signal (status in APPROVED/COMPLETED/REVERSED/VOIDED,
// OR approved === true, OR transactionId + type in reverse/void) and
// REJECTS with err.isUnconfirmedVoid === true when none is present.
//
// D-50-02b: the rejection message text must not contain 'already',
// 'reversal', 'reversed', or 'voided' — those substrings are the collision
// contract lib/reconcile.js:149-167 (isAlreadyVoidedError) uses to classify
// an error as a SUCCESS (charge already voided by another path). A collision
// would silently swallow a genuinely unconfirmed void inside the sweep's
// backstop, reintroducing the exact bug this plan fixes.
//
// Cases 1, 2, 7, 8, 9 MUST FAIL against pre-fix code (current code resolves
// { ok: true } on any 2xx, so these never reject). Cases 3-6 are the
// anti-regression half — they PASS against pre-fix code and must keep
// passing post-fix (a working void is never misreported as failed).
// ---------------------------------------------------------------------------

jest.mock('axios');

var axios = require('axios');
var helcim = require('../lib/helcim');
var reconcile = require('../lib/reconcile');

describe('voidTransaction — reversal status inspection (M-A2 / audit H5)', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    process.env.HELCIM_API_TOKEN = 'test-token-void-status';
    helcim.init();
  });

  afterEach(function () {
    delete process.env.HELCIM_API_TOKEN;
    delete process.env.HELCIM_DEVICE_CODE;
  });

  // -------------------------------------------------------------------------
  // Case 1: empty body — no positive signal at all
  // -------------------------------------------------------------------------
  test('1. 200 with empty body {} → REJECTS (unconfirmed)', function () {
    axios.post.mockResolvedValue({ data: {} });
    return expect(helcim.voidTransaction('txn-1')).rejects.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Case 2: explicit negative status
  // -------------------------------------------------------------------------
  test('2. 200 with status DECLINED → REJECTS', function () {
    axios.post.mockResolvedValue({ data: { status: 'DECLINED' } });
    return expect(helcim.voidTransaction('txn-1')).rejects.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Case 3: status APPROVED — positive signal
  // -------------------------------------------------------------------------
  test('3. 200 with status APPROVED + transactionId → RESOLVES ok:true', function () {
    axios.post.mockResolvedValue({ data: { status: 'APPROVED', transactionId: 'rev-1' } });
    return expect(helcim.voidTransaction('txn-1')).resolves.toMatchObject({
      ok: true,
      transactionId: 'txn-1'
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: status REVERSED — positive signal
  // -------------------------------------------------------------------------
  test('4. 200 with status REVERSED → RESOLVES ok:true', function () {
    axios.post.mockResolvedValue({ data: { status: 'REVERSED' } });
    return expect(helcim.voidTransaction('txn-1')).resolves.toMatchObject({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Case 5: approved === true — positive signal
  // -------------------------------------------------------------------------
  test('5. 200 with approved:true → RESOLVES ok:true', function () {
    axios.post.mockResolvedValue({ data: { approved: true } });
    return expect(helcim.voidTransaction('txn-1')).resolves.toMatchObject({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Case 6: transactionId + type reverse — positive signal
  // -------------------------------------------------------------------------
  test('6. 200 with transactionId + type:reverse → RESOLVES ok:true', function () {
    axios.post.mockResolvedValue({ data: { transactionId: 'rev-2', type: 'reverse' } });
    return expect(helcim.voidTransaction('txn-1')).resolves.toMatchObject({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Case 7 (D-50-02a): rejection carries err.isUnconfirmedVoid === true so
  // callers' generic .catch handlers can route it into the fail-closed
  // void-failure machinery without inspecting message text.
  // -------------------------------------------------------------------------
  test('7. D-50-02a: unconfirmed-void rejection has err.isUnconfirmedVoid === true', function () {
    axios.post.mockResolvedValue({ data: {} });
    return helcim.voidTransaction('txn-1').then(function (result) {
      throw new Error('Expected voidTransaction to reject, but it resolved with: ' + JSON.stringify(result));
    }, function (err) {
      expect(err).toBeDefined();
      expect(err.isUnconfirmedVoid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Case 8 (D-50-02b): the rejection message text must not contain any of
  // the four substrings isAlreadyVoidedError treats as a SUCCESS signal.
  // Assert all four independently so a future message edit that reintroduces
  // the reconcile collision fails loudly.
  // -------------------------------------------------------------------------
  test('8. D-50-02b: rejection message contains none of already/reversal/reversed/voided', function () {
    axios.post.mockResolvedValue({ data: {} });
    return helcim.voidTransaction('txn-1').then(function (result) {
      throw new Error('Expected voidTransaction to reject, but it resolved with: ' + JSON.stringify(result));
    }, function (err) {
      var msg = (err && err.message || '').toLowerCase();
      expect(msg).not.toContain('already');
      expect(msg).not.toContain('reversal');
      expect(msg).not.toContain('reversed');
      expect(msg).not.toContain('voided');
    });
  });

  // -------------------------------------------------------------------------
  // Case 9: cross-module guard. lib/reconcile.js's isAlreadyVoidedError must
  // NOT classify the unconfirmed-void rejection as an already-voided success
  // — otherwise the reconcile sweep silently swallows the bug this plan
  // fixes, clearing the pending record with no staff alert.
  // -------------------------------------------------------------------------
  test('9. reconcile.isAlreadyVoidedError(err) returns false for the unconfirmed-void rejection', function () {
    axios.post.mockResolvedValue({ data: {} });
    return helcim.voidTransaction('txn-1').then(function (result) {
      throw new Error('Expected voidTransaction to reject, but it resolved with: ' + JSON.stringify(result));
    }, function (err) {
      expect(reconcile.isAlreadyVoidedError(err)).toBe(false);
    });
  });
});
