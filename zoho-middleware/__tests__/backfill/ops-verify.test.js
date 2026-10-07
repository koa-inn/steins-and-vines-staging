'use strict';

/**
 * Tests for scripts/backfill/ops-verify.js - Phase 86 Plan 14 (DB-05).
 * Pure comparator tests plus one CLI run with a fake pool and a mocked workbook reader.
 */

var fs = require('fs');

jest.mock('../../scripts/backfill/read-xlsx');

var readXlsx = require('../../scripts/backfill/read-xlsx');
var verify = require('../../scripts/backfill/ops-verify');
var compareOps = verify.compareOps;

var STEPS = [{ day_offset: 0, action: 'Pitch' }, { day_offset: 7, action: 'Rack' }];

function pgVessel(over) {
  return Object.assign({
    vessel_id: 'FV-001', type: 'Fermenter', material: 'Steel', capacity_liters: 23, status: 'Empty',
    archived: false, bottom_diameter_cm: '', top_diameter_cm: '', depth_cm: '', location: 'Storage',
    brand: '', notes: '', label: ''
  }, over || {});
}

function sheetVessel(over) {
  return Object.assign({
    vessel_id: 'FV-001', type: 'Fermenter', material: 'Steel', capacity_liters: 23, status: 'Empty',
    bottom_diameter_cm: null, top_diameter_cm: null, depth_cm: null, location: 'Storage',
    brand: null, notes: null, label: null
  }, over || {});
}

function pgSchedule(over) {
  return Object.assign({
    schedule_id: 'FS-0001', name: 'Ale', description: '', category: 'Ale', is_active: true,
    created_by: 'a@x.ca', steps: JSON.stringify(STEPS), steps_parsed: STEPS
  }, over || {});
}

function sheetSchedule(over) {
  return Object.assign({
    schedule_id: 'FS-0001', name: 'Ale', description: '', category: 'Ale', is_active: true,
    created_by: 'a@x.ca', steps: JSON.stringify(STEPS)
  }, over || {});
}

function input(over) {
  over = over || {};
  return {
    pg: Object.assign({
      vessels: [pgVessel()],
      schedules: [pgSchedule()],
      config: [{ key: 'hold_expiry_hours', value: '24' }, { key: 'google_calendar_id', value: 'cal@x' }],
      staffEmails: ['a@x.ca']
    }, over.pg),
    sheet: Object.assign({
      vessels: [sheetVessel()],
      vesselHeaders: ['vessel_id', 'type', 'label'],
      schedules: [sheetSchedule()],
      configRows: [{ key: 'hold_expiry_hours', value: 24 }, { key: 'google_calendar_id', value: 'cal@x' }]
    }, over.sheet),
    envStaff: over.envStaff
  };
}

describe('compareOps', function () {
  it('reports 0 mismatches for identical data', function () {
    var r = compareOps(input());
    expect(r.mismatches).toEqual([]);
    expect(r.labelHeaderPresent).toBe(true);
    expect(r.secretKeysInConfig).toBe(0);
  });

  it('treats 23 vs "23.0", "" vs NULL and padded text as equal', function () {
    var r = compareOps(input({
      sheet: { vessels: [sheetVessel({ capacity_liters: '23.0', location: 'Storage ', notes: '' })] }
    }));
    expect(r.mismatches).toEqual([]);
  });

  it('treats archived vs "Disabled/Retired" as equal and live vs "Disabled/Retired" as a mismatch', function () {
    var ok = compareOps(input({
      pg: { vessels: [pgVessel({ archived: true, status: 'Disabled/Retired' })] },
      sheet: { vessels: [sheetVessel({ status: 'Disabled/Retired' })] }
    }));
    expect(ok.mismatches).toEqual([]);
    var bad = compareOps(input({ sheet: { vessels: [sheetVessel({ status: 'Disabled/Retired' })] } }));
    expect(bad.mismatches).toEqual([{ entity: 'vessel', id: 'FV-001', field: 'status' }]);
  });

  it('does not derive vessel status from batches (a status that disagrees with a batch is not flagged)', function () {
    var r = compareOps(input({
      pg: { vessels: [pgVessel({ status: 'In-Use' })] },
      sheet: { vessels: [sheetVessel({ status: 'In-Use' })], batches: [{ vessel_id: 'FV-001', status: 'Completed' }] }
    }));
    expect(r.mismatches).toEqual([]);
  });

  it('compares steps parsed (key order ignored) and flags a changed day_offset', function () {
    var reordered = JSON.stringify([{ action: 'Pitch', day_offset: 0 }, { action: 'Rack', day_offset: 7 }]);
    expect(compareOps(input({ sheet: { schedules: [sheetSchedule({ steps: reordered })] } })).mismatches).toEqual([]);
    var changed = JSON.stringify([{ day_offset: 1, action: 'Pitch' }, { day_offset: 7, action: 'Rack' }]);
    expect(compareOps(input({ sheet: { schedules: [sheetSchedule({ steps: changed })] } })).mismatches)
      .toEqual([{ entity: 'fermsched', id: 'FS-0001', field: 'steps' }]);
  });

  it('accepts is_active false vs boolean FALSE and the string "FALSE"', function () {
    var pg = { schedules: [pgSchedule({ is_active: false })] };
    expect(compareOps(input({ pg: pg, sheet: { schedules: [sheetSchedule({ is_active: false })] } })).mismatches).toEqual([]);
    expect(compareOps(input({ pg: pg, sheet: { schedules: [sheetSchedule({ is_active: 'FALSE' })] } })).mismatches).toEqual([]);
  });

  it('flags a row missing from the sheet and one missing from Postgres', function () {
    var r = compareOps(input({
      pg: { vessels: [pgVessel(), pgVessel({ vessel_id: 'FV-002' })] },
      sheet: { vessels: [sheetVessel(), sheetVessel({ vessel_id: 'FV-009' })] }
    }));
    expect(r.mismatches).toEqual(expect.arrayContaining([
      { entity: 'vessel', id: 'FV-002', field: 'missing_in_sheet' },
      { entity: 'vessel', id: 'FV-009', field: 'missing_in_postgres' }
    ]));
  });

  it('requires the Vessels label header: absent gives exactly one label_header_missing mismatch', function () {
    var r = compareOps(input({
      pg: { vessels: [pgVessel({ label: 'Big blue' })] },
      sheet: { vesselHeaders: ['vessel_id', 'type'] }
    }));
    expect(r.labelHeaderPresent).toBe(false);
    expect(r.mismatches).toEqual([{ entity: 'vessel', id: '(sheet)', field: 'label_header_missing' }]);
  });

  it('compares labels when the header is present', function () {
    expect(compareOps(input({ pg: { vessels: [pgVessel({ label: '' })] } })).mismatches).toEqual([]);
    var r = compareOps(input({ pg: { vessels: [pgVessel({ label: 'Big blue' })] } }));
    expect(r.mismatches).toEqual([{ entity: 'vessel', id: 'FV-001', field: 'label' }]);
  });

  it('flags a secret-looking Config row without echoing its key or value', function () {
    var r = compareOps(input({
      sheet: {
        configRows: [
          { key: 'hold_expiry_hours', value: 24 }, { key: 'google_calendar_id', value: 'cal@x' },
          { key: 'server_token', value: 'sekrit-value' }
        ]
      }
    }));
    expect(r.secretKeysInConfig).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/sekrit-value|server_token/);
  });

  it('flags a changed imported Config value', function () {
    var r = compareOps(input({
      sheet: { configRows: [{ key: 'hold_expiry_hours', value: 48 }, { key: 'google_calendar_id', value: 'cal@x' }] }
    }));
    expect(r.mismatches).toEqual([{ entity: 'config', id: 'hold_expiry_hours', field: 'value' }]);
  });

  it('staff leg: env member absent from Postgres is a mismatch, Postgres extras are only counted', function () {
    var r = compareOps(input({ envStaff: ['a@x.ca', 'gone@x.ca'], pg: { staffEmails: ['a@x.ca', 'new@x.ca'] } }));
    expect(r.staff).toEqual({ missingFromPg: 1, pgOnly: 1, skipped: false });
    expect(r.mismatches).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/gone@x\.ca|new@x\.ca/);
    var extra = compareOps(input({ envStaff: ['a@x.ca'], pg: { staffEmails: ['a@x.ca', 'new@x.ca'] } }));
    expect(extra.staff.pgOnly).toBe(1);
    expect(extra.mismatches).toEqual([]);
  });

  it('skips the staff leg when no env list is given', function () {
    expect(compareOps(input()).staff.skipped).toBe(true);
  });
});

