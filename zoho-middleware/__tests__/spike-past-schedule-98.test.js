'use strict';

var spike = require('../scripts/spike-past-schedule-98');

function row(id, start, snap, planned, status) {
  return { batch_id: id, status: status || 'primary', start_date: start, schedule_snapshot: snap, planned_days: planned };
}

describe('snapshotMax', function () {
  test('empty and unparsable are null', function () {
    expect(spike.snapshotMax('')).toBeNull();
    expect(spike.snapshotMax('not json')).toBeNull();
    expect(spike.snapshotMax(null)).toBeNull();
  });
  test('top-level array', function () {
    expect(spike.snapshotMax('[{"day_offset":0},{"day_offset":45}]')).toBe(45);
  });
  test('object with steps and string offsets', function () {
    expect(spike.snapshotMax('{"steps":[{"day_offset":"27"}]}')).toBe(27);
  });
});

describe('summarise', function () {
  var today = '2026-11-05';
  var snap30 = '[{"day_offset":30}]';

  test('only primary/secondary count as active', function () {
    var s = spike.summarise([row('A', '2026-10-01', snap30, 30), row('B', '2026-10-01', snap30, 30, 'completed')], today);
    expect(s.active).toBe(1);
  });

  test('no schedule is counted and excluded from past counts', function () {
    var s = spike.summarise([row('A', '2020-01-01', '', null)], today);
    expect(s.noSchedule).toBe(1);
    expect(s.byPlannedDays.any).toBe(0);
    expect(s.bySnapshot.any).toBe(0);
    expect(s.mismatches).toEqual([]);
  });

  test('grace edges: over 14 is plus7 only, over 15 is plus14', function () {
    // start 2026-09-01 -> 65 days to today; plan 51 => over 14; plan 50 => over 15
    var s = spike.summarise([
      row('E14', '2026-09-01', '[{"day_offset":51}]', 51),
      row('E15', '2026-09-01', '[{"day_offset":50}]', 50)
    ], today);
    expect(s.byPlannedDays.plus7).toBe(2);
    expect(s.byPlannedDays.plus14).toBe(1);
    expect(s.bySnapshot.plus14).toBe(1);
  });

  test('mismatch lists batch_id with both plan lengths', function () {
    var s = spike.summarise([row('M', '2026-09-01', '[{"day_offset":40}]', 30)], today);
    expect(s.mismatches).toEqual([{ batch_id: 'M', planned_days: 30, snapshot_max: 40 }]);
    expect(s.byPlannedDays.plus14).toBe(1);
    expect(s.bySnapshot.plus14).toBe(1);
  });

  test('flat90 counts batches started more than 90 days ago', function () {
    var s = spike.summarise([row('F', '2026-06-01', snap30, 30), row('G', '2026-10-30', snap30, 30)], today);
    expect(s.flat90).toBe(1);
  });
});
