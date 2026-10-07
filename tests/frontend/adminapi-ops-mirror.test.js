'use strict';

// Phase 86-08: mirror_vessel_state / mirror_ferm_schedule_state / mirror_ferm_schedule_delete.
// Fake Sheets runtime (models the Apps Script APIs); the staging rehearsal (86-18) is the real gate.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

function makeSheet(rows) {
  var sheet = {
    rows: rows,
    formats: [],
    writes: [],
    getLastRow: function () { return sheet.rows.length; },
    getLastColumn: function () {
      return sheet.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    },
    getDataRange: function () {
      return { getValues: function () { return sheet.rows.map(function (r) { return r.slice(); }); } };
    },
    appendRow: function (arr) { sheet.writes.push('appendRow'); sheet.rows.push(arr.slice()); },
    deleteRow: function (r) { sheet.writes.push('deleteRow'); sheet.rows.splice(r - 1, 1); },
    getRange: function (r, c) {
      return {
        setNumberFormat: function (f) { sheet.formats.push({ row: r, col: c, format: f }); },
        setValues: function (vals) {
          sheet.writes.push('setValues:' + r + ':' + vals.length);
          for (var i = 0; i < vals.length; i++) {
            if (!sheet.rows[r - 1 + i]) sheet.rows[r - 1 + i] = [];
            for (var j = 0; j < vals[i].length; j++) sheet.rows[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        }
      };
    }
  };
  return sheet;
}

function makeCache() {
  var removed = [];
  return { removed: removed, removeAll: function (k) { removed.push(k); }, remove: function (k) { removed.push([k]); } };
}

function load(sheets, cache) {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var factory = new Function('SpreadsheetApp', 'CacheService', 'LockService', 'Logger',
    src + '\nreturn { mirrorVesselState: mirrorVesselState, mirrorFermScheduleState: mirrorFermScheduleState,' +
    ' mirrorFermScheduleDelete: mirrorFermScheduleDelete };');
  return factory(
    { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return sheets[n] || null; } }; } },
    { getScriptCache: function () { return cache; } },
    { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    { log: function () {} }
  );
}

var VH = ['vessel_id', 'type', 'status', 'capacity_liters', 'notes'];

describe('mirrorVesselState', function () {
  function setup(headers) {
    var sheet = makeSheet([
      (headers || VH).slice(),
      ['PCB-001', 'carboy', 'Available', 20, 'old'],
      ['PCB-002', 'carboy', 'In-Use', 30, 'keep']
    ]);
    if (headers) {
      sheet.rows[1].push('');
      sheet.rows[2].push('');
    }
    // unheaded trailing column
    var extraIdx = sheet.rows[0].length;
    sheet.rows[0][extraIdx] = '';
    sheet.rows[1][extraIdx] = 'EXTRA-1';
    sheet.rows[2][extraIdx] = 'EXTRA-2';
    return { sheet: sheet, extraIdx: extraIdx, api: load({ Vessels: sheet }, makeCache()) };
  }

  test('updates only the headed cells and leaves unheaded column and other rows alone', function () {
    var s = setup();
    var res = s.api.mirrorVesselState({ vessel: { vessel_id: 'PCB-001', type: 'conical', status: 'In-Use', capacity_liters: 25, notes: 'new' } });
    expect(res).toEqual({ ok: true, vessel_id: 'PCB-001', created: false });
    expect(s.sheet.rows[1]).toEqual(['PCB-001', 'conical', 'In-Use', 25, 'new', 'EXTRA-1']);
    expect(s.sheet.rows[2]).toEqual(['PCB-002', 'carboy', 'In-Use', 30, 'keep', 'EXTRA-2']);
  });

  test('new vessel is appended', function () {
    var s = setup();
    var res = s.api.mirrorVesselState({ vessel: { vessel_id: 'PCB-010', type: 'keg', status: 'Available', capacity_liters: 19 } });
    expect(res.created).toBe(true);
    expect(s.sheet.rows).toHaveLength(4);
    expect(s.sheet.rows[3].slice(0, 4)).toEqual(['PCB-010', 'keg', 'Available', 19]);
  });

  test('archived writes Disabled/Retired; non-archived keeps its status', function () {
    var s = setup();
    s.api.mirrorVesselState({ vessel: { vessel_id: 'PCB-001', status: 'Available', archived: true } });
    expect(s.sheet.rows[1][2]).toBe('Disabled/Retired');
    s.api.mirrorVesselState({ vessel: { vessel_id: 'PCB-002', status: 'In-Use', archived: false } });
    expect(s.sheet.rows[2][2]).toBe('In-Use');
  });

  test('label is written only when the sheet has a label header', function () {
    var without = setup();
    expect(without.api.mirrorVesselState({ vessel: { vessel_id: 'PCB-001', label: 'Big one' } }).ok).toBe(true);
    expect(without.sheet.rows[1]).not.toContain('Big one');
    var withLabel = setup(VH.concat(['label']));
    withLabel.api.mirrorVesselState({ vessel: { vessel_id: 'PCB-001', label: 'Big one' } });
    expect(withLabel.sheet.rows[1][5]).toBe('Big one');
  });

  test('validation errors', function () {
    var s = setup();
    expect(s.api.mirrorVesselState({ vessel: { vessel_id: 'pcb-1' } }).error).toBe('invalid_id');
    expect(s.api.mirrorVesselState({}).error).toBe('missing_fields');
    expect(load({}, makeCache()).mirrorVesselState({ vessel: { vessel_id: 'PCB-001' } }).error).toBe('sheet_not_found');
  });

  test('values are written verbatim (no sanitiser)', function () {
    var s = setup();
    s.api.mirrorVesselState({ vessel: { vessel_id: 'PCB-001', notes: '=SUM(A1)' } });
    expect(s.sheet.rows[1][4]).toBe('=SUM(A1)');
  });
});

