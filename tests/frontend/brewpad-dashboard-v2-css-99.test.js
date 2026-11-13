'use strict';

// Phase 99-06: CSS-reading assertions for the v2 dashboard grid, focus rings, text contrast and tap targets.

var fs = require('fs');
var path = require('path');

var css = fs.readFileSync(path.join(__dirname, '../../css/brewpad.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Minimal rule splitter: returns [{media, selector, body}] with one level of @media nesting.
function parseRules(src) {
  var rules = [];
  var i = 0;
  function readBlock(media) {
    while (i < src.length) {
      var open = src.indexOf('{', i);
      if (open === -1) { i = src.length; return; }
      var head = src.slice(i, open).trim();
      var close;
      var depth = 1;
      var j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      close = j - 1;
      if (head.indexOf('@media') === 0) {
        var inner = parseRules(src.slice(open + 1, close));
        inner.forEach(function (r) { rules.push({ media: head.replace(/\s+/g, ' '), selector: r.selector, body: r.body }); });
      } else if (head.charAt(0) !== '@') {
        rules.push({ media: media || '', selector: head.replace(/\s+/g, ' '), body: src.slice(open + 1, close) });
      }
      i = close + 1;
    }
  }
  readBlock('');
  return rules;
}

var rules = parseRules(css);

function find(selectorPart, media) {
  return rules.filter(function (r) {
    return r.selector.split(',').some(function (s) { return s.trim() === selectorPart; }) && (media === undefined || r.media === media);
  });
}

function decl(rule, prop) {
  var m = new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([^;]+)', 'i').exec(rule.body);
  return m ? m[1].trim() : null;
}

describe('grid (D-11, D-12)', function () {
  test('3 columns with a 24px gap from 1200px', function () {
    var r = find('.bp-dash-grid', '@media (min-width: 1200px)');
    expect(r.length).toBe(1);
    expect(decl(r[0], 'grid-template-columns')).toBe('repeat(3, minmax(0, 1fr))');
    expect(decl(r[0], 'gap')).toBe('24px');
  });

  test('2 columns from 768px, 1 column by default, and no 4-column grid', function () {
    expect(decl(find('.bp-dash-grid', '@media (min-width: 768px)')[0], 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
    expect(decl(find('.bp-dash-grid', '')[0], 'grid-template-columns')).toBe('1fr');
    rules.filter(function (r) { return r.selector === '.bp-dash-grid'; }).forEach(function (r) {
      expect(decl(r, 'grid-template-columns') || '').not.toMatch(/repeat\(4/);
    });
  });

  test('the dashboard container widens at 1200px so three columns have room', function () {
    var r = rules.filter(function (x) { return x.media === '@media (min-width: 1200px)' && x.selector.indexOf('bp-dash-v2') !== -1 && x.selector.indexOf('bp-dashboard-inner') !== -1; });
    expect(r.length).toBe(1);
    expect(decl(r[0], 'max-width')).toBeTruthy();
    expect(decl(r[0], 'padding')).toMatch(/24px/);
  });

  test('full-width slots span the row; grid children and charts can shrink', function () {
    expect(decl(find('.bp-dash-full')[0], 'grid-column')).toBe('1 / -1');
    var kids = find('.bp-dash-grid > *');
    expect(kids.length).toBe(1);
    expect(decl(kids[0], 'min-width')).toBe('0');
    var chart = rules.filter(function (r) { return r.selector === '.bp-chart'; });
    expect(chart.some(function (r) { return decl(r, 'min-width') === '0'; })).toBe(true);
  });
});

describe('focus rings (D-14)', function () {
  var fv = rules.filter(function (r) { return r.selector.indexOf(':focus-visible') !== -1; });

  test('there are focus-visible rules to check', function () {
    expect(fv.length).toBeGreaterThan(10);
  });

  test('no :focus-visible rule uses the faint --ledger-focus token', function () {
    fv.forEach(function (r) { expect([r.selector, r.body]).not.toEqual([r.selector, expect.stringContaining('--ledger-focus')]); });
  });

  test('no :focus-visible rule removes the outline', function () {
    fv.forEach(function (r) { expect([r.selector, /outline\s*:\s*(none|0)\b/.test(r.body)]).toEqual([r.selector, false]); });
  });

  test('v2 focus rules draw a 2px --stain ring (the tooltip action sits on --stain and uses the light ring)', function () {
    var v2 = fv.filter(function (r) { return /\.bp-(dash|attn|stat|table|list|accordion|bc|text-btn|drill)/.test(r.selector) && r.body.indexOf('outline:') !== -1; });
    expect(v2.length).toBeGreaterThan(6);
    v2.forEach(function (r) { expect([r.selector, decl(r, 'outline')]).toEqual([r.selector, '2px solid var(--stain)']); });
  });

  test('input focus borders use --stain, not --ledger-focus', function () {
    rules.forEach(function (r) {
      if (r.selector.indexOf(':focus') === -1) return;
      expect([r.selector, /border-color\s*:\s*var\(--ledger-focus\)/.test(r.body)]).toEqual([r.selector, false]);
    });
  });
});

describe('contrast (D-14)', function () {
  var V2 = /^\.bp-(dash|attn|stat|seg|table|chart|health|list|empty|tab|shell-brand|batch-chip)/;

  test('no v2 text colour uses --ink-tertiary (3.28:1 on --cellar-raised)', function () {
    var bad = [];
    rules.forEach(function (r) {
      var c = decl(r, 'color');
      if (c !== 'var(--ink-tertiary)') return;
      r.selector.split(',').forEach(function (s) {
        if (V2.test(s.trim())) bad.push(s.trim());
      });
    });
    expect(bad).toEqual([]);
  });

  test('no v2 text colour uses --ink-muted', function () {
    var bad = [];
    rules.forEach(function (r) {
      if (decl(r, 'color') !== 'var(--ink-muted)') return;
      r.selector.split(',').forEach(function (s) { if (V2.test(s.trim())) bad.push(s.trim()); });
    });
    expect(bad).toEqual([]);
  });

  test('an overdue batch chip is not overridden back to blue by the base chip rule', function () {
    var over = find('.bp-batch-chip.bp-batch-chip--overdue');
    expect(over.length).toBe(1);
    expect(decl(over[0], 'color')).toBe('var(--batch-danger)');
  });
});

describe('tap targets (D-14)', function () {
  ['.bp-seg-btn', '.bp-link-btn', '.bp-filter-btn', '.bp-attn-chip', '.bp-dash-section-toggle', '.bp-chart-tip-action', '.bp-dash-chip', '.bp-text-btn', '.bp-table-link', '.bp-accordion-head', '.bp-bc-head'].forEach(function (sel) {
    test(sel + ' is at least 44px tall', function () {
      var hit = find(sel).filter(function (r) { return decl(r, 'min-height') === '44px'; });
      expect(hit.length).toBeGreaterThan(0);
    });
  });

  test('v2 controls opt out of double-tap zoom delay', function () {
    var hit = rules.filter(function (r) { return decl(r, 'touch-action') === 'manipulation' && r.selector.indexOf('.bp-seg-btn') !== -1; });
    expect(hit.length).toBeGreaterThan(0);
    ['.bp-link-btn', '.bp-attn-chip', '.bp-dash-chip', '.bp-text-btn', '.bp-table-link', '.bp-accordion-head', '.bp-bc-head'].forEach(function (sel) {
      expect([sel, hit[0].selector.indexOf(sel) !== -1]).toEqual([sel, true]);
    });
  });
});
