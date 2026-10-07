'use strict';

/**
 * Parity: lib/ferm-schedule-rules.js vs the REAL apps-script/adminApi.gs createFermSchedule —
 * Phase 86 Plan 01 (DB-05). The .gs source is evaluated via `new Function` with a minimal fake
 * Sheets runtime; each shared vector is run through the real function and through the port, and
 * the accept/reject decision must match.
 */

var fs = require('fs');
var path = require('path');
var rules = require('../lib/ferm-schedule-rules');

var src = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8'); // adminApi.gs

function makeFakeSheet() {
  var grid = [['schedule_id', 'name', 'description', 'category', 'steps', 'is_active', 'created_at', 'created_by', 'last_updated']];
  return {
    _grid: grid,
    getLastRow: function () { return grid.length; },
    appendRow: function (v) { grid.push(v.slice()); },
    getRange: function (row, col, numRows) {
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) out.push([(grid[row - 1 + r] || [])[col - 1]]);
          return out;
        }
      };
    }
  };
}

function runGs(payload) {
  var sheet = makeFakeSheet();
  var app = {
    getActiveSpreadsheet: function () {
      return { getSheetByName: function () { return sheet; } };
    }
  };
  var cache = { getScriptCache: function () { return { remove: function () {}, get: function () { return null; }, put: function () {} }; } };
  var logger = { log: function () {} };
  var api = new Function(
    'SpreadsheetApp', 'CacheService', 'Logger',
    src + '\nreturn {createFermSchedule: createFermSchedule};'
  )(app, cache, logger);
  var result = api.createFermSchedule(payload, 'test@example.com');
  return { result: result, rows: sheet._grid.length - 1 };
}

function step(n, offset, packaging) {
  return { step_number: n, day_offset: offset, title: 'Step ' + n, is_packaging: !!packaging };
}

var twoOk = [step(1, 0, false), step(2, 14, true)];

var vectors = [
  { name: 'a) two steps, one packaging', steps: twoOk, accept: true },
  { name: 'b) one step only', steps: [step(1, 0, true)], accept: false },
  { name: 'c) three steps, none packaging', steps: [step(1, 0), step(2, 5), step(3, 9)], accept: false },
  { name: 'd) three steps, two packaging (code uses some)', steps: [step(1, 0, true), step(2, 5), step(3, 9, true)], accept: true },
  { name: 'e) JSON string of (a)', steps: JSON.stringify(twoOk), accept: true },
  { name: 'f) object steps', steps: '{"a":1}', accept: false },
  { name: 'g) not json', steps: 'not json', accept: false },
  { name: 'h) missing steps', steps: undefined, accept: false }
];

function portAccepts(steps) {
  if (steps === undefined || steps === null || steps === '') return false;
  var parsed = rules.parseSteps(steps);
  if (!parsed.ok) return false;
  return rules.validateSteps(parsed.steps).ok === true;
}

describe('ferm-schedule-rules parity with adminApi.gs createFermSchedule', function () {
  vectors.forEach(function (v) {
    it(v.name, function () {
      var gs = runGs({ name: 'Test', steps: v.steps });
      expect(gs.result.ok).toBe(v.accept);
      expect(gs.rows).toBe(v.accept ? 1 : 0);
      expect(portAccepts(v.steps)).toBe(v.accept);
    });
  });

  describe('port-only jsonb safety rules', function () {
    it('rejects non-numeric step_number with invalid_steps', function () {
      var r = rules.validateSteps([{ step_number: 'abc', day_offset: 0, title: 'x' }, { step_number: 2, day_offset: 1, title: 'y', is_packaging: true }]);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid_steps');
    });
    it('rejects non-string title with invalid_steps', function () {
      var r = rules.validateSteps([{ step_number: 1, day_offset: 0, title: 5 }, { step_number: 2, day_offset: 1, title: 'y', is_packaging: true }]);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid_steps');
    });
    it('too few and no packaging get distinct codes', function () {
      expect(rules.validateSteps([step(1, 0, true)]).error).toBe('too_few_steps');
      expect(rules.validateSteps([step(1, 0), step(2, 1)]).error).toBe('no_packaging_step');
    });
  });

  describe('live-shaped fixtures', function () {
    [2, 3, 4, 5, 6, 7, 8].forEach(function (count) {
      it('fixture with ' + count + ' steps is accepted by port and .gs', function () {
        var steps = [];
        for (var i = 1; i <= count; i++) steps.push(step(i, i * 3, i === count));
        expect(rules.validateSteps(steps).ok).toBe(true);
        expect(runGs({ name: 'F', steps: steps }).result.ok).toBe(true);
      });
    });
    [2, 4, 6, 8].forEach(function (count) {
      it('fixture B with ' + count + ' steps (string form) is accepted', function () {
        var steps = [];
        for (var i = 1; i <= count; i++) steps.push(step(i, i, i === 2));
        expect(portAccepts(JSON.stringify(steps))).toBe(true);
      });
    });
  });

  it('sanitizeScheduleText delegates to recipe-rules sanitizeInput', function () {
    var rr = require('../lib/recipe-rules');
    expect(rules.sanitizeScheduleText('<script>x</script> hi')).toEqual(rr.sanitizeInput('<script>x</script> hi'));
  });
});
