'use strict';

// Minimal global stubs for admin.js IIFE to load without errors.
// admin.js relies on DOM, SHEETS_CONFIG, google auth, etc.
// Copied verbatim from tests/frontend/admin-beerxml.test.js:1-99 (see that file's
// own comment: jest-environment-jsdom ignores the global.document/global.window
// reassignments below -- the real jsdom document/window win. Kept for parity
// with the established fixture pattern; harmless dead assignments here.)

var mockElements = {};
function createMockElement() {
  return {
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    setAttribute: jest.fn(),
    getAttribute: jest.fn(function () { return null; }),
    addEventListener: jest.fn(),
    querySelector: jest.fn(function () { return null; }),
    querySelectorAll: jest.fn(function () { return []; }),
    appendChild: jest.fn(),
    closest: jest.fn(function () { return null; }),
    remove: jest.fn(),
    classList: { add: jest.fn(), remove: jest.fn(), contains: jest.fn() },
    parentNode: { querySelector: jest.fn(function () { return null; }), appendChild: jest.fn() },
    focus: jest.fn()
  };
}

global.document = {
  getElementById: jest.fn(function (id) {
    if (!mockElements[id]) mockElements[id] = createMockElement();
    return mockElements[id];
  }),
  querySelectorAll: jest.fn(function () { return []; }),
  querySelector: jest.fn(function () { return null; }),
  addEventListener: jest.fn(),
  createElement: jest.fn(function () { return createMockElement(); }),
  body: { appendChild: jest.fn() }
};

global.window = {
  confirm: jest.fn(function () { return true; }),
  location: { search: '', pathname: '/admin.html', href: '' },
  addEventListener: jest.fn(),
  matchMedia: jest.fn(function () { return { matches: false, addEventListener: jest.fn() }; })
};

global.navigator = { userAgent: 'test' };
global.localStorage = {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.sessionStorage = {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.console = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
};
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
});
global.setTimeout = jest.fn(function (fn) { if (typeof fn === 'function') fn(); return 1; });
global.clearTimeout = jest.fn();
global.setInterval = jest.fn(function () { return 1; });
global.clearInterval = jest.fn();
global.alert = jest.fn();
global.Image = jest.fn(function () { return {}; });
global.URLSearchParams = function (s) {
  this.get = function () { return null; };
  this.has = function () { return false; };
};
global.MutationObserver = jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn() };
});
global.IntersectionObserver = jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn(), unobserve: jest.fn() };
});

// Google Identity stubs
global.google = { accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } } };

// SHEETS_CONFIG stub (normally from js/sheets-config.js)
global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://localhost:3001',
  MW_API_KEY: 'test-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};

// Load admin.js (the IIFE will run and export via module.exports)
var admin = require('../../js/admin.js');

// ---------------------------------------------------------------------------
// DOM fixture — real jsdom document (see comment above: the global.document
// reassignment is inert under jest-environment-jsdom). Provides exactly the
// admin-modal ids that openEditScheduleModal -> renderScheduleForm -> openModal
// read/write, plus the toast container and the #recipes-status-filter select
// that ensureRecipeListForBlastRadius's status resolution reads (GAP-01).
// ---------------------------------------------------------------------------
function resetAdminDomFixture() {
  document.body.innerHTML =
    '<div id="admin-modal" style="display:none">' +
    '  <div class="admin-modal-content">' +
    '    <button id="admin-modal-close"></button>' +
    '    <h2 id="admin-modal-title"></h2>' +
    '    <div id="admin-modal-body"></div>' +
    '  </div>' +
    '</div>' +
    '<div id="admin-modal-overlay"></div>' +
    '<div id="admin-toast-container"></div>' +
    '<select id="recipes-status-filter"><option value="all" selected>all</option></select>';
}

// global.setTimeout is stubbed synchronously above, so a real timer-based
// flush would never yield to microtasks. Flush the microtask queue instead.
function flush() {
  return new Promise(function (resolve) { process.nextTick(resolve); });
}

var FS_0010 = { schedule_id: 'FS-0010', name: 'Basic Ale, No Dry Hop', description: '', category: 'beer', steps_parsed: [{ step_number: 1, day_offset: 0, title: 'Pitch yeast', description: '' }] };
var FS_0008 = { schedule_id: 'FS-0008', name: 'Standard Lager', description: '', category: 'beer', steps_parsed: [{ step_number: 1, day_offset: 0, title: 'Pitch yeast', description: '' }] };
var FS_0009 = { schedule_id: 'FS-0009', name: 'Unused Template', description: '', category: 'beer', steps_parsed: [{ step_number: 1, day_offset: 0, title: 'Pitch yeast', description: '' }] };

var THREE_RECIPES = [
  { recipe_id: 'SV-R-000011', schedule_id: 'FS-0010' },
  { recipe_id: 'SV-R-000003', schedule_id: 'FS-0010' },
  { recipe_id: 'SV-R-000002', schedule_id: 'FS-0008' }
];

describe('D-15 blast-radius note load-order regression (GAP-01)', function () {
  beforeEach(function () {
    resetAdminDomFixture();
    admin._recipesState.list = [];
    admin._setFermSchedulesDataForTest([FS_0010, FS_0008, FS_0009]);
    global.fetch = jest.fn(function () {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ recipes: THREE_RECIPES, total: THREE_RECIPES.length }); } });
    });
  });

  test('REGRESSION — Recipes tab never opened: the note still renders the count on the direct Batches -> Schedule Templates path', function () {
    admin.openEditScheduleModal('FS-0010');
    return flush().then(flush).then(function () {
      var body = document.getElementById('admin-modal-body');
      expect(body.textContent).toContain('Used by 2 public recipes');
      expect(global.fetch).toHaveBeenCalled();
      var calledUrl = global.fetch.mock.calls[0][0];
      expect(calledUrl).toEqual(expect.stringContaining('/api/recipes?status='));
    });
  });

  test('Singular — a template used by exactly one recipe reads "1 public recipe" with no trailing s', function () {
    admin.openEditScheduleModal('FS-0008');
    return flush().then(flush).then(function () {
      var body = document.getElementById('admin-modal-body');
      expect(body.textContent).toContain('Used by 1 public recipe');
      expect(body.textContent).not.toContain('1 public recipes');
    });
  });

  test('Zero-attached template renders no note', function () {
    admin.openEditScheduleModal('FS-0009');
    return flush().then(flush).then(function () {
      var body = document.getElementById('admin-modal-body');
      expect(body.textContent).not.toContain('Used by');
    });
  });

  test('Idempotence — a list already populated (Recipes tab visited first) issues no fetch', function () {
    admin._recipesState.list = THREE_RECIPES;
    admin.openEditScheduleModal('FS-0010');
    return flush().then(flush).then(function () {
      var body = document.getElementById('admin-modal-body');
      expect(body.textContent).toContain('Used by 2 public recipes');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  test('Non-fatal — the modal still opens when the recipe fetch fails', function () {
    global.fetch = jest.fn(function () { return Promise.reject(new Error('network down')); });
    admin.openEditScheduleModal('FS-0010');
    return flush().then(flush).then(function () {
      var title = document.getElementById('admin-modal-title');
      var body = document.getElementById('admin-modal-body');
      expect(title.textContent).toBe('Edit Schedule Template');
      expect(body.innerHTML.length).toBeGreaterThan(0);
      expect(body.textContent).not.toContain('Used by');
    });
  });
});
