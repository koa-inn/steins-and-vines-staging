'use strict';

// Phase 86-03 Task 3: createBatch prefers trusted schedule_steps_json on the server_token path.
//
// Loads the REAL apps-script/adminApi.gs via `new Function` with a fake Sheets runtime
// (SpreadsheetApp, LockService, Utilities, Session, CacheService, PropertiesService,
// ContentService injected as parameters that shadow the Apps Script globals). Nothing in
// adminApi.gs is stubbed except checkAuthorization (staff-OAuth path). This is a model of the
// Apps Script APIs, not proof Google's runtime agrees; the staging rehearsal (86-18) is the gate.

var fs = require('fs');
var path = require('path');

var SRC = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8');

var BATCH_HEADERS = [
  'batch_id', 'status', 'product_sku', 'product_name', 'customer_id', 'customer_name',
  'customer_email', 'start_date', 'schedule_id', 'schedule_snapshot', 'vessel_id', 'shelf_id',
  'bin_id', 'notes', 'access_token', 'reservation_id', 'created_at', 'created_by',
  'last_updated', 'completed_by', 'source', 'zoho_so_number', 'fermentation_started_at',
  'completed_at', 'customer_firstname', 'customer_lastname'
];
var TASK_HEADERS = [
  'task_id', 'batch_id', 'step_number', 'title', 'description', 'day_offset', 'due_date',
  'is_packaging', 'is_transfer', 'completed', 'completed_at', 'completed_by', 'notes', 'last_updated'
];
var TOKEN = 'abcdef0123456789abcdef0123456789';

function makeSheet(headers, rows) {
  var grid = [headers.slice()].concat((rows || []).map(function (r) { return r.slice(); }));
  return {
    _grid: grid,
    getLastColumn: function () { return grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0); },
    getLastRow: function () { return grid.length; },
    appendRow: function (v) { grid.push(v.slice()); },
    deleteRow: function (n) { grid.splice(n - 1, 1); },
    getDataRange: function () {
      return { getValues: function () { return grid.map(function (r) { return r.slice(); }); } };
    },
    getRange: function (row, col, numRows, numCols) {
      if (numRows === undefined) {
        return {
          setValue: function (v) {
            if (!grid[row - 1]) grid[row - 1] = [];
            grid[row - 1][col - 1] = v;
          },
          getValue: function () { return (grid[row - 1] || [])[col - 1]; }
        };
      }
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var src = grid[row - 1 + r] || [];
            var line = [];
            for (var c = 0; c < numCols; c++) line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
            out.push(line);
          }
          return out;
        }
      };
    }
  };
}

function batchRow(id, vessel) {
  var r = BATCH_HEADERS.map(function () { return ''; });
  r[0] = id; r[1] = 'primary'; r[10] = vessel; r[14] = TOKEN;
  return r;
}

function taskRow(id, batchId, transfer) {
  var r = TASK_HEADERS.map(function () { return ''; });
  r[0] = id; r[1] = batchId; r[7] = 'FALSE'; r[8] = transfer ? 'TRUE' : 'FALSE'; r[9] = 'FALSE';
  return r;
}

var STEPS = [
  { step_number: 1, title: 'Start', day_offset: 0 },
  { step_number: 2, title: 'Rack', day_offset: 7, is_transfer: true },
  { step_number: 3, title: 'Bottle', day_offset: -1, is_packaging: true }
];

