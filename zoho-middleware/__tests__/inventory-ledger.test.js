'use strict';

// ---------------------------------------------------------------------------
// Mocks — must be declared before require()
// ---------------------------------------------------------------------------
jest.mock('../lib/cache', function () {
  return {
    getClient: jest.fn()
  };
});

jest.mock('../lib/logger', function () {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
});

var cache = require('../lib/cache');
var ledger = require('../lib/inventory-ledger');

// ---------------------------------------------------------------------------
// Shared mock pipeline / client factory
// ---------------------------------------------------------------------------
function makePipeline(execResult) {
  return {
    set: jest.fn().mockReturnThis(),
    incr: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    decrBy: jest.fn().mockReturnThis(),
    lPush: jest.fn().mockReturnThis(),
    lTrim: jest.fn().mockReturnThis(),
    get: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(execResult !== undefined ? execResult : [])
  };
}

function makeClient(pipeline) {
  return {
    multi: jest.fn().mockReturnValue(pipeline),
    get: jest.fn().mockResolvedValue(null)
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(function () {
  process.env.INVENTORY_LEDGER_ENABLED = 'true';
});

afterEach(function () {
  delete process.env.INVENTORY_LEDGER_ENABLED;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// reconcile()
// ---------------------------------------------------------------------------
describe('reconcile()', function () {
  test('sets stock keys for all items with stock_on_hand', function () {
    var pipeline = makePipeline([]);
    var client = makeClient(pipeline);
    cache.getClient.mockResolvedValue(client);

    var items = [
      { item_id: 'A1', stock_on_hand: 10 },
      { item_id: 'B2', stock_on_hand: 5 }
    ];

    return ledger.reconcile(items).then(function () {
      expect(pipeline.set).toHaveBeenCalledWith('inv:stock:A1', '10', { EX: 7200 });
      expect(pipeline.set).toHaveBeenCalledWith('inv:stock:B2', '5', { EX: 7200 });
    });
  });

  test('increments version counter', function () {
    var pipeline = makePipeline([]);
    var client = makeClient(pipeline);
    cache.getClient.mockResolvedValue(client);

    var items = [{ item_id: 'A1', stock_on_hand: 10 }];

    return ledger.reconcile(items).then(function () {
      expect(pipeline.incr).toHaveBeenCalledWith('inv:stock:version');
      expect(pipeline.expire).toHaveBeenCalledWith('inv:stock:version', 7200);
    });
  });

  test('is a no-op when INVENTORY_LEDGER_ENABLED is not true', function () {
    delete process.env.INVENTORY_LEDGER_ENABLED;

    var items = [{ item_id: 'A1', stock_on_hand: 10 }];

    return ledger.reconcile(items).then(function () {
      expect(cache.getClient).not.toHaveBeenCalled();
    });
  });

  test('is a no-op when Redis client is null', function () {
    cache.getClient.mockResolvedValue(null);

    var items = [{ item_id: 'A1', stock_on_hand: 10 }];

    return ledger.reconcile(items).then(function () {
      // Should resolve without error; no pipeline created
      expect(cache.getClient).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// decrementStock()
// ---------------------------------------------------------------------------
describe('decrementStock()', function () {
  test('decrements stock for each line item', function () {
    var pipeline = makePipeline([]);
    var client = makeClient(pipeline);
    cache.getClient.mockResolvedValue(client);

    var lineItems = [
      { item_id: 'A1', quantity: 2 },
      { item_id: 'B2', quantity: 1 }
    ];

    return ledger.decrementStock(lineItems, 'checkout:SO-00001').then(function () {
      expect(pipeline.decrBy).toHaveBeenCalledWith('inv:stock:A1', 2);
      expect(pipeline.decrBy).toHaveBeenCalledWith('inv:stock:B2', 1);
    });
  });

  test('logs adjustment entries to the adjustments list', function () {
    var pipeline = makePipeline([]);
    var client = makeClient(pipeline);
    cache.getClient.mockResolvedValue(client);

    var lineItems = [{ item_id: 'A1', quantity: 3 }];
    var reason = 'checkout:SO-00002';

    return ledger.decrementStock(lineItems, reason).then(function () {
      expect(pipeline.lPush).toHaveBeenCalledTimes(1);
      var pushCall = pipeline.lPush.mock.calls[0];
      expect(pushCall[0]).toBe('inv:adjustments:log');
      var entry = JSON.parse(pushCall[1]);
      expect(entry.item_id).toBe('A1');
      expect(entry.delta).toBe(-3);
      expect(entry.reason).toBe(reason);
      expect(entry.timestamp).toBeDefined();

      expect(pipeline.lTrim).toHaveBeenCalledWith('inv:adjustments:log', 0, 999);
    });
  });

  test('is a no-op when INVENTORY_LEDGER_ENABLED is not true', function () {
    delete process.env.INVENTORY_LEDGER_ENABLED;

    var lineItems = [{ item_id: 'A1', quantity: 2 }];

    return ledger.decrementStock(lineItems, 'checkout:SO-00003').then(function () {
      expect(cache.getClient).not.toHaveBeenCalled();
    });
  });

  test('is a no-op when Redis client is null', function () {
    cache.getClient.mockResolvedValue(null);

    var lineItems = [{ item_id: 'A1', quantity: 2 }];

    return ledger.decrementStock(lineItems, 'checkout:SO-00004').then(function () {
      expect(cache.getClient).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// overlayStock()
// ---------------------------------------------------------------------------
describe('overlayStock()', function () {
  test('replaces stock_on_hand with ledger values where available', function () {
    // exec returns one result per GET call (raw string values)
    var pipeline = makePipeline(['42', '7']);
    var client = makeClient(pipeline);
    cache.getClient.mockResolvedValue(client);

    var items = [
      { item_id: 'A1', stock_on_hand: 100 },
      { item_id: 'B2', stock_on_hand: 50 }
    ];

    return ledger.overlayStock(items).then(function (result) {
      expect(result[0].stock_on_hand).toBe(42);
      expect(result[1].stock_on_hand).toBe(7);
    });
  });

  test('preserves catalog stock_on_hand when no ledger entry exists (null result)', function () {
    // exec returns null for the second item (no ledger entry)
    var pipeline = makePipeline(['20', null]);
    var client = makeClient(pipeline);
    cache.getClient.mockResolvedValue(client);

    var items = [
      { item_id: 'A1', stock_on_hand: 100 },
      { item_id: 'B2', stock_on_hand: 50 }
    ];

    return ledger.overlayStock(items).then(function (result) {
      expect(result[0].stock_on_hand).toBe(20);
      expect(result[1].stock_on_hand).toBe(50); // unchanged
    });
  });

  test('floors negative values to 0 using Math.max(0, ...)', function () {
    var pipeline = makePipeline(['-5']);
    var client = makeClient(pipeline);
    cache.getClient.mockResolvedValue(client);

    var items = [{ item_id: 'A1', stock_on_hand: 10 }];

    return ledger.overlayStock(items).then(function (result) {
      expect(result[0].stock_on_hand).toBe(0);
    });
  });

  test('returns items unchanged when Redis client is null', function () {
    cache.getClient.mockResolvedValue(null);

    var items = [{ item_id: 'A1', stock_on_hand: 99 }];

    return ledger.overlayStock(items).then(function (result) {
      expect(result).toBe(items);
      expect(result[0].stock_on_hand).toBe(99);
    });
  });
});

// ---------------------------------------------------------------------------
// getStock()
// ---------------------------------------------------------------------------
describe('getStock()', function () {
  test('returns null when Redis client is null', function () {
    cache.getClient.mockResolvedValue(null);

    return ledger.getStock('A1').then(function (result) {
      expect(result).toBeNull();
    });
  });
});
