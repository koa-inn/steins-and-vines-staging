'use strict';

// =============================================================================
// Tests: Phase 86 Plan 10 -- owner-only Staff Access tab (D-02, D-03)
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

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }

function reply(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(body || {}); }
  });
}

function buildDom() {
  document.body.innerHTML =
    '<div id="admin-toast-container"></div>' +
    '<div id="admin-modal" style="display:none"><div id="admin-modal-title"></div><div id="admin-modal-body"></div></div>' +
    '<div class="admin-tabs"><button class="admin-tab-btn" data-tab="staff-access" style="display:none"></button></div>' +
    '<div id="tab-staff-access" class="admin-tab-panel">' +
    '<button id="staff-access-add-btn">Add</button>' +
    '<table><tbody id="staff-access-tbody"></tbody></table>' +
    '<table><tbody id="staff-access-audit-tbody"></tbody></table></div>';
}

var listBody;
function mock(handlers) {
  global.fetch.mockImplementation(function (url, opts) {
    var method = (opts && opts.method) || 'GET';
    var u = String(url).replace('http://mw.test', '');
    var h = handlers && handlers(u, method, opts);
    if (h) return h;
    if (u === '/api/staff-access' && method === 'GET') return reply(200, listBody);
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
function confirmYes() {
  var btns = document.querySelectorAll('.admin-confirm-box .btn');
  btns[btns.length - 1].click();
}
function tabBtn() { return document.querySelector('[data-tab="staff-access"]'); }

beforeEach(function () {
  global.fetch.mockReset();
  buildDom();
  listBody = {
    ok: true,
    staff: [
      { email: 'a@x.ca', role: 'staff', added_by: 'o@x.ca', added_at: '2026-10-01', break_glass: false },
      { email: 'bg@x.ca', role: 'owner', added_by: '', added_at: '', break_glass: true }
    ],
    break_glass_only: ['env@x.ca'],
    audit: [{ occurred_at: '2026-10-02', actor_email: 'o@x.ca', target_email: '<i>t</i>', action: 'add', role_before: null, role_after: 'staff' }]
  };
});

describe('Staff Access visibility', function () {
  test('role staff -> hidden, no further staff-access request', function () {
    mock(function (u) { if (u === '/api/staff-access/me') return reply(200, { email: 'a@x.ca', role: 'staff', break_glass: false, store: 'dual' }); });
    return admin._checkStaffAccessVisibilityForTest().then(function () {
      expect(tabBtn().style.display).toBe('none');
      expect(global.fetch.mock.calls.length).toBe(1);
    });
  });

  test('owner on sheets store -> hidden; owner on dual -> visible', function () {
    mock(function (u) { if (u === '/api/staff-access/me') return reply(200, { role: 'owner', store: 'sheets' }); });
    return admin._checkStaffAccessVisibilityForTest().then(function () {
      expect(tabBtn().style.display).toBe('none');
      mock(function (u) { if (u === '/api/staff-access/me') return reply(200, { role: 'owner', store: 'dual' }); });
      return admin._checkStaffAccessVisibilityForTest();
    }).then(function () {
      expect(tabBtn().style.display).toBe('');
    });
  });
});

describe('Staff Access list', function () {
  test('lists staff, break-glass read-only chip, escaped audit', function () {
    mock();
    return admin._initStaffAccessTabForTest().then(function () {
      var rows = document.querySelectorAll('#staff-access-tbody tr');
      expect(rows.length).toBe(3);
      expect(rows[0].querySelector('.staff-remove-btn')).not.toBeNull();
      expect(rows[1].textContent).toContain('Break-glass (Railway)');
      expect(rows[1].querySelector('button')).toBeNull();
      expect(rows[2].textContent).toContain('env@x.ca');
      expect(rows[2].querySelector('button')).toBeNull();
      var audit = document.getElementById('staff-access-audit-tbody');
      expect(audit.querySelector('i')).toBeNull();
      expect(audit.textContent).toContain('<i>t</i>');
      expect(audit.textContent).toContain('add');
    });
  });

  test('add posts {email, role} and reloads; staff_exists shows message', function () {
    var exists = false;
    mock(function (u, m) {
      if (u === '/api/staff-access' && m === 'POST') {
        return exists ? reply(409, { error: 'Already a staff member', code: 'staff_exists' }) : reply(201, { ok: true });
      }
    });
    return admin._initStaffAccessTabForTest().then(function () {
      document.getElementById('staff-access-add-btn').click();
      document.getElementById('staff-f-email').value = 'n@x.ca';
      document.getElementById('staff-f-role').value = 'owner';
      document.getElementById('staff-f-save').click();
      return tick();
    }).then(function () {
      var posts = callsTo('POST', '/api/staff-access');
      expect(posts.length).toBe(1);
      expect(JSON.parse(posts[0][1].body)).toEqual({ email: 'n@x.ca', role: 'owner' });
      expect(callsTo('GET', '/api/staff-access').length).toBe(2);
      exists = true;
      document.getElementById('staff-access-add-btn').click();
      document.getElementById('staff-f-email').value = 'a@x.ca';
      document.getElementById('staff-f-save').click();
      return tick();
    }).then(function () {
      expect(toastText()).toBe('Already a staff member');
    });
  });

  test('change role PUTs; last_owner / cannot_change_own_role toast the server message', function () {
    mock(function (u, m) {
      if (m === 'PUT') return reply(409, { error: 'Cannot demote the last owner', code: 'last_owner' });
    });
    return admin._initStaffAccessTabForTest().then(function () {
      document.querySelector('.staff-role-btn').click();
      confirmYes();
      return tick();
    }).then(function () {
      var puts = callsTo('PUT', '/api/staff-access/a%40x.ca');
      expect(puts.length).toBe(1);
      expect(JSON.parse(puts[0][1].body)).toEqual({ role: 'owner' });
      expect(toastText()).toBe('Cannot demote the last owner');
      mock(function (u, m) {
        if (m === 'PUT') return reply(409, { error: 'You cannot change your own role', code: 'cannot_change_own_role' });
      });
      document.querySelector('.staff-role-btn').click();
      confirmYes();
      return tick();
    }).then(function () {
      expect(toastText()).toBe('You cannot change your own role');
    });
  });

  test('remove confirms naming the email, then DELETEs; cannot_remove_self toasts', function () {
    mock(function (u, m) {
      if (m === 'DELETE') return reply(409, { error: 'You cannot remove yourself', code: 'cannot_remove_self' });
    });
    return admin._initStaffAccessTabForTest().then(function () {
      document.querySelector('.staff-remove-btn').click();
      var msg = document.querySelector('.admin-confirm-msg').textContent;
      expect(msg).toContain('a@x.ca');
      expect(msg).toContain('sessions end immediately');
      expect(callsTo('DELETE', '/api/staff-access').length).toBe(0);
      confirmYes();
      return tick();
    }).then(function () {
      expect(callsTo('DELETE', '/api/staff-access/a%40x.ca').length).toBe(1);
      expect(toastText()).toBe('You cannot remove yourself');
    });
  });

  test('403 owner_required hides the tab and shows the owners-only message', function () {
    tabBtn().style.display = '';
    mock(function (u, m) {
      if (u === '/api/staff-access' && m === 'GET') return reply(403, { error: 'Owner required', code: 'owner_required' });
    });
    return admin._initStaffAccessTabForTest().then(function () {
      expect(tabBtn().style.display).toBe('none');
      expect(toastText()).toBe('Only owners can manage staff access');
    });
  });
});
