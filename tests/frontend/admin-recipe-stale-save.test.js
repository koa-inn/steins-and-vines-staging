'use strict';

// =============================================================================
// Tests: Phase 85 Plan 09 -- admin D-03 stale-save UX.
//   - recipe editor (saveRecipe / deleteRecipe) sends expected_updated_at
//   - kiosk quick-edit (kioskSaveRecipeQuickEdit) sends the form-open token and
//     refreshes it after each successful save
//   - 409 stale_recipe -> D-03 message + Reload, nothing overwritten
// =============================================================================

global.window = global.window || {};
global.window.confirm = jest.fn(function () { return true; });
global.window.addEventListener = global.window.addEventListener || jest.fn();
global.navigator = global.navigator || { userAgent: 'test' };
global.localStorage = global.localStorage || {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.sessionStorage = global.sessionStorage || {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
global.fetch = jest.fn();
global.alert = jest.fn();
global.Image = global.Image || jest.fn(function () { return {}; });
global.MutationObserver = global.MutationObserver || jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn() };
});
global.IntersectionObserver = global.IntersectionObserver || jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn(), unobserve: jest.fn() };
});
global.google = {
  accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } }
};
global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://mw.test',
  MW_API_KEY: 'test-api-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};

var admin = require('../../js/admin.js');

var TOKEN = '2026-10-07T10:00:00.123Z';
var TOKEN2 = '2026-10-07T10:05:00.456Z';
var TOKEN3 = '2026-10-07T10:09:00.789Z';
var STALE_MSG = 'This recipe was changed since you opened it — reload to see the latest';

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }

function el(id, tag, parent) {
  var e = document.createElement(tag || 'div');
  e.id = id;
  (parent || document.body).appendChild(e);
  return e;
}

function buildDom() {
  document.body.innerHTML = '';
  el('admin-toast-container');
  ['recipe-name', 'recipe-style', 'recipe-description', 'recipe-batch-size', 'recipe-abv', 'recipe-ibu',
    'recipe-colour', 'recipe-locked-price', 'recipe-service-fee', 'recipe-materials-fee'].forEach(function (id) {
    el(id, 'input');
  });
  el('recipe-schedule-select', 'select');
  el('recipe-pricing-mode', 'input').value = 'locked';
  el('recipe-status', 'input').value = 'draft';
  el('recipe-status-error', 'span');
  el('recipes-save-btn', 'button');
  ['recipes-list-view', 'recipes-detail-view', 'recipes-detail-title', 'recipes-delete-btn', 'recipes-duplicate-btn'].forEach(function (id) {
    el(id);
  });
  document.getElementById('recipe-name').value = 'Test IPA';
  el('kiosk-recipe-selected-name', 'span');
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
    return handler(String(url), method, opts) || reply(200, { ok: true, recipes: [], recipe: {}, ingredients: [] });
  });
}

function calls(method) {
  return global.fetch.mock.calls.filter(function (c) {
    return ((c[1] && c[1].method) || 'GET') === method && String(c[0]).indexOf('/api/recipes/RCP-1') !== -1;
  });
}

function lastToast() {
  var els = document.querySelectorAll('#admin-toast-container .admin-toast');
  return els.length ? els[els.length - 1] : null;
}
function toastText() { var t = lastToast(); return t ? t.querySelector('.admin-toast-msg').textContent : ''; }
function toastBtn() { var t = lastToast(); return t ? t.querySelector('.admin-toast-undo') : null; }

beforeEach(function () {
  global.fetch.mockReset();
  buildDom();
  admin._recipesState.currentRecipeId = 'RCP-1';
  admin._recipesState.currentRecipe = { recipe_id: 'RCP-1', name: 'Test IPA', updated_at: TOKEN };
  admin._recipesState.currentIngredients = [];
});

