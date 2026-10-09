'use strict';

// Phase 87-04: mirror_batch_state / mirror_batch_delete / export_batch_tabs and the D-12 notice
// helpers in apps-script/adminApi.gs. Fake Sheets runtime; the staging rehearsal (87-18) is the
// real gate.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

function makeSheet(rows) {
  var sheet = {
    rows: rows,
    notes: {},
    protections: [],
    getLastRow: function () { return sheet.rows.length; },
    getLastColumn: function () {
      return sheet.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    },
    getDataRange: function () {
      return { getValues: function () { return sheet.rows.map(function (r) { return r.slice(); }); } };
    },
    appendRow: function (arr) { sheet.rows.push(arr.slice()); },
    deleteRow: function (r) { sheet.rows.splice(r - 1, 1); },
    getRange: function (r, c, nr, nc) {
      return {
        getValues: function () {
          var out = [];
          for (var i = 0; i < (nr || 1); i++) {
            var row = [];
            for (var j = 0; j < (nc || 1); j++) {
              var v = (sheet.rows[r - 1 + i] || [])[c - 1 + j];
              row.push(v === undefined ? '' : v);
            }
            out.push(row);
          }
          return out;
        },
        setNumberFormat: function () {},
        setNote: function (n) { sheet.notes[r + ':' + c] = n; },
        setValues: function (vals) {
          for (var i = 0; i < vals.length; i++) {
            if (!sheet.rows[r - 1 + i]) sheet.rows[r - 1 + i] = [];
            for (var j = 0; j < vals[i].length; j++) sheet.rows[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        }
      };
    },
    protect: function () {
      var p = {
        desc: '', warn: false,
        setDescription: function (d) { p.desc = d; return p; },
        getDescription: function () { return p.desc; },
        setWarningOnly: function (w) { p.warn = w; return p; },
        remove: function () { sheet.protections.splice(sheet.protections.indexOf(p), 1); }
      };
      sheet.protections.push(p);
      return p;
    },
    getProtections: function () { return sheet.protections.slice(); }
  };
  return sheet;
}

function makeCache() {
  var removed = [];
  return { removed: removed, removeAll: function (k) { removed.push(k); } };
}

var EXPORTS = 'return { mirrorBatchState: mirrorBatchState, mirrorBatchDelete: mirrorBatchDelete,' +
  ' exportBatchTabs: exportBatchTabs, setupBatchMirrorNotices: setupBatchMirrorNotices,' +
  ' removeBatchMirrorNotices: removeBatchMirrorNotices, doPost: doPost };';

function load(sheets, cache, lock, extra) {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var factory = new Function('SpreadsheetApp', 'CacheService', 'LockService', 'Logger', 'PropertiesService',
    'ContentService', src + '\n' + EXPORTS);
  return factory(
    {
      ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
      getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return sheets[n] || null; } }; }
    },
    { getScriptCache: function () { return cache; } },
    { getScriptLock: function () { return lock || { waitLock: function () {}, releaseLock: function () {} }; } },
    { log: function () {} },
    { getScriptProperties: function () { return { getProperty: function () { return 'tok'; } }; } },
    extra || null
  );
}

var BH = ['batch_id', 'status', 'bin_id', 'target_volume_L', 'start_date', 'is_kit', 'notes', 'last_updated'];
var TH = ['task_id', 'batch_id', 'step_number', 'completed', 'due_date'];
var RH = ['reading_id', 'batch_id', 'reading_at', 'degrees_plato', 'notes'];
var HH = ['history_id', 'batch_id', 'vessel_id', 'transferred_at'];

function fixture() {
  var sheets = {
    Batches: makeSheet([BH.slice(), ['SV-B-000002', 'primary', 3, 20, '2026-01-01', false, 'other', 'x']]),
    BatchTasks: makeSheet([TH.slice(), ['BT-000900', 'SV-B-000002', 1, false, '2026-01-02']]),
    PlatoReadings: makeSheet([RH.slice(), ['PR-000900', 'SV-B-000002', 't', 1.01, 'o']]),
    VesselHistory: makeSheet([HH.slice(), ['VH-000900', 'SV-B-000002', 'PCB-001', 't']])
  };
  var cache = makeCache();
  return { sheets: sheets, cache: cache, api: load(sheets, cache) };
}

function bundle(extra) {
  var b = {
    batch: { batch_id: 'SV-B-000001', status: 'primary', bin_id: 7, target_volume_L: 23, start_date: '2026-02-03',
      is_kit: true, notes: '<b>hi</b>', last_updated: '2026-02-03T00:00:00.000Z' },
    tasks: [
      { task_id: 'BT-000001', batch_id: 'SV-B-000001', step_number: 1, completed: false, due_date: '2026-02-04' },
      { task_id: 'BT-000002', batch_id: 'SV-B-000001', step_number: 2, completed: true, due_date: '2026-02-05' },
      { task_id: 'BT-000003', batch_id: 'SV-B-000001', step_number: 3, completed: false, due_date: '' }
    ],
    readings: [{ reading_id: 'PR-000001', batch_id: 'SV-B-000001', reading_at: '2026-02-04T00:00:00.000Z', degrees_plato: 12, notes: 'a' }],
    history: [{ history_id: 'VH-000001', batch_id: 'SV-B-000001', vessel_id: 'PCB-001', transferred_at: '2026-02-03T00:00:00.000Z' }]
  };
  Object.keys(extra || {}).forEach(function (k) { b[k] = extra[k]; });
  return b;
}

