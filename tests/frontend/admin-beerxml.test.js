'use strict';

// Minimal global stubs for admin.js IIFE to load without errors.
// admin.js relies on DOM, SHEETS_CONFIG, google auth, etc.

var mockElements = {};
function createMockElement() {
  return {
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    setAttribute: jest.fn(),
    getAttribute: jest.fn(function () { return null; }),
    addEventListener: jest.fn(),
    querySelector: jest.fn(function () { return null; }),
    querySelectorAll: jest.fn(function () { return []; }),
    appendChild: jest.fn(),
    closest: jest.fn(function () { return null; }),
    remove: jest.fn(),
    classList: { add: jest.fn(), remove: jest.fn(), contains: jest.fn() },
    parentNode: { querySelector: jest.fn(function () { return null; }), appendChild: jest.fn() },
    focus: jest.fn()
  };
}

global.document = {
  getElementById: jest.fn(function (id) {
    if (!mockElements[id]) mockElements[id] = createMockElement();
    return mockElements[id];
  }),
  querySelectorAll: jest.fn(function () { return []; }),
  querySelector: jest.fn(function () { return null; }),
  addEventListener: jest.fn(),
  createElement: jest.fn(function () { return createMockElement(); }),
  body: { appendChild: jest.fn() }
};

global.window = {
  confirm: jest.fn(function () { return true; }),
  location: { search: '', pathname: '/admin.html', href: '' },
  addEventListener: jest.fn(),
  matchMedia: jest.fn(function () { return { matches: false, addEventListener: jest.fn() }; })
};

global.navigator = { userAgent: 'test' };
global.localStorage = {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.sessionStorage = {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.console = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
};
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
});
global.setTimeout = jest.fn(function (fn) { if (typeof fn === 'function') fn(); return 1; });
global.clearTimeout = jest.fn();
global.setInterval = jest.fn(function () { return 1; });
global.clearInterval = jest.fn();
global.alert = jest.fn();
global.Image = jest.fn(function () { return {}; });
global.URLSearchParams = function (s) {
  this.get = function () { return null; };
  this.has = function () { return false; };
};
global.MutationObserver = jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn() };
});
global.IntersectionObserver = jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn(), unobserve: jest.fn() };
});

// Google Identity stubs
global.google = { accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } } };

// SHEETS_CONFIG stub (normally from js/sheets-config.js)
global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://localhost:3001',
  MW_API_KEY: 'test-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};

// Load admin.js (the IIFE will run and export via module.exports)
var admin = require('../../js/admin.js');

// ---------------------------------------------------------------------------
// XML helper — builds a DOMParser document from recipe inner XML
// ---------------------------------------------------------------------------
function buildXML(recipeXml) {
  var parser = new DOMParser();
  return parser.parseFromString(
    '<?xml version="1.0"?><RECIPES><RECIPE>' + recipeXml + '</RECIPE></RECIPES>',
    'application/xml'
  );
}

// ---------------------------------------------------------------------------
// DOM fixture — this jsdom testEnvironment ignores the top-of-file
// global.document reassignment above (jest-environment-jsdom's `document`
// global is not replaceable), so document.getElementById here resolves
// against the REAL jsdom document. Functions exercising the BeerXML review
// modal + recipe-editor carry-through (D-12/D-13/D-14) touch a real set of
// admin-panel DOM ids -- this fixture provides exactly the ids those code
// paths read/write, built fresh before each test that needs it.
// ---------------------------------------------------------------------------
function resetAdminDomFixture() {
  document.body.innerHTML =
    '<div id="admin-modal" style="display:none">' +
    '  <div class="admin-modal-content">' +
    '    <button id="admin-modal-close"></button>' +
    '    <h2 id="admin-modal-title"></h2>' +
    '    <div id="admin-modal-body"></div>' +
    '  </div>' +
    '</div>' +
    '<div id="admin-modal-overlay"></div>' +
    '<div id="recipes-list-view"></div>' +
    '<div id="recipes-detail-view"></div>' +
    '<h2 id="recipes-detail-title"></h2>' +
    '<button id="recipes-delete-btn"></button>' +
    '<button id="recipes-duplicate-btn"></button>' +
    '<button id="recipes-save-btn"></button>' +
    '<div id="recipes-availability-banner"></div>' +
    '<table><tbody id="recipes-ingredients-body"></tbody></table>' +
    '<div id="recipes-ingredients-empty"></div>' +
    '<input id="recipe-name" />' +
    '<input id="recipe-style" />' +
    '<textarea id="recipe-description"></textarea>' +
    '<input id="recipe-batch-size" />' +
    '<input id="recipe-abv" />' +
    '<input id="recipe-ibu" />' +
    '<input id="recipe-colour" />' +
    '<select id="recipe-schedule-select"></select>' +
    '<p id="recipe-schedule-warning"></p>' +
    '<input id="recipe-locked-price" />' +
    '<input id="recipe-service-fee" />' +
    '<input id="recipe-materials-fee" />' +
    '<select id="recipe-status"></select>' +
    '<select id="recipe-pricing-mode"></select>' +
    '<div id="recipe-status-error"></div>';
}

