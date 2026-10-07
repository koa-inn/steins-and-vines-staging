'use strict';

// =============================================================================
// Tests: Phase 86 Plan 10 -- admin Vessels tab (D-05..D-08, D-16, D-17)
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

var STALE_MSG = 'This vessel was changed since you opened it — reload to see the latest';
var T1 = '2026-10-07T10:00:00.123Z';

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }

function reply(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(body || {}); }
  });
}

function vessel(over) {
  return Object.assign({
    vessel_id: 'PCB-009', label: 'Big Blue', type: 'Carboy', material: 'PET', capacity_liters: 23,
    status: 'Empty', archived: false, location: 'Shelf A', brand: '', notes: '', updated_at: T1
  }, over || {});
}

function buildDom() {
  document.body.innerHTML =
    '<div id="admin-toast-container"></div>' +
    '<div id="admin-modal" style="display:none"><div id="admin-modal-title"></div><div id="admin-modal-body"></div></div>' +
    '<div class="admin-tabs"><button class="admin-tab-btn" data-tab="vessels"></button></div>' +
    '<div id="tab-vessels" class="admin-tab-panel">' +
    '<input type="checkbox" id="vessels-show-archived"><button id="vessels-add-btn">Add</button>' +
    '<p id="vessels-empty"></p><table><tbody id="vessels-tbody"></tbody></table></div>';
  admin._vesselsTabState.list = [];
  admin._vesselsTabState.showArchived = false;
  admin._vesselsTabState.unavailable = false;
}

var vesselList;
function mock(handlers) {
  global.fetch.mockImplementation(function (url, opts) {
    var method = (opts && opts.method) || 'GET';
    var u = String(url).replace('http://mw.test', '');
    var h = handlers && handlers(u, method, opts);
    if (h) return h;
    if (u === '/api/vessels' && method === 'GET') return reply(200, { ok: true, vessels: vesselList });
    return reply(200, { ok: true });
  });
}
function callsTo(method, pathPrefix) {
  return global.fetch.mock.calls.filter(function (c) {
    return ((c[1] && c[1].method) || 'GET') === method && String(c[0]).indexOf('http://mw.test' + pathPrefix) === 0;
  });
}
function lastToast() {
  var els = document.querySelectorAll('#admin-toast-container .admin-toast');
  return els.length ? els[els.length - 1] : null;
}
function toastText() { var t = lastToast(); return t ? t.querySelector('.admin-toast-msg').textContent : ''; }
function toastBtn() { var t = lastToast(); return t ? t.querySelector('.admin-toast-undo') : null; }
function confirmYes() {
  var btns = document.querySelectorAll('.admin-confirm-box .btn');
  btns[btns.length - 1].click();
}

beforeEach(function () {
  global.fetch.mockReset();
  buildDom();
  vesselList = [vessel(), vessel({ vessel_id: 'PCB-010', label: '', archived: true, updated_at: T1 })];
});

