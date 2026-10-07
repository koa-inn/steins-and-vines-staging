'use strict';

// brewpad.js runs its IIFE on load -- stub the globals it touches at the top level.
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
  getItem: function (k) { return this._data[k] || null; },
  setItem: function (k, v) { this._data[k] = v; },
  removeItem: function (k) { delete this._data[k]; },
  clear: function () { this._data = {}; }
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

global.SHEETS_CONFIG = { MIDDLEWARE_URL: 'http://mw.test' };

var bp = require('../../js/brewpad');

// =============================================================================
// Phase 86 Plan 04 -- BrewPad schedule editor D-15 / D-16 and vessel label (D-06/D-08).
// =============================================================================

var TOKEN = '2026-10-07T10:00:00.123Z';
var STALE_MSG = 'This schedule was changed since you opened it — reload to see the latest';
var IN_USE_MSG = 'This schedule is used by 1 recipe(s) and 0 batch(es). Archive it instead.';

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }
function resp(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(body); } });
}
function posted() {
  return global.fetch.mock.calls.map(function (c) { return JSON.parse(c[1].body); });
}
function toastText() { return document.getElementById('bp-toast-container').textContent; }
function toastAction(label) {
  var btns = Array.prototype.slice.call(document.querySelectorAll('#bp-toast-container .bp-toast-action'));
  return btns.filter(function (b) { return b.textContent === label; })[0];
}

beforeEach(function () {
  document.body.innerHTML =
    '<div id="bp-toast-container"></div>' +
    '<div id="bp-sched-sheet"><div id="bp-sched-sheet-inner"></div></div>' +
    '<div id="bp-schedules-list"></div>';
  global.fetch = jest.fn();
  bp._setFermSchedulesForTest([{ schedule_id: 'FS-0010', name: 'Basic Ale', last_updated: TOKEN, steps_parsed: [] }]);
  bp._setRecipesListForTest([]);
});

describe('BrewPad schedule save: expected_updated_at + stale', function () {
  function openEdit() {
    var c = document.getElementById('bp-sched-sheet-inner');
    bp._buildSchedFormForTest(c, {
      schedule_id: 'FS-0010', name: 'Basic Ale', last_updated: TOKEN,
      steps_parsed: [{ step_number: 1, day_offset: 0, title: 'Pitch', description: '' }]
    });
  }

  test('update carries expected_updated_at; 409 stale -> D-16 message + Reload, one call only', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'update_ferm_schedule') {
        return resp(409, { ok: false, error: 'stale_schedule', code: 'stale_schedule', message: STALE_MSG });
      }
      if (b.action === 'get_ferm_schedules') return resp(200, { ok: true, data: { schedules: [] } });
      return resp(200, { ok: true });
    });
    openEdit();
    document.getElementById('bp-sched-submit').click();
    return tick().then(tick).then(function () {
      var writes = posted().filter(function (b) { return b.action === 'update_ferm_schedule'; });
      expect(writes).toHaveLength(1);                       // never auto-retried
      expect(writes[0].expected_updated_at).toBe(TOKEN);
      expect(toastText()).toContain(STALE_MSG);
      expect(document.getElementById('bp-sched-submit')).not.toBeNull();   // draft kept
      expect(document.getElementById('bp-sched-submit').disabled).toBe(false);
      var reload = toastAction('Reload');
      expect(reload).toBeDefined();
      reload.click();
      return tick().then(tick);
    }).then(function () {
      expect(posted().some(function (b) { return b.action === 'get_ferm_schedules'; })).toBe(true);
    });
  });

  test('create posts no expected_updated_at', function () {
    global.fetch.mockImplementation(function () { return resp(200, { ok: true, data: { schedules: [] } }); });
    var c = document.getElementById('bp-sched-sheet-inner');
    bp._buildSchedFormForTest(c, null);
    document.getElementById('bp-sched-name').value = 'Fresh';
    var title = c.querySelector('.bp-sched-step-title');
    if (title) title.value = 'Pitch';
    document.getElementById('bp-sched-submit').click();
    return tick().then(tick).then(function () {
      var cre = posted().filter(function (b) { return b.action === 'create_ferm_schedule'; });
      expect(cre).toHaveLength(1);
      expect('expected_updated_at' in cre[0]).toBe(false);
    });
  });
});

