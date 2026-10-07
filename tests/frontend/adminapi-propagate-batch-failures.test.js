'use strict';

// Phase 86-08 (D-14): propagateFermSchedule continues past a failing batch and reports batches_failed.
// Harness duplicated per the no-cross-test-imports convention.

var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8');

var TASK_HEADERS = [
  'task_id', 'batch_id', 'step_number', 'title', 'description', 'day_offset', 'due_date',
  'is_packaging', 'is_transfer', 'completed', 'completed_at', 'completed_by', 'notes', 'last_updated'
];

function makeSheet(rows, opts) {
  opts = opts || {};
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
          return self.rows.slice(r - 1, r - 1 + (nr || 1)).map(function (row) { return row.slice(c - 1, c - 1 + (nc || 1)); });
        },
        setValue: function (v) {
          if (opts.failOnBatch && self.rows[r - 1] && self.rows[r - 1][1] === opts.failOnBatch) throw new Error('boom');
          self.rows[r - 1][c - 1] = v;
        }
      };
    },
    appendRow: function (arr) { this.rows.push(arr.slice()); },
    deleteRow: function (r) { this.rows.splice(r - 1, 1); }
  };
}

function load(sheets) {
  var cache = { get: function () { return null; }, put: function () {}, remove: function () {}, removeAll: function () {} };
  var factory = new Function('SpreadsheetApp', 'CacheService', 'LockService', 'Utilities', 'Session',
    src + '\nreturn { propagateFermSchedule: propagateFermSchedule };');
  return factory(
    { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return sheets[n] || null; } }; } },
    { getScriptCache: function () { return cache; } },
    { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    { formatDate: function (d) { return d.toISOString().slice(0, 10); } },
    { getScriptTimeZone: function () { return 'America/Vancouver'; } }
  );
}

function task(id, batch, step, title) {
  return [id, batch, step, title, '', 1, '2026-09-30', 'FALSE', 'FALSE', 'FALSE', '', '', '', ''];
}

var STEPS = [{ step_number: 1, day_offset: 3, title: 'New', description: '', is_packaging: false, is_transfer: false }];

describe('propagateFermSchedule batches_failed (D-14)', function () {
  function batches() {
    return makeSheet([
      ['batch_id', 'status', 'schedule_id', 'start_date'],
      ['B1', 'primary', 'FS-0001', '2026-09-23'],
      ['B2', 'primary', 'FS-0001', '2026-09-23'],
      ['B3', 'secondary', 'FS-0001', '2026-09-23']
    ]);
  }
  function threeTasks(opts) {
    return makeSheet([TASK_HEADERS.slice(), task('BT-1', 'B1', 1, 'Old'), task('BT-2', 'B2', 1, 'Old'), task('BT-3', 'B3', 1, 'Old')], opts);
  }

  test('a throwing batch is reported and the others still update', function () {
    var tasks = threeTasks({ failOnBatch: 'B2' });
    var res = load({ BatchTasks: tasks, Batches: batches() }).propagateFermSchedule({ schedule_id: 'FS-0001', steps: STEPS }, 'middleware');
    expect(res.ok).toBe(true);
    expect(res.batches_failed).toEqual([{ batch_id: 'B2', error: 'boom' }]);
    expect(res.batches_updated).toBe(2);
    expect(res.tasks_updated).toBe(2);
    expect(tasks.rows[1][3]).toBe('New');
    expect(tasks.rows[2][3]).toBe('Old');
    expect(tasks.rows[3][3]).toBe('New');
  });

  test('no failures -> empty batches_failed and unchanged keys', function () {
    var res = load({ BatchTasks: threeTasks(), Batches: batches() }).propagateFermSchedule({ schedule_id: 'FS-0001', steps: STEPS }, 'middleware');
    expect(res).toEqual({ ok: true, batches_updated: 3, tasks_updated: 3, tasks_created: 0, tasks_removed: 0, batches_failed: [] });
  });

  test('no active batches early return also carries batches_failed []', function () {
    var res = load({ BatchTasks: makeSheet([TASK_HEADERS.slice()]), Batches: batches() }).propagateFermSchedule({ schedule_id: 'FS-0099', steps: STEPS }, 'middleware');
    expect(res.ok).toBe(true);
    expect(res.batches_failed).toEqual([]);
    expect(res.batches_updated).toBe(0);
  });
});
