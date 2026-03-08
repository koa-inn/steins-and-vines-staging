'use strict';

// 11-cart.js references these globals inside functions (not at module level).
// Declare no-op stubs so any incidental call doesn't throw.
global.updateReservationBar = function () {};
global.trackEvent = function () {};

// jsdom provides localStorage natively; expose it as a global for the module
global.localStorage = window.localStorage;

const cart = require('../../js/modules/11-cart');
const { getCartKey, getCartKeyForTab, getEffectiveMax } = cart;
const { getAllCartItems, getReservation, saveReservation } = cart;

var FERMENT_KEY = 'sv-cart-ferment';
var INGREDIENT_KEY = 'sv-cart-ingredients';

describe('getCartKey', () => {
  test('routes ingredient item_type to ingredient cart key', () => {
    expect(getCartKey({ _item_type: 'ingredient' })).toBe(INGREDIENT_KEY);
  });

  test('routes ingredient via item_type fallback', () => {
    expect(getCartKey({ item_type: 'ingredient' })).toBe(INGREDIENT_KEY);
  });

  test('routes kit item_type to ferment cart key', () => {
    expect(getCartKey({ _item_type: 'kit' })).toBe(FERMENT_KEY);
  });

  test('routes service item_type to ferment cart key', () => {
    expect(getCartKey({ _item_type: 'service' })).toBe(FERMENT_KEY);
  });

  test('defaults to ferment key when no item_type set', () => {
    expect(getCartKey({})).toBe(FERMENT_KEY);
  });

  test('_item_type takes precedence over item_type', () => {
    expect(getCartKey({ _item_type: 'ingredient', item_type: 'kit' })).toBe(INGREDIENT_KEY);
    expect(getCartKey({ _item_type: 'kit', item_type: 'ingredient' })).toBe(FERMENT_KEY);
  });
});

describe('getCartKeyForTab', () => {
  test('"ingredients" tab maps to ingredient cart key', () => {
    expect(getCartKeyForTab('ingredients')).toBe(INGREDIENT_KEY);
  });

  test('"kits" tab maps to ferment cart key', () => {
    expect(getCartKeyForTab('kits')).toBe(FERMENT_KEY);
  });

  test('"services" tab maps to ferment cart key', () => {
    expect(getCartKeyForTab('services')).toBe(FERMENT_KEY);
  });

  test('unknown tab defaults to ferment cart key', () => {
    expect(getCartKeyForTab('other')).toBe(FERMENT_KEY);
    expect(getCartKeyForTab('')).toBe(FERMENT_KEY);
    expect(getCartKeyForTab(null)).toBe(FERMENT_KEY);
  });
});

describe('getEffectiveMax', () => {
  describe('kit items', () => {
    test('returns Infinity when max_order_qty is not set', () => {
      expect(getEffectiveMax({ _item_type: 'kit' })).toBe(Infinity);
    });

    test('returns Infinity when max_order_qty is 0', () => {
      expect(getEffectiveMax({ _item_type: 'kit', max_order_qty: '0' })).toBe(Infinity);
    });

    test('returns Infinity when max_order_qty is negative', () => {
      expect(getEffectiveMax({ _item_type: 'kit', max_order_qty: '-1' })).toBe(Infinity);
    });

    test('returns max_order_qty when set to positive value', () => {
      expect(getEffectiveMax({ _item_type: 'kit', max_order_qty: '5' })).toBe(5);
    });

    test('does not consider stock for kit items', () => {
      expect(getEffectiveMax({ _item_type: 'kit', max_order_qty: '10', stock: '3' })).toBe(10);
    });
  });

  describe('ingredient items', () => {
    test('returns stock when stock < max_order_qty', () => {
      expect(getEffectiveMax({ _item_type: 'ingredient', stock: '10', max_order_qty: '20' })).toBe(10);
    });

    test('returns max_order_qty when max_order_qty < stock', () => {
      expect(getEffectiveMax({ _item_type: 'ingredient', stock: '10', max_order_qty: '3' })).toBe(3);
    });

    test('returns 0 when no stock and no max_order_qty', () => {
      expect(getEffectiveMax({ _item_type: 'ingredient' })).toBe(0);
    });

    test('returns stock when max_order_qty not set', () => {
      expect(getEffectiveMax({ _item_type: 'ingredient', stock: '8' })).toBe(8);
    });

    test('returns 0 when stock is 0', () => {
      expect(getEffectiveMax({ _item_type: 'ingredient', stock: '0' })).toBe(0);
    });

    test('returns min(maxOrder, stock) when both are positive', () => {
      expect(getEffectiveMax({ _item_type: 'ingredient', stock: '5', max_order_qty: '5' })).toBe(5);
    });
  });

  describe('service items', () => {
    test('returns stock for service items (same as ingredient)', () => {
      expect(getEffectiveMax({ _item_type: 'service', stock: '4' })).toBe(4);
    });

    test('returns min(max_order_qty, stock) for service items', () => {
      expect(getEffectiveMax({ _item_type: 'service', stock: '10', max_order_qty: '2' })).toBe(2);
    });
  });

  describe('default item type (no _item_type)', () => {
    test('defaults to kit behaviour when no type set', () => {
      expect(getEffectiveMax({ max_order_qty: '3' })).toBe(3);
      expect(getEffectiveMax({})).toBe(Infinity);
    });

    test('uses item_type fallback', () => {
      expect(getEffectiveMax({ item_type: 'ingredient', stock: '7' })).toBe(7);
    });
  });
});