var SH = ['schedule_id', 'name', 'description', 'category', 'steps', 'is_active', 'created_at', 'created_by', 'last_updated'];

describe('mirrorFermScheduleState / mirrorFermScheduleDelete', function () {
  function setup() {
    var sheet = makeSheet([
      SH.slice(),
      ['FS-0001', 'Ale', '', 'beer', '[]', true, '2026-01-01T00:00:00.000Z', 'a', '2026-01-01T00:00:00.000Z'],
      ['FS-0002', 'Lager', '', 'beer', '[]', true, 'c', 'b', 'd']
    ]);
    var cache = makeCache();
    return { sheet: sheet, cache: cache, api: load({ FermSchedules: sheet }, cache) };
  }
  var sched = function (o) {
    var s = { schedule_id: 'FS-0001', name: 'Ale2', description: 'd', category: 'beer', steps: '[{"step_number":1}]',
      is_active: false, created_at: '2026-01-01T00:00:00.000Z', created_by: 'a', last_updated: '2026-02-02T10:00:00.000Z' };
    Object.keys(o || {}).forEach(function (k) { s[k] = o[k]; });
    return s;
  };

  test('upsert writes boolean is_active, verbatim steps, text timestamps; evicts caches', function () {
    var s = setup();
    var res = s.api.mirrorFermScheduleState({ schedule: sched({ is_active: 'false' }) });
    expect(res).toEqual({ ok: true, schedule_id: 'FS-0001', created: false });
    var row = s.sheet.rows[1];
    expect(row[5]).toBe(false);
    expect(row[4]).toBe('[{"step_number":1}]');
    expect(row[8]).toBe('2026-02-02T10:00:00.000Z');
    expect(s.sheet.formats.map(function (f) { return f.col; }).sort()).toEqual([7, 9]);
    expect(s.sheet.formats.every(function (f) { return f.format === '@'; })).toBe(true);
    expect(s.cache.removed).toContainEqual(['gfs', 'gbi']);
    expect(s.sheet.rows[2][1]).toBe('Lager');
  });

  test('new schedule is created', function () {
    var s = setup();
    var res = s.api.mirrorFermScheduleState({ schedule: sched({ schedule_id: 'FS-0003' }) });
    expect(res.created).toBe(true);
    expect(s.sheet.rows).toHaveLength(4);
    expect(s.sheet.rows[3][0]).toBe('FS-0003');
    expect(s.sheet.rows[3][5]).toBe(false);
  });

  test('validation errors', function () {
    var s = setup();
    expect(s.api.mirrorFermScheduleState({ schedule: sched({ schedule_id: 'x' }) }).error).toBe('invalid_id');
    expect(s.api.mirrorFermScheduleState({}).error).toBe('missing_fields');
  });

  test('delete removes the row, is idempotent, and evicts caches', function () {
    var s = setup();
    expect(s.api.mirrorFermScheduleDelete({ schedule_id: 'FS-0001' })).toEqual({ ok: true, schedule_id: 'FS-0001', deleted: true });
    expect(s.sheet.rows).toHaveLength(2);
    expect(s.cache.removed).toContainEqual(['gfs', 'gbi']);
    expect(s.api.mirrorFermScheduleDelete({ schedule_id: 'FS-0099' }).deleted).toBe(false);
  });
});

describe('no staff mirror action', function () {
  test('adminApi.gs has no staff mirror', function () {
    var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
    expect(/mirror_staff|staff_access/i.test(src)).toBe(false);
  });
});
