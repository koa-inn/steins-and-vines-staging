require('dotenv').config();

var express = require('express');
var cors = require('cors');
var crypto = require('crypto');
var rateLimit = require('express-rate-limit');
var helmet = require('helmet');
var zohoAuth = require('./lib/zohoAuth');
var cache = require('./lib/cache');
var log = require('./lib/logger');
var gpLib = require('./lib/gp');

var app = express();
app.set('trust proxy', 1); // Railway sits behind a load balancer
var PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
var ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map(function(s) { return s.trim(); });
app.use(cors({
  origin: function(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Request logging middleware (attaches reqId, logs method/path/status/ms)
app.use(function (req, res, next) {
  var reqId = crypto.randomBytes(4).toString('hex');
  req.id = reqId;
  var start = Date.now();
  res.on('finish', function () {
    log.info(req.method + ' ' + req.path, { reqId: reqId, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

// ---------------------------------------------------------------------------
// Health check (used by Railway)
// ---------------------------------------------------------------------------

app.get('/health', function (req, res) {
  res.json({
    status: 'ok',
    authenticated: zohoAuth.isAuthenticated(),
    uptime: process.uptime()
  });
});

// ---------------------------------------------------------------------------
// Auth routes (MUST be mounted BEFORE auth guard)
// /auth/zoho, /auth/zoho/callback, /auth/status, /api/payment/config
// ---------------------------------------------------------------------------

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/requests'));

// ---------------------------------------------------------------------------
// Auth guard — protects all /api/* routes below
// ---------------------------------------------------------------------------

app.use('/api', function (req, res, next) {
  if (!zohoAuth.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/zoho to connect.' });
  }
  next();
});

// ---------------------------------------------------------------------------
// API key guard — protects mutating /api/* endpoints from unauthorized callers
// ---------------------------------------------------------------------------

var API_SECRET_KEY = process.env.API_SECRET_KEY || '';

if (!API_SECRET_KEY) {
  log.warn('');
  log.warn('┌─────────────────────────────────────────────────────────┐');
  log.warn('│  SECURITY WARNING: API_SECRET_KEY is not set.           │');
  log.warn('│  All mutating /api/* endpoints (POST, PUT, DELETE) are  │');
  log.warn('│  BLOCKED until API_SECRET_KEY is configured.            │');
  log.warn('│  Set API_SECRET_KEY in your environment variables.      │');
  log.warn('└─────────────────────────────────────────────────────────┘');
  log.warn('');
}

app.use('/api', function (req, res, next) {
  if (req.method === 'GET') return next();
  if (!API_SECRET_KEY) {
    return res.status(503).json({ error: 'Server not configured: API_SECRET_KEY is not set. Contact your administrator.' });
  }
  if (req.headers['x-api-key'] === API_SECRET_KEY) return next();
  res.status(403).json({ error: 'Forbidden' });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Build a minimal express-rate-limit custom store backed by the existing Redis
 * client from lib/cache.js. Uses INCR + EXPIRE so the window auto-resets.
 * Falls back gracefully to a no-op (skip) when Redis is unavailable, which
 * allows the in-process MemoryStore (express-rate-limit default) to take over
 * per-instance — preserving at least single-instance protection.
 *
 * express-rate-limit v6+ store interface:
 *   increment(key) -> Promise<{ totalHits, resetTime }>
 *   decrement(key) -> Promise<void>
 *   resetKey(key)  -> Promise<void>
 */
function makeRedisStore(windowMs) {
  var windowSec = Math.ceil(windowMs / 1000);

  return {
    increment: function (key) {
      if (!cache.isConnected()) {
        // Redis down — return a sentinel that signals "skip this store"
        return Promise.resolve({ totalHits: 0, resetTime: new Date(Date.now() + windowMs) });
      }
      var redisKey = 'rl:' + key;
      return cache.getClient().then(function (c) {
        if (!c) {
          return { totalHits: 0, resetTime: new Date(Date.now() + windowMs) };
        }
        // INCR is atomic; set expiry only on the first increment (NX flag)
        return c.incr(redisKey).then(function (hits) {
          if (hits === 1) {
            // First hit in this window — set expiry
            return c.expire(redisKey, windowSec).then(function () {
              return { totalHits: hits, resetTime: new Date(Date.now() + windowMs) };
            });
          }
          // Subsequent hits — check remaining TTL for accurate resetTime
          return c.ttl(redisKey).then(function (ttlSec) {
            var resetMs = ttlSec > 0 ? Date.now() + ttlSec * 1000 : Date.now() + windowMs;
            return { totalHits: hits, resetTime: new Date(resetMs) };
          });
        });
      }).catch(function () {
        return { totalHits: 0, resetTime: new Date(Date.now() + windowMs) };
      });
    },

    decrement: function (key) {
      if (!cache.isConnected()) return Promise.resolve();
      var redisKey = 'rl:' + key;
      return cache.getClient().then(function (c) {
        if (!c) return;
        return c.decr(redisKey);
      }).catch(function () {});
    },

    resetKey: function (key) {
      if (!cache.isConnected()) return Promise.resolve();
      return cache.del('rl:' + key);
    }
  };
}

// skip() returns true when Redis is down so express-rate-limit bypasses the
// Redis store entirely and falls back to its default MemoryStore behaviour.
// This means per-process limiting still applies when Redis is unavailable.
function redisUnavailableSkip() {
  return !cache.isConnected();
}

var apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000),
  skip: redisUnavailableSkip,
  message: { error: 'Too many requests, please try again later' }
});

var paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000),
  skip: redisUnavailableSkip,
  message: { error: 'Too many payment requests, please try again later' }
});

app.use('/api', apiLimiter);
app.use('/api/payment', paymentLimiter);
app.use('/api/checkout', paymentLimiter);
app.use('/api/pos/sale', paymentLimiter);
app.use('/api/kiosk/sale', paymentLimiter);

// ---------------------------------------------------------------------------
// Route modules
// ---------------------------------------------------------------------------

var catalogRouter = require('./routes/catalog');

app.use('/', require('./routes/bookings'));
app.use('/', catalogRouter);
app.use('/', require('./routes/items'));
app.use('/', require('./routes/payments'));
app.use('/', require('./routes/checkout'));
app.use('/', require('./routes/taxes'));
app.use('/', require('./routes/pos'));
app.use('/', require('./routes/purchaseorders'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Initialize GP SDK, connect Redis, restore Zoho auth, then start listening
gpLib.init();
cache.init().then(function () {
  return zohoAuth.init();
}).then(function () {
  var server = app.listen(PORT, function () {
    log.info('Zoho middleware running on http://localhost:' + PORT);
    log.info('Health check: http://localhost:' + PORT + '/health');
    if (!zohoAuth.isAuthenticated()) {
      log.info('Connect Zoho: http://localhost:' + PORT + '/auth/zoho');
    } else {
      log.info('Zoho: Connected');
      // Pre-warm product and ingredients caches on startup
      log.info('Pre-warming product cache...');
      catalogRouter.refreshProducts().then(function () {
        log.info('Product cache pre-warmed');
        // Pre-warm ingredients after products (sequential to avoid rate-limiting)
        log.info('Pre-warming ingredients cache...');
        return catalogRouter.refreshIngredients();
      }).then(function () {
        log.info('Ingredients cache pre-warmed');
      }).catch(function (err) {
        log.error('Pre-warm failed: ' + err.message);
      });
    }
  });

  process.on('SIGTERM', function () {
    log.info('[server] SIGTERM received — shutting down gracefully');
    server.close(function () {
      log.info('[server] HTTP server closed');
      cache.quit().then(function () {
        process.exit(0);
      }).catch(function () {
        process.exit(0);
      });
    });
    setTimeout(function () {
      log.error('[server] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  });
});
