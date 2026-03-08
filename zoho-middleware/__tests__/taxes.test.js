'use strict';

// Mock all external dependencies so the route module loads cleanly
jest.mock('express', () => {
  var router = { get: jest.fn(), post: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('../lib/zoho-api', () => ({
  zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn(),
  inventoryGet: jest.fn(), inventoryPut: jest.fn(), fetchAllItems: jest.fn()
}));
jest.mock('../lib/cache', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('axios');

var taxes = require('../routes/taxes');
var parseCSVLine = taxes.parseCSVLine;
var keywordMatch = taxes.keywordMatch;
var classifyItem = taxes.classifyItem;

// ---------------------------------------------------------------------------
// Minimal CATEGORIES fixture for classifyItem tests
// ---------------------------------------------------------------------------
var TEST_CATEGORIES = {
  capital_equipment: {
    name_patterns: ['bucket', 'carboy', 'fermenter'],
    rule_id: 'CE_RULE', tax_id: 'CE_TAX', rule_label: 'GST + PST - Standard (12%)'
  },
  ingredients: {
    keywords: ['juice', 'malt', 'yeast', 'kit', 'grape', 'concentrate'],
    rule_id: 'ZERO_RULE', tax_id: 'ZERO_TAX', rule_label: 'Zero Rated (0%)'
  },
  services: {
    keywords: ['\\bservice\\b', '\\bracking\\b', '\\bfiltering\\b', '\\bfee\\b'],
    rule_id: 'SVC_RULE', tax_id: 'SVC_TAX', rule_label: 'GST Only (5%)'
  },
  packaging: {
    keywords: ['bottle', 'cork', 'label', 'capsule'],
    rule_id: 'PKG_RULE', tax_id: 'PKG_TAX', rule_label: 'GST + PST (12%)'
  },
  hardware: {
    keywords: ['airlock', 'siphon', 'hydrometer', 'thermometer'],
    rule_id: 'HW_RULE', tax_id: 'HW_TAX', rule_label: 'GST + PST (12%)'
  },
  liquor: {
    keywords: ['commercial wine', 'commercial beer', 'finished wine'],
    rule_id: 'LQ_RULE', tax_id: 'LQ_TAX', rule_label: 'GST + PST Liquor (15%)'
  }
};

function makeItem(name, opts) {
  opts = opts || {};
  return {
    item_id: opts.item_id || 'item-001',
    name: name,
    category_name: opts.category || '',
    description: opts.description || '',
    group_name: opts.group || '',
    purchase_tax_rule_id: opts.purchase_rule || undefined,
    tax_id: opts.current_tax || undefined
  };
}

// ---------------------------------------------------------------------------
// parseCSVLine
// ---------------------------------------------------------------------------
describe('parseCSVLine', () => {
  test('simple comma-separated fields', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  test('quoted field containing a comma', () => {
    expect(parseCSVLine('"a,b",c')).toEqual(['a,b', 'c']);
  });

  test('escaped double-quotes inside quoted field', () => {
    expect(parseCSVLine('"a""b"')).toEqual(['a"b']);
  });

  test('empty fields', () => {
    expect(parseCSVLine('a,,c')).toEqual(['a', '', 'c']);
  });

  test('trailing comma produces empty last field', () => {
    expect(parseCSVLine('a,b,')).toEqual(['a', 'b', '']);
  });

  test('single field — no comma', () => {
    expect(parseCSVLine('hello')).toEqual(['hello']);
  });

  test('empty string', () => {
    expect(parseCSVLine('')).toEqual(['']);
  });

  test('quoted field spanning whole value', () => {
    expect(parseCSVLine('"Steins & Vines"')).toEqual(['Steins & Vines']);
  });

  test('multiple quoted fields', () => {
    expect(parseCSVLine('"one","two","three"')).toEqual(['one', 'two', 'three']);
  });

  test('numeric values as strings', () => {
    expect(parseCSVLine('1,2.5,10')).toEqual(['1', '2.5', '10']);
  });
});

// ---------------------------------------------------------------------------
// keywordMatch
// ---------------------------------------------------------------------------
describe('keywordMatch', () => {
  test('plain keyword present', () => {
    expect(keywordMatch('juice', 'orange juice kit')).toBe(true);
  });

  test('plain keyword absent', () => {
    expect(keywordMatch('juice', 'wine malt yeast')).toBe(false);
  });

  test('plain keyword matches lowercased text (callers pre-lowercase searchText)', () => {
    expect(keywordMatch('malt', 'malt extract 500g')).toBe(true);
  });

  test('word boundary matches whole word', () => {
    expect(keywordMatch('\\bfee\\b', 'service fee included')).toBe(true);
  });

  test('word boundary does not match partial word', () => {
    expect(keywordMatch('\\bfee\\b', 'coffee')).toBe(false);
  });

  test('word boundary keyword is case-insensitive', () => {
    expect(keywordMatch('\\bservice\\b', 'ANNUAL SERVICE CHARGE')).toBe(true);
  });

  test('word boundary — racking not inside another word', () => {
    expect(keywordMatch('\\bracking\\b', 'racking kit')).toBe(true);
  });

  test('plain keyword at start of text', () => {
    expect(keywordMatch('airlock', 'airlock 3-piece')).toBe(true);
  });

  test('plain keyword substring match', () => {
    // 'oak' is a substring of 'oak chips' — should match
    expect(keywordMatch('oak', 'french oak chips')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyItem
// ---------------------------------------------------------------------------
describe('classifyItem', () => {
  test('capital equipment — bucket in name', () => {
    var result = classifyItem(makeItem('5 Gallon Bucket'), TEST_CATEGORIES);
    expect(result.category).toBe('capital_equipment');
    expect(result.rule_id).toBe('CE_RULE');
    expect(result.tax_id).toBe('CE_TAX');
  });

  test('capital equipment — carboy', () => {
    var result = classifyItem(makeItem('6 Gallon Carboy'), TEST_CATEGORIES);
    expect(result.category).toBe('capital_equipment');
  });

  test('capital equipment — fermenter', () => {
    var result = classifyItem(makeItem('Plastic Fermenter 23L'), TEST_CATEGORIES);
    expect(result.category).toBe('capital_equipment');
  });

  test('ingredients — juice kit', () => {
    var result = classifyItem(makeItem('Grape Juice Concentrate'), TEST_CATEGORIES);
    expect(result.category).toBe('ingredients');
    expect(result.tax_id).toBe('ZERO_TAX');
  });

  test('ingredients — malt extract', () => {
    var result = classifyItem(makeItem('Dry Malt Extract'), TEST_CATEGORIES);
    expect(result.category).toBe('ingredients');
  });

  test('ingredients — kit keyword', () => {
    var result = classifyItem(makeItem('RJS En Primeur Wine Kit'), TEST_CATEGORIES);
    expect(result.category).toBe('ingredients');
  });

  test('services — racking service (word boundary)', () => {
    var result = classifyItem(makeItem('Racking Service'), TEST_CATEGORIES);
    expect(result.category).toBe('services');
    expect(result.tax_id).toBe('SVC_TAX');
  });

  test('services — filtering', () => {
    var result = classifyItem(makeItem('Filtering Fee'), TEST_CATEGORIES);
    expect(result.category).toBe('services');
  });

  test('packaging — wine bottles', () => {
    var result = classifyItem(makeItem('Wine Bottles 750ml x12'), TEST_CATEGORIES);
    expect(result.category).toBe('packaging');
    expect(result.tax_id).toBe('PKG_TAX');
  });

  test('packaging — corks', () => {
    var result = classifyItem(makeItem('Natural Cork 100pk'), TEST_CATEGORIES);
    expect(result.category).toBe('packaging');
  });

  test('hardware — airlock', () => {
    var result = classifyItem(makeItem('Airlock 3-Piece'), TEST_CATEGORIES);
    expect(result.category).toBe('hardware');
    expect(result.tax_id).toBe('HW_TAX');
  });

  test('hardware — hydrometer', () => {
    var result = classifyItem(makeItem('Triple Scale Hydrometer'), TEST_CATEGORIES);
    expect(result.category).toBe('hardware');
  });

  test('liquor — commercial wine', () => {
    var result = classifyItem(makeItem('Commercial Wine Merlot'), TEST_CATEGORIES);
    expect(result.category).toBe('liquor');
    expect(result.tax_id).toBe('LQ_TAX');
  });

  test('default — unrecognised product → ingredients (default)', () => {
    var result = classifyItem(makeItem('Mystery Gadget XYZ-9000'), TEST_CATEGORIES);
    expect(result.category).toBe('ingredients (default)');
    expect(result.tax_id).toBe('ZERO_TAX');
  });

  test('ingredients priority over packaging — kit with bottle in name', () => {
    // "kit" is an ingredient keyword and appears before "bottle" in the priority order
    var result = classifyItem(makeItem('Wine Kit with Bottle'), TEST_CATEGORIES);
    expect(result.category).toBe('ingredients');
  });

  test('includes item_id and item_name in result', () => {
    var result = classifyItem(makeItem('Airlock', { item_id: 'abc-123' }), TEST_CATEGORIES);
    expect(result.item_id).toBe('abc-123');
    expect(result.item_name).toBe('Airlock');
  });

  test('current_purchase_rule defaults to (none) when missing', () => {
    var result = classifyItem(makeItem('Yeast 5g'), TEST_CATEGORIES);
    expect(result.current_purchase_rule).toBe('(none)');
  });

  test('current_purchase_rule preserved when present', () => {
    var result = classifyItem(makeItem('Yeast 5g', { purchase_rule: 'RULE-99' }), TEST_CATEGORIES);
    expect(result.current_purchase_rule).toBe('RULE-99');
  });

  test('keyword match in category_name field', () => {
    // Item name has no keyword, but category_name does
    var result = classifyItem(
      makeItem('Mystery Product', { category: 'Wine Juice Category' }),
      TEST_CATEGORIES
    );
    expect(result.category).toBe('ingredients');
  });

  test('keyword match in description field', () => {
    var result = classifyItem(
      makeItem('Generic Item', { description: 'Contains malt extract' }),
      TEST_CATEGORIES
    );
    expect(result.category).toBe('ingredients');
  });
});
