'use strict';

// =============================================================================
// Tests: Phase 85 Plan 09 -- BrewPad D-03 stale-save UX.
// The editor sends expected_updated_at on PUT/DELETE of an existing recipe,
// and a 409 stale_recipe shows the D-03 message with a Reload action. 409 is
// never auto-retried (no Retry action), and the draft is still snapshotted.
// =============================================================================

global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();
global.localStorage = {
  _data: {},
  getItem: function (k) { return this._data[k] || null; },
  setItem: function (k, v) { this._data[k] = v; },
  removeItem: function (k) { delete this._data[k]; },
  clear: function () { this._data = {}; }
};
global.sessionStorage = {
  _data: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
  setItem: function (k, v) { this._data[k] = v; },
  removeItem: function (k) { delete this._data[k]; },
  clear: function () { this._data = {}; }
};
global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://mw.test',
  MW_API_KEY: 'test-api-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token',
  ADMIN_API_URL: 'https://script.google.com/test/admin'
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

var TOKEN = '2026-10-07T10:00:00.123Z';
var STALE_MSG = 'This recipe was changed since you opened it — reload to see the latest';
var INGS = [{ item_id: 'I1', item_name: 'Cascade Hops', quantity: 5, unit: 'kg', purchase_rate: 2, rate: 3 }];

function injectEl(id, tag) {
  var el = document.createElement(tag || 'div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

function buildDom() {
  document.body.innerHTML = '';
  ['bp-recipes-detail-view', 'bp-recipes-list-view', 'bp-recipe-detail-title', 'bp-recipes-save-btn',
    'bp-recipe-delete', 'bp-recipe-clone', 'bp-recipe-activate', 'bp-recipe-status-error',
    'bp-recipe-ing-empty', 'bp-recipes-availability-banner', 'bp-toast-container'].forEach(function (id) {
    injectEl(id, 'div');
  });
  ['bp-recipe-name', 'bp-recipe-style', 'bp-recipe-description', 'bp-recipe-batch-size', 'bp-recipe-abv',
    'bp-recipe-ibu', 'bp-recipe-colour-srm', 'bp-recipe-pricing-mode', 'bp-recipe-locked-price',
    'bp-recipe-service-fee', 'bp-recipe-materials-fee', 'bp-recipe-status'].forEach(function (id) {
    injectEl(id, 'input');
  });
  var table = document.createElement('table');
  var tbody = document.createElement('tbody');
  tbody.id = 'bp-recipe-ing-tbody';
  var tfoot = document.createElement('tfoot');
  tfoot.id = 'bp-recipe-ing-tfoot';
  table.appendChild(tbody);
  table.appendChild(tfoot);
  document.body.appendChild(table);
  document.getElementById('bp-recipe-name').value = 'Test Recipe';
  document.getElementById('bp-recipe-batch-size').value = '23';
  document.getElementById('bp-recipe-pricing-mode').value = 'locked';
  document.getElementById('bp-recipe-locked-price').value = '29.99';
  document.getElementById('bp-recipe-status').value = 'draft';
}

function reply(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(body || {}); }
  });
}

function mockFetch(handler) {
  global.fetch.mockImplementation(function (url, opts) {
    var method = (opts && opts.method) || 'GET';
    var r = handler(String(url), method, opts);
    return r || reply(200, { recipes: [], items: [], ingredients: [], ok: true });
  });
}

function writeCalls(method) {
  return global.fetch.mock.calls.filter(function (c) {
    return ((c[1] && c[1].method) || 'GET') === method && String(c[0]).indexOf('/api/recipes') !== -1;
  });
}

function toast() {
  var els = document.querySelectorAll('#bp-toast-container .bp-toast');
  return els.length ? els[els.length - 1] : null;
}
function toastText() { var t = toast(); return t ? t.querySelector('.bp-toast-msg').textContent : ''; }
function toastAction() { var t = toast(); return t ? t.querySelector('.bp-toast-action') : null; }

beforeEach(function () {
  global.fetch.mockReset();
  global.sessionStorage.clear();
  buildDom();
  bp._setRecipesStateForTest({
    currentRecipeId: 'RCP-1',
    currentRecipe: { recipe_id: 'RCP-1', name: 'Test Recipe', updated_at: TOKEN },
    currentIngredients: INGS.slice(),
    availability: null,
    previousStatus: 'draft'
  });
});