describe('Vessels tab list', function () {
  test('tab click triggers exactly one GET /api/vessels (lazy, one-shot)', function () {
    mock();
    admin._initTabNavigationForTest();
    var btn = document.querySelector('[data-tab="vessels"]');
    btn.click(); btn.click();
    return tick().then(function () {
      expect(callsTo('GET', '/api/vessels').length).toBe(1);
      expect(callsTo('GET', '/api/vessels')[0][1].credentials).toBe('include');
    });
  });

  test('renders rows; archived rows only when shown, with Archived marker and Unarchive', function () {
    mock();
    return admin._initVesselsTabForTest().then(function () {
      var rows = document.querySelectorAll('#vessels-tbody tr');
      expect(rows.length).toBe(1);
      expect(rows[0].textContent).toContain('Big Blue');
      var chk = document.getElementById('vessels-show-archived');
      chk.checked = true;
      chk.dispatchEvent(new Event('change'));
      rows = document.querySelectorAll('#vessels-tbody tr');
      expect(rows.length).toBe(2);
      expect(rows[1].textContent).toContain('Archived');
      expect(rows[1].querySelector('.vessel-unarchive-btn')).not.toBeNull();
      expect(rows[1].querySelector('.vessel-archive-btn')).toBeNull();
    });
  });

  test('503 vessels_editor_requires_postgres shows the empty state, no toast', function () {
    mock(function (u) {
      if (u === '/api/vessels') return reply(503, { error: 'The vessels editor is available once vessels move to the database', code: 'vessels_editor_requires_postgres' });
    });
    return admin._initVesselsTabForTest().then(function () {
      expect(document.getElementById('vessels-empty').textContent).toContain('available once vessels move to the database');
      expect(document.getElementById('vessels-empty').style.display).toBe('');
      expect(lastToast()).toBeNull();
    });
  });

  test('no Delete control anywhere in the panel', function () {
    mock();
    return admin._initVesselsTabForTest().then(function () {
      document.getElementById('vessels-show-archived').checked = true;
      document.getElementById('vessels-show-archived').dispatchEvent(new Event('change'));
      expect(document.getElementById('tab-vessels').textContent).not.toMatch(/Delete/);
    });
  });

  test('hostile label renders as text', function () {
    vesselList = [vessel({ label: '<img src=x onerror=alert(1)>' })];
    mock();
    return admin._initVesselsTabForTest().then(function () {
      expect(document.querySelector('#vessels-tbody img')).toBeNull();
      expect(document.getElementById('vessels-tbody').textContent).toContain('<img src=x onerror=alert(1)>');
    });
  });
});

describe('Vessels add / edit', function () {
  test('prefix pre-fills next id; save POSTs fields; vessel_exists toasts server message', function () {
    mock(function (u, m) {
      if (u.indexOf('/api/vessels/next-id') === 0) return reply(200, { ok: true, vessel_id: 'PCB-013' });
      if (u === '/api/vessels' && m === 'POST') return reply(409, { error: 'Vessel already exists', code: 'vessel_exists' });
    });
    return admin._initVesselsTabForTest().then(function () {
      document.getElementById('vessels-add-btn').click();
      var prefix = document.getElementById('vessel-f-prefix');
      prefix.value = 'PCB';
      prefix.dispatchEvent(new Event('change'));
      return tick();
    }).then(function () {
      expect(callsTo('GET', '/api/vessels/next-id?prefix=PCB').length).toBe(1);
      expect(document.getElementById('vessel-f-id').value).toBe('PCB-013');
      document.getElementById('vessel-f-label').value = 'New';
      document.getElementById('vessel-f-capacity').value = '20';
      document.getElementById('vessel-f-save').click();
      return tick();
    }).then(function () {
      var posts = callsTo('POST', '/api/vessels');
      expect(posts.length).toBe(1);
      var body = JSON.parse(posts[0][1].body);
      expect(body.vessel_id).toBe('PCB-013');
      expect(body.label).toBe('New');
      expect(body.capacity_liters).toBe(20);
      expect(toastText()).toBe('Vessel already exists');
    });
  });

  test('edit: id read-only, PUT carries expected_updated_at and status, no vessel_id', function () {
    mock(function (u, m) { if (m === 'PUT') return reply(200, { ok: true, vessel: vessel() }); });
    return admin._initVesselsTabForTest().then(function () {
      document.querySelector('.vessel-edit-btn').click();
      var idEl = document.getElementById('vessel-f-id');
      expect(idEl.disabled || idEl.readOnly).toBe(true);
      expect(document.getElementById('admin-modal-body').textContent).toContain('Normally set by batches — override only to correct it');
      var opts = Array.prototype.map.call(document.getElementById('vessel-f-status').options, function (o) { return o.value; });
      expect(opts).toEqual(['Empty', 'In-Use']);
      document.getElementById('vessel-f-status').value = 'In-Use';
      document.getElementById('vessel-f-save').click();
      return tick();
    }).then(function () {
      var puts = callsTo('PUT', '/api/vessels/PCB-009');
      expect(puts.length).toBe(1);
      var body = JSON.parse(puts[0][1].body);
      expect(body.expected_updated_at).toBe(T1);
      expect(body.status).toBe('In-Use');
      expect(body.vessel_id).toBeUndefined();
    });
  });

  test('stale_vessel on save shows message with Reload that refetches', function () {
    mock(function (u, m) { if (m === 'PUT') return reply(409, { error: STALE_MSG, code: 'stale_vessel' }); });
    return admin._initVesselsTabForTest().then(function () {
      document.querySelector('.vessel-edit-btn').click();
      document.getElementById('vessel-f-save').click();
      return tick();
    }).then(function () {
      expect(toastText()).toBe(STALE_MSG);
      expect(toastBtn().textContent).toBe('Reload');
      global.fetch.mockClear();
      toastBtn().click();
      expect(callsTo('GET', '/api/vessels').length).toBe(1);
    });
  });
});

