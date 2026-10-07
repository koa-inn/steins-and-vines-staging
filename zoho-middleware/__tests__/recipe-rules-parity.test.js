'use strict';

/**
 * Function-level parity: lib/recipe-rules.js vs the REAL apps-script/adminApi.gs source —
 * Phase 85 Plan 01 (DB-04, ROADMAP SC3, Phase 79 D-04/D-09).
 *
 * adminApi.gs is loaded from disk and evaluated via `new Function` (same technique as
 * tests/frontend/adminapi-recipe-pure.test.js); the four pure rules are pulled out and every
 * shared vector is run through both implementations. planIngredientIds has no standalone .gs
 * function (the D-09 logic lives inside updateRecipe) — it is tested here against the explicit
 * D-09 rules, and against the real updateRecipe in recipe-d09-runtime-parity.test.js.
 */

var fs = require('fs');
var path = require('path');
var rules = require('../lib/recipe-rules');

var src = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8'); // adminApi.gs
var gs = new Function(
  src + '\nreturn {' +
    'sanitizeInput: sanitizeInput,' +
    'normalizePricingMode: normalizePricingMode,' +
    'normalizeRecipeIngredientTuple: normalizeRecipeIngredientTuple,' +
    'recipeIngredientsUnchanged: recipeIngredientsUnchanged' +
  '};'
)();

describe('recipe-rules parity with adminApi.gs', function () {
  describe('sanitizeInput', function () {
    var vectors = [
      'plain text', '  padded  ', '<script>alert(1)</script>x', 'a onclick=b', 'a onclick="b" c',
      'javascript:x', 'JavaScript :x', '<scr<script>ipt>', '<iframe>', '</iframe>', '<object>', '<embed>',
      '<style>', '<style>p{}</style>y', 'data: text/html', 'Tom & Jerry', '=IMPORTRANGE("x")', '',
      null, undefined, 5, 0, true, { a: 1 }
    ];
    vectors.forEach(function (v, i) {
      it('vector ' + i + ' matches', function () {
        expect(rules.sanitizeInput(v)).toEqual(gs.sanitizeInput(v));
      });
    });
  });

  describe('normalizePricingMode', function () {
    ['dynamic', 'DYNAMIC', ' dynamic ', 'locked', '', null, undefined, 'x', 5].forEach(function (v, i) {
      it('vector ' + i + ' matches', function () {
        expect(rules.normalizePricingMode(v)).toEqual(gs.normalizePricingMode(v));
      });
    });
  });

  describe('normalizeRecipeIngredientTuple', function () {
    var vectors = [
      [' A ', 5, ' kg '], ['A', '5', 'kg'], ['A', 0.1 + 0.2, 'g'], ['A', '', 'g'], ['A', null, 'g'],
      ['A', undefined, 'g'], ['A', 'abc', 'g'], ['A', 0.0055, 'g'], ['a', 1, 'KG'], ['A', 1, 'kg'],
      [null, 1, null], [undefined, 1, undefined], ['A', Infinity, 'g']
    ];
    vectors.forEach(function (v, i) {
      it('vector ' + i + ' matches', function () {
        expect(rules.normalizeRecipeIngredientTuple(v[0], v[1], v[2]))
          .toEqual(gs.normalizeRecipeIngredientTuple(v[0], v[1], v[2]));
      });
    });
    it('does not case-fold item or unit', function () {
      expect(rules.normalizeRecipeIngredientTuple('a', 1, 'KG'))
        .not.toEqual(rules.normalizeRecipeIngredientTuple('A', 1, 'kg'));
    });
  });

  describe('recipeIngredientsUnchanged', function () {
    var t = rules.normalizeRecipeIngredientTuple;
    var a = [t('A', 1, 'kg'), t('B', 2, 'g')];
    var cases = [
      [a, a.slice()],
      [a, [a[1], a[0]]],
      [a, [a[0]]],
      [[t('A', 'abc', 'g')], [t('A', 'abc', 'g')]],
      [[], []],
      [null, []],
      [[], null]
    ];
    cases.forEach(function (c, i) {
      it('case ' + i + ' matches', function () {
        expect(rules.recipeIngredientsUnchanged(c[0], c[1])).toEqual(gs.recipeIngredientsUnchanged(c[0], c[1]));
      });
    });
  });

  describe('planIngredientIds (D-09)', function () {
    function ing(id) { return { ingredient_id: id, item_id: 'I', item_name: 'n', quantity: 1, unit: 'kg' }; }
    var stored = ['RI-000001', 'RI-000002', 'RI-000003'];

    it('honours own unclaimed ids', function () {
      var out = rules.planIngredientIds([ing('RI-000002'), ing('RI-000001')], stored);
      expect(out.map(function (r) { return r.ingredient_id; })).toEqual(['RI-000002', 'RI-000001']);
    });
    it('nulls a foreign id', function () {
      expect(rules.planIngredientIds([ing('RI-000099')], stored)[0].ingredient_id).toBeNull();
    });
    it('nulls an invented id', function () {
      expect(rules.planIngredientIds([ing('bogus')], stored)[0].ingredient_id).toBeNull();
    });
    it('honours the first of a repeated own id and nulls the second', function () {
      var out = rules.planIngredientIds([ing('RI-000001'), ing('RI-000001')], stored);
      expect(out[0].ingredient_id).toBe('RI-000001');
      expect(out[1].ingredient_id).toBeNull();
    });
    it('nulls a missing id', function () {
      expect(rules.planIngredientIds([ing(undefined), ing('')], stored).map(function (r) { return r.ingredient_id; }))
        .toEqual([null, null]);
    });
    it('assigns 1-based positions in payload order and carries fields', function () {
      var out = rules.planIngredientIds([ing(null), ing(null), ing(null)], stored);
      expect(out.map(function (r) { return r.position; })).toEqual([1, 2, 3]);
      expect(out[0]).toEqual({ ingredient_id: null, position: 1, item_id: 'I', item_name: 'n', quantity: 1, unit: 'kg' });
    });
    it('trims incoming ids like the .gs does', function () {
      expect(rules.planIngredientIds([ing('  RI-000001 ')], stored)[0].ingredient_id).toBe('RI-000001');
    });
    it('handles empty inputs', function () {
      expect(rules.planIngredientIds([], stored)).toEqual([]);
      expect(rules.planIngredientIds(null, null)).toEqual([]);
    });
  });
});