describe('mirrorBatchState', function () {
  test('new batch is appended under header names with typed values; children appended', function () {
    var f = fixture();
    var res = f.api.mirrorBatchState(bundle());
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    var row = f.sheets.Batches.rows[2];
    expect(row).toEqual(['SV-B-000001', 'primary', 7, 23, '2026-02-03', true, '<b>hi</b>', '2026-02-03T00:00:00.000Z']);
    expect(typeof row[2]).toBe('number');
    expect(typeof row[5]).toBe('boolean');
    expect(f.sheets.BatchTasks.rows).toHaveLength(5);
    expect(f.sheets.PlatoReadings.rows).toHaveLength(3);
    expect(f.sheets.VesselHistory.rows).toHaveLength(3);
  });

  test('lowercase target_volume_l key also lands in the target_volume_L column', function () {
    var f = fixture();
    var b = bundle();
    delete b.batch.target_volume_L;
    b.batch.target_volume_l = 18;
    f.api.mirrorBatchState(b);
    expect(f.sheets.Batches.rows[2][3]).toBe(18);
  });

  test('second call removes dropped task, updates reading in place, leaves other batches alone', function () {
    var f = fixture();
    f.api.mirrorBatchState(bundle());
    var b2 = bundle();
    b2.tasks = b2.tasks.slice(0, 2);
    b2.readings[0].degrees_plato = 9.5;
    var res = f.api.mirrorBatchState(b2);
    expect(res.created).toBe(false);
    var taskIds = f.sheets.BatchTasks.rows.slice(1).map(function (r) { return r[0]; });
    expect(taskIds).toEqual(['BT-000900', 'BT-000001', 'BT-000002']);
    expect(f.sheets.PlatoReadings.rows).toHaveLength(3);
    expect(f.sheets.PlatoReadings.rows[2][3]).toBe(9.5);
    expect(f.sheets.Batches.rows[1][6]).toBe('other');
    expect(f.sheets.VesselHistory.rows[1][0]).toBe('VH-000900');
  });

  test('empty children array deletes that batch child rows only', function () {
    var f = fixture();
    f.api.mirrorBatchState(bundle());
    f.api.mirrorBatchState(bundle({ readings: [] }));
    expect(f.sheets.PlatoReadings.rows.map(function (r) { return r[0]; })).toEqual(['reading_id', 'PR-000900']);
  });

  test('a child is always written under the bundle batch id', function () {
    var f = fixture();
    var b = bundle();
    b.tasks[0].batch_id = 'SV-B-000002';
    f.api.mirrorBatchState(b);
    expect(f.sheets.BatchTasks.rows[2][1]).toBe('SV-B-000001');
  });

  test('validation errors write nothing', function () {
    var f = fixture();
    expect(f.api.mirrorBatchState({ batch: { batch_id: 'X1' } })).toEqual({ ok: false, error: 'invalid_id' });
    expect(f.api.mirrorBatchState({})).toEqual({ ok: false, error: 'missing_fields' });
    var bad = bundle();
    bad.tasks[1].task_id = 'ZZ-1';
    expect(f.api.mirrorBatchState(bad).error).toBe('invalid_id');
    expect(f.sheets.Batches.rows).toHaveLength(2);
    expect(f.sheets.BatchTasks.rows).toHaveLength(2);
  });

  test('evicts batch caches and sheet caches', function () {
    var f = fixture();
    f.api.mirrorBatchState(bundle());
    var keys = [].concat.apply([], f.cache.removed);
    ['gb:SV-B-000001', 'gbp:SV-B-000001', 'gbl', 'gtu', 'gbds', 'gbi', 'gfs'].forEach(function (k) {
      expect(keys).toContain(k);
    });
  });

  test('lock is released when a write throws', function () {
    var released = 0;
    var sheets = fixture().sheets;
    sheets.Batches.getDataRange = function () { throw new Error('boom'); };
    var api = load(sheets, makeCache(), { waitLock: function () {}, releaseLock: function () { released++; } });
    expect(function () { api.mirrorBatchState(bundle()); }).toThrow('boom');
    expect(released).toBe(1);
  });
});

