'use strict';

// Phase 97-05 (D-06): Target OG / Target FG in the BrewPad recipe editor and attach snapshot.

var fs = require('fs');
var path = require('path');

global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

var html = fs.readFileSync(path.join(__dirname, '../../brewpad.html'), 'utf8');

describe('brewpad.html target gravity inputs', function () {
  var host;
  beforeAll(function () {
    host = document.createElement('div');
    host.innerHTML = html.slice(html.indexOf('<body'));
  });

  ['bp-recipe-target-og', 'bp-recipe-target-fg'].forEach(function (id) {
    test(id + ' is a bounded decimal number input', function () {
      var el = host.querySelector('#' + id);
      expect(el).not.toBeNull();
      expect(el.getAttribute('type')).toBe('number');
      expect(el.getAttribute('step')).toBe('0.1');
      expect(el.getAttribute('min')).toBe('2');
      expect(el.getAttribute('max')).toBe('40');
      expect(el.getAttribute('inputmode')).toBe('decimal');
      expect(el.className).toContain('bp-input');
    });
  });

  test('shared helper text', function () {
    var help = host.querySelector('#bp-recipe-gravity-help');
    expect(help).not.toBeNull();
    expect(help.textContent.trim()).toBe('Optional. Used for the expected curve on the dashboard.');
  });
});

describe('populate / read target gravity', function () {
  beforeEach(function () {
    document.body.innerHTML = '<input id="bp-recipe-target-og" /><input id="bp-recipe-target-fg" />';
  });
  var og = function () { return document.getElementById('bp-recipe-target-og'); };
  var fg = function () { return document.getElementById('bp-recipe-target-fg'); };

  test('populate fills both from the recipe', function () {
    bp._bpPopulateRecipeFormForTest({ target_og: 12, target_fg: 3.5 });
    expect(og().value).toBe('12');
    expect(fg().value).toBe('3.5');
  });

  test('populate leaves blank for missing or empty-string keys', function () {
    og().value = '9';
    bp._bpPopulateRecipeFormForTest({ target_og: '', target_fg: null });
    expect(og().value).toBe('');
    expect(fg().value).toBe('');
    bp._bpPopulateRecipeFormForTest({});
    expect(og().value).toBe('');
  });

  test('read returns number for a value and empty string for blank', function () {
    og().value = '12.5';
    fg().value = '';
    var d = bp._bpReadRecipeFormDataForTest();
    expect(d.target_og).toBe(12.5);
    expect(d.target_fg).toBe('');
  });

  test('read never returns 0 for blank inputs', function () {
    var d = bp._bpReadRecipeFormDataForTest();
    expect(d.target_og).toBe('');
    expect(d.target_fg).toBe('');
  });

  test('buildRecipePayload carries both keys through', function () {
    var p = bp.buildRecipePayload({ target_og: 12.5, target_fg: '' }, []);
    expect(p.target_og).toBe(12.5);
    expect(p.target_fg).toBe('');
    var q = bp.buildRecipePayload({}, []);
    expect(q.target_og).toBe('');
    expect(q.target_fg).toBe('');
  });

  test('clone copies target gravity', function () {
    var c = bp.bpCloneRecipePayload({ name: 'A', target_og: 12, target_fg: 3 }, []).recipe;
    expect(c.target_og).toBe(12);
    expect(c.target_fg).toBe(3);
    expect(bp.bpCloneRecipePayload({ name: 'A' }, []).recipe.target_og).toBe('');
  });
});

describe('buildBpAttachSnapshot target gravity', function () {
  function snapFor(recipe) {
    bp._bpSetResolvedRecipe({
      recipe: recipe,
      ingredients: [{ item_id: 'i1', item_name: 'Malt', quantity: 5, unit: 'kg', cf_type: 'grain' }]
    });
    bp._bpSetTargetVolumeL(null);
    bp._bpSetScaleFactor(1);
    bp._bpSetModifiedIngredients(null);
    return bp.buildBpAttachSnapshot();
  }

  test('copies target_og to og and target_fg', function () {
    var s = snapFor({ name: 'X', abv: 5, ibu: 30, batch_size_l: 23, target_og: 12, target_fg: 3 });
    expect(s.og).toBe(12);
    expect(s.target_fg).toBe(3);
  });

  test('null when blank or absent', function () {
    var s = snapFor({ name: 'X', target_og: '', target_fg: '' });
    expect(s.og).toBeNull();
    expect(s.target_fg).toBeNull();
    var t = snapFor({ name: 'X' });
    expect(t.og).toBeNull();
    expect(t.target_fg).toBeNull();
  });

  test('existing keys unchanged', function () {
    var s = snapFor({ name: 'X', abv: 5, ibu: 30, batch_size_l: 23, target_og: 12 });
    expect(s.abv).toBe(5);
    expect(s.ibu).toBe(30);
    expect(s.batch_size_l).toBe(23);
    expect(s.ingredients[0].cf_type).toBe('grain');
  });
});
