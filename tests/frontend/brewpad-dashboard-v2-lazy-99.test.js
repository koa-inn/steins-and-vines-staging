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
