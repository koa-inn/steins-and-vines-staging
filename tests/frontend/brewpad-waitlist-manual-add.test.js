'use strict';

// Phase 80-05 Task 2: manual-add sheet with the D-23 disclosure state and
// MailerLite sync (D-21-D-25). Covers: the toolbar trigger, email validation,
// the get_waitlist-before-add snapshot ordering, the new-row optional-field
// write + mailerlite-sync, the D-23 dedupe disclosure (no sync, no optional
// write), and a write failure keeping the sheet open with typed values intact.

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
global.sessionStorage = global.localStorage;

global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: '',
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

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

var EXISTING_ROW = {
  id: 'w-existing',
  email: 'existing@example.com',
  status: 'waiting',
  signed_up_at: '2026-08-01T08:00:00.000Z',
  zoho_contact_id: '',
  customer_name: '',
  customer_phone: '',
  recipe_ids: '',
  mailerlite_synced: true
};

function renderWithRows(rows) {
  document.body.innerHTML = '<div id="bp-app"><div id="bp-panel-waitlist"></div></div><div id="bp-toast-container"></div>';
  bp._setWaitlistStateForTest({ rows: rows, filter: 'all', search: '' });
  bp.renderWaitlist();
  return document.getElementById('bp-panel-waitlist');
}

function proxyCalls() {
  return global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/api/batch/admin-proxy') !== -1; });
}

function proxyBodies() {
  return proxyCalls().map(function (c) {
    try { return JSON.parse(c[1].body); } catch (e) { return null; }
  });
}

function toastMessages() {
  return Array.prototype.map.call(document.querySelectorAll('#bp-toast-container .bp-toast-msg'), function (el) {
    return el.textContent;
  });
}

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Routes global.fetch by request shape so unrelated calls never reject.
function mockFetch(opts) {
  opts = opts || {};
  global.fetch.mockImplementation(function (url, options) {
    var u = String(url);

    if (u.indexOf('/api/recipes') !== -1 && u.indexOf('status=active') !== -1) {
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ recipes: opts.recipeCatalog || [] }); }
      });
    }

    if (u.indexOf('/mailerlite-sync') !== -1) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } });
    }

    if (u.indexOf('/api/batch/admin-proxy') !== -1) {
      var body = {};
      try { body = JSON.parse(options.body); } catch (e) {}
      if (body.action === 'get_waitlist') {
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ ok: true, data: opts.snapshot || [] }); }
        });
      }
      if (body.action === 'add_waitlist_entry') {
        if (opts.addReject) return Promise.reject(new Error('network down'));
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ ok: true, id: opts.newId || 'w-new' }); }
        });
      }
      if (body.action === 'update_waitlist_status') {
        if (opts.updateReject) {
          return Promise.resolve({
            ok: false,
            status: 502,
            json: function () { return Promise.resolve({ ok: false, message: 'write failed' }); }
          });
        }
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } });
      }
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } });
    }

    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
  });
}

beforeEach(function () {
  global.fetch.mockReset();
  mockFetch();
});

// ---------------------------------------------------------------------------

describe('toolbar trigger', function () {
  test('"+ Add to Waitlist" renders in the toolbar', function () {
    var panel = renderWithRows([]);
    var btn = document.getElementById('bp-waitlist-add-trigger');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('+ Add to Waitlist');
    expect(panel.contains(btn)).toBe(true);
  });

  test('tapping it opens the sheet', function () {
    renderWithRows([]);
    document.getElementById('bp-waitlist-add-trigger').click();
    expect(document.getElementById('bp-waitlist-add-sheet')).not.toBeNull();
    var title = document.querySelector('#bp-waitlist-add-sheet .bp-create-sheet-title');
    expect(title.textContent).toBe('Add to Waitlist');
  });
});