// ---------------------------------------------------------------------------
// parseBeerXML
// ---------------------------------------------------------------------------
describe('parseBeerXML', function () {
  test('extracts recipe name, style, ABV, batch size, IBU, colour', function () {
    var xmlDoc = buildXML(
      '<NAME>Burton Ale</NAME>' +
      '<STYLE><NAME>English Pale Ale</NAME></STYLE>' +
      '<EST_ABV>5.2</EST_ABV>' +
      '<BATCH_SIZE>18.93</BATCH_SIZE>' +
      '<EST_IBU>35</EST_IBU>' +
      '<EST_COLOR>8</EST_COLOR>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.name).toBe('Burton Ale');
    expect(result.style).toBe('English Pale Ale');
    expect(result.abv).toBe(5.2);
    expect(result.batch_size_l).toBe(18.93);
    expect(result.ibu).toBe(35);
    expect(result.colour_srm).toBe(8);
  });

  test('extracts fermentable with AMOUNT in kg', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<FERMENTABLES><FERMENTABLE>' +
      '<NAME>Pale Malt</NAME><AMOUNT>3.629</AMOUNT>' +
      '</FERMENTABLE></FERMENTABLES>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.ingredients).toHaveLength(1);
    var ing = result.ingredients[0];
    expect(ing.beerxml_name).toBe('Pale Malt');
    expect(ing.beerxml_type).toBe('fermentable');
    expect(ing.amount_kg).toBe(3.629);
    expect(ing.unit).toBe('kg');
    expect(ing.amount_display).toBe('3.629 kg');
  });

  test('converts hop AMOUNT from kg to grams', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<HOPS><HOP>' +
      '<NAME>Cascade</NAME><AMOUNT>0.028</AMOUNT>' +
      '</HOP></HOPS>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.ingredients).toHaveLength(1);
    var ing = result.ingredients[0];
    expect(ing.beerxml_type).toBe('hop');
    expect(ing.amount_kg).toBe(0.028);
    expect(ing.amount_display).toBe('28.0 g');
    expect(ing.unit).toBe('g');
  });

  test('sets yeast to 1 pcs regardless of AMOUNT', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<YEASTS><YEAST>' +
      '<NAME>US-05</NAME><AMOUNT>0.035</AMOUNT>' +
      '</YEAST></YEASTS>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.ingredients).toHaveLength(1);
    var ing = result.ingredients[0];
    expect(ing.beerxml_type).toBe('yeast');
    expect(ing.amount_kg).toBe(1);
    expect(ing.amount_display).toBe('1 pcs');
    expect(ing.unit).toBe('pcs');
  });

  test('handles misc with AMOUNT_IS_WEIGHT true as grams', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<MISCS><MISC>' +
      '<NAME>Irish Moss</NAME><AMOUNT>0.007</AMOUNT><AMOUNT_IS_WEIGHT>TRUE</AMOUNT_IS_WEIGHT>' +
      '</MISC></MISCS>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.ingredients).toHaveLength(1);
    var ing = result.ingredients[0];
    expect(ing.beerxml_type).toBe('misc');
    expect(ing.unit).toBe('g');
    expect(ing.amount_display).toBe('7.0 g');
  });

  test('handles misc with AMOUNT_IS_WEIGHT false as liters', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<MISCS><MISC>' +
      '<NAME>Lactic Acid</NAME><AMOUNT>0.005</AMOUNT>' +
      '</MISC></MISCS>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.ingredients).toHaveLength(1);
    var ing = result.ingredients[0];
    expect(ing.beerxml_type).toBe('misc');
    expect(ing.unit).toBe('L');
    expect(ing.amount_display).toBe('0.005 L');
  });

  test('returns null when no RECIPE element', function () {
    var parser = new DOMParser();
    var xmlDoc = parser.parseFromString(
      '<?xml version="1.0"?><RECIPES></RECIPES>',
      'application/xml'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).toBeNull();
  });

  test('uses first recipe when multiple exist', function () {
    var parser = new DOMParser();
    var xmlDoc = parser.parseFromString(
      '<?xml version="1.0"?><RECIPES>' +
      '<RECIPE><NAME>First</NAME></RECIPE>' +
      '<RECIPE><NAME>Second</NAME></RECIPE>' +
      '</RECIPES>',
      'application/xml'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.name).toBe('First');
  });

  test('handles missing optional fields gracefully', function () {
    var xmlDoc = buildXML('<NAME>Minimal Recipe</NAME>');
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.name).toBe('Minimal Recipe');
    expect(result.style).toBe('');
    expect(result.ibu).toBe(0);
    expect(result.colour_srm).toBe(0);
  });

  test('does not convert fermentable AMOUNT under 20 (treats as kg)', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<FERMENTABLES><FERMENTABLE>' +
      '<NAME>Pale Malt</NAME><AMOUNT>8.0</AMOUNT>' +
      '</FERMENTABLE></FERMENTABLES>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    var ing = result.ingredients[0];
    expect(ing.amount_kg).toBe(8.0);
    expect(ing.amount_display).toBe('8.000 kg');
  });

  test('detects probable lbs and converts when any fermentable AMOUNT exceeds 20 (per D-08)', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<FERMENTABLES>' +
      '<FERMENTABLE><NAME>Pale Malt</NAME><AMOUNT>22.0</AMOUNT></FERMENTABLE>' +
      '<FERMENTABLE><NAME>Crystal Malt</NAME><AMOUNT>1.5</AMOUNT></FERMENTABLE>' +
      '</FERMENTABLES>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result).not.toBeNull();
    expect(result.ingredients).toHaveLength(2);
    // Both amounts should be converted from lbs
    expect(result.ingredients[0].amount_kg).toBeCloseTo(22.0 * 0.453592, 3);
    expect(result.ingredients[1].amount_kg).toBeCloseTo(1.5 * 0.453592, 3);
    // Display should note the conversion
    expect(result.ingredients[0].amount_display).toContain('converted from lbs');
    expect(result.ingredients[1].amount_display).toContain('converted from lbs');
  });
});

