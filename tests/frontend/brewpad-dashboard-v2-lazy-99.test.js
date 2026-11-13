'use strict';

// Phase 99-03: print tools off the head path, collapsible phone sections, lazy chart rendering.

var fs = require('fs');
var path = require('path');

global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
});
var _ssData = {};
global.sessionStorage = {
  getItem: function (k) { return _ssData[k] !== undefined ? _ssData[k] : null; },
  setItem: function (k, v) { _ssData[k] = v; },
  removeItem: function (k) { delete _ssData[k]; },
  clear: function () { _ssData = {}; }
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

var QR = 'js/vendor/qrcode.min.js';
var PDF = 'js/vendor/jspdf.umd.min.js';
var TOAST = 'Could not load the PDF tools. Check your connection and try again.';

var appended;
var appendSpy;

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }

function srcOf(node) { return node.getAttribute('src'); }

beforeEach(function () {
  bp._resetPrintToolsForTest();
  appended = [];
  appendSpy = jest.spyOn(document.head, 'appendChild').mockImplementation(function (n) {
    appended.push(n);
    return n;
  });
  document.body.innerHTML = '<div id="bp-toast-container"></div>';
});

afterEach(function () {
  appendSpy.mockRestore();
  delete global.qrcode;
  delete window.jspdf;
  delete window.requestIdleCallback;
});

describe('brewpad.html head', function () {
  test('no longer loads qrcode or jsPDF', function () {
    var html = fs.readFileSync(path.join(__dirname, '../../brewpad.html'), 'utf8');
    expect(html).not.toContain('jspdf.umd.min.js');
    expect(html).not.toContain('qrcode.min.js');
  });
});

describe('loadScriptOnce', function () {
  test('same src returns the same promise and appends one node', function () {
    var a = bp._loadScriptOnceForTest('js/vendor/test-a.js');
    var b = bp._loadScriptOnceForTest('js/vendor/test-a.js');
    expect(a).toBe(b);
    expect(appended.length).toBe(1);
    appended[0].onload();
    return a;
  });

  test('error rejects, clears the cache and a retry appends a new node', async function () {
    var p = bp._loadScriptOnceForTest('js/vendor/test-b.js');
    var node = appended[0];
    node.onerror();
    await expect(p).rejects.toThrow();
    var p2 = bp._loadScriptOnceForTest('js/vendor/test-b.js');
    expect(appended.length).toBe(2);
    expect(p2).not.toBe(p);
    appended[1].onload();
    await p2;
  });
});

describe('preloadPrintTools', function () {
  test('schedules both scripts on idle once', function () {
    var cb = null;
    window.requestIdleCallback = jest.fn(function (f) { cb = f; });
    bp._preloadPrintToolsForTest();
    bp._preloadPrintToolsForTest();
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(appended.length).toBe(0);
    cb();
    var srcs = appended.map(srcOf);
    expect(srcs).toEqual([QR, PDF]);
    appended.forEach(function (n) { n.onload(); });
  });
});

