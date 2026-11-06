'use strict';

// ---------------------------------------------------------------------------
// Limited Releases 2026-27 -- server-side campaign config.
//
// Every money decision for the deposit route comes from here, never from the
// browser. The server never reads content/limited-releases-2026-27.json; a
// test cross-checks ids/sku/release so the two cannot drift.
//
// Per-item cap hook: set cap: N on an entry to limit reservations per order
// line for that kit (handoff section 8 item 6). Cross-order caps would need
// Zoho counts and are out of scope ("no cap" across orders is locked).
//
// Sold out: set sold_out: true here AND "sold_out": true on the kit in the
// content JSON (a test checks they match). validateBasket then refuses new
// deposits for it; existing deposits still price and redeem (getKitRate and
// the pickup flow ignore the flag).
// ---------------------------------------------------------------------------

var DEPOSIT_PER_KIT = 50;
var MAX_QTY_PER_LINE = 10;
// D-18 request-size bound, not an inventory cap -- no cap across orders.
var MAX_KITS_PER_ORDER = 10;
var CAMPAIGN_REFERENCE = 'LIMITED-2026-27';

var TOO_MANY = 'Up to ' + MAX_KITS_PER_ORDER + ' kits per order. Call us for more: (604) 567-4565';

function kit(sku, name, collection, supplier, release, releaseLabel) {
  return {
    sku: sku,
    name: name,
    collection: collection,
    supplier: supplier,
    release: release,
    release_label: releaseLabel,
    cap: undefined,
    sold_out: false
  };
}

var ALLOWLIST = {
  '109900000001719001': kit('80100269', 'Ember', 'rq27', 'RJS', '2026-11', 'November 2026'),
  '109900000001719056': kit('G010409', 'Connexion Red', 'le26', 'Winexpert', '2026-12', 'December 2026'),
  '109900000001719012': kit('80100270', 'Aria', 'rq27', 'RJS', '2027-01', 'January 2027'),
  '109900000001719067': kit('G010408', 'Connexion White', 'le26', 'Winexpert', '2027-01', 'January 2027'),
  '109900000001719023': kit('80100271', 'Acqua', 'rq27', 'RJS', '2027-02', 'February 2027'),
  '109900000001719078': kit('G010407', 'Milagro', 'le26', 'Winexpert', '2027-02', 'February 2027'),
  '109900000001719034': kit('80100272', 'Terre', 'rq27', 'RJS', '2027-03', 'March 2027'),
  '109900000001719089': kit('G010406', 'Synergy', 'le26', 'Winexpert', '2027-03', 'March 2027'),
  '109900000001719045': kit('80100285', 'Sol', 'rq27', 'RJS', '2027-04', 'April 2027'),
  '109900000001719100': kit('G010404', 'Amici', 'le26', 'Winexpert', '2027-04', 'April 2027')
};

ALLOWLIST['109900000001719012'].sold_out = true; // Aria

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function fail(error) {
  return { ok: false, error: error };
}

/**
 * Strictly validate an untrusted basket.
 * @param {*} items
 * @returns {{ok:true, lines:Array, totalKits:number}|{ok:false, error:string}}
 */
function validateBasket(items) {
  if (!Array.isArray(items) || items.length < 1) return fail('Choose at least one kit');
  if (items.length > MAX_KITS_PER_ORDER) return fail(TOO_MANY);

  var seen = {};
  var lines = [];
  var total = 0;

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || typeof it !== 'object' || Array.isArray(it)) return fail('Invalid basket line');
    var id = it.item_id;
    if (typeof id !== 'string' || !has(ALLOWLIST, id)) return fail('Unknown kit');
    if (ALLOWLIST[id].sold_out) return fail(ALLOWLIST[id].name + ' is sold out');
    var qty = it.qty;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      return fail('Invalid quantity');
    }
    var cap = ALLOWLIST[id].cap;
    if (typeof cap === 'number' && qty > cap) return fail('Quantity above the limit for this kit');
    if (has(seen, id)) return fail('Duplicate kit line');
    seen[id] = true;
    total += qty;
    lines.push({ item_id: id, qty: qty });
  }

  if (total > MAX_KITS_PER_ORDER) return fail(TOO_MANY);
  if (total < 1) return fail('Choose at least one kit');
  return { ok: true, lines: lines, totalKits: total };
}

function computeDeposit(totalKits) {
  return computeDepositCents(totalKits) / 100;
}

function computeDepositCents(totalKits) {
  return Math.round(DEPOSIT_PER_KIT * totalKits * 100);
}

/**
 * Expand validated lines into one unit per kit (D-04: one SO per kit unit).
 */
function expandUnits(lines) {
  var units = [];
  lines.forEach(function (l) {
    var e = ALLOWLIST[l.item_id];
    for (var n = 1; n <= l.qty; n++) {
      units.push({
        item_id: l.item_id,
        sku: e.sku,
        name: e.name,
        release: e.release,
        release_label: e.release_label,
        collection: e.collection,
        unitIndex: n,
        unitCount: l.qty
      });
    }
  });
  return units;
}

module.exports = {
  DEPOSIT_PER_KIT: DEPOSIT_PER_KIT,
  MAX_QTY_PER_LINE: MAX_QTY_PER_LINE,
  MAX_KITS_PER_ORDER: MAX_KITS_PER_ORDER,
  CAMPAIGN_REFERENCE: CAMPAIGN_REFERENCE,
  ALLOWLIST: ALLOWLIST,
  validateBasket: validateBasket,
  computeDeposit: computeDeposit,
  computeDepositCents: computeDepositCents,
  expandUnits: expandUnits
};
