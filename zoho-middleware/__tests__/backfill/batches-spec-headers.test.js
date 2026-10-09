'use strict';

/**
 * Pins the four Phase 87 batch specs to the REAL row-1 headers of the live Batches (33),
 * BatchTasks (14), PlatoReadings (9) and VesselHistory (8) tabs. If a sheet changes, update BOTH
 * this list and the spec. spec-headers.test.js (Phase 83 rehearsal) is intentionally untouched.
 */

var batches = require('../../scripts/backfill/specs/batches');
var tasks = require('../../scripts/backfill/specs/batch-tasks');
var readings = require('../../scripts/backfill/specs/plato-readings-final');
var history = require('../../scripts/backfill/specs/vessel-history-final');
var specIndex = require('../../scripts/backfill/specs');

var REAL_BATCHES = [
  'batch_id', 'status', 'product_sku', 'product_name', 'customer_id', 'customer_name', 'customer_email',
  'start_date', 'schedule_id', 'schedule_snapshot', 'vessel_id', 'shelf_id', 'bin_id', 'notes',
  'access_token', 'reservation_id', 'created_at', 'created_by', 'last_updated', 'last_regenerated_at',
  'source', 'zoho_so_number', 'fermentation_started_at', 'completed_at', 'customer_firstname',
  'customer_lastname', 'recipe_id', 'customer_phone', 'target_volume_L', 'scale_factor',
  'recipe_snapshot', 'bottling_invite_sent_at', 'bottling_invite_email'
];
var REAL_TASKS = [
  'task_id', 'batch_id', 'step_number', 'title', 'description', 'day_offset', 'due_date',
  'is_packaging', 'is_transfer', 'completed', 'completed_at', 'completed_by', 'notes', 'last_updated'
];
var REAL_READINGS = [
  'reading_id', 'batch_id', 'timestamp', 'degrees_plato', 'notes', 'recorded_by', 'created_at',
  'temperature', 'ph'
];
var REAL_HISTORY = [
  'history_id', 'batch_id', 'vessel_id', 'shelf_id', 'bin_id', 'transferred_at', 'transferred_by', 'notes'
];

function headersOf(spec) {
  return spec.columns.map(function (c) { return c.header; });
}

describe('batch backfill specs match the real sheet row 1', function () {
  test('Batches spec has the 33 real headers', function () {
    expect(REAL_BATCHES).toHaveLength(33);
    expect(headersOf(batches)).toEqual(REAL_BATCHES);
    expect(batches.sheet).toBe('Batches');
    expect(batches.table).toBe('batches');
  });

  test('BatchTasks spec has the 14 real headers', function () {
    expect(headersOf(tasks)).toEqual(REAL_TASKS);
    expect(tasks.sheet).toBe('BatchTasks');
  });

  test('PlatoReadings spec has the 9 real headers', function () {
    expect(headersOf(readings)).toEqual(REAL_READINGS);
    expect(readings.sheet).toBe('PlatoReadings');
  });

  test('VesselHistory spec has the 8 real headers', function () {
    expect(headersOf(history)).toEqual(REAL_HISTORY);
    expect(history.sheet).toBe('VesselHistory');
  });

  test('header differences from DDL names are exactly the two known ones', function () {
    expect(batches.columns.filter(function (c) { return c.name !== c.header; }).map(function (c) { return c.name; }))
      .toEqual(['target_volume_l']);
    expect(readings.columns.filter(function (c) { return c.name !== c.header; }).map(function (c) { return c.name; }))
      .toEqual(['reading_at']);
    expect(tasks.columns.every(function (c) { return c.name === c.header; })).toBe(true);
    expect(history.columns.every(function (c) { return c.name === c.header; })).toBe(true);
  });

  test('DDL column names match 0005_batches.sql', function () {
    var fs = require('fs');
    var path = require('path');
    var sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '0005_batches.sql'), 'utf8');
    [[batches, 'batches'], [tasks, 'batch_tasks'], [readings, 'plato_readings'], [history, 'vessel_history']]
      .forEach(function (pair) {
        var block = sql.split('create table ' + pair[1] + ' (')[1].split('\n);')[0];
        pair[0].columns.forEach(function (c) {
          expect(block).toMatch(new RegExp('\\n  ' + c.name + ' '));
        });
      });
  });

  test('none of the batch specs is registered in specs/index.js', function () {
    var names = specIndex.listSpecs();
    ['Batches', 'BatchTasks'].forEach(function (n) {
      expect(names).not.toContain(n);
      expect(function () { specIndex.getSpec(n); }).toThrow();
    });
  });
});
