'use strict';

// Phase 99-05: line-chart point markers, legend glyphs and safe touch tooltips (fake Chart).

global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
});
global.localStorage = {
  _data: {},
  getItem: function (k) { return this._data[k] || null; },
  setItem: function (k, v) { this._data[k] = v; },
  removeItem: function (k) { delete this._data[k]; },
  clear: function () { this._data = {}; }
};
var _ssData = {};
global.sessionStorage = {
  getItem: function (k) { return _ssData[k] !== undefined ? _ssData[k] : null; },
  setItem: function (k, v) { _ssData[k] = v; },
  removeItem: function (k) { delete _ssData[k]; },
  clear: function () { Object.keys(_ssData).forEach(function (k) { delete _ssData[k]; }); }
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;


var bp = require('../../js/brewpad');

function makeFakeChart() {
  function FakeChart(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.destroyed = false;
    FakeChart.instances.push(this);
  }
  FakeChart.instances = [];
  FakeChart.hits = {};
  FakeChart.prototype.destroy = function () { this.destroyed = true; };
  FakeChart.prototype.update = function () {};
  FakeChart.prototype.getElementsAtEventForMode = function (evt, mode) { return FakeChart.hits[mode] || []; };
  FakeChart.getChart = function (canvas) {
    for (var i = FakeChart.instances.length - 1; i >= 0; i--) {
      if (FakeChart.instances[i].canvas === canvas && !FakeChart.instances[i].destroyed) return FakeChart.instances[i];
    }
    return undefined;
  };
  FakeChart.defaults = { font: {} };
  return FakeChart;
}

var Fake;
var wrap;
var canvas;

function lineCfg(over) {
  var c = {
    type: 'line', markers: true, xType: 'linear', xTitle: 'Days since start', unit: 'plato',
    ariaLabel: 'Plato readings', hitDatasetIndex: true, onClick: jest.fn(),
    series: [
      { key: 'A1', label: 'A1', data: [{ x: 1, y: 12.5 }, { x: 2, y: 9 }], colour: '#111', markerStyle: 'triangle' },
      { key: 'A2', label: 'A2', data: [{ x: 1, y: 11 }], colour: '#222', markerStyle: 'rect' }
    ]
  };
  for (var k in over) c[k] = over[k];
  return c;
}

function touch(extra) {
  var e = { native: { pointerType: 'touch' }, x: 40, y: 30 };
  for (var k in extra) e[k] = extra[k];
  return e;
}

beforeEach(function () {
  document.body.innerHTML = '';
  window.matchMedia = function () { return { matches: false }; };
  Fake = makeFakeChart();
  window.Chart = Fake;
  wrap = document.createElement('div');
  wrap.className = 'bp-chart';
  canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  document.body.appendChild(wrap);
});

describe('point markers (D-15)', function () {
  test('type-keyed series get circle/triangle/rect/rectRot with 6px marker and 22px hit radius', function () {
    var keys = ['wine', 'cider', 'beer', 'other'];
    var series = keys.map(function (k) { return { key: k, label: k, data: [{ x: 1, y: 1 }], colour: '#abc' }; });
    var c = bp._chartForTest(canvas, lineCfg({ series: series, onClick: undefined }));
    var ds = c.config.data.datasets;
    expect(ds.map(function (d) { return d.pointStyle; })).toEqual(['circle', 'triangle', 'rect', 'rectRot']);
    expect(ds[0].pointRadius).toBe(6);
    expect(ds[0].pointHitRadius).toBe(22);
    expect(ds[0].pointBackgroundColor).toBe('#abc');
    expect(ds[0].pointBorderColor).toBe(bp.readChartTheme().separator);
    expect(ds[0].pointBorderWidth).toBe(1);
  });

  test('series markerStyle override wins over the key mapping', function () {
    var c = bp._chartForTest(canvas, lineCfg());
    expect(c.config.data.datasets[0].pointStyle).toBe('triangle');
    expect(c.config.data.datasets[1].pointStyle).toBe('rect');
  });

  test('more than 24 points: markers only on hover', function () {
    var data = [];
    for (var i = 0; i < 25; i++) data.push({ x: i, y: i });
    var c = bp._chartForTest(canvas, lineCfg({ series: [{ key: 'wine', label: 'w', data: data, colour: '#000' }] }));
    var d = c.config.data.datasets[0];
    expect(d.pointRadius).toBe(0);
    expect(d.pointHoverRadius).toBe(6);
    expect(d.pointStyle).toBe('circle');
  });

  test('explicit series pointRadius still wins', function () {
    var c = bp._chartForTest(canvas, lineCfg({ series: [{ key: 'wine', label: 'w', data: [{ x: 1, y: 1 }], colour: '#000', pointRadius: 0 }] }));
    expect(c.config.data.datasets[0].pointRadius).toBe(0);
  });

  test('without cfg.markers datasets carry no marker fields', function () {
    var c = bp._chartForTest(canvas, lineCfg({ markers: undefined }));
    var d = c.config.data.datasets[0];
    expect(d.pointStyle).toBeUndefined();
    expect(d.pointHitRadius).toBeUndefined();
    expect(d.pointBackgroundColor).toBeUndefined();
  });

  test('bar charts never get markers', function () {
    var c = bp._chartForTest(canvas, { type: 'bar', markers: true, labels: ['a'], series: [{ key: 'wine', label: 'W', data: [1], colour: '#000' }], ariaLabel: 'x' });
    expect(c.config.data.datasets[0].pointStyle).toBeUndefined();
  });

  test('dashTypeMarker maps batch types to marker styles', function () {
    expect(bp.dashTypeMarker('wine')).toBe('circle');
    expect(bp.dashTypeMarker('cider')).toBe('triangle');
    expect(bp.dashTypeMarker('beer')).toBe('rect');
    expect(bp.dashTypeMarker('other')).toBe('rectRot');
    expect(bp.dashTypeMarker('seltzer')).toBe('cross');
  });
});

describe('legend glyphs', function () {
  test('marker items render an aria-hidden glyph in the series colour, plain items keep the swatch', function () {
    var html = bp.dashV2LegendHtml([
      { label: 'Beer', colour: '#9a4e0c', marker: 'rect' },
      { label: 'Wine', colour: '#6e1a2c' }
    ]);
    var host = document.createElement('div');
    host.innerHTML = html;
    var items = host.querySelectorAll('.bp-chart-legend-item');
    var g = items[0].querySelector('.bp-chart-legend-glyph');
    expect(g).not.toBeNull();
    expect(g.getAttribute('aria-hidden')).toBe('true');
    expect(g.textContent).toBe('■');
    expect(g.getAttribute('style')).toContain('#9a4e0c');
    expect(items[0].querySelector('.bp-chart-swatch')).toBeNull();
    expect(items[1].querySelector('.bp-chart-swatch')).not.toBeNull();
    expect(items[1].querySelector('.bp-chart-legend-glyph')).toBeNull();
  });

  test('colour is escaped', function () {
    var html = bp.dashV2LegendHtml([{ label: 'x', colour: '"><img src=x>', marker: 'circle' }]);
    expect(html).not.toContain('<img');
  });
});

describe('canvas description', function () {
  test('aria-label unchanged; aria-describedby points at one shared hidden sentence', function () {
    bp._chartForTest(canvas, lineCfg());
    expect(canvas.getAttribute('aria-label')).toBe('Plato readings');
    expect(canvas.getAttribute('aria-describedby')).toBe('bp-chart-desc');
    var c2 = document.createElement('canvas');
    wrap.appendChild(c2);
    bp._chartForTest(c2, lineCfg());
    var descs = document.querySelectorAll('#bp-chart-desc');
    expect(descs.length).toBe(1);
    expect(descs[0].textContent).toBe('Switch to Table for the full data.');
    expect(descs[0].className).toContain('bp-visually-hidden');
  });
});

describe('touch tooltip (D-13)', function () {
  var conf;
  var c;
  beforeEach(function () {
    conf = lineCfg();
    c = bp._chartForTest(canvas, conf);
  });

  function tapPoint(ev, dsIdx, idx) {
    Fake.hits.nearest = [{ datasetIndex: dsIdx, index: idx }];
    c.config.options.onClick(ev || touch(), []);
  }

  test('mouse path is unchanged: single click drills, no tip', function () {
    Fake.hits.nearest = [{ datasetIndex: 1, index: 0 }];
    c.config.options.onClick({ native: { pointerType: 'mouse' } }, []);
    expect(conf.onClick).toHaveBeenCalledWith({ index: 0, key: 'A2', datasetIndex: 1 });
    expect(wrap.querySelector('.bp-chart-tip')).toBeNull();
  });

  test('no native event behaves as mouse', function () {
    Fake.hits.nearest = [{ datasetIndex: 0, index: 1 }];
    c.config.options.onClick({}, []);
    expect(conf.onClick).toHaveBeenCalledTimes(1);
  });

  test('first touch tap shows the tip with title, values and button and does not navigate', function () {
    tapPoint(null, 0, 1);
    expect(conf.onClick).not.toHaveBeenCalled();
    var tip = wrap.querySelector('.bp-chart-tip');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('Days since start: 2');
    expect(tip.textContent).toContain('A1: 9 °P');
    var btn = tip.querySelector('button.bp-chart-tip-action');
    expect(btn.textContent).toBe('View batches ›');
  });

  test('second tap on the same point drills and removes the tip', function () {
    tapPoint(null, 0, 1);
    tapPoint(null, 0, 1);
    expect(conf.onClick).toHaveBeenCalledWith({ index: 1, key: 'A1', datasetIndex: 0 });
    expect(wrap.querySelector('.bp-chart-tip')).toBeNull();
  });

  test('tap on a different point moves the tip and does not navigate', function () {
    tapPoint(null, 0, 1);
    tapPoint(null, 1, 0);
    expect(conf.onClick).not.toHaveBeenCalled();
    expect(wrap.querySelectorAll('.bp-chart-tip').length).toBe(1);
    expect(wrap.querySelector('.bp-chart-tip').textContent).toContain('A2: 11 °P');
  });

  test('the button drills with the same payload', function () {
    tapPoint(null, 0, 0);
    wrap.querySelector('.bp-chart-tip-action').click();
    expect(conf.onClick).toHaveBeenCalledWith({ index: 0, key: 'A1', datasetIndex: 0 });
    expect(wrap.querySelector('.bp-chart-tip')).toBeNull();
  });

  test('tap on empty chart area hides the tip', function () {
    tapPoint(null, 0, 0);
    Fake.hits.nearest = [];
    Fake.hits.index = [];
    c.config.options.onClick(touch(), []);
    expect(wrap.querySelector('.bp-chart-tip')).toBeNull();
    expect(conf.onClick).not.toHaveBeenCalled();
  });

  test('pointerdown outside the chart and Escape hide the tip; pointerdown inside the tip keeps it', function () {
    tapPoint(null, 0, 0);
    wrap.querySelector('.bp-chart-tip').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(wrap.querySelector('.bp-chart-tip')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(wrap.querySelector('.bp-chart-tip')).toBeNull();
    tapPoint(null, 0, 0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrap.querySelector('.bp-chart-tip')).toBeNull();
    tapPoint(null, 0, 0);
    expect(conf.onClick).not.toHaveBeenCalled();
  });

  test('last pointerdown type on the canvas marks touch when the click event carries none', function () {
    var pd = new Event('pointerdown');
    pd.pointerType = 'touch';
    canvas.dispatchEvent(pd);
    Fake.hits.nearest = [{ datasetIndex: 0, index: 0 }];
    c.config.options.onClick({}, []);
    expect(conf.onClick).not.toHaveBeenCalled();
    expect(wrap.querySelector('.bp-chart-tip')).not.toBeNull();
  });

  test('inert keys show values without a button and never drill', function () {
    var cc = document.createElement('canvas');
    wrap.appendChild(cc);
    var conf2 = lineCfg({ inertKeys: ['A1'] });
    var c2 = bp._chartForTest(cc, conf2);
    Fake.hits.nearest = [{ datasetIndex: 0, index: 0 }];
    c2.config.options.onClick(touch(), []);
    c2.config.options.onClick(touch(), []);
    expect(conf2.onClick).not.toHaveBeenCalled();
    expect(wrap.querySelector('.bp-chart-tip')).not.toBeNull();
    expect(wrap.querySelector('.bp-chart-tip-action')).toBeNull();
  });

  test('without cfg.onClick the touch tip shows values only', function () {
    var cc = document.createElement('canvas');
    wrap.appendChild(cc);
    var c2 = bp._chartForTest(cc, { type: 'bar', labels: ['a', 'b'], series: [{ key: 'wine', label: 'Wine', data: [3, 4], colour: '#000' }], ariaLabel: 'x' });
    expect(c2.config.options.onClick).toBeDefined();
    Fake.hits.index = [{ datasetIndex: 0, index: 1 }];
    Fake.hits.nearest = [{ datasetIndex: 0, index: 1 }];
    c2.config.options.onClick(touch(), []);
    var tip = wrap.querySelector('.bp-chart-tip');
    expect(tip.textContent).toContain('b');
    expect(tip.textContent).toContain('Wine: 4 batches');
    expect(tip.querySelector('button')).toBeNull();
  });

  test('tip text is set with textContent (no markup from data)', function () {
    conf.series[0].label = '<img src=x onerror=alert(1)>';
    c = bp._chartForTest(canvas, conf);
    tapPoint(null, 0, 0);
    expect(wrap.querySelector('.bp-chart-tip img')).toBeNull();
  });

  test('tip box is kept at least 8px inside the viewport', function () {
    var orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.className === 'bp-chart-tip') return { left: -30, right: 120, top: 0, bottom: 50, width: 150, height: 50 };
      return { left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200 };
    };
    try {
      tapPoint(touch({ x: 0, y: 10 }), 0, 0);
      var tip = wrap.querySelector('.bp-chart-tip');
      expect(parseFloat(tip.style.left)).toBeGreaterThanOrEqual(8);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
  });
});
