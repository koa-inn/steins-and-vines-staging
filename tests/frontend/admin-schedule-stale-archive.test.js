'use strict';

// =============================================================================
// Tests: Phase 86 Plan 04 -- admin schedule editor D-15 / D-16.
//   - handleProxyResponse sets err.code / err.status (additive)
//   - update/delete/archive carry expected_updated_at (the schedule's last_updated)
//   - 409 stale_schedule -> D-16 message + Reload, nothing else posted
//   - 409 schedule_in_use -> server message + "Archive instead"
//   - card shows Archive + Delete; old soft Delete wording gone
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
var STALE_MSG = 'This schedule was changed since you opened it — reload to see the latest';
var IN_USE_MSG = 'This schedule is used by 2 recipe(s) and 1 batch(es). Archive it instead.';

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }

function sched(id, lastUpdated) {
  return {
    schedule_id: id, name: 'Basic Ale', description: '', category: 'beer', last_updated: lastUpdated,
    steps_parsed: [
      { step_number: 1, day_offset: 0, title: 'Pitch yeast', description: '' },
      { step_number: 2, day_offset: -1, title: 'Bottling', description: '', is_packaging: true }
    ]
  };
}

function resp(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(body); } });
}

function posted() {
  return global.fetch.mock.calls.map(function (c) { return JSON.parse(c[1].body); });
}

function resetDom() {
  document.body.innerHTML =
    '<div id="admin-modal" style="display:none"><div class="admin-modal-content">' +
    '<button id="admin-modal-close"></button><h2 id="admin-modal-title"></h2><div id="admin-modal-body"></div></div></div>' +
    '<div id="admin-modal-overlay"></div><div id="admin-toast-container"></div>' +
    '<div id="schedules-list"></div><div id="schedules-empty"></div>' +
    '<select id="recipes-status-filter"><option value="all" selected>all</option></select>';
}

function toastButtons() {
  return Array.prototype.slice.call(document.querySelectorAll('#admin-toast-container .admin-toast-undo'));
}
function toastText() { return document.getElementById('admin-toast-container').textContent; }

describe('admin handleProxyResponse (additive code/status)', function () {
  beforeEach(function () { resetDom(); global.fetch = jest.fn(); });

  test('409 body sets err.code and err.status, keeps message', function () {
    global.fetch.mockImplementation(function () {
      return resp(409, { ok: false, error: 'stale_schedule', code: 'stale_schedule', message: 'X' });
    });
    return admin._adminApiPostForTest('update_ferm_schedule', {}).then(function () {
      throw new Error('should reject');
    }, function (err) {
      expect(err.message).toBe('X');
      expect(err.code).toBe('stale_schedule');
      expect(err.status).toBe(409);
    });
  });

  test('error-only body falls back to error as code', function () {
    global.fetch.mockImplementation(function () { return resp(400, { ok: false, error: 'bad_thing' }); });
    return admin._adminApiPostForTest('x', {}).then(function () {
      throw new Error('should reject');
    }, function (err) {
      expect(err.message).toBe('bad_thing');
      expect(err.code).toBe('bad_thing');
      expect(err.status).toBe(400);
    });
  });
});

