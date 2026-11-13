// Phase 99 perf harness runner (D-05 / D-06).
// Usage: node tests/perf/run.mjs [--root <dir>] [--fixture <path>] [--port 8099] [--report-only]
// Run under Node 24:  source ~/.nvm/nvm.sh && nvm exec 24 npm run perf
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

var HERE = path.dirname(fileURLToPath(import.meta.url));
var REPO = path.resolve(HERE, '..', '..');
var require = createRequire(import.meta.url);

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && process.argv[i + 1].indexOf('--') !== 0 ? process.argv[i + 1] : dflt;
}
var REPORT_ONLY = process.argv.indexOf('--report-only') > -1;
var PORT = parseInt(arg('port', '8099'), 10);
var ROOT = path.resolve(arg('root', REPO));
var FIXTURE = path.resolve(arg('fixture', path.join(HERE, 'fixture', 'dashboard-fixture.json')));
var ORIGIN = 'http://127.0.0.1:' + PORT;
var URL_COLD = ORIGIN + '/brewpad.html';
var URL_WARM = ORIGIN + '/brewpad.html?warm=1';
var PERF_TARGET = 0.85;
// Hard guarantee: Chrome cannot resolve any host except 127.0.0.1, so no request can reach
// a real middleware, Google or a font CDN even if a rewrite or the fetch guard were bypassed.
var HOST_RULES = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';

