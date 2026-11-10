// ===== Limited Releases Page Module =====
// Standalone module (NOT in concat:js). Phase 100 limited-releases page.
// Renders the kits, calendar, terms and JSON-LD from
// content/limited-releases-2026-27.json and drives the stepper, basket,
// sticky bar and pay-button gating. The payment flow is added separately.
// ES5 only. All content strings are written with textContent (no HTML parsing of content).

var LR_CONTENT_URL = 'content/limited-releases-2026-27.json';
var LR_SITE_URL = 'https://steinsandvines.ca/';
var LR_MAX_PER_KIT = 10;
var LR_MAX_PER_ORDER = 10;
var LR_PHONE = '(604) 567-4565';
var LR_MSG_ORDER_MAX = 'Up to 10 kits per order. Call us for more: ' + LR_PHONE;
var LR_MSG_KIT_MAX = 'Maximum 10 per kit. Call us for larger orders: ' + LR_PHONE;
var LR_BROCHURE_LABELS = { le26: 'Brochure (PDF, 0.6 MB)', rq27: 'Brochure (PDF, 0.7 MB)' };
var LR_RQ27_BOTTLES = { ember: [235, 900], aria: [240, 900], acqua: [234, 900], terre: [238, 900], sol: [239, 900] };
var LR_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

var _lrData = null;
var _lrKits = [];          // kits in display order (collection order, then release)
var _lrQty = {};           // sku -> qty
var _lrLocked = false;
var _lrReserveVisible = false;
var _lrCookieOpen = false;
var _lrLiveTimer = null;
var _lrHandlersBound = false;

// ---------------------------------------------------------------------------
// Pure functions (exported for tests)
// ---------------------------------------------------------------------------

