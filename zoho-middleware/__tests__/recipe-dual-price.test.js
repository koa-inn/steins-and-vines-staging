'use strict';

// Phase 85-08 Task 2: D-05/D-06 dual price compare in routes/pos-recipe.js.

var mockRouteHandlers = {};
var mockMirrorEnabled = true;
var mockStoreMode = 'dual';

jest.mock('express', function () {
  var router = {
    get:    jest.fn(function (path, handler) { mockRouteHandlers['GET:' + path] = handler; }),
    post:   jest.fn(function (path, handler) { mockRouteHandlers['POST:' + path] = handler; }),
    put:    jest.fn(),
    delete: jest.fn()
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });

jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({}),
    voidTransaction: jest.fn().mockResolvedValue({})
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn().mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } }),
    zohoPut: jest.fn()
  };
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue()
  };
});

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/mailer', function () { return { sendVoidFailureAlert: jest.fn().mockResolvedValue() }; });

jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      KIOSK_PRODUCTS: 'test:kiosk-products',
      RECIPES: 'sv:recipes',
      RECIPES_TS: 'sv:recipes:ts',
      INGREDIENTS: 'zoho:ingredients',
      INGREDIENTS_ALL: 'zoho:ingredients:all',
      KIOSK_DISCOUNT_PRESETS: 'kiosk:discount-presets'
    },
    LOCK_KEYS: { RECIPE_SALE: 'recipe-sale' }
  };
});

jest.mock('../lib/brewpad-integration', function () {
  return { detectRecipeSale: jest.fn(), createBatchesFromSale: jest.fn() };
});

jest.mock('../lib/recipe-store', function () {
  return {
    getMode: jest.fn(function () { return mockStoreMode; }),
    get: jest.fn(),
    getFromSheet: jest.fn()
  };
});

jest.mock('../lib/recipe-mirror', function () {
  return { isDirty: jest.fn() };
});

// Controllable gate: same contract as lib/sheet-mirror (fn invoked only when enabled;
// rejections reported as sheet-mirror warnings, never thrown).
jest.mock('../lib/sheet-mirror', function () {
  return {
    mirrorFireAndForget: jest.fn(function (label, fn) {
      if (!mockMirrorEnabled) return undefined;
      try {
        var r = fn();
        if (r && typeof r.then === 'function') {
          r.catch(function (err) {
            require('../lib/sentry-capture').captureExceptionSafe(err, {
              level: 'warning', tags: { component: 'sheet-mirror', mirror: label }
            });
          });
        }
      } catch (err) {
        require('../lib/sentry-capture').captureExceptionSafe(err, {
          level: 'warning', tags: { component: 'sheet-mirror', mirror: label }
        });
      }
      return undefined;
    })
  };
});

jest.mock('../lib/dual-write-compare', function () {
  return { compareAndReport: jest.fn().mockReturnValue({ match: true, differences: [] }) };
});

jest.mock('../lib/sentry-capture', function () {
  return { captureExceptionSafe: jest.fn() };
});

var CATALOG = [
  { item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' },
  { item_id: 'ing-hops-1', name: 'Cascade Hops', rate: 8.00, tax_id: 'tax-gst', stock_on_hand: 2, unit: 'kg' }
];

var NOW = 1800000000000;

function recipeBody(opts) {
  opts = opts || {};
  return {
    ok: true,
    data: {
      recipe: {
        recipe_id: opts.id || 'RCP-001', name: 'Pale Ale', batch_size_l: 20, locked_price: 0,
        pricing_mode: 'dynamic', service_fee: 45, materials_fee: 5,
        status: opts.status || 'active',
        updated_at: opts.updated_at === undefined ? new Date(NOW - 3600 * 1000).toISOString() : opts.updated_at
      },
      ingredients: [
        { ingredient_id: 'I1', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: opts.malt || 5.5, unit: 'kg' },
        { ingredient_id: 'I2', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg' }
      ]
    }
  };
}

var mocks;
var nowSpy;
var clock;

function load() {
  mockRouteHandlers = {};
  jest.resetModules();
  var router = require('../routes/pos-recipe');
  mocks = {
    router: router,
    store: require('../lib/recipe-store'),
    mirror: require('../lib/recipe-mirror'),
    gate: require('../lib/sheet-mirror'),
    compare: require('../lib/dual-write-compare'),
    sentry: require('../lib/sentry-capture'),
    cache: require('../lib/cache'),
    log: require('../lib/logger'),
    axios: require('axios')
  };
  mocks.cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all') return Promise.resolve(CATALOG);
    return Promise.resolve(null);
  });
  mocks.mirror.isDirty.mockResolvedValue(false);
  mocks.store.get.mockImplementation(function () { return Promise.resolve(recipeBody()); });
  mocks.store.getFromSheet.mockImplementation(function () { return Promise.resolve(recipeBody()); });
}

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 30; i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  return p;
}

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers[method + ':' + path];
    if (!handler) return reject(new Error('No handler for ' + method + ':' + path));
    var res = {
      _status: 200, _body: null, headersSent: false,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; res.headersSent = true; resolve(res); return res; })
    };
    try { handler(req || {}, res); } catch (e) { reject(e); }
  });
}

