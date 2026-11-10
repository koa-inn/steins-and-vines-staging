/**
 * Limited releases: per-kit "Sold out" flag (Aria first).
 * A sold-out kit stays on the page, marked Sold out, with no way to add it.
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'limited-releases-2026-27.json'), 'utf8'));
var PAGE = fs.readFileSync(path.join(ROOT, 'limited-releases.html'), 'utf8');

var lr;
var fetchMock;

function kitByName(name) {
  return DATA.kits.filter(function (k) { return k.short_name === name; })[0];
}
var ARIA = kitByName('Aria');
var EMBER = kitByName('Ember');

// The page as a visitor saw it before Aria sold out (stale open tab).
function staleData() {
  var copy = JSON.parse(JSON.stringify(DATA));
  copy.kits.forEach(function (k) { delete k.sold_out; });
  return copy;
}

function flush() {
  return new Promise(function (r) { setTimeout(r, 0); }).then(function () {
    return new Promise(function (r) { setTimeout(r, 0); });
  }).then(function () {
    return new Promise(function (r) { setTimeout(r, 0); });
  });
}

function resp(status, body) {
  return Promise.resolve({
    status: status,
    ok: status >= 200 && status < 300,
    text: function () { return Promise.resolve(JSON.stringify(body)); }
  });
}

function $(id) { return document.getElementById(id); }

function setup(data) {
  var bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/.exec(PAGE);
  document.head.innerHTML = '';
  document.documentElement.className = '';
  document.body.innerHTML = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.removeAttribute('data-page');
  jest.resetModules();
  window.SHEETS_CONFIG = { MIDDLEWARE_URL: 'https://mw.test' };
  global.SHEETS_CONFIG = window.SHEETS_CONFIG;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  global.appendHelcimPayIframe = jest.fn();
  global.removeHelcimPayIframe = jest.fn();
  lr = require('../../js/modules/18-limited-releases.js');
  lr.render(data || DATA);
}

function card(k) { return $('lr-kit-' + k.sku); }
function plus(k) { return card(k).querySelector('.lr-stepper__btn[data-action="add"]'); }

describe('content', function () {
  test('Aria is the only sold-out kit', function () {
    var sold = DATA.kits.filter(function (k) { return k.sold_out === true; })
      .map(function (k) { return k.short_name; });
    expect(sold).toEqual(['Aria']);
  });
});

describe('sold-out kit card', function () {
  beforeEach(function () { setup(); });

  test('has no stepper, shows Sold out, and carries lr-kit--sold-out', function () {
    var c = card(ARIA);
    expect(c.classList.contains('lr-kit--sold-out')).toBe(true);
    expect(c.querySelector('.lr-stepper')).toBeNull();
    expect(c.querySelector('.lr-kit__footer .lr-soldout').textContent).toBe('Sold out');
  });

  test('keeps the price, notes and pairings', function () {
    var c = card(ARIA);
    expect(c.querySelector('.lr-price').textContent).toContain('$' + ARIA.price);
    expect(c.querySelector('.lr-kit__notes').textContent).toBe(ARIA.notes);
    expect(c.querySelectorAll('.lr-pairs li')).toHaveLength(ARIA.food_pairings.length);
  });

  test('has a Sold out badge over the bottle image', function () {
    var badge = card(ARIA).querySelector('.lr-kit__media .lr-soldout-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('Sold out');
  });

  test('an available kit card is unchanged', function () {
    var c = card(EMBER);
    expect(c.classList.contains('lr-kit--sold-out')).toBe(false);
    expect(c.querySelector('.lr-stepper')).not.toBeNull();
    expect(c.querySelector('.lr-soldout')).toBeNull();
    expect(c.querySelector('.lr-soldout-badge')).toBeNull();
    plus(EMBER).click();
    expect(lr.getBasketLines()).toEqual([{ item_id: EMBER.zoho_item_id, qty: 1 }]);
  });

  test('locking and unlocking controls never adds a stepper back', function () {
    lr.setControlsLocked(true);
    lr.setControlsLocked(false);
    expect(card(ARIA).querySelector('.lr-stepper')).toBeNull();
  });
});

describe('basket guard', function () {
  beforeEach(function () { setup(); });

  test('applyQtyChange refuses a sold-out sku', function () {
    var r = lr.applyQtyChange({}, ARIA.sku, 1);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('sold-out');
    expect(r.basket[ARIA.sku] || 0).toBe(0);
  });

  test('applyQtyChange still works for an available sku', function () {
    var r = lr.applyQtyChange({}, EMBER.sku, 1);
    expect(r.changed).toBe(true);
    expect(r.basket[EMBER.sku]).toBe(1);
  });
});

describe('calendar', function () {
  test('buildCalendar keeps Aria in January and marks it sold out', function () {
    setup();
    var jan = lr.buildCalendar(DATA).filter(function (c) { return c.month === '2027-01'; })[0];
    var aria = jan.kits.filter(function (k) { return k.short_name === 'Aria'; })[0];
    expect(aria.sold_out).toBe(true);
    jan.kits.filter(function (k) { return k.short_name !== 'Aria'; }).forEach(function (k) {
      expect(k.sold_out).toBe(false);
    });
  });

  test('the rendered calendar entry is marked Sold out and still links to the card', function () {
    setup();
    var link = document.querySelector('#lr-calendar a[href="#lr-kit-' + ARIA.sku + '"]');
    expect(link).not.toBeNull();
    expect(link.parentNode.classList.contains('lr-calendar__kit--sold-out')).toBe(true);
    expect(link.querySelector('.lr-calendar__soldout').textContent).toBe('Sold out');
    var ember = document.querySelector('#lr-calendar a[href="#lr-kit-' + EMBER.sku + '"]');
    expect(ember.parentNode.classList.contains('lr-calendar__kit--sold-out')).toBe(false);
    expect(ember.querySelector('.lr-calendar__soldout')).toBeNull();
  });
});

describe('json-ld', function () {
  test('Aria is SoldOut, every other kit is PreOrder', function () {
    setup();
    var ld = lr.buildJsonLd(DATA);
    ld['@graph'].forEach(function (p) {
      expect(p.offers.availability).toBe(p.sku === ARIA.sku
        ? 'https://schema.org/SoldOut'
        : 'https://schema.org/PreOrder');
    });
  });
});

describe('server says sold out (stale tab)', function () {
  beforeEach(function () { setup(staleData()); });

  function pay() {
    $('lr-name').value = 'Jane Doe';
    $('lr-email').value = 'jane@example.com';
    $('lr-phone').value = '604 555 1234';
    plus(ARIA).click();
    plus(EMBER).click();
    plus(EMBER).click();
    var c = $('lr-consent');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
    fetchMock.mockImplementationOnce(function () { return resp(400, { error: 'Aria is sold out' }); });
    $('lr-pay').click();
    return flush();
  }

  test('shows the server message and drops the kit so the rest can still be paid', async function () {
    await pay();
    expect($('lr-pay-alert').textContent).toBe('Aria is sold out');
    expect(lr.getBasketLines()).toEqual([{ item_id: EMBER.zoho_item_id, qty: 2 }]);
    expect(card(ARIA).classList.contains('lr-kit--sold-out')).toBe(true);
    expect(card(ARIA).querySelector('.lr-stepper')).toBeNull();
    expect($('lr-pay').disabled).toBe(false);
  });

  test('a retry posts only the remaining kits', async function () {
    await pay();
    fetchMock.mockImplementationOnce(function () {
      return resp(200, { checkoutToken: 'CT1', secretToken: 'ST1', invoice_number: 'INV-9' });
    });
    $('lr-pay').click();
    await flush();
    var body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.items).toEqual([{ item_id: EMBER.zoho_item_id, qty: 2 }]);
  });

  test('other 400s still show the generic verify message', async function () {
    $('lr-name').value = 'Jane Doe';
    $('lr-email').value = 'jane@example.com';
    $('lr-phone').value = '604 555 1234';
    plus(EMBER).click();
    var c = $('lr-consent');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
    fetchMock.mockImplementationOnce(function () { return resp(400, { error: 'Unknown kit' }); });
    $('lr-pay').click();
    await flush();
    expect($('lr-pay-alert').textContent).toBe('We could not verify your request. Please try again.');
  });
});

describe('submit payload', function () {
  test('getBasketLines never contains a sold-out kit', function () {
    setup();
    lr.applyQtyChange({}, ARIA.sku, 1);
    DATA.kits.forEach(function (k) {
      var p = card(k).querySelector('.lr-stepper__btn[data-action="add"]');
      if (p) p.click();
    });
    var ids = lr.getBasketLines().map(function (l) { return l.item_id; });
    expect(ids).not.toContain(ARIA.zoho_item_id);
    expect(ids).toHaveLength(9);
  });
});