function lrFindCollection(data, id) {
  var list = (data && data.collections) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/**
 * Collections in JSON order, each with its kits in ascending release order.
 * @returns {Array} [{collection, kits}]
 */
function groupKitsByCollection(data) {
  var kits = (data && data.kits) || [];
  return ((data && data.collections) || []).map(function (collection) {
    var mine = [];
    for (var i = 0; i < kits.length; i++) {
      if (kits[i].collection === collection.id) mine.push({ kit: kits[i], idx: i });
    }
    mine.sort(function (a, b) {
      if (a.kit.release < b.kit.release) return -1;
      if (a.kit.release > b.kit.release) return 1;
      return a.idx - b.idx;
    });
    return { collection: collection, kits: mine.map(function (m) { return m.kit; }) };
  });
}

function lrMonthLabel(release) {
  var parts = String(release).split('-');
  var m = parseInt(parts[1], 10);
  return (LR_MONTHS[m - 1] || '') + ' ' + parts[0];
}

function lrSupplierTag(collection) {
  var name = (collection && collection.supplier) || '';
  return name.split(' ')[0];
}

/**
 * Chronological release calendar built from the kits' release field.
 * Within a month, kits keep collection order (JSON order of collections).
 * @returns {Array} [{month, label, kits:[{sku, short_name, supplier, collection}]}]
 */
function buildCalendar(data) {
  var byMonth = {};
  var months = [];
  var groups = groupKitsByCollection(data);
  groups.forEach(function (g) {
    g.kits.forEach(function (kit) {
      if (!byMonth[kit.release]) {
        byMonth[kit.release] = [];
        months.push(kit.release);
      }
      byMonth[kit.release].push({
        sku: kit.sku,
        short_name: kit.short_name,
        supplier: lrSupplierTag(g.collection),
        collection: kit.collection,
        sold_out: kit.sold_out === true
      });
    });
  });
  months.sort();
  return months.map(function (m) {
    return { month: m, label: lrMonthLabel(m), kits: byMonth[m] };
  });
}

function computeDepositTotal(basket, perKit) {
  var per = typeof perKit === 'number' ? perKit : 50;
  var n = 0;
  for (var k in basket) {
    if (Object.prototype.hasOwnProperty.call(basket, k)) n += basket[k] || 0;
  }
  return n * per;
}

function lrTotalKits(basket) {
  var n = 0;
  for (var k in basket) {
    if (Object.prototype.hasOwnProperty.call(basket, k)) n += basket[k] || 0;
  }
  return n;
}

function isPayEnabled(totalKits, consentTicked) {
  return totalKits >= 1 && !!consentTicked;
}

/**
 * Applies a quantity change without mutating the input.
 * @returns {{basket:Object, changed:boolean, reason:string}} reason is one of
 *   '', 'kit-max', 'order-max', 'min', 'sold-out'
 */
function applyQtyChange(basket, sku, delta) {
  var next = {};
  for (var k in basket) {
    if (Object.prototype.hasOwnProperty.call(basket, k)) next[k] = basket[k];
  }
  var cur = next[sku] || 0;
  var target = cur + delta;
  var reason = '';
  if (delta > 0) {
    // Sold-out kits can only be removed, never added.
    var soldKit = lrKitBySku(sku);
    if (soldKit && soldKit.sold_out) {
      return { basket: next, changed: false, reason: 'sold-out' };
    }
    if (cur >= LR_MAX_PER_KIT) {
      return { basket: next, changed: false, reason: 'kit-max' };
    }
    if (lrTotalKits(next) + delta > LR_MAX_PER_ORDER) {
      return { basket: next, changed: false, reason: 'order-max' };
    }
  }
  if (target < 0) {
    target = 0;
    reason = 'min';
  }
  if (target > LR_MAX_PER_KIT) target = LR_MAX_PER_KIT;
  next[sku] = target;
  return { basket: next, changed: target !== cur, reason: reason };
}

/** Spec chips for a kit. Weeks is shown only when non-null (D-08). */
function formatSpecs(kit) {
  var out = [];
  if (kit.colour) out.push(kit.colour);
  if (kit.sweetness) out.push(kit.sweetness);
  if (kit.body) out.push(kit.body + ' body');
  if (kit.oak) out.push('Oak: ' + kit.oak);
  if (kit.abv !== null && kit.abv !== undefined) out.push(kit.abv + '% ABV');
  if (kit.weeks !== null && kit.weeks !== undefined) out.push(kit.weeks + ' weeks');
  return out;
}

function lrFormatMoney(n) {
  return n % 1 === 0 ? '$' + n : '$' + n.toFixed(2);
}

function lrKitsLabel(n) {
  return n + (n === 1 ? ' kit' : ' kits');
}

function lrPayLabel(totalKits) {
  return totalKits >= 1 ? 'Pay ' + lrFormatMoney(totalKits * 50) + ' deposit' : 'Pay deposit';
}

function lrBarText(totalKits) {
  return lrKitsLabel(totalKits) + ' · ' + lrFormatMoney(totalKits * 50) + ' deposit';
}

function lrLiveText(totalKits) {
  if (totalKits < 1) return 'No kits selected.';
  return lrKitsLabel(totalKits) + ' selected. Deposit total ' + lrFormatMoney(totalKits * 50) + '.';
}

/** [width, height] for a content image, looked up by file name; null if unknown. */
function lrImageDims(path) {
  var f = String(path || '').split('/').pop();
  var m;
  if (/^le26-hero/.test(f)) return [1920, 1080];
  if (/^rq27-hero/.test(f)) return [1920, 1233];
  if (/^le26-group/.test(f)) return [1400, 1124];
  if (/^rq27-group/.test(f)) return [1100, 1375];
  if (/^le26-logo/.test(f)) return [700, 302];
  if (/^rq27-logo/.test(f)) return [700, 441];
  if (/^le26-.*-scene/.test(f)) return [1200, 857];
  if (/^le26-.*-bottle/.test(f)) return [455, 900];
  m = /^rq27-([a-z]+)-bottle/.exec(f);
  if (m && LR_RQ27_BOTTLES[m[1]]) return LR_RQ27_BOTTLES[m[1]];
  return null;
}

function buildJsonLd(data) {
  var graph = [];
  groupKitsByCollection(data).forEach(function (g) {
    g.kits.forEach(function (kit) {
      graph.push({
        '@type': 'Product',
        name: kit.short_name + ' (' + g.collection.name + ')',
        description: kit.notes,
        sku: kit.sku,
        image: [LR_SITE_URL + kit.image],
        brand: { '@type': 'Brand', name: g.collection.supplier },
        offers: {
          '@type': 'Offer',
          priceCurrency: 'CAD',
          price: kit.price,
          availability: kit.sold_out ? 'https://schema.org/SoldOut' : 'https://schema.org/PreOrder',
          availabilityStarts: kit.release + '-01',
          url: LR_SITE_URL + 'limited-releases#lr-kit-' + kit.sku,
          seller: { '@type': 'Organization', name: 'Steins & Vines' }
        }
      });
    });
  });
  return { '@context': 'https://schema.org', '@graph': graph };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function lrEl(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function lrById(id) {
  return document.getElementById(id);
}

function lrClear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function lrImg(src, alt, cls, opts) {
  var img = document.createElement('img');
  img.className = cls;
  img.src = src;
  img.alt = alt;
  var d = lrImageDims(src);
  if (d) {
    img.setAttribute('width', String(d[0]));
    img.setAttribute('height', String(d[1]));
  }
  if (opts && opts.eager) {
    img.setAttribute('fetchpriority', 'high');
  } else {
    img.setAttribute('loading', 'lazy');
  }
  img.setAttribute('decoding', 'async');
  return img;
}

function lrKitBySku(sku) {
  for (var i = 0; i < _lrKits.length; i++) {
    if (_lrKits[i].sku === sku) return _lrKits[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function lrBuildStepper(kit) {
  var group = lrEl('div', 'lr-stepper');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Quantity for ' + kit.short_name);
  var minus = lrEl('button', 'lr-stepper__btn', '−');
  minus.type = 'button';
  minus.setAttribute('data-action', 'remove');
  minus.setAttribute('data-sku', kit.sku);
  minus.setAttribute('aria-label', 'Remove one ' + kit.short_name);
  minus.disabled = true;
  var out = lrEl('output', 'lr-qty', '0');
  out.setAttribute('aria-live', 'off');
  var plus = lrEl('button', 'lr-stepper__btn', '+');
  plus.type = 'button';
  plus.setAttribute('data-action', 'add');
  plus.setAttribute('data-sku', kit.sku);
  plus.setAttribute('aria-label', 'Add one ' + kit.short_name);
  group.appendChild(minus);
  group.appendChild(out);
  group.appendChild(plus);
  return group;
}

function lrBuildKitCard(kit) {
  var card = lrEl('article', 'lr-kit' + (kit.sold_out ? ' lr-kit--sold-out' : ''));
  card.id = 'lr-kit-' + kit.sku;
  var nameId = 'lr-kit-name-' + kit.sku;
  card.setAttribute('aria-labelledby', nameId);

  if (kit.scene_image) {
    card.appendChild(lrImg(kit.scene_image, '', 'lr-kit__scene'));
  }
  var media = lrEl('div', 'lr-kit__media');
  media.appendChild(lrImg(kit.image, kit.image_alt, 'lr-kit__bottle'));
  if (kit.sold_out) media.appendChild(lrEl('span', 'lr-soldout-badge', 'Sold out'));
  card.appendChild(media);

  card.appendChild(lrEl('span', 'lr-chip', 'Releases ' + kit.release_label));
  var h3 = lrEl('h3', 'lr-kit__name', kit.short_name);
  h3.id = nameId;
  card.appendChild(h3);
  card.appendChild(lrEl('p', 'lr-kit__grapes', kit.grapes));
  card.appendChild(lrEl('p', 'lr-kit__region', kit.region));
  if (kit.region_note) card.appendChild(lrEl('p', 'lr-kit__region-note', kit.region_note));

  var specs = lrEl('ul', 'lr-specs');
  formatSpecs(kit).forEach(function (s) { specs.appendChild(lrEl('li', '', s)); });
  card.appendChild(specs);

  card.appendChild(lrEl('p', 'lr-kit__notes', kit.notes));

  // Always shown (owner request): a plain heading + list, no disclosure toggle.
  var pairs = lrEl('div', 'lr-pairs');
  pairs.appendChild(lrEl('p', 'lr-pairs__title', 'Pairs with'));
  var pl = lrEl('ul');
  (kit.food_pairings || []).forEach(function (p) { pl.appendChild(lrEl('li', '', p)); });
  pairs.appendChild(pl);
  card.appendChild(pairs);

  var footer = lrEl('div', 'lr-kit__footer');
  var price = lrEl('span', 'lr-price', 'Kit price ');
  price.appendChild(lrEl('strong', '', lrFormatMoney(kit.price)));
  footer.appendChild(price);
  footer.appendChild(kit.sold_out ? lrEl('span', 'lr-soldout', 'Sold out') : lrBuildStepper(kit));
  card.appendChild(footer);

  var note = lrEl('p', 'lr-max-note');
  note.setAttribute('role', 'status');
  note.hidden = true;
  card.appendChild(note);
  return card;
}

function lrBuildCollection(group, index) {
  var c = group.collection;
  var section = lrEl('section', 'lr-collection');
  section.id = 'lr-collection-' + c.id;
  var h2Id = 'lr-collection-name-' + c.id;
  section.setAttribute('aria-labelledby', h2Id);

  var header = lrEl('div', 'lr-collection__header');
  if (c.logo && c.logo.light) {
    header.appendChild(lrImg(c.logo.light, c.name, 'lr-collection__logo'));
  }
  var text = lrEl('div');
  var h2 = lrEl('h2', '', c.name);
  h2.id = h2Id;
  text.appendChild(h2);
  text.appendChild(lrEl('p', 'lr-collection__theme', c.theme));
  text.appendChild(lrEl('p', 'lr-collection__blurb', c.blurb));
  header.appendChild(text);
  section.appendChild(header);

  var frame = lrEl('div', 'lr-collection__hero-frame');
  frame.appendChild(lrImg(c.hero_image, c.hero_image_alt, 'lr-collection__hero', { eager: index === 0 }));
  section.appendChild(frame);

  var link = lrEl('a', 'btn-secondary lr-brochure', LR_BROCHURE_LABELS[c.id] || 'Brochure (PDF)');
  link.href = c.brochure_pdf;
  link.setAttribute('download', '');
  section.appendChild(link);

  var grid = lrEl('div', 'lr-grid');
  group.kits.forEach(function (kit) { grid.appendChild(lrBuildKitCard(kit)); });
  section.appendChild(grid);
  return section;
}

function lrBuildCalendar(data) {
  var ol = lrById('lr-calendar');
  if (!ol) return;
  lrClear(ol);
  var now = new Date();
  var current = now.getFullYear() + '-' + (now.getMonth() < 9 ? '0' : '') + (now.getMonth() + 1);
  buildCalendar(data).forEach(function (cell) {
    var li = lrEl('li', 'lr-calendar__month' + (cell.month === current ? ' lr-calendar__month--active' : ''));
    // Wall-calendar page header: short month large, year below. The label's
    // text stays "Mon YYYY" (abbr carries the full month name).
    var label = lrEl('strong', 'lr-calendar__label');
    var parts = String(cell.label).split(' ');
    var mon = lrEl('abbr', 'lr-calendar__mon', parts[0].slice(0, 3));
    mon.setAttribute('title', parts[0]);
    label.appendChild(mon);
    label.appendChild(document.createTextNode(' '));
    label.appendChild(lrEl('span', 'lr-calendar__year', parts[1] || ''));
    li.appendChild(label);
    var kits = lrEl('ul', 'lr-calendar__kits');
    cell.kits.forEach(function (k) {
      var entry = lrEl('li', 'lr-calendar__kit lr-calendar__kit--' + (k.supplier === 'RJS' ? 'rjs' : 'we') +
        (k.sold_out ? ' lr-calendar__kit--sold-out' : ''));
      // The supplier tag sits inside the link so the whole 44px row is the tap target.
      var a = lrEl('a', '');
      a.href = '#lr-kit-' + k.sku;
      a.appendChild(lrEl('span', 'lr-calendar__name', k.short_name));
      a.appendChild(document.createTextNode(' '));
      a.appendChild(lrEl('span', 'lr-calendar__tag', k.supplier));
      if (k.sold_out) {
        a.appendChild(document.createTextNode(' '));
        a.appendChild(lrEl('span', 'lr-calendar__soldout', 'Sold out'));
      }
      entry.appendChild(a);
      kits.appendChild(entry);
    });
    li.appendChild(kits);
    ol.appendChild(li);
  });
}

function lrInjectJsonLd(data) {
  var old = lrById('lr-jsonld');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var s = document.createElement('script');
  s.type = 'application/ld+json';
  s.id = 'lr-jsonld';
  s.textContent = JSON.stringify(buildJsonLd(data)).replace(/</g, '\\u003c');
  document.head.appendChild(s);
}

function lrRender(data) {
  _lrData = data;
  _lrQty = {};
  _lrKits = [];
  var groups = groupKitsByCollection(data);
  groups.forEach(function (g) {
    g.kits.forEach(function (k) { _lrKits.push(k); _lrQty[k.sku] = 0; });
  });
  var copy = data.copy || {};

  var heroSub = lrById('lr-hero-sub');
  if (heroSub && copy.hero_sub) heroSub.textContent = copy.hero_sub;

  var steps = lrById('lr-how-steps');
  if (steps) {
    lrClear(steps);
    (copy.how_it_works || []).forEach(function (s, i) {
      var li = lrEl('li', 'how-it-works-step');
      var num = lrEl('div', 'how-it-works-step-number', String(i + 1));
      num.setAttribute('aria-hidden', 'true');
      li.appendChild(num);
      li.appendChild(lrEl('h3', 'how-it-works-step-title', s.step));
      li.appendChild(lrEl('p', 'how-it-works-step-desc', s.text));
      steps.appendChild(li);
    });
  }

  lrBuildCalendar(data);

  var host = lrById('lr-collections');
  if (host) {
    lrClear(host);
    groups.forEach(function (g, i) { host.appendChild(lrBuildCollection(g, i)); });
  }

  var terms = lrById('lr-terms');
  if (terms) {
    lrClear(terms);
    (copy.deposit_terms || []).forEach(function (t) { terms.appendChild(lrEl('li', '', t)); });
  }
  var priceNote = lrById('lr-price-note');
  if (priceNote && copy.price_note) priceNote.textContent = copy.price_note;
  var consentLabel = lrById('lr-consent-label');
  if (consentLabel && copy.deposit_checkbox_label) consentLabel.textContent = copy.deposit_checkbox_label;
  var attr = lrById('lr-attribution');
  if (attr && data.assets && data.assets.attribution) attr.textContent = data.assets.attribution;

  lrInjectJsonLd(data);
  lrBindHandlers();
  lrUpdateAll(true);
}

// ---------------------------------------------------------------------------
// Basket, stepper, pay gating, sticky bar
// ---------------------------------------------------------------------------

function lrTotal() {
  return lrTotalKits(_lrQty);
}

function lrSyncCard(sku, message) {
  var card = lrById('lr-kit-' + sku);
  if (!card) return;
  var qty = _lrQty[sku] || 0;
  var out = card.querySelector('.lr-qty');
  if (out) out.textContent = String(qty);
  var minus = card.querySelector('.lr-stepper__btn[data-action="remove"]');
  var plus = card.querySelector('.lr-stepper__btn[data-action="add"]');
  if (minus) minus.disabled = _lrLocked || qty <= 0;
  if (plus) plus.disabled = _lrLocked || qty >= LR_MAX_PER_KIT;
  if (qty >= 1) card.classList.add('lr-kit--selected');
  else card.classList.remove('lr-kit--selected');

  var badge = card.querySelector('.lr-badge');
  if (qty >= 1) {
    if (!badge) {
      badge = lrEl('span', 'lr-badge');
      var media = card.querySelector('.lr-kit__media');
      if (media) media.appendChild(badge);
    }
    badge.textContent = qty + ' selected';
  } else if (badge && badge.parentNode) {
    badge.parentNode.removeChild(badge);
  }

  var note = card.querySelector('.lr-max-note');
  if (note) {
    var text = message || (qty >= LR_MAX_PER_KIT ? LR_MSG_KIT_MAX : '');
    note.textContent = text;
    note.hidden = !text;
  }
}

function lrRenderBasket() {
  var box = lrById('lr-basket');
  if (!box) return;
  lrClear(box);
  var total = lrTotal();
  if (total < 1) {
    box.appendChild(lrEl('h3', 'lr-basket__empty-heading', 'No kits chosen yet'));
    box.appendChild(lrEl('p', 'lr-basket__empty',
      'Use the + buttons on the kits above to choose how many of each you want. Your deposit total will appear here.'));
    return;
  }
  var list = lrEl('ul', 'lr-basket__list');
  list.style.listStyle = 'none';
  list.style.padding = '0';
  _lrKits.forEach(function (kit) {
    var qty = _lrQty[kit.sku] || 0;
    if (qty < 1) return;
    var row = lrEl('li', 'lr-basket__row');
    row.appendChild(lrEl('span', '', kit.short_name + ' × ' + qty));
    row.appendChild(lrEl('span', 'lr-basket__release', kit.release_label));
    var rm = lrEl('button', 'btn-secondary lr-basket__remove', 'Remove');
    rm.type = 'button';
    rm.setAttribute('data-action', 'clear');
    rm.setAttribute('data-sku', kit.sku);
    rm.setAttribute('aria-label', 'Remove ' + kit.short_name);
    rm.disabled = _lrLocked;
    row.appendChild(rm);
    list.appendChild(row);
  });
  box.appendChild(list);
  var totalRow = lrEl('div', 'lr-basket__total');
  totalRow.appendChild(lrEl('span', '', lrKitsLabel(total)));
  var dep = lrEl('span', '', 'Deposit today: ');
  dep.appendChild(lrEl('strong', '', lrFormatMoney(total * 50)));
  totalRow.appendChild(dep);
  box.appendChild(totalRow);
}

function lrUpdatePay() {
  // During a payment the state machine owns the button label and disabled flag.
  if (_lrPayState !== 'ready') return;
  var btn = lrById('lr-pay');
  var consent = lrById('lr-consent');
  var hint = lrById('lr-pay-hint');
  var total = lrTotal();
  var enabled = isPayEnabled(total, consent && consent.checked);
  if (btn) {
    btn.disabled = !enabled;
    btn.textContent = lrPayLabel(total);
  }
  if (hint) hint.hidden = enabled;
}

function lrUpdateBar() {
  var bar = lrById('lr-bar');
  if (!bar) return;
  var total = lrTotal();
  var show = total >= 1 && !_lrLocked && !_lrReserveVisible;
  if (!show) {
    bar.classList.add('hidden');
    lrPadBody('');
    return;
  }
  var text = lrById('lr-bar-text');
  if (text) text.textContent = lrBarText(total);
  var btn = lrById('lr-bar-btn');
  if (btn) {
    btn.setAttribute('aria-label', 'Reserve ' + lrKitsLabel(total) + ', ' +
      lrFormatMoney(total * 50) + ' deposit');
  }
  bar.classList.remove('hidden');
  if (_lrCookieOpen) bar.classList.add('lr-bar--static');
  else bar.classList.remove('lr-bar--static');
  var h = bar.offsetHeight || 0;
  // While the cookie notice is open, styles.css pads body for the notice instead.
  lrPadBody((_lrCookieOpen || !h) ? '' : h + 'px');
}

/**
 * Pads the end of the page by the bar height so the fixed bar never covers
 * the footer (policy links, cookie settings). Padding goes on body, below the
 * footer; padding a section inside <main> left the footer under the bar.
 */
function lrPadBody(value) {
  var st = document.body && document.body.style;
  if (!st) return;
  // removeProperty, not = '': jsdom's padding longhand ignores the empty string.
  if (value) st.paddingBottom = value;
  else if (st.removeProperty) st.removeProperty('padding-bottom');
}

function lrScheduleLive() {
  if (_lrLiveTimer) clearTimeout(_lrLiveTimer);
  _lrLiveTimer = setTimeout(function () {
    _lrLiveTimer = null;
    var live = lrById('lr-live');
    if (live) live.textContent = lrLiveText(lrTotal());
  }, 400);
}

function lrUpdateAll(skipLive) {
  _lrKits.forEach(function (k) { lrSyncCard(k.sku); });
  lrRenderBasket();
  lrUpdatePay();
  lrUpdateBar();
  if (!skipLive) lrScheduleLive();
}

function lrChange(sku, delta) {
  var res = applyQtyChange(_lrQty, sku, delta);
  _lrQty = res.basket;
  var msg = '';
  if (res.reason === 'order-max') msg = LR_MSG_ORDER_MAX;
  // Refresh every card so a stale refusal message on another card is cleared.
  _lrKits.forEach(function (k) { lrSyncCard(k.sku, k.sku === sku ? msg : ''); });
  lrRenderBasket();
  lrUpdatePay();
  lrUpdateBar();
  lrScheduleLive();
}

function lrSetQty(sku, qty) {
  lrChange(sku, qty - (_lrQty[sku] || 0));
}

function getBasketLines() {
  var lines = [];
  _lrKits.forEach(function (k) {
    var q = _lrQty[k.sku] || 0;
    if (q > 0 && !k.sold_out) lines.push({ item_id: k.zoho_item_id, qty: q });
  });
  return lines;
}

function setControlsLocked(locked) {
  _lrLocked = !!locked;
  var form = lrById('lr-form');
  if (form) {
    var inputs = form.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = _lrLocked;
  }
  lrUpdateAll(true);
  var rm = document.querySelectorAll('#lr-basket button');
  for (var j = 0; j < rm.length; j++) rm[j].disabled = _lrLocked;
}

function clearBasket() {
  for (var k in _lrQty) {
    if (Object.prototype.hasOwnProperty.call(_lrQty, k)) _lrQty[k] = 0;
  }
  lrUpdateAll();
}

function lrBindHandlers() {
  if (_lrHandlersBound) return;
  _lrHandlersBound = true;

  var host = lrById('lr-collections');
  if (host) {
    host.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== host && !(t.getAttribute && t.getAttribute('data-action'))) t = t.parentNode;
      if (!t || t === host || !t.classList || !t.classList.contains('lr-stepper__btn')) return;
      if (t.disabled || _lrLocked) return;
      lrChange(t.getAttribute('data-sku'), t.getAttribute('data-action') === 'add' ? 1 : -1);
    });
  }

  var basket = lrById('lr-basket');
  if (basket) {
    basket.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== basket && !(t.getAttribute && t.getAttribute('data-action') === 'clear')) t = t.parentNode;
      if (!t || t === basket || t.disabled || _lrLocked) return;
      lrSetQty(t.getAttribute('data-sku'), 0);
    });
  }

  var consent = lrById('lr-consent');
  if (consent) consent.addEventListener('change', lrUpdatePay);

  var payBtn = lrById('lr-pay');
  if (payBtn) payBtn.addEventListener('click', submitPayment);
  var payForm = lrById('lr-form');
  if (payForm) payForm.addEventListener('submit', function (e) { e.preventDefault(); });
  if (typeof window !== 'undefined') window.addEventListener('message', handleHelcimMessage);

  var barBtn = lrById('lr-bar-btn');
  if (barBtn) {
    barBtn.addEventListener('click', function () {
      var reserve = lrById('lr-reserve');
      var reduced = typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reserve && typeof reserve.scrollIntoView === 'function') {
        reserve.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      }
      var heading = lrById('lr-reserve-heading');
      if (heading) {
        try { heading.focus({ preventScroll: true }); } catch (err) { heading.focus(); }
      }
    });
  }

  var reserveEl = lrById('lr-reserve');
  if (reserveEl && typeof IntersectionObserver === 'function') {
    var io = new IntersectionObserver(function (entries) {
      if (entries && entries.length) {
        _lrReserveVisible = !!entries[entries.length - 1].isIntersecting;
        lrUpdateBar();
      }
    });
    io.observe(reserveEl);
  }

  if (typeof MutationObserver === 'function') {
    var root = document.documentElement;
    var sync = function () {
      _lrCookieOpen = root.classList.contains('cookie-notice-open');
      lrUpdateBar();
    };
    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
    _lrCookieOpen = root.classList.contains('cookie-notice-open');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function lrShowLoadError() {
  var host = lrById('lr-collections');
  if (!host) return;
  lrClear(host);
  var p = lrEl('p', 'lr-load-error',
    'We couldn’t load the kits. Please refresh, or call us at ' + LR_PHONE + '.');
  p.style.color = 'var(--color-muted)';
  host.appendChild(p);
}

function lrBoot() {
  if (!document.body || !document.body.dataset || document.body.dataset.page !== 'limited-releases') return;
  if (typeof fetch !== 'function') { lrShowLoadError(); return; }
  fetch(LR_CONTENT_URL).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (data) {
    lrRender(data);
  }).catch(function () {
    lrShowLoadError();
  });
}

