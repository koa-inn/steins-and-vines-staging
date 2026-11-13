'use strict';

// Phase 99-01: anonymize a raw staging capture into the committed perf fixture.
// Everything under tests/ is publicly served on production, so this is allowlist-first:
// a string under any key NOT in KEEP_KEYS becomes "Redacted text". Numbers, booleans,
// null and empty strings are kept. PII key rules take precedence over the allowlist.
//
// CLI: node tests/perf/anonymize.js [in] [out]
//      (defaults: tests/perf/.raw/capture.json -> tests/perf/fixture/dashboard-fixture.json)

var fs = require('fs');
var path = require('path');

// Keys checked to hold no personal data: ids, dates/timestamps, enums, and
// recipe/product/schedule/vessel/ingredient/task names.
var KEEP_KEYS = [
  // ids (internal, no embedded contact data)
  'batch_id', 'task_id', 'vessel_id', 'shelf_id', 'bin_id', 'schedule_id', 'recipe_id',
  'product_sku', 'item_id', 'ingredient_id', 'tax_id', 'staffBatchIds',
  // dates / timestamps
  'today', 'tz', 'month', 'start', 'end', 'due_date', 'start_date', 'completed_day',
  'completed_at', 'completed_at_source', 'created_at', 'last_updated', 'last_regenerated_at',
  'updated_at', 'reading_at', 'reading_day', 'signed_up_at', 'contacted_at',
  'fermentation_started_at', 'bottling_invite_sent_at', 'bottling_due',
  // enums
  'status', 'type', 'material', 'category', 'source', 'batch_type', 'batch_type_source',
  'schedule_category', 'product_subcategory', 'unit', 'cf_type', 'cf_subcategory',
  'display_group', 'error',
  // recipe / product / schedule / task / ingredient names
  'name', 'title', 'product_name', 'recipe_name', 'recipe_style', 'item_name', 'juice', 'yeast',
  // month labels only (see VALUE_PATTERNS); other labels are redacted
  'label'
];

// Strings that are JSON documents: parsed, anonymized recursively, re-stringified.
var JSON_STRING_KEYS = ['steps', 'schedule_snapshot', 'recipe_snapshot'];

// Extra value guard for keys that are kept only when the value looks like this.
var VALUE_PATTERNS = {
  label: /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/
};

// Id-like keys that link to a person: deterministic placeholders keep equality.
var PSEUDO_ID_PREFIX = {
  customer_id: 'CUST-', zoho_contact_id: 'CONTACT-', id: 'ROW-', zoho_so_number: 'SO-'
};

var RE_EMAIL = /email/i;
var RE_PHONE = /phone|mobile|tel/i;
var RE_SECRET = /token|secret|password|session|signature/i;
var RE_NAME = /(customer|contact|client|first|last|full)_?name/i;
var RE_FREE = /^notes?$|comment|message|description|address/i;
var RE_PII_VALUE = /@|\b\d{10}\b|\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/;
var REDACTED = 'Redacted text';

function makeCounter() {
  var maps = {};
  return function (kind, value) {
    var m = maps[kind] || (maps[kind] = { n: 0, seen: {} });
    if (!Object.prototype.hasOwnProperty.call(m.seen, value)) { m.seen[value] = ++m.n; }
    return m.seen[value];
  };
}

function isCustomerShaped(obj) {
  return Object.keys(obj).some(function (k) { return /email|phone|customer|contact/i.test(k); });
}

function anonymizeFixture(raw) {
  var count = makeCounter();

  function str(key, value, parent) {
    if (value === '') { return value; }
    if (RE_EMAIL.test(key)) { return 'customer' + count('email', value) + '@example.test'; }
    if (RE_PHONE.test(key)) { return '555-0100'; }
    if (RE_SECRET.test(key)) { return 'redacted'; }
    if (Object.prototype.hasOwnProperty.call(PSEUDO_ID_PREFIX, key)) {
      return PSEUDO_ID_PREFIX[key] + count('id:' + key, value);
    }
    if (RE_NAME.test(key) || (key === 'name' && parent && isCustomerShaped(parent))) {
      return 'Customer ' + count('name', value);
    }
    if (RE_FREE.test(key)) { return REDACTED; }
    if (JSON_STRING_KEYS.indexOf(key) !== -1) {
      try { return JSON.stringify(walk(JSON.parse(value), key, null)); } catch (e) { return REDACTED; }
    }
    if (KEEP_KEYS.indexOf(key) !== -1) {
      if (RE_PII_VALUE.test(value)) { return REDACTED; }
      if (VALUE_PATTERNS[key] && !VALUE_PATTERNS[key].test(value)) { return REDACTED; }
      return value;
    }
    return REDACTED;
  }

  // key is the nearest object key (array elements inherit their array's key).
  function walk(v, key, parent) {
    if (Array.isArray(v)) { return v.map(function (x) { return walk(x, key, parent); }); }
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).forEach(function (k) { out[k] = walk(v[k], k, v); });
      return out;
    }
    if (typeof v === 'string') { return str(key, v, parent); }
    return v;
  }

  return walk(raw, '', null);
}

module.exports = { anonymizeFixture: anonymizeFixture, KEEP_KEYS: KEEP_KEYS };

if (require.main === module) {
  var HERE = __dirname;
  var inFile = process.argv[2] || path.join(HERE, '.raw', 'capture.json');
  var outFile = process.argv[3] || path.join(HERE, 'fixture', 'dashboard-fixture.json');
  var raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  fs.writeFileSync(outFile, JSON.stringify(anonymizeFixture(raw), null, 2) + '\n');
  console.log('wrote ' + outFile);
}
