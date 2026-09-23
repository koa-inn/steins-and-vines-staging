'use strict';

// Regression/parity tests for Phase 82-07 (D-21): admin.js's Scheduling flows
// (generateSlotsForMonth, toggleSlot, bulkUpdateDay, resetDayToDefault,
// resetMonthToDefaults) and the Homepage load (loadHomepageData) no longer call
// the direct Google Sheets API -- they now route through the typed
// append_schedule_slots / update_schedule_slots / get_homepage proxy actions
// added in 82-03 and allowlisted in 82-04.
//
// Every schedule fixture date below (October 2026) is deliberately in the
// future relative to this suite's real system clock (2026-09-23) so the
// "skip past days" filters in generateSlotsForMonth/resetMonthToDefaults
// never trigger -- no Date mocking required.

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

describe('admin.js Scheduling + Homepage flows route through /api/admin/proxy (82-07 D-21)', function () {
  var admin;

  beforeEach(function () {
    jest.resetModules();

    document.body.innerHTML =
      '<div id="admin-signin" style="display:none"></div>' +
      '<div id="admin-denied" style="display:none"></div>' +
      '<div id="admin-dashboard"></div>' +
      '<span id="admin-user-email">staff@example.com</span>' +
      '<button id="admin-signout"></button>' +
      '<div id="admin-toast-container"></div>' +
      '<input id="homepage-instafeed-url">' +
      '<input id="homepage-social-instagram">' +
      '<input id="homepage-social-facebook">' +
      '<div id="homepage-news-list"></div>' +
      '<div id="homepage-faq-list"></div>' +
      '<div id="homepage-featured-list"></div>';

    global.window = global.window || {};
    global.navigator = global.navigator || {};
    global.google = { accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } } };
    global.confirm = jest.fn(function () { return true; });
    global.fetch = jest.fn(function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
    });
    global.localStorage = {
      _data: {},
      getItem: function (k) { return this._data[k] || null; },
      setItem: function (k, v) { this._data[k] = v; },
      removeItem: function (k) { delete this._data[k]; },
      clear: function () { this._data = {}; }
    };
    global.sessionStorage = global.localStorage;
    global.SHEETS_CONFIG = {
      MIDDLEWARE_URL: 'http://mw.test',
      SPREADSHEET_ID: 'test-id',
      CLIENT_ID: 'test-client-id',
      ADMIN_API_URL: '',
      SHEET_NAMES: {
        KITS: 'Kits', INGREDIENTS: 'Ingredients', RESERVATIONS: 'Reservations',
        HOLDS: 'Holds', SCHEDULE: 'Schedule', HOMEPAGE: 'Homepage'
      }
    };

    var _auth = require('../../js/lib/auth');
    global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
    global.gsiInitTokenClient = _auth.gsiInitTokenClient;
    global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

    admin = require('../../js/admin.js');
    admin._setAccessToken('test-access-token');
    admin._setUserEmail('staff@example.com');

    // Default schedule read by getDefaultSchedule(): open every day of the week,
    // 9:00 AM - 11:00 AM (30-min slots -> 9:00/9:30/10:00/10:30 AM).
    var everyDayOpen = { start: '9:00 AM', end: '11:00 AM', open: true, blockedSlots: [] };
    global.localStorage.setItem('sv_schedule_defaults', JSON.stringify([
      Object.assign({ day: 'Sun' }, everyDayOpen),
      Object.assign({ day: 'Mon' }, everyDayOpen),
      Object.assign({ day: 'Tue' }, everyDayOpen),
      Object.assign({ day: 'Wed' }, everyDayOpen),
      Object.assign({ day: 'Thu' }, everyDayOpen),
      Object.assign({ day: 'Fri' }, everyDayOpen),
      Object.assign({ day: 'Sat' }, everyDayOpen)
    ]));

    // October 2026 is entirely in the future relative to this suite's real
    // system clock (2026-09-23) -- no day in it is ever filtered as "past".
    admin._setSheetStateForTest({ scheduleCalMonth: new Date(2026, 9, 1) });
  });

  function lastFetchBody() {
    var call = global.fetch.mock.calls[global.fetch.mock.calls.length - 1];
    return JSON.parse(call[1].body);
  }

  function noSheetsUrl() {
    global.fetch.mock.calls.forEach(function (call) {
      expect(String(call[0])).not.toMatch(/sheets\.googleapis\.com/);
    });
  }

  test('toggleSlot on an available slot issues ONE update_schedule_slots call and flips local status on success', function () {
    var slot = { date: '2026-10-01', time: '9:00 AM', status: 'available', _rowIndex: 7 };
    admin._setSheetStateForTest({ scheduleData: [slot], scheduleHeaders: ['date', 'time', 'status'] });
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, updated: 1, skipped: [] }); } });
    });

    admin._scheduleForTest.toggleSlot('2026-10-01', '9:00 AM', 7);

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_schedule_slots');
      expect(body.updates).toEqual([{ row: 7, status: 'blocked' }]);
      expect(slot.status).toBe('blocked');
      noSheetsUrl();
    });
  });

  test('toggleSlot does not flip local status when the row comes back skipped (already booked server-side)', function () {
    var slot = { date: '2026-10-01', time: '9:00 AM', status: 'available', _rowIndex: 7 };
    admin._setSheetStateForTest({ scheduleData: [slot], scheduleHeaders: ['date', 'time', 'status'] });
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, updated: 0, skipped: [7] }); } });
    });

    admin._scheduleForTest.toggleSlot('2026-10-01', '9:00 AM', 7);

    return flushPromises().then(function () {
      expect(slot.status).toBe('available');
    });
  });

  test('bulkUpdateDay over 3 non-booked slots issues ONE call with 3 updates', function () {
    var slots = [
      { date: '2026-10-01', time: '9:00 AM', status: 'available', _rowIndex: 2 },
      { date: '2026-10-01', time: '9:30 AM', status: 'available', _rowIndex: 3 },
      { date: '2026-10-01', time: '10:00 AM', status: 'available', _rowIndex: 4 },
      { date: '2026-10-01', time: '10:30 AM', status: 'booked', _rowIndex: 5 }
    ];
    admin._setSheetStateForTest({ scheduleData: slots, scheduleHeaders: ['date', 'time', 'status'] });

    admin._scheduleForTest.bulkUpdateDay('2026-10-01', 'blocked');

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_schedule_slots');
      expect(body.updates).toEqual([
        { row: 2, status: 'blocked' },
        { row: 3, status: 'blocked' },
        { row: 4, status: 'blocked' }
      ]);
      noSheetsUrl();
    });
  });

  test('resetDayToDefault issues ONE call with every needed update; booked slots never appear', function () {
    var slots = [
      { date: '2026-10-01', time: '9:00 AM', status: 'blocked', _rowIndex: 10 }, // should become available
      { date: '2026-10-01', time: '9:30 AM', status: 'available', _rowIndex: 11 }, // already matches default
      { date: '2026-10-01', time: '12:00 PM', status: 'booked', _rowIndex: 12 } // never touched
    ];
    admin._setSheetStateForTest({ scheduleData: slots, scheduleHeaders: ['date', 'time', 'status'] });

    admin._scheduleForTest.resetDayToDefault('2026-10-01');

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_schedule_slots');
      expect(body.updates).toEqual([{ row: 10, status: 'available' }]);
      var rows = body.updates.map(function (u) { return u.row; });
      expect(rows).not.toContain(12);
      noSheetsUrl();
    });
  });

  test('resetMonthToDefaults issues ONE call with every needed update; booked slots never appear', function () {
    var slots = [
      { date: '2026-10-10', time: '9:00 AM', status: 'blocked', _rowIndex: 20 }, // should become available
      { date: '2026-10-10', time: '12:00 PM', status: 'booked', _rowIndex: 21 } // never touched
    ];
    admin._setSheetStateForTest({ scheduleData: slots, scheduleHeaders: ['date', 'time', 'status'] });

    admin._scheduleForTest.resetMonthToDefaults();

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_schedule_slots');
      var rows = body.updates.map(function (u) { return u.row; });
      expect(rows).toContain(20);
      expect(rows).not.toContain(21);
      noSheetsUrl();
    });
  });

  test('generateSlotsForMonth issues ONE append_schedule_slots call then reloads', function () {
    admin._setSheetStateForTest({ scheduleData: [], scheduleHeaders: ['date', 'time', 'status'] });

    admin._scheduleForTest.generateSlotsForMonth();

    return flushPromises().then(function () {
      expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
      var call = global.fetch.mock.calls[0];
      var body = JSON.parse(call[1].body);
      expect(body.action).toBe('append_schedule_slots');
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBeGreaterThan(0);
      body.rows.forEach(function (row) {
        expect(row[2]).toBe('available');
      });
      noSheetsUrl();
    });
  });

  test('loadHomepageData issues ONE get_homepage call and fills homepageConfig exactly as the old sheetsGet path did', function () {
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            ok: true,
            data: {
              values: [
                ['type', 'date', 'title', 'text', 'sku'],
                ['news', '2026-09-01', 'T', 'X', ''],
                ['featured', '', '', 'Desc', 'SKU-1']
              ]
            }
          });
        }
      });
    });

    admin._scheduleForTest.loadHomepageData();

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('get_homepage');
      var cfg = admin._getHomepageConfigForTest();
      expect(cfg['promo-news']).toEqual([{ date: '2026-09-01', title: 'T', text: 'X' }]);
      expect(cfg['promo-featured-skus']).toEqual([{ sku: 'SKU-1', description: 'Desc' }]);
      noSheetsUrl();
    });
  });

  test('no URL contains sheets.googleapis.com across any scheduling/homepage call in this suite', function () {
    var slot = { date: '2026-10-01', time: '9:00 AM', status: 'available', _rowIndex: 7 };
    admin._setSheetStateForTest({ scheduleData: [slot], scheduleHeaders: ['date', 'time', 'status'] });
    admin._scheduleForTest.toggleSlot('2026-10-01', '9:00 AM', 7);

    return flushPromises().then(function () {
      noSheetsUrl();
    });
  });
});

describe('source-shape: no direct-Sheets calls remain in the 82-07 rewired scheduling/homepage functions', function () {
  var fs = require('fs');
  var path = require('path');
  var SRC = fs.readFileSync(path.join(__dirname, '../../js/admin.js'), 'utf8');

  function bodyOf(fnName) {
    var start = SRC.indexOf('function ' + fnName + '(');
    expect(start).toBeGreaterThan(-1);
    var next = SRC.indexOf('\n  function ', start + 1);
    return SRC.slice(start, next === -1 ? SRC.length : next);
  }

  ['generateSlotsForMonth', 'toggleSlot', 'bulkUpdateDay', 'resetDayToDefault', 'resetMonthToDefaults', 'loadHomepageData'].forEach(function (fnName) {
    test(fnName + ' body contains no sheetsGet(/sheetsUpdate(/sheetsAppend(/colLetter(', function () {
      var body = bodyOf(fnName);
      expect(body).not.toMatch(/sheetsGet\(/);
      expect(body).not.toMatch(/sheetsUpdate\(/);
      expect(body).not.toMatch(/sheetsAppend\(/);
      expect(body).not.toMatch(/colLetter\(/);
    });
  });
});