// ---------------------------------------------------------------------------
// Payment flow (Plan 100-12): validate -> reCAPTCHA -> initialize -> HelcimPay
// iframe -> deposit. The server is the authority; the client keeps the
// transaction id alive and never claims "not charged" without proof.
// ---------------------------------------------------------------------------

var LR_HELCIM_ORIGINS = ['https://secure.helcim.app', 'https://myhelcim.com'];
var LR_DEPOSIT_TIMEOUT_MS = 60000;
var LR_MSG_CANCELLED = 'Payment cancelled. You have not been charged.';
var LR_MSG_DECLINED = 'Your card was declined. You have not been charged. Please try a different card or contact your bank.';
var LR_MSG_UNREACHABLE = 'We could not reach the payment service. You have not been charged. Please try again.';
var LR_MSG_NOT_OPEN = 'Reservations are not open yet. Please check back soon.';
var LR_MSG_VERIFY = 'We could not verify your request. Please try again.';
var LR_MSG_VOIDED = 'We could not complete your reservation, and your card has not been charged. Please try again, or call us at ' + LR_PHONE + '.';
var LR_MSG_UNKNOWN = 'Your payment went through but we could not confirm your reservation here. Please do not pay again. Call us at ' + LR_PHONE + ' or email us and we will sort it out.';

