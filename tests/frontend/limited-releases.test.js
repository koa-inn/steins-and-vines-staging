/**
 * Limited releases page module (Phase 100, plan 11).
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'limited-releases-2026-27.json'), 'utf8'));
var PAGE = fs.readFileSync(path.join(ROOT, 'limited-releases.html'), 'utf8');

var lr;

// Observers from earlier module instances would otherwise keep reacting to
// class changes on <html>; track and disconnect them between tests.
var RealMutationObserver = global.MutationObserver;
var liveObservers = [];
global.MutationObserver = function (cb) {
  var inner = new RealMutationObserver(cb);
  liveObservers.push(inner);
  this.observe = function (n, o) { return inner.observe(n, o); };
  this.disconnect = function () { return inner.disconnect(); };
};

function loadPage() {
  liveObservers.forEach(function (o) { o.disconnect(); });
  liveObservers = [];
  var bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/.exec(PAGE);
  var body = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.head.innerHTML = '';
  document.documentElement.className = '';
  document.body.innerHTML = body;
  // Keep the boot step from fetching on require; tests call render() directly.
  document.body.removeAttribute('data-page');
}

function freshModule() {
  jest.resetModules();
  lr = require('../../js/modules/18-limited-releases.js');
}

function renderPage() {
  loadPage();
  freshModule();
  lr.render(DATA);
}

function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

function plus(sku) {
  return document.querySelector('#lr-kit-' + sku + ' .lr-stepper__btn[data-action="add"]');
}
function minus(sku) {
  return document.querySelector('#lr-kit-' + sku + ' .lr-stepper__btn[data-action="remove"]');
}

function kit(name) {
  for (var i = 0; i < DATA.kits.length; i++) {
    if (DATA.kits[i].short_name === name) return DATA.kits[i];
  }
  return null;
}

function shortNames(sectionId) {
  var out = [];
  var nodes = document.querySelectorAll('#' + sectionId + ' .lr-kit__name');
  for (var i = 0; i < nodes.length; i++) out.push(nodes[i].textContent);
  return out;
}

describe('pure functions', function () {
  beforeAll(freshModule);

  test('specs: Ember includes weeks and the oak detail', function () {
    expect(lr.formatSpecs(kit('Ember'))).toEqual(
      ['Red', 'Dry', 'Medium body', 'Oak: Medium (American and French)', '13.8% ABV', '6 weeks']);
  });

  test('specs: weeks omitted entirely when null', function () {
    var le = DATA.kits.filter(function (k) { return k.weeks === null; })[0];
    expect(le).toBeTruthy();
    var joined = lr.formatSpecs(le).join(' | ');
    expect(joined).not.toMatch(/weeks|null|TBC|undefined/i);
  });

  test('calendar: six months in order, collection order within a month', function () {
    var cal = lr.buildCalendar(DATA);
    expect(cal.map(function (c) { return c.month; })).toEqual(
      ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
    expect(cal[0].kits.map(function (k) { return k.short_name; })).toEqual(['Ember']);
    expect(cal[1].kits.map(function (k) { return k.short_name; })).toEqual(['Connexion Red']);
    for (var i = 2; i < 6; i++) {
      expect(cal[i].kits).toHaveLength(2);
      expect(cal[i].kits[0].collection).toBe('le26');
      expect(cal[i].kits[1].collection).toBe('rq27');
    }
  });

  test('grouping: JSON collection order, ascending release order', function () {
    var g = lr.groupKitsByCollection(DATA);
    expect(g.map(function (x) { return x.collection.id; })).toEqual(['le26', 'rq27']);
    expect(g[0].kits.map(function (k) { return k.release; })).toEqual(
      ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
    expect(g[1].kits.map(function (k) { return k.release; })).toEqual(
      ['2026-11', '2027-01', '2027-02', '2027-03', '2027-04']);
  });

  test('json-ld: Product + PreOrder Offer per kit at the kit price', function () {
    var ld = lr.buildJsonLd(DATA);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@graph']).toHaveLength(10);
    ld['@graph'].forEach(function (p) {
      var src = DATA.kits.filter(function (k) { return k.sku === p.sku; })[0];
      expect(p['@type']).toBe('Product');
      expect(p.offers.priceCurrency).toBe('CAD');
      expect(p.offers.price).toBe(src.price);
      expect(p.offers.price).not.toBe(50);
      // Sold-out kits are SoldOut (covered in limited-releases-sold-out.test.js).
      if (!src.sold_out) expect(p.offers.availability).toBe('https://schema.org/PreOrder');
      expect(p.offers.availabilityStarts).toBe(src.release + '-01');
    });
  });
});

describe('asset paths', function () {
  test('every images/limited-releases path in the JSON exists on disk', function () {
    var found = [];
    (function walk(v) {
      if (typeof v === 'string') {
        if (/^images\/limited-releases\//.test(v)) found.push(v);
      } else if (v && typeof v === 'object') {
        Object.keys(v).forEach(function (k) { walk(v[k]); });
      }
    })(DATA);
    expect(found.length).toBeGreaterThan(20);
    found.forEach(function (p) {
      expect(fs.existsSync(path.join(ROOT, p))).toBe(true);
    });
  });
});

describe('render', function () {
  beforeEach(renderPage);

  test('renders all ten kits, ordered per collection', function () {
    expect(document.querySelectorAll('article.lr-kit')).toHaveLength(10);
    var le = lr.groupKitsByCollection(DATA)[0].kits.map(function (k) { return k.short_name; });
    var rq = lr.groupKitsByCollection(DATA)[1].kits.map(function (k) { return k.short_name; });
    expect(shortNames('lr-collection-le26')).toEqual(le);
    expect(shortNames('lr-collection-rq27')).toEqual(rq);
  });

  test('calendar lists the ten kits across six months with links to cards', function () {
    var cells = document.querySelectorAll('#lr-calendar > li');
    expect(cells).toHaveLength(6);
    var links = document.querySelectorAll('#lr-calendar a');
    expect(links).toHaveLength(10);
    for (var i = 0; i < links.length; i++) {
      var target = links[i].getAttribute('href').slice(1);
      expect(document.getElementById(target)).not.toBeNull();
    }
  });

  test('bottle images have alt, dimensions, lazy and async', function () {
    var imgs = document.querySelectorAll('.lr-kit__bottle');
    expect(imgs).toHaveLength(10);
    for (var i = 0; i < imgs.length; i++) {
      expect(imgs[i].getAttribute('alt')).toBeTruthy();
      expect(imgs[i].getAttribute('width')).toBeTruthy();
      expect(imgs[i].getAttribute('height')).toBeTruthy();
      expect(imgs[i].getAttribute('loading')).toBe('lazy');
      expect(imgs[i].getAttribute('decoding')).toBe('async');
    }
    expect(document.querySelector('#lr-kit-80100269 .lr-kit__bottle').getAttribute('width')).toBe('235');
  });

  test('LE26 cards have one scene image, RQ27 cards none and no empty img', function () {
    var cards = document.querySelectorAll('article.lr-kit');
    for (var i = 0; i < cards.length; i++) {
      var k = DATA.kits.filter(function (x) { return 'lr-kit-' + x.sku === cards[i].id; })[0];
      var scenes = cards[i].querySelectorAll('.lr-kit__scene');
      if (k.collection === 'le26') {
        expect(scenes).toHaveLength(1);
      } else {
        expect(scenes).toHaveLength(0);
      }
      var imgs = cards[i].querySelectorAll('img');
      for (var j = 0; j < imgs.length; j++) {
        expect(imgs[j].getAttribute('src')).toBeTruthy();
      }
    }
  });

  test('card shows pairings, region note, price, release chip', function () {
    DATA.kits.forEach(function (k) {
      var card = document.getElementById('lr-kit-' + k.sku);
      expect(card.querySelectorAll('.lr-pairs li')).toHaveLength(k.food_pairings.length);
      expect(card.querySelector('.lr-kit__region-note').textContent).toBe(k.region_note);
      expect(card.querySelector('.lr-price').textContent).toContain('$' + k.price);
      expect(card.querySelector('.lr-chip').textContent).toContain(k.release_label);
      expect(card.querySelector('.lr-kit__grapes').textContent).toBe(k.grapes);
    });
  });

  test('hero images have no overlay, first is eager, logo uses the light variant', function () {
    var heroes = document.querySelectorAll('img.lr-collection__hero');
    expect(heroes).toHaveLength(2);
    for (var i = 0; i < heroes.length; i++) {
      expect(heroes[i].parentNode.children).toHaveLength(1);
    }
    expect(heroes[0].getAttribute('loading')).toBeNull();
    expect(heroes[0].getAttribute('fetchpriority')).toBe('high');
    expect(heroes[1].getAttribute('loading')).toBe('lazy');
    var logos = document.querySelectorAll('img.lr-collection__logo');
    expect(logos[0].getAttribute('src')).toBe(DATA.collections[0].logo.light);
    expect(logos[1].getAttribute('src')).toBe(DATA.collections[1].logo.light);
  });

  test('brochure links download with the file size', function () {
    var links = document.querySelectorAll('a.lr-brochure');
    expect(links).toHaveLength(2);
    expect(links[0].hasAttribute('download')).toBe(true);
    expect(links[0].getAttribute('href')).toBe(DATA.collections[0].brochure_pdf);
    expect(links[0].textContent).toBe('Brochure (PDF, 0.6 MB)');
    expect(links[1].textContent).toBe('Brochure (PDF, 0.7 MB)');
  });

  test('attribution, terms and consent label come from the JSON', function () {
    expect(document.getElementById('lr-attribution').textContent).toBe(DATA.assets.attribution);
    expect(document.querySelectorAll('#lr-terms li')).toHaveLength(DATA.copy.deposit_terms.length);
    expect(document.getElementById('lr-consent-label').textContent).toBe(DATA.copy.deposit_checkbox_label);
  });

  test('injects one JSON-LD graph with ten products', function () {
    var scripts = document.querySelectorAll('script#lr-jsonld');
    expect(scripts).toHaveLength(1);
    var parsed = JSON.parse(scripts[0].textContent);
    expect(parsed['@graph']).toHaveLength(10);
  });

  test('no scarcity text anywhere (D-12)', function () {
    expect(document.body.textContent).not.toMatch(/reserved by|only \d+ left/i);
    // D-12 amended: "Sold out" is allowed only on kits flagged sold_out.
    var clone = document.body.cloneNode(true);
    var marked = clone.querySelectorAll('.lr-kit--sold-out, .lr-calendar__kit--sold-out');
    for (var i = 0; i < marked.length; i++) marked[i].parentNode.removeChild(marked[i]);
    expect(clone.textContent).not.toMatch(/sold out/i);
  });

  test('re-rendering does not duplicate the JSON-LD script', function () {
    lr.render(DATA);
    expect(document.querySelectorAll('script#lr-jsonld')).toHaveLength(1);
    expect(document.querySelectorAll('article.lr-kit')).toHaveLength(10);
  });
});

describe('boot', function () {
  afterEach(function () { delete global.fetch; });

  test('renders from fetched JSON on the limited-releases page', function (done) {
    loadPage();
    document.body.setAttribute('data-page', 'limited-releases');
    global.fetch = jest.fn(function () {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(DATA); } });
    });
    freshModule();
    expect(global.fetch).toHaveBeenCalledWith('content/limited-releases-2026-27.json');
    setTimeout(function () {
      expect(document.querySelectorAll('article.lr-kit')).toHaveLength(10);
      done();
    }, 0);
  });

  test('shows a muted message when the fetch fails', function (done) {
    loadPage();
    document.body.setAttribute('data-page', 'limited-releases');
    global.fetch = jest.fn(function () { return Promise.reject(new Error('offline')); });
    freshModule();
    setTimeout(function () {
      expect(document.getElementById('lr-collections').textContent).toContain(
        'We couldn’t load the kits. Please refresh, or call us at (604) 567-4565.');
      done();
    }, 0);
  });
});

describe('basket and gating', function () {
  var ember = '80100269';
  var red = 'G010409';

  beforeEach(function () {
    jest.useFakeTimers();
    renderPage();
  });
  afterEach(function () { jest.useRealTimers(); });

  test('applyQtyChange clamps at 10 and 0 and is non-mutating', function () {
    var b = {};
    var r = lr.applyQtyChange(b, 'A', 1);
    expect(r.basket.A).toBe(1);
    expect(b.A).toBeUndefined();
    var ten = { A: 10 };
    var blocked = lr.applyQtyChange(ten, 'A', 1);
    expect(blocked.changed).toBe(false);
    expect(blocked.reason).toBe('kit-max');
    expect(lr.applyQtyChange({ A: 0 }, 'A', -1).basket.A).toBe(0);
  });

  test('applyQtyChange refuses an increment past 10 kits in the order', function () {
    var r = lr.applyQtyChange({ A: 6, B: 4 }, 'C', 1);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('order-max');
    expect(r.basket.C).toBeUndefined();
  });

  test('deposit total is 50 per kit', function () {
    expect(lr.computeDepositTotal({ A: 2, B: 1 })).toBe(150);
    expect(lr.computeDepositTotal({})).toBe(0);
  });

  test('isPayEnabled needs a kit and the consent', function () {
    expect(lr.isPayEnabled(0, true)).toBe(false);
    expect(lr.isPayEnabled(1, false)).toBe(false);
    expect(lr.isPayEnabled(1, true)).toBe(true);
  });

  test('initial state: minus disabled, pay disabled, hint visible, empty basket copy', function () {
    expect(minus(ember).disabled).toBe(true);
    expect(document.getElementById('lr-pay').disabled).toBe(true);
    expect(document.getElementById('lr-pay').textContent).toBe('Pay deposit');
    expect(document.getElementById('lr-pay-hint').hidden).toBe(false);
    var basket = document.getElementById('lr-basket');
    expect(basket.querySelector('h3').textContent).toBe('No kits chosen yet');
    expect(basket.textContent).toContain(
      'Use the + buttons on the kits above to choose how many of each you want. Your deposit total will appear here.');
  });

  test('pay stays disabled until consent AND a kit; label follows the total', function () {
    var pay = document.getElementById('lr-pay');
    var consent = document.getElementById('lr-consent');
    consent.checked = true;
    consent.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(pay.disabled).toBe(true);
    click(plus(ember));
    expect(pay.disabled).toBe(false);
    expect(pay.textContent).toBe('Pay $50 deposit');
    expect(document.getElementById('lr-pay-hint').hidden).toBe(true);
    click(plus(red));
    click(plus(red));
    expect(pay.textContent).toBe('Pay $150 deposit');
    consent.checked = false;
    consent.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(pay.disabled).toBe(true);
    expect(document.getElementById('lr-pay-hint').hidden).toBe(false);
  });

  test('selected state, badge and basket rows', function () {
    click(plus(ember));
    click(plus(ember));
    var card = document.getElementById('lr-kit-' + ember);
    expect(card.classList.contains('lr-kit--selected')).toBe(true);
    expect(card.querySelector('.lr-badge').textContent).toBe('2 selected');
    click(plus(red));
    var rows = document.querySelectorAll('#lr-basket .lr-basket__row');
    expect(rows).toHaveLength(2);
    // display order: Connexion Red (le26) is listed before Ember (rq27)
    expect(rows[0].textContent).toContain('Connexion Red × 1');
    expect(rows[1].textContent).toContain('Ember × 2');
    expect(rows[1].textContent).toContain('November 2026');
    expect(document.querySelector('#lr-basket .lr-basket__total').textContent).toContain('Deposit today: $150');
    click(document.querySelector('#lr-basket button[aria-label="Remove Ember"]'));
    expect(card.classList.contains('lr-kit--selected')).toBe(false);
    expect(card.querySelector('.lr-badge')).toBeNull();
    expect(document.querySelectorAll('#lr-basket .lr-basket__row')).toHaveLength(1);
  });

  test('plus disabled at 10 with the max note; 11th kit in the order refused', function () {
    for (var i = 0; i < 10; i++) click(plus(ember));
    expect(plus(ember).disabled).toBe(true);
    var note = document.querySelector('#lr-kit-' + ember + ' .lr-max-note');
    expect(note.hidden).toBe(false);
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe('Maximum 10 per kit. Call us for larger orders: (604) 567-4565');
    click(plus(red));
    expect(document.querySelector('#lr-kit-' + red + ' .lr-qty').textContent).toBe('0');
    var refusal = document.querySelector('#lr-kit-' + red + ' .lr-max-note');
    expect(refusal.textContent).toBe('Up to 10 kits per order. Call us for more: (604) 567-4565');
  });

  test('live region is debounced', function () {
    var live = document.getElementById('lr-live');
    click(plus(ember));
    click(plus(red));
    click(plus(red));
    expect(live.textContent).toBe('');
    jest.advanceTimersByTime(400);
    expect(live.textContent).toBe('3 kits selected. Deposit total $150.');
    click(document.querySelector('#lr-basket button[aria-label="Remove Ember"]'));
    click(document.querySelector('#lr-basket button[aria-label="Remove Connexion Red"]'));
    jest.advanceTimersByTime(400);
    expect(live.textContent).toBe('No kits selected.');
  });

  test('getBasketLines lists non-zero kits in display order with item ids', function () {
    click(plus(ember));
    click(plus(red));
    click(plus(red));
    expect(lr.getBasketLines()).toEqual([
      { item_id: kit('Connexion Red').zoho_item_id, qty: 2 },
      { item_id: kit('Ember').zoho_item_id, qty: 1 }
    ]);
    lr.clearBasket();
    expect(lr.getBasketLines()).toEqual([]);
  });

  test('setControlsLocked disables steppers, remove buttons and fields', function () {
    click(plus(ember));
    lr.setControlsLocked(true);
    expect(plus(red).disabled).toBe(true);
    expect(minus(ember).disabled).toBe(true);
    expect(document.querySelector('#lr-basket button').disabled).toBe(true);
    expect(document.getElementById('lr-name').disabled).toBe(true);
    expect(document.getElementById('lr-consent').disabled).toBe(true);
    expect(document.getElementById('lr-bar').classList.contains('hidden')).toBe(true);
    click(plus(red));
    expect(lr.getBasketLines()).toHaveLength(1);
    lr.setControlsLocked(false);
    expect(plus(red).disabled).toBe(false);
    expect(document.getElementById('lr-name').disabled).toBe(false);
  });
});

describe('sticky bar', function () {
  var ember = '80100269';
  var red = 'G010409';
  var ioCallback;

  beforeEach(function () {
    jest.useFakeTimers();
    ioCallback = null;
    global.IntersectionObserver = function (cb) {
      ioCallback = cb;
      this.observe = function () {};
    };
    renderPage();
  });
  afterEach(function () {
    jest.useRealTimers();
    delete global.IntersectionObserver;
  });

  test('hidden at zero, shown with text and aria-label at 1 and 3 kits', function () {
    var bar = document.getElementById('lr-bar');
    expect(bar.classList.contains('hidden')).toBe(true);
    click(plus(ember));
    expect(bar.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('lr-bar-text').textContent).toBe('1 kit · $50 deposit');
    click(plus(red));
    click(plus(red));
    expect(document.getElementById('lr-bar-text').textContent).toBe('3 kits · $150 deposit');
    expect(document.getElementById('lr-bar-btn').getAttribute('aria-label')).toBe('Reserve 3 kits, $150 deposit');
  });

  test('hides while the reservation panel is in view', function () {
    click(plus(ember));
    var bar = document.getElementById('lr-bar');
    ioCallback([{ isIntersecting: true }]);
    expect(bar.classList.contains('hidden')).toBe(true);
    ioCallback([{ isIntersecting: false }]);
    expect(bar.classList.contains('hidden')).toBe(false);
  });

  test('Reserve scrolls to the form and focuses its heading', function () {
    click(plus(ember));
    var reserve = document.getElementById('lr-reserve');
    reserve.scrollIntoView = jest.fn();
    click(document.getElementById('lr-bar-btn'));
    expect(reserve.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(document.getElementById('lr-reserve-heading'));
  });

  test('switches to static while the cookie notice is open', function (done) {
    jest.useRealTimers();
    click(plus(ember));
    var bar = document.getElementById('lr-bar');
    document.documentElement.classList.add('cookie-notice-open');
    setTimeout(function () {
      expect(bar.classList.contains('lr-bar--static')).toBe(true);
      document.documentElement.classList.remove('cookie-notice-open');
      setTimeout(function () {
        expect(bar.classList.contains('lr-bar--static')).toBe(false);
        done();
      }, 20);
    }, 20);
  });

  test('always shown at one kit or more when IntersectionObserver is absent', function () {
    delete global.IntersectionObserver;
    renderPage();
    click(plus(ember));
    expect(document.getElementById('lr-bar').classList.contains('hidden')).toBe(false);
  });
});

describe('module source', function () {
  test('is ES5 (no arrow functions, template strings, let or const)', function () {
    var src = fs.readFileSync(path.join(ROOT, 'js', 'modules', '18-limited-releases.js'), 'utf8');
    expect(src).not.toMatch(/=>/);
    expect(src).not.toMatch(/`/);
    expect(src).not.toMatch(/^\s*(let|const)\s/m);
    expect(src).not.toMatch(/innerHTML/);
  });
});
