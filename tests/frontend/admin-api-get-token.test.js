'use strict';

// Regression test for Phase 64-03 / OPS-03 SC#3: adminApiGet leaked the Google
// OAuth access token into the request URL query string
// (ADMIN_API_URL + '?action=...&token=...') on BOTH staff surfaces
// (brewpad.js:1285, admin.js:681) -- any intermediary/proxy/access log that
// captures request URLs (but not bodies) captured the short-lived token.
//
// Verifies adminApiGet now POSTs the token in the JSON body (matching the
// existing adminApiPost transport), the URL carries no query string at all,
// and the exact return contract (resolve `data` unchanged on ok:true;
// handleUnauthorized()-then-reject on ok:false unauthorized) is preserved.
//
// Exercised via the same test-only export seam already used by every other
// IIFE-scoped helper in these files (mirrors _setAccessTokenForTest /
// checkAuthorization in the same exports blocks) -- adminApiGet has no
// public caller that isolates a single call/response.
//
// Phase 76-03 amendment (D-01): brewpad.js's adminApiGet/adminApiPost were
// migrated wholesale to the middleware's allow-listed admin-proxy
// (mwUrl()+'/api/batch/admin-proxy') and no longer send a Google token at
// all -- the 64-03 "token moved from URL to body" concern is now moot for
// that surface (there is no token in the request whatsoever; identity is
// proven by the x-session-token header instead). admin.js is untouched by
// Phase 76 (Pitfall 4: BrewPad-only scope) and keeps the original 64-03
// contract unchanged. The `surface` objects below now carry the per-surface
// transport/unauthorized-outcome expectations so this one shared suite can
// assert the correct (and now divergent) contract for each.

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function mockFetchOnce(body) {
  global.fetch.mockImplementationOnce(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  });
}

// ---------------------------------------------------------------------------
// Per-surface suite -- identical behavior contract, different module + DOM
// fixture (brewpad.js's handleUnauthorized touches #bp-* elements; admin.js's
// touches #admin-* elements).
// ---------------------------------------------------------------------------
function runAdminApiGetTokenSuite(surface) {
  describe('adminApiGet POSTs the token in the body, never the URL (' + surface.name + ', 64-03/OPS-03 SC#3)', function () {
    var mod;

    beforeEach(function () {
      jest.resetModules();

      document.body.innerHTML = surface.domFixture;
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
        ADMIN_API_URL: 'https://script.google.com/test/admin',
        SHEET_NAMES: {
          KITS: 'Kits', INGREDIENTS: 'Ingredients', RESERVATIONS: 'Reservations',
          HOLDS: 'Holds', SCHEDULE: 'Schedule', HOMEPAGE: 'Homepage'
        }
      };

      // auth.js primitives are loaded via <script> in the browser; wire as
      // globals for tests (mirrors tests/frontend/brewpad-delete-reconcile.test.js).
      var _auth = require('../../js/lib/auth');
      global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
      global.gsiInitTokenClient = _auth.gsiInitTokenClient;
      global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

      mod = require(surface.modulePath);
      surface.setAccessToken(mod, 'test-access-token');
    });

    test(surface.urlTestTitle, function () {
      mockFetchOnce({ ok: true, data: { vessels: [] } });

      mod._adminApiGetForTest('get_vessels');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      var url = String(global.fetch.mock.calls[0][0]);
      expect(url).toBe(surface.expectedUrl(global.SHEETS_CONFIG));
      expect(url.indexOf('token=')).toBe(-1);
      expect(url.indexOf('?action=')).toBe(-1);
    });

    test(surface.bodyTestTitle, function () {
      mockFetchOnce({ ok: true, data: { batch_id: 'X' } });

      mod._adminApiGetForTest('get_batch', { batch_id: 'X' });

      var call = global.fetch.mock.calls[0];
      var opts = call[1];
      expect(opts.method).toBe('POST');
      var body = JSON.parse(opts.body);
      if (surface.expectTokenField) {
        expect(body.token).toBe('test-access-token');
      } else {
        expect(body).not.toHaveProperty('token');
      }
      expect(body.action).toBe('get_batch');
      expect(body.batch_id).toBe('X');
    });

    test('resolves { ok:true, data } unchanged (return contract)', function () {
      mockFetchOnce({ ok: true, data: { vessels: ['v1'] } });

      return mod._adminApiGetForTest('get_vessels').then(function (data) {
        expect(data).toEqual({ ok: true, data: { vessels: ['v1'] } });
      });
    });

    test(surface.unauthorizedTestTitle, function () {
      mockFetchOnce({ ok: false, message: 'unauthorized' });

      var rejected = mod._adminApiGetForTest('get_vessels').then(
        function () { throw new Error('expected rejection, got resolution'); },
        function (err) { return err; }
      );

      return flushPromises().then(function () {
        return rejected;
      }).then(function (err) {
        expect(err).toBeInstanceOf(Error);
        surface.assertUnauthorizedOutcome();
      });
    });
  });
}