var _lrPayState = 'ready';   // ready | starting | iframe | verifying | unknown | success
var _lrSubmitting = false;
var _lrCheckoutToken = null;
var _lrSecretToken = null;
var _lrInvoice = '';
var _lrTxnId = '';
var _lrItems = null;
var _lrUnloadOn = false;

function lrBeforeUnload(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (e) e.returnValue = '';
  return '';
}

function lrSetUnload(on) {
  if (typeof window === 'undefined') return;
  if (on && !_lrUnloadOn) {
    window.addEventListener('beforeunload', lrBeforeUnload);
    _lrUnloadOn = true;
  } else if (!on && _lrUnloadOn) {
    window.removeEventListener('beforeunload', lrBeforeUnload);
    _lrUnloadOn = false;
  }
}

function lrMiddlewareUrl() {
  return (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG && SHEETS_CONFIG.MIDDLEWARE_URL) || '';
}

function lrGetRecaptchaToken(action) {
  return new Promise(function (resolve) {
    var key = (typeof window !== 'undefined' && window.RECAPTCHA_SITE_KEY) ||
      (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG && SHEETS_CONFIG.RECAPTCHA_SITE_KEY) || '';
    if (typeof grecaptcha === 'undefined' || !key) { resolve(''); return; }
    grecaptcha.ready(function () {
      grecaptcha.execute(key, { action: action }).then(resolve, function () { resolve(''); });
    });
  });
}