describe('mirrorBatchDelete', function () {
  test('removes the batch and its children, not other batches', function () {
    var f = fixture();
    f.api.mirrorBatchState(bundle());
    var res = f.api.mirrorBatchDelete({ batch_id: 'SV-B-000001' });
    expect(res).toEqual({ ok: true, batch_id: 'SV-B-000001', deleted: 1 });
    expect(f.sheets.Batches.rows).toHaveLength(2);
    expect(f.sheets.BatchTasks.rows).toHaveLength(2);
    expect(f.sheets.PlatoReadings.rows).toHaveLength(2);
    expect(f.sheets.VesselHistory.rows).toHaveLength(2);
    expect(f.sheets.Batches.rows[1][0]).toBe('SV-B-000002');
  });

  test('unknown id is a no-op success; bad id rejected; caches evicted', function () {
    var f = fixture();
    expect(f.api.mirrorBatchDelete({ batch_id: 'SV-B-000099' }).deleted).toBe(0);
    expect(f.api.mirrorBatchDelete({ batch_id: 'nope' }).error).toBe('invalid_id');
    expect([].concat.apply([], f.cache.removed)).toContain('gb:SV-B-000099');
  });
});

describe('exportBatchTabs', function () {
  test('returns header-keyed arrays and skips rows with blank id', function () {
    var f = fixture();
    f.sheets.BatchTasks.rows.push(['', 'SV-B-000002', 5, false, '']);
    var res = f.api.exportBatchTabs();
    expect(res.ok).toBe(true);
    expect(res.data.Batches).toHaveLength(1);
    expect(res.data.Batches[0].batch_id).toBe('SV-B-000002');
    expect(res.data.BatchTasks).toHaveLength(1);
    expect(res.data.PlatoReadings).toHaveLength(1);
    expect(res.data.VesselHistory).toHaveLength(1);
    expect(res.data.headers.BatchTasks).toEqual(TH);
  });
});

describe('dispatch', function () {
  test('wrong server_token is unauthorized for all three actions and nothing is written', function () {
    var f = fixture();
    var captured = [];
    var api = load(f.sheets, f.cache, null, {
      MimeType: { JSON: 'json' },
      createTextOutput: function (t) {
        captured.push(JSON.parse(t));
        return { setMimeType: function () { return this; } };
      }
    });
    ['mirror_batch_state', 'mirror_batch_delete', 'export_batch_tabs'].forEach(function (action) {
      var body = Object.assign(bundle(), { action: action, batch_id: 'SV-B-000002', server_token: 'bad' });
      api.doPost({ postData: { contents: JSON.stringify(body) } });
    });
    expect(captured).toHaveLength(3);
    captured.forEach(function (c) { expect(c.error).toBe('unauthorized'); });
    expect(f.sheets.Batches.rows).toHaveLength(2);
  });

  test('actions are dispatched only inside the server_token branch; export is not a staff read', function () {
    var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
    var tokenCheck = src.indexOf('payload.server_token !== storedToken');
    expect(tokenCheck).toBeGreaterThan(-1);
    ['mirror_batch_state', 'mirror_batch_delete', 'export_batch_tabs'].forEach(function (a) {
      expect(src.indexOf("action === '" + a + "'")).toBeGreaterThan(tokenCheck);
      expect(src.indexOf("case '" + a + "'")).toBe(-1);
    });
  });

  test('existing mirror_vessel_state dispatch is untouched', function () {
    var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
    expect(src).toContain("if (action === 'mirror_vessel_state') {");
  });
});

describe('batch mirror notices (D-12)', function () {
  var tabs = ['Batches', 'BatchTasks', 'PlatoReadings', 'VesselHistory'];

  test('setup adds a mirror-only note and one warning-only protection per tab; rows unchanged', function () {
    var f = fixture();
    var before = tabs.map(function (t) { return JSON.stringify(f.sheets[t].rows); });
    f.api.setupBatchMirrorNotices();
    tabs.forEach(function (t, i) {
      expect(f.sheets[t].notes['1:1']).toContain('mirror only');
      expect(f.sheets[t].protections).toHaveLength(1);
      expect(f.sheets[t].protections[0].warn).toBe(true);
      expect(f.sheets[t].protections[0].desc).toBe('Phase 87 batch mirror');
      expect(JSON.stringify(f.sheets[t].rows)).toBe(before[i]);
    });
  });

  test('running setup twice does not duplicate protections', function () {
    var f = fixture();
    f.api.setupBatchMirrorNotices();
    f.api.setupBatchMirrorNotices();
    tabs.forEach(function (t) { expect(f.sheets[t].protections).toHaveLength(1); });
  });

  test('remove clears notes and only the Phase 87 protections', function () {
    var f = fixture();
    f.api.setupBatchMirrorNotices();
    var other = f.sheets.Batches.protect();
    other.setDescription('someone else');
    f.api.removeBatchMirrorNotices();
    tabs.forEach(function (t) { expect(f.sheets[t].notes['1:1']).toBe(''); });
    expect(f.sheets.Batches.protections).toEqual([other]);
    expect(f.sheets.BatchTasks.protections).toHaveLength(0);
  });

  test('notice functions are not HTTP-dispatchable', function () {
    var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
    expect(src).not.toMatch(/['"]setupBatchMirrorNotices['"]/);
    expect(src).not.toMatch(/['"]removeBatchMirrorNotices['"]/);
  });
});
