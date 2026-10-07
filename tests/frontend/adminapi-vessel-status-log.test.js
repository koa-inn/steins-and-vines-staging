'use strict';

// Phase 86-03 Task 2: request-scoped vessel status delta log + vessel_sheet_write gate.
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
  action: 'create_batch', product_sku: 'SKU1', customer_name: 'Pat', schedule_id: 'FS-0001',
  start_date: '2026-10-01', vessel_id: 'PCB-009'
};

describe('vessel status delta log', function () {
  test('create_batch reports In-Use and writes the cell', function () {
    var h = build();
    var res = h.post(Object.assign({ collect_vessel_status: true }, CREATE));
    expect(res.ok).toBe(true);
    expect(res.vessel_status_changes).toEqual([{ vessel_id: 'PCB-009', status: 'In-Use' }]);
    expect(h.vesselStatus('PCB-009')).toBe('In-Use');
  });

  test('vessel_sheet_write:false records but does not write the cell', function () {
    var h = build();
    var res = h.post(Object.assign({ collect_vessel_status: true, vessel_sheet_write: false }, CREATE));
    expect(res.vessel_status_changes).toEqual([{ vessel_id: 'PCB-009', status: 'In-Use' }]);
    expect(h.vesselStatus('PCB-009')).toBe('Empty');
  });

  test('without collect_vessel_status the response shape is unchanged', function () {
    var h = build();
    var res = h.post(CREATE);
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('vessel_status_changes');
    expect(h.vesselStatus('PCB-009')).toBe('In-Use');
  });

  test('delete_batch reports Empty', function () {
    var h = build();
    var res = h.post({ action: 'delete_batch', batch_id: 'SV-B-000001', collect_vessel_status: true });
    expect(res.ok).toBe(true);
    expect(res.vessel_status_changes).toEqual([{ vessel_id: 'PCB-010', status: 'Empty' }]);
    expect(h.vesselStatus('PCB-010')).toBe('Empty');
  });

  test('a request that never calls setVesselStatus has no vessel_status_changes', function () {
    var h = build();
    var res = h.post({ action: 'get_next_cert_number', collect_vessel_status: true });
    expect(res).not.toHaveProperty('vessel_status_changes');
  });

  test('log is reset per request', function () {
    var h = build();
    var first = h.post(Object.assign({ collect_vessel_status: true }, CREATE));
    expect(first.vessel_status_changes).toHaveLength(1);
    var second = h.post({ action: 'delete_batch', batch_id: 'SV-B-000001', collect_vessel_status: true });
    expect(second.vessel_status_changes).toEqual([{ vessel_id: 'PCB-010', status: 'Empty' }]);
    var third = h.post({ action: 'get_next_cert_number', collect_vessel_status: true });
    expect(third).not.toHaveProperty('vessel_status_changes');
  });

  test('staff-OAuth path ignores collect and sheetWrite fields', function () {
    var h = build();
    var res = h.post(Object.assign({ collect_vessel_status: true, vessel_sheet_write: false }, CREATE), 'staff');
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('vessel_status_changes');
    expect(h.vesselStatus('PCB-009')).toBe('In-Use');
  });

  test('unknown vessel id: no cell write but the change is still logged', function () {
    var h = build();
    var res = h.post(Object.assign({ collect_vessel_status: true }, CREATE, { vessel_id: 'ZZZ-1' }));
    expect(res.vessel_status_changes).toEqual([{ vessel_id: 'ZZZ-1', status: 'In-Use' }]);
    expect(h.vesselStatus('PCB-009')).toBe('Empty');
    expect(h.vesselStatus('PCB-010')).toBe('In-Use');
  });

  test('batch_token transfer reports the change; vessel_sheet_write is ignored', function () {
    var h = build();
    var res = h.post({
      action: 'update_batch_task', batch_id: 'SV-B-000001', batch_token: TOKEN, task_id: 'BT-000001',
      updates: { completed: true }, collect_vessel_status: true, vessel_sheet_write: false
    }, 'batch');
    expect(res.ok).toBe(true);
    expect(res.vessel_status_changes).toEqual([{ vessel_id: 'PCB-010', status: 'Empty' }]);
    expect(h.vesselStatus('PCB-010')).toBe('Empty');
  });
});
