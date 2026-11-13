// Phase 99: read-only capture of dashboard responses from STAGING for fixture building.
// Run:  source ~/.nvm/nvm.sh && nvm exec 24 npm run perf:capture
// Writes tests/perf/.raw/capture.json (gitignored; contains real customer data, never commit).
// Ends on Enter on stdin, or on SIGINT/SIGTERM, or when tests/perf/.raw/DONE appears.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var HERE = path.dirname(fileURLToPath(import.meta.url));
var RAW = path.join(HERE, '.raw');
var OUT = path.join(RAW, 'capture.json');
var SENTINEL = path.join(RAW, 'DONE');
fs.mkdirSync(RAW, { recursive: true });
try { fs.unlinkSync(SENTINEL); } catch (e) { /* none */ }

var pw = await import('playwright');
var ctx = await pw.chromium.launchPersistentContext(path.join(RAW, 'profile'), {
  headless: false, viewport: { width: 1280, height: 900 }
});
var captured = {};
var wrote = false;

function save() {
  if (wrote) return;
  wrote = true;
  fs.writeFileSync(OUT, JSON.stringify(captured, null, 2));
  console.log('Wrote ' + OUT + ' keys: ' + Object.keys(captured).join(', '));
}
async function finish() {
  save();
  try { await ctx.close(); } catch (e) { /* closed */ }
  process.exit(0);
}

// Read-only: abort any admin-proxy action that does not start with get_.
await ctx.route('**/api/batch/admin-proxy', async function (route) {
  var req = route.request();
  var action = '';
  try { action = (JSON.parse(req.postData() || '{}').action) || ''; } catch (e) { /* ignore */ }
  if (action.indexOf('get_') !== 0) {
    console.log('[capture] aborted non-read action: ' + action);
    return route.abort();
  }
  try {
    var resp = await route.fetch();
    var text = await resp.text();
    try { captured[action] = JSON.parse(text); } catch (e) { /* non-json */ }
    return route.fulfill({ response: resp, body: text });
  } catch (e) {
    return route.abort();
  }
});
// The two dashboard GET endpoints that sit outside admin-proxy; stored under __rest.
await ctx.route(/\/api\/admin\/(packaging-bookings|dashboard-cards)(\?.*)?$/, async function (route) {
  var req = route.request();
  if (req.method() !== 'GET') return route.abort();
  try {
    var resp = await route.fetch();
    var text = await resp.text();
    var p = new URL(req.url()).pathname;
    captured.__rest = captured.__rest || {};
    try { captured.__rest[p] = JSON.parse(text); } catch (e) { /* non-json */ }
    return route.fulfill({ response: resp, body: text });
  } catch (e) {
    return route.abort();
  }
});

var page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://staging.steinsandvines.ca/brewpad.html?dash=v2');
console.log('Sign in (Cloudflare Access + Google), open the Dashboard, then press Enter here');
console.log('(or: touch ' + SENTINEL + ' / send SIGINT to finish when running in the background)');

process.stdin.on('data', function () { finish(); });
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
setInterval(function () { if (fs.existsSync(SENTINEL)) finish(); }, 1000);
