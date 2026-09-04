'use strict';

// Phase 80-04 Task 2: per-row recipe multi-select attach with removable chips
// (D-15/D-16). Covers: the picker's own lazy-fetch catalog (never
// _recipesState, never requires initRecipesTab to have run), client-side
// filtering with no second network call, multi-select attach with the picker
// staying open, per-chip removal preserving survivor order, and the D-16
// guard that nothing here ever fetches a recipe detail or touches
// stock/batch/pricing state.

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
// Helpers
// ---------------------------------------------------------------------------

// A fresh object per call -- attachWaitlistRecipe/removeWaitlistRecipe mutate
// row.recipe_ids in place (the same closure-owned _waitlistRows entry a real
// session would mutate), so a single shared fixture object would leak state
// across tests.
function freshRow(overrides) {
  return Object.assign({
    id: 'w1',
    email: 'jane@example.com',
    status: 'waiting',
    signed_up_at: '2026-08-15T08:00:00.000Z',
    zoho_contact_id: '',
    customer_name: '',
    customer_phone: '',
    recipe_ids: '',
    mailerlite_synced: true
  }, overrides || {});
}
var CATALOG = [
  { recipe_id: 'SV-R-000003', name: 'Cascade Pale Ale', style: 'Pale Ale' },
  { recipe_id: 'SV-R-000007', name: 'Stout Night', style: 'Stout' }
];

function renderWithRows(rows) {
  document.body.innerHTML = '<div id="bp-panel-waitlist"></div><div id="bp-toast-container"></div>';
  bp._setWaitlistStateForTest({ rows: rows, filter: 'all', search: '' });
  bp.renderWaitlist();
  return document.getElementById('bp-panel-waitlist');
}

function recipesCellFor(panel) {
  return panel.querySelectorAll('tbody tr td')[2];
}

function postedBodies() {
  return global.fetch.mock.calls
    .filter(function (c) { return String(c[0]).indexOf('/api/batch/admin-proxy') !== -1; })
    .map(function (c) {
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

function mockFetch(opts) {
  opts = opts || {};
  global.fetch.mockImplementation(function (url) {
    var u = String(url);

    if (u.indexOf('/api/recipes?status=active') !== -1) {
      if (opts.catalogReject) return Promise.reject(new Error('network down'));
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ recipes: opts.catalog !== undefined ? opts.catalog : CATALOG }); }
      });
    }

    if (u.indexOf('/api/batch/admin-proxy') !== -1) {
      if (opts.writeReject) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: function () { return Promise.resolve({ ok: false, message: 'write failed' }); }
        });
      }
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ ok: true }); }
      });
    }

    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
  });
}

beforeEach(function () {
  global.fetch.mockReset();
  bp._setWaitlistRecipeCatalogForTest(null);
  mockFetch();
});

// ---------------------------------------------------------------------------