describe('parseArgs', function () {
  it('accepts --file and refuses URLs and unknown flags', function () {
    expect(verify.parseArgs(['--file=/tmp/a.xlsx']).file).toBe('/tmp/a.xlsx');
    expect(function () { verify.parseArgs(['--db=postgres://u:p@h/d']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { verify.parseArgs(['--nope=1']); }).toThrow(/unknown flag/);
  });
});

describe('runOpsVerify', function () {
  function fakePool() {
    var queries = [];
    var client = {
      query: jest.fn(function (sql) {
        queries.push(sql);
        if (/^(begin transaction read only|commit|rollback)$/.test(sql)) return Promise.resolve({ rows: [] });
        if (/from vessels/.test(sql)) {
          return Promise.resolve({ rows: [{
            vessel_id: 'FV-001', position: 1, label: null, type: 'Fermenter', material: 'Steel',
            capacity_liters: '23', status: 'Empty', archived: false, bottom_diameter_cm: null,
            top_diameter_cm: null, depth_cm: null, location: 'Storage', brand: null, notes: null,
            updated_at: new Date(0)
          }] });
        }
        if (/from ferm_schedules/.test(sql)) return Promise.resolve({ rows: [] });
        if (/from config/.test(sql)) return Promise.resolve({ rows: [] });
        if (/from staff_access/.test(sql)) return Promise.resolve({ rows: [{ email: 'a@x.ca' }] });
        return Promise.reject(new Error('unexpected query: ' + sql));
      }),
      release: jest.fn()
    };
    return { queries: queries, connect: jest.fn(function () { return Promise.resolve(client); }) };
  }

  beforeEach(function () {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    readXlsx.readSheet.mockImplementation(function (file, name) {
      if (name === 'Vessels') {
        return Promise.resolve({
          headers: ['vessel_id', 'type', 'material', 'capacity_liters', 'status', 'location'],
          rows: [{ rowNumber: 2, values: sheetVessel() }]
        });
      }
      return Promise.resolve({ headers: [], rows: [] });
    });
  });

  afterEach(function () {
    jest.restoreAllMocks();
  });

  it('opens a read-only transaction, never writes, exits 4 on mismatches and prints no emails', async function () {
    var pool = fakePool();
    var lines = [];
    var out = await verify.runOpsVerify({ file: '/tmp/fresh.xlsx' }, {
      pool: pool,
      log: function (l) { lines.push(l); },
      env: { BACKFILL_STAFF_EMAILS: 'a@x.ca,gone@x.ca' }
    });
    expect(out.exitCode).toBe(4);
    expect(pool.queries[0]).toBe('begin transaction read only');
    expect(pool.queries.some(function (q) { return /\b(insert|update|delete)\b/i.test(q); })).toBe(false);
    expect(lines).toContain('Vessels label header: MISSING');
    expect(lines.join('\n')).not.toMatch(/@/);
  });
});
