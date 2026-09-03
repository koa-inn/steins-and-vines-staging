'use strict';

// Regression coverage for the beer waitlist form's colour contrast.
//
// The bug: `.beer-waitlist-form` was styled for the dark green hero banner (cream text on a
// translucent white field), but the only instance of the form on beer.html lives in
// `<section class="content" id="waitlist">` — on the light cream body. That put the input's text
// colour and the success confirmation's text colour at `var(--color-cream)` (#e5dec1) against a
// body background of `var(--color-cream)` (#e5dec1): a measured contrast ratio of 1.00. Customers
// could not see their own typing, and could not see the "Thanks! You're on the list" confirmation
// after submitting. Found during the Phase 78 staging UAT.
//
// This suite parses the real css/styles.css, resolves the :root custom properties, and asserts a
// WCAG AA contrast ratio for the declarations that actually render on the light background.
//
// WHAT THIS SUITE CANNOT PROVE: it reasons about DECLARED values in a stylesheet, not about the
// composited result in a browser. It assumes the form renders on the body background, which is
// true while beer.html places it inside `section.content` (asserted below). It does not catch
// contrast regressions introduced by inline styles, by another stylesheet, or by moving the form
// into a differently-coloured container.

var fs = require('fs');
var path = require('path');

var CSS_PATH = path.join(__dirname, '../../css/styles.css');
var HTML_PATH = path.join(__dirname, '../../beer.html');

function css() {
  // Strip comments before parsing: ruleBlock() anchors selectors on `}` or start-of-input, and a
  // comment between two rules would otherwise hide the rule that follows it.
  return fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

// --- colour helpers -------------------------------------------------------------------------

function rootVars(src) {
  var block = src.match(/:root\s*\{([\s\S]*?)\}/);
  var vars = {};
  if (!block) return vars;
  var re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  var m;
  while ((m = re.exec(block[1])) !== null) vars[m[1]] = m[2].trim();
  return vars;
}

function resolve(value, vars) {
  var out = String(value).trim();
  for (var i = 0; i < 5 && /var\(/.test(out); i++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, function (_, name) {
      return vars[name] !== undefined ? vars[name] : '';
    }).trim();
  }
  return out;
}

function toRgb(color) {
  var c = String(color).trim().toLowerCase();
  var hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    var h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  var rgb = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if (c === 'white') return [255, 255, 255];
  if (c === 'black') return [0, 0, 0];
  return null;
}

// Alpha-composite `fg` (which may be rgba) over an opaque `bg`.
function flatten(color, bgRgb) {
  var m = String(color).trim().match(/^rgba\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/i);
  if (!m) return toRgb(color);
  var a = Number(m[4]);
  return [1, 2, 3].map(function (i) {
    return Math.round(Number(m[i]) * a + bgRgb[i - 1] * (1 - a));
  });
}

function luminance(rgb) {
  var a = rgb.map(function (v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function contrast(fgRgb, bgRgb) {
  var L1 = luminance(fgRgb) + 0.05;
  var L2 = luminance(bgRgb) + 0.05;
  return Math.round((Math.max(L1, L2) / Math.min(L1, L2)) * 100) / 100;
}

// Return the LAST matching rule block for a selector (later rules win in the cascade).
function ruleBlock(src, selector) {
  var esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp('(?:^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}', 'g');
  var m, last = null;
  while ((m = re.exec(src)) !== null) last = m[1];
  return last;
}

function decl(block, prop) {
  if (!block) return null;
  var re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i');
  var m = block.match(re);
  return m ? m[1].trim() : null;
}

var AA = 4.5;

// --- tests ----------------------------------------------------------------------------------

describe('beer waitlist form — colour contrast on the light body', function () {
  var src, vars, bodyBg;

  beforeAll(function () {
    src = css();
    vars = rootVars(src);
    bodyBg = toRgb(resolve(decl(ruleBlock(src, 'body'), 'background-color'), vars));
  });

  test('the page background resolves to the cream brand colour', function () {
    expect(bodyBg).toEqual([229, 222, 193]);
  });

  // Guards the assumption the rest of this suite rests on.
  test('beer.html renders the waitlist form on the body background, not inside a dark banner', function () {
    var html = fs.readFileSync(HTML_PATH, 'utf8');
    var idx = html.indexOf('class="beer-waitlist-form"');
    expect(idx).toBeGreaterThan(-1);
    var before = html.slice(0, idx);
    var lastSection = before.lastIndexOf('<section');
    var openTag = before.slice(lastSection, before.indexOf('>', lastSection) + 1);
    expect(openTag).toContain('id="waitlist"');
    expect(openTag).not.toContain('beer-banner');
  });

  // THE REGRESSION. Was contrast 1.00 — cream text on the cream body.
  test('the email input text meets WCAG AA against its own field background', function () {
    var block = ruleBlock(src, '.beer-waitlist-form input[type="email"]');
    expect(block).not.toBeNull();

    var fieldBg = flatten(resolve(decl(block, 'background'), vars) || '', bodyBg) || bodyBg;
    var textRgb = flatten(resolve(decl(block, 'color'), vars), fieldBg);
    expect(textRgb).not.toBeNull();

    var ratio = contrast(textRgb, fieldBg);
    expect(ratio).toBeGreaterThanOrEqual(AA);
  });

  // THE OTHER REGRESSION. The success message rendered invisibly after a successful signup.
  test('the success confirmation meets WCAG AA against the page background', function () {
    var block = ruleBlock(src, '.beer-waitlist-confirm');
    expect(block).not.toBeNull();
    var rgb = flatten(resolve(decl(block, 'color'), vars), bodyBg);
    expect(rgb).not.toBeNull();
    expect(contrast(rgb, bodyBg)).toBeGreaterThanOrEqual(AA);
  });

  test('the input placeholder meets WCAG AA against its own field background', function () {
    var fieldBlock = ruleBlock(src, '.beer-waitlist-form input[type="email"]');
    var fieldBg = flatten(resolve(decl(fieldBlock, 'background'), vars) || '', bodyBg) || bodyBg;
    var block = ruleBlock(src, '.beer-waitlist-form input[type="email"]::placeholder');
    expect(block).not.toBeNull();
    var rgb = flatten(resolve(decl(block, 'color'), vars), fieldBg);
    expect(contrast(rgb, fieldBg)).toBeGreaterThanOrEqual(AA);
  });

  test('the submit button is not overridden to a cream-on-cream fill', function () {
    // `.beer-waitlist-btn` carries class `btn` in the markup, so with no base override it
    // inherits the burgundy primary button. A base override back to cream would reintroduce an
    // invisible button on the light background.
    var block = ruleBlock(src, '.beer-waitlist-btn');
    if (block === null) return; // no override at all — inherits .btn, which is what we want
    var bg = flatten(resolve(decl(block, 'background') || decl(block, 'background-color') || '', vars) || '', bodyBg);
    if (!bg) return;
    expect(contrast(bg, bodyBg)).toBeGreaterThanOrEqual(3);
  });

  test('the focused input keeps a border that is visible against the page', function () {
    var block = ruleBlock(src, '.beer-waitlist-form input[type="email"]:focus-visible');
    expect(block).not.toBeNull();
    var outline = decl(block, 'outline');
    var borderColor = decl(block, 'border-color');
    // Either a real outline, or a border colour that is actually visible on cream.
    if (outline && !/none/i.test(outline)) {
      expect(outline).toBeTruthy();
    } else {
      var rgb = flatten(resolve(borderColor, vars), bodyBg);
      expect(contrast(rgb, bodyBg)).toBeGreaterThanOrEqual(3);
    }
  });
});
