'use strict';

/**
 * Pure planner tests for buildOpsBackfillPlan - Phase 86 Plan 09 Task 1 (DB-05, SC1).
 * Synthetic data only. Fixtures use readSheet()-shaped rows ({rowNumber, values}).
 */

var opsBackfill = require('../../scripts/backfill/ops-backfill');
var buildPlan = opsBackfill.buildOpsBackfillPlan;

var TZ = 'America/Vancouver';
var VESSEL_HEADERS = [
  'vessel_id', 'type', 'material', 'capacity_liters', 'status', 'bottom_diameter_cm',
  'top_diameter_cm', 'depth_cm', 'location', 'brand', 'notes'
];
var SCHEDULE_HEADERS = [
  'schedule_id', 'name', 'description', 'category', 'steps', 'is_active', 'created_at',
  'created_by', 'last_updated'
];
var CONFIG_HEADERS = ['key', 'value'];

var GOOD_STEPS = JSON.stringify([
  { step_number: 1, day_offset: 0, title: 'Pitch' },
  { step_number: 2, day_offset: 14, title: 'Package', is_packaging: true }
]);

function vessel(rowNumber, overrides) {
  var base = {
    vessel_id: 'FV-001', type: 'Fermenter', material: 'Steel', capacity_liters: 60,
    status: 'Empty', bottom_diameter_cm: 30, top_diameter_cm: 40, depth_cm: 70,
    location: 'Cellar', brand: 'Acme', notes: ''
  };
  Object.assign(base, overrides || {});
  return { rowNumber: rowNumber, values: base };
}

function schedule(rowNumber, overrides) {
  var base = {
    schedule_id: 'FS-0001', name: 'Pale', description: '', category: 'Beer', steps: GOOD_STEPS,
    is_active: true, created_at: '2026-01-15T08:00:00Z', created_by: 'maker@example.test',
    last_updated: '2026-01-16T08:00:00Z'
  };
  Object.assign(base, overrides || {});
  return { rowNumber: rowNumber, values: base };
}

function cfg(rowNumber, key, value) {
  return { rowNumber: rowNumber, values: { key: key, value: value } };
}

function cleanVessels() {
  return [
    vessel(2, { vessel_id: 'FV-001' }),
    vessel(3, { vessel_id: 'FV-002', status: 'In-Use' }),
    vessel(4, { vessel_id: 'BR-010', status: 'Disabled/Retired' }),
    vessel(5, { vessel_id: 'FV-003', location: 'Mobile, Wine Racking ' }),
    vessel(6, { vessel_id: 'FV-004', capacity_liters: '' })
  ];
}

function cleanSchedules() {
  return [
    schedule(2, { schedule_id: 'FS-0001' }),
    schedule(3, { schedule_id: 'FS-0002', is_active: 'FALSE' }),
    schedule(4, { schedule_id: 'FS-0011' })
  ];
}

function cleanConfig() {
  return [
    cfg(2, 'hold_expiry_hours', '48'),
    cfg(3, 'google_calendar_id', 'cal-id@group.calendar.example.test'),
    cfg(4, 'unrelated_setting', 'x')
  ];
}

function plan(overrides) {
  var input = {
    workbookSheets: {
      Vessels: { headers: VESSEL_HEADERS, rows: cleanVessels() },
      FermSchedules: { headers: SCHEDULE_HEADERS, rows: cleanSchedules() },
      Config: { headers: CONFIG_HEADERS, rows: cleanConfig() }
    },
    owners: ['a@x.co'],
    staffEmails: 'a@x.co, b@y.co',
    timezone: TZ
  };
  return buildPlan(Object.assign(input, overrides || {}));
}

function withSheet(name, headers, rows) {
  var sheets = {
    Vessels: { headers: VESSEL_HEADERS, rows: cleanVessels() },
    FermSchedules: { headers: SCHEDULE_HEADERS, rows: cleanSchedules() },
    Config: { headers: CONFIG_HEADERS, rows: cleanConfig() }
  };
  sheets[name] = { headers: headers, rows: rows };
  return plan({ workbookSheets: sheets });
}

function reasonsOf(p) {
  return p.rejects.map(function (r) { return r.sheet + ':' + r.field + ':' + r.reason; });
}