function build() {
  var sheets = {
    Vessels: makeSheet(
      ['vessel_id', 'status', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      [['PCB-009', 'Empty'], ['PCB-010', 'In-Use']]
    ),
    Batches: makeSheet(BATCH_HEADERS, [batchRow('SV-B-000001', 'PCB-010')]),
    BatchTasks: makeSheet(TASK_HEADERS, [taskRow('BT-000001', 'SV-B-000001', true)]),
    VesselHistory: makeSheet(['vh_id', 'batch_id', 'vessel_id', 'shelf_id', 'bin_id', 'moved_at', 'by', 'note']),
    PlatoReadings: makeSheet(['reading_id', 'batch_id']),
    FermSchedules: makeSheet(
      ['schedule_id', 'name', 'description', 'category', 'steps'],
      [['FS-0001', 'Std', '', '', JSON.stringify(STEPS)]]
    )
  };
  var uuid = 0;
  var ss = { getSheetByName: function (n) { return sheets[n] || null; } };
  var factory = new Function(
    'SpreadsheetApp', 'LockService', 'Utilities', 'Session', 'CacheService', 'PropertiesService',
    'ContentService',
    SRC + '\ncheckAuthorization = function () { return { authorized: true, email: "oauth@example.com" }; };' +
      '\nreturn doPost;'
  );
  var doPost = factory(
    { getActiveSpreadsheet: function () { return ss; } },
    { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    {
      getUuid: function () { uuid++; return '0000000000000000000000000000000' + uuid.toString(16); },
      formatDate: function (d) { return d.toISOString().slice(0, 10); }
    },
    { getScriptTimeZone: function () { return 'UTC'; } },
    { getScriptCache: function () { return { removeAll: function () {}, remove: function () {}, get: function () { return null; }, put: function () {} }; } },
    { getScriptProperties: function () { return { getProperty: function () { return 'SECRET'; } }; } },
    {
      MimeType: { JSON: 'json' },
      createTextOutput: function (s) { return { _s: s, setMimeType: function () { return this; } }; }
    }
  );
  return {
    sheets: sheets,
    post: function (payload, mode) {
      var p = Object.assign({}, payload);
      if (mode !== 'staff' && mode !== 'batch') p.server_token = 'SECRET';
      return JSON.parse(doPost({ postData: { contents: JSON.stringify(p) } })._s);
    },
    vesselStatus: function (id) {
      var row = sheets.Vessels._grid.filter(function (r) { return r[0] === id; })[0];
      return row && row[1];
    }
  };
}

var CREATE = {
  action: 'create_batch', product_sku: 'SKU1', customer_name: 'Pat', schedule_id: 'FS-0012',
  start_date: '2026-10-01'
};
var TRUSTED = [
  { step_number: 1, title: 'Alpha', day_offset: 0 },
  { step_number: 2, title: 'Beta', day_offset: 5 },
  { step_number: 3, title: 'Gamma', day_offset: -1, is_packaging: true }
];

function titles(h) {
  return h.sheets.BatchTasks._grid.slice(2).map(function (r) { return r[3]; });
}

describe('createBatch trusted schedule steps', function () {
  test('server_token uses supplied steps when the schedule is absent from the sheet', function () {
    var h = build();
    var res = h.post(Object.assign({ schedule_steps_json: JSON.stringify(TRUSTED) }, CREATE));
    expect(res.ok).toBe(true);
    expect(res.tasks_created).toBe(3);
    expect(titles(h)).toEqual(['Alpha', 'Beta', 'Gamma']);
    var batchRow = h.sheets.Batches._grid[h.sheets.Batches._grid.length - 1];
    expect(JSON.parse(batchRow[9])).toEqual(TRUSTED);
  });

  test('unparseable steps -> invalid_steps and no batch row appended', function () {
    var h = build();
    var before = h.sheets.Batches._grid.length;
    var res = h.post(Object.assign({ schedule_steps_json: '{not json' }, CREATE));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_steps');
    expect(h.sheets.Batches._grid.length).toBe(before);
    var res2 = h.post(Object.assign({ schedule_steps_json: '{"a":1}' }, CREATE));
    expect(res2.error).toBe('invalid_steps');
  });

  test('without schedule_steps_json the sheet lookup (and not_found) is unchanged', function () {
    var h = build();
    var res = h.post(CREATE);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_found');
    expect(res.message).toBe('Schedule not found: FS-0012');
    var ok = h.post(Object.assign({}, CREATE, { schedule_id: 'FS-0001' }));
    expect(ok.ok).toBe(true);
    expect(titles(h)).toEqual(['Start', 'Rack', 'Bottle']);
  });

  test('staff-OAuth ignores schedule_steps_json and uses the sheet', function () {
    var h = build();
    var res = h.post(Object.assign({ schedule_steps_json: JSON.stringify(TRUSTED) }, CREATE), 'staff');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_found');
    var ok = h.post(Object.assign({ schedule_steps_json: JSON.stringify(TRUSTED) }, CREATE, { schedule_id: 'FS-0001' }), 'staff');
    expect(ok.ok).toBe(true);
    expect(titles(h)).toEqual(['Start', 'Rack', 'Bottle']);
  });
});
