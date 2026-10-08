'use strict';

/**
 * Regression: ops-backfill must never echo sheet data through header-mismatch rejects.
 *
 * Found in the 86-18 staging rehearsal: the Config tab had no header row, so its first data row
 * (`staff_emails` | `<emails>`) was read as the headers and both cells came back verbatim as
 * `unexpected_header` rejects. The emails were printed to the terminal and written to the rejects
 * JSON file. The tool's contract is "counts, ids, field names, masked emails only".
 */

var buildPlan = require('../../scripts/backfill/ops-backfill').buildOpsBackfillPlan;

var VESSEL_HEADERS = [
  'vessel_id', 'type', 'material', 'capacity_liters', 'status', 'bottom_diameter_cm',
  'top_diameter_cm', 'depth_cm', 'location', 'brand', 'notes'
];
var SCHEDULE_HEADERS = [
  'schedule_id', 'name', 'description', 'category', 'steps', 'is_active', 'created_at',
  'created_by', 'last_updated'
];

function planWith(name, headers) {
  var sheets = {
    Vessels: { headers: VESSEL_HEADERS, rows: [] },
    FermSchedules: { headers: SCHEDULE_HEADERS, rows: [] },
    Config: { headers: ['key', 'value'], rows: [] }
  };
  sheets[name] = { headers: headers, rows: [] };
  return buildPlan({
    workbookSheets: sheets,
    owners: ['owner@example.test'],
    staffEmails: 'owner@example.test',
    timezone: 'America/Vancouver'
  });
}

function unexpectedFields(p) {
  return p.rejects.filter(function (r) { return r.reason === 'unexpected_header'; })
    .map(function (r) { return r.field; });
}

describe('ops-backfill header rejects never echo sheet data', function () {
  test('headerless Config tab: staff_emails row read as headers leaks no email', function () {
    var p = planWith('Config', ['staff_emails', 'alice@example.test, bob@example.test']);
    var out = JSON.stringify(p.rejects);
    expect(out).not.toContain('@');
    expect(out).not.toContain('alice');
    // Still reported: both missing headers and two redacted unexpected headers.
    expect(p.rejects.filter(function (r) { return r.reason === 'missing_header'; })
      .map(function (r) { return r.field; }).sort()).toEqual(['key', 'value']);
    expect(unexpectedFields(p)).toEqual(['<redacted header>', '<redacted header>']);
  });

  test('headerless Config tab: an identifier-like secret value is not echoed either', function () {
    var p = planWith('Config', ['server_token', 'abc123secretvalue']);
    expect(JSON.stringify(p.rejects)).not.toContain('abc123secretvalue');
    expect(JSON.stringify(p.rejects)).not.toContain('server_token');
  });

  test('a stray email-like header on a correctly headed sheet is redacted', function () {
    var p = planWith('Vessels', VESSEL_HEADERS.concat(['someone@example.test']));
    expect(JSON.stringify(p.rejects)).not.toContain('@');
    expect(unexpectedFields(p)).toEqual(['<redacted header>']);
  });

  test('a long or free-text header on a correctly headed sheet is redacted', function () {
    var p = planWith('FermSchedules', SCHEDULE_HEADERS.concat(['Remember: the code is 4471, ask Sam']));
    expect(JSON.stringify(p.rejects)).not.toContain('4471');
    expect(unexpectedFields(p)).toEqual(['<redacted header>']);
  });

  test('a plain identifier header on a correctly headed sheet is still named (useful to fix)', function () {
    var p = planWith('Vessels', VESSEL_HEADERS.concat(['shelf']));
    expect(unexpectedFields(p)).toEqual(['shelf']);
  });
});
