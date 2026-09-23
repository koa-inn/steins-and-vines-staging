'use strict';

// Regression tests for Phase 82-06 (D-05..D-08, D-22): admin.js's
// adminApiGet/adminApiPost now talk to the session-authenticated
// /api/admin/proxy instead of ADMIN_API_URL, send no Google access token,
// retry reads on transient 502/503/504 (but not writes -- a retried write
// risks double-applying a mutation Apps Script already processed before the
// proxy's own timeout fired), and log the user out ONLY on a real
// middleware HTTP 401 -- never on a body-level "unauthorized" message
// (that path, isUnauthorizedError/handleUnauthorized, is deleted outright).
//
// Reference implementation cloned: js/brewpad.js's fetchWithRetry (retryStatuses
// param) + adminApiGet/adminApiPost + the write-once rule this phase makes
// even stricter (brewpad.js still retries a write once on network rejection;
// D-08 removes that for admin.js -- a dropped connection can follow a write
// Apps Script already applied).

var fs = require('fs');
var path = require('path');

function mockFetchOnce(status, body) {
  return function () {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(body); }
    });
  };
}

describe('admin.js data transport: /api/admin/proxy, reads-retry/writes-once, 401-only logout (82-06 D-05..D-08)', function () {
  var admin;

  beforeEach(function () {
    jest.resetModules();
    jest.useFakeTimers();

    document.body.innerHTML =
      '<div id="admin-signin" style="display:none"></div>' +
      '<div id="admin-denied" style="display:none"></div>' +
      '<div id="admin-dashboard"></div>' +
      '<span id="admin-user-email">staff@example.com</span>' +
      '<button id="admin-signout"></button>';

    global.window = global.window || {};
    global.navigator = global.navigator || {};
    global.google = { accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } } };
    global.fetch = jest.fn();
    global.localStorage = {
      _data: {},
      getItem: function (k) { return this._data[k] || null; },
      setItem: function (k, v) { this._data[k] = v; },
      removeItem: function (k) { delete this._data[k]; },
      clear: function () { this._data = {}; }
    };
    global.sessionStorage = global.localStorage;
    global.SHEETS_CONFIG = {
      MIDDLEWARE_URL: 'http://mw.test',
      SPREADSHEET_ID: 'test-id',
      CLIENT_ID: 'test-client-id',
      ADMIN_API_URL: '',
      SHEET_NAMES: {
        KITS: 'Kits', INGREDIENTS: 'Ingredients', RESERVATIONS: 'Reservations',
        HOLDS: 'Holds', SCHEDULE: 'Schedule', HOMEPAGE: 'Homepage'
      }
    };

    var _auth = require('../../js/lib/auth');
    global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
    global.gsiInitTokenClient = _auth.gsiInitTokenClient;
    global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

    admin = require('../../js/admin.js');
    admin._setAccessToken('test-access-token');
    admin._setUserEmail('staff@example.com');
    global.localStorage.setItem('sv_session_token', 'sess-abc');
  });

  afterEach(function () {
    jest.useRealTimers();
  });

  test('adminApiGet issues one POST to MIDDLEWARE_URL + /api/admin/proxy, credentials include, no token', async function () {
    global.fetch.mockImplementationOnce(mockFetchOnce(200, { ok: true, data: { values: [] } }));

    var p = admin._adminApiGetForTest('get_kits');
    await jest.advanceTimersByTimeAsync(0);
    await p;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var call = global.fetch.mock.calls[0];
    expect(call[0]).toBe('http://mw.test/api/admin/proxy');
    var opts = call[1];
    expect(opts.method).toBe('POST');
    expect(opts.credentials).toBe('include');
    expect(opts.headers['Content-Type']).toBe('application/json');
    var body = JSON.parse(opts.body);
    expect(body).toEqual({ action: 'get_kits' });
    expect(body).not.toHaveProperty('token');
  });

  test('adminApiGet forwards action + params in the JSON body', async function () {
    global.fetch.mockImplementationOnce(mockFetchOnce(200, { ok: true, data: {} }));

    var p = admin._adminApiGetForTest('get_reservations', { limit: 50, offset: 0, status: 'pending' });
    await jest.advanceTimersByTimeAsync(0);
    await p;

    var body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ action: 'get_reservations', limit: 50, offset: 0, status: 'pending' });
  });

  test('adminApiPost issues one POST with action + payload, no token', async function () {
    global.fetch.mockImplementationOnce(mockFetchOnce(200, { ok: true }));

    var p = admin._adminApiPostForTest('update_hold', { holdId: 'H-1' });
    await jest.advanceTimersByTimeAsync(0);
    await p;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var call = global.fetch.mock.calls[0];
    expect(call[0]).toBe('http://mw.test/api/admin/proxy');
    var opts = call[1];
    expect(opts.credentials).toBe('include');
    var body = JSON.parse(opts.body);
    expect(body).toEqual({ action: 'update_hold', holdId: 'H-1' });
    expect(body).not.toHaveProperty('token');
  });

  test('read retries a 502 once then resolves on the eventual 200', async function () {
    global.fetch
      .mockImplementationOnce(mockFetchOnce(502, {}))
      .mockImplementationOnce(mockFetchOnce(200, { ok: true, data: {} }));

    var p = admin._adminApiGetForTest('get_kits');
    await jest.advanceTimersByTimeAsync(5000);
    var data = await p;

    expect(data.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('read gives up after exhausting retries on repeated 503 (3 total calls)', async function () {
    global.fetch.mockImplementation(mockFetchOnce(503, {}));

    var p = admin._adminApiGetForTest('get_kits');
    await jest.advanceTimersByTimeAsync(5000);
    var rejected = p.then(
      function () { throw new Error('expected rejection, got resolution'); },
      function (err) { return err; }
    );
    var err = await rejected;

    expect(err).toBeInstanceOf(Error);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('read retries a network rejection then resolves (2 total calls)', async function () {
    global.fetch
      .mockImplementationOnce(function () { return Promise.reject(new Error('network down')); })
      .mockImplementationOnce(mockFetchOnce(200, { ok: true, data: {} }));

    var p = admin._adminApiGetForTest('get_kits');
    await jest.advanceTimersByTimeAsync(5000);
    var data = await p;

    expect(data.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('write does NOT retry a 502 -- rejects after exactly one fetch call', async function () {
    global.fetch.mockImplementationOnce(mockFetchOnce(502, {}));

    var p = admin._adminApiPostForTest('update_hold', { holdId: 'H-1' });
    await jest.advanceTimersByTimeAsync(5000);
    var rejected = p.then(
      function () { throw new Error('expected rejection, got resolution'); },
      function (err) { return err; }
    );
    var err = await rejected;

    expect(err).toBeInstanceOf(Error);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('write does NOT retry a network rejection -- rejects after exactly one fetch call', async function () {
    global.fetch.mockImplementationOnce(function () { return Promise.reject(new Error('network down')); });

    var p = admin._adminApiPostForTest('update_hold', { holdId: 'H-1' });
    await jest.advanceTimersByTimeAsync(5000);
    var rejected = p.then(
      function () { throw new Error('expected rejection, got resolution'); },
      function (err) { return err; }
    );
    var err = await rejected;

    expect(err).toBeInstanceOf(Error);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('body-level { ok:false, message:"unauthorized" } rejects WITHOUT logging out (D-07)', async function () {
    global.fetch.mockImplementationOnce(mockFetchOnce(200, { ok: false, message: 'unauthorized' }));

    var p = admin._adminApiGetForTest('get_kits');
    await jest.advanceTimersByTimeAsync(0);
    var rejected = p.then(
      function () { throw new Error('expected rejection, got resolution'); },
      function (err) { return err; }
    );
    var err = await rejected;

    expect(err).toBeInstanceOf(Error);
    // Never a real middleware 401 -- must not touch the sign-in screen or session.
    expect(document.getElementById('admin-signin').style.display).toBe('none');
    expect(global.localStorage.getItem('sv_session_token')).toBe('sess-abc');
  });

  test('a real HTTP 401 rejects AND enters the logged-out state (D-07)', async function () {
    global.fetch.mockImplementationOnce(mockFetchOnce(401, { ok: false, error: 'unauthorized' }));

    var p = admin._adminApiGetForTest('get_kits');
    await jest.advanceTimersByTimeAsync(0);
    var rejected = p.then(
      function () { throw new Error('expected rejection, got resolution'); },
      function (err) { return err; }
    );
    var err = await rejected;

    expect(err).toBeInstanceOf(Error);
    expect(document.getElementById('admin-signin').style.display).toBe('');
    expect(document.getElementById('admin-dashboard').style.display).toBe('none');
    expect(global.localStorage.getItem('sv_session_token')).toBeNull();
  });

  test('adminApiGet/adminApiPost no longer reject with "Admin API not configured" when ADMIN_API_URL is absent', async function () {
    // beforeEach already sets ADMIN_API_URL: '' -- confirm both helpers still work.
    global.fetch
      .mockImplementationOnce(mockFetchOnce(200, { ok: true, data: {} }))
      .mockImplementationOnce(mockFetchOnce(200, { ok: true }));

    var getP = admin._adminApiGetForTest('get_kits');
    await jest.advanceTimersByTimeAsync(0);
    await expect(getP).resolves.toEqual({ ok: true, data: {} });

    var postP = admin._adminApiPostForTest('update_hold', { holdId: 'H-1' });
    await jest.advanceTimersByTimeAsync(0);
    await expect(postP).resolves.toEqual({ ok: true });
  });
});

describe('source-shape: body-substring unauthorized detection is gone (82-06 D-07)', function () {
  var SRC = fs.readFileSync(path.join(__dirname, '../../js/admin.js'), 'utf8');

  test('isUnauthorizedError/handleUnauthorized no longer appear anywhere', function () {
    expect((SRC.match(/isUnauthorizedError|handleUnauthorized/g) || []).length).toBe(0);
  });

  function bodyOf(fnName) {
    var start = SRC.indexOf('function ' + fnName + '(');
    expect(start).toBeGreaterThan(-1);
    var next = SRC.indexOf('\n  function ', start + 1);
    return SRC.slice(start, next === -1 ? SRC.length : next);
  }

  test('adminApiGet opts reads into 502/503/504 retry', function () {
    expect(bodyOf('adminApiGet')).toMatch(/\[502, 503, 504\]/);
  });

  test('adminApiPost does NOT opt writes into any 5xx retry', function () {
    expect(bodyOf('adminApiPost')).not.toMatch(/50[234]/);
  });
});
