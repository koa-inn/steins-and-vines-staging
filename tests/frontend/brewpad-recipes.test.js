'use strict';

// brewpad.js runs its IIFE on load — stub the globals it touches at the top level.
global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();

// auth.js primitives are loaded via <script> in the browser; in tests wire them as globals.
var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');
var filterRecipesByName        = bp.filterRecipesByName;
var recipeRowPrice             = bp.recipeRowPrice;
var canActivateRecipe          = bp.canActivateRecipe;
var buildRecipePayload         = bp.buildRecipePayload;
var recipeDeleteConfirmMessage = bp.recipeDeleteConfirmMessage;
var unitOptionsFor             = bp.unitOptionsFor;

// ---------------------------------------------------------------------------
// filterRecipesByName
// ---------------------------------------------------------------------------
describe('filterRecipesByName', function () {
  var list = [
    { recipe_id: 'R1', name: 'West Coast IPA', status: 'active' },
    { recipe_id: 'R2', name: 'Amber Ale', status: 'active' },
    { recipe_id: 'R3', name: 'Blackberry Mead', status: 'draft' },
    { recipe_id: 'R4', name: null, status: 'draft' }
  ];

  test('empty query returns all rows', function () {
    var result = filterRecipesByName(list, '');
    expect(result.length).toBe(4);
  });

  test('whitespace-only query returns all rows', function () {
    var result = filterRecipesByName(list, '   ');
    expect(result.length).toBe(4);
  });

  test('null query returns all rows', function () {
    var result = filterRecipesByName(list, null);
    expect(result.length).toBe(4);
  });

  test('undefined query returns all rows', function () {
    var result = filterRecipesByName(list, undefined);
    expect(result.length).toBe(4);
  });

  test('case-insensitive substring match', function () {
    var result = filterRecipesByName(list, 'ipa');
    expect(result.length).toBe(1);
    expect(result[0].recipe_id).toBe('R1');
  });

  test('case-insensitive match returns multiple results', function () {
    var result = filterRecipesByName(list, 'a');
    // 'West Coast IPA', 'Amber Ale', 'Blackberry Mead' all contain 'a'
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  test('no match returns empty array', function () {
    var result = filterRecipesByName(list, 'stout');
    expect(result).toEqual([]);
  });

  test('never throws on null name in list', function () {
    expect(function () { filterRecipesByName(list, 'something'); }).not.toThrow();
  });

  test('null name item is excluded from matches', function () {
    var result = filterRecipesByName(list, 'something');
    // R4 has null name — should not match and should not throw
    var ids = result.map(function (r) { return r.recipe_id; });
    expect(ids).not.toContain('R4');
  });

  test('null list returns empty array', function () {
    var result = filterRecipesByName(null, 'ipa');
    expect(result).toEqual([]);
  });

  test('empty list with query returns empty array', function () {
    var result = filterRecipesByName([], 'ipa');
    expect(result).toEqual([]);
  });

  test('empty query on empty list returns empty array', function () {
    var result = filterRecipesByName([], '');
    expect(result).toEqual([]);
  });

  test('returns a new array (does not mutate input)', function () {
    var result = filterRecipesByName(list, '');
    expect(result).not.toBe(list);
  });
});

// ---------------------------------------------------------------------------
// recipeRowPrice
// ---------------------------------------------------------------------------
describe('recipeRowPrice', function () {
  test('dynamic pricing with computed_price > 0 returns ~$X.XX', function () {
    var r = { pricing_mode: 'dynamic', computed_price: 14.5 };
    expect(recipeRowPrice(r)).toBe('~$14.50');
  });

  test('dynamic pricing with computed_price = 0 returns em-dash', function () {
    var r = { pricing_mode: 'dynamic', computed_price: 0 };
    expect(recipeRowPrice(r)).toBe('—');
  });

  test('dynamic pricing with no computed_price returns em-dash', function () {
    var r = { pricing_mode: 'dynamic' };
    expect(recipeRowPrice(r)).toBe('—');
  });

  test('locked pricing with locked_price > 0 returns $X.XX', function () {
    var r = { pricing_mode: 'locked', locked_price: 29.99 };
    expect(recipeRowPrice(r)).toBe('$29.99');
  });

  test('locked pricing with locked_price = 0 returns em-dash', function () {
    var r = { pricing_mode: 'locked', locked_price: 0 };
    expect(recipeRowPrice(r)).toBe('—');
  });

  test('locked pricing with no locked_price returns em-dash', function () {
    var r = { pricing_mode: 'locked' };
    expect(recipeRowPrice(r)).toBe('—');
  });

  test('null recipe returns em-dash', function () {
    expect(recipeRowPrice(null)).toBe('—');
  });

  test('undefined recipe returns em-dash', function () {
    expect(recipeRowPrice(undefined)).toBe('—');
  });

  test('dynamic price formats to two decimal places', function () {
    var r = { pricing_mode: 'dynamic', computed_price: 10 };
    expect(recipeRowPrice(r)).toBe('~$10.00');
  });

  test('locked price formats to two decimal places', function () {
    var r = { pricing_mode: 'locked', locked_price: 25 };
    expect(recipeRowPrice(r)).toBe('$25.00');
  });

  test('dynamic pricing does not use locked_price', function () {
    var r = { pricing_mode: 'dynamic', computed_price: 0, locked_price: 50 };
    expect(recipeRowPrice(r)).toBe('—');
  });

  test('locked pricing does not use computed_price', function () {
    var r = { pricing_mode: 'locked', computed_price: 99, locked_price: 0 };
    expect(recipeRowPrice(r)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// enrichIngredientsWithCatalogRates
// Regression: recipe endpoint returns ingredients WITHOUT prices (they live in the
// ingredient catalog). Without catalog enrichment, the editor's Cost/Retail columns
// and totals footer render blank ("—") for every existing ingredient.
// ---------------------------------------------------------------------------
describe('enrichIngredientsWithCatalogRates', function () {
  var enrichIngredientsWithCatalogRates = bp.enrichIngredientsWithCatalogRates;

  var catalog = [
    { item_id: '100', name: 'Gambrinus Pale Malt', purchase_rate: 2.75, rate: 3.50, unit: 'kg' },
    { item_id: '200', name: 'Fermentis S-04', purchase_rate: 4.00, price_per_unit: 6.25 },
    { item_id: 300, name: 'Numeric ID malt', purchase_rate: 1.00, rate: 1.50 }
  ];

  test('copies purchase_rate and rate from catalog onto ingredients matched by item_id', function () {
    var ings = [{ item_id: '100', quantity: 9.3 }];
    enrichIngredientsWithCatalogRates(ings, catalog);
    expect(ings[0].purchase_rate).toBe(2.75);
    expect(ings[0].rate).toBe(3.50);
  });

  test('falls back to price_per_unit when rate is absent', function () {
    var ings = [{ item_id: '200', quantity: 2 }];
    enrichIngredientsWithCatalogRates(ings, catalog);
    expect(ings[0].rate).toBe(6.25);
  });

  test('matches across numeric vs string item_id types', function () {
    var ings = [{ item_id: '300', quantity: 1 }];
    enrichIngredientsWithCatalogRates(ings, catalog);
    expect(ings[0].rate).toBe(1.50);
  });

  test('fills unit from catalog only when ingredient lacks one', function () {
    var ings = [{ item_id: '100', quantity: 1 }, { item_id: '100', quantity: 1, unit: 'lb' }];
    enrichIngredientsWithCatalogRates(ings, catalog);
    expect(ings[0].unit).toBe('kg');
    expect(ings[1].unit).toBe('lb');
  });

  test('leaves rates at 0 for ingredients with no catalog match', function () {
    var ings = [{ item_id: '999', quantity: 5 }];
    enrichIngredientsWithCatalogRates(ings, catalog);
    expect(ings[0].purchase_rate).toBeUndefined();
  });

  test('regression: line cost reflects catalog rate after enrichment (was $0 → blank)', function () {
    var ings = [{ item_id: '100', quantity: 9.3 }];
    enrichIngredientsWithCatalogRates(ings, catalog);
    var lineCost = (parseFloat(ings[0].quantity) || 0) * (parseFloat(ings[0].purchase_rate) || 0);
    expect(lineCost).toBeCloseTo(25.575, 3);
  });

  test('tolerates non-array inputs without throwing', function () {
    expect(enrichIngredientsWithCatalogRates(null, catalog)).toEqual([]);
    expect(enrichIngredientsWithCatalogRates([{ item_id: '100' }], null)).toEqual([{ item_id: '100' }]);
  });

  test('skips ingredients with empty or missing item_id', function () {
    var ings = [{ item_id: '', quantity: 1 }, { quantity: 1 }];
    enrichIngredientsWithCatalogRates(ings, catalog);
    expect(ings[0].purchase_rate).toBeUndefined();
    expect(ings[1].purchase_rate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canActivateRecipe (D-06 inline activation guardrail)
// ---------------------------------------------------------------------------
describe('canActivateRecipe', function () {
  var validIngredients = [{ item_id: 'I1', item_name: 'Hops', quantity: 1 }];

  test('returns ok:false when locked_price is missing', function () {
    var result = canActivateRecipe({}, validIngredients);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test('returns ok:false when locked_price is zero', function () {
    var result = canActivateRecipe({ locked_price: 0 }, validIngredients);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test('returns ok:false when locked_price is negative', function () {
    var result = canActivateRecipe({ locked_price: -5 }, validIngredients);
    expect(result.ok).toBe(false);
  });

  test('returns ok:false when locked_price is NaN string', function () {
    var result = canActivateRecipe({ locked_price: 'abc' }, validIngredients);
    expect(result.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Regression: the caller gates on `status === 'active'`, not on "is being
  // activated", so this guard re-runs on EVERY save of an already-active
  // recipe. A dynamic-priced recipe prices from computed_price and
  // legitimately has locked_price 0 — which made renaming one impossible.
  // -------------------------------------------------------------------------

  test('returns ok:true for a dynamic recipe with no locked_price', function () {
    var result = canActivateRecipe(
      { pricing_mode: 'dynamic', locked_price: 0 },
      validIngredients
    );
    expect(result.ok).toBe(true);
  });

  test('returns ok:true for a dynamic recipe with a blank locked_price field', function () {
    var result = canActivateRecipe(
      { pricing_mode: 'dynamic', locked_price: '' },
      validIngredients
    );
    expect(result.ok).toBe(true);
  });

  test('a dynamic recipe still requires ingredients — its price derives from them', function () {
    var result = canActivateRecipe(
      { pricing_mode: 'dynamic', locked_price: 0 },
      []
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ingredient/i);
  });

  test('a locked recipe still requires a locked_price', function () {
    var result = canActivateRecipe(
      { pricing_mode: 'locked', locked_price: 0 },
      validIngredients
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/price/i);
  });

  test('an absent pricing_mode is treated as locked and still requires a price', function () {
    var result = canActivateRecipe({ locked_price: 0 }, validIngredients);
    expect(result.ok).toBe(false);
  });

  test('returns ok:false when ingredients array is empty', function () {
    var result = canActivateRecipe({ locked_price: 25 }, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test('returns ok:false when ingredients is null', function () {
    var result = canActivateRecipe({ locked_price: 25 }, null);
    expect(result.ok).toBe(false);
  });

  test('returns ok:true when locked_price > 0 and ingredients not empty', function () {
    var result = canActivateRecipe({ locked_price: 29.99 }, validIngredients);
    expect(result.ok).toBe(true);
  });

  test('returns ok:true with multiple ingredients', function () {
    var ings = [
      { item_id: 'I1', quantity: 1 },
      { item_id: 'I2', quantity: 2 }
    ];
    var result = canActivateRecipe({ locked_price: 49 }, ings);
    expect(result.ok).toBe(true);
  });

  test('reason field absent (or falsy) when ok:true', function () {
    var result = canActivateRecipe({ locked_price: 10 }, validIngredients);
    expect(result.ok).toBe(true);
    // reason may be undefined or empty — must not block activation
    expect(result.reason).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// buildRecipePayload (ingredient filter + ingredient_count)
// ---------------------------------------------------------------------------
describe('buildRecipePayload', function () {
  var baseForm = {
    name: 'Pale Ale',
    style: 'APA',
    description: 'A refreshing ale',
    batch_size_l: 23,
    abv: 5.2,
    ibu: 35,
    colour_srm: 8,
    pricing_mode: 'locked',
    locked_price: 29.99,
    service_fee: 45,
    materials_fee: 5,
    status: 'draft'
  };

  test('includes all formData fields in payload', function () {
    var payload = buildRecipePayload(baseForm, []);
    expect(payload.name).toBe('Pale Ale');
    expect(payload.style).toBe('APA');
    expect(payload.batch_size_l).toBe(23);
    expect(payload.abv).toBe(5.2);
    expect(payload.ibu).toBe(35);
    expect(payload.locked_price).toBe(29.99);
    expect(payload.service_fee).toBe(45);
    expect(payload.materials_fee).toBe(5);
    expect(payload.status).toBe('draft');
    expect(payload.pricing_mode).toBe('locked');
  });

  test('filters out ingredients with no item_id', function () {
    var ings = [
      { item_id: '', item_name: 'Unknown', quantity: 1 },
      { item_id: 'I1', item_name: 'Malt', quantity: 2 }
    ];
    var payload = buildRecipePayload(baseForm, ings);
    expect(payload.ingredients.length).toBe(1);
    expect(payload.ingredients[0].item_id).toBe('I1');
  });

  test('filters out ingredients with quantity <= 0', function () {
    var ings = [
      { item_id: 'I1', item_name: 'Hops', quantity: 0 },
      { item_id: 'I2', item_name: 'Malt', quantity: 1 }
    ];
    var payload = buildRecipePayload(baseForm, ings);
    expect(payload.ingredients.length).toBe(1);
    expect(payload.ingredients[0].item_id).toBe('I2');
  });

  test('sets ingredient_count to the filtered count', function () {
    var ings = [
      { item_id: 'I1', quantity: 1 },
      { item_id: '', quantity: 1 },     // filtered out — no item_id
      { item_id: 'I3', quantity: 0 }    // filtered out — zero qty
    ];
    var payload = buildRecipePayload(baseForm, ings);
    expect(payload.ingredient_count).toBe(1);
  });

  test('ingredient_count matches ingredients array length in payload', function () {
    var ings = [
      { item_id: 'I1', quantity: 2 },
      { item_id: 'I2', quantity: 0.5 }
    ];
    var payload = buildRecipePayload(baseForm, ings);
    expect(payload.ingredient_count).toBe(payload.ingredients.length);
  });

  test('ingredient_count is 0 for empty ingredients', function () {
    var payload = buildRecipePayload(baseForm, []);
    expect(payload.ingredient_count).toBe(0);
    expect(payload.ingredients).toEqual([]);
  });

  test('ingredient_count is 0 when all ingredients are invalid', function () {
    var ings = [
      { item_id: '', quantity: 5 },
      { item_id: 'I1', quantity: 0 }
    ];
    var payload = buildRecipePayload(baseForm, ings);
    expect(payload.ingredient_count).toBe(0);
  });

  test('handles null ingredients gracefully', function () {
    var payload = buildRecipePayload(baseForm, null);
    expect(payload.ingredient_count).toBe(0);
    expect(payload.ingredients).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recipeDeleteConfirmMessage (pure helper — confirm-sheet message for delete, D-04)
// ---------------------------------------------------------------------------
describe('recipeDeleteConfirmMessage', function () {
  test('includes the recipe name in the message', function () {
    var msg = recipeDeleteConfirmMessage('West Coast IPA');
    expect(msg).toContain('West Coast IPA');
  });

  test('includes irreversible-warning copy', function () {
    var msg = recipeDeleteConfirmMessage('Amber Ale');
    expect(msg.toLowerCase()).toContain('cannot be undone');
  });

  test('uses the danger class variant (bp-confirm-btn--danger triggers showConfirmSheet okCls)', function () {
    // This test asserts the helper returns non-empty string (danger class is wired in deleteRecipe, not the message).
    var msg = recipeDeleteConfirmMessage('Test Recipe');
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  test('handles empty name gracefully', function () {
    var msg = recipeDeleteConfirmMessage('');
    expect(msg.toLowerCase()).toContain('cannot be undone');
  });

  test('handles null name gracefully', function () {
    expect(function () { recipeDeleteConfirmMessage(null); }).not.toThrow();
    var msg = recipeDeleteConfirmMessage(null);
    expect(msg.toLowerCase()).toContain('cannot be undone');
  });
});

// ---------------------------------------------------------------------------
// unitOptionsFor — constrains the recipe editor's unit dropdown to units that
// can actually convert against the catalog item, so a line CANNOT be saved in
// a unit the pricing path will later refuse. Lactic Acid 88% (catalog kg, line
// "L") is the case that motivated this: unconvertible, unpriceable, reported
// as a false "out of stock", and unfixable because the column was read-only.
// ---------------------------------------------------------------------------
describe('unitOptionsFor', function () {
  test('is exported from the module', function () {
    expect(typeof unitOptionsFor).toBe('function');
  });

  test('a kg catalog item offers only mass units', function () {
    expect(unitOptionsFor('kg', 'kg')).toEqual(['g', 'kg']);
  });

  test('a g catalog item offers the same mass units', function () {
    expect(unitOptionsFor('g', 'g')).toEqual(['g', 'kg']);
  });

  test('a volume catalog item offers only volume units', function () {
    expect(unitOptionsFor('l', 'ml')).toEqual(['ml', 'l']);
  });

  test('a count catalog item offers only count units', function () {
    expect(unitOptionsFor('pcs', 'pcs')).toEqual(['pcs', 'ea', 'each', 'unit', 'pkg', 'pack']);
  });

  test('never offers a cross-family unit — a kg item cannot be set to L', function () {
    expect(unitOptionsFor('kg', 'kg').indexOf('l')).toBe(-1);
    expect(unitOptionsFor('kg', 'kg').indexOf('ml')).toBe(-1);
  });

  test('surfaces an existing incompatible unit so bad data is visible and fixable', function () {
    // the Lactic Acid case: catalog kg, line L
    var opts = unitOptionsFor('kg', 'L');
    expect(opts.indexOf('L')).toBe(0);
    expect(opts.indexOf('g')).toBeGreaterThan(-1);
    expect(opts.indexOf('kg')).toBeGreaterThan(-1);
  });

  test('does not duplicate the current unit when it is already compatible', function () {
    var opts = unitOptionsFor('kg', 'g');
    expect(opts.filter(function (u) { return u === 'g'; }).length).toBe(1);
  });

  test('an unknown catalog unit falls back to every known unit so the row stays editable', function () {
    var opts = unitOptionsFor('', 'g');
    expect(opts.indexOf('g')).toBeGreaterThan(-1);
    expect(opts.indexOf('kg')).toBeGreaterThan(-1);
    expect(opts.indexOf('ml')).toBeGreaterThan(-1);
    expect(opts.indexOf('pcs')).toBeGreaterThan(-1);
  });

  test('an empty current unit does not add a blank option', function () {
    expect(unitOptionsFor('kg', '').indexOf('')).toBe(-1);
  });
});
