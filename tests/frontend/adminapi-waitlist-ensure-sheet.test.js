'use strict';

// Behavioural regression coverage for ensureWaitlistSheet's bootstrap paths.
//
// The sibling suite (adminapi-waitlist-pure.test.js) deliberately asserts on ensureWaitlistSheet
// by SOURCE SHAPE only, because apps-script/adminApi.gs has no local Sheets runtime. This suite
// closes that specific gap by injecting a fake SpreadsheetApp/Logger as `new Function` parameters
// (they shadow the Apps Script globals of the same name), so the bootstrap branches can actually
// be executed and observed.
//
// Regression under test: a `Waitlist` tab that already EXISTS but is completely EMPTY — created
// by hand, or left behind by a partial earlier setup run. The original implementation skipped the
// header write (because `sheet` was truthy) and then called
// `sheet.getRange(1, 1, 1, sheet.getLastColumn())` with getLastColumn() === 0, which Apps Script
// rejects with "The number of columns in the range must be at least 1." That threw out of
// setupWaitlist AND out of every live waitlist write path, since they all call this function.
//
// WHAT THIS SUITE STILL CANNOT PROVE: the fake is a model of the Sheets API, not the real thing.
// It fixes the shape of getLastColumn/getRange/appendRow that this bug turned on; it does not
// prove Google's runtime agrees. The live probe in plan 78-04 remains the real gate.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

// --- Fake Sheets runtime -------------------------------------------------------------------

function makeFakeSheet(rows) {
  var grid = rows ? rows.map(function (r) { return r.slice(); }) : [];
  var calls = { setFontWeight: [], setFrozenRows: [], appendRow: [] };

  return {
    _grid: grid,
    _calls: calls,

    // Last column containing content anywhere in the sheet. 0 for a wholly empty sheet — the
    // exact value that made the original getRange call throw.
    getLastColumn: function () {
      return grid.reduce(function (max, row) {
        return Math.max(max, row.length);
      }, 0);
    },

    appendRow: function (values) {
      calls.appendRow.push(values.slice());
      grid.push(values.slice());
    },

    getRange: function (row, col, numRows, numCols) {
      if (numCols < 1) {
        // Mirror the real Apps Script error this regression is about.
        throw new Error('The number of columns in the range must be at least 1.');
      }
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var src = grid[row - 1 + r] || [];
            var line = [];
            for (var c = 0; c < numCols; c++) {
              line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
            }
            out.push(line);
          }
          return out;
        },
        setFontWeight: function (weight) {
          calls.setFontWeight.push({ row: row, col: col, numRows: numRows, numCols: numCols, weight: weight });
          return this;
        }
      };
    },

    setFrozenRows: function (n) {
      calls.setFrozenRows.push(n);
    }
  };
}

function makeFakeSpreadsheetApp(sheetsByName) {
  var sheets = sheetsByName || {};
  var inserted = [];

  return {
    _inserted: inserted,
    _sheets: sheets,
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (name) {
          return Object.prototype.hasOwnProperty.call(sheets, name) ? sheets[name] : null;
        },
        insertSheet: function (name) {
          inserted.push(name);
          var s = makeFakeSheet([]);
          sheets[name] = s;
          return s;
        }
      };
    }
  };
}

function loadEnsureWaitlistSheet(spreadsheetApp) {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var logged = [];
  var logger = {
    log: function (msg) { logged.push(String(msg)); }
  };
  // SpreadsheetApp and Logger are declared as parameters here, so they shadow the Apps Script
  // globals that adminApi.gs references as free variables.
  var factory = new Function(
    'SpreadsheetApp',
    'Logger',
    src + '\nreturn {' +
      'ensureWaitlistSheet: (typeof ensureWaitlistSheet !== "undefined" ? ensureWaitlistSheet : undefined),' +
      'WAITLIST_SHEET_NAME: (typeof WAITLIST_SHEET_NAME !== "undefined" ? WAITLIST_SHEET_NAME : undefined)' +
      '};'
  );
  var api = factory(spreadsheetApp, logger);
  api._logged = logged;
  return api;
}

// Phase 80, D-17: extended from Phase 78's original 7-column contract to 13 — the six new names
// are APPENDED after `notes`, never inserted between the original seven (RESEARCH.md Pitfall 1 /
// ensureWaitlistSheet's own JSDoc). Updated here (not left on the stale 7-column contract) because
// this suite exists to prove ensureWaitlistSheet's REAL, current required-header behaviour —
// leaving it asserting the superseded 7-column shape would make it silently wrong, not neutral
// (same rationale as the phase's documented waitlist-admin-proxy.test.js flip, CLAUDE.md rule 10
// exception).
var HEADERS = [
  'id', 'email', 'category', 'status', 'signed_up_at', 'mailerlite_synced', 'notes',
  'zoho_contact_id', 'customer_name', 'customer_phone', 'recipe_ids', 'position', 'contacted_at'
];