describe('opening the picker on a cold session (Recipes tab never opened)', function () {
  test('tapping "+ Attach recipe" fetches its own /api/recipes?status=active catalog', function () {
    var row = freshRow();
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    bp._openWaitlistRecipeAttachPanelForTest(cell, row.id);

    var dropdown = document.getElementById('bp-waitlist-recipe-' + row.id + '-dropdown');
    expect(dropdown.textContent).toContain('Loading recipes…');

    return flushPromises().then(function () {
      var catalogCalls = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/api/recipes?status=active') !== -1; });
      expect(catalogCalls.length).toBe(1);
      var options = dropdown.querySelectorAll('.bp-vessel-option[data-rid]');
      expect(options.length).toBe(2);
    });
  });

  test('a filtered-empty result shows "No recipes found"', function () {
    mockFetch({ catalog: [] });
    var row = freshRow();
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    bp._openWaitlistRecipeAttachPanelForTest(cell, row.id);
    return flushPromises().then(function () {
      var dropdown = document.getElementById('bp-waitlist-recipe-' + row.id + '-dropdown');
      expect(dropdown.textContent).toContain('No recipes found');
    });
  });

  test('typing filters the cached catalog client-side with no second network call', function () {
    var row = freshRow();
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    bp._openWaitlistRecipeAttachPanelForTest(cell, row.id);
    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var input = document.getElementById('bp-waitlist-recipe-' + row.id + '-input');
      input.value = 'stout';
      input.dispatchEvent(new Event('input'));
      expect(global.fetch).toHaveBeenCalledTimes(1); // still just the one catalog fetch
      var dropdown = document.getElementById('bp-waitlist-recipe-' + row.id + '-dropdown');
      var options = dropdown.querySelectorAll('.bp-vessel-option[data-rid]');
      expect(options.length).toBe(1);
      expect(options[0].textContent).toContain('Stout Night');
    });
  });

  test('no request is ever made to an /api/recipes/{id} detail path', function () {
    var row = freshRow();
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    bp._openWaitlistRecipeAttachPanelForTest(cell, row.id);
    return flushPromises().then(function () {
      return bp._attachWaitlistRecipeForTest(row.id, 'SV-R-000003', 'Cascade Pale Ale', cell);
    }).then(function () {
      var detailCalls = global.fetch.mock.calls.filter(function (c) {
        return (/\/api\/recipes\/[^?]/).test(String(c[0]));
      });
      expect(detailCalls.length).toBe(0);
    });
  });
});

describe('selecting a recipe (attach)', function () {
  test('appends recipe_id and issues exactly one adminApiPost with pipe-joined recipe_ids in order', function () {
    var row = freshRow();
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    return bp._attachWaitlistRecipeForTest(row.id, 'SV-R-000003', 'Cascade Pale Ale', cell).then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = postedBodies()[0];
      expect(body).toEqual({ action: 'update_waitlist_status', id: row.id, recipe_ids: 'SV-R-000003' });
      return bp._attachWaitlistRecipeForTest(row.id, 'SV-R-000007', 'Stout Night', cell);
    }).then(function () {
      var bodies = postedBodies();
      expect(bodies[1]).toEqual({ action: 'update_waitlist_status', id: row.id, recipe_ids: 'SV-R-000003|SV-R-000007' });
      expect(toastMessages()).toContain('Recipe attached');
    });
  });

  test('selecting an already-attached recipe does not duplicate it and issues no write', function () {
    // Catalog pre-populated (mirrors the real flow: the dropdown can only be
    // clicked once its own lazy-fetch has resolved) so the duplicate-skip
    // path's re-render doesn't itself trigger an unrelated catalog fetch.
    bp._setWaitlistRecipeCatalogForTest(CATALOG);
    var row = freshRow({ recipe_ids: 'SV-R-000003' });
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    bp._attachWaitlistRecipeForTest(row.id, 'SV-R-000003', 'Cascade Pale Ale', cell);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the picker stays open after a selection so a second recipe can be attached', function () {
    var row = freshRow();
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    bp._openWaitlistRecipeAttachPanelForTest(cell, row.id);
    return bp._attachWaitlistRecipeForTest(row.id, 'SV-R-000003', 'Cascade Pale Ale', cell).then(function () {
      expect(cell.querySelector('#bp-waitlist-recipe-' + row.id + '-input')).not.toBeNull();
    });
  });

  test('a write failure toasts "Failed: " + err.message', function () {
    mockFetch({ writeReject: true });
    var row = freshRow();
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    return bp._attachWaitlistRecipeForTest(row.id, 'SV-R-000003', 'Cascade Pale Ale', cell).then(function () {
      expect(toastMessages().some(function (m) { return m.indexOf('Failed: ') === 0; })).toBe(true);
    });
  });
});

