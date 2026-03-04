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
var cron = require('node-cron');

var nodemailer = require('nodemailer');

var app = express();
app.set('trust proxy', 1); // Railway sits behind a load balancer
var PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
// H3: CORS origin whitelist — only allow requests from known frontend origins
var allowedOrigins = [
  'https://steinsandvines.ca',
  'https://staging.steinsandvines.ca',
  'http://localhost:3001',
  'http://localhost:8080'
];
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, etc.) and whitelisted origins
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed: ' + origin));
    }
  },
  credentials: true
}));

// H3: Referer check — key-authenticated routes must come from allowed origins
var allowedReferers = [
  'https://steinsandvines.ca',
  'https://staging.steinsandvines.ca',
  'http://localhost:3001',
  'http://localhost:8080'
];
function requireAllowedReferer(req, res, next) {
  // Skip for server-to-server calls (no Referer) and OPTIONS preflight
  if (req.method === 'OPTIONS' || !req.headers.referer) return next();
  var referer = req.headers.referer;
  var allowed = allowedReferers.some(function(origin) {
    return referer.startsWith(origin);
  });
  if (!allowed) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

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
// H4: Contact form email submission (public — no Zoho auth or API key needed)
// Railway env vars needed: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (Gmail App Password), CONTACT_TO
// ---------------------------------------------------------------------------

var contactLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000),
  skip: redisUnavailableSkip,
  message: { error: 'Too many requests, please try again later' }
});

app.post('/api/contact', contactLimiter, async function(req, res) {
  var name = (req.body.name || '').trim();
  var email = (req.body.email || '').trim();
  var message = (req.body.message || '').trim();

  // Validate
  if (!name) return res.status(400).json({ error: 'Name is required' });
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    var transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.CONTACT_TO || 'hello@steinsandvines.ca',
      replyTo: email,
      subject: 'New message from ' + name + ' via steinsandvines.ca',
      text: 'Name: ' + name + '\nEmail: ' + email + '\n\nMessage:\n' + message
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[contact] Email send failed:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ---------------------------------------------------------------------------
// Auth guard — protects all /api/* routes below
// ---------------------------------------------------------------------------

// POST routes that handle Zoho-unavailable gracefully (offline fallback mode).
// They are allowed through when Zoho is not authenticated; req.zohoOffline is
// set so each handler can switch to email-notification fallback.
var OFFLINE_CAPABLE_POSTS = ['/contacts', '/bookings', '/checkout'];

app.use('/api', function (req, res, next) {
  if (!zohoAuth.isAuthenticated()) {
    if (req.method === 'POST' && OFFLINE_CAPABLE_POSTS.indexOf(req.path) !== -1) {
      req.zohoOffline = true;
      return next();
    }
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
  // /api/checkout is public — protected by reCAPTCHA + rate limit instead of API key
  if (req.path === '/checkout') return next();
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
app.use('/api', requireAllowedReferer);
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

      // Scheduled cache warm-up: 5 AM and 1 PM UTC daily
      // Keeps Redis caches hot during business hours so user requests never
      // trigger a cold Zoho fetch. Products first, ingredients staggered 60s later
      // to stay within Zoho's per-minute rate limit.
      cron.schedule('0 5,13 * * *', function () {
        if (!zohoAuth.isAuthenticated()) {
          log.warn('[cron] Skipping warm-up — Zoho not authenticated');
          return;
        }
        log.info('[cron] Scheduled cache warm-up starting');
        catalogRouter.refreshProducts().then(function () {
          log.info('[cron] Products cache refreshed');
        }).catch(function (err) {
          log.error('[cron] Products warm-up failed: ' + err.message);
        });
        setTimeout(function () {
          if (!zohoAuth.isAuthenticated()) return;
          catalogRouter.refreshIngredients().then(function () {
            log.info('[cron] Ingredients cache refreshed');
          }).catch(function (err) {
            log.error('[cron] Ingredients warm-up failed: ' + err.message);
          });
        }, 60000); // 60s after products to avoid rate-limit burst
      });
      log.info('[cron] Scheduled warm-up registered: 05:00 and 13:00 UTC daily');
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
