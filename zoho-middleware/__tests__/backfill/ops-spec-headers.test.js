'use strict';

/**
 * Pins the ops backfill specs (Phase 86 Plan 09) to the REAL row-1 headers of the live
 * Vessels, FermSchedules and Config tabs. If the sheet changes, update BOTH this list and the spec.
 */

var vessels = require('../../scripts/backfill/specs/vessels');
var schedules = require('../../scripts/backfill/specs/ops-ferm-schedules');
var config = require('../../scripts/backfill/specs/config');
var specIndex = require('../../scripts/backfill/specs');

var REAL_VESSELS = [
  'vessel_id', 'type', 'material', 'capacity_liters', 'status', 'bottom_diameter_cm',
  'top_diameter_cm', 'depth_cm', 'location', 'brand', 'notes'
];
var REAL_SCHEDULES = [
  'schedule_id', 'name', 'description', 'category', 'steps', 'is_active', 'created_at',
  'created_by', 'last_updated'
];
var REAL_CONFIG = ['key', 'value'];

function headersOf(spec) {
  return spec.columns.map(function (c) { return c.header; });
}

describe('ops backfill specs match the real sheet row 1', function () {
  test('Vessels spec has the 11 real headers, plus one optional label', function () {
    expect(headersOf(vessels)).toEqual(REAL_VESSELS);
    expect(vessels.optionalHeaders).toEqual(['label']);
    expect(vessels.sheet).toBe('Vessels');
  });

  test('FermSchedules spec has the 9 real headers', function () {
    expect(headersOf(schedules)).toEqual(REAL_SCHEDULES);
    expect(schedules.sheet).toBe('FermSchedules');
    expect(schedules.table).toBe('ferm_schedules');
  });

  test('Config spec has key,value', function () {
    expect(headersOf(config)).toEqual(REAL_CONFIG);
  });

  test('none of the ops specs is registered in specs/index.js', function () {
    var names = specIndex.listSpecs();
    expect(names).not.toContain('Vessels');
    expect(names).not.toContain('Config');
    expect(function () { specIndex.getSpec('Vessels'); }).toThrow();
  });
});