// ---------------------------------------------------------------------------
// parseBeerXML — D-12 fermentation timing extraction (ferment_days_beerxml)
// ---------------------------------------------------------------------------
describe('parseBeerXML fermentation timing (D-12)', function () {
  test('sums PRIMARY_AGE + SECONDARY_AGE when no TERTIARY_AGE is present', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<PRIMARY_AGE>14</PRIMARY_AGE>' +
      '<SECONDARY_AGE>21</SECONDARY_AGE>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result.ferment_days_beerxml).toBe(35);
  });

  test('uses PRIMARY_AGE alone when no other timing tag is present', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<PRIMARY_AGE>14</PRIMARY_AGE>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result.ferment_days_beerxml).toBe(14);
  });

  test('sums all three vessel timing tags when all are present', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<PRIMARY_AGE>4</PRIMARY_AGE>' +
      '<SECONDARY_AGE>10</SECONDARY_AGE>' +
      '<TERTIARY_AGE>7</TERTIARY_AGE>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result.ferment_days_beerxml).toBe(21);
  });

  test('omits ferment_days_beerxml entirely when no timing tag is present', function () {
    var xmlDoc = buildXML('<NAME>Test Recipe</NAME>');
    var result = admin.parseBeerXML(xmlDoc);
    expect('ferment_days_beerxml' in result).toBe(false);
  });

  test('omits ferment_days_beerxml when every timing tag present is 0', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<PRIMARY_AGE>0</PRIMARY_AGE>' +
      '<SECONDARY_AGE>0</SECONDARY_AGE>' +
      '<TERTIARY_AGE>0</TERTIARY_AGE>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect('ferment_days_beerxml' in result).toBe(false);
  });

  test('never reads AGE (post-packaging conditioning is out of scope per D-01)', function () {
    var xmlDoc = buildXML(
      '<NAME>Test Recipe</NAME>' +
      '<PRIMARY_AGE>14</PRIMARY_AGE>' +
      '<AGE>90</AGE>'
    );
    var result = admin.parseBeerXML(xmlDoc);
    expect(result.ferment_days_beerxml).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// showBeerXMLReviewModal meta-line — D-12 BeerXML fermentation claim segment
// ---------------------------------------------------------------------------
describe('showBeerXMLReviewModal meta-line ferment segment (D-12)', function () {
  beforeEach(function () {
    resetAdminDomFixture();
  });

  test('meta line ends with the BeerXML days-ferment segment when a timing total exists', function () {
    var xmlDoc = buildXML(
      '<NAME>Burton Ale</NAME>' +
      '<STYLE><NAME>English Pale Ale</NAME></STYLE>' +
      '<EST_ABV>5.2</EST_ABV>' +
      '<PRIMARY_AGE>14</PRIMARY_AGE>' +
      '<SECONDARY_AGE>21</SECONDARY_AGE>'
    );
    var parsed = admin.parseBeerXML(xmlDoc);
    var matchedRows = admin.autoMatchIngredients(parsed);
    admin.showBeerXMLReviewModal(parsed, matchedRows);
    var metaLineEl = document.querySelector('.beerxml-meta-line');
    expect(metaLineEl.textContent).toBe('English Pale Ale · 5.2% ABV · BeerXML: 35 days ferment');
  });

  test('meta line contains no BeerXML segment when the file carried no timing tags', function () {
    var xmlDoc = buildXML(
      '<NAME>Burton Ale</NAME>' +
      '<STYLE><NAME>English Pale Ale</NAME></STYLE>'
    );
    var parsed = admin.parseBeerXML(xmlDoc);
    var matchedRows = admin.autoMatchIngredients(parsed);
    admin.showBeerXMLReviewModal(parsed, matchedRows);
    var metaLineEl = document.querySelector('.beerxml-meta-line');
    expect(metaLineEl.textContent).not.toContain('BeerXML:');
  });
});

// ---------------------------------------------------------------------------
// autoMatchIngredients
// ---------------------------------------------------------------------------
describe('autoMatchIngredients', function () {
  beforeEach(function () {
    admin._recipesState.catalog = [
      { item_id: '111', name: 'Pale Malt 2-Row', sku: 'MALT-001', unit: 'kg', purchase_rate: 2.50, rate: 3.00 },
      { item_id: '222', name: 'Cascade Hops', sku: 'HOP-001', unit: 'g', purchase_rate: 0.10, rate: 0.15 },
      { item_id: '333', name: 'Safale US-05', sku: 'YEAST-001', unit: 'pcs', purchase_rate: 5.00, rate: 7.00 }
    ];
    admin._recipesState.catalogLoaded = true;
  });

  test('matches fermentable to catalog item and returns high confidence for single match', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Pale Malt 2-Row', beerxml_type: 'fermentable', amount_kg: 3.629, amount_display: '3.629 kg', unit: 'kg' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].zoho_match).not.toBeNull();
    expect(result[0].zoho_match.item_id).toBe('111');
    expect(result[0].confidence).toBe('high');
  });

  test('returns low confidence when multiple catalog items match', function () {
    // Add a second item that also matches "Pale Malt"
    admin._recipesState.catalog.push(
      { item_id: '444', name: 'Pale Malt Munich', sku: 'MALT-002', unit: 'kg', purchase_rate: 2.80, rate: 3.20 }
    );
    var parsed = {
      ingredients: [
        { beerxml_name: 'Pale Malt', beerxml_type: 'fermentable', amount_kg: 3.629, amount_display: '3.629 kg', unit: 'kg' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe('low');
  });

  test('returns none confidence and null match when no results', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Unicorn Dust', beerxml_type: 'fermentable', amount_kg: 1.0, amount_display: '1.000 kg', unit: 'kg' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].zoho_match).toBeNull();
    expect(result[0].confidence).toBe('none');
  });

  test('sets skipped to false for all items', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Pale Malt 2-Row', beerxml_type: 'fermentable', amount_kg: 3.629, amount_display: '3.629 kg', unit: 'kg' },
        { beerxml_name: 'Unicorn Dust', beerxml_type: 'fermentable', amount_kg: 1.0, amount_display: '1.000 kg', unit: 'kg' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result[0].skipped).toBe(false);
    expect(result[1].skipped).toBe(false);
  });

  test('sets hop quantity to amount_kg * 1000', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Cascade Hops', beerxml_type: 'hop', amount_kg: 0.028, amount_display: '28.0 g', unit: 'g' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(28);
  });

  test('sets fermentable quantity to amount_kg', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Pale Malt 2-Row', beerxml_type: 'fermentable', amount_kg: 3.629, amount_display: '3.629 kg', unit: 'kg' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(3.629);
  });

  test('sets yeast quantity to 1', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Safale US-05', beerxml_type: 'yeast', amount_kg: 1, amount_display: '1 pcs', unit: 'pcs' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(1);
  });

  test('sets misc weight quantity to amount_kg * 1000 (grams)', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Irish Moss', beerxml_type: 'misc', amount_kg: 0.007, amount_display: '7.0 g', unit: 'g' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(7);
  });

  test('sets misc volume quantity to raw amount_kg', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Lactic Acid', beerxml_type: 'misc', amount_kg: 0.005, amount_display: '0.005 L', unit: 'L' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(0.005);
  });

  test('avoids floating-point precision artifacts in gram quantities', function () {
    var parsed = {
      ingredients: [
        { beerxml_name: 'Cascade Hops', beerxml_type: 'hop', amount_kg: 0.0142, amount_display: '14.2 g', unit: 'g' }
      ]
    };
    var result = admin.autoMatchIngredients(parsed);
    expect(result[0].quantity).toBe(14.2);
  });
});

