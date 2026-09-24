'use strict';

// Regression test for a pre-existing Apps Script defect found in the Phase 82 staging walk
// (82-09-SUMMARY.md "Findings"): propagateFermSchedule matched template steps to tasks by
// step_number over PENDING tasks only, so every completed step was re-appended as an open
// duplicate; inserting a step shifted numbers so the pending packaging task was rewritten into the
// new step while keeping is_packaging=TRUE; and it never evicted the per-batch `gb:` cache.
//
// Unlike the source-shape suites, this harness evaluates the REAL adminApi.gs with in-memory
// stand-ins for the Apps Script globals (SpreadsheetApp, CacheService, LockService, Utilities,
// Session) passed as `new Function` parameters, so the actual function bodies run. The harness is
// duplicated in adminapi-batch-public-cache.test.js per the no-cross-test-imports convention.

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

// --- 2. propagateFermSchedule -----------------------------------------------------------------

describe('propagateFermSchedule (data-integrity regression)', function () {
  // Reproduces SV-B-000221 from the staging walk: template had [A(day 7), Packaging];
  // A is completed; owner inserts B(day 14) → template [A, B, Packaging].
  function setup() {
    var tasks = makeSheet([
      TASK_HEADERS.slice(),
      taskRow({ task_id: 'BT-000001', batch_id: 'SV-B-000221', step_number: 1, title: 'ZZ Step A',
        day_offset: 7, due_date: '2026-09-30', is_packaging: 'FALSE', is_transfer: 'FALSE', completed: 'TRUE' }),
      taskRow({ task_id: 'BT-000002', batch_id: 'SV-B-000221', step_number: 2, title: 'Bottling / Packaging',
        day_offset: -1, due_date: '', is_packaging: 'TRUE', is_transfer: 'FALSE', completed: 'FALSE' }),
      // An unrelated batch on another template must be untouched.
      taskRow({ task_id: 'BT-000003', batch_id: 'SV-B-000100', step_number: 1, title: 'Other',
        day_offset: 0, due_date: '2026-09-01', is_packaging: 'FALSE', is_transfer: 'FALSE', completed: 'FALSE' })
    ]);
    var batches = makeSheet([
      BATCH_HEADERS.slice(),
      ['SV-B-000221', 'primary', 'FS-TEST', '2026-09-23'],
      ['SV-B-000100', 'primary', 'FS-OTHER', '2026-09-01']
    ]);
    var cache = makeCache();
    cache.put('gb:SV-B-000221', 'stale');
    cache.put('gbp:SV-B-000221', 'stale');
    cache.put('gb:SV-B-000100', 'keep');
    var api = loadApi({ BatchTasks: tasks, Batches: batches }, cache);
    var steps = [
      { step_number: 1, day_offset: 7, title: 'ZZ Step A', description: '', is_packaging: false, is_transfer: false },
      { step_number: 2, day_offset: 14, title: 'ZZ Step B', description: '', is_packaging: false, is_transfer: false },
      { step_number: 3, day_offset: -1, title: 'Bottling / Packaging', description: '', is_packaging: true, is_transfer: false }
    ];
    var result = api.propagateFermSchedule({ schedule_id: 'FS-TEST', steps: steps }, 'middleware');
    return { tasks: tasks, cache: cache, result: result };
  }

  test('a completed step is not re-added as an open duplicate', function () {
    var s = setup();
    var stepA = tasksFor(s.tasks, 'SV-B-000221').filter(function (t) { return t.title === 'ZZ Step A'; });
    expect(stepA).toHaveLength(1);
    expect(stepA[0].completed).toBe('TRUE');
  });

  test('inserting a step creates it as a normal (non-packaging) task', function () {
    var s = setup();
    var stepB = tasksFor(s.tasks, 'SV-B-000221').filter(function (t) { return t.title === 'ZZ Step B'; });
    expect(stepB).toHaveLength(1);
    expect(stepB[0].is_packaging).toBe('FALSE');
    expect(stepB[0].due_date).toBe('2026-10-07');
  });

  test('the existing packaging task is kept (renumbered), not duplicated', function () {
    var s = setup();
    var pack = tasksFor(s.tasks, 'SV-B-000221').filter(function (t) { return t.is_packaging === 'TRUE'; });
    expect(pack).toHaveLength(1);
    expect(pack[0].task_id).toBe('BT-000002');
    expect(pack[0].title).toBe('Bottling / Packaging');
    expect(Number(pack[0].step_number)).toBe(3);
  });

  test('batch ends with exactly A, B, Packaging and reports 1 created', function () {
    var s = setup();
    expect(tasksFor(s.tasks, 'SV-B-000221')).toHaveLength(3);
    expect(s.result.tasks_created).toBe(1);
    expect(s.result.tasks_removed).toBe(0);
  });

  test('other batches are untouched', function () {
    var s = setup();
    var other = tasksFor(s.tasks, 'SV-B-000100');
    expect(other).toHaveLength(1);
    expect(other[0].title).toBe('Other');
  });

  test('evicts the per-batch caches of every propagated batch (and only those)', function () {
    var s = setup();
    expect(s.cache.get('gb:SV-B-000221')).toBeNull();
    expect(s.cache.get('gbp:SV-B-000221')).toBeNull();
    expect(s.cache.get('gb:SV-B-000100')).toBe('keep');
  });

  test('a pending step removed from the template is deleted; completed history is kept', function () {
    var tasks = makeSheet([
      TASK_HEADERS.slice(),
      taskRow({ task_id: 'BT-000001', batch_id: 'SV-B-000221', step_number: 1, title: 'Done step',
        day_offset: 0, is_packaging: 'FALSE', completed: 'TRUE' }),
      taskRow({ task_id: 'BT-000002', batch_id: 'SV-B-000221', step_number: 2, title: 'Dropped step',
        day_offset: 5, is_packaging: 'FALSE', completed: 'FALSE' }),
      taskRow({ task_id: 'BT-000003', batch_id: 'SV-B-000221', step_number: 3, title: 'Bottling / Packaging',
        day_offset: -1, is_packaging: 'TRUE', completed: 'FALSE' })
    ]);
    var batches = makeSheet([BATCH_HEADERS.slice(), ['SV-B-000221', 'secondary', 'FS-TEST', '2026-09-23']]);
    var api = loadApi({ BatchTasks: tasks, Batches: batches }, makeCache());
    var result = api.propagateFermSchedule({ schedule_id: 'FS-TEST', steps: [
      { step_number: 1, day_offset: 0, title: 'Done step', is_packaging: false },
      { step_number: 2, day_offset: -1, title: 'Bottling / Packaging', is_packaging: true }
    ] }, 'middleware');
    var titles = tasksFor(tasks, 'SV-B-000221').map(function (t) { return t.title; });
    expect(titles).toEqual(['Done step', 'Bottling / Packaging']);
    expect(result.tasks_removed).toBe(1);
    expect(result.tasks_created).toBe(0);
  });

  test('a pending non-packaging step is updated in place (title/date follow the template)', function () {
    var tasks = makeSheet([
      TASK_HEADERS.slice(),
      taskRow({ task_id: 'BT-000001', batch_id: 'SV-B-000221', step_number: 1, title: 'Old title',
        day_offset: 3, due_date: '2026-09-26', is_packaging: 'FALSE', completed: 'FALSE' })
    ]);
    var batches = makeSheet([BATCH_HEADERS.slice(), ['SV-B-000221', 'primary', 'FS-TEST', '2026-09-23']]);
    var api = loadApi({ BatchTasks: tasks, Batches: batches }, makeCache());
    var result = api.propagateFermSchedule({ schedule_id: 'FS-TEST', steps: [
      { step_number: 1, day_offset: 5, title: 'New title', is_packaging: false }
    ] }, 'middleware');
    var t = tasksFor(tasks, 'SV-B-000221');
    expect(t).toHaveLength(1);
    expect(t[0].task_id).toBe('BT-000001');
    expect(t[0].title).toBe('New title');
    expect(t[0].due_date).toBe('2026-09-28');
    expect(result.tasks_updated).toBe(1);
  });
});