describe('validation', function () {
  test('empty email shows "Email is required." and issues no request', function () {
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-submit').click();
    var err = document.getElementById('bp-waitlist-add-email-error');
    expect(err.textContent).toBe('Email is required.');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('malformed email shows "Enter a valid email address." and issues no request', function () {
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'not-an-email';
    document.getElementById('bp-waitlist-add-submit').click();
    var err = document.getElementById('bp-waitlist-add-email-error');
    expect(err.textContent).toBe('Enter a valid email address.');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('submit ordering + payload (D-25)', function () {
  test('issues get_waitlist BEFORE add_waitlist_entry', function () {
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'new@example.com';
    document.getElementById('bp-waitlist-add-submit').click();
    return flushPromises().then(function () {
      var actions = proxyBodies().map(function (b) { return b.action; });
      expect(actions.indexOf('get_waitlist')).toBeLessThan(actions.indexOf('add_waitlist_entry'));
    });
  });

  test('add payload carries email and category beer, no signed_up_at', function () {
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'new@example.com';
    document.getElementById('bp-waitlist-add-submit').click();
    return flushPromises().then(function () {
      var addBody = proxyBodies().filter(function (b) { return b.action === 'add_waitlist_entry'; })[0];
      expect(addBody.email).toBe('new@example.com');
      expect(addBody.category).toBe('beer');
      expect(Object.prototype.hasOwnProperty.call(addBody, 'signed_up_at')).toBe(false);
    });
  });
});

describe('new-row path', function () {
  test('no optional field filled -> no update_waitlist_status call, sync fires, sheet closes, toast fires', function () {
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'plain@example.com';
    document.getElementById('bp-waitlist-add-submit').click();
    return flushPromises().then(function () {
      return flushPromises();
    }).then(function () {
      // The sheet's close animation defers actual DOM removal by 180ms
      // (matches openRecipeFromBatchSheet's closeRcSheet timing) -- wait past it.
      return new Promise(function (resolve) { setTimeout(resolve, 200); });
    }).then(function () {
      var actions = proxyBodies().map(function (b) { return b.action; });
      expect(actions.indexOf('update_waitlist_status')).toBe(-1);
      var syncCalls = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/mailerlite-sync') !== -1; });
      expect(syncCalls.length).toBe(1);
      expect(document.getElementById('bp-waitlist-add-sheet')).toBeNull();
      expect(toastMessages()).toContain('Added to waitlist');
    });
  });

  test('name/phone/recipes filled -> exactly one update_waitlist_status carrying only filled keys, then sync', function () {
    mockFetch({ recipeCatalog: [{ recipe_id: 'r1', name: 'Cascade Pale Ale' }] });
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'full@example.com';
    document.getElementById('bp-waitlist-add-name').value = 'Full Person';
    document.getElementById('bp-waitlist-add-phone').value = '604-555-0000';

    var recipeInput = document.getElementById('bp-waitlist-add-recipe-input');
    recipeInput.dispatchEvent(new Event('focus'));
    return flushPromises().then(function () {
      var opt = document.querySelector('#bp-waitlist-add-recipe-dropdown .bp-vessel-option[data-rid]');
      expect(opt).not.toBeNull();
      opt.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true }));
      var chips = document.getElementById('bp-waitlist-add-recipe-chips');
      expect(chips.textContent).toContain('Cascade Pale Ale');

      document.getElementById('bp-waitlist-add-submit').click();
      return flushPromises();
    }).then(function () {
      return flushPromises();
    }).then(function () {
      var updateCalls = proxyBodies().filter(function (b) { return b.action === 'update_waitlist_status'; });
      expect(updateCalls.length).toBe(1);
      expect(updateCalls[0]).toEqual({
        action: 'update_waitlist_status',
        id: 'w-new',
        customer_name: 'Full Person',
        customer_phone: '604-555-0000',
        recipe_ids: 'r1'
      });
      var syncCalls = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/mailerlite-sync') !== -1; });
      expect(syncCalls.length).toBe(1);
      expect(toastMessages()).toContain('Added to waitlist');
    });
  });
});

describe('D-23 disclosure (dedupe hit)', function () {
  test('returned id present in snapshot -> disclosure swap, no sync, no optional write, sheet stays open until Got It', function () {
    mockFetch({
      snapshot: [EXISTING_ROW],
      newId: EXISTING_ROW.id
    });
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'existing@example.com';
    document.getElementById('bp-waitlist-add-name').value = 'Should Not Write';
    document.getElementById('bp-waitlist-add-submit').click();
    return flushPromises().then(function () {
      return flushPromises();
    }).then(function () {
      var body = document.getElementById('bp-waitlist-add-body');
      expect(body.textContent).toContain('existing@example.com is already on the beer waitlist');
      expect(body.textContent).toContain('Waiting');
      var gotIt = document.getElementById('bp-waitlist-add-gotit');
      expect(gotIt).not.toBeNull();
      expect(gotIt.textContent).toBe('Got It');
      expect(document.getElementById('bp-waitlist-add-sheet')).not.toBeNull(); // still open

      var actions = proxyBodies().map(function (b) { return b.action; });
      expect(actions.indexOf('update_waitlist_status')).toBe(-1);
      var syncCalls = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/mailerlite-sync') !== -1; });
      expect(syncCalls.length).toBe(0);
    });
  });

  test('"Got It" dismisses the sheet', function () {
    mockFetch({ snapshot: [EXISTING_ROW], newId: EXISTING_ROW.id });
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'existing@example.com';
    document.getElementById('bp-waitlist-add-submit').click();
    return flushPromises().then(function () {
      return flushPromises();
    }).then(function () {
      document.getElementById('bp-waitlist-add-gotit').click();
      return new Promise(function (resolve) { setTimeout(resolve, 200); });
    }).then(function () {
      expect(document.getElementById('bp-waitlist-add-sheet')).toBeNull();
    });
  });
});

describe('write failure', function () {
  test('a failed add keeps the sheet open with typed values intact and shows "Failed: " + message', function () {
    mockFetch({ addReject: true });
    renderWithRows([]);
    bp._openWaitlistAddSheetForTest();
    document.getElementById('bp-waitlist-add-email').value = 'oops@example.com';
    document.getElementById('bp-waitlist-add-name').value = 'Oops Person';
    document.getElementById('bp-waitlist-add-submit').click();
    return flushPromises().then(function () {
      // adminApiPost's fetchWithRetry retries once on a network-level
      // rejection with a 1000ms backoff (js/brewpad.js:1691-1710) -- wait
      // past it with real timers rather than mocking the retry away.
      return new Promise(function (resolve) { setTimeout(resolve, 1200); });
    }).then(function () {
      expect(document.getElementById('bp-waitlist-add-sheet')).not.toBeNull();
      var errEl = document.getElementById('bp-waitlist-add-error');
      expect(errEl.textContent.indexOf('Failed: ')).toBe(0);
      expect(document.getElementById('bp-waitlist-add-email').value).toBe('oops@example.com');
      expect(document.getElementById('bp-waitlist-add-name').value).toBe('Oops Person');
    });
  });
});

describe('D-23 RACE comment (documentation gate)', function () {
  test('a D-23 RACE comment exists in the source documenting the snapshot-diff tradeoff', function () {
    var fs = require('fs');
    var src = fs.readFileSync(require.resolve('../../js/brewpad.js'), 'utf8');
    expect(src.indexOf('D-23 RACE:')).toBeGreaterThan(-1);
  });
});
