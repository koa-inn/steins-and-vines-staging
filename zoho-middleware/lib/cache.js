/**
 * Redis cache layer.
 *
 * Connects lazily on first use. If Redis is unavailable the server
 * still works — cache misses just fall through to the Zoho API.
 */

var redis = require('redis');

var client = null;
var connected = false;

function getClient() {
  if (client) return Promise.resolve(client);

  client = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: {
      reconnectStrategy: false   // don't retry — fail fast if Redis is down
    }
  });

  client.on('error', function (err) {
    if (connected) {
      console.error('[redis] Connection lost:', err.message);
    }
    connected = false;
  });

  client.on('ready', function () {
    connected = true;
    console.log('[redis] Connected');
  });

  return client.connect().then(function () {
    connected = true;
    return client;
  }).catch(function (err) {
    console.error('[redis] Failed to connect:', err.message);
    console.error('[redis] Caching disabled — API calls will hit Zoho directly');
    connected = false;
    client = null;  // allow fresh attempt if Redis comes up later
    return null;
  });
}

/**
 * Get a cached value by key.
 * Returns null on miss or if Redis is unavailable.
 */
function get(key) {
  if (!connected) return Promise.resolve(null);

  return getClient().then(function (c) {
    return c.get(key);
  }).then(function (val) {
    if (val === null) return null;
    try {
      return JSON.parse(val);
    } catch (e) {
      return null;
    }
  }).catch(function () {
    return null;
  });
}

/**
 * Store a value in cache with a TTL (in seconds).
 */
function set(key, value, ttlSeconds) {
  if (!connected) return Promise.resolve();

  return getClient().then(function (c) {
    return c.set(key, JSON.stringify(value), { EX: ttlSeconds });
  }).catch(function (err) {
    console.error('[redis] Failed to set cache:', err.message);
  });
}

/**
 * Delete a cached key (useful for cache invalidation after writes).
 */
function del(key) {
  if (!connected) return Promise.resolve();

  return getClient().then(function (c) {
    return c.del(key);
  }).catch(function () {});
}

/**
 * Initialize the Redis connection eagerly (call at server startup).
 */
function init() {
  return getClient();
}

module.exports = {
  get: get,
  set: set,
  del: del,
  init: init
};
