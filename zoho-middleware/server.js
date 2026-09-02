require('dotenv').config();

var validateEnv = require('./lib/validateEnv');
var checkRedis = require('./lib/checkRedis');
var checkMailer = require('./lib/checkMailer');
validateEnv();

var Sentry = require('@sentry/node');
var scrub = require('./lib/sentry-scrub');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
    beforeSend: function (event) {
      event = scrub.scrubEvent(event);
      event.fingerprint = scrub.fingerprintFor(event);
      return event;
    }
  });
}

var express = require('express');
var axios = require('axios');
var cors = require('cors');
var crypto = require('crypto');
var rateLimit = require('express-rate-limit');
var helmet = require('helmet');
var zohoAuth = require('./lib/zohoAuth');
var cache = require('./lib/cache');
var log = require('./lib/logger');
var C = require('./lib/constants');
var helcimLib = require('./lib/helcim');
var cron = require('node-cron');
var brewpadIntegration = require('./lib/brewpad-integration');

var mailer = require('./lib/mailer');
var mailerlite = require('./lib/mailerlite');
var reconcile = require('./lib/reconcile');
var cookieParser = require('cookie-parser');
var authTiers = require('./lib/authTiers');
var closedOnRedisError = require('./lib/redis-guard').closedOnRedisError;

var app = express();
app.set('trust proxy', 1); // Railway sits behind a load balancer
var PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet());
app.use(express.json({
  limit: '1mb',
  verify: function (req, res, buf) { req.rawBody = buf; }
}));
// Session cookies (sv_session, D-46-04) must be readable before the auth
// router and the /api guard — mounted here so req.cookies is populated on
// every request, including GETs the global guard skips (46-03).
app.use(cookieParser());
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
  // Checkout is protected by reCAPTCHA + rate limit instead of Referer check
  if (req.path === '/checkout') return next();
  // NOTE (D-46-10): /bookings, /contacts, /payment/initialize are exempted
  // from the API-KEY guard below (keyless) but deliberately NOT exempted
  // here — must_haves truth requires them to stay "referer + rate-limit
  // only", matching /promo/validate's existing risk profile (which is also
  // not referer-exempt). Referer is the only remaining gate for these public
  // POSTs, so it must keep running.
  var referer = req.headers.referer;
  var allowed = allowedReferers.some(function(origin) {
    return referer === origin || referer.startsWith(origin + '/');
  });
  if (!allowed) {
    log.warn('[referer-guard] Blocked: referer=' + referer + ' path=' + req.path);
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
  var redisOk = cache.isConnected();
  var redisCheck = redisOk
    ? cache.getClient().then(function (c) {
        if (!c) return false;
        return c.ping().then(function (r) { return r === 'PONG'; }).catch(function () { return false; });
      }).catch(function () { return false; })
    : Promise.resolve(false);

  redisCheck.then(function (redisPong) {
    res.json({
      status: 'ok',
      authenticated: zohoAuth.isAuthenticated(),
      redis: redisPong,
      uptime: process.uptime()
    });
  });
});

// ---------------------------------------------------------------------------
// Auth routes (MUST be mounted BEFORE auth guard)
// /auth/zoho, /auth/zoho/callback, /auth/status, /api/payment/config
// ---------------------------------------------------------------------------

app.use('/', require('./routes/auth'));

var requestsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'requests'),
  skip: redisUnavailableSkip,
  message: { error: 'Too many requests, please try again later' }
});
app.post('/product-requests', requestsLimiter);
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
  store: makeRedisStore(60 * 1000, 'contact'),
  skip: redisUnavailableSkip,
  message: { error: 'Too many requests, please try again later' }
});

app.post('/api/contact', contactLimiter, async function(req, res) {
  var name = (req.body.name || '').trim().replace(/[\r\n]/g, ' ');
  var email = (req.body.email || '').trim();
  var message = (req.body.message || '').trim();

  // Validate
  if (!name) return res.status(400).json({ error: 'Name is required' });
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    // Sent via Resend (HTTPS) — Railway blocks outbound SMTP. name is already
    // CRLF-stripped above; mailer uses email as reply-to.
    await mailer.sendContactMessage({ name: name, email: email, message: message });
    res.json({ success: true });
  } catch (err) {
    console.error('[contact] Email send failed:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Beer waitlist signup → writes an authoritative row to the `Waitlist` sheet
// via Apps Script (D-03/Phase 78) and best-effort adds the email to a
// MailerLite group (list-building, not transactional). Public like
// /api/contact (registered before the API-key gate) and rate-limited.
// Contact form + order emails still go via Resend.
var waitlistLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'waitlist'),
  skip: redisUnavailableSkip,
  message: { error: 'Too many requests, please try again later' }
});

