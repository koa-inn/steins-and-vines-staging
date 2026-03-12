var log = require('./logger');
var cache = require('./cache');

function checkRedis() {
  return cache.getClient().then(function (client) {
    return client.ping();
  }).then(function () {
    log.info('[startup] Redis connected');
  }).catch(function (err) {
    log.warn('[startup] Redis unavailable — rate limiting, idempotency, and inventory ledger disabled (' + err.message + ')');
  });
}

module.exports = checkRedis;