runAdminApiGetTokenSuite({
  name: 'brewpad.js',
  modulePath: '../../js/brewpad',
  domFixture: '<div id="bp-toast-container"></div>',
  setAccessToken: function (mod, token) { mod._setAccessTokenForTest(token); },
  // Phase 76-03 (D-01): brewpad.js's adminApiGet/adminApiPost were migrated
  // wholesale to the middleware admin-proxy -- no Google token anywhere in
  // the request, target URL is mwUrl()+'/api/batch/admin-proxy' rather than
  // ADMIN_API_URL.
  urlTestTitle: 'issues a fetch to the middleware admin-proxy (no ADMIN_API_URL, no query string) -- Phase 76-03 D-01',
  expectedUrl: function (cfg) { return cfg.MIDDLEWARE_URL + '/api/batch/admin-proxy'; },
  bodyTestTitle: 'POSTs method with action + params in the JSON body, no token field -- Phase 76-03 D-01',
  expectTokenField: false,
  unauthorizedTestTitle: '{ ok:false, message: "unauthorized" } rejects WITHOUT clearing sv_session (D-02/D-03: no more per-call isUnauthorizedError/handleUnauthorized)',
  assertUnauthorizedOutcome: function () {
    // D-03: a body-level "unauthorized" message from the upstream admin-proxy
    // response is NOT a real middleware HTTP 401 -- it must never show the
    // session-expired overlay (that is now the sole job of the global
    // _handleMiddlewareResponse interceptor, keyed on res.status === 401).
    expect(document.getElementById('bp-session-overlay')).toBeNull();
  }
});

runAdminApiGetTokenSuite({
  name: 'admin.js',
  modulePath: '../../js/admin',
  domFixture:
    '<div id="admin-signin"></div>' +
    '<div id="admin-denied" style="display:none"></div>' +
    '<div id="admin-dashboard"></div>' +
    '<span id="admin-user-email">staff@example.com</span>' +
    '<button id="admin-signout"></button>',
  setAccessToken: function (mod, token) { mod._setAccessToken(token); },
  // Phase 82 D-22: admin.js's adminApiGet/adminApiPost are migrated onto the
  // middleware's session-authenticated /api/admin/proxy (mirrors Phase 76-03's
  // brewpad.js change) -- no Google token anywhere in the request, target URL
  // is MIDDLEWARE_URL + '/api/admin/proxy' rather than ADMIN_API_URL, and a
  // body-level "unauthorized" message no longer logs the user out (only a
  // real middleware HTTP 401 does, via handleProxyResponse).
  urlTestTitle: 'issues a fetch to the middleware admin proxy (no ADMIN_API_URL, no query string) -- Phase 82 D-05',
  expectedUrl: function (cfg) { return cfg.MIDDLEWARE_URL + '/api/admin/proxy'; },
  bodyTestTitle: 'POSTs action + params in the JSON body, no token field -- Phase 82 D-06',
  expectTokenField: false,
  unauthorizedTestTitle: '{ ok:false, message: "unauthorized" } rejects WITHOUT logging out (Phase 82 D-07: only a real middleware 401 does)',
  assertUnauthorizedOutcome: function () {
    expect(document.getElementById('admin-dashboard').style.display).not.toBe('none');
  }
});