// Local helper — a fourth private copy of the callAppsScript(action, payload)
// blocking-POST pattern also duplicated in routes/gift-cards.js, routes/
// recipes.js and routes/pos-recipe.js. Deliberately not extracted into a
// shared lib/apps-script.js here (CLAUDE.md rule 3 — out of scope refactor).
function callAppsScript(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  var body = Object.assign({}, payload, { action: action, server_token: token });
  return axios.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 12000,
    maxRedirects: 5
  }).then(function (resp) { return resp.data || {}; });
}

app.post('/api/waitlist', waitlistLimiter, async function (req, res) {
  var email = (req.body.email || '').trim();
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Valid email is required' });

  // Category is never client-supplied — a public unauthenticated endpoint
  // must not be able to choose which queue a row lands in (T-78-07).
  var category = 'beer';

  try {
    // D-03: the sheet write is authoritative and blocking. Exactly one
    // add_waitlist_entry call is issued — no re-call wrapper of any kind
    // (the admin proxy collapses upstream errors to 502, so a second call
    // cannot distinguish "never happened" from "already happened" —
    // RESEARCH.md Pitfall 4).
    var sheetResult;
    try {
      sheetResult = await callAppsScript('add_waitlist_entry', { email: email, category: category });
    } catch (writeErr) {
      console.error('[waitlist] sheet write failed:', writeErr.message);
      return res.status(503).json({ error: 'Waitlist is temporarily unavailable' });
    }
    if (!sheetResult || sheetResult.ok !== true) {
      console.error('[waitlist] sheet write failed:', (sheetResult && sheetResult.error) || 'unknown error');
      return res.status(503).json({ error: 'Waitlist is temporarily unavailable' });
    }

    var entryId = (sheetResult && sheetResult.id) || null;

    // MailerLite is best-effort from here on — its outcome never changes
    // the HTTP status (D-03). A failure/misconfiguration leaves the row's
    // mailerlite_synced flag false, which is the persisted drift signal
    // D-07 requires (a console.error alone would vanish on restart).
    if (mailerlite.isConfigured()) {
      var groupId = (process.env.MAILERLITE_WAITLIST_GROUP_ID || '').trim();
      mailerlite.addSubscriber(email, groupId ? [groupId] : [])
        .then(function () {
          if (entryId) {
            callAppsScript('update_waitlist_status', { id: entryId, mailerlite_synced: true })
              .catch(function (err) { console.error('[waitlist] sync-flag write failed:', err.message); });
          }
        })
        .catch(function (err) { console.error('[waitlist] MailerLite subscribe failed:', err.message); });
    } else {
      console.error('[waitlist] MAILERLITE_API_KEY not set — row recorded, marketing sync skipped');
    }

    // Fire-and-forget staff heads-up — must not block or fail the signup.
    mailer.sendWaitlistNotification({ email: email })
      .catch(function (err) { console.error('[waitlist] staff notify failed:', err.message); });

    // Identical response for a brand-new row and a dedupe hit — the
    // middleware must never disclose whether the address was already
    // listed (D-06).
    res.json({ success: true });
  } catch (err) {
    console.error('[waitlist] unexpected error:', err.message);
    res.status(503).json({ error: 'Waitlist is temporarily unavailable' });
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
  // Promo validate is Redis-only — never needs Zoho
  if (req.method === 'POST' && req.path === '/promo/validate') return next();
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
// 3-tier /api guard — legacy key / kiosk device token / session cookie
// (D-46-02, D-46-06, D-46-10, D-46-11). All three are valid simultaneously
// during the dual-accept window; the legacy branch dies the moment
// API_SECRET_KEY is rotated (cutover, 46-10). Credential resolution + the
// kiosk route allowlist live in lib/authTiers so this guard and 46-04's
// in-route checks (requireTiers) share one source of truth (req.authTier).
// ---------------------------------------------------------------------------

var apiKeyGuard = require('./lib/apiKey');

if (!apiKeyGuard.getKey()) {
  log.warn('');
  log.warn('┌─────────────────────────────────────────────────────────┐');
  log.warn('│  SECURITY WARNING: API_SECRET_KEY is not set.           │');
  log.warn('│  All mutating /api/* endpoints (POST, PUT, DELETE) are  │');
  log.warn('│  BLOCKED until API_SECRET_KEY is configured.            │');
  log.warn('│  Set API_SECRET_KEY in your environment variables.      │');
  log.warn('└─────────────────────────────────────────────────────────┘');
  log.warn('');
}

// D-46-10 / Finding #1: these three public POSTs are keyless — protected by
// Referer + rate-limit only (requireAllowedReferer still runs on them, see
// the NOTE above), matching the existing /promo/validate risk profile.
var KEYLESS_POSTS = ['/bookings', '/contacts', '/payment/initialize'];

// Credential comparison (constant-time, header-only) lives in lib/apiKey /
// lib/deviceToken; session lookup lives in lib/session. lib/authTiers is the
// single place that dispatches between them so server.js and route-level
// guards can never drift.
app.use('/api', async function (req, res, next) {
  if (req.method === 'GET') return next();
  // /api/checkout is public — protected by reCAPTCHA + rate limit instead of API key
  if (req.path === '/checkout') return next();
  // Promo validation is called from public checkout page without API key
  if (req.path === '/promo/validate') return next();
  // Webhooks are protected by HMAC signature verification, not API key
  if (req.path.indexOf('/webhooks/') === 0) return next();
  if (KEYLESS_POSTS.indexOf(req.path) !== -1) return next();

  // Fail closed if NO credential path can EVER succeed — no legacy key
  // (either half of the unified API_SECRET_KEY/MW_API_KEY pair), no device
  // token, no staff allowlist for sessions.
  if (!apiKeyGuard.getKey() && !process.env.KIOSK_DEVICE_TOKEN && !process.env.STAFF_EMAILS) {
    return res.status(503).json({ error: 'Server not configured: API_SECRET_KEY is not set. Contact your administrator.' });
  }

  var tier;
  try {
    // Express 4 does not catch a rejected middleware promise — an unwrapped
    // await on a session.getSession rejection would hang the request instead
    // of failing closed, so this is explicitly try/caught (T-46-17).
    tier = await authTiers.resolveTier(req);
  } catch (e) {
    log.warn('[auth-guard] resolveTier failed: ' + e.message);
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.authTier = tier;

  if (!tier) {
    var sent = req.headers['x-api-key'];
    log.warn('[auth-guard] Forbidden: method=' + req.method + ' path=' + req.path +
      ' x-api-key-present=' + (sent !== undefined) +
      ' x-device-token-present=' + (req.headers['x-device-token'] !== undefined) +
      ' session-cookie-present=' + !!(req.cookies && req.cookies.sv_session) +
      ' x-session-token-present=' + (req.headers['x-session-token'] !== undefined) +
      ' origin=' + (req.headers.origin || 'none') +
      ' referer=' + (req.headers.referer || 'none'));
    return res.status(403).json({ error: 'Forbidden' });
  }

  // D-46-02 / T-46-03: device tokens are scoped to the explicit kiosk-route
  // allowlist — never admin-grade (a stolen iPad must not reach PII/void/
  // consignment routes). This guard is mounted via app.use('/api', ...), so
  // req.path here is mount-relative (e.g. '/kiosk/sale', NOT
  // '/api/kiosk/sale') — KIOSK_ROUTES is defined in absolute form (matching
  // how 46-04 calls isKioskRoute() from inside route files, where req.path
  // IS the full absolute path), so it must be reconstructed here.
  var fullPath = '/api' + req.path;
  if (tier === 'device' && !authTiers.isKioskRoute(fullPath)) {
    log.warn('[auth-guard] Forbidden: device token on non-kiosk route path=' + fullPath);
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Build a minimal express-rate-limit custom store backed by the existing Redis
 * client from lib/cache.js. Uses INCR + EXPIRE so the window auto-resets.
 *
 * When Redis is unavailable — or reports connected but a mid-op call fails
 * (M4, RESIL-01) — the store falls back to a per-limiter in-process Map
 * (key → { hits, expiresAt }) via countInProcess(). This provides genuine
 * per-process rate limiting during a Redis outage — the middleware runs as a
 * single Railway instance so per-process covers all traffic (D-06).
 * Security-critical limiters (pin, payment, api) do NOT use
 * skip:redisUnavailableSkip so this in-process fallback is always active for
 * those paths (D-07). The connected-but-failed Redis path is routed through
 * the shared lib/redis-guard closedOnRedisError helper (alwaysClosed:true —
 * this backs security-critical limiters, so the invariant holds in every
 * environment) and falls through to the SAME countInProcess accounting on
 * failclosed — never a bare { totalHits: 0 }, which would silently disable
 * the limiter (express-rate-limit also rejects a totalHits of 0 as invalid).
 *
 * express-rate-limit v6+ store interface:
 *   increment(key) -> Promise<{ totalHits, resetTime }>
 *   decrement(key) -> Promise<void>
 *   resetKey(key)  -> Promise<void>
 */
function makeRedisStore(windowMs, prefix) {
  var windowSec = Math.ceil(windowMs / 1000);
  // Each limiter must use a unique prefix so they track separate counters per IP.
  // Without a prefix all limiters share 'rl:<ip>' and cross-contaminate each other.
  var keyPrefix = C.RATE_LIMIT_PREFIX + (prefix || 'default') + ':';
  // In-process fallback: tracks hits per client IP when Redis is unavailable OR
  // a connected-but-failed Redis op falls closed (M4). Keyed by the same value
  // express-rate-limit passes (default: req.ip).
  var memStore = Object.create(null);
  // Loopback addresses only appear in direct-connection scenarios (health checks,
  // local dev, supertest). Skipping loopback keys there avoids accumulating
  // counts across test requests that share the same 127.x/::1 address without
  // representing external clients.
  // M5 (RESIL-01): this skip is gated to non-production below — trust proxy:1
  // trusts the X-Forwarded-For value Railway's load balancer forwards, but a
  // client-supplied XFF is still attacker-controlled input; a spoofed
  // `X-Forwarded-For: ::1` must not be able to defeat PIN/payment throttling
  // in production, so the skip never applies once NODE_ENV === 'production'.
  var LOOPBACK_RE = /^(127\.|::1$|::ffff:127\.)/;

  // Shared in-process accounting (M4) — the single place that increments the
  // per-process Map, used by the disconnected branch AND by any connected-but-
  // failed Redis path (mid-op error, absent client) so both share one counter
  // per key rather than drifting into separate fail-open states.
  function countInProcess(key) {
    var now = Date.now();
    var entry = memStore[key];
    if (!entry || now >= entry.expiresAt) {
      memStore[key] = { hits: 1, expiresAt: now + windowMs };
      return { totalHits: 1, resetTime: new Date(now + windowMs) };
    }
    memStore[key].hits++;
    return { totalHits: memStore[key].hits, resetTime: new Date(memStore[key].expiresAt) };
  }

  return {
    increment: function (key) {
      if (!cache.isConnected()) {
        // Redis down — count in-process so security limits still apply (D-06/D-07).
        // D-07/M5: the loopback short-circuit is a TEST/DEV convenience only —
        // in production a spoofed X-Forwarded-For loopback address must not be
        // able to defeat PIN throttling, so it is gated to non-production.
        // Outside production, loopback traffic (health checks, local dev,
        // supertest) never represents an external client, so it returns
        // totalHits:1 (never accumulates).
        if ((!key || LOOPBACK_RE.test(key)) && process.env.NODE_ENV !== 'production') {
          return Promise.resolve({ totalHits: 1, resetTime: new Date(Date.now() + windowMs) });
        }
        return Promise.resolve(countInProcess(key));
      }
      var redisKey = keyPrefix + key;
      return closedOnRedisError(function () {
        return cache.getClient().then(function (c) {
          if (!c) {
            // Race window: isConnected() reported true but the client is absent
            // (e.g. an 'end' event fired between the check and this resolve).
            throw new Error('Redis client unavailable mid-op');
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
        });
      }, { alwaysClosed: true, label: 'ratelimit' }).then(function (result) {
        if (result.status === 'failclosed') {
          return countInProcess(key);
        }
        return result.value;
      });
    },

    decrement: function (key) {
      if (!cache.isConnected()) {
        if (key && !LOOPBACK_RE.test(key) && memStore[key] && memStore[key].hits > 0) {
          memStore[key].hits--;
        }
        return Promise.resolve();
      }
      var redisKey = keyPrefix + key;
      return cache.getClient().then(function (c) {
        if (!c) return;
        return c.decr(redisKey);
      }).catch(function () {});
    },

    resetKey: function (key) {
      if (!cache.isConnected()) {
        if (key && !LOOPBACK_RE.test(key)) {
          delete memStore[key];
        }
        return Promise.resolve();
      }
      return cache.del(keyPrefix + key);
    }
  };
}

// skip() bypasses the limiter entirely when Redis is down.
// Used ONLY for lower-stakes abuse limiters (contact, waitlist, requests)
// where availability is prioritised over strict counting during an outage.
// Security-critical limiters (pin, payment, api) do NOT use this skip —
// they count in-process via makeRedisStore's memStore fallback instead (D-07).
function redisUnavailableSkip() {
  return !cache.isConnected();
}

// D-07: apiLimiter has no skip — in-process memStore fallback applies when
// Redis is down. Requests still count per-process (single Railway instance).
var apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'api'),
  validate: { singleCount: false },
  message: { error: 'Too many requests, please try again later' }
});

// D-07: paymentLimiter has no skip — in-process memStore fallback applies
// when Redis is down so money-path throttling is always enforced.
var paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'payment'),
  validate: { singleCount: false },
  message: { error: 'Too many requests, please try again in a minute' }
});

// D-07: pinLimiter has no skip — PIN brute-force throttling is always-on.
// In-process memStore ensures 5/min cap holds even during a Redis outage.
var pinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'pin'),
  validate: { singleCount: false },
  message: { error: 'Too many PIN attempts, please try again in a minute' }
});