describe('openBatchQR', function () {
  function fakeQr() {
    return function () {
      return { addData: function () {}, make: function () {}, createImgTag: function () { return '<img>'; } };
    };
  }

  test('qrcode present: window.open is called synchronously', function () {
    global.qrcode = fakeQr();
    var doc = { write: jest.fn(), close: jest.fn() };
    window.open = jest.fn(function () { return { document: doc, print: jest.fn() }; });
    bp._openBatchQRForTest('B1', 'tok');
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(appended.length).toBe(0);
  });

  test('qrcode absent: loads it then opens the window', async function () {
    var doc = { write: jest.fn(), close: jest.fn() };
    window.open = jest.fn(function () { return { document: doc, print: jest.fn() }; });
    bp._openBatchQRForTest('B2', 'tok');
    expect(window.open).not.toHaveBeenCalled();
    expect(srcOf(appended[0])).toBe(QR);
    global.qrcode = fakeQr();
    appended[0].onload();
    await flush();
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  test('load failure shows the PDF tools toast', async function () {
    window.open = jest.fn();
    bp._openBatchQRForTest('B3', 'tok');
    appended[0].onerror();
    await flush();
    expect(document.getElementById('bp-toast-container').textContent).toContain(TOAST);
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe('generateBatchLabelPDF', function () {
  test('missing libraries: loads both, failure shows the toast', async function () {
    bp._generateBatchLabelPDFForTest({ batch_id: 'B4' }, [], 'tok');
    expect(appended.map(srcOf).sort()).toEqual([PDF, QR].sort());
    appended[0].onerror();
    appended[1].onerror();
    await flush();
    expect(document.getElementById('bp-toast-container').textContent).toContain(TOAST);
  });
});

// ---------------------------------------------------------------------------
// Task 2: collapsible phone sections and action-first order
// ---------------------------------------------------------------------------

var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var YEAR = +TODAY.slice(0, 4);

function lean(id, type, start) {
  return {
    batch_id: id, status: 'primary', batch_type: type, batch_type_source: 'recipe',
    start_date: start, completed_day: null, completed_at: null, completed_at_source: null,
    vessel_id: null, source: 'kiosk', product_sku: '', product_name: '', product_subcategory: '',
    product_brand: '', product_manufacturer: '', recipe_id: '', schedule_id: '',
    schedule_category: '', target_volume_l: 20, tasks_total: 0, tasks_done: 0
  };
}

var DATA = {
  asOf: { today: TODAY, year: YEAR, tz: 'America/Vancouver' },
  batches: [lean('B', 'beer', YEAR + '-01-01'), lean('C', 'cider', YEAR + '-01-01'), lean('A', 'wine', YEAR + '-01-02')]
};

var CHART_SECTIONS = ['production', 'floor', 'bc', 'products', 'health'];
var phone;
var secListeners;
var origRenders;

function setupMedia() {
  window.matchMedia = function (q) {
    return {
      get matches() { return phone && q.indexOf('767') !== -1; },
      addEventListener: function (type, fn) { if (q.indexOf('767') !== -1) secListeners.push(fn); },
      removeEventListener: function () {}
    };
  };
}

function fireSecChange() { secListeners.forEach(function (fn) { fn(); }); }

function widgetsFor(secKey) {
  var sec = document.querySelector('section[data-dash-sec="' + secKey + '"]');
  return bp._dashV2FrameForTest.widgets.filter(function (w) { return sec && sec.querySelector('#' + w.slot); });
}

function mountDash() {
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div><div id="bp-toast-container"></div>';
  bp._setStateForTest({ _allBatchesData: [], _dashData: DATA, _dashSummary: {}, _dashWineSkuLookup: {} });
  bp._setDashV2ForTest(true);
  bp._renderDashboardForTest();
}

function chartScripts() {
  return appended.filter(function (n) { return /chart/i.test(srcOf(n) || ''); });
}

describe('phone sections', function () {
  beforeEach(function () {
    phone = true;
    secListeners = [];
    setupMedia();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/brewpad.html?dash=v2');
    bp._resetDashV2LazyForTest();
    delete window.Chart;
    origRenders = bp._dashV2FrameForTest.widgets.map(function (w) { return w.render; });
    bp._dashV2FrameForTest.widgets.forEach(function (w) { w.render = jest.fn(); });
    mountDash();
  });

  afterEach(function () {
    bp._dashV2FrameForTest.widgets.forEach(function (w, i) { w.render = origRenders[i]; });
    bp._setDashV2ForTest(false);
    delete window.matchMedia;
  });

  test('chart sections start collapsed with a 44px toggle; Today has none', function () {
    CHART_SECTIONS.forEach(function (k) {
      var btn = document.querySelector('button.bp-dash-section-toggle[data-dash-sec-toggle="' + k + '"]');
      expect(btn).not.toBeNull();
      expect(btn.getAttribute('type')).toBe('button');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(btn.getAttribute('aria-controls')).toBe('bp-dash-sec-body-' + k);
      expect(btn.querySelector('.bp-dash-section-chevron').textContent).toBe('▸');
      expect(btn.querySelector('.bp-dash-section-count').textContent).toMatch(/^\d+ charts?$/);
      expect(document.getElementById('bp-dash-sec-body-' + k).hasAttribute('hidden')).toBe(true);
      widgetsFor(k).forEach(function (w) { expect(w.render).not.toHaveBeenCalled(); });
    });
    expect(document.querySelector('[data-dash-sec-toggle="today"]')).toBeNull();
    expect(document.querySelector('section[data-dash-sec="today"] h2.bp-dash-section-title')).not.toBeNull();
    widgetsFor('today').forEach(function (w) { expect(w.render).toHaveBeenCalled(); });
    expect(chartScripts().length).toBe(0);
    expect(document.querySelector('#bp-dash-v2-period .bp-skeleton-chart')).not.toBeNull();
  });

  test('opening renders the section once, loads Chart.js once, keeps focus, closing keeps the render', function () {
    var btn = document.querySelector('[data-dash-sec-toggle="production"]');
    btn.focus();
    btn.click();
    var now = document.querySelector('[data-dash-sec-toggle="production"]');
    expect(now.getAttribute('aria-expanded')).toBe('true');
    expect(now.querySelector('.bp-dash-section-chevron').textContent).toBe('▾');
    expect(document.getElementById('bp-dash-sec-body-production').hasAttribute('hidden')).toBe(false);
    expect(document.activeElement).toBe(now);
    widgetsFor('production').forEach(function (w) { expect(w.render).toHaveBeenCalledTimes(1); });
    expect(chartScripts().length).toBe(1);
    expect(bp._dashV2SecOpenForTest().production).toBe(true);
    now.click();
    expect(document.querySelector('[data-dash-sec-toggle="production"]').getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('bp-dash-sec-body-production').hasAttribute('hidden')).toBe(true);
    document.querySelector('[data-dash-sec-toggle="production"]').click();
    widgetsFor('production').forEach(function (w) { expect(w.render).toHaveBeenCalledTimes(1); });
    expect(chartScripts().length).toBe(1);
  });

  test('a filter change while closed renders with the current model on open', function () {
    window.history.replaceState(null, '', '/brewpad.html?dash=v2#type=beer');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    var st = bp.getStateForTest();
    expect(st._dashV2State.type).toBe('beer');
    widgetsFor('production').forEach(function (w) {
      expect(w.render).not.toHaveBeenCalled();
      expect(bp._dashV2DirtyForTest()[w.key]).toBe(true);
    });
    document.querySelector('[data-dash-sec-toggle="production"]').click();
    widgetsFor('production').forEach(function (w) {
      expect(w.render).toHaveBeenCalledTimes(1);
      expect(w.render.mock.calls[0][0]).toBe(bp.getStateForTest()._dashV2Model);
      expect(bp._dashV2DirtyForTest()[w.key]).toBeUndefined();
    });
  });

  test('DOM order: Today, KPI tiles, then chart sections; same nodes move back on wide', function () {
    function ids() {
      return Array.prototype.map.call(document.getElementById('bp-dash-v2').children, function (c) {
        return c.id || c.getAttribute('data-dash-sec');
      });
    }
    expect(ids()).toEqual(['bp-dash-filters', 'bp-dash-range', 'today', 'bp-dash-v2-tiles', 'production', 'floor', 'bc', 'products', 'health']);
    var tiles = document.getElementById('bp-dash-v2-tiles');
    phone = false;
    fireSecChange();
    expect(document.getElementById('bp-dash-v2-tiles')).toBe(tiles);
    expect(ids()).toEqual(['bp-dash-filters', 'bp-dash-range', 'bp-dash-v2-tiles', 'today', 'production', 'floor', 'bc', 'products', 'health']);
    phone = true;
    fireSecChange();
    expect(ids().slice(2, 4)).toEqual(['today', 'bp-dash-v2-tiles']);
    expect(document.getElementById('bp-dash-v2-tiles')).toBe(tiles);
  });

  test('crossing 768 expands every section; returning restores previous open states', function () {
    document.querySelector('[data-dash-sec-toggle="floor"]').click();
    phone = false;
    fireSecChange();
    expect(document.querySelectorAll('[data-dash-sec-toggle]').length).toBe(0);
    CHART_SECTIONS.forEach(function (k) {
      expect(document.getElementById('bp-dash-sec-body-' + k).hasAttribute('hidden')).toBe(false);
    });
    expect(document.querySelector('section[data-dash-sec="production"] h2.bp-dash-section-title')).not.toBeNull();
    widgetsFor('production').forEach(function (w) { expect(w.render).toHaveBeenCalledTimes(1); });
    phone = true;
    fireSecChange();
    expect(document.querySelector('[data-dash-sec-toggle="floor"]').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-dash-sec-toggle="products"]').getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('bp-dash-sec-body-products').hasAttribute('hidden')).toBe(true);
  });

  test('real widget render replaces the skeleton on open', function () {
    bp._dashV2FrameForTest.widgets.forEach(function (w, i) { w.render = origRenders[i]; });
    expect(document.querySelector('#bp-dash-v2-period .bp-skeleton-chart')).not.toBeNull();
    document.querySelector('[data-dash-sec-toggle="production"]').click();
    expect(document.querySelector('#bp-dash-v2-period .bp-skeleton-chart')).toBeNull();
    expect(document.querySelector('#bp-dash-v2-period .bp-widget-title').textContent).not.toBe('');
  });
});
