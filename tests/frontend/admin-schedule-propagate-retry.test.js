'use strict';

// =============================================================================
// Tests: Phase 86 Plan 04 -- admin D-14 propagate partial-failure list + Retry.
// The saved schedule is never rolled back; batches_failed ids are listed and a
// Retry action re-posts propagate_ferm_schedule with the same schedule_id/steps.
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
function resp(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(body); } });
}
function posted() {
  return global.fetch.mock.calls.map(function (c) { return JSON.parse(c[1].body); });
}
function proposals() {
  return posted().filter(function (b) { return b.action === 'propagate_ferm_schedule'; });
}
function toastText() { return document.getElementById('admin-toast-container').textContent; }
function toastButtons() {
  return Array.prototype.slice.call(document.querySelectorAll('#admin-toast-container .admin-toast-undo'));
}

var STEPS = [{ step_number: 1, day_offset: 0, title: 'Pitch', description: '' }];

describe('D-14 propagate failures + Retry', function () {
  beforeEach(function () {
    document.body.innerHTML = '<div id="admin-toast-container"></div>';
    global.fetch = jest.fn();
  });

  test('batches_failed -> toast lists ids + "did not update"; Retry re-posts same payload', function () {
    var call = 0;
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'propagate_ferm_schedule') {
        call++;
        if (call === 1) {
          return resp(200, { ok: true, batches_updated: 1, batches_failed: [{ batch_id: 'SV-B-000201' }, { batch_id: 'SV-B-000202' }] });
        }
        return resp(200, { ok: true, batches_updated: 3, batches_failed: [] });
      }
      return resp(200, { ok: true, data: { batches: [] } });
    });

    admin._propagateScheduleForTest('FS-0010', STEPS);
    return tick().then(tick).then(function () {
      var text = toastText();
      expect(text).toContain('SV-B-000201');
      expect(text).toContain('SV-B-000202');
      expect(text).toContain('did not update');
      var retry = toastButtons().filter(function (b) { return b.textContent === 'Retry'; })[0];
      expect(retry).toBeDefined();
      retry.click();
      return tick().then(tick);
    }).then(function () {
      var p = proposals();
      expect(p).toHaveLength(2);
      expect(p[1].schedule_id).toBe('FS-0010');
      expect(p[1].steps).toEqual(STEPS);
      expect(toastText()).toContain('Propagated to 3 batches');
    });
  });

  test('no batches_failed -> unchanged success path (no Retry button)', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'propagate_ferm_schedule') {
        return resp(200, { ok: true, batches_updated: 1, tasks_updated: 2 });
      }
      return resp(200, { ok: true, data: { batches: [] } });
    });
    admin._propagateScheduleForTest('FS-0010', STEPS);
    return tick().then(tick).then(function () {
      expect(toastText()).toContain('Propagated to 1 batch, 2 updated');
      expect(toastButtons().some(function (b) { return b.textContent === 'Retry'; })).toBe(false);
    });
  });

  test('hostile batch id is rendered as inert text (no element injected)', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'propagate_ferm_schedule') {
        return resp(200, { ok: true, batches_updated: 0, batches_failed: [{ batch_id: '<img src=x onerror=alert(1)>' }] });
      }
      return resp(200, { ok: true, data: { batches: [] } });
    });
    admin._propagateScheduleForTest('FS-0010', STEPS);
    return tick().then(tick).then(function () {
      expect(document.querySelector('#admin-toast-container img')).toBeNull();
      expect(toastText()).toContain('<img src=x onerror=alert(1)>');
    });
  });
});