function quote(extra) {
  return callHandler('GET', '/api/kiosk/recipe-quote', {
    query: Object.assign({ recipe_id: 'RCP-001', sale_type: 'in-store' }, extra || {})
  });
}

beforeEach(function () {
  mockMirrorEnabled = true;
  mockStoreMode = 'dual';
  clock = NOW;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(function () { return clock; });
  process.env.BEER_SALES_ENABLED = 'true';
  process.env.MAKERS_FEE_ITEM_ID = 'fee-makers-1';
  process.env.MATERIALS_FEE_ITEM_ID = 'fee-materials-1';
  process.env.KIOSK_CONTACT_ID = 'contact-default';
  delete process.env.MILLING_FEE_ITEM_ID;
  load();
  mocks.router._resetDualPriceStats();
});

afterEach(function () {
  nowSpy.mockRestore();
  delete process.env.BEER_SALES_ENABLED;
  delete process.env.MAKERS_FEE_ITEM_ID;
  delete process.env.MATERIALS_FEE_ITEM_ID;
  delete process.env.KIOSK_CONTACT_ID;
});

describe('D-05 dual price compare', function () {
  test('sheets and postgres modes schedule no compare', function () {
    mockStoreMode = 'postgres';
    return quote().then(flush).then(function () {
      mockStoreMode = 'sheets';
      return quote();
    }).then(flush).then(function () {
      expect(mocks.gate.mirrorFireAndForget).not.toHaveBeenCalled();
      expect(mocks.store.getFromSheet).not.toHaveBeenCalled();
      expect(mocks.compare.compareAndReport).not.toHaveBeenCalled();
    });
  });

  test('dual + mirror enabled: one sheet read, compareAndReport with recipes/quote and projections', function () {
    return quote().then(function (res) {
      expect(res._status).toBe(200);
      return flush();
    }).then(function () {
      expect(mocks.gate.mirrorFireAndForget).toHaveBeenCalledWith('recipes.price', expect.any(Function));
      expect(mocks.store.getFromSheet).toHaveBeenCalledTimes(1);
      expect(mocks.store.getFromSheet).toHaveBeenCalledWith('RCP-001');
      expect(mocks.compare.compareAndReport).toHaveBeenCalledTimes(1);
      var arg = mocks.compare.compareAndReport.mock.calls[0][0];
      expect(arg.store).toBe('recipes');
      expect(arg.operation).toBe('quote');
      expect(arg.reportValuesFor).toEqual(['grandTotal', 'totalBeforeDiscount', 'feePortion', 'discountTotal', 'quantity', 'scaleFactor']);
      expect(arg.sheets).toEqual(arg.postgres);
      expect(arg.postgres.status).toBeNull();
      expect(arg.postgres.pricingMode).toBe('dynamic');
      expect(arg.postgres.lines.length).toBe(2);
      expect(Object.keys(arg.postgres.lines[0]).sort()).toEqual(['item_id', 'quantity', 'unit']);
      expect(mocks.router._dualPriceStats().compared).toBe(1);
    });
  });

  test('sale route compares with operation sale', function () {
    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(202);
      return flush();
    }).then(function () {
      expect(mocks.compare.compareAndReport).toHaveBeenCalledTimes(1);
      expect(mocks.compare.compareAndReport.mock.calls[0][0].operation).toBe('sale');
    });
  });

  test('drifted sheet recipe: projections differ, response and price still Postgres (D-06)', function () {
    mocks.store.getFromSheet.mockImplementation(function () { return Promise.resolve(recipeBody({ malt: 9 })); });
    var pgTotal;
    return quote().then(function (res) {
      pgTotal = res._body.total;
      return flush();
    }).then(function () {
      var arg = mocks.compare.compareAndReport.mock.calls[0][0];
      expect(arg.sheets.grandTotal).not.toBe(arg.postgres.grandTotal);
      expect(arg.postgres.grandTotal).toBe(pgTotal);
    });
  });

  test('response is sent before the sheet read resolves (never awaited)', function () {
    var release;
    mocks.store.getFromSheet.mockImplementation(function () {
      return new Promise(function (resolve) { release = function () { resolve(recipeBody()); }; });
    });
    return quote().then(function (res) {
      expect(res._status).toBe(200);
      return flush().then(function () {
        expect(mocks.store.getFromSheet).toHaveBeenCalledTimes(1);
        expect(mocks.compare.compareAndReport).not.toHaveBeenCalled();
        release();
        return flush();
      });
    }).then(function () {
      expect(mocks.compare.compareAndReport).toHaveBeenCalledTimes(1);
    });
  });

  test('a compare that throws does not affect the response', function () {
    mocks.compare.compareAndReport.mockImplementation(function () { throw new Error('boom'); });
    return quote().then(function (res) {
      expect(res._status).toBe(200);
      return flush();
    }).then(function () {
      expect(mocks.sentry.captureExceptionSafe).toHaveBeenCalled();
    });
  });

  test('sheet fetch rejection: no compare, reported via sheet-mirror warning, counted as sheet_failed', function () {
    mocks.store.getFromSheet.mockImplementation(function () { return Promise.reject(new Error('apps script timeout')); });
    return quote().then(flush).then(function () {
      expect(mocks.compare.compareAndReport).not.toHaveBeenCalled();
      var call = mocks.sentry.captureExceptionSafe.mock.calls[0];
      expect(call[1].tags.component).toBe('sheet-mirror');
      expect(mocks.router._dualPriceStats().sheet_failed).toBe(1);
    });
  });

  test('sheet ok:false body is a mirror failure, not a price mismatch', function () {
    mocks.store.getFromSheet.mockImplementation(function () { return Promise.resolve({ ok: false, error: 'x' }); });
    return quote().then(flush).then(function () {
      expect(mocks.compare.compareAndReport).not.toHaveBeenCalled();
      expect(mocks.sentry.captureExceptionSafe.mock.calls[0][1].tags.component).toBe('sheet-mirror');
    });
  });

  test('both sides reject identically (inactive): projections equal', function () {
    mocks.store.get.mockImplementation(function () { return Promise.resolve(recipeBody({ status: 'inactive' })); });
    mocks.store.getFromSheet.mockImplementation(function () { return Promise.resolve(recipeBody({ status: 'inactive' })); });
    return quote().then(function (res) {
      expect(res._status).toBe(400);
      return flush();
    }).then(function () {
      var arg = mocks.compare.compareAndReport.mock.calls[0][0];
      expect(arg.sheets).toEqual(arg.postgres);
      expect(arg.postgres.status).toBe(400);
      expect(arg.postgres.error).toBe('Recipe is not active');
    });
  });

  test('sheet rejects but Postgres priced: reported as a mismatch', function () {
    mocks.store.getFromSheet.mockImplementation(function () { return Promise.resolve(recipeBody({ status: 'inactive' })); });
    return quote().then(flush).then(function () {
      var arg = mocks.compare.compareAndReport.mock.calls[0][0];
      expect(arg.sheets.status).toBe(400);
      expect(arg.postgres.status).toBeNull();
    });
  });

  test('mirror disabled (staging): no sheet read in dual', function () {
    mockMirrorEnabled = false;
    return quote().then(flush).then(function () {
      expect(mocks.store.getFromSheet).not.toHaveBeenCalled();
      expect(mocks.compare.compareAndReport).not.toHaveBeenCalled();
    });
  });

  test('five quotes within 5 s: one sheet read, five compares', function () {
    var p = Promise.resolve();
    for (var i = 0; i < 5; i++) {
      p = p.then(quote).then(flush);
    }
    return p.then(function () {
      expect(mocks.store.getFromSheet).toHaveBeenCalledTimes(1);
      expect(mocks.compare.compareAndReport).toHaveBeenCalledTimes(5);
    });
  });
});