describe('admin editor: saveRecipe', function () {
  test('PUT carries expected_updated_at for an existing recipe', function () {
    mockFetch(function (url, method) { if (method === 'PUT') return reply(200, { ok: true }); });
    admin._recipesSaveForTest();
    return tick().then(function () {
      var puts = calls('PUT');
      expect(puts.length).toBe(1);
      expect(JSON.parse(puts[0][1].body).expected_updated_at).toBe(TOKEN);
    });
  });

  test('POST (new recipe) has no expected_updated_at', function () {
    admin._recipesState.currentRecipeId = null;
    mockFetch(function (url, method) { if (method === 'POST') return reply(200, { ok: true, recipe_id: 'RCP-9' }); });
    admin._recipesSaveForTest();
    return tick().then(function () {
      var posts = global.fetch.mock.calls.filter(function (c) { return c[1] && c[1].method === 'POST'; });
      expect(posts.length).toBe(1);
      expect(JSON.parse(posts[0][1].body).expected_updated_at).toBeUndefined();
    });
  });

  test('409 stale_recipe shows the D-03 message with Reload; Reload re-opens the recipe', function () {
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(409, { error: STALE_MSG, code: 'stale_recipe' });
    });
    admin._recipesSaveForTest();
    return tick().then(function () {
      expect(toastText()).toBe(STALE_MSG);
      expect(toastText()).not.toBe('Could not save recipe. Please try again.');
      expect(toastBtn().textContent).toBe('Reload');
      global.fetch.mockClear();
      toastBtn().click();
      var gets = calls('GET').filter(function (c) { return String(c[0]).indexOf('availability') === -1; });
      expect(gets.length).toBe(1);
    });
  });

  test('422 keeps the generic toast', function () {
    mockFetch(function (url, method) { if (method === 'PUT') return reply(422, { ok: false, error: 'bad', code: 'save_failed' }); });
    admin._recipesSaveForTest();
    return tick().then(function () {
      expect(toastText()).toBe('Could not save recipe. Please try again.');
      expect(toastBtn()).toBeNull();
    });
  });

  test('network error keeps the generic toast', function () {
    global.fetch.mockImplementation(function () { return Promise.reject(new Error('net')); });
    admin._recipesSaveForTest();
    return tick().then(function () {
      expect(toastText()).toBe('Could not save recipe. Please try again.');
    });
  });
});

describe('admin editor: deleteRecipe', function () {
  test('URL carries the encoded token', function () {
    mockFetch(function (url, method) { if (method === 'DELETE') return reply(200, { ok: true }); });
    admin._recipesDeleteForTest();
    return tick().then(function () {
      var dels = calls('DELETE');
      expect(dels.length).toBe(1);
      expect(dels[0][0]).toBe('http://mw.test/api/recipes/RCP-1?expected_updated_at=' + encodeURIComponent(TOKEN));
    });
  });

  test('no query string when the recipe has no updated_at', function () {
    admin._recipesState.currentRecipe = { recipe_id: 'RCP-1', name: 'Test IPA' };
    mockFetch(function (url, method) { if (method === 'DELETE') return reply(200, { ok: true }); });
    admin._recipesDeleteForTest();
    return tick().then(function () {
      expect(calls('DELETE')[0][0]).toBe('http://mw.test/api/recipes/RCP-1');
    });
  });

  test('409 stale_recipe shows D-03 message + Reload and does not reload the list', function () {
    mockFetch(function (url, method) {
      if (method === 'DELETE') return reply(409, { error: STALE_MSG, code: 'stale_recipe' });
    });
    admin._recipesDeleteForTest();
    return tick().then(function () {
      expect(toastText()).toBe(STALE_MSG);
      expect(toastBtn().textContent).toBe('Reload');
      var listCalls = global.fetch.mock.calls.filter(function (c) {
        return /\/api\/recipes\?/.test(String(c[0]));
      });
      expect(listCalls.length).toBe(0);
    });
  });
});

describe('admin toast', function () {
  test('toast without actionLabel has no action button', function () {
    admin._recipesState.currentRecipe = null;
    document.getElementById('recipe-name').value = '';
    admin._recipesSaveForTest(); // "Recipe name is required." warning
    expect(toastText()).toBe('Recipe name is required.');
    expect(toastBtn()).toBeNull();
  });
});