describe('attached chips', function () {
  test('renders the catalog-resolved NAME with a × carrying aria-label="Remove {name}"', function () {
    bp._setWaitlistRecipeCatalogForTest(CATALOG);
    var row = freshRow({ recipe_ids: 'SV-R-000003' });
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    var chip = cell.querySelector('.bp-batch-chip-inline');
    expect(chip.textContent).toContain('Cascade Pale Ale');
    var removeBtn = chip.querySelector('[data-waitlist-recipe-remove-rid]');
    expect(removeBtn.getAttribute('aria-label')).toBe('Remove Cascade Pale Ale');
  });

  test('falls back to the raw id when the catalog has not resolved it yet', function () {
    var row = freshRow({ recipe_ids: 'SV-R-000003' });
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    expect(cell.querySelector('.bp-batch-chip-inline').textContent).toContain('SV-R-000003');
  });

  test('the "+ Attach recipe" trigger is present on rows of every status, including booked and removed', function () {
    ['waiting', 'contacted', 'booked', 'removed'].forEach(function (status) {
      var row = freshRow({ status: status });
      var panel = renderWithRows([row]);
      var cell = recipesCellFor(panel);
      expect(cell.querySelector('[data-waitlist-recipe-attach-trigger]')).not.toBeNull();
    });
  });

  test('T-80-22: a <script>-bearing catalog recipe name renders escaped, no script element', function () {
    bp._setWaitlistRecipeCatalogForTest([{ recipe_id: 'SV-R-000003', name: '<script>alert(1)</script>Evil' }]);
    var row = freshRow({ recipe_ids: 'SV-R-000003' });
    var panel = renderWithRows([row]);
    var cell = recipesCellFor(panel);
    expect(cell.querySelector('script')).toBeNull();
    expect(cell.querySelector('.bp-batch-chip-inline').textContent).toContain('<script>alert(1)</script>Evil');
    var removeBtn = cell.querySelector('[data-waitlist-recipe-remove-rid]');
    expect(removeBtn.getAttribute('aria-label')).toBe('Remove <script>alert(1)</script>Evil');
  });
});

describe('removing a chip', function () {
  test('tapping × writes the remaining ids immediately, preserving survivor order, with no confirm sheet', function () {
    var row = freshRow({ recipe_ids: 'SV-R-000003|SV-R-000007|SV-R-000009' });
    renderWithRows([row]);
    return bp._removeWaitlistRecipeForTest(row.id, 'SV-R-000007').then(function () {
      var body = postedBodies()[0];
      expect(body).toEqual({ action: 'update_waitlist_status', id: row.id, recipe_ids: 'SV-R-000003|SV-R-000009' });
      expect(toastMessages()).toContain('Recipe removed');
      var sheet = document.getElementById('bp-confirm-sheet');
      expect(sheet === null || !sheet.classList.contains('bp-confirm-sheet--visible')).toBe(true);
    });
  });

  test('removing the last chip writes an empty string and the cell renders "No recipes attached"', function () {
    var row = freshRow({ recipe_ids: 'SV-R-000003' });
    renderWithRows([row]);
    return bp._removeWaitlistRecipeForTest(row.id, 'SV-R-000003').then(function () {
      var body = postedBodies()[0];
      expect(body).toEqual({ action: 'update_waitlist_status', id: row.id, recipe_ids: '' });
      var refreshedPanel = document.getElementById('bp-panel-waitlist');
      var cell = recipesCellFor(refreshedPanel);
      expect(cell.textContent).toContain('No recipes attached');
      expect(cell.querySelectorAll('.bp-batch-chip-inline').length).toBe(0);
    });
  });

  test('remove is available on rows of every status, including booked and removed', function () {
    ['waiting', 'contacted', 'booked', 'removed'].forEach(function (status) {
      var row = freshRow({ status: status, recipe_ids: 'SV-R-000003' });
      var panel = renderWithRows([row]);
      var cell = recipesCellFor(panel);
      expect(cell.querySelector('[data-waitlist-recipe-remove-id]')).not.toBeNull();
    });
  });
});

describe('D-16: display-only, no downstream effect', function () {
  test('waitlistResolveRecipeName never triggers a network call', function () {
    bp._setWaitlistRecipeCatalogForTest(CATALOG);
    expect(bp.waitlistResolveRecipeName('SV-R-000003')).toBe('Cascade Pale Ale');
    expect(bp.waitlistResolveRecipeName('SV-R-999999')).toBe('SV-R-999999');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