describe('buildOpsBackfillPlan - clean fixture', function () {
  test('0 rejects, positions in sheet order, ids unchanged', function () {
    var p = plan();
    expect(p.rejects).toEqual([]);
    expect(p.vessels.map(function (v) { return v.vessel_id; })).toEqual(
      ['FV-001', 'FV-002', 'BR-010', 'FV-003', 'FV-004']
    );
    expect(p.vessels.map(function (v) { return v.position; })).toEqual([1, 2, 3, 4, 5]);
    expect(p.schedules.map(function (s) { return s.schedule_id; })).toEqual(['FS-0001', 'FS-0002', 'FS-0011']);
    expect(p.seeds).toEqual({ fermScheduleMax: 11, vesselCount: 5 });
  });

  test('retired vessel is archived with status Empty; In-Use kept; location trimmed', function () {
    var p = plan();
    var retired = p.vessels[2];
    expect(retired.archived).toBe(true);
    expect(retired.status).toBe('Empty');
    expect(p.vessels[1].status).toBe('In-Use');
    expect(p.vessels[1].archived).toBe(false);
    expect(p.vessels[3].location).toBe('Mobile, Wine Racking');
  });

  test('Disabled alone also archives; numerics become strings or null', function () {
    var p = withSheet('Vessels', VESSEL_HEADERS, [vessel(2, { status: 'Disabled' }), vessel(3, { vessel_id: 'FV-002', capacity_liters: '' })]);
    expect(p.rejects).toEqual([]);
    expect(p.vessels[0].archived).toBe(true);
    expect(p.vessels[0].capacity_liters).toBe('60');
    expect(p.vessels[1].capacity_liters).toBeNull();
  });

  test('schedules: steps parsed to an array, booleans real, timestamps ISO', function () {
    var p = plan();
    expect(Array.isArray(p.schedules[0].steps)).toBe(true);
    expect(p.schedules[0].is_active).toBe(true);
    expect(p.schedules[1].is_active).toBe(false);
    expect(p.schedules[0].created_at).toBe('2026-01-15T08:00:00.000Z');
    expect(p.schedules[0].updated_at).toBe('2026-01-16T08:00:00.000Z');
  });

  test('config imports exactly hold_expiry_hours and google_calendar_id', function () {
    var p = plan();
    expect(p.config.map(function (c) { return c.key; }).sort()).toEqual(['google_calendar_id', 'hold_expiry_hours']);
  });
});

describe('buildOpsBackfillPlan - vessel rejects', function () {
  test('duplicate vessel id', function () {
    var p = withSheet('Vessels', VESSEL_HEADERS, [vessel(2), vessel(3)]);
    expect(reasonsOf(p)).toContain('Vessels:vessel_id:duplicate_id');
  });

  test('malformed id pcb-1', function () {
    var p = withSheet('Vessels', VESSEL_HEADERS, [vessel(2, { vessel_id: 'pcb-1' })]);
    expect(reasonsOf(p)).toContain('Vessels:vessel_id:invalid_id');
  });

  test('unknown status Broken', function () {
    var p = withSheet('Vessels', VESSEL_HEADERS, [vessel(2, { status: 'Broken' })]);
    expect(reasonsOf(p)).toContain('Vessels:status:invalid_status');
  });

  test('capacity abc', function () {
    var p = withSheet('Vessels', VESSEL_HEADERS, [vessel(2, { capacity_liters: 'abc' })]);
    expect(reasonsOf(p)).toContain('Vessels:capacity_liters:invalid_number');
  });
});

describe('buildOpsBackfillPlan - vessel label header', function () {
  var LABELLED = VESSEL_HEADERS.concat(['label']);

  test('present: trimmed value imported, blank becomes NULL', function () {
    var rows = [
      vessel(2, { vessel_id: 'FV-001', label: 'Big blue' }),
      vessel(3, { vessel_id: 'FV-002', label: '  ' }),
      vessel(4, { vessel_id: 'FV-003', label: '' })
    ];
    var p = withSheet('Vessels', LABELLED, rows);
    expect(p.rejects).toEqual([]);
    expect(p.vessels.map(function (v) { return v.label; })).toEqual(['Big blue', null, null]);
  });

  test('absent: every label is NULL', function () {
    var p = plan();
    expect(p.vessels.every(function (v) { return v.label === null; })).toBe(true);
  });

  test('any other extra header is a header mismatch reject', function () {
    var p = withSheet('Vessels', VESSEL_HEADERS.concat(['shelf']), [vessel(2)]);
    expect(reasonsOf(p)).toContain('Vessels:shelf:unexpected_header');
    expect(p.vessels).toEqual([]);
  });
});

describe('buildOpsBackfillPlan - schedule rejects', function () {
  test('id FS-12 (too short)', function () {
    var p = withSheet('FermSchedules', SCHEDULE_HEADERS, [schedule(2, { schedule_id: 'FS-12' })]);
    expect(reasonsOf(p)).toContain('FermSchedules:schedule_id:invalid_id');
  });

  test('is_active blank rejects; TRUE string accepted', function () {
    var blank = withSheet('FermSchedules', SCHEDULE_HEADERS, [schedule(2, { is_active: '' })]);
    expect(reasonsOf(blank)).toContain('FermSchedules:is_active:required');
    var upper = withSheet('FermSchedules', SCHEDULE_HEADERS, [schedule(2, { is_active: 'TRUE' })]);
    expect(upper.rejects).toEqual([]);
    expect(upper.schedules[0].is_active).toBe(true);
  });

  test('steps: not json, one step, no packaging', function () {
    var notJson = withSheet('FermSchedules', SCHEDULE_HEADERS, [schedule(2, { steps: 'not json' })]);
    expect(reasonsOf(notJson)).toContain('FermSchedules:steps:invalid_json');

    var one = JSON.stringify([{ step_number: 1, day_offset: 0, title: 'x', is_packaging: true }]);
    expect(reasonsOf(withSheet('FermSchedules', SCHEDULE_HEADERS, [schedule(2, { steps: one })])))
      .toContain('FermSchedules:steps:too_few_steps');

    var noPack = JSON.stringify([
      { step_number: 1, day_offset: 0, title: 'a' },
      { step_number: 2, day_offset: 1, title: 'b' }
    ]);
    expect(reasonsOf(withSheet('FermSchedules', SCHEDULE_HEADERS, [schedule(2, { steps: noPack })])))
      .toContain('FermSchedules:steps:no_packaging_step');
  });

  test('duplicate schedule id', function () {
    var p = withSheet('FermSchedules', SCHEDULE_HEADERS, [schedule(2), schedule(3)]);
    expect(reasonsOf(p)).toContain('FermSchedules:schedule_id:duplicate_id');
  });
});

