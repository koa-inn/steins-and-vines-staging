'use strict';

// Phase 80, RESEARCH.md Pitfall 1: addWaitlistEntry (apps-script/adminApi.gs) writes a new row
// via a LITERAL POSITIONAL `appendRow([...])` array. That was safe while the header order and
// the array-literal order happened to match (Phase 78's 7 columns), but D-17 adds six more
// columns AFTER `notes` — and nothing in ensureWaitlistSheet's header-driven column-lookup
// contract guarantees a sheet's physical column order matches the literal array order. If a
// human ever reorders the header row (hand-edit, copy/paste, a future migration), the positional
// write silently lands values in the WRONG columns with no error.
//
// This suite proves the fix behaviourally: inject a fake Sheets runtime whose Waitlist tab has
// the 13 D-17 header names in a DELIBERATELY SHUFFLED order (position/customer_name sit between
// category and status), call addWaitlistEntry with a real payload, and assert — resolving every
// value BY HEADER NAME, never by array index — that it landed in its own named column.
//
// Harness pattern copied from tests/frontend/adminapi-waitlist-ensure-sheet.test.js
// (makeFakeSheet/makeFakeSpreadsheetApp), extended here with getLastRow/getDataRange (so the
// real sheetToObjects — not a stub — naturally returns [] for a header-only sheet, keeping the
// D-06 dedupe branch out of play) and getRange(row, col).setValue() (so a header-driven write,
// once implemented, has somewhere to land).

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

// --- Fake Sheets runtime -------------------------------------------------------------------

function makeFakeSheet(rows) {
  var grid = rows ? rows.map(function (r) { return r.slice(); }) : [];
  var calls = { setFontWeight: [], setFrozenRows: [], appendRow: [], setValue: [] };

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

    appendRow: function (values) {
      calls.appendRow.push(values.slice());
      grid.push(values.slice());
    },

    getRange: function (row, col, numRows, numCols) {
      var isSingleCell = numRows === undefined && numCols === undefined;
      return {
        getValues: function () {
          var nr = numRows === undefined ? 1 : numRows;
          var nc = numCols === undefined ? 1 : numCols;
          if (nc < 1) {
            throw new Error('The number of columns in the range must be at least 1.');
          }
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
        },
        setFontWeight: function (weight) {
          calls.setFontWeight.push({ row: row, col: col, numRows: numRows, numCols: numCols, weight: weight });
          return this;
        }
      };
      // eslint-disable-next-line no-unreachable
      void isSingleCell;
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

// SHUFFLED 13 D-17 header names: `position` and `customer_name` deliberately sit between
// `category` and `status`, so a positional appendRow (which assumes the ORIGINAL 7-column order)
// would misplace every value from `category` onward.
var SHUFFLED_HEADERS = [
  'id', 'email', 'category', 'position', 'customer_name', 'status',
  'signed_up_at', 'mailerlite_synced', 'notes',
  'zoho_contact_id', 'customer_phone', 'recipe_ids', 'contacted_at'
];

function loadAddWaitlistEntry(spreadsheetApp, utilities) {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var logged = [];
  var logger = { log: function (msg) { logged.push(String(msg)); } };
  // SpreadsheetApp and Utilities are declared as parameters here, so they shadow the Apps
  // Script globals of the same name that adminApi.gs references as free variables.
  var factory = new Function(
    'SpreadsheetApp',
    'Utilities',
    'Logger',
    src + '\nreturn {' +
      'addWaitlistEntry: (typeof addWaitlistEntry !== "undefined" ? addWaitlistEntry : undefined),' +
      'WAITLIST_SHEET_NAME: (typeof WAITLIST_SHEET_NAME !== "undefined" ? WAITLIST_SHEET_NAME : undefined)' +
      '};'
  );
  var api = factory(spreadsheetApp, utilities, logger);
  api._logged = logged;
  return api;
}

function fakeUtilities() {
  return { getUuid: function () { return 'fake-uuid-0001'; } };
}

describe('addWaitlistEntry — header-driven write (Phase 80, RESEARCH.md Pitfall 1)', function () {
  test('every value lands in its NAMED column even when the header row is shuffled', function () {
    var sheet = makeFakeSheet([SHUFFLED_HEADERS.slice()]);
    var app = makeFakeSpreadsheetApp({ Waitlist: sheet });
    var api = loadAddWaitlistEntry(app, fakeUtilities());

    // Header-only sheet -> sheetToObjects(WAITLIST_SHEET_NAME) naturally returns [] (getLastRow()
    // <= 1), so the D-06 dedupe branch is never taken; this exercises the NEW-row append path.
    var result = api.addWaitlistEntry({ email: 'new@example.com', category: 'beer' });

    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();

    expect(sheet._calls.appendRow.length).toBe(1);
    var appended = sheet._calls.appendRow[0];

    function byName(name) {
      var idx = SHUFFLED_HEADERS.indexOf(name);
      expect(idx).toBeGreaterThan(-1);
      return appended[idx];
    }

    expect(byName('email')).toBe('new@example.com');
    expect(byName('category')).toBe('beer');
    expect(byName('status')).toBe('waiting');
    expect(byName('signed_up_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byName('mailerlite_synced')).toBe(false);
    expect(byName('notes')).toBe('');
    expect(byName('zoho_contact_id')).toBe('');
    expect(byName('customer_name')).toBe('');
    expect(byName('customer_phone')).toBe('');
    expect(byName('recipe_ids')).toBe('');
    expect(byName('position')).toBe('');
    expect(byName('contacted_at')).toBe('');
    expect(byName('id')).toBeTruthy();
  });
});
