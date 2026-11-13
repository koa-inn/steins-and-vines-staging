// Phase 99 perf harness: dependency-free local server.
// Serves a --root directory on 127.0.0.1 only, mocks the admin-proxy and
// /auth/google endpoints from a recorded fixture, and rewrites a few responses
// at serve time so the shipped files need no test seam (D-06).
// It never forwards anything: there is no outbound HTTP client in this file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var HERE = path.dirname(fileURLToPath(import.meta.url));
var REPO = path.resolve(HERE, '..', '..');

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

var ROOT = path.resolve(arg('root', REPO));
var FIXTURE_PATH = path.resolve(arg('fixture', path.join(HERE, 'fixture', 'dashboard-fixture.json')));
var PORT = parseInt(arg('port', '8099'), 10);

var MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function loadFixture() {
  var now = new Date();
  var today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver' }).format(now);
  var txt = fs.readFileSync(FIXTURE_PATH, 'utf8')
    .replace(/"__YEAR__"/g, String(parseInt(today.slice(0, 4), 10)))
    .replace(/__TODAY__/g, today);
  return JSON.parse(txt);
}

var fixture = loadFixture();
var misses = [];
var requests = [];

function send(res, status, type, body, extra) {
  var headers = { 'Content-Type': type };
  if (extra) { Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; }); }
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), { 'Cache-Control': 'no-store' });
}

function rewriteBrewpadHtml(html) {
  var out = html.replace(/<head>/i, '<head>\n  <script src="/__harness/seed.js"></script>');
  out = out.replace(/https:\/\/accounts\.google\.com\/gsi\/client/g, '/__harness/gsi-stub.js');
  // Fonts are blocked for determinism (no network, identical fallback metrics every run).
  out = out.replace(/\s*<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g, '');
  return out;
}

function rewriteSheetsConfig(js) {
  var re = /MIDDLEWARE_URL:\s*\(function \(\) \{[\s\S]*?\}\)\(\),/;
  if (!re.test(js)) { console.error('[server] WARNING: MIDDLEWARE_URL block not found; middleware would not be local'); return js; }
  return js.replace(re, 'MIDDLEWARE_URL: location.origin,');
}

function readBody(req, cb) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () { cb(Buffer.concat(chunks).toString('utf8')); });
}

function serveStatic(req, res, urlPath) {
  var rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  var file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) return send(res, 403, 'text/plain', 'forbidden');
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { return send(res, 404, 'text/plain', 'not found: ' + rel); }
    var ext = path.extname(file).toLowerCase();
    var type = MIME[ext] || 'application/octet-stream';
    fs.readFile(file, function (e2, buf) {
      if (e2) return send(res, 500, 'text/plain', 'read error');
      var base = path.basename(file);
      var parent = path.relative(ROOT, path.dirname(file));
      if (base === 'brewpad.html' && parent === '') {
        return send(res, 200, type, rewriteBrewpadHtml(buf.toString('utf8')), { 'Cache-Control': 'no-store' });
      }
      if (base === 'sheets-config.js' && parent === 'js') {
        return send(res, 200, type, rewriteSheetsConfig(buf.toString('utf8')), { 'Cache-Control': 'no-cache' });
      }
      var cc = (ext === '.html' || ext === '.json') ? 'no-store' : 'public, max-age=3600';
      send(res, 200, type, buf, { 'Cache-Control': cc });
    });
  });
}

var server = http.createServer(function (req, res) {
  var u = new URL(req.url, 'http://127.0.0.1');
  var p = u.pathname;
  requests.push(req.method + ' ' + p);

  if (p === '/__harness/seed.js') return fs.createReadStream(path.join(HERE, 'seed.js')).pipe(res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' }));
  if (p === '/__harness/gsi-stub.js') return fs.createReadStream(path.join(HERE, 'gsi-stub.js')).pipe(res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' }));
  if (p === '/__harness/misses') return sendJson(res, 200, { misses: misses });
  if (p === '/__harness/requests') return sendJson(res, 200, { requests: requests });

  if (req.method === 'POST' && p === '/api/batch/admin-proxy') {
    return readBody(req, function (body) {
      var action = '';
      try { action = JSON.parse(body || '{}').action || ''; } catch (e) { /* bad json */ }
      if (action && Object.prototype.hasOwnProperty.call(fixture, action) && action.indexOf('__') !== 0) {
        return sendJson(res, 200, fixture[action]);
      }
      misses.push('admin-proxy:' + action);
      console.error('[server] fixture miss: admin-proxy action=' + action);
      sendJson(res, 404, { ok: false, error: 'no fixture for ' + action });
    });
  }
  if (req.method === 'POST' && p === '/auth/google') {
    return readBody(req, function () { sendJson(res, 200, { authorized: true, token: 'harness-session' }); });
  }
  if (p.indexOf('/api/') === 0) {
    var rest = fixture.__rest || {};
    if (Object.prototype.hasOwnProperty.call(rest, p)) return sendJson(res, 200, rest[p]);
    misses.push(req.method + ' ' + p);
    console.error('[server] fixture miss: ' + req.method + ' ' + p);
    return sendJson(res, 404, { ok: false, error: 'no fixture for ' + p });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  send(res, 405, 'text/plain', 'method not allowed');
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('[server] listening http://127.0.0.1:' + PORT + ' root=' + ROOT + ' fixture=' + FIXTURE_PATH);
});