// --- Tests ---------------------------------------------------------------------------------

describe('ensureWaitlistSheet — bootstrap branches (behavioural, fake Sheets runtime)', function () {
  test('creates the tab with the 13 bold, frozen headers when it is absent', function () {
    var app = makeFakeSpreadsheetApp({});
    var api = loadEnsureWaitlistSheet(app);

    var result = api.ensureWaitlistSheet();

    expect(result.ok).toBe(true);
    expect(app._inserted).toEqual([api.WAITLIST_SHEET_NAME]);

    var sheet = app._sheets[api.WAITLIST_SHEET_NAME];
    expect(sheet._grid[0]).toEqual(HEADERS);
    expect(sheet._calls.setFrozenRows).toEqual([1]);
    expect(sheet._calls.setFontWeight.length).toBe(1);
    expect(sheet._calls.setFontWeight[0].weight).toBe('bold');
    expect(sheet._calls.setFontWeight[0].numCols).toBe(HEADERS.length);
  });

  // THE REGRESSION. Before the fix this threw
  // "The number of columns in the range must be at least 1."
  test('initialises an existing but completely EMPTY tab instead of throwing on getLastColumn() === 0', function () {
    var empty = makeFakeSheet([]);
    var app = makeFakeSpreadsheetApp({ Waitlist: empty });
    var api = loadEnsureWaitlistSheet(app);

    expect(empty.getLastColumn()).toBe(0);

    var result = api.ensureWaitlistSheet();

    expect(result.ok).toBe(true);
    expect(empty._grid[0]).toEqual(HEADERS);
    expect(empty._calls.setFrozenRows).toEqual([1]);
    expect(empty._calls.setFontWeight[0].weight).toBe('bold');
    // It must NOT have created a second tab to work around the empty one.
    expect(app._inserted).toEqual([]);
  });

  test('leaves a correctly-headered existing tab untouched and reports its column map', function () {
    var existing = makeFakeSheet([
      HEADERS.slice(),
      ['ml-0001', 'a@example.com', 'beer', 'waiting', '2026-08-14T17:05:00.000Z', 'TRUE', '', '', '', '', '', '', '']
    ]);
    var app = makeFakeSpreadsheetApp({ Waitlist: existing });
    var api = loadEnsureWaitlistSheet(app);

    var result = api.ensureWaitlistSheet();

    expect(result.ok).toBe(true);
    expect(existing._calls.appendRow).toEqual([]);
    expect(existing._calls.setFrozenRows).toEqual([]);
    expect(existing._grid.length).toBe(2);
    expect(result.col.id).toBe(1);
    // `notes` is column 7 (the last of the original Phase 78 seven); the six D-17 additions are
    // appended after it, so `contacted_at` — not `notes` — is now the true last column.
    expect(result.col.notes).toBe(7);
    expect(result.col.contacted_at).toBe(HEADERS.length);
  });

  test('still fails closed on drifted headers rather than repairing them', function () {
    // All 13 D-17 required names present EXCEPT `signed_up_at` and `notes` — isolates the
    // "two original columns missing" case from the unrelated "six D-17 columns don't exist yet"
    // case, which is covered separately in adminapi-waitlist-fields.test.js / append-headers.
    var drifted = makeFakeSheet([[
      'id', 'email', 'category', 'status', 'mailerlite_synced',
      'zoho_contact_id', 'customer_name', 'customer_phone', 'recipe_ids', 'position', 'contacted_at'
    ]]);
    var app = makeFakeSpreadsheetApp({ Waitlist: drifted });
    var api = loadEnsureWaitlistSheet(app);

    var result = api.ensureWaitlistSheet();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('waitlist_unavailable');
    expect(result.missing).toEqual(['signed_up_at', 'notes']);
    // Fail-closed means it did not rewrite the header row.
    expect(drifted._grid[0]).toEqual([
      'id', 'email', 'category', 'status', 'mailerlite_synced',
      'zoho_contact_id', 'customer_name', 'customer_phone', 'recipe_ids', 'position', 'contacted_at'
    ]);
    expect(drifted._calls.appendRow).toEqual([]);
  });
});