describe('expected_updated_at on save', function () {
  test('PUT of an existing recipe carries the token', function () {
    mockFetch(function (url, method) { if (method === 'PUT') return reply(200, { ok: true }); });
    return bp.saveRecipe().then(function () {
      var puts = writeCalls('PUT');
      expect(puts.length).toBe(1);
      expect(JSON.parse(puts[0][1].body).expected_updated_at).toBe(TOKEN);
    });
  });

  test('POST of a new recipe has no token', function () {
    bp._setRecipesStateForTest({ currentRecipeId: null, currentRecipe: { updated_at: TOKEN } });
    mockFetch(function (url, method) { if (method === 'POST') return reply(200, { ok: true, recipe_id: 'RCP-2' }); });
    return bp.saveRecipe().then(function () {
      var posts = writeCalls('POST');
      expect(posts.length).toBe(1);
      expect(JSON.parse(posts[0][1].body).expected_updated_at).toBeUndefined();
    });
  });

  test('Retry of a transient 502 resubmits the same token', function () {
    var n = 0;
    mockFetch(function (url, method) {
      if (method === 'PUT') { n++; return n === 1 ? reply(502, {}) : reply(200, { ok: true }); }
    });
    return bp.saveRecipe().then(function () {
      var retry = toastAction();
      expect(retry.textContent).toBe('Retry');
      retry.click();
      return new Promise(function (r) { setTimeout(r, 50); });
    }).then(function () {
      var puts = writeCalls('PUT');
      expect(puts.length).toBe(2);
      expect(JSON.parse(puts[1][1].body).expected_updated_at).toBe(TOKEN);
    });
  });
});

describe('409 stale_recipe on save', function () {
  test('shows the D-03 message with Reload (not Retry), snapshots the draft, never retries', function () {
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(409, { error: STALE_MSG, code: 'stale_recipe' });
    });
    return bp.saveRecipe().then(function () {
      expect(toastText()).toBe(STALE_MSG);
      expect(toastText().indexOf('Could not save recipe.')).toBe(-1);
      expect(toastAction().textContent).toBe('Reload');
      expect(global.sessionStorage.getItem('sv-brewpad-recipe-draft')).not.toBeNull();
      expect(writeCalls('PUT').length).toBe(1);
    });
  });

  test('Reload re-opens the recipe (GET detail)', function () {
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(409, { error: STALE_MSG, code: 'stale_recipe' });
    });
    return bp.saveRecipe().then(function () {
      global.fetch.mockClear();
      toastAction().click();
      var gets = global.fetch.mock.calls.filter(function (c) {
        return String(c[0]).indexOf('/api/recipes/RCP-1') !== -1 && String(c[0]).indexOf('availability') === -1;
      });
      expect(gets.length).toBe(1);
    });
  });

  test('transient set is unchanged (409 excluded) -- source pin', function () {
    var src = require('fs').readFileSync(require('path').join(__dirname, '../../js/brewpad.js'), 'utf8');
    expect(src.indexOf('!status || status === 502 || status === 503 || status === 504')).not.toBe(-1);
  });
});

describe('delete', function () {
  function confirmDelete() {
    bp.deleteRecipe('RCP-1', 'Test Recipe');
    document.getElementById('bp-confirm-sheet-ok').click();
    return new Promise(function (r) { setTimeout(r, 50); });
  }

  test('URL carries the encoded token', function () {
    mockFetch(function (url, method) { if (method === 'DELETE') return reply(200, { ok: true }); });
    return confirmDelete().then(function () {
      var dels = writeCalls('DELETE');
      expect(dels.length).toBe(1);
      expect(dels[0][0]).toBe('http://mw.test/api/recipes/RCP-1?expected_updated_at=' + encodeURIComponent(TOKEN));
    });
  });

  test('409 stale_recipe shows D-03 message + Reload, list view not shown', function () {
    document.getElementById('bp-recipes-list-view').style.display = 'none';
    mockFetch(function (url, method) {
      if (method === 'DELETE') return reply(409, { error: STALE_MSG, code: 'stale_recipe' });
    });
    return confirmDelete().then(function () {
      expect(toastText()).toBe(STALE_MSG);
      expect(toastAction().textContent).toBe('Reload');
      expect(document.getElementById('bp-recipes-list-view').style.display).toBe('none');
    });
  });

  test('other delete failure keeps the generic message', function () {
    mockFetch(function (url, method) { if (method === 'DELETE') return reply(500, { ok: false, error: 'boom' }); });
    return confirmDelete().then(function () {
      expect(toastText()).toBe('Could not delete recipe. Please try again.');
    });
  });
});
