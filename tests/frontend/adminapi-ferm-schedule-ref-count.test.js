'use strict';

// Phase 86-08 (D-15): ferm_schedule_ref_count counts every batch (any status) fresh from the sheet.

var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8');

function load(rows, reads) {
  var sheet = {
    getLastRow: function () { return rows.length; },
    getDataRange: function () { reads.n++; return { getValues: function () { return rows.map(function (r) { return r.slice(); }); } }; }
  };
  var cacheTouched = { n: 0 };
  var factory = new Function('SpreadsheetApp', 'CacheService', 'Logger',
    src + '\nreturn { fermScheduleRefCount: fermScheduleRefCount };');
  var api = factory(
    { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return n === 'Batches' ? sheet : null; } }; } },
    { getScriptCache: function () { cacheTouched.n++; return { get: function () { return 'STALE'; }, put: function () {} }; } },
    { log: function () {} }
  );
  api._cacheTouched = cacheTouched;
  return api;
}

describe('fermScheduleRefCount', function () {
  var rows = [
    ['batch_id', 'status', 'schedule_id'],
    ['B1', 'active', 'FS-0001'],
    ['B2', 'complete', 'FS-0001'],
    ['B3', 'cancelled', 'FS-0001'],
    ['B4', 'primary', 'FS-0002']
  ];

  test('counts every status, zero for unused, invalid_id for malformed', function () {
    var api = load(rows, { n: 0 });
    expect(api.fermScheduleRefCount({ schedule_id: 'FS-0001' })).toEqual({ ok: true, count: 3 });
    expect(api.fermScheduleRefCount({ schedule_id: 'FS-0002' })).toEqual({ ok: true, count: 1 });
    expect(api.fermScheduleRefCount({ schedule_id: 'FS-0009' })).toEqual({ ok: true, count: 0 });
    expect(api.fermScheduleRefCount({ schedule_id: 'bad' })).toEqual({ ok: false, error: 'invalid_id' });
  });

  test('reads the sheet fresh every call, never via cache', function () {
    var reads = { n: 0 };
    var api = load(rows, reads);
    api.fermScheduleRefCount({ schedule_id: 'FS-0001' });
    api.fermScheduleRefCount({ schedule_id: 'FS-0001' });
    expect(reads.n).toBe(2);
    expect(api._cacheTouched.n).toBe(0);
  });
});