/** POST JSON. Resolves {status, body} (body null when not JSON); rejects on network error or timeout. */
function lrPost(path, payload, timeoutMs) {
  var opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
  var timer = null;
  if (timeoutMs && typeof AbortController === 'function') {
    var ctl = new AbortController();
    opts.signal = ctl.signal;
    timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
  }
  return fetch(lrMiddlewareUrl() + path, opts).then(function (r) {
    return r.text().then(function (t) {
      if (timer) clearTimeout(timer);
      var body = null;
      try { body = JSON.parse(t); } catch (e) { body = null; }
      return { status: r.status, body: body };
    });
  }, function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function lrExtractTransactionId(data) {
  var em = data && data.eventMessage;
  if (typeof em === 'string') { try { em = JSON.parse(em); } catch (e) { return ''; } }
  var inner = em && em.data && em.data.data;
  if (inner && inner.transactionId) return String(inner.transactionId);
  var flat = em && em.data;
  return (flat && flat.transactionId) ? String(flat.transactionId) : '';
}

function lrIsDecline(data) {
  var em = data && data.eventMessage;
  if (!em) return false;
  var text = typeof em === 'string' ? em : JSON.stringify(em);
  return /declin/i.test(text);
}

function lrSetAlert(text, reference) {
  var alertEl = lrById('lr-pay-alert');
  if (!alertEl) return;
  lrClear(alertEl);
  if (text) alertEl.appendChild(document.createTextNode(text));
  if (reference) alertEl.appendChild(lrEl('p', 'lr-pay-reference', 'Reference: ' + reference));
}

function lrSetStatus(text) {
  var s = lrById('lr-pay-status');
  if (s) s.textContent = text || '';
}

/**
 * Locks page scroll while HelcimPay's full-screen iframe is open so a swipe
 * on a phone cannot scroll the page behind the payment sheet.
 */
function lrLockScroll(lock) {
  var st = document.documentElement && document.documentElement.style;
  if (!st) return;
  if (lock) st.overflow = 'hidden';
  else if (st.removeProperty) st.removeProperty('overflow');
}

function lrRemoveCloseButton() {
  var c = lrById('lr-close-pay');
  if (c && c.parentNode) c.parentNode.removeChild(c);
}

/**
 * Moves the form panel to a payment state and updates button, status,
 * alert, lock, sticky bar and beforeunload accordingly.
 * @param {string} state ready | starting | iframe | verifying | unknown
 * @param {Object} [o] {status, alert, reference}
 */
function lrSetPaymentState(state, o) {
  o = o || {};
  _lrPayState = state;
  var btn = lrById('lr-pay');
  var call = lrById('lr-call-us');
  lrRemoveCloseButton();
  lrSetStatus(o.status || '');
  lrSetAlert(o.alert || '', o.reference);
  if (call) {
    if (state === 'unknown') call.classList.remove('hidden');
    else call.classList.add('hidden');
  }
  lrSetUnload(state === 'iframe' || state === 'verifying');
  lrLockScroll(state === 'iframe');
  if (state === 'ready') {
    _lrSubmitting = false;
    if (btn) btn.classList.remove('btn-loading');
    setControlsLocked(false);
    return;
  }
  setControlsLocked(true);
  if (!btn) return;
  btn.disabled = true;
  if (state === 'starting') {
    btn.textContent = 'Opening secure payment...';
    btn.classList.add('btn-loading');
    lrSetStatus('Preparing your payment.');
  } else if (state === 'iframe') {
    btn.textContent = 'Secure payment open';
    btn.classList.remove('btn-loading');
    lrSetStatus('Complete your payment in the secure window. We never see your card number.');
    var close = lrEl('button', 'btn-secondary', 'Close secure payment');
    close.type = 'button';
    close.id = 'lr-close-pay';
    close.addEventListener('click', lrCancelPayment);
    if (btn.parentNode) btn.parentNode.insertBefore(close, btn.nextSibling);
  } else if (state === 'verifying') {
    btn.textContent = 'Confirming your reservation...';
    var spinner = lrEl('span', 'lr-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    btn.insertBefore(spinner, btn.firstChild);
    btn.classList.add('btn-loading');
    lrSetStatus('Payment approved. Please keep this page open while we confirm your reservation. Do not pay again.');
  } else if (state === 'unknown') {
    btn.textContent = 'Payment received';
    btn.classList.remove('btn-loading');
  }
}

function lrClearSession() {
  _lrCheckoutToken = null;
  _lrSecretToken = null;
  _lrInvoice = '';
  _lrTxnId = '';
  _lrItems = null;
}

function lrCloseIframe() {
  if (typeof removeHelcimPayIframe === 'function') removeHelcimPayIframe();
}

function lrCancelPayment() {
  if (_lrPayState !== 'iframe') return;
  lrCloseIframe();
  lrClearSession();
  lrSetPaymentState('ready', { status: LR_MSG_CANCELLED });
}

function lrFieldGroup(input) {
  var n = input && input.parentNode;
  while (n && !(n.classList && n.classList.contains('form-group'))) n = n.parentNode;
  return n;
}

function lrFieldError(input, msg) {
  var group = lrFieldGroup(input);
  var m = group && group.querySelector('.form-error-msg');
  if (msg) {
    input.classList.add('field-error');
    input.setAttribute('aria-invalid', 'true');
    if (m) { m.textContent = msg; m.classList.add('visible'); }
  } else {
    input.classList.remove('field-error');
    input.removeAttribute('aria-invalid');
    if (m) { m.textContent = ''; m.classList.remove('visible'); }
  }
}

/** Validates name, email and phone. Returns the first invalid input, or null. */
function lrValidateFields() {
  var name = lrById('lr-name');
  var email = lrById('lr-email');
  var phone = lrById('lr-phone');
  var first = null;
  var phoneOk = false;
  if (phone) {
    var d = phone.value.replace(/\D/g, '');
    phoneOk = d.length >= 10 && d.length <= 15;
  }
  var checks = [
    [name, !!(name && name.value.trim()), 'Please enter your name.'],
    [email, !!(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())), 'Please enter a valid email address.'],
    [phone, phoneOk, 'Please enter a phone number we can reach you on.']
  ];
  checks.forEach(function (c) {
    if (!c[0]) return;
    lrFieldError(c[0], c[1] ? '' : c[2]);
    if (!c[1] && !first) first = c[0];
  });
  return first;
}

/**
 * A kit sold out after this page loaded: the server answers initialize with
 * 400 "<Name> is sold out". Mark that kit sold out on the page and drop it
 * from the basket so the customer can pay for the rest.
 * @returns {string} the server message, or '' when it is not a sold-out error
 */
function lrApplyServerSoldOut(body) {
  var err = body && typeof body.error === 'string' ? body.error : '';
  var kit = null;
  for (var i = 0; i < _lrKits.length; i++) {
    if (err === _lrKits[i].short_name + ' is sold out') kit = _lrKits[i];
  }
  if (!kit) return '';
  kit.sold_out = true;
  _lrQty[kit.sku] = 0;
  var old = lrById('lr-kit-' + kit.sku);
  if (old && old.parentNode) old.parentNode.replaceChild(lrBuildKitCard(kit), old);
  if (_lrData) {
    lrBuildCalendar(_lrData);
    lrInjectJsonLd(_lrData);
  }
  return err;
}

function submitPayment() {
  if (_lrSubmitting || _lrPayState !== 'ready') return;
  var bad = lrValidateFields();
  if (bad) { bad.focus(); return; }
  var items = getBasketLines();
  if (!items.length) return;
  _lrSubmitting = true;
  _lrItems = items;
  lrSetPaymentState('starting');
  lrGetRecaptchaToken('preorder_initialize').then(function (token) {
    return lrPost('/api/preorder/initialize', { items: items, recaptcha_token: token });
  }).then(function (res) {
    var b = res.body;
    if (res.status === 200 && b && b.checkoutToken && typeof appendHelcimPayIframe === 'function') {
      _lrCheckoutToken = b.checkoutToken;
      _lrSecretToken = b.secretToken || null;
      _lrInvoice = b.invoice_number || '';
      lrSetPaymentState('iframe');
      appendHelcimPayIframe(b.checkoutToken);
      return;
    }
    var msg = LR_MSG_UNREACHABLE;
    if (res.status === 503) msg = LR_MSG_NOT_OPEN;
    else if (res.status === 400) msg = lrApplyServerSoldOut(b) || LR_MSG_VERIFY;
    lrClearSession();
    lrSetPaymentState('ready', { alert: msg });
  }, function () {
    lrClearSession();
    lrSetPaymentState('ready', { alert: LR_MSG_UNREACHABLE });
  });
}

function handleHelcimMessage(event) {
  if (!event || LR_HELCIM_ORIGINS.indexOf(event.origin) === -1) return;
  if (_lrPayState !== 'iframe') return;
  var data = event.data || {};
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return; } }
  var byCheckout = _lrCheckoutToken && data.eventName === 'helcim-pay-js-' + _lrCheckoutToken;
  var bySecret = _lrSecretToken && data.eventName === 'helcim-pay-js-' + _lrSecretToken;
  if (!byCheckout && !bySecret) return;
  if (data.eventStatus === 'SUCCESS') {
    _lrTxnId = lrExtractTransactionId(data);
    lrCloseIframe();
    if (!_lrTxnId) {
      // Approved but unreadable: we cannot book it. Never claim "not charged".
      lrSetPaymentState('unknown', { alert: LR_MSG_UNKNOWN });
      return;
    }
    submitDeposit();
  } else if (data.eventStatus === 'ABORTED') {
    lrCloseIframe();
    var declined = lrIsDecline(data);
    lrClearSession();
    lrSetPaymentState('ready', declined ? { alert: LR_MSG_DECLINED } : { status: LR_MSG_CANCELLED });
  }
}

