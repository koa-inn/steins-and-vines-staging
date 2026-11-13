'use strict';

// Phase 95-06: v2 dashboard opt-in, shell, sticky filter bar, phone sheet, hash/localStorage state.

global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
});
// The module reads jsdom's real window.localStorage; use it directly.
function ls(k) { return window.localStorage.getItem(k); }
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

// Fixed to the real clock's year so ytd windows line up with todayPacific().
var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var YEAR = +TODAY.slice(0, 4);
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };

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
  asOf: ASOF,
  batches: [lean('A', 'wine', (YEAR - 1) + '-01-01'), lean('B', 'beer', YEAR + '-01-01'), lean('C', 'cider', YEAR + '-01-01')]
};

function setup() {
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>';
  bp._setStateForTest({ _allBatchesData: [], _dashData: DATA, _dashSummary: {}, _dashWineSkuLookup: {} });
}

function setUrl(search, hash) {
  window.history.replaceState(null, '', '/brewpad.html' + (search || '') + (hash || ''));
}

function setPhone(on) {
  window.matchMedia = function (q) {
    return { matches: on && q.indexOf('600') !== -1, addEventListener: function () {}, removeEventListener: function () {} };
  };
}

function checked(group) {
  var g = document.querySelector('[role="radiogroup"][aria-label="' + group + '"]');
  var b = g.querySelector('[aria-checked="true"]');
  return b ? b.textContent : null;
}

beforeEach(function () {
  window.localStorage.clear();
  setUrl('', '');
  setPhone(false);
  setup();
  bp._initDashV2FlagForTest();
});

describe('opt-in flag and dispatch', function () {
  test('flag off renders v1 and the switch offers the new dashboard', function () {
    window.localStorage.setItem('bp_dash_v2', '0');
    window.localStorage.setItem('bp_dash_default_v2', '1');
    bp._initDashV2FlagForTest();
    bp._renderDashboardForTest();
    expect(document.querySelector('.bp-pipeline-tile')).not.toBeNull();
    expect(document.getElementById('bp-dash-v2')).toBeNull();
    expect(document.getElementById('bp-dash-switch').textContent).toBe('Try new dashboard');
  });

  test('?dash=v2 persists and renders v2; ?dash=v1 turns it off', function () {
    setUrl('?dash=v2', '');
    bp._initDashV2FlagForTest();
    expect(ls('bp_dash_v2')).toBe('1');
    bp._renderDashboardForTest();
    expect(document.getElementById('bp-dash-v2')).not.toBeNull();
    setUrl('?dash=v1', '');
    bp._initDashV2FlagForTest();
    expect(ls('bp_dash_v2')).toBe('0');
    bp._renderDashboardForTest();
    expect(document.getElementById('bp-dash-v2')).toBeNull();
  });

  test('#dash=v2 hash opts in', function () {
    setUrl('', '#dash=v2');
    bp._initDashV2FlagForTest();
    bp._renderDashboardForTest();
    expect(document.getElementById('bp-dash-v2')).not.toBeNull();
  });

  test('throwing localStorage does not crash and defaults to v2', function () {
    var g = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(function () { throw new Error('denied'); });
    var s = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function () { throw new Error('denied'); });
    try {
      expect(function () { bp._initDashV2FlagForTest(); bp._renderDashboardForTest(); }).not.toThrow();
      expect(document.getElementById('bp-dash-v2')).not.toBeNull();
      setUrl('?dash=v2', '');
      expect(function () { bp._initDashV2FlagForTest(); bp._renderDashboardForTest(); }).not.toThrow();
      expect(document.getElementById('bp-dash-v2')).not.toBeNull();
    } finally {
      g.mockRestore();
      s.mockRestore();
    }
  });

  test('switch button toggles v2 and back, destroying charts and stripping dash= from the URL', function () {
    window.localStorage.setItem('bp_dash_v2', '0');
    window.localStorage.setItem('bp_dash_default_v2', '1');
    bp._initDashV2FlagForTest();
    bp._renderDashboardForTest();
    var btn = document.getElementById('bp-dash-switch');
    btn.click();
    expect(ls('bp_dash_v2')).toBe('1');
    expect(document.getElementById('bp-dash-v2')).not.toBeNull();
    expect(btn.textContent).toBe('Classic dashboard');
    var destroyed = 0;
    bp._setDashV2ChartsForTest({ a: { destroy: function () { destroyed++; } }, b: { destroy: function () { destroyed++; } } });
    setUrl('?dash=v2', '#dash=v2&type=wine');
    var spy = jest.spyOn(window.history, 'replaceState');
    btn.click();
    expect(ls('bp_dash_v2')).toBe('0');
    expect(destroyed).toBe(2);
    expect(document.getElementById('bp-dash-v2')).toBeNull();
    expect(document.querySelector('.bp-pipeline-tile')).not.toBeNull();
    var url = spy.mock.calls[spy.mock.calls.length - 1][2];
    expect(url).not.toContain('dash=');
    spy.mockRestore();
  });
});