describe('kiosk quick-edit', function () {
  function buildQuickEdit(recipe) {
    var wrap = el('kiosk-recipe-quick-edit-wrap');
    var qeBtn = el('kiosk-recipe-quick-edit-btn', 'button');
    el('kqe-name', 'input', wrap).value = 'New Name';
    el('kqe-notes', 'textarea', wrap).value = 'notes';
    el('kqe-price', 'input', wrap).value = '30';
    var sel = el('kqe-status', 'select', wrap);
    sel.innerHTML = '<option value="draft">d</option><option value="active">a</option>';
    sel.value = 'active';
    el('kqe-save', 'button', wrap);
    return { wrap: wrap, qeBtn: qeBtn, recipe: recipe };
  }

  function detail(token, name) {
    return { ok: true, recipe: { recipe_id: 'RCP-1', name: name || 'New Name', notes: 'notes', locked_price: 30, status: 'active', updated_at: token } };
  }

  test('PUT carries name/notes/locked_price/status plus the form-open token', function () {
    var recipe = { recipe_id: 'RCP-1', name: 'Old', updated_at: TOKEN };
    var q = buildQuickEdit(recipe);
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(200, { ok: true });
      return reply(200, detail(TOKEN2));
    });
    admin.kioskSaveRecipeQuickEdit(recipe, q.wrap, q.qeBtn, TOKEN);
    return tick().then(function () {
      var body = JSON.parse(calls('PUT')[0][1].body);
      expect(body).toEqual({ name: 'New Name', notes: 'notes', locked_price: 30, status: 'active', expected_updated_at: TOKEN });
      expect(recipe.updated_at).toBe(TOKEN2);
      expect(recipe._fetchedDetail).toBeTruthy();
    });
  });

  test('two consecutive saves: second PUT carries the refreshed token', function () {
    var recipe = { recipe_id: 'RCP-1', name: 'Old', updated_at: TOKEN };
    var q = buildQuickEdit(recipe);
    var detailTokens = [TOKEN2, TOKEN3];
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(200, { ok: true });
      return reply(200, detail(detailTokens.shift()));
    });
    admin.kioskSaveRecipeQuickEdit(recipe, q.wrap, q.qeBtn, TOKEN);
    return tick().then(function () {
      var q2 = buildQuickEdit(recipe);
      admin.kioskSaveRecipeQuickEdit(recipe, q2.wrap, q2.qeBtn, recipe.updated_at);
      return tick();
    }).then(function () {
      var puts = calls('PUT');
      expect(puts.length).toBe(2);
      expect(JSON.parse(puts[1][1].body).expected_updated_at).toBe(TOKEN2);
      expect(recipe.updated_at).toBe(TOKEN3);
    });
  });

  test('refresh GET failure after success shows no error toast and keeps the old token', function () {
    var recipe = { recipe_id: 'RCP-1', name: 'Old', updated_at: TOKEN };
    var q = buildQuickEdit(recipe);
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(200, { ok: true });
      return Promise.reject(new Error('net'));
    });
    admin.kioskSaveRecipeQuickEdit(recipe, q.wrap, q.qeBtn, TOKEN);
    return tick().then(function () {
      expect(toastText()).toBe('Recipe updated.');
      expect(recipe.updated_at).toBe(TOKEN);
    });
  });

  test('409 stale_recipe: D-03 toast with Reload, no local change; Reload refreshes and closes the form', function () {
    var recipe = { recipe_id: 'RCP-1', name: 'Old', notes: 'o', locked_price: 10, status: 'draft', updated_at: TOKEN };
    var q = buildQuickEdit(recipe);
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(409, { error: STALE_MSG, code: 'stale_recipe' });
      return reply(200, detail(TOKEN2, 'Server Name'));
    });
    admin.kioskSaveRecipeQuickEdit(recipe, q.wrap, q.qeBtn, TOKEN);
    return tick().then(function () {
      expect(toastText()).toBe(STALE_MSG);
      expect(toastBtn().textContent).toBe('Reload');
      expect(recipe.name).toBe('Old');
      expect(recipe.status).toBe('draft');
      q.qeBtn.style.display = 'none';
      toastBtn().click();
      return tick();
    }).then(function () {
      expect(recipe.name).toBe('Server Name');
      expect(recipe.status).toBe('active');
      expect(recipe.updated_at).toBe(TOKEN2);
      expect(document.getElementById('kiosk-recipe-selected-name').textContent).toBe('Server Name');
      expect(q.wrap.innerHTML).toBe('');
      expect(q.qeBtn.style.display).toBe('');
    });
  });

  test('no token at form-open: PUT omits the key; 409 -> Reload fetches the token; next save succeeds', function () {
    var recipe = { recipe_id: 'RCP-1', name: 'Old' };
    var q = buildQuickEdit(recipe);
    var putCount = 0;
    mockFetch(function (url, method) {
      if (method === 'PUT') {
        putCount++;
        return putCount === 1 ? reply(409, { error: STALE_MSG, code: 'stale_recipe' }) : reply(200, { ok: true });
      }
      return reply(200, detail(TOKEN2));
    });
    admin.kioskSaveRecipeQuickEdit(recipe, q.wrap, q.qeBtn, '');
    return tick().then(function () {
      expect(JSON.parse(calls('PUT')[0][1].body).expected_updated_at).toBeUndefined();
      toastBtn().click();
      return tick();
    }).then(function () {
      expect(recipe.updated_at).toBe(TOKEN2);
      var q2 = buildQuickEdit(recipe);
      admin.kioskSaveRecipeQuickEdit(recipe, q2.wrap, q2.qeBtn, recipe.updated_at);
      return tick();
    }).then(function () {
      expect(JSON.parse(calls('PUT')[1][1].body).expected_updated_at).toBe(TOKEN2);
    });
  });

  test('422 keeps the generic failure toast and re-enables Save', function () {
    var recipe = { recipe_id: 'RCP-1', name: 'Old', updated_at: TOKEN };
    var q = buildQuickEdit(recipe);
    mockFetch(function (url, method) {
      if (method === 'PUT') return reply(422, { ok: false, error: 'Nope', code: 'save_failed' });
    });
    admin.kioskSaveRecipeQuickEdit(recipe, q.wrap, q.qeBtn, TOKEN);
    return tick().then(function () {
      expect(toastText()).toBe('Could not update recipe: Nope');
      expect(document.getElementById('kqe-save').disabled).toBe(false);
    });
  });
});
