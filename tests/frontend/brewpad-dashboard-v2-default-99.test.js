'use strict';

// Phase 99-09: v2 is the default dashboard (D-01), one-time per-device migration (D-03),
// remembered Classic fallback, and the cached-first hydrate interaction.

global.google = { accounts: { oauth2: { initTokenClient: jest.fn(), revoke: jest.fn() } } };
global.SHEETS_CONFIG = { MIDDLEWARE_URL: 'http://mw.test' };
// Network never answers: the tests only look at the synchronous first paint.
global.fetch = jest.fn(function () { return new Promise(function () {}); });
var _ssData = {};
global.sessionStorage = {
  getItem: function (k) { return _ssData[k] !== undefined ? _ssData[k] : null; },
  setItem: function (k, v) { _ssData[k] = v; },
  removeItem: function (k) { delete _ssData[k]; },
  clear: function () { _ssData = {}; }
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

var KEY = 'bp_dash_cache_v1';
var EMAIL = 'staff@example.ca';
var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var YEAR = +TODAY.slice(0, 4);
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };

function ls(k) { return window.localStorage.getItem(k); }
function setUrl(search, hash) {
  window.history.replaceState(null, '', '/brewpad.html' + (search || '') + (hash || ''));
}

function lean(id, type) {
  return {
    batch_id: id, status: 'primary', batch_type: type, batch_type_source: 'recipe',
    start_date: YEAR + '-01-05', completed_day: null, completed_at: null, completed_at_source: null,
    vessel_id: null, source: 'kiosk', product_sku: '', product_name: id, product_subcategory: '',
    product_brand: '', product_manufacturer: '', recipe_id: '', schedule_id: '',
    schedule_category: '', target_volume_l: 20, tasks_total: 0, tasks_done: 0
  };
}
var DATA = { asOf: ASOF, batches: [lean('W1', 'wine')], staffBatchIds: [], batchMeta: [], inviteSentIds: [] };

function mount() {
  document.body.innerHTML =
    '<div id="bp-signin"></div><div id="bp-app"></div>' +
    '<div class="bp-dash-switch-row"><p id="bp-dash-asof" class="bp-dash-asof" role="status" aria-live="polite" hidden></p>' +
    '<button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div><div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  bp._setStateForTest({ _allBatchesData: [], _dashData: DATA, _dashSummary: {}, _dashWineSkuLookup: {} });
}

function isV2() { return document.getElementById('bp-dash-v2') !== null; }
function render() { bp._renderDashboardForTest(); }

beforeEach(function () {
  window.localStorage.clear();
  setUrl('', '');
  window.matchMedia = function () { return { matches: false, addEventListener: function () {}, removeEventListener: function () {} }; };
  window.Chart = function () {};
  mount();
});

describe('default-on v2', function () {
  test('empty storage and no URL flag renders v2 and records flag + marker', function () {
    bp._initDashV2FlagForTest();
    render();
    expect(isV2()).toBe(true);
    expect(ls('bp_dash_v2')).toBe('1');
    expect(ls('bp_dash_default_v2')).toBe('1');
    expect(document.getElementById('bp-dash-switch').textContent).toBe('Classic dashboard');
  });

  test('stored bp_dash_v2=0 without marker is moved to v2 once', function () {
    window.localStorage.setItem('bp_dash_v2', '0');
    bp._initDashV2FlagForTest();
    render();
    expect(isV2()).toBe(true);
    expect(ls('bp_dash_v2')).toBe('1');
    expect(ls('bp_dash_default_v2')).toBe('1');
  });

  test('after migration, choosing Classic is remembered across re-init', function () {
    window.localStorage.setItem('bp_dash_v2', '0');
    bp._initDashV2FlagForTest();
    render();
    document.getElementById('bp-dash-switch').click();
    expect(ls('bp_dash_v2')).toBe('0');
    expect(isV2()).toBe(false);
    expect(document.getElementById('bp-dash-switch').textContent).toBe('Try new dashboard');
    bp._initDashV2FlagForTest();
    render();
    expect(isV2()).toBe(false);
    expect(ls('bp_dash_v2')).toBe('0');
  });
});

describe('explicit URL values', function () {
  test('?dash=classic opens Classic, remembers it and strips the URL', function () {
    setUrl('?dash=classic', '');
    bp._initDashV2FlagForTest();
    render();
    expect(isV2()).toBe(false);
    expect(ls('bp_dash_v2')).toBe('0');
    expect(ls('bp_dash_default_v2')).toBe('1');
    expect(window.location.search).not.toContain('dash=');
  });

  test('#dash=classic opens Classic and remembers it', function () {
    setUrl('', '#dash=classic');
    bp._initDashV2FlagForTest();
    render();
    expect(isV2()).toBe(false);
    expect(ls('bp_dash_v2')).toBe('0');
    expect(ls('bp_dash_default_v2')).toBe('1');
    expect(window.location.hash).not.toContain('dash=');
  });

  test('?dash=v1 opens Classic; ?dash=v2 opens v2', function () {
    setUrl('?dash=v1', '');
    bp._initDashV2FlagForTest();
    render();
    expect(isV2()).toBe(false);
    setUrl('?dash=v2', '');
    bp._initDashV2FlagForTest();
    render();
    expect(isV2()).toBe(true);
    expect(ls('bp_dash_v2')).toBe('1');
  });
});

describe('storage failures', function () {
  test('throwing localStorage still renders v2 without throwing', function () {
    var g = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(function () { throw new Error('denied'); });
    var s = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function () { throw new Error('denied'); });
    try {
      expect(function () { bp._initDashV2FlagForTest(); render(); }).not.toThrow();
      expect(isV2()).toBe(true);
    } finally {
      g.mockRestore();
      s.mockRestore();
    }
  });
});

describe('cached-first hydrate follows the flag', function () {
  function seedCache() {
    window.localStorage.setItem('sv-brewpad-session', JSON.stringify({
      token: 't', expires_at: Date.now() + 3600000, email: EMAIL, login_at: Date.now()
    }));
    window.localStorage.setItem(KEY, JSON.stringify({
      v: 1, day: TODAY, savedAt: Date.now() - 60000, email: EMAIL,
      dashData: DATA, fermSchedules: [], upcomingTasks: []
    }));
  }

  test('a default-v2 device with no stored flag gets the cached v2 render on first load', function () {
    seedCache();
    bp._initDashV2FlagForTest();
    bp._eagerLoadForTest();
    expect(isV2()).toBe(true);
    expect(document.getElementById('bp-dash-asof').textContent).toMatch(/^As of .+ · Updating…$/);
  });

  test('a Classic device never gets a v2 cached render', function () {
    window.localStorage.setItem('bp_dash_default_v2', '1');
    window.localStorage.setItem('bp_dash_v2', '0');
    seedCache();
    bp._initDashV2FlagForTest();
    bp._eagerLoadForTest();
    expect(isV2()).toBe(false);
  });
});
