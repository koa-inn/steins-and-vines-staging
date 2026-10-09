'use strict';

/**
 * Phase 87-17 (T-87-17-01): static single-issuer invariant. After the Postgres flip the batch store
 * is the only issuer of batch ids and batch writes. No file under routes/ or lib/ may name a batch
 * Apps Script action outside an explicit allow-map (proxy allowlists, the proxy op mapping, and the
 * sheets-mode fall-through call sites), and each fall-through site must sit next to a batchStore()
 * call so the postgres branch is taken first. Adding a stray call anywhere else fails this test.
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var DIRS = ['routes', 'lib'];
var ACTIONS = [
  'create_batch', 'update_batch', 'get_batches',
  'recipe_batch_ref_count', 'ferm_schedule_ref_count', 'propagate_ferm_schedule'
];

// Remove // and block comments while leaving string literals intact.
function stripComments(src) {
  var out = '';
  var i = 0;
  var n = src.length;
  var quote = null;
  while (i < n) {
    var c = src[i];
    var d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

// A "use" is the action as a whole quoted literal ('x') or an object key (x:). Prose inside log
// message strings is not a use.
function findUses(code, action) {
  var re = new RegExp('([\'"`]' + action + '[\'"`])|(\\b' + action + '\\s*:)', 'g');
  var hits = [];
  var m;
  while ((m = re.exec(code))) hits.push({ action: action, index: m.index });
  return hits;
}

function listFiles() {
  var files = [];
  DIRS.forEach(function (dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(function (f) {
      if (/\.js$/.test(f)) files.push(dir + '/' + f);
    });
  });
  return files.sort();
}

// Expected number of uses per file. Anything not listed must have zero.
var ALLOW = {
  // ADMIN_PROXY_ACTIONS / ADMIN_PANEL_PROXY_ACTIONS allowlists, plus sheets-mode scan-invoices
  // (get_batches), reassign (update_batch) and bottling-invite stamp (2x update_batch).
  'routes/pos.js': null,
  // ACTION_TO_OP and WRITE_ACTIONS maps
  'lib/batch-proxy.js': null,
  // ops-proxy action mapping (propagate) and the create_batch schedule-injection branch
  'lib/ops-proxy.js': null,
  // sheets-mode create (viaAppsScript) and reconcile index (get_batches)
  'lib/brewpad-integration.js': null,
  // sheets-mode ref-count / propagate fall-throughs
  'lib/recipe-store.js': null,
  'lib/ferm-schedule-store.js': null
};

// Exact per-file, per-action counts (comment-stripped).
var EXPECTED = {
  'routes/pos.js': {
    create_batch: 2, update_batch: 4, get_batches: 4,
    recipe_batch_ref_count: 0, ferm_schedule_ref_count: 0, propagate_ferm_schedule: 1
  },
  'lib/batch-proxy.js': {
    create_batch: 4, update_batch: 2, get_batches: 1,
    recipe_batch_ref_count: 0, ferm_schedule_ref_count: 0, propagate_ferm_schedule: 0
  },
  'lib/ops-proxy.js': {
    create_batch: 1, update_batch: 0, get_batches: 0,
    recipe_batch_ref_count: 0, ferm_schedule_ref_count: 0, propagate_ferm_schedule: 1
  },
  'lib/brewpad-integration.js': {
    create_batch: 1, update_batch: 0, get_batches: 1,
    recipe_batch_ref_count: 0, ferm_schedule_ref_count: 0, propagate_ferm_schedule: 0
  },
  'lib/recipe-store.js': {
    create_batch: 0, update_batch: 0, get_batches: 0,
    recipe_batch_ref_count: 1, ferm_schedule_ref_count: 0, propagate_ferm_schedule: 0
  },
  'lib/ferm-schedule-store.js': {
    create_batch: 0, update_batch: 0, get_batches: 0,
    recipe_batch_ref_count: 0, ferm_schedule_ref_count: 1, propagate_ferm_schedule: 1
  }
};

describe('batch single-issuer invariant (87-17)', function () {
  var files = listFiles();
  var codeByFile = {};
  files.forEach(function (f) {
    codeByFile[f] = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  });

  test('scans a non-trivial file set', function () {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('routes/pos.js');
  });

  test('no file outside the allow-map names a batch Apps Script action', function () {
    var stray = [];
    files.forEach(function (f) {
      if (Object.prototype.hasOwnProperty.call(ALLOW, f)) return;
      ACTIONS.forEach(function (a) {
        if (findUses(codeByFile[f], a).length) stray.push(f + ' -> ' + a);
      });
    });
    expect(stray).toEqual([]);
  });

  test('allow-listed files use each action exactly the expected number of times', function () {
    var actual = {};
    Object.keys(EXPECTED).forEach(function (f) {
      actual[f] = {};
      ACTIONS.forEach(function (a) { actual[f][a] = findUses(codeByFile[f], a).length; });
    });
    expect(actual).toEqual(EXPECTED);
  });

  // Sheets-mode fall-through axios sites: each must have a batchStore() call (the postgres branch)
  // in the same enclosing top-level function (the sheets-mode closure is defined before the store branch), so postgres mode never reaches Apps Script.
  var FALL_THROUGH = [
    { file: 'lib/brewpad-integration.js', anchor: /action:\s*'create_batch'/ },
    { file: 'lib/brewpad-integration.js', anchor: /action=?:?\s*'get_batches'/ },
    { file: 'routes/pos.js', anchor: /action:\s*'get_batches'/ },
    { file: 'routes/pos.js', anchor: /action:\s*'update_batch'/ },
    { file: 'lib/recipe-store.js', anchor: /callAppsScript\('recipe_batch_ref_count'/ },
    { file: 'lib/ferm-schedule-store.js', anchor: /callAppsScript\('ferm_schedule_ref_count'/ },
    { file: 'lib/ferm-schedule-store.js', anchor: /callAppsScript\('propagate_ferm_schedule'/ }
  ];

  FALL_THROUGH.forEach(function (site) {
    test('fall-through in ' + site.file + ' ' + String(site.anchor) + ' is guarded by batchStore()', function () {
      var code = codeByFile[site.file];
      var re = new RegExp(site.anchor.source, 'g');
      var m;
      var checked = 0;
      while ((m = re.exec(code))) {
        // Enclosing region: from the nearest top-level-ish "function" declaration that precedes the
        // site and itself precedes a batchStore() call, up to the site.
        var before = code.slice(0, m.index);
        var fnStart = Math.max(before.lastIndexOf('\nfunction '), before.lastIndexOf('\nrouter.'), 0);
        var region = code.slice(fnStart, m.index + 3000);
        expect(/batchStore\(\)/.test(region)).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });
  });
});