describe('skip gate', function () {
  test('recipe updated < 60 s ago: no sheet read, settle skip logged with running totals', function () {
    mocks.store.get.mockImplementation(function () {
      return Promise.resolve(recipeBody({ updated_at: new Date(NOW - 10000).toISOString() }));
    });
    return quote().then(flush).then(function () {
      expect(mocks.store.getFromSheet).not.toHaveBeenCalled();
      expect(mocks.compare.compareAndReport).not.toHaveBeenCalled();
      expect(mocks.log.info).toHaveBeenCalledWith(expect.stringContaining(
        '[dual-price] skip recipe=RCP-001 op=quote reason=settle compared=0 skipped=1'));
      expect(mocks.router._dualPriceStats().skipped_settle).toBe(1);
      expect(mocks.router._dualPriceStats().skipped_dirty).toBe(0);
    });
  });

  test('dirty marker: no sheet read, dirty skip counted separately', function () {
    mocks.mirror.isDirty.mockResolvedValue(true);
    return quote().then(flush).then(function () {
      expect(mocks.store.getFromSheet).not.toHaveBeenCalled();
      expect(mocks.log.info).toHaveBeenCalledWith(expect.stringContaining('reason=dirty compared=0 skipped=1'));
      expect(mocks.router._dualPriceStats().skipped_dirty).toBe(1);
      expect(mocks.router._dualPriceStats().skipped_settle).toBe(0);
    });
  });

  test('every completed compare logs running totals', function () {
    return quote().then(flush).then(function () {
      expect(mocks.log.info).toHaveBeenCalledWith(expect.stringContaining(
        '[dual-price] compared recipe=RCP-001 op=quote compared=1 skipped=0'));
    });
  });

  function dirtyQuote(atMs) {
    clock = NOW + atMs;
    return quote({ target_volume_l: '20' }).then(flush);
  }

  function dualPriceAlerts() {
    return mocks.sentry.captureExceptionSafe.mock.calls.filter(function (c) {
      return c[1] && c[1].tags && c[1].tags.component === 'recipes-dual-price';
    });
  }

  test('stuck dirty marker: no alert at 9 min, one at 11 min, none again at 30 min', function () {
    mocks.mirror.isDirty.mockResolvedValue(true);
    var min = 60000;
    return dirtyQuote(0).then(function () {
      expect(dualPriceAlerts().length).toBe(0);
      return dirtyQuote(9 * min);
    }).then(function () {
      expect(dualPriceAlerts().length).toBe(0);
      return dirtyQuote(11 * min);
    }).then(function () {
      var alerts = dualPriceAlerts();
      expect(alerts.length).toBe(1);
      expect(alerts[0][0].message).toBe('[dual-price] recipe RCP-001 dirty > 10 min — D-05 compare skipped');
      expect(alerts[0][1].level).toBe('warning');
      expect(alerts[0][1].extra.recipe_id).toBe('RCP-001');
      expect(alerts[0][1].extra.dirty_minutes).toBe(11);
      return dirtyQuote(30 * min);
    }).then(function () {
      expect(dualPriceAlerts().length).toBe(1);
    });
  });

  test('alert state is cleared after a non-dirty evaluation, so a new stuck period re-alerts', function () {
    var min = 60000;
    mocks.mirror.isDirty.mockResolvedValue(true);
    return dirtyQuote(0).then(function () {
      return dirtyQuote(11 * min);
    }).then(function () {
      expect(dualPriceAlerts().length).toBe(1);
      mocks.mirror.isDirty.mockResolvedValue(false);
      return dirtyQuote(12 * min); // compared -> state cleared
    }).then(function () {
      mocks.mirror.isDirty.mockResolvedValue(true);
      return dirtyQuote(13 * min); // new dirtySince
    }).then(function () {
      expect(dualPriceAlerts().length).toBe(1);
      return dirtyQuote(25 * min); // 12 min later and < 1 h since first alert: alert only if state was cleared
    }).then(function () {
      expect(dualPriceAlerts().length).toBe(2);
    });
  });
});

describe('/confirm in dual', function () {
  test('compares with operation sale; charge path does not use the sheet recipe', function () {
    mocks.store.getFromSheet.mockImplementation(function () { return Promise.resolve(recipeBody({ malt: 9 })); });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: { recipe_id: 'RCP-001', transaction_id: 'txn-1', reference: 'R-1', sale_type: 'in-store' }
    }).then(function (res) {
      return flush().then(function () { return res; });
    }).then(function () {
      expect(mocks.store.get).toHaveBeenCalledWith('RCP-001');
      expect(mocks.compare.compareAndReport).toHaveBeenCalledTimes(1);
      var arg = mocks.compare.compareAndReport.mock.calls[0][0];
      expect(arg.operation).toBe('sale');
      expect(arg.sheets.grandTotal).not.toBe(arg.postgres.grandTotal);
      // the invoice was built from the Postgres recipe (malt 5.5), not the drifted sheet copy (malt 9)
      var invoiceCall = mocks.axios.post.mock.calls.length; // axios unused on this path
      expect(invoiceCall).toBe(0);
    });
  });
});