function median(a) {
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function r(n, d) { var f = Math.pow(10, d || 0); return Math.round(n * f) / f; }

function startServer() {
  return new Promise(function (resolve, reject) {
    var child = spawn(process.execPath, [
      path.join(HERE, 'server.mjs'), '--root', ROOT, '--fixture', FIXTURE, '--port', String(PORT)
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    var done = false;
    child.stdout.on('data', function (d) {
      process.stdout.write(d);
      if (!done && String(d).indexOf('listening') > -1) { done = true; resolve(child); }
    });
    child.stderr.on('data', function (d) { process.stderr.write(d); });
    child.on('exit', function (code) { if (!done) reject(new Error('server exited early (' + code + ')')); });
  });
}

async function chromePath() {
  var pw = await import('playwright');
  return pw.chromium.executablePath();
}

async function lighthouseRuns(chromeBin) {
  var lhMod = await import('lighthouse');
  var lighthouse = lhMod.default;
  var desktopConfig = (await import('lighthouse/core/config/desktop-config.js')).default;
  var cl = await import('chrome-launcher');

  var chrome = await cl.launch({
    chromePath: chromeBin,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', HOST_RULES]
  });
  var base = { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility'] };

  function pick(lhr) {
    var a = lhr.audits;
    return {
      perf: lhr.categories.performance.score,
      a11y: lhr.categories.accessibility.score,
      fcp: a['first-contentful-paint'].numericValue,
      lcp: a['largest-contentful-paint'].numericValue,
      tbt: a['total-blocking-time'].numericValue,
      cls: a['cumulative-layout-shift'].numericValue,
      tti: a.interactive.numericValue
    };
  }

  try {
    var cold = [];
    for (var i = 0; i < 3; i++) {
      console.log('[lh] mobile cold run ' + (i + 1) + '/3');
      cold.push(pick((await lighthouse(URL_COLD, base)).lhr));
    }
    // Warm: one priming load (fills any dashboard cache), then a run that keeps storage.
    console.log('[lh] mobile warm run (priming load first)');
    await lighthouse(URL_WARM, Object.assign({}, base, { disableStorageReset: true }));
    var warm = pick((await lighthouse(URL_WARM, Object.assign({}, base, { disableStorageReset: true }))).lhr);
    console.log('[lh] desktop run (informational)');
    var desktop = pick((await lighthouse(URL_COLD, base, desktopConfig)).lhr);
    var med = function (k) { return median(cold.map(function (x) { return x[k]; })); };
    return {
      cold: cold, warm: warm, desktop: desktop,
      median: { perf: med('perf'), a11y: med('a11y'), fcp: med('fcp'), lcp: med('lcp'), tbt: med('tbt'), cls: med('cls'), tti: med('tti') }
    };
  } finally {
    await chrome.kill();
  }
}

async function browserChecks(chromeBin) {
  var pw = await import('playwright');
  var AxeBuilder = (await import('@axe-core/playwright')).default;
  var browser = await pw.chromium.launch({ executablePath: chromeBin, args: [HOST_RULES] });
  var external = [];
  var out = { axe: {}, overflow: {}, signedIn: null, notes: [] };

  async function open(w, h) {
    var ctx = await browser.newContext({ viewport: { width: w, height: h } });
    // Nothing may leave 127.0.0.1: abort and record anything that tries.
    await ctx.route('**/*', function (route) {
      var u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1') return route.continue();
      external.push(route.request().method() + ' ' + route.request().url());
      return route.abort();
    });
    var page = await ctx.newPage();
    await page.goto(URL_COLD, { waitUntil: 'load' });
    var ok = true;
    try { await page.waitForSelector('#bp-dash-v2', { timeout: 20000 }); } catch (e) { ok = false; }
    return { ctx: ctx, page: page, v2: ok };
  }

  async function axeCount(page) {
    var res = await new AxeBuilder({ page: page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    var bad = res.violations.filter(function (v) { return v.impact === 'serious' || v.impact === 'critical'; });
    return { count: bad.length, rules: bad.map(function (v) { return v.id + '(' + v.nodes.length + ')'; }) };
  }

  var sizes = [['desktop', 1280, 900], ['tablet', 820, 1180], ['phone', 390, 844]];
  for (var i = 0; i < sizes.length; i++) {
    var s = sizes[i];
    var o = await open(s[1], s[2]);
    if (!o.v2) out.notes.push('#bp-dash-v2 not found at ' + s[0]);
    if (i === 0) {
      out.signedIn = await o.page.evaluate(function () {
        var app = document.getElementById('bp-app');
        var inner = document.getElementById('bp-dashboard-inner');
        return {
          appVisible: !!app && app.style.display !== 'none' && app.offsetParent !== null,
          dashInnerChildren: inner ? inner.children.length : -1,
          dashV2: !!document.getElementById('bp-dash-v2')
        };
      });
    }
    out.axe[s[0]] = await axeCount(o.page);
    if (s[0] === 'phone') {
      var toggles = await o.page.$$('[data-dash-sec-toggle]');
      for (var t = 0; t < toggles.length; t++) { try { await toggles[t].click(); } catch (e) { /* hidden */ } }
      if (toggles.length) {
        await o.page.waitForTimeout(300);
        out.axe.phoneExpanded = await axeCount(o.page);
      }
    }
    await o.ctx.close();
  }

  var narrow = [['360', 360, 780], ['320', 320, 700]];
  for (var n = 0; n < narrow.length; n++) {
    var nn = narrow[n];
    var o2 = await open(nn[1], nn[2]);
    out.overflow[nn[0]] = await o2.page.evaluate(function () {
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
    });
    await o2.ctx.close();
  }
  await browser.close();
  out.externalAttempts = external;
  return out;
}

async function main() {
  var server = await startServer();
  var exitCode = 0;
  try {
    var chromeBin = await chromePath();
    var lh = await lighthouseRuns(chromeBin);
    var bc = await browserChecks(chromeBin);
    var misses = [];
    try { misses = (await (await fetch(ORIGIN + '/__harness/misses')).json()).misses; } catch (e) { /* ignore */ }
    var reqs = [];
    try { reqs = (await (await fetch(ORIGIN + '/__harness/requests')).json()).requests; } catch (e) { /* ignore */ }

    var axeBad = 0;
    Object.keys(bc.axe).forEach(function (k) { axeBad += bc.axe[k].count; });
    var overflow = Object.keys(bc.overflow).some(function (k) { return bc.overflow[k].scrollWidth > bc.overflow[k].innerWidth; });

    var result = {
      date: new Date().toISOString(), root: ROOT, fixture: FIXTURE,
      lighthouse: lh, browser: bc, fixtureMisses: misses, serverRequestCount: reqs.length
    };
    fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
    fs.writeFileSync(path.join(HERE, 'results', 'latest.json'), JSON.stringify(result, null, 2));

    var m = lh.median;
    console.log('\n===== Phase 99 perf harness =====');
    console.log('root: ' + ROOT);
    console.log('Lighthouse mobile (median of 3, cold): performance ' + r(m.perf, 2) + '  accessibility ' + r(m.a11y, 2));
    console.log('  interactive ' + r(m.tti) + ' ms | LCP ' + r(m.lcp) + ' ms | TBT ' + r(m.tbt) + ' ms | CLS ' + r(m.cls, 3) + ' | FCP ' + r(m.fcp) + ' ms');
    console.log('Lighthouse mobile warm: performance ' + r(lh.warm.perf, 2) + '  interactive ' + r(lh.warm.tti) + ' ms');
    console.log('Lighthouse desktop (info): performance ' + r(lh.desktop.perf, 2) + '  accessibility ' + r(lh.desktop.a11y, 2));
    Object.keys(bc.axe).forEach(function (k) {
      console.log('axe serious+critical @' + k + ': ' + bc.axe[k].count + (bc.axe[k].rules.length ? '  ' + bc.axe[k].rules.join(', ') : ''));
    });
    Object.keys(bc.overflow).forEach(function (k) {
      console.log('scrollWidth @' + k + ': ' + bc.overflow[k].scrollWidth + ' (innerWidth ' + bc.overflow[k].innerWidth + ')');
    });
    console.log('signed-in state: ' + JSON.stringify(bc.signedIn));
    if (bc.notes.length) console.log('notes: ' + bc.notes.join('; '));
    console.log('external request attempts (aborted): ' + bc.externalAttempts.length);
    if (misses.length) console.log('WARNING fixture misses: ' + misses.join(', '));

    var fails = [];
    if (m.perf < PERF_TARGET) fails.push('performance ' + r(m.perf, 2) + ' < ' + PERF_TARGET);
    if (axeBad > 0) fails.push('axe serious+critical = ' + axeBad);
    if (overflow) fails.push('horizontal overflow at 360/320');
    if (fails.length) {
      console.log((REPORT_ONLY ? 'REPORT-ONLY (would fail): ' : 'FAIL: ') + fails.join('; '));
      if (!REPORT_ONLY) exitCode = 1;
    } else {
      console.log('PASS');
    }
  } catch (e) {
    console.error(e);
    exitCode = 1;
  } finally {
    server.kill();
  }
  process.exit(exitCode);
}

main();