describe('BrewPad schedule delete: in-use -> Archive instead', function () {
  test('delete carries token; 409 schedule_in_use offers Archive instead which posts archive', function () {
    global.fetch.mockImplementation(function (url, opts) {
      var b = JSON.parse(opts.body);
      if (b.action === 'delete_ferm_schedule') {
        return resp(409, { ok: false, error: 'schedule_in_use', code: 'schedule_in_use', message: IN_USE_MSG });
      }
      if (b.action === 'get_ferm_schedules') return resp(200, { ok: true, data: { schedules: [] } });
      return resp(200, { ok: true, message: 'archived' });
    });
    return bp._deleteScheduleForTest('FS-0010').then(function () {
      var del = posted().filter(function (b) { return b.action === 'delete_ferm_schedule'; });
      expect(del).toHaveLength(1);                          // 409 is not retried
      expect(del[0].expected_updated_at).toBe(TOKEN);
      expect(toastText()).toContain(IN_USE_MSG);
      var arch = toastAction('Archive instead');
      expect(arch).toBeDefined();
      arch.click();
      return tick().then(tick);
    }).then(function () {
      var a = posted().filter(function (b) { return b.action === 'archive_ferm_schedule'; });
      expect(a).toHaveLength(1);
      expect(a[0].schedule_id).toBe('FS-0010');
      expect(a[0].expected_updated_at).toBe(TOKEN);
    });
  });

  test('archive 409 stale -> D-16 message with Reload', function () {
    global.fetch.mockImplementation(function () {
      return resp(409, { ok: false, error: 'stale_schedule', code: 'stale_schedule', message: STALE_MSG });
    });
    return bp._archiveScheduleForTest('FS-0010').then(function () {
      expect(toastText()).toContain(STALE_MSG);
      expect(toastAction('Reload')).toBeDefined();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  test('adminApiPost sets err.code / err.status on a rejection', function () {
    global.fetch.mockImplementation(function () {
      return resp(409, { ok: false, error: 'stale_schedule', code: 'stale_schedule', message: 'm' });
    });
    return bp._adminApiPostForTest('update_ferm_schedule', {}).then(function () {
      throw new Error('should reject');
    }, function (err) {
      expect(err.code).toBe('stale_schedule');
      expect(err.status).toBe(409);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('BrewPad vessel label (D-06 / D-08)', function () {
  test('label is inserted after the id', function () {
    expect(bp._buildVesselLabelForTest({ vessel_id: 'PCB-009', label: 'Big Blue', type: 'Carboy', capacity_liters: 23 }))
      .toBe('PCB-009 — Big Blue — Carboy — 23L');
  });

  test('without a label the output is unchanged', function () {
    expect(bp._buildVesselLabelForTest({ vessel_id: 'PCB-009', type: 'Carboy', capacity_liters: 23 }))
      .toBe('PCB-009 — Carboy — 23L');
    expect(bp._buildVesselLabelForTest({ vessel_id: 'PCB-009', label: '', type: 'Carboy', capacity_liters: 23 }))
      .toBe('PCB-009 — Carboy — 23L');
  });

  test('search for "blue" matches PCB-009 by label', function () {
    bp._setVesselsDataForTest([
      { vessel_id: 'PCB-009', label: 'Big Blue', type: 'Carboy', capacity_liters: 23, status: 'available' },
      { vessel_id: 'PCB-010', label: '', type: 'Carboy', capacity_liters: 23, status: 'available' }
    ]);
    var input = document.createElement('input');
    var dropdown = document.createElement('div');
    var hidden = document.createElement('input');
    document.body.appendChild(input);
    document.body.appendChild(dropdown);
    bp._bindVesselSearchForTest(input, dropdown, hidden, '');
    input.value = 'blue';
    input.dispatchEvent(new Event('input'));
    return tick(220).then(function () {
      var opts = dropdown.querySelectorAll('.bp-vessel-option[data-vid]');
      expect(opts).toHaveLength(1);
      expect(opts[0].getAttribute('data-vid')).toBe('PCB-009');
      expect(opts[0].textContent).toContain('Big Blue');
    });
  });
});