describe('schedule cards: Archive + Delete', function () {
  beforeEach(function () {
    resetDom();
    global.fetch = jest.fn();
    admin._setFermSchedulesDataForTest([sched('FS-0010', TOKEN)]);
    admin._renderScheduleTemplatesForTest();
  });

  test('card has Archive (primary) and Delete; old wording is gone', function () {
    var arch = document.querySelector('.sched-archive-btn');
    var del = document.querySelector('.sched-delete-btn');
    expect(arch).not.toBeNull();
    expect(arch.className).toContain('btn');
    expect(arch.className).not.toContain('btn-secondary');
    expect(del).not.toBeNull();
    expect(document.body.textContent).not.toContain('Delete this schedule template?');
  });

  test('Archive confirms then posts archive_ferm_schedule with expected_updated_at', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'archive_ferm_schedule') return resp(200, { ok: true, message: 'archived' });
      if (b.action === 'get_ferm_schedules') return resp(200, { ok: true, data: { schedules: [] } });
      return resp(200, { ok: true });
    });
    document.querySelector('.sched-archive-btn').click();
    document.querySelector('.admin-confirm-actions .btn').click();
    return tick().then(tick).then(function () {
      var arch = posted().filter(function (b) { return b.action === 'archive_ferm_schedule'; });
      expect(arch).toHaveLength(1);
      expect(arch[0].schedule_id).toBe('FS-0010');
      expect(arch[0].expected_updated_at).toBe(TOKEN);
      expect(document.querySelectorAll('.schedule-card')).toHaveLength(0);
    });
  });

  test('Delete posts delete_ferm_schedule with expected_updated_at', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'get_ferm_schedules') return resp(200, { ok: true, data: { schedules: [] } });
      return resp(200, { ok: true });
    });
    document.querySelector('.sched-delete-btn').click();
    document.querySelector('.admin-confirm-actions .btn').click();
    return tick().then(tick).then(function () {
      var del = posted().filter(function (b) { return b.action === 'delete_ferm_schedule'; });
      expect(del).toHaveLength(1);
      expect(del[0].expected_updated_at).toBe(TOKEN);
    });
  });

  test('Delete 409 schedule_in_use -> server message + "Archive instead" posts archive', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'delete_ferm_schedule') {
        return resp(409, { ok: false, error: 'schedule_in_use', code: 'schedule_in_use', message: IN_USE_MSG });
      }
      if (b.action === 'get_ferm_schedules') return resp(200, { ok: true, data: { schedules: [] } });
      return resp(200, { ok: true });
    });
    document.querySelector('.sched-delete-btn').click();
    document.querySelector('.admin-confirm-actions .btn').click();
    return tick().then(tick).then(function () {
      expect(toastText()).toContain(IN_USE_MSG);
      var btn = toastButtons().filter(function (b) { return b.textContent === 'Archive instead'; })[0];
      expect(btn).toBeDefined();
      btn.click();
      return tick().then(tick);
    }).then(function () {
      var arch = posted().filter(function (b) { return b.action === 'archive_ferm_schedule'; });
      expect(arch).toHaveLength(1);
      expect(arch[0].schedule_id).toBe('FS-0010');
      expect(arch[0].expected_updated_at).toBe(TOKEN);
    });
  });

  test('Archive 409 stale_schedule -> D-16 message + Reload re-fetches list', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'archive_ferm_schedule') {
        return resp(409, { ok: false, error: 'stale_schedule', code: 'stale_schedule', message: STALE_MSG });
      }
      if (b.action === 'get_ferm_schedules') return resp(200, { ok: true, data: { schedules: [sched('FS-0010', 'NEW')] } });
      return resp(200, { ok: true });
    });
    document.querySelector('.sched-archive-btn').click();
    document.querySelector('.admin-confirm-actions .btn').click();
    return tick().then(tick).then(function () {
      expect(toastText()).toContain(STALE_MSG);
      var reload = toastButtons().filter(function (b) { return b.textContent === 'Reload'; })[0];
      expect(reload).toBeDefined();
      reload.click();
      return tick().then(tick);
    }).then(function () {
      expect(posted().some(function (b) { return b.action === 'get_ferm_schedules'; })).toBe(true);
    });
  });
});

describe('schedule save: expected_updated_at + stale', function () {
  beforeEach(function () {
    resetDom();
    global.fetch = jest.fn();
    admin._recipesState.list = [{ recipe_id: 'SV-R-1', schedule_id: 'OTHER' }];
    admin._setFermSchedulesDataForTest([sched('FS-0010', TOKEN)]);
    admin._setBatchesDataForTest([]);
  });

  test('editing posts update_ferm_schedule with expected_updated_at', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'get_ferm_schedules') return resp(200, { ok: true, data: { schedules: [sched('FS-0010', 'NEW')] } });
      return resp(200, { ok: true });
    });
    admin.openEditScheduleModal('FS-0010');
    return tick().then(function () {
      document.getElementById('sched-submit').click();
      return tick().then(tick);
    }).then(function () {
      var upd = posted().filter(function (b) { return b.action === 'update_ferm_schedule'; });
      expect(upd).toHaveLength(1);
      expect(upd[0].schedule_id).toBe('FS-0010');
      expect(upd[0].expected_updated_at).toBe(TOKEN);
    });
  });

  test('stale on save -> D-16 toast with Reload, modal stays open, nothing else posted', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'update_ferm_schedule') {
        return resp(409, { ok: false, error: 'stale_schedule', code: 'stale_schedule', message: STALE_MSG });
      }
      return resp(200, { ok: true });
    });
    admin.openEditScheduleModal('FS-0010');
    return tick().then(function () {
      document.getElementById('sched-submit').click();
      return tick().then(tick);
    }).then(function () {
      expect(toastText()).toContain(STALE_MSG);
      expect(toastButtons().some(function (b) { return b.textContent === 'Reload'; })).toBe(true);
      expect(document.getElementById('sched-submit')).not.toBeNull();
      var actions = posted().map(function (b) { return b.action; });
      expect(actions).toEqual(['update_ferm_schedule']);
    });
  });

  test('creating posts no expected_updated_at', function () {
    global.fetch.mockImplementation(function () { return resp(200, { ok: true, data: { schedules: [] } }); });
    admin._scheduleFormForTest(null);
    document.getElementById('sched-name').value = 'New One';
    document.querySelector('.sched-step-title').value = 'Pitch';
    document.getElementById('sched-submit').click();
    return tick().then(tick).then(function () {
      var cre = posted().filter(function (b) { return b.action === 'create_ferm_schedule'; });
      expect(cre).toHaveLength(1);
      expect('expected_updated_at' in cre[0]).toBe(false);
    });
  });
});