describe('buildDashV2Model', function () {
  var D = bp.sanitizeDashFilters({}, TODAY);
  test('defaults give ytd and last-year ytd', function () {
    var m = bp.buildDashV2Model(DATA.batches, ASOF, D, {}, {});
    expect(m.win.key).toBe('ytd');
    expect(m.prevWin.start).toBe((YEAR - 1) + '-01-01');
    expect(m.prev).not.toBeNull();
    expect(m.cur.totals.all).toBe(2);
    expect(m.periodLabel).toBe('YTD');
    expect(m.insufficient).toBe(false);
  });
  test('period all has no previous window', function () {
    var m = bp.buildDashV2Model(DATA.batches, ASOF, bp.sanitizeDashFilters({ period: 'all' }, TODAY), {}, {});
    expect(m.prevWin).toBeNull();
    expect(m.prev).toBeNull();
    expect(m.insufficient).toBe(true);
  });
  test('insufficient when previous window starts before the earliest batch', function () {
    var m = bp.buildDashV2Model([lean('Z', 'beer', YEAR + '-01-01')], ASOF, D, {}, {});
    expect(m.insufficient).toBe(true);
  });
});

describe('env state I/O', function () {
  test('filter change writes hash via replaceState and localStorage', function () {
    setUrl('?dash=v2', '');
    bp._initDashV2FlagForTest();
    bp._renderDashboardV2ForTest();
    var spy = jest.spyOn(window.history, 'replaceState');
    document.querySelector('[data-dash-ctl="type"][data-val="wine"]').click();
    var url = spy.mock.calls[spy.mock.calls.length - 1][2];
    expect(url).toContain('#dash=v2&type=wine');
    expect(url).toContain('?dash=v2');
    expect(JSON.parse(ls('bp_dash_filters')).type).toBe('wine');
    spy.mockRestore();
  });
});