describe('Vessels archive', function () {
  test('archive confirms then POSTs expected_updated_at', function () {
    mock(function (u, m) { if (m === 'POST') return reply(200, { ok: true }); });
    return admin._initVesselsTabForTest().then(function () {
      document.querySelector('.vessel-archive-btn').click();
      expect(callsTo('POST', '/api/vessels').length).toBe(0);
      confirmYes();
      return tick();
    }).then(function () {
      var posts = callsTo('POST', '/api/vessels/PCB-009/archive');
      expect(posts.length).toBe(1);
      expect(JSON.parse(posts[0][1].body).expected_updated_at).toBe(T1);
    });
  });

  test('vessel_in_use shows the server message', function () {
    mock(function (u, m) { if (m === 'POST') return reply(409, { error: 'Vessel is in use by batch B-1', code: 'vessel_in_use' }); });
    return admin._initVesselsTabForTest().then(function () {
      document.querySelector('.vessel-archive-btn').click();
      confirmYes();
      return tick();
    }).then(function () {
      expect(toastText()).toBe('Vessel is in use by batch B-1');
    });
  });

  test('stale_vessel on archive shows message with Reload', function () {
    mock(function (u, m) { if (m === 'POST') return reply(409, { error: STALE_MSG, code: 'stale_vessel' }); });
    return admin._initVesselsTabForTest().then(function () {
      document.querySelector('.vessel-archive-btn').click();
      confirmYes();
      return tick();
    }).then(function () {
      expect(toastText()).toBe(STALE_MSG);
      expect(toastBtn().textContent).toBe('Reload');
    });
  });

  test('unarchive posts without confirm', function () {
    mock(function (u, m) { if (m === 'POST') return reply(200, { ok: true }); });
    return admin._initVesselsTabForTest().then(function () {
      document.getElementById('vessels-show-archived').checked = true;
      document.getElementById('vessels-show-archived').dispatchEvent(new Event('change'));
      document.querySelector('.vessel-unarchive-btn').click();
      return tick();
    }).then(function () {
      expect(callsTo('POST', '/api/vessels/PCB-010/unarchive').length).toBe(1);
    });
  });
});

describe('picker label', function () {
  test('buildVesselLabel includes label after the id', function () {
    expect(admin._buildVesselLabelForTest({ vessel_id: 'PCB-009', label: 'Big Blue', type: 'Carboy', capacity_liters: 23 }))
      .toBe('PCB-009 — Big Blue — Carboy — 23L');
    expect(admin._buildVesselLabelForTest({ vessel_id: 'PCB-009', type: 'Carboy', capacity_liters: 23 }))
      .toBe('PCB-009 — Carboy — 23L');
  });

  test('picker search matches the label and escapes it', function () {
    admin._setVesselsDataForTest([
      vessel({ label: 'Big Blue' }),
      vessel({ vessel_id: 'PCB-011', label: '<b>x</b>', status: 'Empty' })
    ]);
    var dd = document.createElement('div');
    var hidden = document.createElement('input');
    var input = document.createElement('input');
    admin._showVesselOptionsForTest('big blue', dd, hidden, input, '');
    expect(dd.querySelectorAll('.admin-kit-search-option').length).toBe(1);
    admin._showVesselOptionsForTest('<b>', dd, hidden, input, '');
    expect(dd.querySelector('b')).toBeNull();
    expect(dd.textContent).toContain('<b>x</b>');
  });
});
