'use strict';

// Regression test for a pre-existing Apps Script defect found in the Phase 82 staging walk
// (82-09-SUMMARY.md "Findings"): get_batch_public cached its RESULT under `gbp:<batch_id>` with no
// token in the key, and the token check ran inside the cached fetch — for 5 s after any valid view,
// ANY token (even a malformed one) got the batch's public data; conversely a cached invalid_token
// result made the valid token fail.
//
// Unlike the source-shape suites, this harness evaluates the REAL adminApi.gs with in-memory
// stand-ins for the Apps Script globals (SpreadsheetApp, CacheService, LockService, Utilities,
// Session) passed as `new Function` parameters, so the actual function bodies run. The harness is
// duplicated in adminapi-propagate-ferm-schedule.test.js per the no-cross-test-imports convention.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

var TASK_HEADERS = [
  'task_id', 'batch_id', 'step_number', 'title', 'description', 'day_offset', 'due_date',
  'is_packaging', 'is_transfer', 'completed', 'completed_at', 'completed_by', 'notes', 'last_updated'
];
var BATCH_HEADERS = ['batch_id', 'status', 'schedule_id', 'start_date'];

function makeSheet(rows) {
  return {
    rows: rows,
    getLastRow: function () { return this.rows.length; },
    getDataRange: function () {
      var self = this;
      return { getValues: function () { return self.rows.map(function (r) { return r.slice(); }); } };
    },
    getRange: function (r, c, nr, nc) {
      var self = this;
      return {
        getValues: function () {
          return self.rows.slice(r - 1, r - 1 + (nr || 1)).map(function (row) {
            return row.slice(c - 1, c - 1 + (nc || 1));
          });
        },
        setValue: function (v) { self.rows[r - 1][c - 1] = v; }
      };
    },
    appendRow: function (arr) { this.rows.push(arr.slice()); },
    deleteRow: function (r) { this.rows.splice(r - 1, 1); }
  };
}

function makeCache() {
  var store = {};
  return {
    store: store,
    get: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    put: function (k, v) { store[k] = v; },
    remove: function (k) { delete store[k]; },
    removeAll: function (keys) { keys.forEach(function (k) { delete store[k]; }); }
  };
}

function loadApi(sheets, cache) {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var SpreadsheetApp = {
    getActiveSpreadsheet: function () {
      return { getSheetByName: function (n) { return sheets[n] || null; } };
    }
  };
  var CacheService = { getScriptCache: function () { return cache; } };
  var LockService = {
    getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; }
  };
  var Utilities = {
    formatDate: function (d) {
      var m = String(d.getMonth() + 1); if (m.length < 2) m = '0' + m;
      var day = String(d.getDate()); if (day.length < 2) day = '0' + day;
      return d.getFullYear() + '-' + m + '-' + day;
    }
  };
  var Session = { getScriptTimeZone: function () { return 'America/Vancouver'; } };
  var factory = new Function(
    'SpreadsheetApp', 'CacheService', 'LockService', 'Utilities', 'Session',
    src + '\nreturn {' +
      'propagateFermSchedule: propagateFermSchedule,' +
      '_getBatchPublicCached: (typeof _getBatchPublicCached !== "undefined" ? _getBatchPublicCached : undefined)' +
      '};'
  );
  return factory(SpreadsheetApp, CacheService, LockService, Utilities, Session);
}

function taskRow(o) {
  return TASK_HEADERS.map(function (h) { return o[h] !== undefined ? o[h] : ''; });
}

function tasksFor(sheet, batchId) {
  var h = sheet.rows[0];
  return sheet.rows.slice(1).map(function (r) {
    var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o;
  }).filter(function (t) { return t.batch_id === batchId; });
}

// --- 1. get_batch_public cache must never serve one token's result to another token ---------

describe('get_batch_public cache is token-bound (security regression)', function () {
  var GOOD = 'a'.repeat(32);
  var OK_RESULT = { ok: true, data: { batch: { batch_id: 'SV-B-000001', customer_name: 'Jane' } } };

  function fetchFor(token) {
    return function () {
      return token === GOOD ? OK_RESULT : { ok: false, error: 'invalid_token', message: 'Invalid access token' };
    };
  }

  test('_getBatchPublicCached exists', function () {
    var api = loadApi({}, makeCache());
    expect(typeof api._getBatchPublicCached).toBe('function');
  });

  test('a cached valid view does not leak to a bogus or malformed token', function () {
    var cache = makeCache();
    var api = loadApi({}, cache);
    expect(api._getBatchPublicCached('SV-B-000001', GOOD, fetchFor(GOOD)).ok).toBe(true);
    var bogus = '0'.repeat(32);
    expect(api._getBatchPublicCached('SV-B-000001', bogus, fetchFor(bogus)).ok).toBe(false);
    expect(api._getBatchPublicCached('SV-B-000001', 'not-hex', fetchFor('not-hex')).ok).toBe(false);
  });

  test('a failed lookup is not cached, so the valid token still works right after', function () {
    var cache = makeCache();
    var api = loadApi({}, cache);
    var bogus = '0'.repeat(32);
    expect(api._getBatchPublicCached('SV-B-000001', bogus, fetchFor(bogus)).ok).toBe(false);
    expect(api._getBatchPublicCached('SV-B-000001', GOOD, fetchFor(GOOD)).ok).toBe(true);
  });

  test('a repeat view with the same valid token is served from cache', function () {
    var cache = makeCache();
    var api = loadApi({}, cache);
    var calls = 0;
    var fetchFn = function () { calls++; return OK_RESULT; };
    api._getBatchPublicCached('SV-B-000001', GOOD, fetchFn);
    api._getBatchPublicCached('SV-B-000001', GOOD, fetchFn);
    expect(calls).toBe(1);
  });

  test('the cache entry stays keyed gbp:<batch_id> so existing invalidation still evicts it', function () {
    var cache = makeCache();
    var api = loadApi({}, cache);
    api._getBatchPublicCached('SV-B-000001', GOOD, fetchFor(GOOD));
    expect(Object.keys(cache.store)).toEqual(['gbp:SV-B-000001']);
  });

  test('doGet routes get_batch_public through _getBatchPublicCached', function () {
    var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
    var start = src.indexOf("if (action === 'get_batch_public')");
    var block = src.slice(start, src.indexOf('}\n  }', start));
    expect(block).toContain('_getBatchPublicCached(');
    expect(block).not.toContain('_cachedGet(');
  });
});