describe('buildOpsBackfillPlan - config', function () {
  test('server_token is hard-rejected and its value never echoed', function () {
    var p = withSheet('Config', CONFIG_HEADERS, [
      cfg(2, 'hold_expiry_hours', '48'),
      cfg(3, 'server_token', 'SUPERSECRETVALUE')
    ]);
    expect(reasonsOf(p)).toContain('Config:key:secret_key_forbidden');
    expect(JSON.stringify(p.rejects)).not.toContain('SUPERSECRETVALUE');
    expect(p.config.map(function (c) { return c.key; })).toEqual(['hold_expiry_hours']);
  });

  test('blank value for an imported key is a reject', function () {
    var p = withSheet('Config', CONFIG_HEADERS, [cfg(2, 'hold_expiry_hours', '')]);
    expect(reasonsOf(p)).toContain('Config:value:required');
  });
});

describe('buildOpsBackfillPlan - header mismatches', function () {
  test('missing header on each sheet', function () {
    expect(reasonsOf(withSheet('Vessels', VESSEL_HEADERS.slice(1), [])))
      .toContain('Vessels:vessel_id:missing_header');
    expect(reasonsOf(withSheet('FermSchedules', SCHEDULE_HEADERS.slice(0, 8), [])))
      .toContain('FermSchedules:last_updated:missing_header');
    expect(reasonsOf(withSheet('Config', ['key'], [])))
      .toContain('Config:value:missing_header');
  });

  test('extra header on FermSchedules and Config', function () {
    expect(reasonsOf(withSheet('FermSchedules', SCHEDULE_HEADERS.concat(['extra']), [])))
      .toContain('FermSchedules:extra:unexpected_header');
    expect(reasonsOf(withSheet('Config', CONFIG_HEADERS.concat(['extra']), [])))
      .toContain('Config:extra:unexpected_header');
  });
});

describe('buildOpsBackfillPlan - staff', function () {
  test('Railway list plus owners; roles assigned', function () {
    var p = plan({ staffEmails: 'A@x.co, b@y.co', owners: ['a@x.co'] });
    expect(p.staff).toEqual([{ email: 'a@x.co', role: 'owner' }, { email: 'b@y.co', role: 'staff' }]);
  });

  test('owners empty is a plan error', function () {
    expect(plan({ owners: [] }).error).toBe('owners_required');
    expect(plan({ owners: undefined }).error).toBe('owners_required');
  });

  test('an owner not in staffEmails is still added as owner', function () {
    var p = plan({ staffEmails: 'b@y.co', owners: ['z@q.co'] });
    expect(p.staff).toEqual(expect.arrayContaining([{ email: 'z@q.co', role: 'owner' }, { email: 'b@y.co', role: 'staff' }]));
    expect(p.staff.length).toBe(2);
  });

  test('Config staff_emails extras are counted, masked, not imported', function () {
    var p = withSheet('Config', CONFIG_HEADERS, cleanConfig().concat([cfg(5, 'staff_emails', 'a@x.co, c@z.co')]));
    expect(p.rejects).toEqual([]);
    expect(p.notImportedConfigStaffCount).toBe(1);
    expect(p.staff.map(function (s) { return s.email; })).not.toContain('c@z.co');
    expect(p.config.map(function (c) { return c.key; })).not.toContain('staff_emails');
  });

  test('invalid email in the list is a reject without echoing it', function () {
    var p = plan({ staffEmails: 'not-an-email, b@y.co' });
    expect(reasonsOf(p)).toContain('staff:email:invalid_email');
    expect(JSON.stringify(p.rejects)).not.toContain('not-an-email');
  });
});

describe('buildOpsBackfillPlan - output hygiene', function () {
  test('no reject or summary string carries a raw email or config value', function () {
    var rows = cleanConfig().concat([cfg(5, 'staff_emails', 'leak@z.co'), cfg(6, 'api_key', 'RAWVALUE')]);
    var p = withSheet('Config', CONFIG_HEADERS, rows);
    var serialized = JSON.stringify({ rejects: p.rejects, seeds: p.seeds, n: p.notImportedConfigStaffCount });
    expect(serialized).not.toContain('leak@z.co');
    expect(serialized).not.toContain('RAWVALUE');
    expect(serialized).not.toContain('maker@example.test');
    expect(opsBackfill.maskEmail('leak@z.co')).toBe('l***@z.co');
  });
});
