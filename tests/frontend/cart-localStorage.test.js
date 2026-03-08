'use strict';

// Globals expected by 11-cart.js at load time
global.SHEETS_CONFIG = { SPREADSHEET_ID: 'test', MIDDLEWARE_URL: '' };
global.navigator = global.navigator || {};
global.navigator.vibrate = jest.fn();

var cart = require('../../js/modules/11-cart');
var migrateReservationData = cart.migrateReservationData;
var getReservation       = cart.getReservation;
var saveReservation      = cart.saveReservation;
var getReservedQty       = cart.getReservedQty;
var isReserved           = cart.isReserved;
var setReservationQty    = cart.setReservationQty;
var isWeightUnit         = cart.isWeightUnit;
var hasMinQtyIngredients = cart.hasMinQtyIngredients;

var FERMENT_KEY     = 'sv-cart-ferment';
var INGREDIENT_KEY  = 'sv-cart-ingredients';
var LEGACY_KEY      = 'sv-reservation';

beforeEach(function () {
  localStorage.clear();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isWeightUnit
// ---------------------------------------------------------------------------
describe('isWeightUnit', function () {
  test('kg', function () { expect(isWeightUnit('kg')).toBe(true); });
  test('g', function () { expect(isWeightUnit('g')).toBe(true); });
  test('gram', function () { expect(isWeightUnit('gram')).toBe(true); });
  test('grams', function () { expect(isWeightUnit('grams')).toBe(true); });
  test('500g', function () { expect(isWeightUnit('500g')).toBe(false); }); // no leading space before g
  test('each', function () { expect(isWeightUnit('each')).toBe(false); });
  test('empty string', function () { expect(isWeightUnit('')).toBe(false); });
  test('null/undefined', function () { expect(isWeightUnit(null)).toBe(false); });
  test('case-insensitive — KG', function () { expect(isWeightUnit('KG')).toBe(true); });
  test('case-insensitive — Kg', function () { expect(isWeightUnit('Kg')).toBe(true); });
});

// ---------------------------------------------------------------------------
// getReservation / saveReservation
// ---------------------------------------------------------------------------
describe('getReservation / saveReservation', function () {
  test('returns empty array when nothing stored', function () {
    expect(getReservation(FERMENT_KEY)).toEqual([]);
  });

  test('saves and retrieves ferment cart', function () {
    var items = [{ name: 'Wine Kit', brand: 'RJS', qty: 1 }];
    saveReservation(items, FERMENT_KEY);
    expect(getReservation(FERMENT_KEY)).toEqual(items);
  });

  test('saves and retrieves ingredient cart independently', function () {
    saveReservation([{ name: 'Malt', brand: '', qty: 2 }], INGREDIENT_KEY);
    expect(getReservation(FERMENT_KEY)).toEqual([]);
    expect(getReservation(INGREDIENT_KEY)).toHaveLength(1);
  });

  test('overwrites existing data', function () {
    saveReservation([{ name: 'A', brand: '', qty: 1 }], FERMENT_KEY);
    saveReservation([{ name: 'B', brand: '', qty: 2 }], FERMENT_KEY);
    expect(getReservation(FERMENT_KEY)).toEqual([{ name: 'B', brand: '', qty: 2 }]);
  });

  test('returns empty array for corrupt JSON', function () {
    localStorage.setItem(FERMENT_KEY, 'not-json');
    expect(getReservation(FERMENT_KEY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// migrateReservationData
// ---------------------------------------------------------------------------
describe('migrateReservationData', function () {
  test('no-op when no legacy key', function () {
    migrateReservationData();
    expect(localStorage.getItem(FERMENT_KEY)).toBeNull();
    expect(localStorage.getItem(INGREDIENT_KEY)).toBeNull();
  });

  test('no-op when legacy key is empty array', function () {
    localStorage.setItem(LEGACY_KEY, '[]');
    migrateReservationData();
    expect(localStorage.getItem(FERMENT_KEY)).toBeNull();
  });

  test('kit items go to ferment cart', function () {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([
      { name: 'Wine Kit', brand: '', qty: 1, item_type: 'kit' }
    ]));
    migrateReservationData();
    expect(JSON.parse(localStorage.getItem(FERMENT_KEY))).toHaveLength(1);
    expect(localStorage.getItem(INGREDIENT_KEY)).toBeNull();
  });

  test('ingredient items go to ingredient cart', function () {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([
      { name: 'Malt', brand: '', qty: 2, item_type: 'ingredient' }
    ]));
    migrateReservationData();
    expect(localStorage.getItem(FERMENT_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(INGREDIENT_KEY))).toHaveLength(1);
  });

  test('mixed items split correctly', function () {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([
      { name: 'Wine Kit', brand: '', qty: 1, item_type: 'kit' },
      { name: 'Malt', brand: '', qty: 2, item_type: 'ingredient' }
    ]));
    migrateReservationData();
    expect(JSON.parse(localStorage.getItem(FERMENT_KEY))).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(INGREDIENT_KEY))).toHaveLength(1);
  });

  test('removes legacy key after migration', function () {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([
      { name: 'Wine Kit', brand: '', qty: 1, item_type: 'kit' }
    ]));
    migrateReservationData();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  test('items with no item_type default to kit', function () {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([
      { name: 'Unknown', brand: '', qty: 1 }
    ]));
    migrateReservationData();
    expect(JSON.parse(localStorage.getItem(FERMENT_KEY))).toHaveLength(1);
  });

  test('no-op when legacy value is corrupt JSON', function () {
    localStorage.setItem(LEGACY_KEY, 'bad');
    expect(function () { migrateReservationData(); }).not.toThrow();
    expect(localStorage.getItem(FERMENT_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getReservedQty / isReserved
// ---------------------------------------------------------------------------
describe('getReservedQty / isReserved', function () {
  test('returns 0 when item not in either cart', function () {
    expect(getReservedQty('Wine Kit|RJS')).toBe(0);
  });

  test('returns qty from ferment cart', function () {
    saveReservation([{ name: 'Wine Kit', brand: 'RJS', qty: 2 }], FERMENT_KEY);
    expect(getReservedQty('Wine Kit|RJS')).toBe(2);
  });

  test('returns qty from ingredient cart', function () {
    saveReservation([{ name: 'Malt', brand: '', qty: 3 }], INGREDIENT_KEY);
    expect(getReservedQty('Malt|')).toBe(3);
  });

  test('searches both carts', function () {
    saveReservation([{ name: 'Wine Kit', brand: '', qty: 1 }], FERMENT_KEY);
    saveReservation([{ name: 'Malt', brand: '', qty: 5 }], INGREDIENT_KEY);
    expect(getReservedQty('Wine Kit|')).toBe(1);
    expect(getReservedQty('Malt|')).toBe(5);
  });

  test('isReserved returns true when qty > 0', function () {
    saveReservation([{ name: 'Wine Kit', brand: '', qty: 1 }], FERMENT_KEY);
    expect(isReserved('Wine Kit|')).toBe(true);
  });

  test('isReserved returns false when not in cart', function () {
    expect(isReserved('Wine Kit|')).toBe(false);
  });

  test('defaults qty to 1 when item.qty missing', function () {
    saveReservation([{ name: 'Wine Kit', brand: '' }], FERMENT_KEY);
    expect(getReservedQty('Wine Kit|')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setReservationQty
// ---------------------------------------------------------------------------
describe('setReservationQty', function () {
  function makeProduct(overrides) {
    return Object.assign({
      name: 'Wine Kit', brand: 'RJS', _item_type: 'kit',
      max_order_qty: '', stock: 10
    }, overrides);
  }

  test('adds item to ferment cart', function () {
    var p = makeProduct();
    setReservationQty(p, 1);
    expect(getReservedQty('Wine Kit|RJS')).toBe(1);
  });

  test('routes ingredient to ingredient cart', function () {
    var p = makeProduct({ name: 'Malt', brand: '', _item_type: 'ingredient' });
    setReservationQty(p, 2);
    expect(getReservedQty('Malt|')).toBe(2);
    expect(getReservation(FERMENT_KEY)).toHaveLength(0);
  });

  test('updates qty when item already in cart', function () {
    var p = makeProduct();
    setReservationQty(p, 1);
    setReservationQty(p, 3);
    expect(getReservedQty('Wine Kit|RJS')).toBe(3);
    expect(getReservation(FERMENT_KEY)).toHaveLength(1);
  });

  test('removes item when qty set to 0', function () {
    var p = makeProduct();
    setReservationQty(p, 1);
    setReservationQty(p, 0);
    expect(getReservation(FERMENT_KEY)).toHaveLength(0);
  });

  test('clamps qty to max_order_qty', function () {
    var p = makeProduct({ max_order_qty: '2' });
    setReservationQty(p, 10);
    expect(getReservedQty('Wine Kit|RJS')).toBe(2);
  });

  test('ignores set when max is 0 and qty > 0', function () {
    var p = makeProduct({ stock: 0, _item_type: 'ingredient' });
    setReservationQty(p, 1);
    expect(getReservation(INGREDIENT_KEY)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hasMinQtyIngredients
// ---------------------------------------------------------------------------
describe('hasMinQtyIngredients', function () {
  test('returns false when ingredient cart is empty', function () {
    expect(hasMinQtyIngredients()).toBe(false);
  });

  test('returns false when no item has qty 0.01', function () {
    saveReservation([{ name: 'Malt', brand: '', qty: 0.5 }], INGREDIENT_KEY);
    expect(hasMinQtyIngredients()).toBe(false);
  });

  test('returns true when any item has qty 0.01', function () {
    saveReservation([
      { name: 'Malt', brand: '', qty: 0.5 },
      { name: 'Yeast', brand: '', qty: 0.01 }
    ], INGREDIENT_KEY);
    expect(hasMinQtyIngredients()).toBe(true);
  });

  test('returns false when only ferment cart has items', function () {
    saveReservation([{ name: 'Wine Kit', brand: '', qty: 0.01 }], FERMENT_KEY);
    expect(hasMinQtyIngredients()).toBe(false);
  });
});