function lrUnknownOutcome() {
  lrSetPaymentState('unknown', { alert: LR_MSG_UNKNOWN, reference: _lrTxnId });
}

function submitDeposit() {
  lrSetPaymentState('verifying');
  var nl = lrById('lr-newsletter');
  var copy = (_lrData && _lrData.copy) || {};
  var consentLabel = lrById('lr-consent-label');
  var payload = {
    transaction_id: _lrTxnId,
    invoice_number: _lrInvoice,
    items: _lrItems,
    customer: {
      name: ((lrById('lr-name') || {}).value || '').trim(),
      email: ((lrById('lr-email') || {}).value || '').trim(),
      phone: ((lrById('lr-phone') || {}).value || '').trim()
    },
    consent: {
      accepted: true,
      text: copy.deposit_checkbox_label || (consentLabel && consentLabel.textContent) || ''
    },
    newsletter: !!(nl && nl.checked)
  };
  return lrGetRecaptchaToken('preorder_deposit').then(function (token) {
    payload.recaptcha_token = token;
    return lrPost('/api/preorder/deposit', payload, LR_DEPOSIT_TIMEOUT_MS);
  }).then(function (res) {
    var b = res.body;
    if ((res.status === 200 || res.status === 201) && b && b.ok === true) {
      try {
        lrOnSuccess(b, payload.customer.email);
      } catch (e) {
        lrUnknownOutcome();
      }
      return;
    }
    if (b && b.voided === true) {
      lrClearSession();
      lrSetPaymentState('ready', { alert: LR_MSG_VOIDED });
      return;
    }
    lrUnknownOutcome();
  }, function () {
    lrUnknownOutcome();
  });
}