describe('shell and filter bar', function () {
  beforeEach(function () {
    setUrl('?dash=v2', '');
    bp._initDashV2FlagForTest();
    bp._renderDashboardV2ForTest();
  });

  test('persistent shell keeps the filter node across re-render', function () {
    var bar = document.getElementById('bp-dash-filters');
    ['bp-dash-range', 'bp-dash-v2-tiles', 'bp-dash-v2-period', 'bp-dash-v2-wine'].forEach(function (id) {
      expect(document.getElementById(id)).not.toBeNull();
    });
    bp._renderDashboardV2ForTest();
    expect(document.getElementById('bp-dash-filters')).toBe(bar);
  });

  test('defaults and radiogroup semantics', function () {
    expect(checked('Type')).toBe('All');
    expect(checked('Period')).toBe('YTD');
    expect(checked('Group by')).toBe('Month');
    expect(checked('Measure')).toBe('Batches');
    var opts = Array.prototype.map.call(document.querySelectorAll('select[data-dash-ctl="source"] option'), function (o) { return o.value; });
    expect(opts).toEqual(['all', 'kiosk', 'online', 'manual', 'zoho_scan', 'research', 'internal', 'unknown']);
    expect(document.querySelector('[data-dash-reset]').hidden).toBe(true);
  });

  test('tapping updates state, shows Reset, Reset restores defaults', function () {
    document.querySelector('[data-dash-ctl="period"][data-val="90d"]').click();
    expect(checked('Period')).toBe('90d');
    expect(bp.getStateForTest()._dashV2State.period).toBe('90d');
    expect(bp.getStateForTest()._dashV2Model.win.key).toBe('90d');
    expect(document.querySelector('[data-dash-reset]').hidden).toBe(false);
    document.querySelector('[data-dash-reset]').click();
    expect(checked('Period')).toBe('YTD');
    expect(document.querySelector('[data-dash-reset]').hidden).toBe(true);
  });

  test('source select and staff toggle', function () {
    var sel = document.querySelector('select[data-dash-ctl="source"]');
    sel.value = 'unknown';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(bp.getStateForTest()._dashV2State.source).toBe('unknown');
    var staff = document.querySelector('[data-dash-staff]');
    expect(staff.getAttribute('aria-pressed')).toBe('false');
    staff.click();
    expect(document.querySelector('[data-dash-staff]').getAttribute('aria-pressed')).toBe('true');
    expect(bp.getStateForTest()._dashV2State.staff).toBe('1');
  });

  test('arrow keys move the selection', function () {
    var b = document.querySelector('[data-dash-ctl="type"][data-val="all"]');
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(checked('Type')).toBe('Wine');
    document.querySelector('[data-dash-ctl="type"][data-val="wine"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(checked('Type')).toBe('All');
  });

  test('custom range validation and apply', function () {
    document.querySelector('[data-dash-ctl="period"][data-val="custom"]').click();
    var range = document.getElementById('bp-dash-range');
    expect(range.hidden).toBe(false);
    var from = range.querySelector('[data-dash-from]');
    var to = range.querySelector('[data-dash-to]');
    var apply = range.querySelector('[data-dash-apply-range]');
    expect(apply.disabled).toBe(true);
    from.value = '2020-07-15';
    to.value = '2020-06-01';
    from.dispatchEvent(new Event('input', { bubbles: true }));
    expect(apply.disabled).toBe(true);
    expect(range.querySelector('.bp-dash-range-error').hidden).toBe(false);
    expect(range.querySelector('.bp-dash-range-error').textContent).toBe('From must be on or before To.');
    from.value = '2020-06-01';
    to.value = '2020-07-15';
    from.dispatchEvent(new Event('input', { bubbles: true }));
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(bp.getStateForTest()._dashV2State.period).toBe('custom');
    expect(document.querySelector('[data-dash-ctl="period"][data-val="custom"]').textContent).toBe('Jun 1 – Jul 15');
  });

  test('hashchange re-applies; invalid values fall back to defaults', function () {
    setUrl('?dash=v2', '#dash=v2&type=cider&period=90d');
    window.dispatchEvent(new Event('hashchange'));
    expect(checked('Type')).toBe('Cider');
    expect(checked('Period')).toBe('90d');
    setUrl('?dash=v2', '#dash=v2&type=bogus');
    window.dispatchEvent(new Event('hashchange'));
    expect(checked('Type')).toBe('All');
  });

  test('hash-injected markup never becomes elements', function () {
    setUrl('?dash=v2', '#dash=v2&type=' + encodeURIComponent('<img src=x onerror=alert(1)>') + '&period=custom&from=' + encodeURIComponent('<img src=y>') + '&to=2020-01-01');
    window.dispatchEvent(new Event('hashchange'));
    expect(document.querySelector('#bp-dashboard-inner img')).toBeNull();
    expect(checked('Type')).toBe('All');
  });
});

describe('phone bottom sheet', function () {
  beforeEach(function () {
    setPhone(true);
    setUrl('?dash=v2', '');
    bp._initDashV2FlagForTest();
    bp._renderDashboardV2ForTest();
  });

  test('bar shows Filters button, badge and summary', function () {
    var bar = document.getElementById('bp-dash-filters');
    expect(bar.querySelector('[data-dash-open-sheet]')).not.toBeNull();
    expect(bar.querySelector('.bp-dash-summary').textContent).toBe('YTD · Month · Batches · All');
    expect(bar.querySelector('.bp-dash-badge').hidden).toBe(true);
  });

  test('sheet stages changes, Apply commits once, focus returns', function () {
    var open = document.querySelector('[data-dash-open-sheet]');
    open.focus();
    open.click();
    var sheet = document.getElementById('bp-dash-sheet');
    var dlg = sheet.querySelector('[role="dialog"]');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dlg.getAttribute('aria-labelledby'))).not.toBeNull();
    expect(sheet.contains(document.activeElement)).toBe(true);
    var spy = jest.spyOn(window.history, 'replaceState');
    sheet.querySelector('[data-dash-ctl="type"][data-val="beer"]').click();
    expect(bp.getStateForTest()._dashV2State.type).toBe('all');
    expect(spy).not.toHaveBeenCalled();
    sheet.querySelector('[data-dash-apply-sheet]').click();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(document.getElementById('bp-dash-sheet')).toBeNull();
    expect(bp.getStateForTest()._dashV2State.type).toBe('beer');
    expect(document.querySelector('.bp-dash-badge').textContent).toBe('1');
    expect(document.activeElement).toBe(document.querySelector('[data-dash-open-sheet]'));
  });

  test('Esc, backdrop and close button dismiss without committing', function () {
    function openSheet() { document.querySelector('[data-dash-open-sheet]').click(); }
    openSheet();
    document.querySelector('[data-dash-ctl="type"][data-val="beer"]').click();
    document.querySelector('.bp-dash-sheet-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('bp-dash-sheet')).toBeNull();
    openSheet();
    document.querySelector('.bp-dash-sheet-backdrop').click();
    expect(document.getElementById('bp-dash-sheet')).toBeNull();
    openSheet();
    var x = document.querySelector('[aria-label="Close filters"]');
    expect(x).not.toBeNull();
    x.click();
    expect(document.getElementById('bp-dash-sheet')).toBeNull();
    expect(bp.getStateForTest()._dashV2State.type).toBe('all');
  });
});