// ---------------------------------------------------------------------------
// confirmBeerXMLImport schedule carry-through (Task 3, the verified defect)
// ---------------------------------------------------------------------------
describe('confirmBeerXMLImport schedule_id carry-through', function () {
  beforeEach(function () {
    resetAdminDomFixture();
    admin._setFermSchedulesDataForTest([
      { schedule_id: 'SCHED-1', name: 'Standard Ale', category: 'beer' }
    ]);
  });

  // Stands in for the modal's real #beerxml-schedule-select (normally created
  // dynamically inside #admin-modal-body by showBeerXMLReviewModal). A plain
  // value-bearing element is sufficient here: confirmBeerXMLImport only reads
  // .value, and an <input> avoids needing a matching <option> the way a real
  // <select> would.
  function seedBeerxmlScheduleSelect(value) {
    var el = document.createElement('input');
    el.type = 'hidden';
    el.id = 'beerxml-schedule-select';
    el.value = value;
    document.body.appendChild(el);
  }

  test('a template selected in the review modal survives Confirm Import into #recipe-schedule-select', function () {
    seedBeerxmlScheduleSelect('SCHED-1');
    var parsedRecipe = { name: 'Test Ale', style: 'IPA', abv: 5.5, batch_size_l: 20, ibu: 40, colour_srm: 8 };
    admin.confirmBeerXMLImport(parsedRecipe, []);
    var scheduleSelectEl = document.getElementById('recipe-schedule-select');
    expect(scheduleSelectEl.innerHTML).toContain('value="SCHED-1" selected');
  });

  test('no template selected leaves #recipe-schedule-select empty and does not fire the D-11 warning (imported recipe is draft)', function () {
    seedBeerxmlScheduleSelect('');
    var parsedRecipe = { name: 'Test Ale', style: 'IPA', abv: 5.5, batch_size_l: 20, ibu: 40, colour_srm: 8 };
    admin.confirmBeerXMLImport(parsedRecipe, []);
    var scheduleSelectEl = document.getElementById('recipe-schedule-select');
    expect(scheduleSelectEl.innerHTML).not.toContain('selected');
    var warningEl = document.getElementById('recipe-schedule-warning');
    expect(warningEl.textContent).toBe('');
  });

  test('does not throw when #beerxml-schedule-select is absent (defends the read against a torn-down modal)', function () {
    // No seedBeerxmlScheduleSelect() call -- simulates closeModal having
    // already removed the element. confirmBeerXMLImport's element-exists
    // guard must default to an empty schedule_id rather than throw.
    var parsedRecipe = { name: 'Test Ale', style: 'IPA', abv: 5.5, batch_size_l: 20, ibu: 40, colour_srm: 8 };
    expect(function () { admin.confirmBeerXMLImport(parsedRecipe, []); }).not.toThrow();
    var scheduleSelectEl = document.getElementById('recipe-schedule-select');
    expect(scheduleSelectEl.innerHTML).not.toContain('selected');
  });
});