// 57-01: cap the kiosk client-error beacon so a wedged/looping iPad (or a leaked
// device token) cannot spam the telemetry sink and flood Sentry/Redis. T-57-03.
var clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'client-error'),
  skip: redisUnavailableSkip,
  message: { error: 'Too many client-error reports, slow down' }
});

// 68-01: same bounded, no-side-effect telemetry class as clientErrorLimiter —
// a separate bucket so the terminal-push-latency beacon can never crowd out
// error reporting (or vice versa). T-68-01-2.
var telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'telemetry'),
  skip: redisUnavailableSkip,
  message: { error: 'Too many telemetry reports, slow down' }
});

app.use('/api', apiLimiter);
app.use('/api', requireAllowedReferer);
app.use('/api/kiosk/verify-pin', pinLimiter);
app.use('/api/kiosk/client-error', clientErrorLimiter);
app.use('/api/kiosk/telemetry', telemetryLimiter);
app.use('/api/payment', paymentLimiter);
app.use('/api/checkout', paymentLimiter);
app.use('/api/pos/sale', paymentLimiter);
app.use('/api/kiosk/sale', function (req, res, next) {
  if (req.path === '/status') return next();
  paymentLimiter(req, res, next);
});
app.use('/api/pos/collect', paymentLimiter);
app.use('/api/kiosk/salesorder-pay', paymentLimiter);
// NOTE (Phase 44-09): /api/kiosk/gift-card/issue + /reload paymentLimiter mounts
// removed — those phantom-payment routes are decommissioned. Gift cert issue/reload
// now flows through /api/kiosk/sale (already rate-limited via paymentLimiter above).