function lrOnSuccess(response, email) {
  _lrPayState = 'success';
  _lrSubmitting = false;
  lrSetUnload(false);
  lrRemoveCloseButton();
  lrRenderConfirmation(response, email);
  clearBasket();
  var bar = lrById('lr-bar');
  if (bar) bar.classList.add('hidden');
  var heading = lrById('lr-confirm-heading');
  if (heading) heading.focus();
}

/** Zoho SO numbers already carry the "SO-" prefix; add one only when it is missing. */
function lrSoLabel(num) {
  var n = (num === null || num === undefined) ? '' : String(num);
  return /^SO[-\s]/i.test(n) ? n : 'SO ' + n;
}

function lrRenderConfirmation(response, email) {
  var form = lrById('lr-form');
  var basket = lrById('lr-basket');
  var box = lrById('lr-confirm');
  if (form) form.classList.add('hidden');
  if (basket) basket.classList.add('hidden');
  if (!box) return;
  lrClear(box);

  var reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var svgNs = 'http://www.w3.org/2000/svg';
  var wrap = lrEl('div', 'confirm-checkmark');
  wrap.setAttribute('aria-hidden', 'true');
  var svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.setAttribute('width', '52');
  svg.setAttribute('height', '52');
  var circle = document.createElementNS(svgNs, 'circle');
  circle.setAttribute('class', 'confirm-checkmark-circle');
  circle.setAttribute('cx', '26');
  circle.setAttribute('cy', '26');
  circle.setAttribute('r', '25');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'currentColor');
  circle.setAttribute('stroke-width', '2');
  var tick = document.createElementNS(svgNs, 'path');
  tick.setAttribute('class', 'confirm-checkmark-path');
  tick.setAttribute('fill', 'none');
  tick.setAttribute('stroke', 'currentColor');
  tick.setAttribute('stroke-width', '3');
  tick.setAttribute('stroke-linecap', 'round');
  tick.setAttribute('stroke-linejoin', 'round');
  tick.setAttribute('d', 'M14.1 27.2l7.1 7.2 16.7-16.8');
  if (reduced) {
    // Final state, no draw animation.
    circle.setAttribute('style', 'animation:none;stroke-dashoffset:0');
    tick.setAttribute('style', 'animation:none;stroke-dashoffset:0');
  }
  svg.appendChild(circle);
  svg.appendChild(tick);
  wrap.appendChild(svg);
  box.appendChild(wrap);

  var h2 = lrEl('h2', '', 'Your deposit is paid');
  h2.id = 'lr-confirm-heading';
  h2.setAttribute('tabindex', '-1');
  box.appendChild(h2);

  // One row per SO, in kit display order (stable for unknown item ids).
  var orders = ((response && response.salesorders) || []).map(function (so, i) {
    var pos = _lrKits.length;
    for (var k = 0; k < _lrKits.length; k++) {
      if (_lrKits[k].zoho_item_id === so.item_id) { pos = k; break; }
    }
    return { so: so, pos: pos, i: i };
  });
  orders.sort(function (a, b) { return a.pos - b.pos || a.i - b.i; });
  var list = lrEl('ul', 'lr-confirm__list');
  list.style.listStyle = 'none';
  list.style.padding = '0';
  orders.forEach(function (o) {
    var row = lrEl('li', 'lr-confirm__row', o.so.name + ' · ' + o.so.release_label + ' · ');
    row.appendChild(lrEl('span', 'lr-confirm__so', lrSoLabel(o.so.salesorder_number)));
    list.appendChild(row);
  });
  box.appendChild(list);

  var kitCount = typeof response.kit_count === 'number' ? response.kit_count : orders.length;
  var depositTotal = typeof response.deposit_total === 'number' ? response.deposit_total : kitCount * 50;
  var totals = lrEl('p', 'lr-confirm__totals');
  totals.appendChild(lrEl('strong', '', 'Deposit paid: ' + lrFormatMoney(depositTotal)));
  totals.appendChild(document.createTextNode(' · ' + lrKitsLabel(kitCount)));
  box.appendChild(totals);

  box.appendChild(lrEl('h3', 'lr-confirm__subheading', 'What happens next'));
  var steps = lrEl('ol', 'lr-confirm__steps');
  var how = (_lrData && _lrData.copy && _lrData.copy.how_it_works) || [];
  how.slice(1, 4).forEach(function (s) {
    var li = lrEl('li');
    li.appendChild(lrEl('strong', '', s.step));
    li.appendChild(document.createTextNode(': ' + s.text));
    steps.appendChild(li);
  });
  box.appendChild(steps);
  box.appendChild(lrEl('p', 'lr-confirm__email', 'We have emailed your confirmation to ' + email + '.'));

  var actions = lrEl('div', 'lr-confirm__actions');
  var print = lrEl('button', 'btn-secondary', 'Print confirmation');
  print.type = 'button';
  print.addEventListener('click', function () {
    if (typeof window.print === 'function') window.print();
  });
  actions.appendChild(print);
  var back = lrEl('a', 'btn', 'Back to browsing');
  back.href = 'wine.html';
  actions.appendChild(back);
  box.appendChild(actions);

  box.classList.remove('hidden');
}

// Public surface for the payment flow (loaded as a separate script).
if (typeof window !== 'undefined') {
  window.LimitedReleases = {
    getBasketLines: getBasketLines,
    setControlsLocked: setControlsLocked,
    clearBasket: clearBasket,
    computeDepositTotal: computeDepositTotal
  };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', lrBoot);
  } else {
    lrBoot();
  }
}

// ---------------------------------------------------------------------------
// Module exports (for unit testing)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    groupKitsByCollection: groupKitsByCollection,
    buildCalendar: buildCalendar,
    computeDepositTotal: computeDepositTotal,
    isPayEnabled: isPayEnabled,
    formatSpecs: formatSpecs,
    buildJsonLd: buildJsonLd,
    applyQtyChange: applyQtyChange,
    render: lrRender,
    getBasketLines: getBasketLines,
    setControlsLocked: setControlsLocked,
    clearBasket: clearBasket,
    submitPayment: submitPayment,
    submitDeposit: submitDeposit,
    handleHelcimMessage: handleHelcimMessage,
    setPaymentState: lrSetPaymentState
  };
}