// ---------------------------------------------------------------------------
// getAllCartItems
// ---------------------------------------------------------------------------
describe('getAllCartItems', () => {
  beforeEach(() => { localStorage.clear(); });

  test('returns empty array when both carts are empty', () => {
    expect(getAllCartItems()).toEqual([]);
  });

  test('returns items from ferment cart only', () => {
    var kit = { name: 'Wine Kit', brand: 'RJS', qty: 1, item_type: 'kit' };
    saveReservation([kit], FERMENT_KEY);
    var result = getAllCartItems();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Wine Kit');
  });

  test('returns items from ingredient cart only', () => {
    var malt = { name: 'Malt', brand: '', qty: 2, item_type: 'ingredient' };
    saveReservation([malt], INGREDIENT_KEY);
    var result = getAllCartItems();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Malt');
  });

  test('merges items from both carts', () => {
    var kit = { name: 'Wine Kit', brand: 'RJS', qty: 1, item_type: 'kit' };
    var malt = { name: 'Malt', brand: '', qty: 2, item_type: 'ingredient' };
    saveReservation([kit], FERMENT_KEY);
    saveReservation([malt], INGREDIENT_KEY);
    var result = getAllCartItems();
    expect(result).toHaveLength(2);
    var names = result.map(function (i) { return i.name; });
    expect(names).toContain('Wine Kit');
    expect(names).toContain('Malt');
  });

  test('ferment items appear before ingredient items', () => {
    var kit = { name: 'Wine Kit', brand: '', qty: 1, item_type: 'kit' };
    var malt = { name: 'Malt', brand: '', qty: 1, item_type: 'ingredient' };
    saveReservation([kit], FERMENT_KEY);
    saveReservation([malt], INGREDIENT_KEY);
    var result = getAllCartItems();
    expect(result[0].name).toBe('Wine Kit');
    expect(result[1].name).toBe('Malt');
  });

  test('multiple items in each cart are all included', () => {
    saveReservation([
      { name: 'Kit A', brand: '', qty: 1, item_type: 'kit' },
      { name: 'Kit B', brand: '', qty: 2, item_type: 'kit' }
    ], FERMENT_KEY);
    saveReservation([
      { name: 'Ingredient A', brand: '', qty: 1, item_type: 'ingredient' },
      { name: 'Ingredient B', brand: '', qty: 3, item_type: 'ingredient' }
    ], INGREDIENT_KEY);
    expect(getAllCartItems()).toHaveLength(4);
  });

  test('returns a new array (does not mutate either cart)', () => {
    var kit = { name: 'Wine Kit', brand: '', qty: 1, item_type: 'kit' };
    saveReservation([kit], FERMENT_KEY);
    var result = getAllCartItems();
    result.push({ name: 'Extra', brand: '', qty: 1 });
    // Ferment cart should still have only 1 item
    expect(getReservation(FERMENT_KEY)).toHaveLength(1);
  });
});