// ---------------------------------------------------------------------------
// PII-01: Targeted API-key guard on exactly the 4 PII-exposing GET routes.
// These routes return customer/contact/invoice data — they must require the
// API key regardless of Referer (Referer can be spoofed by the public site).
//
// Rationale: The global guard above exempts ALL GET (line 254 — required for
// ~12+ legitimately-public storefront routes like /api/products, /api/ingredients).
// We cannot invert that default without breaking the public storefront.
// Solution: narrow targeted guard on exactly these 4 paths (D-07).
//
// Exact-match path list — /api/contacts/search (pos.js) is a different path
// and is intentionally NOT in this list.
// ---------------------------------------------------------------------------

var PII_GET_ROUTES = ['/api/contacts', '/api/invoices', '/api/items/inspect', '/api/snapshot'];

// D-46-02: PII GET routes accept the legacy key OR a session — a bare
// kiosk device token must NOT reach customer/contact/invoice data.
function requirePiiApiKey(req, res, next) {
  if (apiKeyGuard.matches(req.headers['x-api-key'])) return next();
  Promise.resolve(authTiers.resolveTier(req)).then(function (tier) {
    if (authTiers.allowAdmin(tier)) {
      req.authTier = tier;
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  }).catch(function () {
    return res.status(403).json({ error: 'Forbidden' });
  });
}

PII_GET_ROUTES.forEach(function (p) { app.get(p, requirePiiApiKey); });

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
app.use('/', require('./routes/gift-cards'));
app.use('/', require('./routes/collect'));
app.use('/', require('./routes/purchaseorders'));
app.use('/', require('./routes/consignment'));
app.use('/', require('./routes/discounts'));
app.use('/', require('./routes/promo'));
app.use('/', require('./routes/recipes'));
app.use('/', require('./routes/pos-recipe'));
app.use(require('./routes/webhooks'));

// Sentry error handler (must be after routes, before other error handlers)
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Initialize Helcim, connect Redis, restore Zoho auth, then start listening.
// Guard with require.main === module so that importing server.js in tests
// (e.g. via supertest) does NOT bind a port or start cron jobs.
if (require.main === module) {
  helcimLib.init();
  cache.init().then(function () {
    return checkRedis();
  }).then(function () {
    return zohoAuth.init();
  }).then(function () {
    var server = app.listen(PORT, function () {
      log.info('Zoho middleware running on http://localhost:' + PORT);
      log.info('Health check: http://localhost:' + PORT + '/health');
      // Verify SMTP in the background — never block listen on it. A hung SMTP
      // connect (e.g. an unreachable IPv6 route on Railway) previously stalled
      // startup before app.listen and produced ~2 min of 502s on every deploy.
      // checkMailer never throws; it logs the result on its own.
      checkMailer();
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

      // Kit registry: the Kits sheet is the only authoritative answer to "is this line
      // item a kit?" (the Zoho catalog has no category on any item). Loaded once at
      // startup and refreshed hourly; batch creation degrades to a heuristic without it,
      // so a failure here is non-fatal.
      brewpadIntegration.refreshKitSkus().catch(function (err) {
        log.error('[brewpad] Initial kit registry load failed: ' + err.message);
      });
      setInterval(function () {
        brewpadIntegration.refreshKitSkus().catch(function (err) {
          log.error('[brewpad] Kit registry refresh failed: ' + err.message);
        });
      }, 60 * 60 * 1000);
      log.info('[brewpad] Kit registry refresh registered: hourly');

      // Retry pending batch creations + Zoho sync retries every 5 minutes (D-04, D-10)
      // Runs regardless of Zoho auth state since Apps Script calls don't need Zoho auth.
      // retrySyncQueue skips gracefully if Zoho is not authenticated.
      setInterval(function () {
        brewpadIntegration.retryPendingBatches().catch(function (err) {
          log.error('[brewpad] Retry sweep failed: ' + err.message);
        });
        // Phase 7: also sweep Zoho sync retries (D-10)
        brewpadIntegration.retrySyncQueue().catch(function (err) {
          log.error('[brewpad] Zoho sync retry sweep failed: ' + err.message);
        });
      }, 5 * 60 * 1000);
      log.info('[brewpad] Batch + Zoho sync retry sweeps registered: every 5 minutes');

      // D-13: Kiosk pending-charge reconciliation sweep (45-08 backstop)
      // Catches orphan charges that the webhook handler missed (e.g. failed delivery).
      // No-ops cleanly when Redis is disconnected.
      setInterval(function () {
        reconcile.sweepPendingCharges().catch(function (err) {
          log.error('[reconcile] Pending-charge sweep failed: ' + err.message);
        });
      }, 5 * 60 * 1000);
      log.info('[reconcile] Kiosk pending-charge sweep registered: every 5 minutes');
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
}

module.exports = app;
