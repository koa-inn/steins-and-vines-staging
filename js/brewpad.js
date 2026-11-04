// ===== Steins & Vines BrewPad — iPad Batch Terminal =====
// Self-contained IIFE — no dependency on admin.js.

// Phase 76-03: module-scope hook the fetch-wrapper IIFE below calls on every
// MIDDLEWARE_URL response. Assigned to the real implementation once the main
// auth IIFE below runs (it needs closure access to clearSession/accessToken/
// showSessionExpiredOverlay). Declared here, at the top level, so it is
// reachable both from the wrapped window.fetch (production) and from the
// module.exports test seam at the bottom of this file (Jest) -- see
// _handleMiddlewareResponse's assignment further down for why this can't
// simply live inside either IIFE.
var _handleMiddlewareResponse = null;

// Attach the session token to every middleware request as an x-session-token
// header. The httpOnly sv_session cookie is set at login but modern browsers do
// NOT send it to the cross-site Railway origin, so staff surfaces carry the same
// opaque session id in this header instead. Scoped strictly to MIDDLEWARE_URL
// requests — the token is never sent to any other host.
(function () {
  // Browser-only: under CommonJS/jest the tests mock window.fetch directly and
  // must keep their jest.fn reference intact, so never wrap in that context.
  if (typeof module !== 'undefined' || typeof window === 'undefined' ||
      !window.fetch || window.__svSessionFetchWrapped) return;
  window.__svSessionFetchWrapped = true;
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var base = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL) || '';
      if (base && url.indexOf(base) === 0) {
        var tok = null;
        try { tok = localStorage.getItem('sv_session_token'); } catch (e) {}
        if (tok) {
          init = init || {};
          if (init.headers && typeof init.headers.set === 'function') {
            init.headers.set('x-session-token', tok);
          } else {
            var merged = {}, src = init.headers || {};
            for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) merged[k] = src[k]; }
            merged['x-session-token'] = tok;
            init.headers = merged;
          }
        }
      }
    } catch (e) { /* never break a fetch over telemetry */ }
    return origFetch.call(this, input, init).then(function (response) {
      // Phase 76-03 (D-03): the SOLE full-re-login trigger is a real
      // middleware HTTP 401 -- never a Google/Apps-Script body substring.
      try { if (typeof _handleMiddlewareResponse === 'function') _handleMiddlewareResponse(url, response); } catch (e) {}
      return response;
    });
  };
})();

// Pure / near-pure helpers lifted out of the IIFE so they can be unit-tested.

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Return a YYYY-MM-DD string for today (or today +/- N days) in Pacific time
function todayPacific(offsetDays) {
  var d = offsetDays ? new Date(Date.now() + offsetDays * 86400000) : new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return String(dateStr).substring(0, 10);
}

// Compact "Mon D" label from a YYYY-MM-DD string, parsed without timezone drift.
function fmtShortDate(dateStr) {
  var s = String(dateStr || '').slice(0, 10);
  var p = s.split('-');
  if (p.length !== 3) return s;
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var mi = parseInt(p[1], 10) - 1;
  if (mi < 0 || mi > 11) return s;
  return months[mi] + ' ' + parseInt(p[2], 10);
}

// True when a batch's start date is in the future (scheduled to begin later) — Pacific.
function isFutureStart(startDate) {
  if (!startDate) return false;
  return String(startDate).slice(0, 10) > todayPacific();
}

function isOverdue(dateStr) {
  if (!dateStr) return false;
  return String(dateStr).substring(0, 10) < todayStr();
}

function isToday(dateStr) {
  if (!dateStr) return false;
  return String(dateStr).substring(0, 10) === todayStr();
}

// Display helper: prefers firstname+lastname, falls back to customer_name (legacy batches)
function getCustomerDisplayName(b) {
  if (b.customer_firstname || b.customer_lastname) {
    return ((b.customer_firstname || '') + ' ' + (b.customer_lastname || '')).trim();
  }
  return b.customer_name || '';
}

// --- Zoho refresh helpers (ZSYNC-01/02, Phase 29) ---

// Gate for Refresh-from-Zoho button: returns true only when num matches the
// exact shape the endpoint validates (/api/batch/customer-by-number).
// Case-insensitive per D-08. The middleware normalizes to uppercase before its
// regex check (CR-01, plan 29-04), so this gate and the middleware accept the
// same set of refs — a coherent single contract. The fetch handler still
// defends against a 400 invalid_number for robustness.
function isValidZohoNumber(num) {
  if (typeof num !== 'string' || !num) return false;
  return /^(INV|SO)-\d+$/i.test(num);
}

// Returns true when an error message from adminApiPost indicates an
// optimistic-lock version conflict.  The Apps Script message contains
// 'modified' (e.g. 'Batch was modified by another user…'), NOT 'version'.
// Matching both ensures forward-compatibility if the message ever changes.
function isVersionConflict(msg) {
  if (!msg) return false;
  var lower = String(msg).toLowerCase();
  return lower.indexOf('version') !== -1 || lower.indexOf('modified') !== -1;
}

// Split a full customer name into {customer_firstname, customer_lastname}.
// Single-token names yield lastname=''. Used by the Zoho refresh handler to
// keep firstname/lastname columns coherent with the refreshed customer_name.
function splitCustomerName(fullName) {
  var trimmed = String(fullName || '').trim();
  var parts = trimmed.split(/\s+/);
  var first = parts.shift() || '';
  var last = parts.join(' ');
  return { customer_firstname: first, customer_lastname: last };
}

// Build the update_batch payload from fetched Zoho data (D-13 / Phase 28 D-02).
// Includes ONLY keys whose trimmed fetched value is a non-empty string.
// Never emits '', null, or undefined — preserves existing batch data for blank Zoho values.
// Build the canonical updates object for batch customer reassignment (Phase 29.1).
// Accepts a picked customer from the type-ahead search { contact_id, contact_name, email, phone }
// or from the add-new form { name, email, phone } (no contact_id).
// Always returns all six keys as strings — never undefined.
function buildCustomerReassignUpdates(picked) {
  var contactId = picked.contact_id || '';
  var fullName = picked.contact_name || picked.name || '';
  var nameParts = splitCustomerName(fullName);
  return {
    customer_id: String(contactId),
    customer_name: fullName,
    customer_firstname: nameParts.customer_firstname,
    customer_lastname: nameParts.customer_lastname,
    customer_email: String(picked.email || ''),
    customer_phone: String(picked.phone || '')
  };
}

function buildRefreshUpdates(fetched) {
  var result = {};
  var keys = ['customer_name', 'customer_email', 'customer_phone'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var raw = fetched[k];
    if (typeof raw === 'string' && raw.trim() !== '') {
      result[k] = raw.trim();
    }
  }
  return result;
}

// No-change comparison (D-12): returns true when every key present in
// buildRefreshUpdates(fetched) already equals the batch's current value
// (trimmed, case-insensitive). If buildRefreshUpdates returns {} (nothing to
// apply) this is also treated as "no change" — return true so the caller
// skips the update_batch call entirely.
function compareRefreshFields(fetched, batch) {
  var updates = buildRefreshUpdates(fetched);
  var keys = Object.keys(updates);
  if (keys.length === 0) return true; // nothing to apply = no change
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var fetchedVal = String(updates[k] || '').trim().toLowerCase();
    var batchVal = String(batch[k] || '').trim().toLowerCase();
    if (fetchedVal !== batchVal) return false;
  }
  return true;
}

function filterBatchesByStatus(batches, filter) {
  if (!filter || filter === 'all') return batches.slice();
  if (filter === 'active') {
    return batches.filter(function (b) {
      var s = String(b.status || '').toLowerCase();
      return s === 'primary' || s === 'secondary';
    });
  }
  return batches.filter(function (b) {
    return String(b.status || '').toLowerCase() === filter;
  });
}

// Phase 90 (D-06/D-24): the Unlinked set. Every batch, any status, with no invoice
// number, whose source is not 'internal', and which is not disabled/deleted.
// Blank-source legacy batches count (they are the backlog).
function normBatchSource(source) {
  return String(source === null || source === undefined ? '' : source).trim().toLowerCase();
}

function filterBatchesByUnlinked(batches) {
  return (batches || []).filter(function (b) {
    if (!b) return false;
    if (String(b.zoho_so_number === null || b.zoho_so_number === undefined ? '' : b.zoho_so_number).trim() !== '') return false;
    if (normBatchSource(b.source) === 'internal') return false;
    var s = String(b.status || '').trim().toLowerCase();
    return s !== 'disabled' && s !== 'deleted';
  });
}

// Phase 90 (D-05): Mark internal / Mark as not internal is offered only for blank,
// manual or internal sources. Locked sources (kiosk, kiosk_recipe, online, zoho_scan,
// research, anything else) are never changed from the UI (server guards are authoritative).
function isBatchSourceEditable(source) {
  var s = normBatchSource(source);
  return s === '' || s === 'manual' || s === 'internal';
}

function shouldShowInternalBadge(source) {
  return normBatchSource(source) === 'internal';
}

// Ready-to-Bottle filter: intersects _allBatchesData with the SERVER-computed
// _dashSummary.readyToBottle set (adminApi.gs:1847-1883) by batch_id. Does NOT
// re-derive the packaging-due predicate client-side.
function filterBatchesByReadyToBottle(batches, readyToBottleList) {
  var ids = {};
  (readyToBottleList || []).forEach(function (r) { ids[String(r.batch_id)] = true; });
  return (batches || []).filter(function (b) { return ids[String(b.batch_id)]; });
}

// Recipes: pure helpers lifted out of the IIFE for unit-testing.

function filterRecipesByName(list, query) {
  var q = (query || '').toLowerCase().trim();
  if (!q) return list ? list.slice() : [];
  return (list || []).filter(function (r) {
    return (r.name || '').toLowerCase().indexOf(q) !== -1;
  });
}

function recipeRowPrice(recipe) {
  if (!recipe) return '—';
  var isDynamic = recipe.pricing_mode === 'dynamic';
  var priceVal = isDynamic ? Number(recipe.computed_price) : Number(recipe.locked_price);
  if (!priceVal || isNaN(priceVal) || priceVal <= 0) return '—';
  return (isDynamic ? '~$' : '$') + priceVal.toFixed(2);
}

// Copy cost (purchase_rate) and retail (rate) from the ingredient catalog onto each
// recipe ingredient, matched by item_id. The recipe endpoint returns ingredients WITHOUT
// prices — they live in the ingredient catalog — so without this enrichment the editor's
// Cost/Retail columns and the totals footer render blank ("—"). Mirrors admin.js
// applyCatalogRatesToCurrentIngredients. Mutates and returns `ingredients`.
function enrichIngredientsWithCatalogRates(ingredients, catalog) {
  if (!Array.isArray(ingredients) || !Array.isArray(catalog)) return ingredients || [];
  ingredients.forEach(function (ing) {
    if (!ing || ing.item_id == null || ing.item_id === '') return; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    var match = catalog.find(function (c) {
      return c && String(c.item_id) === String(ing.item_id);
    });
    if (match) {
      ing.purchase_rate = parseFloat(match.purchase_rate) || 0;
      ing.rate = parseFloat(match.rate || match.price_per_unit) || 0;
      // 73-07/CR-02: catalog_unit is the unit the rate is PRICED per — kept
      // DISTINCT from ing.unit (the recipe-line unit) so bpIngredientLineCost
      // can convert a g-line against a kg-priced catalog item instead of the
      // two units silently collapsing into one field.
      if (match.unit) ing.catalog_unit = match.unit;
      if (!ing.unit && match.unit) ing.unit = match.unit;
    }
  });
  return ingredients;
}

// Known beverage type buckets for the dashboard Batches-by-Month chart.
var KNOWN_BATCH_TYPES = { wine: true, beer: true, cider: true, seltzer: true };

// Build a lookup map { schedule_id -> category } from a _fermSchedules-shaped array.
function buildScheduleCategoryById(schedules) {
  var map = {};
  if (!schedules || !schedules.length) return map;
  for (var i = 0; i < schedules.length; i++) {
    var s = schedules[i];
    if (s && s.schedule_id && s.category) {
      map[s.schedule_id] = String(s.category).toLowerCase();
    }
  }
  return map;
}

// Resolve the beverage type bucket for a single batch.
// Resolution order:
//   1. batch.category (non-empty known type)
//   2. scheduleCategoryById[batch.schedule_id]
//   3. JSON-parsed batch.schedule_snapshot.category
//   4. 'other'
function resolveBatchType(batch, scheduleCategoryById) {
  var known = KNOWN_BATCH_TYPES;

  // 1. Direct batch.category
  if (batch.category) {
    var c = String(batch.category).toLowerCase();
    if (known[c]) return c;
  }

  // 2. Via schedule_id lookup
  if (batch.schedule_id && scheduleCategoryById) {
    var sc = scheduleCategoryById[batch.schedule_id];
    if (sc) {
      var s2 = String(sc).toLowerCase();
      if (known[s2]) return s2;
    }
  }

  // 3. Via schedule_snapshot
  if (batch.schedule_snapshot) {
    try {
      var snap = typeof batch.schedule_snapshot === 'string'
        ? JSON.parse(batch.schedule_snapshot)
        : batch.schedule_snapshot;
      if (snap && snap.category) {
        var s3 = String(snap.category).toLowerCase();
        if (known[s3]) return s3;
      }
    } catch (e) { /* ignore malformed JSON */ }
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// Phase 94 dashboard data layer. Pure ES5 helpers: no wall clock inside the
// window/cycle math (everything derives from asOf.today, a Vancouver YYYY-MM-DD).
// ---------------------------------------------------------------------------
var DASH_WINDOW_DAYS = { '30d': 30, '90d': 90, '6mo': 180, '12mo': 365 };
var DASH_TYPES = ['wine', 'beer', 'cider', 'seltzer', 'other'];
var DASH_TYPE_LABELS = { all: 'All', wine: 'Wine', beer: 'Beer', cider: 'Cider', seltzer: 'Seltzer', other: 'Other' };
var DASH_STARTED_STATUSES = { primary: true, secondary: true, complete: true };
var DASH_MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Whole-day index of a 'YYYY-MM-DD' string (UTC based, DST proof).
function dayNumber(ymd) {
  var p = String(ymd).slice(0, 10).split('-');
  return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

function addDays(ymd, n) {
  var d = new Date((dayNumber(ymd) + n) * 86400000);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// Whole days from start to completion; null when either is missing or span < 0.
function cycleDays(startYmd, completedYmd) {
  if (!startYmd || !completedYmd) return null;
  var n = dayNumber(completedYmd) - dayNumber(startYmd);
  if (isNaN(n) || n < 0) return null;
  return n;
}

function medianOf(nums) {
  if (!nums || !nums.length) return null;
  var a = nums.slice().sort(function (x, y) { return x - y; });
  var mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function meanOf(nums) {
  if (!nums || !nums.length) return null;
  var sum = 0;
  for (var i = 0; i < nums.length; i++) sum += nums[i];
  return sum / nums.length;
}

function dashboardWindow(key, asOfToday) {
  var end = asOfToday;
  if (key === 'all') return { key: 'all', start: '0000-01-01', end: end };
  if (DASH_WINDOW_DAYS[key]) {
    return { key: key, start: addDays(end, -(DASH_WINDOW_DAYS[key] - 1)), end: end };
  }
  return { key: 'ytd', start: String(end).slice(0, 4) + '-01-01', end: end };
}

function inWindow(ymd, w) {
  if (!ymd) return false;
  var s = String(ymd).slice(0, 10);
  return s >= w.start && s <= w.end;
}

function effectiveBatchType(row, scheduleCategoryById) {
  var bt = row && row.batch_type ? String(row.batch_type).toLowerCase() : '';
  if (bt && DASH_TYPES.indexOf(bt) !== -1) return bt;
  var sc = row && row.schedule_category ? String(row.schedule_category).toLowerCase() : '';
  if (sc && KNOWN_BATCH_TYPES[sc]) return sc;
  return resolveBatchType(row || {}, scheduleCategoryById);
}

function vancouverDay(iso) {
  if (!iso) return null;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
}

// Adapt get_batches rows to the lean dashboard row contract (sheets-mode fallback).
function toDashRows(batches) {
  var out = [];
  if (!batches || !batches.length) return out;
  for (var i = 0; i < batches.length; i++) {
    var b = batches[i] || {};
    out.push({
      batch_id: b.batch_id,
      status: String(b.status || '').toLowerCase(),
      batch_type: b.batch_type || null,
      batch_type_source: b.batch_type_source || null,
      start_date: b.start_date ? String(b.start_date).slice(0, 10) : null,
      completed_day: vancouverDay(b.completed_at),
      completed_at: b.completed_at || null,
      completed_at_source: b.completed_at_source || null,
      vessel_id: b.vessel_id || null,
      source: b.source || '',
      product_sku: b.product_sku || '',
      product_name: b.product_name || '',
      product_subcategory: b.product_subcategory || '',
      product_brand: b.product_brand || '',
      product_manufacturer: b.product_manufacturer || '',
      recipe_id: b.recipe_id || '',
      schedule_id: b.schedule_id || '',
      schedule_category: '',
      target_volume_l: b.target_volume_l === undefined ? null : b.target_volume_l,
      tasks_total: b.tasks_total || 0,
      tasks_done: b.tasks_done || 0,
      staff_batch: b.staff_batch === true
    });
  }
  return out;
}

function emptyTypeCounts() {
  var o = {};
  for (var i = 0; i < DASH_TYPES.length; i++) o[DASH_TYPES[i]] = 0;
  return o;
}

function isNeedsType(row, type) {
  var src = row.batch_type_source ? String(row.batch_type_source).toLowerCase() : '';
  return type === 'other' && src !== 'manual' && String(row.status || '').toLowerCase() !== 'disabled';
}

// ---------------------------------------------------------------------------
// Phase 95 selection layer helpers (pure ES5, no wall clock).
// ---------------------------------------------------------------------------
var DASH_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyTypeLists() {
  var o = {};
  for (var i = 0; i < DASH_TYPES.length; i++) o[DASH_TYPES[i]] = [];
  return o;
}

// Monday on or before ymd (1970-01-01 was a Thursday).
function weekStartOf(ymd) {
  var sinceMonday = (dayNumber(ymd) + 3) % 7;
  return addDays(ymd, -sinceMonday);
}

function bucketKeyOf(ymd, group) {
  if (group === 'week') return weekStartOf(ymd);
  return String(ymd).slice(0, 7);
}

function bucketLabelOf(key, group) {
  if (group === 'week') {
    return 'Week of ' + DASH_MONTH_LABELS[+String(key).slice(5, 7) - 1] + ' ' + (+String(key).slice(8, 10));
  }
  return DASH_MONTH_LABELS[+String(key).slice(5, 7) - 1] + ' ' + String(key).slice(0, 4);
}

// Gap-filled bucket list; first bucket contains start, last contains end.
function periodSkeleton(start, end, group) {
  var out = [];
  var key;
  if (!start || !end || start > end) return out;
  if (group === 'week') {
    key = weekStartOf(start);
    var lastWeek = weekStartOf(end);
    while (key <= lastWeek) {
      out.push({ key: key, label: bucketLabelOf(key, 'week') });
      key = addDays(key, 7);
    }
    return out;
  }
  var y = +String(start).slice(0, 4);
  var m = +String(start).slice(5, 7);
  var lastMonth = String(end).slice(0, 7);
  while (true) {
    key = y + '-' + (m < 10 ? '0' : '') + m;
    if (key > lastMonth) break;
    out.push({ key: key, label: bucketLabelOf(key, 'month') });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function sourceMatches(row, want) {
  if (want === undefined || want === null || want === '' || want === 'all') return true;
  var s = normBatchSource(row && row.source);
  if (want === 'unknown') return s === '';
  if (want === 'kiosk') return s === 'kiosk' || s === 'kiosk_recipe';
  return s === want;
}

// Litres for one batch. kind: 'started' | 'active' | 'completed'. est=true when a default was used.
function batchLitres(row, kind, type) {
  var tv = Number(row && row.target_volume_l);
  if (tv > 0) return { l: tv, est: false };
  if (type === 'beer') return { l: kind === 'completed' ? 25 : 28, est: true };
  return { l: 23, est: true };
}

function isStaffRow(row, staffIds) {
  if (!row) return false;
  return row.staff_batch === true || !!(staffIds && staffIds[row.batch_id] === true);
}

function isRealYmd(s) {
  return typeof s === 'string' && DASH_YMD_RE.test(s) && addDays(s, 0) === s;
}

function windowFromFilters(state, today) {
  var st = state || {};
  var p = st.period;
  if (p === 'custom') {
    if (isRealYmd(st.from) && isRealYmd(st.to) && st.from <= st.to && st.to <= today) {
      return { key: 'custom', start: st.from, end: st.to };
    }
    return dashboardWindow('ytd', today);
  }
  if (p === 'all' || p === 'ytd' || DASH_WINDOW_DAYS[p]) return dashboardWindow(p, today);
  return dashboardWindow('ytd', today);
}

function previousWindow(win, today) {
  if (!win || win.key === 'all') return null;
  if (win.key === 'ytd') {
    var py = +String(win.end).slice(0, 4) - 1;
    var md = String(win.end).slice(5, 10);
    if (md === '02-29') md = '02-28';
    return { key: 'ytd', start: py + '-01-01', end: py + '-' + md, days: dayNumber(py + '-' + md) - dayNumber(py + '-01-01') + 1 };
  }
  var n = dayNumber(win.end) - dayNumber(win.start) + 1;
  return { key: win.key, start: addDays(win.start, -n), end: addDays(win.start, -1), days: n };
}

// The single dashboard computation. Each row is classified once and the type
// filter is applied once, before any total is computed.
function getDashboardData(rows, asOf, filters) {
  var f = filters || {};
  var winKey = f.window || 'ytd';
  var typeFilter = f.type || 'all';
  var months = f.months || 6;
  var catMap = f.scheduleCategoryById || {};
  var today = asOf.today;
  var win = dashboardWindow(winKey, today);
  if (f.range && f.range.start && f.range.end) {
    win = { key: f.window || 'custom', start: f.range.start, end: f.range.end };
  }
  var cycleWin = win;

  var items = [];
  var needsType = [];
  var src = rows || [];
  var earliestStart = null;
  var i;
  for (i = 0; i < src.length; i++) {
    var r = src[i];
    if (!r) continue;
    var t = effectiveBatchType(r, catMap);
    var rStatus = String(r.status || '').toLowerCase();
    // earliestStart looks at every started row before any filter.
    if (DASH_STARTED_STATUSES[rStatus] === true && r.start_date) {
      var sd = String(r.start_date).slice(0, 10);
      if (earliestStart === null || sd < earliestStart) earliestStart = sd;
    }
    // needsType is a worklist and ignores the type filter.
    if (isNeedsType(r, t)) needsType.push(r);
    if (typeFilter !== 'all' && t !== typeFilter) continue;
    if (!sourceMatches(r, f.source)) continue;
    items.push({ row: r, type: t, status: rStatus });
  }

  var idSets = {
    started: [], completed: [], activeNow: [], cycle: [],
    startedByType: emptyTypeLists(), completedByType: emptyTypeLists()
  };
  var litres = {
    started: 0, completed: 0, activeNow: 0,
    startedByType: emptyTypeCounts(), completedByType: emptyTypeCounts(), estimated: false
  };
  var mixWine = [];
  var staffHidden = 0;
  var periodBuckets = [];
  var periodByKey = {};
  var startedItems = [];
  var completedItems = [];
  var completedBuckets = [];

  var activeNow = 0;
  var pendingCount = 0;
  var started = 0;
  var completed = 0;
  var totalsByType = emptyTypeCounts();
  var completedByType = emptyTypeCounts();
  var spans = [];
  var spansByType = {};
  var excluded = 0;

  // Month bucket skeleton: last N calendar months ending at the asOf month.
  var y = +String(today).slice(0, 4);
  var m = +String(today).slice(5, 7);
  var buckets = [];
  var bucketByKey = {};
  var k;
  for (k = months - 1; k >= 0; k--) {
    var mm = m - k;
    var yy = y;
    while (mm < 1) { mm += 12; yy -= 1; }
    var key = yy + '-' + (mm < 10 ? '0' : '') + mm;
    var bk = { key: key, label: DASH_MONTH_LABELS[mm - 1], total: 0, counts: emptyTypeCounts() };
    buckets.push(bk);
    bucketByKey[key] = bk;
  }

  for (i = 0; i < items.length; i++) {
    var it = items[i];
    var row = it.row;
    var isStarted = DASH_STARTED_STATUSES[it.status] === true;
    if (it.status === 'pending') pendingCount++;
    if (it.status === 'primary' || it.status === 'secondary') {
      activeNow++;
      idSets.activeNow.push(row.batch_id);
      var lAct = batchLitres(row, 'active', it.type);
      litres.activeNow += lAct.l;
      if (lAct.est) litres.estimated = true;
    }
    if (!isStarted) continue;

    if (inWindow(row.start_date, win)) {
      started++;
      totalsByType[it.type]++;
      idSets.started.push(row.batch_id);
      idSets.startedByType[it.type].push(row.batch_id);
      var lSt = batchLitres(row, 'started', it.type);
      litres.started += lSt.l;
      litres.startedByType[it.type] += lSt.l;
      if (lSt.est) litres.estimated = true;
      startedItems.push(it);
    }
    // Review CR-01: only complete rows count, so a reopened batch's stale stamp is ignored.
    if (it.status === 'complete' && inWindow(row.completed_day, win)) {
      completed++;
      completedItems.push(it);
      completedByType[it.type]++;
      idSets.completed.push(row.batch_id);
      idSets.completedByType[it.type].push(row.batch_id);
      var lCo = batchLitres(row, 'completed', it.type);
      litres.completed += lCo.l;
      litres.completedByType[it.type] += lCo.l;
      if (lCo.est) litres.estimated = true;
    }
    if (row.start_date && row.start_date <= today) {
      var b = bucketByKey[String(row.start_date).slice(0, 7)];
      if (b) { b.total++; b.counts[it.type]++; }
    }

    if (it.status === 'complete') {
      if (row.completed_day) {
        if (inWindow(row.completed_day, cycleWin)) {
          var span = cycleDays(row.start_date, row.completed_day);
          if (span === null) {
            excluded++;
          } else {
            spans.push(span);
            idSets.cycle.push(row.batch_id);
            if (!spansByType[it.type]) spansByType[it.type] = [];
            spansByType[it.type].push(span);
          }
        }
      } else if (inWindow(row.start_date, cycleWin)) {
        excluded++;
      }
    }
  }

  var cycleByType = {};
  for (k = 0; k < DASH_TYPES.length; k++) {
    var tt = DASH_TYPES[k];
    var list = spansByType[tt];
    if (list && list.length) {
      cycleByType[tt] = { n: list.length, median: Math.round(medianOf(list)), mean: Math.round(meanOf(list)) };
    }
  }
  var med = medianOf(spans);
  var mean = meanOf(spans);

  // Phase 95: window-clipped period buckets and the wine mix rows, both from
  // the started-in-window set so they match ids.started by construction.
  if (f.group === 'week' || f.group === 'month') {
    var skelStart = win.start;
    if (win.key === 'all') {
      skelStart = null;
      for (i = 0; i < startedItems.length; i++) {
        var sdi = String(startedItems[i].row.start_date).slice(0, 10);
        if (skelStart === null || sdi < skelStart) skelStart = sdi;
      }
    }
    var skel = skelStart ? periodSkeleton(skelStart, win.end, f.group) : [];
    // Phase 96: completion twin of periodBuckets, keyed by completed_day.
    var cStart = win.start;
    if (win.key === 'all') {
      cStart = null;
      for (i = 0; i < completedItems.length; i++) {
        var cdi = String(completedItems[i].row.completed_day).slice(0, 10);
        if (cStart === null || cdi < cStart) cStart = cdi;
      }
    }
    var cSkel = cStart ? periodSkeleton(cStart, win.end, f.group) : [];
    var cByKey = {};
    for (k = 0; k < cSkel.length; k++) {
      var cb = {
        key: cSkel[k].key, label: cSkel[k].label, ids: emptyTypeLists(), all: [],
        counts: emptyTypeCounts(), total: 0, litres: emptyTypeCounts(), totalLitres: 0
      };
      completedBuckets.push(cb);
      cByKey[cb.key] = cb;
    }
    for (i = 0; i < completedItems.length; i++) {
      var ci = completedItems[i];
      var cbk = cByKey[bucketKeyOf(String(ci.row.completed_day).slice(0, 10), f.group)];
      if (!cbk) continue;
      var cl = batchLitres(ci.row, 'completed', ci.type).l;
      cbk.ids[ci.type].push(ci.row.batch_id);
      cbk.all.push(ci.row.batch_id);
      cbk.counts[ci.type]++;
      cbk.total++;
      cbk.litres[ci.type] += cl;
      cbk.totalLitres += cl;
    }
    for (k = 0; k < skel.length; k++) {
      var pb = {
        key: skel[k].key, label: skel[k].label, ids: emptyTypeLists(), all: [],
        counts: emptyTypeCounts(), total: 0, litres: emptyTypeCounts(), totalLitres: 0
      };
      periodBuckets.push(pb);
      periodByKey[pb.key] = pb;
    }
    for (i = 0; i < startedItems.length; i++) {
      var si = startedItems[i];
      var pbk = periodByKey[bucketKeyOf(String(si.row.start_date).slice(0, 10), f.group)];
      if (!pbk) continue;
      var pl = batchLitres(si.row, 'started', si.type).l;
      pbk.ids[si.type].push(si.row.batch_id);
      pbk.all.push(si.row.batch_id);
      pbk.counts[si.type]++;
      pbk.total++;
      pbk.litres[si.type] += pl;
      pbk.totalLitres += pl;
    }
  }
  for (i = 0; i < startedItems.length; i++) {
    if (startedItems[i].type !== 'wine') continue;
    if (f.staff !== true && isStaffRow(startedItems[i].row, f.staffIds)) { staffHidden++; continue; }
    mixWine.push(startedItems[i].row);
  }

  return {
    ids: idSets,
    litres: litres,
    periodBuckets: periodBuckets,
    completedBuckets: completedBuckets,
    mix: { wine: mixWine, staffHidden: staffHidden },
    earliestStart: earliestStart,
    asOf: asOf,
    window: win,
    activeNow: activeNow,
    pendingCount: pendingCount,
    started: started,
    totals: { all: started, byType: totalsByType },
    completed: completed,
    completedTotals: { all: completed, byType: completedByType },
    monthBuckets: buckets,
    cycle: {
      n: spans.length,
      excluded: excluded,
      median: med === null ? null : Math.round(med),
      mean: mean === null ? null : Math.round(mean),
      byType: cycleByType
    },
    needsType: needsType
  };
}

// Batches whose effective type is 'other' and not manually set. typeById overlays
// { batch_type, batch_type_source } by batch_id onto get_batches rows.
// get_batch / get_batches rows from Postgres carry batch_type_source (null when unclassified).
function hasServerType(b) {
  return !!b && b.batch_type_source !== undefined;
}

function filterBatchesByNeedsType(batches, typeById, scheduleCategoryById) {
  var out = [];
  if (!batches || !batches.length) return out;
  var overlay = typeById || {};
  for (var i = 0; i < batches.length; i++) {
    var b = batches[i];
    if (!b) continue;
    // Review WR-02: a server-provided type on the row (get_batches) is fresher than the overlay.
    var o = hasServerType(b) ? b : (overlay[b.batch_id] || {});
    var merged = {
      batch_type: o.batch_type !== undefined ? o.batch_type : b.batch_type,
      batch_type_source: o.batch_type_source !== undefined ? o.batch_type_source : b.batch_type_source,
      schedule_category: b.schedule_category,
      schedule_id: b.schedule_id,
      category: b.category,
      schedule_snapshot: b.schedule_snapshot,
      status: b.status
    };
    if (isNeedsType(merged, effectiveBatchType(merged, scheduleCategoryById))) out.push(b);
  }
  return out;
}

// Bucket batches by month and beverage type for the Batches-by-Month chart.
// Returns an ordered array (oldest → newest) of:
//   { label: 'Jan', total: N, counts: { wine:N, beer:N, cider:N, seltzer:N, other:N } }
// Accepts an optional `now` param (ISO string or Date) for deterministic testing.
function bucketBatchesByMonthType(batches, scheduleCategoryById, monthsBack, now) {
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var numMonths = monthsBack || 6;
  var refDate = now ? new Date(now) : new Date();
  var refYear = refDate.getFullYear();
  var refMonth = refDate.getMonth(); // 0-based

  // Build ordered bucket list (oldest first)
  var buckets = [];
  var keyToIndex = {};
  for (var i = numMonths - 1; i >= 0; i--) {
    var mo = refMonth - i;
    var yr = refYear;
    while (mo < 0) { mo += 12; yr--; }
    var key = yr + '-' + (mo < 9 ? '0' : '') + (mo + 1);
    var label = months[mo];
    buckets.push({ label: label, key: key, total: 0, counts: { wine: 0, beer: 0, cider: 0, seltzer: 0, other: 0 } });
    keyToIndex[key] = buckets.length - 1;
  }

  if (!batches || !batches.length) return buckets;

  for (var j = 0; j < batches.length; j++) {
    var b = batches[j];
    var dateStr = b.start_date || b.created_at;
    if (!dateStr) continue;
    var batchKey = String(dateStr).slice(0, 7); // 'YYYY-MM'
    if (!(batchKey in keyToIndex)) continue;
    var type = resolveBatchType(b, scheduleCategoryById);
    var idx = keyToIndex[batchKey];
    buckets[idx].counts[type] = (buckets[idx].counts[type] || 0) + 1;
    buckets[idx].total++;
  }

  return buckets;
}

// Build a lookup map { sku -> product } from the catalog products array.
// Structural analog: buildScheduleCategoryById. Skips entries with falsy sku.
// Later duplicate sku wins (last-write).
function buildSkuLookup(products) {
  var map = {};
  if (!products || !products.length) return map;
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    if (p && p.sku) {
      map[String(p.sku)] = p;
    }
  }
  return map;
}

// Normalize a wine kit time string (e.g. '5 week' -> '5 weeks') and extract
// the week count for sorting. Returns { label: <normalized string>, week: <integer> }.
// Singular/plural merge: both '5 week' and '5 weeks' map to label '5 weeks', week 5.
// Non-numeric or empty strings return the trimmed input with week = 9999 (sorts last).
function normalizeWineTime(timeStr) {
  var s = String(timeStr == null ? '' : timeStr).trim(); // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
  var m = s.match(/^(\d+)\s*weeks?/i);
  if (m) {
    var n = parseInt(m[1], 10);
    return { label: n + ' weeks', week: n };
  }
  return { label: s, week: 9999 };
}

// Bucket wine batches by a catalog dimension (subcategory, brand, manufacturer, time)
// over a time window, returning [{label, count}] sorted by:
//   - dimension='time': week number ascending (D-12)
//   - all other dimensions: count descending (D-02)
// 'Unknown' bucket (no catalog match OR empty dimension value) always appended last (D-10).
// Wine membership gate: resolveBatchType(batch, scheduleCategoryById) === 'wine' (D-11).
// Accepts optional `now` param (ISO string or Date) for deterministic testing (D-03).
//
// windowDays: number of days to look back (e.g. 30, 90, 180, 365), or null/0 for All Time.
// Default: 180 days (~6 months). Cutoff is day-precise: batch date >= (now - windowDays days).
function bucketWineDimension(batches, scheduleCategoryById, skuLookup, dimension, windowDays, now) {
  var refDate = now ? new Date(now) : new Date();

  // Compute cutoff date string ('YYYY-MM-DD'). null/0 windowDays = no cutoff (All Time).
  // Use UTC date methods throughout to avoid timezone-dependent off-by-one errors when the
  // `now` param is a 'YYYY-MM-DD' date string (parsed as UTC midnight by Date()).
  var numDays = (windowDays == null || windowDays === 0) ? null : windowDays; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
  var cutoffDateStr = null;
  if (numDays) {
    // Work in UTC milliseconds: subtract (numDays * ms/day) from refDate's UTC timestamp.
    var cutoffMs = refDate.getTime() - (numDays * 86400000);
    var cutoff = new Date(cutoffMs);
    var cy = cutoff.getUTCFullYear();
    var cm = cutoff.getUTCMonth() + 1;
    var cd = cutoff.getUTCDate();
    cutoffDateStr = cy + '-' + (cm < 10 ? '0' : '') + cm + '-' + (cd < 10 ? '0' : '') + cd;
  }

  // Tally: { label: count } and a separate map for time dimension week values
  var tally = {};
  var weekForLabel = {}; // only used for dimension === 'time'
  var unknownCount = 0;

  if (batches && batches.length) {
    for (var j = 0; j < batches.length; j++) {
      var b = batches[j];

      // Wine membership gate (D-11)
      if (resolveBatchType(b, scheduleCategoryById) !== 'wine') continue;

      // Window gate (D-03): use start_date || created_at, compare as 'YYYY-MM-DD' string.
      // ISO date string comparison is lexicographically correct.
      var dateStr = b.start_date || b.created_at;
      if (!dateStr) continue;
      var batchDateStr = String(dateStr).slice(0, 10); // 'YYYY-MM-DD'
      if (cutoffDateStr && batchDateStr < cutoffDateStr) continue;

      // SKU join to derive dimension value
      var product = skuLookup ? skuLookup[String(b.product_sku)] : null;
      var dimValue = product ? product[dimension] : null;

      // Empty or missing dimension value -> 'Unknown' (D-10)
      if (!product || dimValue == null || String(dimValue).trim() === '') { // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        unknownCount++;
        continue;
      }

      // For 'time' dimension: normalize and track week for sort (D-12)
      var label;
      if (dimension === 'time') {
        var norm = normalizeWineTime(String(dimValue));
        label = norm.label;
        weekForLabel[label] = norm.week;
      } else {
        label = String(dimValue).trim();
        if (label === '') { unknownCount++; continue; }
      }

      tally[label] = (tally[label] || 0) + 1;
    }
  }

  // Convert tally to array
  var result = [];
  for (var lbl in tally) {
    if (Object.prototype.hasOwnProperty.call(tally, lbl)) {
      result.push({ label: lbl, count: tally[lbl] });
    }
  }

  // Sort: time dimension by week ascending; others by count descending (D-02, D-12)
  if (dimension === 'time') {
    result.sort(function (a, b) {
      var wa = weekForLabel[a.label] != null ? weekForLabel[a.label] : 9999; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      var wb = weekForLabel[b.label] != null ? weekForLabel[b.label] : 9999; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      return wa - wb;
    });
  } else {
    result.sort(function (a, b) { return b.count - a.count; });
  }

  // Always append 'Unknown' last (D-10)
  if (unknownCount > 0) {
    result.push({ label: 'Unknown', count: unknownCount });
  }

  return result;
}

// Collapse a dimension bucket list to top N + 'Other', keeping 'Unknown' last (D-07..D-10).
// Pure -- does not mutate the input array.
// If distinct non-Unknown values <= n, returns them + Unknown (if present) in original order.
// If > n, keeps n highest-count, folds remainder into { label:'Other', count:sum },
// appends 'Other' after the top-n, then appends 'Unknown' last (D-09).
function applyTopN(buckets, n) {
  if (!buckets || !buckets.length) return [];

  // Pull out 'Unknown' bucket
  var unknownBucket = null;
  var normal = [];
  for (var i = 0; i < buckets.length; i++) {
    if (buckets[i].label === 'Unknown') {
      unknownBucket = buckets[i];
    } else {
      normal.push({ label: buckets[i].label, count: buckets[i].count });
    }
  }

  var result;
  if (normal.length <= n) {
    // No collapsing needed -- preserve existing order
    result = normal.slice();
  } else {
    // Sort by count descending, take top n, fold rest into 'Other'
    var sorted = normal.slice().sort(function (a, b) { return b.count - a.count; });
    var top = sorted.slice(0, n);
    var tail = sorted.slice(n);
    var otherSum = 0;
    for (var j = 0; j < tail.length; j++) { otherSum += tail[j].count; }
    result = top;
    result.push({ label: 'Other', count: otherSum }); // 'Other' after top-N (D-09)
  }

  // 'Unknown' always appended last (D-10)
  if (unknownBucket) {
    result.push(unknownBucket);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 95-04: v2 dashboard filter state, display strings, deltas, wine buckets.
// All pure: storage and URL access happen in the render layer.
// ---------------------------------------------------------------------------
var DASH_FILTER_DEFAULTS = { type: 'all', period: 'ytd', group: 'month', measure: 'batches', source: 'all', staff: '0', from: '', to: '' };
var DASH_FILTER_KEYS = ['type', 'period', 'group', 'measure', 'source', 'staff', 'from', 'to'];
var DASH_FILTER_WHITELIST = {
  type: ['all', 'wine', 'beer', 'cider'],
  period: ['30d', '90d', '6mo', '12mo', 'ytd', 'all', 'custom'],
  group: ['week', 'month'],
  measure: ['batches', 'litres'],
  source: ['all', 'kiosk', 'online', 'manual', 'zoho_scan', 'research', 'internal', 'unknown'],
  staff: ['0', '1']
};
var DASH_SOURCE_LABELS = { kiosk: 'Kiosk', online: 'Online', manual: 'Manual', zoho_scan: 'Zoho scan', research: 'Research', internal: 'Internal', unknown: 'Unknown' };

function parseDashHash(hash) {
  var out = {};
  var s = String(hash || '').replace(/^#/, '');
  if (!s) return out;
  var parts = s.split('&');
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    if (eq < 1) continue;
    try {
      out[decodeURIComponent(parts[i].slice(0, eq))] = decodeURIComponent(parts[i].slice(eq + 1));
    } catch (e) { /* malformed pair skipped */ }
  }
  return out;
}

function dashWhitelisted(key, val) {
  var list = DASH_FILTER_WHITELIST[key];
  for (var i = 0; i < list.length; i++) {
    if (list[i] === val) return list[i];
  }
  return DASH_FILTER_DEFAULTS[key];
}

// Builds a fresh state object from whitelisted literals only (T-95-15).
function sanitizeDashFilters(raw, today) {
  var r = (raw && typeof raw === 'object') ? raw : {};
  var out = {
    type: dashWhitelisted('type', r.type),
    period: dashWhitelisted('period', r.period),
    group: dashWhitelisted('group', r.group),
    measure: dashWhitelisted('measure', r.measure),
    source: dashWhitelisted('source', r.source),
    staff: dashWhitelisted('staff', r.staff),
    from: '',
    to: ''
  };
  if (out.period === 'custom') {
    if (isRealYmd(r.from) && isRealYmd(r.to) && r.from <= r.to && r.to <= today) {
      out.from = r.from;
      out.to = r.to;
    } else {
      out.period = 'ytd';
    }
  }
  return out;
}

function resolveDashFilters(hash, storedJson, today) {
  var parsed = parseDashHash(hash);
  var authoritative = parsed.dash === 'v2';
  for (var i = 0; i < DASH_FILTER_KEYS.length && !authoritative; i++) {
    if (Object.prototype.hasOwnProperty.call(parsed, DASH_FILTER_KEYS[i])) authoritative = true;
  }
  if (authoritative) return sanitizeDashFilters(parsed, today);
  if (storedJson) {
    try {
      var st = JSON.parse(storedJson);
      if (st && typeof st === 'object') return sanitizeDashFilters(st, today);
    } catch (e) { /* corrupted storage -> defaults */ }
  }
  return sanitizeDashFilters({}, today);
}

function serializeDashFilters(state) {
  var s = state || {};
  var out = 'dash=v2';
  var keys = ['type', 'period', 'group', 'measure', 'source', 'staff'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (s[k] !== undefined && s[k] !== DASH_FILTER_DEFAULTS[k]) out += '&' + k + '=' + encodeURIComponent(s[k]);
  }
  if (s.period === 'custom') {
    out += '&from=' + encodeURIComponent(s.from || '') + '&to=' + encodeURIComponent(s.to || '');
  }
  return out;
}

function dashV2FlagFrom(search, hash, storedFlag) {
  var q = String(search || '');
  if (/[?&]dash=v2(&|$)/.test(q) || parseDashHash(hash).dash === 'v2') return { on: true, persist: '1' };
  if (/[?&]dash=v1(&|$)/.test(q)) return { on: false, persist: '0' };
  return { on: storedFlag === '1', persist: null };
}

function dashShortDate(ymd) {
  return DASH_MONTH_LABELS[+String(ymd).slice(5, 7) - 1] + ' ' + (+String(ymd).slice(8, 10));
}

function dashPeriodLabel(state) {
  var p = state && state.period;
  if (p === '6mo') return '6m';
  if (p === '12mo') return '12m';
  if (p === 'ytd') return 'YTD';
  if (p === 'all') return 'All';
  if (p === 'custom') return dashShortDate(state.from) + ' – ' + dashShortDate(state.to);
  return String(p || '');
}

function dashFilterSummary(state) {
  var s = state || DASH_FILTER_DEFAULTS;
  var parts = [
    dashPeriodLabel(s),
    s.group === 'week' ? 'Week' : 'Month',
    s.measure === 'litres' ? 'Litres' : 'Batches',
    DASH_TYPE_LABELS[s.type] || 'All'
  ];
  if (s.source && s.source !== 'all') parts.push(DASH_SOURCE_LABELS[s.source] || s.source);
  if (s.staff === '1') parts.push('Staff');
  return parts.join(' · ');
}

function countNonDefaultFilters(state) {
  var s = state || {};
  var keys = ['type', 'period', 'group', 'measure', 'source', 'staff'];
  var n = 0;
  for (var i = 0; i < keys.length; i++) {
    if (s[keys[i]] !== undefined && s[keys[i]] !== DASH_FILTER_DEFAULTS[keys[i]]) n++;
  }
  return n;
}

// Phase 95-06: current/previous model for the v2 dashboard (pure).
function buildDashV2Model(rows, asOf, state, staffIds, catMap) {
  var st = state || DASH_FILTER_DEFAULTS;
  var today = asOf.today;
  // Review WR-02: the range was validated against the client's today, but the aggregate's
  // asOf.today can be a day behind (fetched before midnight). Clamp the end to asOf.today
  // instead of silently falling back to YTD, and label from the window actually used.
  var winState = st;
  if (st.period === 'custom' && isRealYmd(st.from) && isRealYmd(st.to) && st.from <= today && st.to > today) {
    winState = { period: 'custom', from: st.from, to: today };
  }
  var win = windowFromFilters(winState, today);
  var prevWin = previousWindow(win, today);
  var periodLabel = win.key === 'custom' ?
    dashShortDate(win.start) + ' – ' + dashShortDate(win.end) :
    dashPeriodLabel({ period: win.key });
  function run(range) {
    return getDashboardData(rows, asOf, {
      range: range,
      window: range.key,
      type: st.type,
      source: st.source,
      staff: st.staff === '1',
      staffIds: staffIds || {},
      group: st.group,
      scheduleCategoryById: catMap || {}
    });
  }
  var cur = run(win);
  var prev = prevWin ? run(prevWin) : null;
  var insufficient = !prevWin || !cur.earliestStart || prevWin.start < cur.earliestStart;
  return { state: st, win: win, prevWin: prevWin, cur: cur, prev: prev, insufficient: insufficient, periodLabel: periodLabel };
}

function dashGroupThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function dashDeltaSuffix(win, prevWin) {
  var k = win && win.key;
  if (k === '30d' || k === '90d') return 'vs prev ' + k;
  if (k === '6mo') return 'vs prev 6m';
  if (k === '12mo') return 'vs prev 12m';
  if (k === 'ytd') return 'vs same period last year';
  if (k === 'custom') return 'vs prior ' + (prevWin && prevWin.days) + ' days';
  return null;
}

function dashDeltaAriaTail(win, prevWin) {
  var k = win && win.key;
  if (k === '30d') return 'previous 30 days';
  if (k === '90d') return 'previous 90 days';
  if (k === '6mo') return 'previous 6 months';
  if (k === '12mo') return 'previous 12 months';
  if (k === 'ytd') return 'the same period last year';
  return 'the prior ' + (prevWin && prevWin.days) + ' days';
}

function formatDelta(cur, prev, opts) {
  var o = opts || {};
  var win = o.win || {};
  if (win.key === 'all') return null;
  var none = { text: 'No earlier data to compare', dir: 'none', tone: 'neutral', aria: 'No earlier data to compare' };
  if (o.insufficient || cur === null || cur === undefined || prev === null || prev === undefined) return none;
  var suffix = dashDeltaSuffix(win, o.prevWin);
  var tail = dashDeltaAriaTail(win, o.prevWin);
  var kind = o.kind || 'count';
  var diff = Math.round(cur - prev);
  if (diff === 0) {
    return { text: '– no change ' + suffix, dir: 'flat', tone: 'neutral', aria: 'No change compared with ' + tail };
  }
  var up = diff > 0;
  var abs = Math.abs(diff);
  var num;
  var unitWord;
  if (kind === 'litres') { num = dashGroupThousands(abs) + ' L'; unitWord = abs === 1 ? 'litre' : 'litres'; }
  else if (kind === 'days') { num = abs + 'd'; unitWord = abs === 1 ? 'day' : 'days'; }
  else { num = String(abs); unitWord = ''; }
  var text = (up ? '▲ ' : '▼ ') + num;
  if (prev >= 5 && Math.abs(cur - prev) / prev >= 0.10) {
    var pct = Math.round((cur - prev) / prev * 100);
    text += ' (' + (pct > 0 ? '+' : '') + pct + '%)';
  }
  text += ' ' + suffix;
  var good = kind === 'days' ? !up : up;
  return {
    text: text,
    dir: up ? 'up' : 'down',
    tone: good ? 'good' : 'bad',
    aria: (up ? 'Up ' : 'Down ') + dashGroupThousands(abs) + (unitWord ? ' ' + unitWord : '') + ' compared with ' + tail
  };
}

function dashDrillLabel(spec) {
  var sp = spec || {};
  var t = sp.typeLabel ? String(sp.typeLabel) : '';
  var verb = sp.verb;
  var head;
  if (verb === 'fermenting') {
    head = (t ? t + ' fermenting now' : 'Fermenting now');
  } else if (verb === 'cycle') {
    head = (t ? t + ' days to complete' : 'Days to complete') + ', ' + (sp.periodLabel || '');
  } else if (sp.bucketLabel) {
    head = (t ? t + ' ' + verb : verb.charAt(0).toUpperCase() + verb.slice(1)) + ' in ' + sp.bucketLabel;
  } else {
    head = (t ? t + ' ' + verb : verb.charAt(0).toUpperCase() + verb.slice(1)) + (sp.periodLabel ? ' ' + sp.periodLabel : '');
  }
  var count = Number(sp.count) || 0;
  var out = 'From dashboard: ' + head + ' · ' + count + (count === 1 ? ' batch' : ' batches');
  if (sp.litres !== undefined && sp.litres !== null && Number(sp.litres) > 0) {
    out += ' (' + dashGroupThousands(Math.round(Number(sp.litres))) + ' L)';
  }
  return out;
}

// Same override rules as the v1 inline merge in renderDashboard; input not mutated.
function mergeWineSkuLookup(lookup, rows) {
  var merged = {};
  var k;
  var src = lookup || {};
  for (k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) merged[k] = src[k];
  }
  var pairs = [['subcategory', 'product_subcategory'], ['brand', 'product_brand'], ['manufacturer', 'product_manufacturer']];
  var list = rows || [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || !r.product_sku) continue;
    var ov = {};
    var any = false;
    for (var p = 0; p < pairs.length; p++) {
      if (r[pairs[p][1]]) { ov[pairs[p][0]] = r[pairs[p][1]]; any = true; }
    }
    if (!any) continue;
    var sku = String(r.product_sku);
    var combined = {};
    var base = src[sku];
    if (base) { for (k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) combined[k] = base[k]; } }
    for (k in ov) { if (Object.prototype.hasOwnProperty.call(ov, k)) combined[k] = ov[k]; }
    merged[sku] = combined;
  }
  return merged;
}

// Wine rows (already gated to wine + window upstream) -> [{label, count, ids}].
// Same sort / top-N / Other / Unknown-last rules as bucketWineDimension + applyTopN.
function wineBreakdownBuckets(rows, skuLookup, dimension, topN) {
  var tally = {};
  var weekFor = {};
  var unknownIds = [];
  var list = rows || [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var product = skuLookup ? skuLookup[String(r.product_sku)] : null;
    var dv = product ? product[dimension] : null;
    if (!product || dv === null || dv === undefined || String(dv).trim() === '') { unknownIds.push(r.batch_id); continue; }
    var label;
    if (dimension === 'time') {
      var norm = normalizeWineTime(String(dv));
      label = norm.label;
      weekFor[label] = norm.week;
    } else {
      label = String(dv).trim();
    }
    if (!Object.prototype.hasOwnProperty.call(tally, label)) tally[label] = [];
    tally[label].push(r.batch_id);
  }
  var normal = [];
  for (var lbl in tally) {
    if (Object.prototype.hasOwnProperty.call(tally, lbl)) normal.push({ label: lbl, count: tally[lbl].length, ids: tally[lbl] });
  }
  if (dimension === 'time') {
    normal.sort(function (a, b) { return weekFor[a.label] - weekFor[b.label]; });
  } else {
    normal.sort(function (a, b) { return b.count - a.count; });
  }
  var result = normal;
  if (topN && normal.length > topN) {
    var sorted = normal.slice().sort(function (a, b) { return b.count - a.count; });
    result = sorted.slice(0, topN);
    var otherIds = [];
    for (var j = topN; j < sorted.length; j++) otherIds = otherIds.concat(sorted[j].ids);
    result.push({ label: 'Other', count: otherIds.length, ids: otherIds });
  }
  if (unknownIds.length) result.push({ label: 'Unknown', count: unknownIds.length, ids: unknownIds });
  return result;
}

// ===== Phase 96-03: shared pure helpers (one model, two renderers) =====
var DASH_TASK_KINDS = [
  { key: 'transfer', label: 'Racking / transfer' },
  { key: 'filtering', label: 'Filtering' },
  { key: 'packaging', label: 'Packaging' },
  { key: 'temp', label: 'Temperature step' },
  { key: 'other', label: 'Other' }
];

// Subject text is raw; escape at render.
function dashDrillSubject(subject, count) {
  var n = Number(count) || 0;
  return 'From dashboard: ' + String(subject || '') + ' · ' + n + (n === 1 ? ' batch' : ' batches');
}

// Same classification path as getDashboardData (effectiveBatchType + sourceMatches + isStaffRow).
function dashClassifyRows(rows, opts) {
  var o = opts || {};
  var typeFilter = o.type || 'all';
  var catMap = o.scheduleCategoryById || {};
  var list = [];
  var byId = {};
  var src = rows || [];
  for (var i = 0; i < src.length; i++) {
    var r = src[i];
    if (!r) continue;
    var t = effectiveBatchType(r, catMap);
    if (typeFilter !== 'all' && t !== typeFilter) continue;
    if (!sourceMatches(r, o.source)) continue;
    var staff = isStaffRow(r, o.staffIds);
    if (o.staff === false && staff) continue;
    var item = { row: r, type: t, status: String(r.status || '').toLowerCase(), staff: staff };
    list.push(item);
    byId[r.batch_id] = item;
  }
  return { list: list, byId: byId };
}

function dashTaskKind(task) {
  var t = task || {};
  var title = String(t.title || '');
  if (t.is_packaging === true) return 'packaging';
  if (t.is_transfer === true) return 'transfer';
  if (/bottl|packag/i.test(title)) return 'packaging';
  if (/rack/i.test(title)) return 'transfer';
  if (/filter/i.test(title)) return 'filtering';
  if (/^(lower|crash|raise|warm|cool|chill)\b/i.test(title) || /[0-9]\s*[º°]\s*c\b/i.test(title)) return 'temp';
  return 'other';
}

// Group items by valueOf(item); blank -> 'Unspecified' (last); overflow -> 'Other (n more)' before it.
function dashBreakdownBuckets(items, valueOf, topN, litresOf) {
  var tally = {};
  var order = [];
  var blank = { label: 'Unspecified', count: 0, litres: 0, ids: [] };
  var list = items || [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    var raw = valueOf(it);
    var label = (raw === null || raw === undefined) ? '' : String(raw).trim();
    var l = litresOf ? (Number(litresOf(it)) || 0) : 0;
    var id = it && it.row ? it.row.batch_id : (it ? it.batch_id : undefined);
    var b;
    if (label === '') {
      b = blank;
    } else {
      if (!Object.prototype.hasOwnProperty.call(tally, label)) {
        tally[label] = { label: label, count: 0, litres: 0, ids: [] };
        order.push(label);
      }
      b = tally[label];
    }
    b.count++;
    b.litres += l;
    b.ids.push(id);
  }
  var named = [];
  for (var j = 0; j < order.length; j++) named.push(tally[order[j]]);
  named.sort(function (a, b2) {
    if (b2.count !== a.count) return b2.count - a.count;
    return a.label < b2.label ? -1 : (a.label > b2.label ? 1 : 0);
  });
  var out = named;
  if (topN && named.length > topN) {
    out = named.slice(0, topN);
    var rest = named.slice(topN);
    var other = { label: 'Other (' + rest.length + ' more)', count: 0, litres: 0, ids: [] };
    for (var k = 0; k < rest.length; k++) {
      other.count += rest[k].count;
      other.litres += rest[k].litres;
      other.ids = other.ids.concat(rest[k].ids);
    }
    out.push(other);
  }
  if (blank.count) out.push(blank);
  return out;
}

// Widget/control keys are restricted to [a-z0-9_] so data-* attributes cannot carry markup.
function dashKey(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[^a-z0-9_]/gi, '').toLowerCase();
}

function dashSegHtml(widget, ctl, choices, selected, ariaLabel) {
  var html = '<div class="bp-seg" role="radiogroup" aria-label="' + escapeHTML(ariaLabel) + '">';
  for (var i = 0; i < choices.length; i++) {
    var val = String(choices[i][0]);
    var on = val === String(selected);
    html += '<button type="button" class="bp-seg-btn" role="radio" aria-checked="' + (on ? 'true' : 'false') + '"' +
      ' tabindex="' + (on ? '0' : '-1') + '" data-dash-w="' + dashKey(widget) + ':' + dashKey(ctl) + ':' + dashKey(val) + '">' +
      escapeHTML(choices[i][1]) + '</button>';
  }
  return html + '</div>';
}

function dashSelectHtml(widget, ctl, choices, selected, ariaLabel) {
  var html = '<select class="bp-select" data-dash-wsel="' + dashKey(widget) + ':' + dashKey(ctl) + '" aria-label="' + escapeHTML(ariaLabel) + '">';
  for (var i = 0; i < choices.length; i++) {
    var val = String(choices[i][0]);
    html += '<option value="' + escapeHTML(val) + '"' + (val === String(selected) ? ' selected' : '') + '>' + escapeHTML(choices[i][1]) + '</option>';
  }
  return html + '</select>';
}

function dashViewToggleHtml(widget, view) {
  return dashSegHtml(widget, 'view', [['chart', 'Chart'], ['table', 'Table']], view === 'table' ? 'table' : 'chart', 'View as');
}

function dashTableHtml(widget, model) {
  var m = model || {};
  var cols = m.columns || [];
  var rows = m.rows || [];
  var w = dashKey(widget);
  var html = '<div class="bp-table-wrap"><table class="bp-table"><caption class="bp-visually-hidden">' + escapeHTML(m.caption) + '</caption><thead><tr>';
  var i;
  for (i = 0; i < cols.length; i++) {
    html += '<th scope="col"' + (cols[i].numeric ? ' class="bp-num"' : '') + '>' + escapeHTML(cols[i].label) + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (i = 0; i < rows.length; i++) {
    html += '<tr' + (rows[i].total ? ' class="bp-table-total"' : '') + '>';
    var cells = rows[i].cells || [];
    for (var c = 0; c < cells.length; c++) {
      var cell = cells[c];
      var numeric = cols[c] && cols[c].numeric;
      var inner = escapeHTML(cell.text);
      if (cell.drill !== undefined && cell.drill !== null) {
        inner = '<button type="button" class="bp-table-link" data-dash-row="' + w + ':' + (parseInt(cell.drill, 10) || 0) + '">' + inner + '</button>';
      }
      html += '<td' + (numeric ? ' class="bp-num"' : '') + '>' + inner + '</td>';
    }
    html += '</tr>';
  }
  return html + '</tbody></table></div>';
}

function dashListHtml(widget, listKey, items, opts) {
  var o = opts || {};
  var limit = o.limit || 5;
  var list = items || [];
  var w = dashKey(widget);
  if (!list.length) return '<p class="bp-empty">' + escapeHTML(o.emptyText) + '</p>';
  var shown = o.expanded ? list : list.slice(0, limit);
  var html = '<div class="bp-list">';
  for (var i = 0; i < shown.length; i++) {
    var it = shown[i];
    var body = '<span class="bp-list-main"><span class="bp-list-primary">' + escapeHTML(it.primary) + '</span>' +
      (it.secondary ? '<span class="bp-list-row-sub">' + escapeHTML(it.secondary) + '</span>' : '') + '</span>' +
      '<span class="bp-list-right">' + escapeHTML(it.right) + '</span>';
    if (it.drill !== undefined && it.drill !== null) {
      html += '<button type="button" class="bp-list-row" data-dash-row="' + w + ':' + dashKey(it.drill) + '">' + body +
        '<span class="bp-list-chev" aria-hidden="true">›</span></button>';
    } else {
      html += '<div class="bp-list-row">' + body + '</div>';
    }
  }
  html += '</div>';
  if (list.length > limit) {
    html += '<button type="button" class="bp-text-btn" data-dash-showall="' + w + ':' + dashKey(listKey) + '" aria-expanded="' +
      (o.expanded ? 'true' : 'false') + '">' + (o.expanded ? 'Show fewer' : 'Show all ' + list.length) + '</button>';
  }
  return html;
}

// ===== Phase 96-04: G1 Production over time (pure model; one model feeds chart and table) =====
var DASH_G1_DEFS = [['wine', 'Wine'], ['cider', 'Cider'], ['beer', 'Beer'], ['other', 'Other']];

function dashG1BucketIds(bk, key) {
  if (key === 'other') return bk.ids.seltzer.concat(bk.ids.other);
  if (key) return bk.ids[key];
  return bk.all;
}

function dashG1Drill(bk, key, mode) {
  var ids = dashG1BucketIds(bk, key);
  var typeLabel = key ? (key === 'other' ? 'Other' : (DASH_TYPE_LABELS[key] || '')) : '';
  return {
    ids: ids.slice(),
    label: dashDrillLabel({ typeLabel: typeLabel, verb: mode === 'completed' ? 'completed' : 'started', bucketLabel: bk.label, count: ids.length })
  };
}

function buildG1Model(model, mode) {
  var cur = model.cur;
  var st = model.state;
  var m = mode === 'completed' ? 'completed' : 'started';
  var lit = st.measure === 'litres';
  var buckets = (m === 'completed' ? cur.completedBuckets : cur.periodBuckets) || [];
  var theme = readChartTheme();
  var colours = { wine: theme.wine, cider: theme.cider, beer: theme.beer, other: theme.other };
  var only = st.type === 'all' ? null : (st.type === 'seltzer' ? 'other' : st.type);
  var by = st.group === 'week' ? 'week' : 'month';
  var labels = [];
  var series = [];
  var parts = [];
  var totals = [];
  var i;
  var d;
  for (i = 0; i < buckets.length; i++) {
    labels.push(buckets[i].label);
    var tv = lit ? buckets[i].totalLitres : buckets[i].total;
    totals.push(lit ? Math.round(tv * 10) / 10 : tv);
  }
  for (d = 0; d < DASH_G1_DEFS.length; d++) {
    var key = DASH_G1_DEFS[d][0];
    if (only && key !== only) continue;
    var data = [];
    var sum = 0;
    for (i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      var v;
      if (lit) v = key === 'other' ? b.litres.seltzer + b.litres.other : b.litres[key];
      else v = key === 'other' ? b.counts.seltzer + b.counts.other : b.counts[key];
      v = lit ? Math.round(v * 10) / 10 : v;
      data.push(v);
      sum += v;
    }
    series.push({ key: key, label: DASH_G1_DEFS[d][1], data: data, colour: colours[key] });
    if (sum > 0) parts.push(DASH_G1_DEFS[d][1] + ' ' + (lit ? dashGroupThousands(Math.round(sum)) + ' L' : sum));
  }
  var noun = (m === 'completed' ? 'Completed ' : 'Started ') + (lit ? 'litres' : 'batches');
  var subtitle = noun + ' · ' + model.periodLabel + ' · by ' + by;
  if (lit && cur.litres.estimated) subtitle += ' · litres estimated from standard batch sizes';
  function fmt(v) { return lit ? dashGroupThousands(Math.round(v)) + ' L' : String(v); }
  var columns = [{ label: 'Period' }];
  for (d = 0; d < series.length; d++) columns.push({ label: series[d].label, numeric: true });
  columns.push({ label: 'Total', numeric: true });
  var rows = [];
  for (i = buckets.length - 1; i >= 0; i--) {
    var cells = [{ text: buckets[i].label }];
    for (d = 0; d < series.length; d++) {
      var val = series[d].data[i];
      var cell = { text: fmt(val), value: val };
      if (val > 0) { var dr = dashG1Drill(buckets[i], series[d].key, m); cell.ids = dr.ids; cell.label = dr.label; }
      cells.push(cell);
    }
    var tcell = { text: fmt(totals[i]), value: totals[i] };
    if (buckets[i].total > 0) { var td = dashG1Drill(buckets[i], null, m); tcell.ids = td.ids; tcell.label = td.label; }
    cells.push(tcell);
    rows.push({ cells: cells });
  }
  return {
    mode: m,
    labels: labels,
    series: series,
    buckets: buckets,
    totals: totals,
    subtitle: subtitle,
    ariaLabel: noun + ' by ' + by + ', ' + model.periodLabel + '. ' + parts.join(', '),
    measure: lit ? 'litres' : 'batches',
    empty: (m === 'completed' ? cur.completed : cur.started) === 0,
    table: { caption: noun + ' by ' + by + ', ' + model.periodLabel, columns: columns, rows: rows }
  };
}

// ===== Phase 96-05: G2 Pipeline and G3 Cycle time (pure models; one model feeds chart and table) =====
var DASH_PIPELINE_STAGES = [['pending', 'Pending'], ['primary', 'Primary'], ['secondary', 'Secondary'], ['ready', 'Ready to bottle'], ['complete', 'Complete'], ['other', 'Other stage']];
var DASH_PROD_SERIES = [['wine', 'Wine'], ['cider', 'Cider'], ['beer', 'Beer'], ['other', 'Other']];

// Series key for a batch type: seltzer folds into Other (as in G1).
function dashProdKey(type) {
  return (type === 'wine' || type === 'cider' || type === 'beer') ? type : 'other';
}

// The visible series for the global Type: all four under All, else just the one.
function dashProdSeries(typeFilter) {
  if (!typeFilter || typeFilter === 'all') return DASH_PROD_SERIES.slice();
  var k = dashProdKey(typeFilter);
  for (var i = 0; i < DASH_PROD_SERIES.length; i++) {
    if (DASH_PROD_SERIES[i][0] === k) return [DASH_PROD_SERIES[i]];
  }
  return DASH_PROD_SERIES.slice();
}

// G2. Ready to bottle (pinned definition): an active (primary/secondary) batch whose batch_id is in the
// server-computed summary.readyToBottle set (batch-rules buildDashboardSummary: an incomplete packaging
// task AND either every non-packaging task done or the packaging due date reached). It takes precedence
// over Primary/Secondary so each batch appears once. Complete counts only the model window. Statuses
// outside pending/primary/secondary/complete land in 'Other stage' (row shown only when non-empty).
function buildG2Model(rows, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var cls = dashClassifyRows(rows, { type: st.type, source: st.source, staffIds: c.staffIds, scheduleCategoryById: c.catMap });
  var ready = c.readyIds || {};
  var series = dashProdSeries(st.type);
  var theme = readChartTheme();
  var colours = { wine: theme.wine, cider: theme.cider, beer: theme.beer, other: theme.other };
  var cells = {};
  var i;
  var s;
  for (i = 0; i < DASH_PIPELINE_STAGES.length; i++) {
    cells[DASH_PIPELINE_STAGES[i][0]] = { wine: [], cider: [], beer: [], other: [] };
  }
  for (i = 0; i < cls.list.length; i++) {
    var it = cls.list[i];
    var id = it.row.batch_id;
    var stage = null;
    if (it.status === 'pending') stage = 'pending';
    else if ((it.status === 'primary' || it.status === 'secondary') && ready[id] === true) stage = 'ready';
    else if (it.status === 'primary') stage = 'primary';
    else if (it.status === 'secondary') stage = 'secondary';
    else if (it.status === 'complete') stage = inWindow(it.row.completed_day, model.win) ? 'complete' : null;
    else stage = 'other';
    if (stage) cells[stage][dashProdKey(it.type)].push(id);
  }
  var stageRows = [];
  var labels = [];
  var stageTotals = [];
  for (i = 0; i < DASH_PIPELINE_STAGES.length; i++) {
    var sk = DASH_PIPELINE_STAGES[i][0];
    var all = [];
    for (s = 0; s < series.length; s++) all = all.concat(cells[sk][series[s][0]]);
    if (sk === 'other' && !all.length) continue;
    stageRows.push({ key: sk, label: DASH_PIPELINE_STAGES[i][1], ids: all });
    labels.push(DASH_PIPELINE_STAGES[i][1]);
    stageTotals.push(all.length);
  }
  var out = [];
  var grand = 0;
  for (s = 0; s < series.length; s++) {
    var data = [];
    for (i = 0; i < stageRows.length; i++) data.push(cells[stageRows[i].key][series[s][0]].length);
    out.push({ key: series[s][0], label: series[s][1], data: data, colour: colours[series[s][0]] });
  }
  for (i = 0; i < stageTotals.length; i++) grand += stageTotals[i];
  function subjectFor(stageKey, stageLabel, typeLabel) {
    if (stageKey === 'complete') return (typeLabel ? typeLabel + ' completed ' : 'Completed ') + model.periodLabel;
    return (typeLabel ? typeLabel + ' at ' : 'Batches at ') + stageLabel;
  }
  var columns = [{ label: 'Stage' }];
  for (s = 0; s < series.length; s++) columns.push({ label: series[s][1], numeric: true });
  columns.push({ label: 'Total', numeric: true });
  var tRows = [];
  var parts = [];
  for (i = 0; i < stageRows.length; i++) {
    var sr = stageRows[i];
    var tc = [{ text: sr.label }];
    for (s = 0; s < series.length; s++) {
      var sids = cells[sr.key][series[s][0]];
      var cell = { text: String(sids.length), value: sids.length };
      if (sids.length) { cell.ids = sids.slice(); cell.subject = subjectFor(sr.key, sr.label, series[s][1]); }
      tc.push(cell);
    }
    var tot = { text: String(sr.ids.length), value: sr.ids.length };
    if (sr.ids.length) { tot.ids = sr.ids.slice(); tot.subject = subjectFor(sr.key, sr.label, ''); }
    tc.push(tot);
    tRows.push({ cells: tc });
    parts.push(sr.label + ' ' + sr.ids.length);
  }
  return {
    labels: labels,
    stages: stageRows,
    series: out,
    cells: cells,
    totals: stageTotals,
    subtitle: 'Active batches by stage · right now',
    note: 'Complete counts batches finished in ' + model.periodLabel,
    ariaLabel: 'Pipeline, batches by stage. ' + parts.join(', '),
    empty: grand === 0,
    subjectFor: subjectFor,
    table: { caption: 'Pipeline, batches by stage', columns: columns, rows: tRows }
  };
}

// Nearest-rank 95th percentile; null for an empty list.
function dashP95(nums) {
  if (!nums || !nums.length) return null;
  var a = nums.slice().sort(function (x, y) { return x - y; });
  return a[Math.ceil(0.95 * a.length) - 1];
}

// G3 product value for the optional Product select (single global Type only).
function dashCycleProduct(type, row, meta, lookup) {
  var v = '';
  if (type === 'wine') {
    var p = lookup ? lookup[String(row.product_sku)] : null;
    v = (p && p.subcategory) || row.product_subcategory || '';
  } else if (type === 'beer') {
    v = (meta && meta.recipe_style) || '';
  } else if (type === 'cider') {
    v = (meta && meta.recipe_name) || row.product_name || '';
  }
  return String(v === null || v === undefined ? '' : v).trim();
}

function buildG3Model(rows, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var meta = c.batchMeta || {};
  var cls = dashClassifyRows(rows, { type: st.type, source: st.source, staffIds: c.staffIds, scheduleCategoryById: c.catMap });
  var series = dashProdSeries(st.type);
  var theme = readChartTheme();
  var colours = { wine: theme.wine, cider: theme.cider, beer: theme.beer, other: theme.other };
  var single = (st.type === 'wine' || st.type === 'beer' || st.type === 'cider') ? st.type : null;
  var lookup = single === 'wine' ? mergeWineSkuLookup(c.lookup, rows) : null;
  var set = [];
  var i;
  var s;
  for (i = 0; i < cls.list.length; i++) {
    var it = cls.list[i];
    if (it.status !== 'complete' || !inWindow(it.row.completed_day, model.win)) continue;
    var span = cycleDays(it.row.start_date, it.row.completed_day);
    if (span === null) continue;
    set.push({ item: it, span: span, key: dashProdKey(it.type) });
  }
  // Product choices come from the whole set, alphabetical after 'All products'.
  var choices = [['all', 'All products']];
  var product = 'all';
  var filtered = set;
  if (single) {
    var seen = {};
    var names = [];
    for (i = 0; i < set.length; i++) {
      var pv = dashCycleProduct(single, set[i].item.row, meta[set[i].item.row.batch_id], lookup);
      set[i].product = pv;
      if (pv && !Object.prototype.hasOwnProperty.call(seen, pv)) { seen[pv] = true; names.push(pv); }
    }
    names.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
    for (i = 0; i < names.length; i++) choices.push([names[i], names[i]]);
    if (c.product && c.product !== 'all' && Object.prototype.hasOwnProperty.call(seen, c.product)) {
      product = c.product;
      filtered = set.filter(function (e) { return e.product === product; });
    }
  }
  var spans = filtered.map(function (e) { return e.span; });
  var p95 = dashP95(spans);
  var N = p95 === null ? 7 : Math.max(7, Math.ceil(p95 / 7) * 7);
  var nBins = N / 7 + 1;
  var binLabels = [];
  for (i = 0; i < nBins - 1; i++) binLabels.push((i * 7) + '–' + (i * 7 + 6));
  binLabels.push(N + '+');
  var binIds = [];
  for (i = 0; i < nBins; i++) binIds.push({ wine: [], cider: [], beer: [], other: [] });
  for (i = 0; i < filtered.length; i++) {
    var bi = filtered[i].span >= N ? nBins - 1 : Math.floor(filtered[i].span / 7);
    binIds[bi][filtered[i].key].push(filtered[i].item.row.batch_id);
  }
  var out = [];
  var vLines = [];
  for (s = 0; s < series.length; s++) {
    var sk = series[s][0];
    var data = [];
    for (i = 0; i < nBins; i++) data.push(binIds[i][sk].length);
    out.push({ key: sk, label: series[s][1], data: data, colour: colours[sk] });
    var planned = [];
    for (i = 0; i < filtered.length; i++) {
      if (filtered[i].key !== sk) continue;
      var pd = Number((meta[filtered[i].item.row.batch_id] || {}).planned_days);
      if (pd > 0) planned.push(pd);
    }
    if (planned.length) {
      var pm = Math.round(medianOf(planned));
      vLines.push({ key: sk, median: pm, value: Math.min(pm, N) / 7 - 0.5, colour: colours[sk], label: 'Planned ' + pm + ' d' });
    }
  }
  var med = medianOf(spans);
  var medText = med === null ? null : Math.round(med);
  var subtitle = 'Days from start to complete · ' + model.periodLabel + (medText === null ? '' : ' · median ' + medText + ' d');
  function subjectFor(binLabel, typeLabel) {
    return (typeLabel ? typeLabel + ' completed in ' : 'Completed in ') + binLabel + ' days';
  }
  var columns = [{ label: 'Days' }];
  for (s = 0; s < series.length; s++) columns.push({ label: series[s][1], numeric: true });
  columns.push({ label: 'Total', numeric: true });
  var tRows = [];
  var parts = [];
  for (i = 0; i < nBins; i++) {
    var tc = [{ text: binLabels[i] }];
    var all = [];
    for (s = 0; s < series.length; s++) {
      var ids = binIds[i][series[s][0]];
      var cell = { text: String(ids.length), value: ids.length };
      if (ids.length) { cell.ids = ids.slice(); cell.subject = subjectFor(binLabels[i], series[s][1]); }
      tc.push(cell);
      all = all.concat(ids);
    }
    var tot = { text: String(all.length), value: all.length };
    if (all.length) { tot.ids = all.slice(); tot.subject = subjectFor(binLabels[i], ''); }
    tc.push(tot);
    tRows.push({ cells: tc });
    parts.push(binLabels[i] + ' ' + all.length);
  }
  var pc = [{ text: 'Planned (median)' }];
  for (s = 0; s < series.length; s++) {
    var found = null;
    for (i = 0; i < vLines.length; i++) { if (vLines[i].key === series[s][0]) found = vLines[i]; }
    pc.push({ text: found ? found.median + ' d' : '–' });
  }
  pc.push({ text: '–' });
  tRows.push({ cells: pc });
  return {
    labels: binLabels,
    series: out,
    binIds: binIds,
    vLines: vLines,
    n: filtered.length,
    cap: N,
    median: medText,
    product: product,
    choices: choices,
    showProduct: single !== null,
    subtitle: subtitle,
    ariaLabel: 'Cycle time, days from start to complete, ' + model.periodLabel + '. ' + parts.join(', '),
    empty: filtered.length === 0,
    subjectFor: subjectFor,
    table: { caption: 'Cycle time, days from start to complete, ' + model.periodLabel, columns: columns, rows: tRows }
  };
}

// ===== Phase 96-06: G4 Products (+ Top 10) and G9 Source mix (pure models) =====
var DASH_G4_TYPES = [['wine', 'Wine'], ['cider', 'Cider'], ['beer', 'Beer']];
var DASH_G4_DIMS = {
  wine: [['subcategory', 'Subcategory'], ['brand', 'Brand'], ['manufacturer', 'Manufacturer']],
  beer: [['style', 'Style'], ['recipe', 'Recipe']],
  cider: [['recipe', 'Recipe']]
};
var DASH_SOURCE_CATS = [
  ['kiosk', 'Kiosk', 'cat1'], ['online', 'Online', 'cat2'], ['manual', 'Manual', 'cat3'],
  ['zoho_scan', 'Zoho scan', 'cat4'], ['other', 'Other', 'cat5'], ['unknown', 'Unknown', 'cat6']
];

function dashSourceCat(source) {
  var s = normBatchSource(source);
  if (s === '') return 'unknown';
  if (s === 'kiosk' || s === 'kiosk_recipe') return 'kiosk';
  if (s === 'online' || s === 'manual' || s === 'zoho_scan') return s;
  return 'other';
}

function dashMetaById(batchMeta) {
  var out = {};
  var list = batchMeta || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].batch_id !== undefined && list[i].batch_id !== null) out[list[i].batch_id] = list[i];
  }
  return out;
}

function dashStaffNote(model) {
  return model.state.staff === '1' ? 'Including staff batches' : 'Staff batches hidden';
}

// Ranks breakdown buckets by the Measure, rolls the tail into 'Other (n more)', keeps 'Unspecified' last.
function dashRankBuckets(buckets, useLitres, topN) {
  var named = [];
  var blank = null;
  var i;
  for (i = 0; i < buckets.length; i++) {
    if (buckets[i].label === 'Unspecified') blank = buckets[i]; else named.push(buckets[i]);
  }
  function val(b) { return useLitres ? b.litres : b.count; }
  named.sort(function (a, b) {
    if (val(b) !== val(a)) return val(b) - val(a);
    return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
  });
  var out = named;
  if (topN && named.length > topN) {
    out = named.slice(0, topN);
    var other = { label: 'Other (' + (named.length - topN) + ' more)', count: 0, litres: 0, ids: [] };
    for (i = topN; i < named.length; i++) {
      other.count += named[i].count;
      other.litres += named[i].litres;
      other.ids = other.ids.concat(named[i].ids);
    }
    out.push(other);
  }
  if (blank) out.push(blank);
  return out;
}

function dashIdSet(ids) {
  var set = {};
  for (var i = 0; i < (ids || []).length; i++) set[ids[i]] = true;
  return set;
}

function dashLitresText(v) { return dashGroupThousands(Math.round(v * 10) / 10) + ' L'; }

// ctx: {lookup, metaById, type, dim, staffIds, catMap}
function buildG4Model(rows, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var cur = model.cur;
  var lit = st.measure === 'litres';
  var theme = readChartTheme();
  var colours = { wine: theme.wine, cider: theme.cider, beer: theme.beer };
  var showTypeSeg = st.type === 'all';
  var type = null;
  if (showTypeSeg) type = (c.type === 'wine' || c.type === 'cider' || c.type === 'beer') ? c.type : 'wine';
  else if (st.type === 'wine' || st.type === 'cider' || st.type === 'beer') type = st.type;
  var dims = type ? DASH_G4_DIMS[type] : [];
  var dim = dims.length ? dims[0][0] : '';
  var dimLabel = dims.length ? dims[0][1] : '';
  var d;
  for (d = 0; d < dims.length; d++) {
    if (dims[d][0] === c.dim) { dim = dims[d][0]; dimLabel = dims[d][1]; }
  }
  var staffOn = st.staff === '1';
  var meta = c.metaById || {};
  var lookup = type === 'wine' ? mergeWineSkuLookup(c.lookup, rows) : null;
  var items = [];
  var staffHidden = 0;
  var typeName = '';
  if (type) {
    for (d = 0; d < DASH_G4_TYPES.length; d++) { if (DASH_G4_TYPES[d][0] === type) typeName = DASH_G4_TYPES[d][1]; }
    var inSet = dashIdSet(cur.ids.startedByType[type]);
    var cls = dashClassifyRows(rows, { type: type, source: st.source, staffIds: c.staffIds, scheduleCategoryById: c.catMap });
    for (var i = 0; i < cls.list.length; i++) {
      var it = cls.list[i];
      if (inSet[it.row.batch_id] !== true) continue;
      if (it.staff && !staffOn) { staffHidden++; continue; }
      items.push(it);
    }
  }
  function valueOf(it) {
    var row = it.row;
    if (type === 'wine') {
      var p = lookup ? lookup[String(row.product_sku)] : null;
      return p ? p[dim] : '';
    }
    var m = meta[row.batch_id] || {};
    if (dim === 'style') return m.recipe_style;
    return m.recipe_name || row.product_name;
  }
  function litresOf(it) { return batchLitres(it.row, 'started', type).l; }
  var ranked = dashRankBuckets(dashBreakdownBuckets(items, valueOf, 0, litresOf), lit, 12);
  var total = 0;
  var totalL = 0;
  var labels = [];
  var data = [];
  var parts = [];
  for (d = 0; d < ranked.length; d++) {
    total += ranked[d].count;
    totalL += ranked[d].litres;
    labels.push(ranked[d].label);
    var v = lit ? Math.round(ranked[d].litres * 10) / 10 : ranked[d].count;
    data.push(v);
    parts.push(ranked[d].label + ' ' + (lit ? dashLitresText(v) : v));
  }
  function subjectFor(value) { return typeName + ', ' + dimLabel + ' ' + value; }
  var columns = [{ label: 'Name' }, { label: 'Batches', numeric: true }, { label: 'Litres', numeric: true }, { label: 'Share', numeric: true }];
  var tRows = [];
  for (d = 0; d < ranked.length; d++) {
    var share = total > 0 ? (ranked[d].count / total * 100).toFixed(1) + '%' : '0.0%';
    tRows.push({ cells: [
      { text: ranked[d].label, ids: ranked[d].ids.slice(), subject: subjectFor(ranked[d].label) },
      { text: String(ranked[d].count) },
      { text: dashGroupThousands(Math.round(ranked[d].litres)) },
      { text: share }
    ] });
  }
  var subtitle = '';
  if (type) {
    subtitle = typeName + ' by ' + dimLabel.toLowerCase() + ' · started ' + model.periodLabel + (lit ? ' · litres' : '');
  } else {
    subtitle = 'Started batches · ' + model.periodLabel;
  }
  return {
    type: type,
    typeChoices: DASH_G4_TYPES,
    showTypeSeg: showTypeSeg,
    dim: dim,
    dims: dims,
    dimLabel: dimLabel,
    buckets: ranked,
    labels: labels,
    series: type ? [{ key: type, label: typeName, data: data, colour: colours[type] }] : [],
    measure: lit ? 'litres' : 'batches',
    total: total,
    totalLitres: totalL,
    staffHidden: staffHidden,
    note: dashStaffNote(model),
    subtitle: subtitle + ' · ' + dashStaffNote(model),
    ariaLabel: (typeName || 'Products') + ' batches started by ' + dimLabel.toLowerCase() + ', ' + model.periodLabel + '. ' + parts.join(', '),
    empty: ranked.length === 0,
    subjectFor: subjectFor,
    table: { caption: (typeName || 'Products') + ' by ' + dimLabel.toLowerCase() + ', started ' + model.periodLabel, columns: columns, rows: tRows }
  };
}

// ctx: {metaById, staffIds, catMap}
function buildTop10Model(rows, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var cur = model.cur;
  var lit = st.measure === 'litres';
  var theme = readChartTheme();
  var colours = { wine: theme.wine, cider: theme.cider, beer: theme.beer, other: theme.other };
  var typeNames = { wine: 'Wine', cider: 'Cider', beer: 'Beer', other: 'Other' };
  var meta = c.metaById || {};
  var staffOn = st.staff === '1';
  var inSet = dashIdSet(cur.ids.started);
  var cls = dashClassifyRows(rows, { type: st.type, source: st.source, staffIds: c.staffIds, scheduleCategoryById: c.catMap });
  var groups = {};
  var order = [];
  var i;
  for (i = 0; i < cls.list.length; i++) {
    var it = cls.list[i];
    var row = it.row;
    if (inSet[row.batch_id] !== true) continue;
    if (it.staff && !staffOn) continue;
    var key = row.recipe_id || row.product_sku;
    if (!key) continue;
    key = String(key);
    if (!Object.prototype.hasOwnProperty.call(groups, key)) {
      var m = meta[row.batch_id] || {};
      groups[key] = { key: key, label: String(m.recipe_name || row.product_name || key), type: dashProdKey(it.type), count: 0, litres: 0, ids: [] };
      order.push(key);
    }
    groups[key].count++;
    groups[key].litres += batchLitres(row, 'started', it.type).l;
    groups[key].ids.push(row.batch_id);
  }
  var list = [];
  for (i = 0; i < order.length; i++) list.push(groups[order[i]]);
  function val(g) { return lit ? g.litres : g.count; }
  list.sort(function (a, b) {
    if (val(b) !== val(a)) return val(b) - val(a);
    return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
  });
  list = list.slice(0, 10);
  var labels = [];
  var parts = [];
  for (i = 0; i < list.length; i++) {
    labels.push((i + 1) + '. ' + list[i].label);
    parts.push((i + 1) + '. ' + list[i].label + ' ' + (lit ? dashLitresText(list[i].litres) : list[i].count));
  }
  var series = [];
  var seen = {};
  for (i = 0; i < list.length; i++) {
    var tk = list[i].type;
    if (seen[tk]) continue;
    seen[tk] = true;
    var data = [];
    for (var j = 0; j < list.length; j++) {
      data.push(list[j].type === tk ? (lit ? Math.round(list[j].litres * 10) / 10 : list[j].count) : 0);
    }
    series.push({ key: tk, label: typeNames[tk], data: data, colour: colours[tk] });
  }
  var columns = [{ label: 'Rank', numeric: true }, { label: 'Product' }, { label: 'Type' }, { label: 'Batches', numeric: true }, { label: 'Litres', numeric: true }];
  var tRows = [];
  for (i = 0; i < list.length; i++) {
    tRows.push({ cells: [
      { text: String(i + 1) },
      { text: list[i].label, ids: list[i].ids.slice(), subject: 'Top product ' + list[i].label },
      { text: typeNames[list[i].type] },
      { text: String(list[i].count) },
      { text: dashGroupThousands(Math.round(list[i].litres)) }
    ] });
  }
  return {
    entries: list,
    labels: labels,
    series: series,
    measure: lit ? 'litres' : 'batches',
    ariaLabel: 'Top products started, ' + model.periodLabel + '. ' + parts.join(', '),
    empty: list.length === 0,
    table: { caption: 'Top 10 products started, ' + model.periodLabel, columns: columns, rows: tRows }
  };
}

// Largest-remainder rounding to one decimal so a bucket's shares sum to exactly 100.0.
function dashShareTenths(counts) {
  var total = 0;
  var i;
  for (i = 0; i < counts.length; i++) total += counts[i];
  var out = [];
  if (total <= 0) { for (i = 0; i < counts.length; i++) out.push(0); return out; }
  var floors = [];
  var rems = [];
  var used = 0;
  for (i = 0; i < counts.length; i++) {
    var exact = counts[i] / total * 1000;
    floors.push(Math.floor(exact));
    rems.push({ i: i, r: exact - Math.floor(exact) });
    used += floors[i];
  }
  rems.sort(function (a, b) { return b.r - a.r || a.i - b.i; });
  for (var k = 0; k < 1000 - used; k++) floors[rems[k % rems.length].i]++;
  for (i = 0; i < floors.length; i++) out.push(floors[i] / 10);
  return out;
}

// ctx: {mode: 'count'|'share', staffIds, catMap}
function buildG9Model(rows, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var cur = model.cur;
  var lit = st.measure === 'litres';
  var share = c.mode === 'share';
  var staffOn = st.staff === '1';
  var theme = readChartTheme();
  var buckets = cur.periodBuckets || [];
  var cls = dashClassifyRows(rows, { type: st.type, source: st.source, staffIds: c.staffIds, scheduleCategoryById: c.catMap });
  var nCats = DASH_SOURCE_CATS.length;
  var cells = [];
  var vals = [];
  var i;
  var s;
  for (i = 0; i < buckets.length; i++) {
    var ids = [];
    var v = [];
    for (s = 0; s < nCats; s++) { ids.push([]); v.push(0); }
    for (var j = 0; j < buckets[i].all.length; j++) {
      var id = buckets[i].all[j];
      var it = cls.byId[id];
      if (!it) continue;
      if (it.staff && !staffOn) continue;
      var cat = dashSourceCat(it.row.source);
      for (s = 0; s < nCats; s++) {
        if (DASH_SOURCE_CATS[s][0] === cat) {
          ids[s].push(id);
          v[s] += lit ? batchLitres(it.row, 'started', it.type).l : 1;
        }
      }
    }
    cells.push(ids);
    vals.push(v);
  }
  var totals = [];
  for (i = 0; i < buckets.length; i++) {
    var t = 0;
    for (s = 0; s < nCats; s++) t += vals[i][s];
    totals.push(t);
  }
  var shown = [];
  var grand = 0;
  for (s = 0; s < nCats; s++) {
    var sum = 0;
    for (i = 0; i < buckets.length; i++) sum += vals[i][s];
    grand += sum;
    shown.push(sum > 0);
  }
  // Share values per bucket (tenths, sums to 100.0).
  var shares = [];
  for (i = 0; i < buckets.length; i++) shares.push(share ? dashShareTenths(vals[i]) : null);
  var out = [];
  var counts = [];
  for (s = 0; s < nCats; s++) {
    if (!shown[s]) continue;
    var data = [];
    var cnt = [];
    for (i = 0; i < buckets.length; i++) {
      var raw = lit ? Math.round(vals[i][s] * 10) / 10 : vals[i][s];
      cnt.push(raw);
      data.push(share ? shares[i][s] : raw);
    }
    out.push({ key: DASH_SOURCE_CATS[s][0], label: DASH_SOURCE_CATS[s][1], data: data, colour: theme[DASH_SOURCE_CATS[s][2]] });
    counts.push(cnt);
  }
  var labels = [];
  for (i = 0; i < buckets.length; i++) labels.push(buckets[i].label);
  var by = st.group === 'week' ? 'week' : 'month';
  var subtitle = 'Started ' + (lit ? 'litres' : 'batches') + ' by source · ' + model.periodLabel + ' · by ' + by;
  if (st.source && st.source !== 'all') subtitle += ' · Source: ' + (DASH_SOURCE_LABELS[st.source] || st.source);
  function fmt(x) { return lit ? dashLitresText(x) : String(x); }
  function subjectFor(srcLabel, bucketLabel) {
    return (srcLabel ? srcLabel + ' batches' : 'Batches') + ' started in ' + bucketLabel;
  }
  var columns = [{ label: 'Period' }];
  for (s = 0; s < nCats; s++) columns.push({ label: DASH_SOURCE_CATS[s][1], numeric: true });
  columns.push({ label: 'Total', numeric: true });
  var tRows = [];
  var parts = [];
  for (i = buckets.length - 1; i >= 0; i--) {
    var tc = [{ text: labels[i] }];
    var all = [];
    for (s = 0; s < nCats; s++) {
      var cell = { text: share ? shares[i][s].toFixed(1) + '%' : fmt(Math.round(vals[i][s] * 10) / 10) };
      if (cells[i][s].length) {
        cell.ids = cells[i][s].slice();
        cell.subject = subjectFor(DASH_SOURCE_CATS[s][1], labels[i]);
        all = all.concat(cells[i][s]);
      }
      tc.push(cell);
    }
    var tot = { text: share ? (totals[i] > 0 ? '100.0%' : '0.0%') : fmt(Math.round(totals[i] * 10) / 10) };
    if (all.length) { tot.ids = all; tot.subject = subjectFor('', labels[i]); }
    tc.push(tot);
    tRows.push({ cells: tc });
  }
  for (i = 0; i < buckets.length; i++) parts.push(labels[i] + ' ' + fmt(Math.round(totals[i] * 10) / 10));
  return {
    mode: share ? 'share' : 'count',
    labels: labels,
    series: out,
    counts: counts,
    cells: cells,
    totals: totals,
    measure: lit ? 'litres' : 'batches',
    percent: share,
    note: dashStaffNote(model),
    subtitle: subtitle,
    ariaLabel: 'Started ' + (lit ? 'litres' : 'batches') + ' by source, ' + model.periodLabel + '. ' + parts.join(', '),
    empty: grand === 0,
    subjectFor: subjectFor,
    table: { caption: 'Started ' + (lit ? 'litres' : 'batches') + ' by source, ' + model.periodLabel, columns: columns, rows: tRows }
  };
}

// ===== Phase 96-07: G5 Workload and G7 Task health (pure models; read _dashData.taskRows) =====
var DASH_WEEKDAYS_FROM_THU = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
var DASH_TASK_KIND_WORDS = { transfer: 'Racking', filtering: 'Filtering', packaging: 'Packaging', temp: 'Temperature steps', other: 'Other tasks' };
var DASH_TASK_KIND_COLOURS = ['cat1', 'cat2', 'cat3', 'cat4', 'cat5'];

// Tasks joined to classified (Type + Source filtered, staff included) batches.
// open: not completed, on a primary/secondary batch. kind: 'all' or a DASH_TASK_KINDS key.
function dashJoinTasks(rows, taskRows, st, ctx, kind) {
  var c = ctx || {};
  var cls = dashClassifyRows(rows, { type: st.type, source: st.source, staffIds: c.staffIds, scheduleCategoryById: c.catMap });
  var open = [];
  var done = [];
  var list = taskRows || [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t) continue;
    var it = cls.byId[t.batch_id];
    if (!it) continue;
    var k = dashTaskKind(t);
    if (kind && kind !== 'all' && k !== kind) continue;
    var rec = { batch_id: t.batch_id, kind: k, due: t.due_date || null, doneDay: t.completed_day || null };
    if (t.completed === true) done.push(rec);
    else if (it.status === 'primary' || it.status === 'secondary') open.push(rec);
  }
  return { open: open, done: done };
}

function dashDistinct(ids) {
  var seen = {};
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(seen, ids[i])) { seen[ids[i]] = true; out.push(ids[i]); }
  }
  return out;
}

function dashDayLabel(ymd, isToday) {
  if (isToday) return 'Today';
  return DASH_WEEKDAYS_FROM_THU[dayNumber(ymd) % 7] + ' ' + (+String(ymd).slice(8, 10));
}

function dashTasksText(n) { return n + (n === 1 ? ' task' : ' tasks'); }
function dashBatchesText(n) { return n + (n === 1 ? ' batch' : ' batches'); }

function buildG5Model(rows, taskRows, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var horizon = Number(c.horizon) === 30 ? 30 : 14;
  var today = model.cur.asOf.today;
  var theme = readChartTheme();
  var j = dashJoinTasks(rows, taskRows, st, c, 'all');
  var nK = DASH_TASK_KINDS.length;
  var days = [];
  var labels = [];
  var ids = [];
  var vals = [];
  var i;
  var k;
  for (i = 0; i < horizon; i++) {
    var ymd = addDays(today, i);
    days.push(ymd);
    labels.push(dashDayLabel(ymd, i === 0));
    var cell = [];
    var v = [];
    for (k = 0; k < nK; k++) { cell.push([]); v.push(0); }
    ids.push(cell);
    vals.push(v);
  }
  var overdue = 0;
  for (i = 0; i < j.open.length; i++) {
    var t = j.open[i];
    if (!t.due) continue;
    if (t.due < today) { overdue++; continue; }
    var di = dayNumber(t.due) - dayNumber(today);
    if (di < 0 || di >= horizon) continue;
    for (k = 0; k < nK; k++) {
      if (DASH_TASK_KINDS[k].key === t.kind) { ids[di][k].push(t.batch_id); vals[di][k]++; }
    }
  }
  var dayIds = [];
  var dayTotals = [];
  var grand = 0;
  for (i = 0; i < horizon; i++) {
    var all = [];
    var tot = 0;
    for (k = 0; k < nK; k++) {
      ids[i][k] = dashDistinct(ids[i][k]);
      all = all.concat(ids[i][k]);
      tot += vals[i][k];
    }
    dayIds.push(dashDistinct(all));
    dayTotals.push(tot);
    grand += tot;
  }
  var series = [];
  for (k = 0; k < nK; k++) {
    var data = [];
    for (i = 0; i < horizon; i++) data.push(vals[i][k]);
    series.push({ key: DASH_TASK_KINDS[k].key, label: DASH_TASK_KINDS[k].label, data: data, colour: theme[DASH_TASK_KIND_COLOURS[k]] });
  }
  function subjectFor(kindKey, ymd2) {
    return (kindKey ? DASH_TASK_KIND_WORDS[kindKey] + ' due ' : 'Tasks due ') + dashShortDate(ymd2);
  }
  var columns = [{ label: 'Date' }];
  for (k = 0; k < nK; k++) columns.push({ label: DASH_TASK_KINDS[k].label, numeric: true });
  columns.push({ label: 'Total', numeric: true });
  var tRows = [];
  var parts = [];
  for (i = 0; i < horizon; i++) {
    var tc = [{ text: labels[i] }];
    for (k = 0; k < nK; k++) {
      var cl = { text: String(vals[i][k]) };
      if (ids[i][k].length) { cl.ids = ids[i][k].slice(); cl.subject = subjectFor(DASH_TASK_KINDS[k].key, days[i]); }
      tc.push(cl);
    }
    var tl = { text: String(dayTotals[i]) };
    if (dayIds[i].length) { tl.ids = dayIds[i].slice(); tl.subject = subjectFor('', days[i]); }
    tc.push(tl);
    tRows.push({ cells: tc });
    if (dayTotals[i]) parts.push(labels[i] + ' ' + dayTotals[i]);
  }
  return {
    horizon: horizon,
    days: days,
    labels: labels,
    series: series,
    ids: ids,
    dayIds: dayIds,
    dayTotals: dayTotals,
    dayBatches: dayIds.map(function (d) { return d.length; }),
    overdue: overdue,
    note: overdue > 0 ? (overdue === 1 ? '1 open task is overdue. See Task health.' : overdue + ' open tasks are overdue. See Task health.') : '',
    subtitle: 'Open tasks due · next ' + horizon + ' days',
    emptyText: 'No open tasks due in the next ' + horizon + ' days.',
    empty: grand === 0,
    ariaLabel: 'Workload, open tasks due in the next ' + horizon + ' days. ' + (parts.length ? parts.join(', ') : 'None'),
    footer: function (idx) { return dashTasksText(dayTotals[idx]) + ' · ' + dashBatchesText(dayIds[idx].length); },
    subjectFor: subjectFor,
    table: { caption: 'Workload, open tasks due by day', columns: columns, rows: tRows }
  };
}

var DASH_AGEING_BANDS = [['1–3 days', 1, 3], ['4–7 days', 4, 7], ['8+ days', 8, 100000]];

function buildG7Model(rows, taskRows, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var kind = c.kind || 'all';
  var today = model.cur.asOf.today;
  var theme = readChartTheme();
  var j = dashJoinTasks(rows, taskRows, st, c, kind);
  var todayN = dayNumber(today);
  var bandIds = [[], [], []];
  var bandCount = [0, 0, 0];
  var i;
  var b;
  for (i = 0; i < j.open.length; i++) {
    var t = j.open[i];
    if (!t.due) continue;
    var late = todayN - dayNumber(t.due);
    if (late < 1) continue;
    for (b = 0; b < 3; b++) {
      if (late >= DASH_AGEING_BANDS[b][1] && late <= DASH_AGEING_BANDS[b][2]) { bandIds[b].push(t.batch_id); bandCount[b]++; }
    }
  }
  var ageTotal = bandCount[0] + bandCount[1] + bandCount[2];
  var ageLabels = [];
  var ageColours = [theme.inkTertiary, theme.inkSecondary, theme.inkPrimary];
  var ageRows = [];
  var ageIds = [];
  for (b = 0; b < 3; b++) {
    bandIds[b] = dashDistinct(bandIds[b]);
    ageLabels.push(DASH_AGEING_BANDS[b][0]);
    ageIds.push(bandIds[b]);
    var subj = 'Open tasks overdue ' + DASH_AGEING_BANDS[b][0];
    var oc = { text: String(bandCount[b]) };
    var bc = { text: String(bandIds[b].length) };
    if (bandIds[b].length) { oc.ids = bandIds[b].slice(); oc.subject = subj; bc.ids = bandIds[b].slice(); bc.subject = subj; }
    ageRows.push({ cells: [{ text: DASH_AGEING_BANDS[b][0] }, oc, bc] });
  }
  // Completions over time, bucketed like the other period widgets.
  var group = st.group === 'week' ? 'week' : 'month';
  var start = model.win.start;
  var end = model.win.end;
  var inWin = [];
  for (i = 0; i < j.done.length; i++) {
    if (j.done[i].doneDay && inWindow(j.done[i].doneDay, model.win)) inWin.push(j.done[i]);
  }
  if (start === '0000-01-01') {
    start = null;
    for (i = 0; i < inWin.length; i++) { if (start === null || inWin[i].doneDay < start) start = inWin[i].doneDay; }
  }
  var skel = start ? periodSkeleton(start, end, group) : [];
  var cmap = {};
  var cids = {};
  for (i = 0; i < skel.length; i++) { cmap[skel[i].key] = 0; cids[skel[i].key] = []; }
  for (i = 0; i < inWin.length; i++) {
    var key = bucketKeyOf(inWin[i].doneDay, group);
    if (Object.prototype.hasOwnProperty.call(cmap, key)) { cmap[key]++; cids[key].push(inWin[i].batch_id); }
  }
  var cLabels = [];
  var cData = [];
  var cCells = [];
  var doneTotal = 0;
  var cRows = [];
  for (i = 0; i < skel.length; i++) {
    cLabels.push(skel[i].label);
    cData.push(cmap[skel[i].key]);
    cCells.push(dashDistinct(cids[skel[i].key]));
    doneTotal += cmap[skel[i].key];
  }
  function compSubject(label) { return 'Tasks completed in ' + label; }
  for (i = skel.length - 1; i >= 0; i--) {
    var cc = { text: String(cData[i]) };
    if (cCells[i].length) { cc.ids = cCells[i].slice(); cc.subject = compSubject(cLabels[i]); }
    cRows.push({ cells: [{ text: cLabels[i] }, cc] });
  }
  var choices = [['all', 'All tasks']];
  for (i = 0; i < DASH_TASK_KINDS.length; i++) choices.push([DASH_TASK_KINDS[i].key, DASH_TASK_KINDS[i].label]);
  return {
    kind: kind,
    choices: choices,
    ageing: {
      labels: ageLabels,
      counts: bandCount,
      ids: ageIds,
      total: ageTotal,
      colours: ageColours,
      empty: ageTotal === 0,
      emptyText: 'No open tasks are overdue.',
      subjectFor: function (bi) { return 'Open tasks overdue ' + DASH_AGEING_BANDS[bi][0]; },
      ariaLabel: 'Open tasks past due date. ' + ageLabels.map(function (l, q) { return l + ' ' + bandCount[q]; }).join(', '),
      table: { caption: 'Open tasks past due date', columns: [{ label: 'Overdue by' }, { label: 'Open tasks', numeric: true }, { label: 'Batches', numeric: true }], rows: ageRows }
    },
    completions: {
      labels: cLabels,
      data: cData,
      cells: cCells,
      total: doneTotal,
      colour: theme.cat1,
      empty: doneTotal === 0,
      emptyText: 'No tasks were ticked off in this period.',
      subjectFor: compSubject,
      ariaLabel: 'Tasks ticked off, ' + model.periodLabel + '. ' + cLabels.map(function (l, q) { return l + ' ' + cData[q]; }).join(', '),
      table: { caption: 'Tasks ticked off, ' + model.periodLabel, columns: [{ label: 'Period' }, { label: 'Tasks completed', numeric: true }], rows: cRows }
    },
    subtitle: 'Tasks · ' + model.periodLabel + ' · by ' + group,
    note: 'Tick times can lag the work, so lateness here is only an estimate.'
  };
}

// ===== Phase 96-08: G6 Vessels and G8 Fermentation (pure models; read _dashData.vessels / readings / batchMeta) =====
var DASH_VESSEL_TYPE_ORDER = ['Carboy', 'Bucket', 'Keg', 'Drum', 'Boil Kettle', 'Conical Fermenter', 'Mash Tun'];

function dashSortIds(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function dashLitresNum(n) { return dashGroupThousands(Math.round(Number(n) || 0)); }

function buildG6Model(rows, vessels, ctx) {
  var c = ctx || {};
  var mode = c.mode === 'litres' ? 'litres' : 'vessels';
  var theme = readChartTheme();
  // Physical state: every global filter (staff included) is ignored.
  var cls = dashClassifyRows(rows, { scheduleCategoryById: c.catMap, staffIds: c.staffIds });
  var vmap = {};
  var all = vessels || [];
  var i;
  for (i = 0; i < all.length; i++) { if (all[i]) vmap[all[i].vessel_id] = all[i]; }
  var onVessel = {};
  var noVessel = [];
  for (i = 0; i < cls.list.length; i++) {
    var it = cls.list[i];
    if (it.status !== 'primary' && it.status !== 'secondary') continue;
    var vid = String(it.row.vessel_id === undefined || it.row.vessel_id === null ? '' : it.row.vessel_id).trim();
    if (vid === '') { noVessel.push(it); continue; }
    if (!Object.prototype.hasOwnProperty.call(onVessel, vid)) onVessel[vid] = [];
    onVessel[vid].push(it.row.batch_id);
  }
  // Capacity rows by stored type; archived vessels are counted nowhere.
  var byType = {};
  var typeNames = [];
  var missingCap = false;
  for (i = 0; i < all.length; i++) {
    var v = all[i];
    if (!v || v.archived === true) continue;
    var ty = String(v.type || '').trim() || 'Unknown type';
    if (!Object.prototype.hasOwnProperty.call(byType, ty)) {
      byType[ty] = { type: ty, total: 0, inUse: 0, litresTotal: 0, litresInUse: 0, ids: [] };
      typeNames.push(ty);
    }
    var tb = byType[ty];
    var cap = (v.capacity_liters === null || v.capacity_liters === undefined) ? null : Number(v.capacity_liters);
    if (cap !== null && isNaN(cap)) cap = null;
    if (cap === null) missingCap = true;
    var used = Object.prototype.hasOwnProperty.call(onVessel, v.vessel_id);
    tb.total++;
    if (cap !== null) tb.litresTotal += cap;
    if (used) {
      tb.inUse++;
      if (cap !== null) tb.litresInUse += cap;
      tb.ids = tb.ids.concat(onVessel[v.vessel_id]);
    }
  }
  typeNames.sort(function (a, b) {
    var ia = DASH_VESSEL_TYPE_ORDER.indexOf(a);
    var ib = DASH_VESSEL_TYPE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return dashSortIds(a, b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  var lit = mode === 'litres';
  var labels = [];
  var inUse = [];
  var avail = [];
  var types = [];
  var tRows = [];
  var parts = [];
  for (i = 0; i < typeNames.length; i++) {
    var t = byType[typeNames[i]];
    t.ids = dashDistinct(t.ids);
    var tot = lit ? t.litresTotal : t.total;
    var use = lit ? t.litresInUse : t.inUse;
    t.subject = t.type + 's in use';
    types.push(t);
    labels.push(t.type);
    inUse.push(use);
    avail.push(tot - use);
    var uc = { text: lit ? dashLitresNum(use) + ' L' : String(use) };
    if (t.ids.length) { uc.ids = t.ids.slice(); uc.subject = t.subject; }
    tRows.push({ cells: [{ text: t.type }, uc, { text: lit ? dashLitresNum(tot - use) + ' L' : String(tot - use) }, { text: lit ? dashLitresNum(tot) + ' L' : String(tot) }] });
    parts.push(t.type + ' ' + (lit ? dashLitresNum(use) + ' of ' + dashLitresNum(tot) + ' L' : use + ' of ' + tot));
  }
  // Shared vessels: 2+ active batches on one vessel (allowed; shown neutrally).
  var sharedIds = [];
  for (var k in onVessel) {
    if (Object.prototype.hasOwnProperty.call(onVessel, k) && onVessel[k].length >= 2) sharedIds.push(k);
  }
  sharedIds.sort(dashSortIds);
  var shared = [];
  for (i = 0; i < sharedIds.length; i++) {
    var sid = sharedIds[i];
    var bids = dashDistinct(onVessel[sid]);
    var sv = vmap[sid];
    shared.push({
      primary: sid + ' · ' + ((sv && String(sv.type || '').trim()) || 'Unknown type'),
      secondary: bids.join(', '),
      right: bids.length + ' batches',
      ids: bids,
      subject: 'Shared vessel ' + sid
    });
  }
  noVessel.sort(function (a, b) { return dashSortIds(String(a.row.batch_id), String(b.row.batch_id)); });
  var none = [];
  for (i = 0; i < noVessel.length; i++) {
    none.push({
      primary: String(noVessel[i].row.batch_id),
      secondary: (noVessel[i].row.product_name || '') + ' · ' + (DASH_TYPE_LABELS[noVessel[i].type] || ''),
      right: '',
      ids: [noVessel[i].row.batch_id],
      subject: 'Batch ' + noVessel[i].row.batch_id
    });
  }
  return {
    mode: mode,
    types: types,
    labels: labels,
    series: [
      { key: 'inuse', label: 'In use', data: inUse, colour: theme.inkSecondary },
      { key: 'available', label: 'Available', data: avail, colour: theme.ledgerSoft, borderColour: theme.ledgerLine }
    ],
    unit: lit ? 'litres' : 'vessels',
    label: function (idx) {
      var tt = types[idx];
      if (!tt) return '';
      return lit ? dashLitresNum(tt.litresInUse) + ' of ' + dashLitresNum(tt.litresTotal) + ' L' : tt.inUse + ' of ' + tt.total;
    },
    empty: types.length === 0,
    emptyText: 'No vessels have been recorded yet.',
    subtitle: 'Right now · all batch types and sources' + (lit && missingCap ? ' · vessels with no capacity recorded are left out' : ''),
    note: 'Ignores the filters above',
    sharedNote: 'More than one active batch is using the same vessel. This is allowed.',
    shared: shared,
    noVessel: none,
    ariaLabel: 'Vessel capacity in use, right now. ' + (parts.length ? parts.join(', ') : 'None'),
    table: { caption: 'Vessel capacity in use by type', columns: [{ label: 'Vessel type' }, { label: 'In use', numeric: true }, { label: 'Available', numeric: true }, { label: 'Total', numeric: true }], rows: tRows }
  };
}

// ===== Phase 96-09: G10 Data health (pure model; ignores every global filter) =====
var DASH_HEALTH_CATS = [
  { key: 'novessel', label: 'No vessel' },
  { key: 'nocompletedat', label: 'Missing completion date' },
  { key: 'noinvoice', label: 'No invoice link' },
  { key: 'blanksource', label: 'Blank source' },
  { key: 'stale', label: 'Stale active batches' }
];
var DASH_HEALTH_STALE_DAYS = 90;

function buildG10Model(rows, metaById, ctx) {
  var c = ctx || {};
  var meta = metaById || {};
  var today = c.today;
  var cls = dashClassifyRows(rows, { scheduleCategoryById: c.catMap, staffIds: c.staffIds });
  var buckets = {};
  var i;
  for (i = 0; i < DASH_HEALTH_CATS.length; i++) buckets[DASH_HEALTH_CATS[i].key] = [];
  function mk(it, detail) {
    var id = it.row.batch_id;
    return {
      primary: String(id),
      secondary: (it.row.product_name || '') + ' · ' + (DASH_TYPE_LABELS[it.type] || '') + (detail ? ' · ' + detail : '') + (it.staff ? ' · Staff batch' : ''),
      right: '',
      ids: [id],
      subject: 'Batch ' + id
    };
  }
  for (i = 0; i < cls.list.length; i++) {
    var it = cls.list[i];
    var st = it.status;
    if (st === 'disabled' || st === 'deleted') continue;
    var r = it.row;
    var active = st === 'primary' || st === 'secondary';
    var vid = String(r.vessel_id === undefined || r.vessel_id === null ? '' : r.vessel_id).trim();
    var src = normBatchSource(r.source);
    if (active && vid === '') buckets.novessel.push(mk(it, ''));
    if (st === 'complete' && String(r.completed_at === undefined || r.completed_at === null ? '' : r.completed_at).trim() === '') buckets.nocompletedat.push(mk(it, ''));
    var m = meta[r.batch_id];
    if (m && m.has_invoice_link === false && src !== 'internal') buckets.noinvoice.push(mk(it, ''));
    if (src === '') buckets.blanksource.push(mk(it, ''));
    if (active && today && r.start_date) {
      var age = dayNumber(today) - dayNumber(r.start_date);
      if (age > DASH_HEALTH_STALE_DAYS) buckets.stale.push(mk(it, 'Active ' + age + ' days'));
    }
  }
  var cats = [];
  var total = 0;
  for (i = 0; i < DASH_HEALTH_CATS.length; i++) {
    var list = buckets[DASH_HEALTH_CATS[i].key];
    list.sort(function (a, b) { return dashSortIds(a.primary, b.primary); });
    total += list.length;
    cats.push({ key: DASH_HEALTH_CATS[i].key, label: DASH_HEALTH_CATS[i].label, count: list.length, items: list });
  }
  return {
    cats: cats,
    allZero: total === 0,
    subtitle: 'All batches · ignores the filters above',
    note: 'No invoice link means no Zoho sales order is stored on the batch. It does not mean the batch is unpaid.',
    emptyText: 'No data issues found.'
  };
}

function dashPlato(n) { return (Math.round(Number(n) * 10) / 10) + ' °P'; }

function buildG8Model(rows, readings, metaById, model, ctx) {
  var c = ctx || {};
  var st = model.state;
  var today = model.cur.asOf.today;
  var theme = readChartTheme();
  var meta = metaById || {};
  var base = {
    choices: [['all', 'All batches with readings']],
    batch: 'all',
    series: [],
    legend: [],
    stats: null,
    note: '',
    subtitle: 'Plato readings · active beer and cider',
    noReadings: [],
    noReadingsEmpty: 'Every active beer and cider batch has a reading.',
    table: { caption: 'Plato readings', columns: [], rows: [] },
    state: 'ok',
    stateText: '',
    ariaLabel: ''
  };
  if (st.type === 'wine' || st.type === 'seltzer' || st.type === 'other') {
    base.state = 'wrongType';
    base.stateText = 'Fermentation curves cover beer and cider.';
    return base;
  }
  var cls = dashClassifyRows(rows, { type: st.type, source: st.source, staffIds: c.staffIds, scheduleCategoryById: c.catMap });
  var items = [];
  var i;
  for (i = 0; i < cls.list.length; i++) {
    var it = cls.list[i];
    if ((it.status === 'primary' || it.status === 'secondary') && (it.type === 'beer' || it.type === 'cider')) items.push(it);
  }
  var itemById = {};
  for (i = 0; i < items.length; i++) itemById[items[i].row.batch_id] = items[i];
  // Plato points per batch (x = day since start).
  var pts = {};
  var latest = {};
  var list = readings || [];
  for (i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || !itemById[r.batch_id]) continue;
    if (r.degrees_plato === null || r.degrees_plato === undefined || isNaN(Number(r.degrees_plato)) || !r.reading_day) continue;
    var b = itemById[r.batch_id];
    var x = Math.max(0, dayNumber(r.reading_day) - dayNumber(String(b.row.start_date || r.reading_day)));
    if (!pts[r.batch_id]) pts[r.batch_id] = [];
    pts[r.batch_id].push({ x: x, y: Number(r.degrees_plato), at: r.reading_at || r.reading_day, temp: r.temperature, ph: r.ph });
    if (!latest[r.batch_id] || r.reading_day > latest[r.batch_id]) latest[r.batch_id] = r.reading_day;
  }
  var withPts = [];
  for (i = 0; i < items.length; i++) {
    var id = items[i].row.batch_id;
    if (pts[id]) {
      pts[id].sort(function (p, q) { return p.x - q.x || (p.at < q.at ? -1 : (p.at > q.at ? 1 : 0)); });
      withPts.push(id);
    }
  }
  withPts.sort(function (a, b2) {
    if (latest[a] !== latest[b2]) return latest[a] < latest[b2] ? 1 : -1;
    return dashSortIds(a, b2);
  });
  // Batches with no Plato reading yet.
  var none = [];
  for (i = 0; i < items.length; i++) {
    if (pts[items[i].row.batch_id]) continue;
    var day = Math.max(0, dayNumber(today) - dayNumber(String(items[i].row.start_date || today)));
    none.push({
      primary: String(items[i].row.batch_id),
      secondary: (items[i].row.product_name || '') + ' · ' + (DASH_TYPE_LABELS[items[i].type] || ''),
      right: 'Day ' + day,
      day: day,
      ids: [items[i].row.batch_id],
      subject: 'Batch ' + items[i].row.batch_id
    });
  }
  none.sort(function (a, b3) { return b3.day - a.day || dashSortIds(a.primary, b3.primary); });
  base.noReadings = none;
  if (!withPts.length) {
    base.state = 'noReadings';
    base.stateText = 'No Plato readings have been recorded yet.';
    return base;
  }
  function nameOf(bid) {
    var m = meta[bid];
    return (m && m.recipe_name) || itemById[bid].row.product_name || '';
  }
  for (i = 0; i < withPts.length; i++) base.choices.push([withPts[i], withPts[i] + ' · ' + nameOf(withPts[i])]);
  var sel = c.batch && c.batch !== 'all' && pts[c.batch] ? c.batch : 'all';
  base.batch = sel;
  var plotted = sel === 'all' ? withPts.slice(0, 20) : [sel];
  if (sel === 'all' && withPts.length > 20) base.note = 'Showing the 20 most recent. Pick a batch to see others.';
  var seen = {};
  var parts = [];
  var tableRows = [];
  for (i = 0; i < plotted.length; i++) {
    var pid = plotted[i];
    var ty = itemById[pid].type;
    var colour = theme[ty];
    var data = [];
    var q;
    for (q = 0; q < pts[pid].length; q++) data.push({ x: pts[pid][q].x, y: pts[pid][q].y });
    base.series.push({ key: pid, label: pid, data: data, colour: colour, borderWidth: 2, pointRadius: sel === 'all' ? 3 : 4, batchId: pid });
    if (!seen[ty]) { seen[ty] = true; base.legend.push({ label: DASH_TYPE_LABELS[ty], colour: colour }); }
    parts.push(pid + ' ' + pts[pid].length + (pts[pid].length === 1 ? ' reading' : ' readings'));
    for (q = 0; q < pts[pid].length; q++) {
      var p = pts[pid][q];
      tableRows.push({
        at: p.at,
        cells: [
          { text: pid, ids: [pid], subject: 'Batch ' + pid },
          { text: DASH_TYPE_LABELS[ty] },
          { text: String(p.x) },
          { text: dashPlato(p.y) },
          { text: p.temp === null || p.temp === undefined || p.temp === '' ? '–' : String(p.temp) },
          { text: p.ph === null || p.ph === undefined || p.ph === '' ? '–' : String(p.ph) }
        ]
      });
    }
  }
  tableRows.sort(function (a, b4) { return a.at < b4.at ? 1 : (a.at > b4.at ? -1 : 0); });
  base.table = {
    caption: 'Plato readings',
    columns: [{ label: 'Batch' }, { label: 'Type' }, { label: 'Day', numeric: true }, { label: '°P', numeric: true }, { label: 'Temp', numeric: true }, { label: 'pH', numeric: true }],
    rows: tableRows
  };
  if (sel !== 'all') {
    var m2 = meta[sel] || {};
    var og = m2.og === null || m2.og === undefined ? null : Number(m2.og);
    var fg = m2.target_fg === null || m2.target_fg === undefined ? null : Number(m2.target_fg);
    var pd = m2.planned_days === null || m2.planned_days === undefined ? null : Number(m2.planned_days);
    if (og !== null && isNaN(og)) og = null;
    if (fg !== null && isNaN(fg)) fg = null;
    if (pd !== null && (isNaN(pd) || pd <= 0)) pd = null;
    if (og !== null && fg !== null && pd !== null) {
      base.series.push({ key: 'expected', label: 'Expected', data: [{ x: 0, y: og }, { x: pd, y: fg }], colour: theme.inkTertiary, borderDash: [6, 4], pointRadius: 0, borderWidth: 2 });
    } else if (og === null || fg === null) {
      base.note = 'No expected curve: this recipe has no OG or target FG.';
    } else {
      base.note = 'No expected curve: this batch has no fermentation schedule.';
    }
    var last = pts[sel][pts[sel].length - 1];
    var both = og !== null && fg !== null && og !== 0;
    base.stats = [
      ['OG', og === null ? '–' : dashPlato(og)],
      ['Latest', dashPlato(last.y)],
      ['Target FG', fg === null ? '–' : dashPlato(fg)],
      ['Attenuation', both ? Math.round((og - fg) / og * 100) + '%' : '–'],
      ['ABV', both ? (Math.round(calcAbv(og, fg) * 10) / 10).toFixed(1) + '%' : '–']
    ];
  }
  base.ariaLabel = 'Plato readings by day since start. ' + parts.join(', ');
  return base;
}

// ===== Phase 95-05: lazy Chart.js loader + shared chart() helper =====
var CHART_JS_SRC = 'js/vendor/chart.umd.min.js?v=4.5.1';
var _chartJsPromise = null;
var _chartTheme = null;

function readChartTheme() {
  if (_chartTheme) return _chartTheme;
  var cs = (typeof window !== 'undefined' && window.getComputedStyle && document.documentElement)
    ? window.getComputedStyle(document.documentElement) : null;
  function v(name, fallback) {
    var val = cs ? String(cs.getPropertyValue(name) || '').trim() : '';
    return val || fallback;
  }
  _chartTheme = {
    wine: v('--chart-wine', '#6e1a2c'),
    cider: v('--chart-cider', '#a8841a'),
    beer: v('--chart-beer', '#9a4e0c'),
    other: v('--chart-other', '#9a8672'),
    cat1: v('--chart-cat-1', '#3f6670'),
    cat2: v('--chart-cat-2', '#5f6b3a'),
    cat3: v('--chart-cat-3', '#6e4a6a'),
    cat4: v('--chart-cat-4', '#b0623f'),
    cat5: v('--chart-cat-5', '#4a403a'),
    cat6: v('--chart-other', '#9a8672'),
    inkPrimary: v('--ink-primary', '#2c2218'),
    inkSecondary: v('--ink-secondary', '#6b5442'),
    inkTertiary: v('--ink-tertiary', '#8c7866'),
    ledgerSoft: v('--ledger-soft', 'rgba(119, 70, 45, 0.07)'),
    ledgerLine: v('--ledger-line', 'rgba(119, 70, 45, 0.12)'),
    separator: v('--cellar-raised', '#faf8f2'),
    grid: v('--ledger-soft', 'rgba(119, 70, 45, 0.07)'),
    axis: v('--ledger-line', 'rgba(119, 70, 45, 0.12)'),
    tick: v('--ink-secondary', '#6b5442'),
    tooltipBg: v('--ink-primary', '#2c2218'),
    tooltipText: v('--cellar-raised', '#faf8f2'),
    font: v('--font-body', "'Lato', 'Helvetica Neue', Arial, sans-serif")
  };
  return _chartTheme;
}

function loadChartJs() {
  if (typeof window !== 'undefined' && window.Chart) return Promise.resolve(window.Chart);
  if (_chartJsPromise) return _chartJsPromise;
  _chartJsPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = CHART_JS_SRC;
    s.async = true;
    s.onload = function () {
      if (window.Chart) {
        try { window.Chart.defaults.font.family = readChartTheme().font; } catch (e) { /* defaults optional */ }
        resolve(window.Chart);
      } else {
        _chartJsPromise = null;
        reject(new Error('Chart.js loaded but window.Chart is missing'));
      }
    };
    s.onerror = function () {
      _chartJsPromise = null;
      if (s.parentNode) s.parentNode.removeChild(s);
      reject(new Error('Chart.js failed to load'));
    };
    document.head.appendChild(s);
  });
  return _chartJsPromise;
}

function chart(canvas, cfg) {
  var Chart = window.Chart;
  var theme = readChartTheme();
  var existing = Chart.getChart ? Chart.getChart(canvas) : null;
  if (existing) existing.destroy();

  var isDoughnut = cfg.type === 'doughnut';
  var litres = cfg.measure === 'litres';
  var fmtNum = function (n) {
    return String(Math.round(Number(n) * 10) / 10).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  var fmtValue = function (n) { return litres ? fmtNum(n) + ' L' : String(n); };
  // Phase 96: optional unit text (tasks, vessels, days, plato, percent).
  var unitText = function (n) {
    var num = Number(n);
    switch (cfg.unit) {
      case 'tasks': return fmtNum(num) + (num === 1 ? ' task' : ' tasks');
      case 'vessels': return fmtNum(num) + (num === 1 ? ' vessel' : ' vessels');
      case 'days': return fmtNum(num) + ' d';
      case 'plato': return fmtNum(num) + ' °P';
      case 'percent': return fmtNum(num) + '%';
      default: return null;
    }
  };
  var valueOf = function (item) {
    var p = item && item.parsed;
    if (typeof p === 'number') return p;
    if (!p) return 0;
    return cfg.horizontal ? p.x : p.y;
  };

  var series = cfg.series || [];
  var datasets = [];
  for (var i = 0; i < series.length; i++) {
    var ds = {
      label: series[i].label,
      data: series[i].data,
      backgroundColor: series[i].colour,
      borderColor: theme.separator,
      borderWidth: (cfg.stacked || isDoughnut) ? 2 : 0,
      borderRadius: 3,
      borderSkipped: false,
      _key: series[i].key
    };
    // Phase 96-08: opt-in 1px outline for neutral fills (G6 Available).
    if (series[i].borderColour) { ds.borderColor = series[i].borderColour; ds.borderWidth = 1; }
    if (cfg.type === 'line') {
      ds.borderColor = series[i].colour;
      ds.borderWidth = 2;
      if (series[i].borderDash) ds.borderDash = series[i].borderDash;
      if (series[i].pointRadius !== undefined) ds.pointRadius = series[i].pointRadius;
      if (series[i].borderWidth !== undefined) ds.borderWidth = series[i].borderWidth;
      if (series[i].fill !== undefined) ds.fill = series[i].fill;
      if (series[i].showLine !== undefined) ds.showLine = series[i].showLine;
    }
    datasets.push(ds);
  }

  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduced = false; }

  var valueScale = {
    beginAtZero: true,
    stacked: !!cfg.stacked,
    grid: { color: theme.grid },
    border: { color: theme.axis },
    ticks: { color: theme.tick, font: { size: 12 } }
  };
  if (litres) {
    valueScale.ticks.callback = function (val) { return fmtNum(val) + ' L'; };
  } else if (cfg.percent || cfg.unit === 'percent') {
    valueScale.ticks.callback = function (val) { return val + '%'; };
  } else {
    valueScale.ticks.precision = 0;
  }
  if (cfg.percent) valueScale.max = 100;
  var labelScale = {
    stacked: !!cfg.stacked,
    grid: { display: false },
    border: { color: theme.axis },
    ticks: { color: theme.tick, font: { size: 12 } }
  };

  var options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: reduced ? false : { duration: 200 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: theme.tooltipBg,
        titleColor: theme.tooltipText,
        bodyColor: theme.tooltipText,
        footerColor: theme.tooltipText,
        padding: 8,
        titleFont: { size: 12 },
        bodyFont: { size: 12 },
        footerFont: { size: 12 },
        callbacks: {
          label: function (item) {
            var name = (item.dataset && item.dataset.label) || item.label || '';
            var val = valueOf(item);
            if (typeof cfg.tooltipLabel === 'function') return cfg.tooltipLabel(item);
            var ut = unitText(val);
            if (ut !== null) return name + ': ' + ut;
            return name + ': ' + (litres ? fmtNum(val) + ' L' : val + (Number(val) === 1 ? ' batch' : ' batches'));
          },
          footer: function (items) {
            if (typeof cfg.tooltipFooter === 'function') return cfg.tooltipFooter(items);
            if (!cfg.tooltipTotal) return '';
            var sum = 0;
            for (var j = 0; j < (items || []).length; j++) sum += Number(valueOf(items[j])) || 0;
            var ut2 = unitText(sum);
            return 'Total: ' + (ut2 !== null ? ut2 : fmtValue(sum));
          }
        }
      }
    }
  };
  if (cfg.xType === 'linear') {
    labelScale.type = 'linear';
    labelScale.beginAtZero = false;
    labelScale.ticks.precision = 0;
    if (typeof cfg.xMin === 'number') labelScale.min = cfg.xMin;
  }
  // Phase 96-07: optional bold tick (e.g. the 'Today' column in Workload).
  if (typeof cfg.boldTick === 'number') {
    labelScale.ticks.font = function (tctx) { return { size: 12, weight: tctx.index === cfg.boldTick ? '700' : '400' }; };
  }
  // Opt-in: long category names (Top 10 products) are cut with an ellipsis instead of clipped at the edge.
  if (cfg.labelMaxChars > 0) {
    labelScale.ticks.callback = function (val) {
      var full = String(this && this.getLabelForValue ? this.getLabelForValue(val) : val);
      return full.length > cfg.labelMaxChars ? full.slice(0, cfg.labelMaxChars - 1) + '…' : full;
    };
  }
  // Bar-end labels are drawn past the bar end, so leave room for the longest one or it is clipped.
  if (typeof cfg.dataLabels === 'function' && !isDoughnut) {
    var maxLabelLen = 0;
    for (var li = 0; li < (cfg.labels || []).length; li++) {
      for (var ls = 0; ls < series.length; ls++) {
        var lt = cfg.dataLabels(li, ls);
        if (lt !== null && lt !== undefined && String(lt).length > maxLabelLen) maxLabelLen = String(lt).length;
      }
    }
    options.layout = { padding: cfg.horizontal ? { right: maxLabelLen * 7 + 8 } : { top: 16 } };
  }
  var addTitle = function (scale, text) {
    if (text) scale.title = { display: true, text: text, color: theme.tick, font: { size: 12 } };
  };
  addTitle(labelScale,cfg.horizontal ? cfg.yTitle : cfg.xTitle);
  addTitle(valueScale, cfg.horizontal ? cfg.xTitle : cfg.yTitle);
  if (!isDoughnut) {
    options.scales = cfg.horizontal ? { x: valueScale, y: labelScale } : { x: labelScale, y: valueScale };
    if (cfg.horizontal) options.indexAxis = 'y';
  }

  var plugins = [];
  if (typeof cfg.dataLabels === 'function') {
    plugins.push({
      id: 'dashDataLabels',
      afterDatasetsDraw: function (inst) {
        var ctx = inst.ctx;
        ctx.save();
        ctx.fillStyle = theme.inkPrimary;
        ctx.font = '12px ' + theme.font;
        ctx.textBaseline = 'middle';
        var metas = inst.data.datasets;
        for (var d = 0; d < metas.length; d++) {
          var meta = inst.getDatasetMeta(d);
          if (meta && meta.hidden) continue;
          for (var e = 0; e < meta.data.length; e++) {
            var text = cfg.dataLabels(e, d);
            if (text === null || text === undefined || text === '') continue;
            var el = meta.data[e];
            if (cfg.horizontal) {
              ctx.textAlign = 'left';
              ctx.fillText(String(text), el.x + 4, el.y);
            } else {
              ctx.textAlign = 'center';
              ctx.fillText(String(text), el.x, el.y - 8);
            }
          }
        }
        ctx.restore();
      }
    });
  }
  if (cfg.vLines && cfg.vLines.length) {
    plugins.push({
      id: 'dashVLines',
      afterDatasetsDraw: function (inst) {
        var ctx = inst.ctx;
        var xs = inst.scales && inst.scales.x;
        var area = inst.chartArea;
        if (!xs || !area) return;
        ctx.save();
        ctx.font = '12px ' + theme.font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        var q;
        // All lines first, then every label on a background, so no line crosses another line's label.
        for (q = 0; q < cfg.vLines.length; q++) {
          var vl = cfg.vLines[q];
          var px = xs.getPixelForValue(vl.value);
          ctx.strokeStyle = vl.colour || theme.inkSecondary;
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(px, area.top);
          ctx.lineTo(px, area.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        for (q = 0; q < cfg.vLines.length; q++) {
          var vq = cfg.vLines[q];
          if (!vq.label) continue;
          var lx = xs.getPixelForValue(vq.value) + 4;
          var ly = area.top + q * 12;
          if (ctx.measureText && ctx.fillRect) {
            var lw = ctx.measureText(String(vq.label)).width;
            if (area.right && lx + lw > area.right) lx = Math.max(area.left || 0, lx - lw - 8);
            ctx.fillStyle = theme.separator;
            ctx.fillRect(lx - 2, ly - 1, lw + 4, 13);
          }
          ctx.fillStyle = vq.colour || theme.inkSecondary;
          ctx.fillText(String(vq.label), lx, ly);
        }
        ctx.restore();
      }
    });
  }

  if (typeof cfg.onClick === 'function') {
    options.onClick = function (evt, elements, chartInst) {
      var inst = chartInst || Chart.getChart(canvas);
      if (!inst) return;
      var hit = inst.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
      if (hit && hit.length) {
        var key = series[hit[0].datasetIndex] ? series[hit[0].datasetIndex].key : null;
        if (key !== null && cfg.inertKeys && cfg.inertKeys.indexOf(key) !== -1) return;
        var payload = { index: hit[0].index, key: key };
        // Opt-in: existing Phase 95 call sites (and their locked tests) expect exactly {index, key}.
        if (cfg.hitDatasetIndex) payload.datasetIndex = hit[0].datasetIndex;
        cfg.onClick(payload);
        return;
      }
      var col = inst.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
      if (col && col.length) {
        var colPayload = { index: col[0].index, key: null };
        if (cfg.hitDatasetIndex) colPayload.datasetIndex = null;
        cfg.onClick(colPayload);
      }
    };
    canvas.style.cursor = 'pointer';
  }

  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', cfg.ariaLabel || '');

  return new Chart(canvas, {
    type: cfg.type,
    data: { labels: cfg.labels, datasets: datasets },
    options: options,
    plugins: plugins
  });
}

// Session staleness check — returns true if token is older than thresholdMs
function isSessionStale(lastTokenTime, thresholdMs) {
  if (!lastTokenTime || !thresholdMs) return true;
  return Date.now() - lastTokenTime > thresholdMs;
}

// Session expiry check — returns true if login_at is older than maxAgeMs
function isSessionExpired(loginAt, maxAgeMs) {
  if (!loginAt || !maxAgeMs) return true;
  return Date.now() - loginAt > maxAgeMs;
}

// Plato-based ABV estimation formula
function calcAbv(og, fg) {
  return (og - fg) / (2.0665 - 0.010665 * og);
}

// Optional `now` param makes this testable without real-time dependency
function renderDataGapWarning(readings, now) {
  if (!readings || readings.length === 0) return '';
  var last = readings[readings.length - 1];
  if (!last || !last.timestamp) return '';
  var lastDate = new Date(last.timestamp);
  var today = now ? new Date(now) : new Date();
  var daysSince = Math.floor((today - lastDate) / 86400000);
  if (daysSince < 3) return '';
  var cls = daysSince >= 7 ? 'bp-chart-warning--danger' : 'bp-chart-warning--warn';
  return '<div class="bp-chart-warning ' + cls + '">' +
    '\u26a0\ufe0f Last reading ' + daysSince + ' day' + (daysSince !== 1 ? 's' : '') + ' ago</div>';
}

/**
 * Determine if a batch should show the kiosk source badge.
 * Per D-11: visible only for kiosk sales (source kiosk, or kiosk_recipe from a
 * kiosk recipe sale) while status=pending.
 * @param {string} source - batch source value
 * @param {string} status - batch status value (already lowercased statusKey)
 * @returns {boolean}
 */
function shouldShowKioskBadge(source, status) {
  return (source === 'kiosk' || source === 'kiosk_recipe') && (status || '').toLowerCase() === 'pending';
}

/**
 * Derive a per-unit "Unit X of N" label for a batch belonging to a multi-unit
 * invoice line (D-03). No stored unit_index — the ordinal is derived purely
 * at render time from the existing sequential batch_id.
 *
 * Group key is exactly (zoho_so_number, product_sku) — never batch_id alone.
 * A non-empty zoho_so_number is required to form a group (an empty/missing
 * zoho_so_number never groups with another empty one). Groups of size <= 1
 * render no label.
 *
 * @param {Object} batch - the batch to label (needs batch_id, zoho_so_number, product_sku)
 * @param {Array} allBatches - full unfiltered batch list (sibling search source)
 * @returns {string} e.g. 'Unit 2 of 3', or '' when the batch is not part of a multi-unit group
 */
// Extract the trailing integer from a batch_id (e.g. 'SV-B-000184' -> 184,
// 'SV-B-EXISTING-2' -> 2). Returns null when the id has no trailing digits, so
// callers can fall back to string collation.
function trailingBatchInt(id) {
  var m = /(\d+)\s*$/.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : null;
}

function computeUnitLabel(batch, allBatches) {
  if (!batch || !batch.zoho_so_number) return '';
  var group = (allBatches || []).filter(function (b) {
    return b && b.zoho_so_number === batch.zoho_so_number && b.product_sku === batch.product_sku;
  });
  if (group.length <= 1) return '';
  // WR-02: order by creation sequence via the trailing integer of batch_id, so mixed
  // or non-zero-padded IDs (e.g. legacy 'SV-B-EXISTING-2' vs 'SV-B-000184', or
  // '...-9' vs '...-10') still sort by unit order. A plain lexicographic sort only
  // holds for uniform fixed-width zero-padded IDs. Fall back to numeric-aware
  // collation (then plain string) when a trailing integer is absent or ties.
  group.sort(function (a, b) {
    var na = trailingBatchInt(a.batch_id);
    var nb = trailingBatchInt(b.batch_id);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    return String(a.batch_id || '')
      .localeCompare(String(b.batch_id || ''), undefined, { numeric: true });
  });
  var idx = -1;
  for (var i = 0; i < group.length; i++) {
    if (group[i].batch_id === batch.batch_id) { idx = i; break; }
  }
  if (idx === -1) return '';
  return 'Unit ' + (idx + 1) + ' of ' + group.length;
}

function buildLifecycleTimeline(batch, soDate) {
  var events = [
    { label: 'Sale & Invoice Created', date: soDate, soRef: batch.zoho_so_number || '' },
    { label: 'Batch Created',          date: batch.created_at },
    { label: 'Fermentation Started',   date: batch.fermentation_started_at },
    { label: 'Batch Completed',        date: batch.completed_at }
  ];

  var html = '<div class="bp-timeline">';
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var done = !!ev.date;
    html += '<div class="bp-timeline-item' + (done ? ' bp-timeline-item--done' : '') + '">';
    html += '<div class="bp-timeline-spine">';
    html += '<div class="bp-timeline-dot ' + (done ? 'bp-timeline-dot--done' : 'bp-timeline-dot--pending') + '"></div>';
    html += '<div class="bp-timeline-line"></div>';
    html += '</div>';
    html += '<div class="bp-timeline-body">';
    var labelText = ev.label;
    if (ev.soRef) labelText += ' — ' + escapeHTML(ev.soRef);
    html += '<span class="bp-timeline-label">' + labelText + '</span>';
    if (done) {
      html += '<span class="bp-timeline-date">' + fmtDate(ev.date) + '</span>';
    } else {
      html += '<span class="bp-timeline-pending-note">(pending)</span>';
    }
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

// --- Pull from Zoho pure helpers (Phase 29.3, D-05/06/09) ---

// Build an HTML row string for a candidate invoice in the pull-confirm sheet.
// Escapes all dynamic values to prevent XSS (T-29.3-10).
// Shows a DRAFT badge when candidate.status === 'draft' (D-05).
function buildPullCandidateRowHtml(candidate) {
  var invNum = escapeHTML(candidate.invoice_number || '');
  var custName = escapeHTML(candidate.customer_name || '');
  var draftBadge = (candidate.status === 'draft')
    ? ' <span style="display:inline-block;padding:0 6px;border-radius:4px;background:#e67e22;color:#fff;font-size:0.72rem;font-weight:700;vertical-align:middle;">DRAFT</span>'
    : '';
  var kitItemsHtml = '';
  var items = candidate.kit_items || [];
  for (var i = 0; i < items.length; i++) {
    kitItemsHtml += '<li>' + escapeHTML(items[i].name || '') + '</li>';
  }
  var kitSection = kitItemsHtml ? '<ul style="margin:4px 0 0 16px;padding:0;font-size:0.85rem;">' + kitItemsHtml + '</ul>' : '';
  return '<div class="bp-pull-candidate-row" data-invoice-id="' + escapeHTML(candidate.invoice_id || '') + '">' +
    '<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px 0;">' +
    '<input type="checkbox" class="bp-pull-candidate-chk" checked style="margin-top:3px;flex-shrink:0;">' +
    '<span>' +
    '<strong>' + invNum + '</strong>' + draftBadge + ' &mdash; ' + custName +
    kitSection +
    '</span>' +
    '</label>' +
    '</div>';
}

// Build the POST body for /api/batch/bulk-create from selected candidates.
// Sends invoice_ids ONLY — server resolves all batch data (D-06, T-29.3-09).
function buildBulkCreatePayload(selectedCandidates) {
  var ids = [];
  for (var i = 0; i < selectedCandidates.length; i++) {
    ids.push(selectedCandidates[i].invoice_id);
  }
  return { invoice_ids: ids };
}

// Summarize the bulk-create results array into { okCount, failCount, message }.
// Used to pick the right toast level after a create attempt.
function summarizeBulkResults(results) {
  var okCount = 0;
  var failCount = 0;
  var dupCount = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    // An invoice with multiple kit line items yields multiple batches; the server
    // returns them in kit_results[]. Count each batch, not one per invoice, so the
    // summary reflects the true number created (previously undercounted multi-batch
    // invoices as a single batch).
    if (r && Array.isArray(r.kit_results) && r.kit_results.length) {
      for (var k = 0; k < r.kit_results.length; k++) {
        var kr = r.kit_results[k];
        if (kr && kr.ok) { okCount++; }
        // WR-01: a unit the Apps Script guard reports as already-existing (duplicate)
        // has converged to the desired state — it is NOT a failure, so keep it out of
        // failCount (otherwise an idempotent re-run showed a spurious "N failed" toast).
        else if (kr && kr.duplicate) { dupCount++; }
        else { failCount++; }
      }
    } else if (r && r.duplicate) {
      // Invoice-level convergence: ok is true (satisfied) but nothing was newly
      // created, so count it as a duplicate, not an ok — check this before r.ok.
      dupCount++;
    } else if (r && r.ok) {
      okCount++;
    } else {
      failCount++;
    }
  }
  var message;
  if (failCount === 0 && okCount === 0 && dupCount > 0) {
    message = dupCount + ' batch(es) already exist — nothing new to create';
  } else if (failCount === 0) {
    message = 'Created ' + okCount + ' batch(es)' +
      (dupCount > 0 ? '; ' + dupCount + ' already existed' : '');
  } else if (okCount === 0) {
    message = 'All ' + failCount + ' failed — check batches list';
  } else {
    message = 'Created ' + okCount + ' batch(es); ' + failCount + ' failed — check batches list';
  }
  return { okCount: okCount, failCount: failCount, dupCount: dupCount, message: message };
}

// Validate a user-typed invoice/SO number for single-import mode (D-09).
// Accepts INV-XXXXXX or SO-XXXXXX (case-insensitive). T-29.3-13.
function isValidImportNumber(num) {
  if (!num || typeof num !== 'string') return false;
  return /^(INV|SO)-\d+$/i.test(num);
}

// ===== Recipe Editor Helpers (module-scope for testability) =====

// Inline activation guardrail (D-06). Client-side UX only — server re-validates on PUT.
// Returns { ok: true } or { ok: false, reason: string }.
function canActivateRecipe(formData, ingredients) {
  // This runs on EVERY save of an active recipe, not only on the draft->active
  // transition, so it must not demand a locked price from a recipe that does
  // not use one. A dynamic recipe prices from computed_price and legitimately
  // carries locked_price 0 — requiring one here made active dynamic recipes
  // impossible to rename or edit at all.
  var isDynamic = formData && formData.pricing_mode === 'dynamic';
  if (!isDynamic) {
    var lockedPrice = parseFloat(formData && formData.locked_price);
    if (!lockedPrice || isNaN(lockedPrice) || lockedPrice <= 0) {
      return { ok: false, reason: 'Set a valid locked price before activating this recipe.' };
    }
  }
  if (!ingredients || ingredients.length === 0) {
    return { ok: false, reason: 'Add at least one ingredient before activating this recipe.' };
  }
  return { ok: true };
}

// Build the full formData payload for POST/PUT.
// Filters ingredients to those with item_id AND quantity > 0.
// Sets ingredient_count so the server guardrail can see it (recipes.js L399-412).
function buildRecipePayload(formData, ingredients) {
  var validIngredients = (ingredients || []).filter(function (ing) {
    return ing.item_id && ing.quantity > 0;
  });
  return {
    name: formData.name || '',
    style: formData.style || '',
    beer_category: formData.beer_category || '',
    description: formData.description || '',
    batch_size_l: formData.batch_size_l || 0,
    abv: formData.abv || 0,
    ibu: formData.ibu || 0,
    target_og: formData.target_og != null ? formData.target_og : '', // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    target_fg: formData.target_fg != null ? formData.target_fg : '', // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    colour_srm: formData.colour_srm || 0,
    pricing_mode: formData.pricing_mode || 'locked',
    locked_price: formData.locked_price || 0,
    service_fee: formData.service_fee != null ? formData.service_fee : 45, // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    materials_fee: formData.materials_fee != null ? formData.materials_fee : 5, // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    status: formData.status || 'draft',
    ingredients: validIngredients,
    ingredient_count: validIngredients.length
  };
}

// Pure helper — returns the confirm-sheet message for recipe delete.
// Lifted to module scope so Jest can import + test it directly.
function recipeDeleteConfirmMessage(name) {
  return 'Delete recipe "' + (name || '') + '"? This cannot be undone.';
}

// =============================================================================
// Phase 36: bpScaleIngredients — pure scaling helper.
// Lifted to module scope for unit-testing parity with lib/recipe-scaling.js.
//
// Unit classification mirrors zoho-middleware/lib/recipe-scaling.js EXACTLY:
//   CONTINUOUS: kg, g, l, ml → linear (4dp float-safe round)
//   DISCRETE:   pcs, each, unit, pkg, ft → Math.max(1, Math.ceil(rawQty))
//   Non-blank, unknown → discrete (conservative default)
//   Blank / null → continuous (D-03: unknown blank → linear)
//
// Returns new array of shallow-cloned ingredients; never mutates input.
// =============================================================================
var BP_CONTINUOUS_UNITS = ['kg', 'g', 'l', 'ml'];
var BP_DISCRETE_UNITS   = ['pcs', 'each', 'unit', 'pkg', 'ft'];

function bpScaleIngredient(ing, factor) {
  var rawQty    = (Number(ing.quantity) || 0) * factor;
  var unitLower = (ing.unit || '').toLowerCase().trim();

  var isContinuous = BP_CONTINUOUS_UNITS.indexOf(unitLower) !== -1;
  var isDiscrete   = BP_DISCRETE_UNITS.indexOf(unitLower)   !== -1;

  // D-03: blank unit → continuous (linear)
  if (!unitLower) {
    isContinuous = true;
    isDiscrete   = false;
  } else if (!isContinuous && !isDiscrete) {
    // Non-blank unknown token → discrete (conservative default)
    isDiscrete = true;
  }

  var scaledQty = isDiscrete
    ? Math.max(1, Math.ceil(rawQty))
    : Math.round(rawQty * 10000) / 10000; // 4dp prevents float drift

  return Object.assign({}, ing, { quantity: scaledQty });
}

function bpScaleIngredients(list, factor) {
  return (list || []).map(function (ing) {
    return bpScaleIngredient(ing, factor);
  });
}

// =============================================================================
// Phase 73-07: bpIngredientLineCost — unit-aware editor cost helper (CR-02).
// Mirrors zoho-middleware/lib/recipe-scaling.js classifyUnit/ingredientLineCost
// EXACTLY (same conversion table, same 4dp intermediate rounding, same
// fail-closed shape on cross-family/unrecognised units). This is the ONE
// helper the editor's per-row Cost/Retail columns + Totals footer route
// through instead of hand-rolling `qty * rate` — that raw math silently
// produced a ~20x-1000x-wrong preview for mixed-unit lines (e.g. a 12 g
// line against a $54/kg catalog item showed $648 instead of $0.65), and
// that preview is what staff read when setting a recipe's locked_price.
//
// IMPORTANT: `item` here must carry the CATALOG unit (e.g. ing.catalog_unit),
// NOT the recipe-line unit — see enrichIngredientsWithCatalogRates and
// selectIngredientFromAutocompleteBp, which record catalog_unit as a field
// DISTINCT from the line's own `unit` so a g-line against a kg catalog item
// actually converts (passing the same object as both item and line no-ops
// the conversion, since itemUnit === lineUnit collapses to a no-op factor).
// =============================================================================
var BP_MASS_FACTORS = { kg: 1, g: 0.001 };
var BP_VOLUME_FACTORS = { l: 1, ml: 0.001 };
var BP_COUNT_UNITS = ['pcs', 'ea', 'each', 'unit', 'pkg', 'pack'];

function bpClassifyUnit(raw) {
  var norm = (raw || '').toLowerCase().trim();
  var family = null;

  if (Object.prototype.hasOwnProperty.call(BP_MASS_FACTORS, norm)) {
    family = 'mass';
  } else if (Object.prototype.hasOwnProperty.call(BP_VOLUME_FACTORS, norm)) {
    family = 'volume';
  } else if (BP_COUNT_UNITS.indexOf(norm) !== -1) {
    family = 'count';
  }

  return { family: family, norm: norm };
}

// Units the recipe editor may offer for a line, given its catalog item's unit.
// Constrained to the catalog unit's family: cross-family conversion needs a
// per-substance density the system deliberately does not guess, so offering
// (say) "L" for a kg-priced item would let the editor create a line that the
// pricing path, the availability check and the save validator all reject.
// An existing incompatible unit is surfaced FIRST so bad data stays visible
// and repairable rather than silently swapped.
function unitOptionsFor(catalogUnit, currentUnit) {
  var family = bpClassifyUnit(catalogUnit).family;
  var opts;
  if (family === 'mass') {
    opts = ['g', 'kg'];
  } else if (family === 'volume') {
    opts = ['ml', 'l'];
  } else if (family === 'count') {
    opts = BP_COUNT_UNITS.slice();
  } else {
    // Unknown/absent catalog unit — do not lock the row down; offer everything
    // so the user can still correct it.
    opts = ['g', 'kg', 'ml', 'l'].concat(BP_COUNT_UNITS);
  }
  var cur = (currentUnit || '').trim();
  if (cur && opts.indexOf(cur) === -1 && opts.indexOf(cur.toLowerCase()) === -1) {
    opts = [cur].concat(opts);
  }
  return opts;
}

// @param {Object} item - catalog view { unit, rate } — unit MUST be the catalog unit.
// @param {Object} line - recipe-line view { unit, quantity } — unit MUST be the line unit.
// @returns {{ ok: true, convertedQty: number, cost: number } | { ok: false, error: string }}
function bpIngredientLineCost(item, line) {
  var itemUnit = bpClassifyUnit(item && item.unit);
  var lineUnit = bpClassifyUnit(line && line.unit);
  var rate = Number(item && item.rate) || 0;
  var qty = Number(line && line.quantity) || 0;

  var convertible = itemUnit.family !== null && itemUnit.family === lineUnit.family;

  if (!convertible) {
    var label = (item && (item.name || item.item_name || item.item_id)) || 'item';
    return {
      ok: false,
      error: 'Cannot price "' + label + '": recipe unit "' + (line && line.unit) +
        '" is not convertible to item unit "' + (item && item.unit) + '"'
    };
  }

  var convertedQty;
  if (itemUnit.family === 'count') {
    convertedQty = qty;
  } else {
    var factors = itemUnit.family === 'mass' ? BP_MASS_FACTORS : BP_VOLUME_FACTORS;
    convertedQty = qty * (factors[lineUnit.norm] / factors[itemUnit.norm]);
    convertedQty = Math.round(convertedQty * 10000) / 10000; // 4dp, prevents float drift
  }

  var cost = Math.round(convertedQty * rate * 10000) / 10000;

  return { ok: true, convertedQty: convertedQty, cost: cost };
}

// ===== Waitlist: pure helpers lifted out of the IIFE for unit-testing (Phase 78) =====

// D-05: one-way progression -- waiting -> contacted -> booked. Deliberately excludes
// 'removed': removed is an exit from the queue, not a step in the forward cycle
// (UI-SPEC.md Phase-Specific Decision 2).
var WAITLIST_STATUS_ORDER = ['waiting', 'contacted', 'booked'];

var WAITLIST_STATUS_LABELS = { waiting: 'Waiting', contacted: 'Contacted', booked: 'Booked', removed: 'Removed' };

// Mirrors the .bp-status-badge--{neutral,warning,success,danger} classes already shipped.
var WAITLIST_STATUS_COLORS = { waiting: 'neutral', contacted: 'warning', booked: 'success', removed: 'danger' };

// TODO(80-CUTOVER §1a): set this to the beer-waitlist Cal.com event type's slug.
//
// WR-04. The Contact sheet used to take result.data.services[0] -- whichever event
// type bookings.js happened to list first, which today is CALCOM_EVENT_TYPE_FERMENT_KIT.
// The owner overturned the `eventtype` default: the contact flow must NOT resolve to
// the ferment-kit or bottling event type, it needs a new beer/waitlist-specific one.
// That event type does not exist yet (§1a steps (a)/(b) are the owner's to perform), so
// its slug is genuinely unknowable here and is deliberately NOT invented.
//
// The beer-waitlist Cal.com event type's slug, confirmed by the owner 2026-09-05:
// https://cal.com/steins-and-vines-tw8csc/beer-consult (event type id 6955754,
// surfaced through CALCOM_EVENT_TYPE_BEER_WAITLIST — see bookings.js).
//
// Selection is by slug, never by array position: an unmatched lookup yields no
// service, so bookingUrl stays falsy and the sheet shows "Could not prepare the
// booking link" — fail LOUDLY and CLOSED rather than silently mailing a waitlist
// customer a ferment-kit or bottling link. If this slug and the Cal.com event ever
// diverge, the flow stops; it does not mis-send.
var WAITLIST_BOOKING_SLUG = 'beer-consult';

// D-05 ONE-WAY: returns the next status in WAITLIST_STATUS_ORDER, or null when there is
// none (booked, removed, or any unrecognized value). Deliberately does NOT use
// `% WAITLIST_STATUS_ORDER.length` -- the batch-status handler wraps around
// (js/brewpad.js:5690-5692), but copying that here would silently reopen a booked
// customer's spot. See UI-SPEC.md Phase-Specific Decision 2.
function nextWaitlistStatus(current) {
  var idx = WAITLIST_STATUS_ORDER.indexOf(current);
  if (idx === -1 || idx === WAITLIST_STATUS_ORDER.length - 1) return null;
  return WAITLIST_STATUS_ORDER[idx + 1];
}

// D-07: the Apps Script side already coerces mailerlite_synced to a real boolean, but a
// hand-pasted D-04 backfill cell may reach the client as a string, so the client
// normalizes too.
function isWaitlistSynced(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    var v = value.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === 'y' || v === '1';
  }
  return false;
}

// D-10: returns a positive integer when `value` coerces to one (accepting the numeric
// string form the sheet may return, e.g. '2'), otherwise null. Only a positive integer
// pins a row -- everything else (0, negative, non-integer, non-numeric, empty, null,
// undefined) is treated as unpinned. ES5 only.
function parseWaitlistPosition(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  if (isNaN(n) || !isFinite(n)) return null;
  if (n !== Math.floor(n)) return null;
  if (n <= 0) return null;
  return n;
}

// Returns a NEW array (never mutates `rows`) sorted by signed_up_at ascending (oldest
// first), comparing the raw ISO strings. A row with a missing/unparseable signed_up_at
// sorts LAST, in its original relative order, so a backfilled undated row never
// displaces a dated one from the front of the queue (UI-SPEC.md §3).
//
// D-10 EXTENSION (Phase 80-03): rows carrying a positive-integer `position`
// (parseWaitlistPosition) are pinned -- split out, sorted by ascending position with an
// original-index tiebreak, then merge-inserted into the unpinned output at their target
// 1-based rank (clamped to the end so an out-of-range position never drops the row or
// creates a gap). Unpinned rows keep the EXACT existing chronological comparator above,
// byte-for-byte -- this is a pure render-time splice; no cell is ever rewritten.
function sortWaitlistRows(rows) {
  var input = rows || [];
  var pinned = [];
  var unpinned = [];
  for (var i = 0; i < input.length; i++) {
    var row = input[i];
    var pos = parseWaitlistPosition(row && row.position);
    if (pos !== null) {
      pinned.push({ row: row, pos: pos, i: i });
    } else {
      unpinned.push({ row: row, i: i });
    }
  }
  unpinned.sort(function (a, b) {
    var sa = a.row && a.row.signed_up_at;
    var sb = b.row && b.row.signed_up_at;
    var aValid = typeof sa === 'string' && sa !== '' && !isNaN(Date.parse(sa));
    var bValid = typeof sb === 'string' && sb !== '' && !isNaN(Date.parse(sb));
    if (!aValid && !bValid) return a.i - b.i;
    if (!aValid) return 1;
    if (!bValid) return -1;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a.i - b.i;
  });
  pinned.sort(function (a, b) { return a.pos - b.pos || a.i - b.i; });
  var out = unpinned.map(function (x) { return x.row; });
  // lastIdx guards against two rows pinned to the same slot landing in reverse order:
  // pinned is already sorted ascending (pos, then original index), so if this row's
  // clamped target collides with (or falls behind) the previous insertion, place it
  // immediately after instead -- preserving the ascending-index stable tiebreak.
  var lastIdx = -1;
  pinned.forEach(function (p) {
    var idx = Math.max(0, Math.min(p.pos - 1, out.length));
    if (idx <= lastIdx) idx = lastIdx + 1;
    out.splice(idx, 0, p.row);
    lastIdx = idx;
  });
  return out;
}

// Ranks each row (1-based) among rows whose status === 'waiting', in the order given
// (call with the output of sortWaitlistRows). Any row not in 'waiting' gets null. A
// number is shown only while an entry is still genuinely next in line -- a stale
// number on an already-contacted entry would mislead staff (UI-SPEC.md §3).
function computeWaitlistQueuePositions(sortedRows) {
  var positions = [];
  var counter = 0;
  (sortedRows || []).forEach(function (row) {
    if (row && row.status === 'waiting') {
      counter++;
      positions.push(counter);
    } else {
      positions.push(null);
    }
  });
  return positions;
}

// statusFilter: 'all' | 'waiting' | 'contacted' | 'booked' | 'removed' | 'notSynced'.
// 'notSynced' matches isWaitlistSynced(row.mailerlite_synced) === false regardless of
// status (D-07). searchText matches row.email case-insensitively as a trimmed
// substring; empty/whitespace-only search matches everything. Preserves input order.
function filterWaitlistRows(rows, statusFilter, searchText) {
  var input = rows || [];
  var search = (searchText || '').trim().toLowerCase();
  return input.filter(function (row) {
    if (!row) return false;
    var statusOk;
    if (!statusFilter || statusFilter === 'all') {
      statusOk = true;
    } else if (statusFilter === 'notSynced') {
      statusOk = !isWaitlistSynced(row.mailerlite_synced);
    } else {
      statusOk = row.status === statusFilter;
    }
    if (!statusOk) return false;
    if (!search) return true;
    var email = String(row.email || '').trim().toLowerCase();
    return email.indexOf(search) !== -1;
  });
}

// D-02: the Category column is shown only when the fetched data holds more than one
// distinct non-empty category (compared trimmed + lowercased). Beer-only data returns
// false; the moment cider/wine rows land in the same tab this flips to true with no
// code change (UI-SPEC.md §5).
function shouldShowWaitlistCategoryColumn(rows) {
  var seen = {};
  var count = 0;
  (rows || []).forEach(function (row) {
    var cat = String((row && row.category) || '').trim().toLowerCase();
    if (!cat || seen[cat]) return;
    seen[cat] = true;
    count++;
  });
  return count > 1;
}

// D-15/D-16: client-side mirror of the Apps Script `parseWaitlistRecipeIds` helper.
// `recipe_ids` is stored as a pipe-delimited string (recipe ids look like
// 'SV-R-000003' and contain no pipes). Splits on '|', drops empty segments (so a
// leading/trailing/double pipe never produces a phantom chip), and preserves order.
function parseWaitlistRecipeIds(value) {
  if (!value) return [];
  return String(value).split('|').filter(function (id) { return id !== ''; });
}

(function () {
  'use strict';

  // ===== State =====

  var accessToken = null;
  var userEmail = null;
  var tokenClient = null;
  // Phase 76-03 (D-02): the ~1hr proactive Google-token refresh timers
  // (a periodic refresh interval + a warn-before-expiry timeout) and the Apps-Script-401
  // "wipe sv_session on any auth-shaped failure" machinery they fed are
  // DELETED, not hardened -- runtime traffic no longer depends on a live
  // Google token (D-01), so nothing needs to keep one warm while the app is
  // open. _googleResumeTimer (below, formerly a differently-named timer) is
  // the one piece that survives: the login-time "get a fresh Google token
  // silently so the mandatory per-page-load /auth/google exchange doesn't
  // need a popup" flow (doSilentRefreshOnLoad) is unrelated to that bug --
  // see RESEARCH.md Open Question #1 / 76-03-SUMMARY.md.
  var _googleResumeTimer = null;
  // Phase 76-03 (D-03): guards the SOLE full-re-login trigger (a real
  // middleware HTTP 401, or another tab explicitly signing out) so it fires
  // exactly once. Reset on a fresh successful checkAuthorization() (login).
  var _sessionLoggedOut = false;
  var _refreshInFlight = false;
  var _lastTokenTime = 0;
  var _visibilityListenerAdded = false;
  var _formSavers = [];
  var RECIPE_DRAFT_KEY = 'sv-brewpad-recipe-draft'; // D-05a: recipe editor draft session key
  var _activeTab = 'dashboard';

  // Batches
  var _batchesData = [];
  var _allBatchesData = [];  // full unfiltered batch list (all statuses) — source of truth for filter/search
  var _eagerLoadDone = false;
  var _eagerLoadTime = 0;
  var _eagerLoading = false;   // review WR-03: boot load in flight (it re-renders the dashboard itself)
  var _batchesLoaded = false;
  var _batchesLoading = false;
  var _batchesLoadTime = 0;
  var _batchStatusFilter = 'active';
  var _batchProductFilter = '';
  var _batchSearch = '';
  var _dashDrill = null;          // Phase 95 (D-14): { ids: {id:true}, count, label } while a dashboard click-through is active
  var _batchSearchTimer = null;   // module-scope so switchTab() can cancel a pending re-render
  var _batchViewMode = 'cards';   // 'cards' or 'table'
  var _batchTableSortCol = 'batch_id';
  var _batchTableSortDir = 1;
  var _selectedBatchId = null;
  var _batchDetailReturnTab = null;  // tab to return to when closing batch detail
  var _vesselsData = null;
  var _vesselsCacheTime = 0;       // TTL: reload vessel list if >30s stale
  var _vesselsMap = {};            // keyed by vessel_id for O(1) lookup
  var _fermSchedules = [];
  var _fermSchedulesCacheTime = 0; // TTL: reload schedule list if >5min stale
  var _batchSubView = 'batches';   // 'batches' or 'schedules'
  var _schedSteps = [];            // temp state for schedule editor form

  // Batch detail
  var _detailPlatoStaging = [];
  var _detailPlatoReadings = [];
  var _detailStartDate = null;
  var _detailBatchId = null;
  var _soSearchTimer = null;
  var _reassignSearchTimer = null;
  var _pendingReassign = null;
  var _currentBatchDetail = null;

  // Tasks
  var _upcomingTasks = [];
  var _upcomingLoaded = false;
  var _upcomingLoadTime = 0;
  var _taskSaveTimers = {};    // keyed by taskId — per-checkbox auto-save debounce
  var _taskFilter = 'incomplete';
  var _taskSearch = '';
  var _taskSearchTimer = null;
  var _chartCache = {};        // keyed by batchId+readingCount+lastTimestamp

  // Waitlist (Phase 78)
  var _waitlistRows = [];
  var _waitlistFilter = 'all';
  var _waitlistSearch = '';
  var _waitlistSearchTimer = null;

  // Preload state — touchstart pre-fetch + top-3 background fetch
  var _preloadBatchId = null;
  var _preloadPromise = null;
  var _batchDetailPreloaded = false;

  // Measurements
  var _measBatches = [];
  var _measSharedDate = '';      // shared date for multi-batch sweep entry
  var _measMultiData = {};       // batchId -> {plato, temp, ph, notes} for current session
  var _measFilterText = '';      // grid search filter
  var _measFilterTimer = null;   // debounce timer for grid filter
  var _measSortCol = 'batch_id';
  var _measSortDir = 1;   // 1=asc, -1=desc

  // Dashboard
  var _dashSummary = null;
  var _dashData = null;   // Phase 94: get_dashboard_stats aggregate ({asOf, batches, ...}) or null (sheets fallback)
  var _dashLoadTime = 0;
  var _dashAutoRefreshTimer = null;
  var _dashV2On = false;          // Phase 95-06: per-device v2 opt-in
  var _dashV2State = null;        // sanitised filter state
  var _dashV2Model = null;        // last buildDashV2Model result
  var _dashV2Seq = 0;
  var _dashV2WidgetOpts = {};     // Phase 96: 'w:opt' -> value; in memory only, never hash/localStorage
  var _dashV2Drills = {};         // Phase 96: widgetKey -> [{ids, label}] rebuilt each render
  var _dashV2Expanded = {};       // Phase 96: 'w:list' -> true when "Show all" is on
  var _dashV2ChartState = 'pending';
  var _dashV2Charts = {};         // slotId -> Chart instance (filled by plan 08)
  var _dashV2RangeOpen = false;   // custom range row open on tablet
  var _dashV2Stage = null;        // phone sheet staged state
  var _notesAutoSaveTimer = null;
  var _dashExpandedDay = null;
  var _dashRtbExpanded = false;
  var _dashNeedsSchedExpanded = false;
  var _dashChartHiddenTypes = {}; // map of type -> true when toggled off in the Batches-by-Month chart
  var _dashWineDimension = 'subcategory'; // active dimension: 'subcategory'|'brand'|'manufacturer'|'time'
  var _dashWinePeriod = '6mo';            // active sample period: '30d'|'90d'|'6mo'|'12mo'|'all'
  var _dashWineSkuLookup = null;          // cached sku -> product map; null = not yet loaded
  var _dashWineSkuError = false;          // true if snapshot fetch failed
  var _dashWineSkuLoading = false;        // in-flight guard — prevents re-entrant fetch loop

  // Product catalog
  var _kitCatalog = null;
  var _productPickerTab = 'kits'; // 'kits' | 'recipes' — Phase 16 tabbed picker state

  var CACHE_TTL = 300000;       // 5min per-tab cache (single-user — safe to cache aggressively)
  var CACHE_TTL_LONG = 600000;  // 10min for batch list + dashboard
  // Kit catalog loaded once per session from published CSV (no TTL needed)

  // ===== Session =====

  var SESSION_KEY = 'sv-brewpad-session';

  function saveSession(token, expiresIn, email, loginAt) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      token: token,
      expires_at: Date.now() + (expiresIn * 1000),
      email: email,
      login_at: loginAt || Date.now()
    }));
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      // Phase 76-03 (D-01/RESEARCH.md Pitfall 2): the client-side 7-day
      // login_at cliff is dropped -- it was a hard, un-renewed cutoff
      // independent of (and shorter-lived than) the server's sliding
      // sv_session expiry (touchSession, Plan 76-02). Trust the server 401
      // as the single source of truth for session validity.
      var tokenValid = data.expires_at > Date.now() + 5 * 60 * 1000;
      return { email: data.email, token: tokenValid ? data.token : null, expires_at: data.expires_at, tokenValid: tokenValid, login_at: data.login_at };
    } catch (e) { return null; }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('sv_session_token');
  }

  // ===== Toast =====

  function showToast(message, type, opts) {
    if (!type) type = 'info';
    if (!opts) opts = {};
    var container = document.getElementById('bp-toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'bp-toast bp-toast--' + type;
    var msgSpan = document.createElement('span');
    msgSpan.className = 'bp-toast-msg';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);
    // D-05d: optional inline action (e.g. "Retry" on a transient save failure).
    if (opts.actionLabel && typeof opts.onAction === 'function') {
      var actionBtn = document.createElement('button');
      actionBtn.className = 'bp-toast-action';
      actionBtn.type = 'button';
      actionBtn.textContent = opts.actionLabel;
      actionBtn.addEventListener('click', function () {
        removeToast(toast);
        opts.onAction();
      });
      toast.appendChild(actionBtn);
    }
    var closeBtn = document.createElement('button');
    closeBtn.className = 'bp-toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () { removeToast(toast); });
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    var duration = opts.duration || (type === 'error' ? 6000 : 3500);
    toast._timer = setTimeout(function () { removeToast(toast); }, duration);
  }

  function removeToast(toast) {
    if (toast._removed) return;
    toast._removed = true;
    clearTimeout(toast._timer);
    toast.classList.add('removing');
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 150);
  }

  // ===== Google OAuth =====

  function initGoogleAuth() {
    // waitForGoogleIdentity / gsiInitTokenClient defined in js/lib/auth.js
    tokenClient = gsiInitTokenClient({
      client_id: SHEETS_CONFIG.CLIENT_ID,
      scope: SHEETS_CONFIG.SCOPES + ' https://www.googleapis.com/auth/userinfo.email',
      callback: onTokenResponse,
      error_callback: function (err) {
        _refreshInFlight = false;
        var dot = document.getElementById('bp-auth-dot');
        if (dot) { dot.className = 'bp-auth-dot bp-auth-dot--offline'; dot.title = 'Not signed in'; }
        // Phase 76-03 (D-02/D-03): a failed/cancelled Google-token mint no
        // longer forces a full sv_session logout -- it only means "not
        // currently holding a fresh Google token". A still-valid sv_session
        // (if any) is untouched; only a real middleware 401 logs out.
        showSignInButton();
      }
    });

    var signoutBtn = document.getElementById('bp-signout');
    if (signoutBtn) signoutBtn.addEventListener('click', bpSignOut);

    var saved = loadSession();

    // Factor the silent-refresh-on-load path so both the expired-token branch and
    // the stored-token graceful-fallback can call it without duplicating logic.
    function doSilentRefreshOnLoad() {
      // Show a loading indicator while the silent token refresh is in flight.
      var signinCard = document.querySelector('.bp-signin-card');
      if (signinCard) {
        var resumeEl = document.createElement('p');
        resumeEl.id = 'bp-resuming-msg';
        resumeEl.style.cssText = 'text-align:center;color:var(--ink-secondary);font-size:0.95rem;margin-top:12px;';
        resumeEl.textContent = 'Resuming session\u2026';
        signinCard.appendChild(resumeEl);
      }
      // Fallback: if no response in 15s, just show the signin button.
      // Do NOT clear session here — the token may still arrive.
      _googleResumeTimer = setTimeout(function () {
        _googleResumeTimer = null;
        showSignInButton();
      }, 15000);
      var _refreshAttempts = 0;
      function attemptSilentRefresh() {
        try {
          tokenClient.requestAccessToken({ prompt: '', login_hint: saved.email });
        } catch (err) {
          _refreshAttempts++;
          if (_refreshAttempts < 3) {
            setTimeout(attemptSilentRefresh, 1000 * _refreshAttempts);
          } else {
            clearTimeout(_googleResumeTimer);
            _googleResumeTimer = null;
            // Phase 76-03 (D-03): exhausting the silent-Google-refresh
            // retries does NOT clear sv_session -- a still-valid session
            // (from a prior page load) must survive a Google-side hiccup.
            // Just fall back to showing the manual sign-in button.
            showSignInButton();
          }
        }
      }
      attemptSilentRefresh();
    }

    if (saved && saved.tokenValid && saved.token) {
      // Fast path: stored token is still valid — use it directly.
      // No round-trip to Google; verify with the backend instead.
      // If backend rejects with an auth/network error (not a clean authorized:false),
      // fall back to the silent-refresh path so a stale-but-present token re-auths
      // transparently rather than dead-ending.
      accessToken = saved.token;
      userEmail = saved.email;
      checkAuthorization(function () {
        // checkAuthorization failed (network error or 401) — fall back to silent refresh.
        accessToken = null;
        userEmail = null;
        doSilentRefreshOnLoad();
      });
      return;
    }

    if (saved) {
      // Session exists but token is missing/expired — use the existing silent-refresh path.
      doSilentRefreshOnLoad();
      return;
    }

    showSignInButton();
  }

  function showSignInButton() {
    var resumeEl = document.getElementById('bp-resuming-msg');
    if (resumeEl) resumeEl.parentNode.removeChild(resumeEl);
    var container = document.getElementById('bp-google-signin-btn');
    if (container && !container.querySelector('button')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Sign in with Google';
      btn.addEventListener('click', function () { tokenClient.requestAccessToken(); });
      container.appendChild(btn);
    }
  }

  function showSessionExpiredOverlay() {
    var existing = document.getElementById('bp-session-overlay');
    if (existing) return;
    var overlay = document.createElement('div');
    overlay.id = 'bp-session-overlay';
    overlay.className = 'bp-session-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Session expired');
    overlay.innerHTML =
      '<div class="bp-session-overlay-card">' +
      '<h2>Session expired</h2>' +
      '<p>Sign in to continue. Your in-progress work has been saved.</p>' +
      '<button type="button" class="btn" id="bp-session-overlay-signin">Sign in with Google</button>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () {
      overlay.classList.add('bp-session-overlay--visible');
    });
    document.getElementById('bp-session-overlay-signin').addEventListener('click', function () {
      if (tokenClient) tokenClient.requestAccessToken();
    });
  }

  function tryRefreshToken() {
    if (_refreshInFlight) return;
    var session = loadSession();
    var email = (session && session.email) || userEmail || '';
    if (!tokenClient) return;
    _refreshInFlight = true;
    var dot = document.getElementById('bp-auth-dot');
    if (dot) { dot.className = 'bp-auth-dot bp-auth-dot--refreshing'; dot.title = 'Refreshing session...'; }
    try {
      tokenClient.requestAccessToken({ prompt: '', login_hint: email });
    } catch (err) {
      _refreshInFlight = false;
      if (dot) { dot.className = 'bp-auth-dot bp-auth-dot--offline'; dot.title = 'Not signed in'; }
      // Phase 76-03 (D-02/D-03): a failed Google-token refresh no longer
      // forces a full sv_session logout -- see error_callback above.
    }
  }

  function onTokenResponse(response) {
    if (_googleResumeTimer) { clearTimeout(_googleResumeTimer); _googleResumeTimer = null; }
    _refreshInFlight = false;
    if (response.error) {
      if (accessToken) {
        // Refresh failed while app was active. The Google token is
        // login-only now (D-01/D-02) -- runtime traffic uses
        // sv_session_token, so this does NOT clear a still-valid session
        // (D-03); just reflect "not refreshed" in the UI.
        var dot = document.getElementById('bp-auth-dot');
        if (dot) { dot.className = 'bp-auth-dot bp-auth-dot--offline'; dot.title = 'Not signed in'; }
      } else {
        // Initial/silent auth attempt failed (e.g. user closed popup, or GIS
        // reports an error during the page-load silent refresh -- iPad
        // Safari's third-party-cookie restriction is the common case). This
        // is a Google-side failure, not evidence that sv_session_token is
        // invalid, so it does NOT clear a still-valid session (D-03) -- see
        // the matching fixes above (error_callback, exhausted-retries
        // branch). Just fall back to the manual sign-in screen.
        showSignInButton();
      }
      return;
    }
    accessToken = response.access_token;
    _lastTokenTime = Date.now();
    var expiresIn = response.expires_in || 3600;
    // Remove session expired overlay if present
    var overlay = document.getElementById('bp-session-overlay');
    if (overlay) { overlay.parentNode.removeChild(overlay); }
    // fetchGoogleUserInfo defined in js/lib/auth.js
    fetchGoogleUserInfo(accessToken)
      .then(function (info) {
        userEmail = info.email;
        // Preserve login_at across token refreshes (7-day session persistence)
        var prevLoginAt;
        try { var prev = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); prevLoginAt = prev.login_at; } catch (e) {}
        saveSession(accessToken, expiresIn, userEmail, prevLoginAt);
        checkAuthorization();
      })
      .catch(function () { showDenied(); });
  }

  function checkAuthorization(onError) {
    // D-46-09: verify identity via the server session exchange (sv_session cookie)
    // instead of the Apps-Script check_auth round trip. The onError callback contract
    // is preserved — it is the silent-refresh fallback used by initGoogleAuth's
    // stored-token fast path (see doSilentRefreshOnLoad above).
    fetch(mwUrl() + '/auth/google', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken })
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (result.authorized) {
          // Store the session token for the x-session-token header. The httpOnly
          // sv_session cookie is also set, but browsers don't send it to the
          // cross-site Railway origin — the header carries the same opaque id.
          try { if (result.token) { localStorage.setItem('sv_session_token', result.token); } } catch (e) {}
          // A fresh, successful login re-arms the once-only logout guard so a
          // later real middleware 401 (D-03) can still trigger it.
          _sessionLoggedOut = false;
          showApp();
        } else { showDenied(); }
      })
      .catch(function (err) {
        if (typeof onError === 'function') {
          onError(err);
        } else {
          showDenied();
        }
      });
  }

  function showApp() {
    document.getElementById('bp-signin').style.display = 'none';
    document.getElementById('bp-app').style.display = '';
    var emailEl = document.getElementById('bp-user-email');
    if (emailEl) emailEl.textContent = userEmail;
    var deniedMsg = document.getElementById('bp-denied-msg');
    if (deniedMsg) deniedMsg.style.display = 'none';

    // Auth status dot — online
    var dot = document.getElementById('bp-auth-dot');
    if (dot) { dot.className = 'bp-auth-dot bp-auth-dot--online'; dot.title = 'Signed in as ' + (userEmail || ''); }

    var clearCacheBtn = document.getElementById('bp-clear-cache');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', function () {
        showConfirmSheet('Clear app cache and reload?', 'Clear & Reload', '', function () {
          var done = function () { location.reload(true); };
          if (window.caches) {
            caches.keys().then(function (keys) {
              return Promise.all(keys.map(function (k) { return caches.delete(k); }));
            }).then(function () {
              if (navigator.serviceWorker) {
                navigator.serviceWorker.getRegistrations().then(function (regs) {
                  regs.forEach(function (r) { r.unregister(); });
                  done();
                }).catch(done);
              } else { done(); }
            }).catch(done);
          } else { done(); }
        });
      });
    }

    // Phase 76-03 (D-01/D-02): the ~1hr proactive refresh interval and the
    // 5-min-before-expiry warn timer are DELETED -- both existed solely to
    // keep a runtime Google token alive for adminApiGet/Post, which no
    // longer send one at all. tryRefreshToken() survives only for the
    // visibility-wake path below.

    // Visibility-based wake detection (D-01): on iPad wake from sleep, refresh if stale
    if (!_visibilityListenerAdded) {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        if (!accessToken) return;
        if (isSessionStale(_lastTokenTime, 45 * 60 * 1000)) {
          tryRefreshToken();
        }
      });
      _visibilityListenerAdded = true;
    }

    // Multi-tab session sync: if another tab signs out, sign out this tab too.
    // Phase 76-03: re-routed to the single "session ended" transition
    // (_enterLoggedOutState) shared with the real-middleware-401 interceptor
    // -- not the deleted per-call Apps-Script-401 auth-clearing path.
    window.addEventListener('storage', function (e) {
      if (e.key === SESSION_KEY && !e.newValue && accessToken) {
        _enterLoggedOutState();
      }
    });

    eagerLoad();

    // Restore any in-progress form drafts after re-login (D-06)
    setTimeout(function () {
      var wasRestored = restoreAllFormDrafts();
      if (wasRestored) {
        showToast('Your in-progress work has been restored', 'success');
      }
    }, 200);
  }

  function showDenied() {
    var el = document.getElementById('bp-denied-msg');
    if (el) el.style.display = '';
  }

  function bpSignOut() {
    if (_dashAutoRefreshTimer) { clearInterval(_dashAutoRefreshTimer); _dashAutoRefreshTimer = null; }
    if (accessToken) google.accounts.oauth2.revoke(accessToken);
    accessToken = null;
    userEmail = null;
    clearSession();
    document.getElementById('bp-signin').style.display = '';
    document.getElementById('bp-app').style.display = 'none';
    var emailEl = document.getElementById('bp-user-email');
    if (emailEl) emailEl.textContent = '';
    var dot = document.getElementById('bp-auth-dot');
    if (dot) { dot.className = 'bp-auth-dot bp-auth-dot--offline'; dot.title = 'Not signed in'; }
  }

  function saveAllFormDrafts() {
    _formSavers.forEach(function (saver) {
      try {
        var data = saver.save();
        if (data) {
          sessionStorage.setItem(saver.key, JSON.stringify(data));
        }
      } catch (e) {}
    });
  }

  function restoreAllFormDrafts() {
    var restored = false;
    _formSavers.forEach(function (saver) {
      try {
        var raw = sessionStorage.getItem(saver.key);
        if (raw) {
          saver.restore(JSON.parse(raw));
          sessionStorage.removeItem(saver.key);
          restored = true;
        }
      } catch (e) {}
    });
    return restored;
  }

  // Phase 76-03 (D-01/D-02/D-03): the SOLE "full re-login" transition. Reached
  // either by a real middleware HTTP 401 (_handleMiddlewareResponse below,
  // driven by the fetch-wrapper IIFE's response path) or by another tab
  // explicitly signing out (the multi-tab storage listener above). Never
  // reached by a Google/Apps-Script body substring.
  function _enterLoggedOutState() {
    if (_sessionLoggedOut) return;
    _sessionLoggedOut = true;
    saveAllFormDrafts();
    clearSession();
    accessToken = null;
    userEmail = null;
    var dot = document.getElementById('bp-auth-dot');
    if (dot) { dot.className = 'bp-auth-dot bp-auth-dot--offline'; dot.title = 'Not signed in'; }
    showSessionExpiredOverlay();
  }

  // Module-scope hook (declared at the top of the file) assigned here so the
  // fetch-wrapper IIFE (which runs before this closure exists, and is a no-op
  // under Jest/CommonJS) can still reach this logic at actual fetch-call time,
  // AND so the bottom-of-file module.exports block can export the SAME
  // function Task 1's regression tests drive directly.
  _handleMiddlewareResponse = function (url, response) {
    try {
      var base = mwUrl();
      if (base && (url || '').indexOf(base) === 0 && response && response.status === 401) {
        _enterLoggedOutState();
      }
    } catch (e) { /* never break a fetch over telemetry */ }
    return response;
  };

  // ===== API Helpers =====

  // retryStatuses (optional) — HTTP status codes that should be retried even
  // though the fetch RESOLVED (fetch only rejects on network failure, never on
  // an HTTP error). Pass this ONLY for idempotent reads: the middleware proxy
  // collapses a transient Apps-Script timeout/slow cold-start into a 502
  // (pos.js /api/batch/admin-proxy), and without a status-level retry the
  // heaviest read (get_batches?status=all) silently drops, leaving a
  // false-empty dashboard. Writes MUST NOT pass retryStatuses — re-sending a
  // non-idempotent write on a 502 could double-apply it if Apps Script already
  // processed it before the proxy's 15s timeout fired.
  function fetchWithRetry(url, options, retries, retryStatuses) {
    if (retries === undefined) retries = 1;
    function backoffRetry() {
      return new Promise(function (resolve) {
        setTimeout(resolve, 1000);
      }).then(function () {
        return fetchWithRetry(url, options, retries - 1, retryStatuses);
      });
    }
    return fetch(url, options).then(function (r) {
      if (retryStatuses && retries > 0 && retryStatuses.indexOf(r.status) !== -1) {
        return backoffRetry();
      }
      return r;
    }, function (err) {
      // Network-level rejection (offline, DNS, dropped connection) — always retryable.
      if (retries > 0) return backoffRetry();
      throw err;
    });
  }

  // Phase 76-03 (D-01): both helpers now hit the middleware's allow-listed
  // Apps-Script proxy (Plan 76-02) instead of SHEETS_CONFIG.ADMIN_API_URL
  // directly. No Google token is sent -- identity is proven solely by the
  // x-session-token header the fetch-wrapper IIFE (top of file) attaches to
  // every MIDDLEWARE_URL request. Errors are handled by REAL HTTP status
  // (mirrors postBottlingInvite/bpSaveAsNewRecipe), never a body substring --
  // a real 401 is caught by the SAME status check and routed to the single
  // global _handleMiddlewareResponse interceptor (D-03), not handled here.
  function adminApiGet(action, params) {
    var body = { action: action };
    if (params) {
      Object.keys(params).forEach(function (key) {
        body[key] = params[key];
      });
    }
    // Reads are idempotent: retry twice on the proxy's transient 502/503/504
    // (usually an Apps-Script cold-start timeout that succeeds warm on retry).
    return fetchWithRetry(mwUrl() + '/api/batch/admin-proxy', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 2, [502, 503, 504])
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok || !data || !data.ok) {
            throw new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
          }
          return data;
        });
      });
  }

  function adminApiPost(action, payload) {
    payload = payload || {};
    payload.action = action;
    return fetchWithRetry(mwUrl() + '/api/batch/admin-proxy', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok || !data || !data.ok) {
            var err = new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
            err.code = data && data.code ? data.code : (data && data.error);
            err.status = r.status;
            throw err;
          }
          return data;
        });
      });
  }

  function mwUrl() {
    return (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL) || '';
  }

  // ===== Phase 36: Recipe-Attach Flow — Scale + Modify + Advisory =====
  //
  // D-10: Attach has NO money path — no recipe-quote, no recipe-sale, no Helcim.
  // D-11: Stock advisory is soft (non-blocking) — Attach button never disabled by stock.
  // D-12/D-13/D-14: Save-as-new creates a draft dynamic recipe from the pre-scale base list.

  // Attach-flow state (closure-scoped to the IIFE)
  var _bpTargetVolumeL       = null;   // number | null: selected target volume in litres
  var _bpScaleFactor         = 1.0;    // computed scale factor for display + snapshot
  var _bpModifiedIngredients = null;   // array | null: deep-copied + edited base ingredients
  var _bpResolvedRecipe      = null;   // { recipe, ingredients } from /api/recipes/:id
  var _bpAttachCatalog       = [];     // ingredient catalog for stock advisory (from _recipesState)

  // bpScaleIngredient / bpScaleIngredients are top-level pure functions (above IIFE).
  // They reference BP_CONTINUOUS_UNITS / BP_DISCRETE_UNITS from module scope.

  // ---------------------------------------------------------------------------
  // buildBpAttachSnapshot — builds the recipe_snapshot for the Attach write.
  //
  // Snapshot includes:
  //   name, style, abv, ibu, batch_size_l, notes  — from resolved recipe
  //   og, target_fg                                — recipe target_og / target_fg (null when blank)
  //   target_volume_l                              — from _bpTargetVolumeL
  //   scale_factor                                 — from _bpScaleFactor
  //   ingredients                                  — base ingredient list (for compatibility)
  //   scaledIngredients                            — scaled(_bpModifiedIngredients || base, factor)
  //   modified_base_ingredients                    — _bpModifiedIngredients | null
  //   is_modified                                  — !!_bpModifiedIngredients
  // ---------------------------------------------------------------------------
  function bpGravityOrNull(v) {
    var n = bpFiniteGravity(v);
    return n === '' ? null : n;
  }

  function buildBpAttachSnapshot() {
    if (!_bpResolvedRecipe) return null;
    var snap = _bpResolvedRecipe.recipe || {};
    var baseIngredients = _bpResolvedRecipe.ingredients || [];
    var listToScale = _bpModifiedIngredients || baseIngredients;
    var factor = _bpScaleFactor || 1.0;
    var targetVol = _bpTargetVolumeL != null ? _bpTargetVolumeL : (Number(snap.batch_size_l) || null); // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined

    var mappedBase = baseIngredients.map(function (i) {
      return {
        item_id: i.item_id, item_name: i.item_name, quantity: i.quantity, unit: i.unit,
        cf_type: i.cf_type || '', cf_subcategory: i.cf_subcategory || '', display_group: i.display_group || ''
      };
    });

    return {
      name:                    snap.name || '',
      style:                   snap.style || '',
      abv:                     snap.abv   || 0,
      ibu:                     snap.ibu   || 0,
      og:                      bpGravityOrNull(snap.target_og),
      target_fg:               bpGravityOrNull(snap.target_fg),
      batch_size_l:            snap.batch_size_l || null,
      notes:                   snap.notes || '',
      target_volume_l:         targetVol,
      scale_factor:            factor,
      ingredients:             mappedBase,
      scaledIngredients:       bpScaleIngredients(listToScale, factor),
      modified_base_ingredients: _bpModifiedIngredients || null,
      is_modified:             !!_bpModifiedIngredients
    };
  }

  // ---------------------------------------------------------------------------
  // refreshBpStockAdvisory — checks scaled quantities vs catalog stock.
  // Renders soft advisory into #bp-recipe-stock-advisory (never disables Attach).
  // ---------------------------------------------------------------------------
  function refreshBpStockAdvisory() {
    var advisoryEl = document.getElementById('bp-recipe-stock-advisory');
    if (!advisoryEl) return;

    if (!_bpResolvedRecipe) {
      advisoryEl.style.display = 'none';
      return;
    }

    var listToScale = _bpModifiedIngredients || (_bpResolvedRecipe.ingredients || []);
    var factor = _bpScaleFactor || 1.0;
    var scaled = bpScaleIngredients(listToScale, factor);

    // Build catalog lookup from _bpAttachCatalog (populated on attach panel open)
    var catalogMap = {};
    (_bpAttachCatalog || []).forEach(function (item) {
      catalogMap[item.item_id] = item;
    });

    var conflicts = [];
    scaled.forEach(function (ing) {
      var entry = catalogMap[ing.item_id];
      if (!entry) return;
      var stock  = Number(entry.stock_on_hand) || 0;
      var needed = Number(ing.quantity) || 0;
      if (needed > stock) {
        conflicts.push({ item_name: ing.item_name, needed: needed, stock: stock, unit: ing.unit });
      }
    });

    if (conflicts.length === 0) {
      advisoryEl.style.display = 'none';
      advisoryEl.innerHTML = '';
    } else {
      var html = 'Some ingredients may need restocking before brewing: ';
      var items = conflicts.map(function (c) {
        return escapeHTML(c.item_name) + ' (' + escapeHTML(String(c.needed)) + ' ' + escapeHTML(c.unit || '') + ' needed, ' + escapeHTML(String(c.stock)) + ' available)';
      });
      advisoryEl.innerHTML = html + items.join(', ');
      advisoryEl.style.display = '';
      // D-11: NEVER disable the Attach button based on stock
    }
  }

  // ---------------------------------------------------------------------------
  // renderBpModifyRows — renders editable ingredient rows in #bp-modify-tbody.
  // Reuses existing bp autocomplete pattern and groupRecipeIngredients grouping.
  // ---------------------------------------------------------------------------
  function renderBpModifyRows() {
    var tbody = document.getElementById('bp-modify-tbody');
    if (!tbody) return;

    var ingredients = _bpModifiedIngredients || [];

    if (!ingredients.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="bp-modify-empty">No ingredients — use ‘+ Add Ingredient’ to build a custom list</td></tr>';
      return;
    }

    var groups = (typeof groupRecipeIngredients === 'function')
      ? groupRecipeIngredients(ingredients)
      : [{ label: '', count: ingredients.length, items: ingredients }];

    var html = '';
    groups.forEach(function (group) {
      if (group.label) {
        html += '<tr class="bp-recipe-ing-group"><td colspan="4"><strong>' + escapeHTML(group.label) + ' (' + group.count + ')</strong></td></tr>';
      }
      group.items.forEach(function (ing) {
        var idx = ingredients.indexOf(ing); // CRITICAL: original array index (PATTERNS #7)
        html += '<tr class="bp-recipe-ing-row" data-ing-idx="' + idx + '">';
        html += '<td><div class="bp-ing-autocomplete-wrap"><input type="text" class="bp-input bp-ing-search" value="' + escapeHTML(ing.item_name || '') + '" autocomplete="off" /></div></td>';
        html += '<td><input type="number" class="bp-input bp-ing-qty" value="' + escapeHTML(String(ing.quantity || 0)) + '" step="any" min="0" inputmode="decimal" style="width:70px;" /></td>';
        html += '<td class="bp-ing-unit">' + escapeHTML(ing.unit || '') + '</td>';
        html += '<td><button type="button" class="btn-secondary bp-btn-sm bp-ing-remove" aria-label="Remove ' + escapeHTML(ing.item_name || '') + '">&#10005;</button></td>';
        html += '</tr>';
      });
    });

    tbody.innerHTML = html;
    attachBpModifyRowListeners();
  }

  // ---------------------------------------------------------------------------
  // attachBpModifyRowListeners — wires remove / qty / autocomplete on #bp-modify-tbody.
  // ---------------------------------------------------------------------------
  function attachBpModifyRowListeners() {
    var tbody = document.getElementById('bp-modify-tbody');
    if (!tbody) return;

    // Remove buttons
    tbody.querySelectorAll('.bp-ing-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.bp-recipe-ing-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        if (isNaN(idx) || idx < 0 || !_bpModifiedIngredients) return;
        _bpModifiedIngredients.splice(idx, 1);
        renderBpModifyRows();
        refreshBpStockAdvisory();
      });
    });

    // Quantity change
    tbody.querySelectorAll('.bp-ing-qty').forEach(function (input) {
      input.addEventListener('change', function () {
        var row = input.closest('.bp-recipe-ing-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        if (!isNaN(idx) && _bpModifiedIngredients && _bpModifiedIngredients[idx]) {
          _bpModifiedIngredients[idx].quantity = parseFloat(input.value) || 0;
        }
        refreshBpStockAdvisory();
      });
    });

    // Autocomplete on search inputs
    tbody.querySelectorAll('.bp-ing-search').forEach(function (input) {
      input.addEventListener('input', function () {
        showIngredientAutocompleteBp(input);
      });
      input.addEventListener('focus', function () {
        if (!input.value) showIngredientAutocompleteBp(input);
      });
      input.addEventListener('blur', function () {
        setTimeout(function () { hideIngredientAutocompleteBp(input); }, 200);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // bpAttachRecipe — writes the scaled+modified snapshot via update_batch.
  // NO quote/charge/sale call — D-10.
  // ---------------------------------------------------------------------------
  function bpAttachRecipe(batchId) {
    if (!_bpResolvedRecipe) return Promise.reject(new Error('No recipe resolved'));
    var rid = _bpResolvedRecipe.recipe && _bpResolvedRecipe.recipe.recipe_id;
    var snapshot = buildBpAttachSnapshot();
    return adminApiPost('update_batch', {
      batch_id: batchId,
      updates: { recipe_id: rid, recipe_snapshot: JSON.stringify(snapshot) }
    });
  }

  // ---------------------------------------------------------------------------
  // bpSaveAsNewRecipe — POSTs a draft dynamic recipe with the pre-scale base list.
  // D-12: modified BASE list (pre-scale). D-13: pricing_mode='dynamic'. D-14: status='draft'.
  // Original recipe is never PUTted.
  // ---------------------------------------------------------------------------
  function bpSaveAsNewRecipe(name, modifiedBaseIngredients) {
    if (!_bpResolvedRecipe) return Promise.reject(new Error('No recipe resolved'));
    var snap = _bpResolvedRecipe.recipe || {};
    var payload = {
      name: name,
      style: snap.style || '',
      beer_category: snap.beer_category || '',
      batch_size_l: snap.batch_size_l || null,
      pricing_mode: 'dynamic',
      status: 'draft',
      ingredients: modifiedBaseIngredients
    };
    return fetch(mwUrl() + '/api/recipes', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || 'Create failed');
        showToast('Recipe saved as draft — activate in Recipes tab to use', 'success');
        return data;
      })
      .catch(function (err) {
        showToast('Could not save recipe — try again', 'error');
        throw err;
      });
  }

  // Send a bottling-appointment invite via the middleware (Resend). Resolves on
  // {success:true}, rejects with an Error otherwise — mirrors the old
  // adminApiPost('send_bottling_invite') contract so callers stay simple.
  function postBottlingInvite(data) {
    return fetch(mwUrl() + '/api/batch/bottling-invite', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (r.ok && d && d.success) return d;
        throw new Error((d && d.error) || ('HTTP ' + r.status));
      });
    });
  }

  // Send a bottling invite for a batch, resolving the customer email from the batch
  // record first. The dashboard's ready-to-bottle payload carries only has_email —
  // never the address (D-09) — so callers there cannot supply one.
  function sendBottlingInviteForBatch(opts) {
    var o = opts || {};
    var batchId = (o.batchId || '').trim();
    if (!batchId) return Promise.reject(new Error('Missing batchId'));

    return adminApiGet('get_batch', { batch_id: batchId }).then(function (r) {
      var batch = (r && r.data && r.data.batch) || {};
      var email = String(batch.customer_email || '').trim();
      if (!email) {
        throw new Error('This batch has no customer email on file');
      }
      return postBottlingInvite({
        name: o.name || batch.customer_name || '',
        email: email,
        batchId: batchId,
        productName: o.productName || batch.product_name || ''
      });
    });
  }

  function showSyncIndicator(state) {
    var el = document.getElementById('bp-sync-indicator');
    if (!el) return;
    if (state === 'ok') {
      el.style.display = 'none';
      el.className = 'bp-sync-indicator';
      el.textContent = '';
      return;
    }
    el.style.display = '';
    if (state === 'syncing') {
      el.className = 'bp-sync-indicator bp-sync-indicator--syncing';
      el.textContent = 'syncing…';
    } else {
      el.className = 'bp-sync-indicator bp-sync-indicator--failed';
      el.textContent = 'sync failed — will retry';
    }
  }

  function callSyncZoho(batchId, soId, status) {
    if (!soId) return;
    showSyncIndicator('syncing');
    fetch(mwUrl() + '/api/batch/sync-zoho', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch_id: batchId, so_id: soId, status: status })
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        showSyncIndicator(data.ok ? 'ok' : 'failed');
      })
      .catch(function () {
        showSyncIndicator('failed');
      });
  }

  // Phase 64/OPS-03: after a successful delete_batch, re-derive the deleted batch's
  // invoice cf_batch_status from the batches that STILL exist (cleared when none do —
  // the INV-000151 class of bug). Fire-and-forget: never blocks or fails the delete UX
  // — a reconcile failure is silent (the one-time cleanup route is the backstop).
  function reconcileInvoiceStatusAfterDelete(zohoSoNumber) {
    reconcileInvoiceStatus(zohoSoNumber);
  }

  // Shared fire-and-forget reconcile (delete path above, create-with-invoice path in
  // the create sheet, Phase 90-03). A failure is silent; the cleanup route is the backstop.
  function reconcileInvoiceStatus(zohoSoNumber) {
    if (!zohoSoNumber) return;
    fetch(mwUrl() + '/api/batch/reconcile-invoice-status', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoho_so_number: zohoSoNumber })
    }).catch(function () {});
  }

  // opts (all optional; the detail-view caller passes none):
  //   resultsId   - results container id (default 'bp-so-search-results')
  //   onSelect    - fn({invoice_id, invoice_number, customer_name, customer_id, date});
  //                 default is the detail-view handleSoSelect write path
  //   renderExtra - fn(inv) -> escaped HTML appended inside each row
  function fetchSoSearch(term, opts) {
    opts = opts || {};
    var resultsEl = document.getElementById(opts.resultsId || 'bp-so-search-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">Searching…</div>';

    fetch(mwUrl() + '/api/batch/search-invoices?search=' + encodeURIComponent(term), {
      credentials: 'include'
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        var orders = data.invoices || [];
        if (orders.length === 0) {
          resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">No matching invoices found</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < orders.length; i++) {
          var inv = orders[i];
          html += '<div class="bp-so-result-item" data-so-id="' + escapeHTML(inv.invoice_id) + '"'
               + ' data-so-number="' + escapeHTML(inv.invoice_number) + '"'
               + ' data-customer-name="' + escapeHTML(inv.customer_name) + '"'
               + ' data-customer-id="' + escapeHTML(inv.customer_id || '') + '"'
               + ' data-so-date="' + escapeHTML(inv.date || '') + '"'
               + ' data-product-name="' + escapeHTML((inv.line_items && inv.line_items[0] ? inv.line_items[0].name : '') || '') + '">';
          html += '<span class="bp-so-result-name">' + escapeHTML(inv.customer_name) + '</span>';
          html += '<span class="bp-so-result-meta">' + escapeHTML(inv.invoice_number) + ' — ' + fmtDate(inv.date) + '</span>';
          if (opts.renderExtra) html += opts.renderExtra(inv) || '';
          html += '</div>';
        }
        resultsEl.innerHTML = html;

        var items = resultsEl.querySelectorAll('.bp-so-result-item[data-so-id]');
        for (var j = 0; j < items.length; j++) {
          items[j].addEventListener('click', function () {
            if (opts.onSelect) {
              opts.onSelect({
                invoice_id: this.getAttribute('data-so-id'),
                invoice_number: this.getAttribute('data-so-number'),
                customer_name: this.getAttribute('data-customer-name'),
                customer_id: this.getAttribute('data-customer-id'),
                date: this.getAttribute('data-so-date')
              });
              return;
            }
            handleSoSelect(this);
          });
        }
      })
      .catch(function () {
        resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">Search unavailable — check connection</div>';
      });
  }

  // Fetch customer contacts for the reassign type-ahead (Phase 29.1).
  function fetchReassignSearch(term) {
    var resultsEl = document.getElementById('bp-reassign-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">Searching…</div>';

    fetch(mwUrl() + '/api/contacts/search?q=' + encodeURIComponent(term), {
      credentials: 'include'
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        var contacts = data.contacts || [];
        if (contacts.length === 0) {
          resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">No matching customers found</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < contacts.length; i++) {
          var c = contacts[i];
          html += '<div class="bp-so-result-item bp-reassign-result-item"'
               + ' data-contact-id="' + escapeHTML(c.contact_id || '') + '"'
               + ' data-name="' + escapeHTML(c.contact_name || '') + '"'
               + ' data-email="' + escapeHTML(c.email || '') + '"'
               + ' data-phone="' + escapeHTML(c.phone || '') + '">';
          html += '<span class="bp-so-result-name">' + escapeHTML(c.contact_name || '') + '</span>';
          if (c.email || c.phone) {
            html += '<span class="bp-so-result-meta">' + escapeHTML(c.email || '') + (c.email && c.phone ? ' · ' : '') + escapeHTML(c.phone || '') + '</span>';
          }
          html += '</div>';
        }
        resultsEl.innerHTML = html;

        var items = resultsEl.querySelectorAll('.bp-reassign-result-item[data-contact-id]');
        for (var j = 0; j < items.length; j++) {
          items[j].addEventListener('click', function () {
            _pendingReassign = {
              contact_id: this.getAttribute('data-contact-id'),
              contact_name: this.getAttribute('data-name'),
              email: this.getAttribute('data-email'),
              phone: this.getAttribute('data-phone')
            };
            submitReassign();
          });
        }
      })
      .catch(function () {
        resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">Search unavailable — check connection</div>';
      });
  }

  // Submit the pending reassignment to the middleware (Phase 29.1).
  // Uses _pendingReassign (set by result click or add-new save) and _currentBatchDetail
  // for the batch id, expected version, and linked SO number.
  function submitReassign() {
    if (!_pendingReassign) return;

    var batchDetail = _currentBatchDetail;
    if (!batchDetail) return;

    var batchId = batchDetail.batch_id || _detailBatchId;
    var soNumber = batchDetail.zoho_so_number || '';
    // WR-06: last_updated is the sole optimistic-lock version. Never fall back to ''
    // (an empty version silently weakens or skips the conflict check on the server).
    // If the batch carries no concrete version, refuse to submit and tell the user to reload.
    var expectedVersion = batchDetail.last_updated || '';
    if (!expectedVersion) {
      showToast('Cannot reassign — batch version unknown, reload first', 'error');
      return;
    }
    var picked = _pendingReassign;

    // Build display name for confirm message
    var displayName = picked.contact_name || picked.name || '';

    function doPost() {
      var reassignBtn = document.getElementById('bp-reassign-btn');
      if (reassignBtn) { reassignBtn.disabled = true; reassignBtn.textContent = 'Saving…'; }

      // Build customer payload: use contact_id for existing, name/email/phone for add-new
      var customer;
      if (picked.contact_id) {
        customer = { contact_id: picked.contact_id };
      } else {
        customer = { name: picked.name || '', email: picked.email || '', phone: picked.phone || '' };
      }

      var body = {
        batch_id: batchId,
        expectedVersion: expectedVersion,
        customer: customer
      };
      if (soNumber) body.zoho_so_number = soNumber;

      fetch(mwUrl() + '/api/batch/reassign-customer', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (resp) {
          var data = resp.data;

          if (resp.status === 409 || isVersionConflict(data.error || data.message || '')) {
            showToast('Batch was updated elsewhere — please reload', 'error');
            var reassignBtnReset = document.getElementById('bp-reassign-btn');
            if (reassignBtnReset) { reassignBtnReset.disabled = false; reassignBtnReset.textContent = 'Change Customer'; }
            return;
          }

          if (!data.ok) {
            showToast('Reassign failed — try again', 'error');
            var reassignBtnReset2 = document.getElementById('bp-reassign-btn');
            if (reassignBtnReset2) { reassignBtnReset2.disabled = false; reassignBtnReset2.textContent = 'Change Customer'; }
            return;
          }

          // Build updates object via pure helper
          var updates = buildCustomerReassignUpdates(picked);

          // Update version for subsequent saves
          if (data.new_version && _currentBatchDetail) {
            _currentBatchDetail.last_updated = data.new_version;
          }

          // In-place patch of _currentBatchDetail and local batch reference
          var updateKeys = Object.keys(updates);
          for (var ki = 0; ki < updateKeys.length; ki++) {
            var k = updateKeys[ki];
            if (_currentBatchDetail) _currentBatchDetail[k] = updates[k];
          }

          // Patch DOM nodes in place using textContent (avoids double-encoding)
          var nameNode = document.getElementById('bp-detail-customer');
          if (nameNode) nameNode.textContent = getCustomerDisplayName(_currentBatchDetail || {}) || '—';
          var emailNode = document.getElementById('bp-detail-email');
          if (emailNode) emailNode.textContent = (_currentBatchDetail ? (_currentBatchDetail.customer_email || '') : '') || '—';
          var phoneNode = document.getElementById('bp-detail-phone');
          if (phoneNode) phoneNode.textContent = (_currentBatchDetail ? (_currentBatchDetail.customer_phone || '') : '') || '—';

          // Patch in-memory list caches
          var patchLists = [_batchesData, _allBatchesData];
          for (var li = 0; li < patchLists.length; li++) {
            if (!patchLists[li]) continue;
            for (var pi = 0; pi < patchLists[li].length; pi++) {
              if (String(patchLists[li][pi].batch_id) === String(batchId)) {
                for (var pk = 0; pk < updateKeys.length; pk++) {
                  patchLists[li][pi][updateKeys[pk]] = updates[updateKeys[pk]];
                }
                break;
              }
            }
          }

          // Bust sessionStorage snapshot
          try { sessionStorage.removeItem('sv-bp-batch-' + batchId); } catch (e) {}

          // Toast: warn if Zoho not updated, success otherwise
          if (data.zoho_warning) {
            showToast('Customer saved — Zoho not updated: ' + data.zoho_warning, 'warn');
          } else {
            showToast('Customer reassigned', 'success');
          }

          // Reset button and close panel
          var reassignBtnDone = document.getElementById('bp-reassign-btn');
          if (reassignBtnDone) { reassignBtnDone.disabled = false; reassignBtnDone.textContent = 'Change Customer'; }
          var panel = document.getElementById('bp-reassign-panel');
          if (panel) panel.style.display = 'none';
          var addNewForm = document.getElementById('bp-reassign-addnew');
          if (addNewForm) addNewForm.style.display = 'none';
          _pendingReassign = null;
        })
        .catch(function (err) {
          var msg = err && err.message ? err.message : '';
          if (isVersionConflict(msg)) {
            showToast('Batch was updated elsewhere — please reload', 'error');
          } else {
            showToast('Reassign failed — check connection', 'error');
          }
          var reassignBtnErr = document.getElementById('bp-reassign-btn');
          if (reassignBtnErr) { reassignBtnErr.disabled = false; reassignBtnErr.textContent = 'Change Customer'; }
        });
    }

    // D-02/D-03: confirm only when linked SO exists
    if (soNumber) {
      showConfirmSheet(
        'Reassign batch ' + batchId + ' to ' + displayName + '? This will also update the linked Zoho order.',
        'Confirm', '', doPost
      );
    } else {
      doPost();
    }
  }

  function handleSoSelect(el) {
    var soId = el.getAttribute('data-so-id');
    var soNumber = el.getAttribute('data-so-number');
    var customerName = el.getAttribute('data-customer-name');
    var customerId = el.getAttribute('data-customer-id');
    var productName = el.getAttribute('data-product-name');
    var soDate = el.getAttribute('data-so-date');

    if (!_detailBatchId || !soId) return;

    var updates = {
      zoho_so_number: soNumber,
      customer_id: customerId,
      customer_name: customerName,
      product_name: productName
    };

    adminApiPost('update_batch', { batch_id: _detailBatchId, updates: updates })
      .then(function () {
        if (_currentBatchDetail) {
          _currentBatchDetail.zoho_so_number = soNumber;
          _currentBatchDetail.customer_name = customerName;
          _currentBatchDetail.customer_id = customerId;
          _currentBatchDetail.product_name = productName;
        }

        showLinkedSo(soNumber);

        var syncStatus = 'pending';
        if (_currentBatchDetail) {
          var curStatus = String(_currentBatchDetail.status || '').toLowerCase();
          if (curStatus === 'complete') syncStatus = 'complete';
          else if (curStatus !== 'pending') syncStatus = 'active';
        }
        callSyncZoho(_detailBatchId, soId, syncStatus);

        var timelineEl = document.getElementById('bp-lifecycle-timeline');
        if (timelineEl && _currentBatchDetail) {
          timelineEl.innerHTML = buildLifecycleTimeline(_currentBatchDetail, soDate);
        }

        showToast('Invoice linked', 'success');
        _batchesLoaded = false;
        _allBatchesData = [];
        _eagerLoadTime = 0;
        try { sessionStorage.removeItem('sv-bp-batch-' + _detailBatchId); } catch (e) {}
      })
      .catch(function () {
        showToast('Failed to link invoice. Try again.', 'error');
      });
  }

  function showLinkedSo(soNumber) {
    var searchWrap = document.getElementById('bp-link-so-search');
    var linkedDisplay = document.getElementById('bp-so-linked-display');
    var linkBtn = document.getElementById('bp-link-so-btn');
    if (searchWrap) searchWrap.style.display = 'none';
    if (linkBtn) linkBtn.style.display = 'none';
    if (linkedDisplay) {
      linkedDisplay.style.display = '';
      linkedDisplay.innerHTML = '<span class="bp-so-linked-text">' + escapeHTML(soNumber) + '</span>'
        + '<button type="button" class="bp-so-change-btn" id="bp-so-change-link">Change Linked Order</button>';
      var changeBtn = document.getElementById('bp-so-change-link');
      if (changeBtn) {
        changeBtn.addEventListener('click', function () {
          linkedDisplay.style.display = 'none';
          if (searchWrap) searchWrap.style.display = '';
          var dismissLink = document.getElementById('bp-so-dismiss');
          if (dismissLink) dismissLink.textContent = 'Keep current link';
        });
      }
    }
  }

  // ===== Phase 90-06: guided invoice review =====
  //
  // Unlinked batch detail shows up to 3 candidate invoices from the middleware
  // (the link-candidates route). NOTHING is written on render or on "Not this";
  // writes happen only in the explicit tap handlers (Link invoice / Mark internal).

  var LINK_REVIEW_MAX_CARDS = 3;
  var LINK_REVIEW_MAX_LINES = 4;
  // Holds the last response for the open detail so "Not this" can re-render without refetching.
  var _linkReview = { batchId: null, data: null, batch: null };

  function linkDismissKey(batchId) { return 'bp-link-dismissed:' + batchId; }

  function readLinkDismissed(batchId) {
    try {
      var arr = JSON.parse(localStorage.getItem(linkDismissKey(batchId)) || '[]');
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function addLinkDismissed(batchId, invoiceNumber) {
    var arr = readLinkDismissed(batchId);
    if (arr.indexOf(invoiceNumber) === -1) arr.push(invoiceNumber);
    try { localStorage.setItem(linkDismissKey(batchId), JSON.stringify(arr)); } catch (e) {}
  }

  function fmtCardDate(dateStr) {
    var s = String(dateStr || '').slice(0, 10);
    var p = s.split('-');
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var mi = parseInt(p[1], 10) - 1;
    if (p.length !== 3 || !(mi >= 0 && mi <= 11)) return s;
    return parseInt(p[2], 10) + ' ' + months[mi] + ' ' + p[0];
  }

  function linkPill(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'paid') return { cls: 'bp-pill--ok', label: 'Paid' };
    if (s === 'partially_paid') return { cls: 'bp-pill--warn', label: 'Part paid' };
    if (s === 'overdue') return { cls: 'bp-pill--warn', label: 'Overdue' };
    return { cls: 'bp-pill--muted', label: 'Unpaid' };
  }

  function isNoCustomerBatch(b) {
    var name = String(b.customer_name || getCustomerDisplayName(b) || '').trim();
    if (/^walk[\s\-]*in$/i.test(name)) return true;
    return name === '' && !String(b.customer_id || '').trim();
  }

  function linkReviewHeaderHtml() {
    return '<div class="bp-detail-section-title">Possible invoices</div>' +
      '<p class="bp-link-card-meta">Same customer, within 60 days of the start date. Nothing is saved until you tap Link invoice.</p>';
  }

  function linkReviewEmptyHtml(b, body) {
    var html = '<div class="bp-link-empty"><strong>No matching invoices found</strong><br>' + escapeHTML(body) + '</div>';
    html += '<div class="bp-link-card-actions">';
    html += '<button type="button" class="btn-secondary bp-link-btn" data-action="search-all">Search all invoices</button>';
    if (isBatchSourceEditable(b.source)) {
      html += '<button type="button" class="btn-secondary bp-link-btn" data-action="internal">Mark internal</button>';
    }
    html += '</div>';
    return html;
  }

  function linkCandidateCardHtml(b, c) {
    var pill = linkPill(c.status);
    var html = '<div class="bp-link-card" data-so-number="' + escapeHTML(c.invoice_number) + '" data-batch-id="' + escapeHTML(b.batch_id) + '">';
    html += '<div class="bp-link-card-head"><span class="bp-link-card-title">' + escapeHTML(c.invoice_number) + '</span>' +
      '<span class="bp-pill ' + pill.cls + '">' + pill.label + '</span></div>';
    var meta = [fmtCardDate(c.date)];
    if (c.total !== undefined && c.total !== null && c.total !== '' && !isNaN(Number(c.total))) {
      meta.push('$' + Number(c.total).toFixed(2));
    }
    if (c.date_distance_days !== undefined && c.date_distance_days !== null && !isNaN(Number(c.date_distance_days))) {
      var d = Math.abs(Number(c.date_distance_days));
      meta.push(d + (d === 1 ? ' day' : ' days') + ' from start');
    }
    html += '<div class="bp-link-card-meta">' + meta.map(escapeHTML).join(' · ') + '</div>';
    var lines = c.line_items || [];
    if (lines.length) {
      html += '<ul class="bp-link-card-lines">';
      lines.slice(0, LINK_REVIEW_MAX_LINES).forEach(function (li) {
        var qty = (li.quantity !== undefined && li.quantity !== null && li.quantity !== '') ? String(li.quantity) + ' x ' : '';
        html += '<li>' + escapeHTML(qty + (li.name || '')) + '</li>';
      });
      html += '</ul>';
      if (lines.length > LINK_REVIEW_MAX_LINES) {
        html += '<div class="bp-link-card-meta">+' + (lines.length - LINK_REVIEW_MAX_LINES) + ' more</div>';
      }
    }
    if (c.has_kit_line === false) {
      html += '<div class="bp-link-card-meta bp-link-card-nokit">No kit or fee line</div>';
    }
    if (c.linked_batches && c.linked_batches.length) {
      html += '<div class="bp-link-card-warn">Already linked to ' + c.linked_batches.map(escapeHTML).join(', ') + '</div>';
    } else if (c.linked_batches === null || c.linked_batches === undefined) {
      html += '<div class="bp-link-card-meta">Link status unknown</div>';
    }
    html += '<div class="bp-link-card-actions">';
    html += '<button type="button" class="btn bp-link-btn bp-link-btn--primary" data-action="link" data-so-number="' + escapeHTML(c.invoice_number) + '" data-batch-id="' + escapeHTML(b.batch_id) + '">Link invoice</button>';
    html += '<button type="button" class="btn-secondary bp-link-btn" data-action="dismiss" data-so-number="' + escapeHTML(c.invoice_number) + '">Not this</button>';
    if (isBatchSourceEditable(b.source)) {
      html += '<button type="button" class="btn-secondary bp-link-btn" data-action="internal" data-so-number="' + escapeHTML(c.invoice_number) + '" data-batch-id="' + escapeHTML(b.batch_id) + '">Mark internal</button>';
    }
    html += '</div></div>';
    return html;
  }

  function renderLinkReview(b) {
    var el = document.getElementById('bp-link-review');
    var data = _linkReview.data;
    if (!el || !data) return;
    el.removeAttribute('aria-busy');
    var html = linkReviewHeaderHtml();
    if (data.reason === 'no_customer') {
      el.innerHTML = html + linkReviewEmptyHtml(b, 'This batch has no customer, so no invoices can be suggested.');
      return;
    }
    var dismissed = readLinkDismissed(b.batch_id);
    var shown = (data.candidates || []).filter(function (c) {
      return c && dismissed.indexOf(c.invoice_number) === -1;
    }).slice(0, LINK_REVIEW_MAX_CARDS);
    if (!shown.length) {
      html += linkReviewEmptyHtml(b, 'Try Search all invoices, or mark this batch Internal if it was made for the shop.');
    } else {
      shown.forEach(function (c) { html += linkCandidateCardHtml(b, c); });
    }
    var unchecked = Number(data.uninspected_count) || 0;
    if (data.inspected_all === false && unchecked > 0) {
      html += '<p class="bp-link-card-meta bp-link-review-hint">' + unchecked + (unchecked === 1 ? ' more invoice' : ' more invoices') +
        ' from this customer in the window ' + (unchecked === 1 ? 'was' : 'were') + ' not checked. Use Search all invoices.</p>';
      if (shown.length) {
        html += '<div class="bp-link-card-actions"><button type="button" class="btn-secondary bp-link-btn" data-action="search-all">Search all invoices</button></div>';
      }
    }
    el.innerHTML = html;
  }

  function renderLinkReviewError(b) {
    var el = document.getElementById('bp-link-review');
    if (!el) return;
    el.removeAttribute('aria-busy');
    el.innerHTML = linkReviewHeaderHtml() +
      '<div class="bp-link-card-warn bp-link-error" role="alert">Invoice lookup failed. Zoho may be busy, try again in a minute or search manually.</div>' +
      '<div class="bp-link-card-actions">' +
      '<button type="button" class="btn-secondary bp-link-btn" data-action="retry">Try again</button>' +
      '<button type="button" class="btn-secondary bp-link-btn" data-action="search-all">Search all invoices</button>' +
      '</div>';
  }

  function loadLinkCandidates(b) {
    var el = document.getElementById('bp-link-review');
    if (!el) return Promise.resolve();
    _linkReview = { batchId: b.batch_id, data: null, batch: b };
    if (isNoCustomerBatch(b)) {
      _linkReview.data = { candidates: [], reason: 'no_customer' };
      renderLinkReview(b);
      return Promise.resolve();
    }
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = linkReviewHeaderHtml() +
      '<div class="bp-link-skeleton"></div><div class="bp-link-skeleton"></div><div class="bp-link-skeleton"></div>' +
      '<p class="bp-link-card-meta">Looking for invoices...</p>';
    var qs = [];
    if (b.customer_id) qs.push('customer_id=' + encodeURIComponent(b.customer_id));
    qs.push('customer_name=' + encodeURIComponent(b.customer_name || getCustomerDisplayName(b) || ''));
    qs.push('start_date=' + encodeURIComponent(String(b.start_date || b.created_at || '').slice(0, 10)));
    var forBatch = b.batch_id;
    // Ignore a late response when the detail pane has since moved to another batch.
    function stillCurrent() {
      return _linkReview.batchId === forBatch && document.getElementById('bp-link-review') === el;
    }
    return Promise.resolve(fetch(mwUrl() + '/api/batch/link-candidates?' + qs.join('&'), { credentials: 'include' }))
      .then(function (r) {
        if (!r || !r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!stillCurrent()) return;
        _linkReview.data = data || { candidates: [] };
        renderLinkReview(b);
      })
      .catch(function () {
        if (!stillCurrent()) return;
        renderLinkReviewError(b);
      });
  }

  // The ONLY write behind "Link invoice": the invoice number alone, guarded by the
  // optimistic-lock version, then a status reconcile for the invoice. Never reuse
  // the manual search handler here: it also overwrites the batch identity fields.
  function linkBatchToInvoice(batchId, soNumber, expectedVersion) {
    return adminApiPost('update_batch', {
      batch_id: batchId,
      updates: { zoho_so_number: soNumber },
      expectedVersion: expectedVersion
    }).then(function (res) {
      afterBatchWrite(batchId, { refreshOpenDetail: true, listAffecting: true });
      reconcileInvoiceStatus(soNumber);
      return res;
    });
  }

  // Mark internal ('internal') / Mark as not internal ('manual'). The UI only offers
  // this for editable sources; the server store guards are authoritative.
  function markBatchSource(batchId, nextSource) {
    return adminApiPost('update_batch', {
      batch_id: batchId,
      updates: { source: nextSource }
    }).then(function (res) {
      afterBatchWrite(batchId, { refreshOpenDetail: true, listAffecting: true });
      return res;
    });
  }

  // Phase 94 (D-06): staff-chosen type, recorded as manual by the server.
  function setBatchType(batchId, nextType) {
    return adminApiPost('update_batch', { batch_id: batchId, updates: { batch_type: nextType } }).then(function (res) {
      var rows = _dashData && _dashData.batches ? _dashData.batches : [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].batch_id === batchId) {
          rows[i].batch_type = nextType;
          rows[i].batch_type_source = 'manual';
        }
      }
      afterBatchWrite(batchId, { refreshOpenDetail: true, listAffecting: true });
      return res;
    });
  }

  // Phase 95 (D-08/D-10): staff flag write. Boolean only (T-95-27); nested updates + batch_id
  // so the server whitelist applies and the gb:<batchId> cache busts.
  function setStaffBatch(batchId, value) {
    var flag = value === true;
    return adminApiPost('update_batch', { batch_id: batchId, updates: { staff_batch: flag } }).then(function (res) {
      if (_dashData) {
        var ids = _dashData.staffBatchIds;
        if (!Array.isArray(ids)) { ids = []; _dashData.staffBatchIds = ids; }
        var at = ids.indexOf(batchId);
        if (flag && at === -1) ids.push(batchId);
        if (!flag && at !== -1) ids.splice(at, 1);
      }
      // Review WR-03: in the summary fallback v2 reads the list rows, so patch the row too.
      for (var i = 0; i < _allBatchesData.length; i++) {
        if (_allBatchesData[i] && _allBatchesData[i].batch_id === batchId) _allBatchesData[i].staff_batch = flag;
      }
      if (isDashV2()) refreshDashV2();
      afterBatchWrite(batchId, { refreshOpenDetail: true, listAffecting: true });
      return res;
    });
  }

  var STAFF_SOURCE_HINTS = {
    internal: 'Set automatically (internal batch)',
    research: 'Set automatically (research batch)'
  };

  var TYPE_SOURCE_HINTS = {
    recipe: 'Set automatically (recipe)',
    zoho: 'Set automatically (Zoho product)',
    schedule: 'Set automatically (schedule)',
    name: 'Set automatically (product name)',
    other: 'Not recognised, please choose',
    manual: 'Set by hand'
  };
  var TYPE_OPTIONS = [['wine', 'Wine'], ['beer', 'Beer'], ['cider', 'Cider'], ['seltzer', 'Seltzer'], ['other', 'Other']];

  function batchTypeInfo(b) {
    var row = null;
    var rows = _dashData && _dashData.batches ? _dashData.batches : [];
    // Review WR-02: prefer the type get_batch returned; the dashboard rows are a cached snapshot.
    if (!hasServerType(b)) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].batch_id === b.batch_id) { row = rows[i]; break; }
      }
    }
    var src = row ? row.batch_type_source : b.batch_type_source;
    var merged = { batch_type: row ? row.batch_type : b.batch_type, schedule_category: b.schedule_category, schedule_id: b.schedule_id, category: b.category, schedule_snapshot: b.schedule_snapshot, product_name: b.product_name, product_sku: b.product_sku, recipe_id: b.recipe_id };
    var type = effectiveBatchType(merged, buildScheduleCategoryById(_fermSchedules));
    var hint = TYPE_SOURCE_HINTS[String(src || '').toLowerCase()];
    if (!hint) hint = type === 'other' ? 'Not yet classified' : 'Set automatically (schedule)';
    return { type: type, hint: hint };
  }

  function setLinkCardBusy(scope, busy, activeBtn, busyLabel) {
    Array.prototype.forEach.call(scope.querySelectorAll('button'), function (x) {
      x.disabled = busy;
    });
    if (activeBtn) {
      if (busy) {
        activeBtn.setAttribute('data-label', activeBtn.textContent);
        activeBtn.textContent = busyLabel;
      } else if (activeBtn.getAttribute('data-label')) {
        activeBtn.textContent = activeBtn.getAttribute('data-label');
      }
    }
  }

  function showLinkRowError(scope, message) {
    var old = scope.querySelector('.bp-link-row-error');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var row = document.createElement('div');
    row.className = 'bp-link-card-warn bp-link-error bp-link-row-error';
    row.setAttribute('role', 'alert');
    row.textContent = message;
    scope.insertBefore(row, scope.firstChild);
  }

  function handleLinkInvoiceTap(b, btn) {
    var soNumber = btn.getAttribute('data-so-number');
    var scope = btn.closest('.bp-link-card') || btn.parentNode;
    setLinkCardBusy(scope, true, btn, 'Linking...');
    linkBatchToInvoice(b.batch_id, soNumber, b.last_updated).then(function (res) {
      b.zoho_so_number = soNumber;
      if (res && res.newVersion) b.last_updated = res.newVersion;
      var review = document.getElementById('bp-link-review');
      if (review) review.innerHTML = '';
      showLinkedSo(soNumber);
      showToast('Linked to ' + soNumber, 'success');
    }).catch(function () {
      setLinkCardBusy(scope, false, btn);
      showLinkRowError(scope, 'Could not link. Try again.');
    });
  }

  function handleMarkInternalTap(b, btn) {
    var scope = btn.closest('.bp-link-card') || btn.parentNode;
    setLinkCardBusy(scope, true, btn, 'Saving...');
    markBatchSource(b.batch_id, 'internal').then(function () {
      b.source = 'internal';
      var review = document.getElementById('bp-link-review');
      if (review) review.innerHTML = '<span class="bp-source-badge bp-source-badge--internal">Internal</span>';
      showToast('Marked internal', 'success');
    }).catch(function (err) {
      setLinkCardBusy(scope, false, btn);
      var msg = (err && err.code === 'invalid_source' && err.message) ? err.message : 'Could not mark internal. Try again.';
      showLinkRowError(scope, msg);
    });
  }

  function onLinkReviewClick(e) {
    var btn = e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    var b = _linkReview.batch;
    if (!b) return;
    var action = btn.getAttribute('data-action');
    if (action === 'link') {
      handleLinkInvoiceTap(b, btn);
    } else if (action === 'internal') {
      handleMarkInternalTap(b, btn);
    } else if (action === 'search-all') {
      var openBtn = document.getElementById('bp-link-so-btn');
      if (openBtn) openBtn.click();
    } else if (action === 'retry') {
      loadLinkCandidates(b);
    } else if (action === 'dismiss') {
      addLinkDismissed(b.batch_id, btn.getAttribute('data-so-number'));
      renderLinkReview(b);
    }
  }

  function initLinkReview(b, el) {
    el.addEventListener('click', onLinkReviewClick);
    loadLinkCandidates(b);
  }

  // ===== Cache-busting helpers =====

  // afterBatchWrite — call after any successful write that mutates a single batch.
  // opts.listAffecting (default true)  — reset the list/dashboard state flags.
  // opts.refreshOpenDetail (default false) — if the batch's detail pane is open,
  //   re-fetch from the server and re-render it so the user sees the new state now.
  //
  // Pattern from the reference template handleSoSelect (~L1809):
  //   (A) bust sv-bp-batch-{id}  (B) reset list/dash flags  (C) optional re-render
  function afterBatchWrite(batchId, opts) {
    opts = opts || {};

    // (A) Remove the per-batch sessionStorage detail snapshot so the next selectBatch
    //     call reads fresh data from the server rather than the stale 2-minute cache.
    try { sessionStorage.removeItem('sv-bp-batch-' + batchId); } catch (e) {}

    // Also cancel any in-flight preload for this batch — it was started before the
    // write and would re-seed a stale snapshot if allowed to complete.
    if (_preloadBatchId === batchId) {
      _preloadBatchId = null;
      _preloadPromise = null;
    }

    // (B) Reset list / dashboard state so the next tab entry fetches fresh data.
    //     Pass opts.listAffecting === false for writes that only affect readings/tasks
    //     (those don't change list cards or dashboard stats).
    if (opts.listAffecting !== false) {
      _batchesLoaded = false;
      _allBatchesData = [];
      _eagerLoadTime = 0;
      _dashLoadTime = 0;
    }

    // (C) If this batch's detail pane is currently open, re-fetch from the server
    //     and re-render immediately so the user sees the saved changes right now.
    if (opts.refreshOpenDetail && _selectedBatchId === batchId) {
      adminApiGet('get_batch', { batch_id: batchId })
        .then(function (r) {
          var data = r.data || {};
          try { sessionStorage.setItem('sv-bp-batch-' + batchId, JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
          syncListTaskCounts(batchId, data.tasks);
          if (_selectedBatchId === batchId) renderBatchDetail(data);
        })
        .catch(function () {});
    }
  }

  // ===== Utilities =====

  function getBatchMeta(batchId) {
    if (!batchId || !_allBatchesData.length) return '';
    for (var i = 0; i < _allBatchesData.length; i++) {
      var b = _allBatchesData[i];
      if (b.batch_id === batchId) {
        var parts = [];
        if (b.product_name || b.product_sku) parts.push(b.product_name || b.product_sku);
        var loc = '';
        if (b.vessel_id) loc += b.vessel_id;
        if (b.shelf_id) loc += (loc ? ' ' : '') + b.shelf_id;
        if (b.bin_id) loc += '-' + b.bin_id;
        if (loc) parts.push(loc);
        return parts.join(' \u00b7 ');
      }
    }
    return '';
  }

  // ===== Tab Switching =====

  function switchTab(tab) {
    _activeTab = tab;

    // Cancel any pending search re-render from the previous tab
    if (_batchSearchTimer) { clearTimeout(_batchSearchTimer); _batchSearchTimer = null; }

    Array.prototype.forEach.call(document.querySelectorAll('.bp-tab'), function (btn) {
      var isActive = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    var panels = ['dashboard', 'batches', 'tasks', 'measurements', 'recipes', 'waitlist'];
    panels.forEach(function (p) {
      var el = document.getElementById('bp-panel-' + p);
      if (el) el.style.display = (p === tab) ? '' : 'none';
    });

    var now = Date.now();
    if (tab === 'dashboard') {
      if (isDashV2()) resizeDashV2Charts();
      if (now - _dashLoadTime > CACHE_TTL_LONG) loadDashboard();
    } else if (tab === 'batches') {
      if (_selectedBatchId) closeBatchDetail();   // close any open detail pane
      if (_allBatchesData.length > 0) {
        // Derive filtered list from cache — instant
        applyBatchFilter();
        _batchesLoaded = true;
        renderBatchList();
      } else {
        loadBatches();
      }
    } else if (tab === 'tasks') {
      loadTasks();
    } else if (tab === 'measurements') {
      loadMeasurementBatches();
    } else if (tab === 'recipes') {
      initRecipesTab();
    } else if (tab === 'waitlist') {
      loadWaitlist();
    }
  }

  // ===== Recipes =====

  var _recipesState = {
    catalog: [],
    catalogLoaded: false,
    list: [],
    total: 0,
    currentRecipeId: null,
    currentRecipe: null,
    currentIngredients: [],
    availability: null,
    previousStatus: 'draft'
  };
  var _recipesDataLoaded = false;
  var _recipesDataLoading = false;

  function getRecipesMwHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  function initRecipesTab() {
    if (_recipesDataLoaded || _recipesDataLoading) return;
    _recipesDataLoading = true;
    _recipesDataLoaded = true;
    loadIngredientCatalogForRecipes();
    loadRecipeList('all');
  }

  function loadIngredientCatalogForRecipes() {
    var url = mwUrl();
    if (!url) return Promise.resolve();
    var headers = getRecipesMwHeaders();
    return fetch(url + '/api/ingredients?include_internal=1', { credentials: 'include', headers: headers })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        _recipesState.catalog = data.items || data.ingredients || data || [];
        _recipesState.catalogLoaded = true;
        // Re-render hook: if a recipe detail was opened before the catalog finished
        // loading, its ingredient rows rendered without cost/retail. Re-apply rates now
        // and re-render so async load order can't leave the columns blank or stale.
        if (_recipesState.currentRecipeId && _recipesState.currentIngredients &&
            _recipesState.currentIngredients.length) {
          applyCatalogRatesToCurrentIngredients();
          renderIngredientRows(_recipesState.currentIngredients, _recipesState.availability);
        }
      })
      .catch(function () {
        // Non-fatal — catalog is used for detail/editor autocomplete (Plan 02); list still shows
      });
  }

  // Mutates _recipesState.currentIngredients in place, copying catalog cost/retail
  // onto each ingredient by item_id. No-op until the catalog has loaded.
  function applyCatalogRatesToCurrentIngredients() {
    if (!_recipesState.catalogLoaded || !_recipesState.currentIngredients) return;
    enrichIngredientsWithCatalogRates(_recipesState.currentIngredients, _recipesState.catalog);
  }

  function loadRecipeList(statusFilter) {
    var url = mwUrl();
    if (!url) { showToast('Middleware not configured', 'error'); return; }
    var status = statusFilter || 'all';
    var inner = document.getElementById('bp-recipes-inner');
    if (inner) inner.innerHTML = '<div class="bp-skeleton-block"></div>';

    fetch(url + '/api/recipes?status=' + encodeURIComponent(status), {
      credentials: 'include',
      headers: getRecipesMwHeaders()
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        _recipesState.list = data.recipes || [];
        _recipesState.total = data.total || 0;
        renderRecipeList();
      })
      .catch(function () {
        showToast('Could not load recipes. Please try again.', 'error');
        var inner2 = document.getElementById('bp-recipes-inner');
        if (inner2) inner2.innerHTML = '<p class="bp-empty-state">Could not load recipes. Please try again.</p>';
      });
  }

  // Pure helper: builds the rows HTML for a filtered recipe list.
  // Exported for unit tests.
  function renderRecipeListHtml(recipes) {
    if (!recipes || recipes.length === 0) return '';
    var html = '<table class="bp-recipes-table"><tbody>';
    recipes.forEach(function (recipe) {
      var badgeClass = 'bp-recipes-badge-' + escapeHTML(recipe.status || 'draft');
      var styleLine = recipe.style ? '<div class="bp-recipes-style">' + escapeHTML(recipe.style) + '</div>' : '';
      html += '<tr class="bp-recipes-row" data-recipe-id="' + escapeHTML(recipe.recipe_id || '') + '">';
      html += '<td class="bp-recipes-name">' + escapeHTML(recipe.name || '') + styleLine + '</td>';
      html += '<td class="bp-recipes-status"><span class="' + badgeClass + '">' + escapeHTML(recipe.status || 'draft') + '</span></td>';
      html += '<td class="bp-recipes-price">' + recipeRowPrice(recipe) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function renderRecipeList() {
    var inner = document.getElementById('bp-recipes-inner');
    if (!inner) return;

    var currentQuery = '';
    var searchEl = document.getElementById('bp-recipes-search');
    if (searchEl) currentQuery = searchEl.value || '';

    var filtered = filterRecipesByName(_recipesState.list, currentQuery);

    var html = '<div class="bp-recipes-toolbar">';
    html += '<input type="search" id="bp-recipes-search" class="bp-recipes-search" placeholder="Search recipes…" value="' + escapeHTML(currentQuery) + '" aria-label="Filter recipes by name">';
    html += '</div>';

    if (filtered.length === 0) {
      html += '<p class="bp-empty-state">' + (currentQuery ? 'No recipes match your search.' : 'No recipes yet.') + '</p>';
      inner.innerHTML = html;
      return;
    }

    inner.innerHTML = html + renderRecipeListHtml(filtered);
  }

  // ===== Recipe Detail / Editor =====

  function showRecipesListView() {
    var listView = document.getElementById('bp-recipes-list-view');
    var detailView = document.getElementById('bp-recipes-detail-view');
    if (listView) listView.style.display = '';
    if (detailView) detailView.style.display = 'none';
    _recipesState.currentRecipeId = null;
    _recipesState.currentRecipe = null;
    _recipesState.currentIngredients = [];
    _recipesState.availability = null;
  }

  function showRecipesDetailView() {
    var listView = document.getElementById('bp-recipes-list-view');
    var detailView = document.getElementById('bp-recipes-detail-view');
    if (listView) listView.style.display = 'none';
    if (detailView) detailView.style.display = '';
  }

  function openRecipeDetail(recipeId) {
    var url = mwUrl();
    if (!url) { showToast('Middleware not configured', 'error'); return; }
    _recipesState.currentRecipeId = recipeId;
    showRecipesDetailView();

    var titleEl = document.getElementById('bp-recipe-detail-title');
    var saveBtn = document.getElementById('bp-recipes-save-btn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Recipe'; }

    // Hide Delete and Clone buttons when creating a new recipe (D-04: no accidental delete).
    var deleteBtn = document.getElementById('bp-recipe-delete');
    if (deleteBtn) { deleteBtn.style.display = recipeId ? '' : 'none'; }
    var cloneBtn = document.getElementById('bp-recipe-clone');
    if (cloneBtn) { cloneBtn.style.display = recipeId ? '' : 'none'; }

    if (!recipeId) {
      // New recipe mode
      if (titleEl) titleEl.textContent = 'New Recipe';
      populateRecipeForm(null);
      renderAvailabilityBannerBp(null);
      renderIngredientRows([], null);
      initBpRecipeNameAssist();
      return;
    }
    clearBpRecipeNameAssist();

    if (titleEl) titleEl.textContent = 'Loading…';
    renderAvailabilityBannerBp({ summary: 'loading' });

    Promise.all([
      fetch(url + '/api/recipes/' + encodeURIComponent(recipeId), { credentials: 'include', headers: getRecipesMwHeaders() })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); }),
      fetch(url + '/api/recipes/' + encodeURIComponent(recipeId) + '/availability', { credentials: 'include', headers: getRecipesMwHeaders() })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
    ]).then(function (results) {
      var detail = results[0];
      var avail = results[1];
      _recipesState.currentRecipe = detail.recipe || detail;
      _recipesState.currentIngredients = (detail.ingredients || []).slice();
      _recipesState.availability = avail;
      // Fill each ingredient's cost/retail from the catalog (matched by item_id). If the
      // catalog is still loading this is a no-op now and gets re-applied when
      // loadIngredientCatalogForRecipes finishes (see the catalog re-render hook).
      applyCatalogRatesToCurrentIngredients();

      if (titleEl) titleEl.textContent = escapeHTML(_recipesState.currentRecipe.name || 'Recipe');
      populateRecipeForm(_recipesState.currentRecipe);
      renderAvailabilityBannerBp(avail);
      renderIngredientRows(_recipesState.currentIngredients, avail);
      updateActivateGuardrail();
    }).catch(function () {
      showToast('Could not load recipe details. Please try again.', 'error');
      showRecipesListView();
    });
  }

  // Target gravity helpers (D-06): '' when blank / non-numeric, else the number.
  function bpFiniteGravity(v) {
    if (v === undefined || v === null || v === '') return '';
    var n = Number(v);
    return isFinite(n) ? n : '';
  }

  function bpReadGravityInput(id) {
    var el = document.getElementById(id);
    var raw = el ? String(el.value).trim() : '';
    if (raw === '') return '';
    var n = parseFloat(raw);
    return isNaN(n) ? '' : n;
  }

  function populateRecipeForm(recipe) {
    var r = recipe || {};
    var get = function (id) { return document.getElementById(id); };
    if (get('bp-recipe-name')) get('bp-recipe-name').value = r.name || '';
    if (get('bp-recipe-style')) get('bp-recipe-style').value = r.style || '';
    if (get('bp-recipe-beer-category')) get('bp-recipe-beer-category').value = r.beer_category || '';
    if (get('bp-recipe-description')) get('bp-recipe-description').value = r.description || '';
    if (get('bp-recipe-batch-size')) get('bp-recipe-batch-size').value = r.batch_size_l || '';
    if (get('bp-recipe-abv')) get('bp-recipe-abv').value = r.abv || '';
    if (get('bp-recipe-ibu')) get('bp-recipe-ibu').value = r.ibu || '';
    if (get('bp-recipe-target-og')) get('bp-recipe-target-og').value = bpFiniteGravity(r.target_og);
    if (get('bp-recipe-target-fg')) get('bp-recipe-target-fg').value = bpFiniteGravity(r.target_fg);
    if (get('bp-recipe-colour-srm')) get('bp-recipe-colour-srm').value = r.colour_srm || '';
    if (get('bp-recipe-locked-price')) get('bp-recipe-locked-price').value = r.locked_price || '';
    if (get('bp-recipe-service-fee')) get('bp-recipe-service-fee').value = r.service_fee != null ? r.service_fee : 45; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    if (get('bp-recipe-materials-fee')) get('bp-recipe-materials-fee').value = r.materials_fee != null ? r.materials_fee : 5; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    if (get('bp-recipe-status')) get('bp-recipe-status').value = r.status || 'draft';
    if (get('bp-recipe-pricing-mode')) get('bp-recipe-pricing-mode').value = r.pricing_mode || 'locked';
    _recipesState.previousStatus = r.status || 'draft';
    if (get('bp-recipe-status-error')) get('bp-recipe-status-error').textContent = '';
  }

  function renderAvailabilityBannerBp(availability) {
    var banner = document.getElementById('bp-recipes-availability-banner');
    if (!banner) return;
    if (!availability) { banner.innerHTML = ''; return; }
    var summary = availability.summary || 'unknown';
    var msgs = {
      'loading': 'Checking ingredient availability…',
      'all_ok': 'All ingredients in stock.',
      'some_low': 'Some ingredients are running low.',
      'cannot_brew': 'One or more ingredients are out of stock.',
      'unknown': 'Availability data unavailable.'
    };
    var cls = {
      'loading': 'bp-avail-loading',
      'all_ok': 'bp-avail-ok',
      'some_low': 'bp-avail-low',
      'cannot_brew': 'bp-avail-error',
      'unknown': 'bp-avail-unknown'
    };
    banner.innerHTML = '<span class="bp-avail-banner ' + (cls[summary] || 'bp-avail-unknown') + '">' +
      escapeHTML(msgs[summary] || 'Unknown availability.') + '</span>';
  }

  function renderIngredientRows(ingredients, availability) {
    var tbody = document.getElementById('bp-recipe-ing-tbody');
    var emptyEl = document.getElementById('bp-recipe-ing-empty');
    if (!tbody) return;

    if (!ingredients || ingredients.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      updateIngredientTotalsBp();
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    var availMap = {};
    if (availability && availability.ingredients) {
      availability.ingredients.forEach(function (a) {
        availMap[String(a.item_id)] = a;
      });
    }

    var html = '';
    var totalCost = 0;
    var totalRetail = 0;

    // Grouped render (data-ing-idx MUST be ingredients.indexOf(ing), not loop idx)
    var groups = (typeof groupRecipeIngredients === 'function')
      ? groupRecipeIngredients(ingredients)
      : [{ label: '', count: ingredients.length, items: ingredients.slice() }];

    groups.forEach(function (group) {
      if (group.label) {
        html += '<tr class="bp-recipes-ing-group"><td colspan="8">' + escapeHTML(group.label) + ' (' + group.count + ')</td></tr>';
      }
      group.items.forEach(function (ing) {
        var idx = ingredients.indexOf(ing); // CRITICAL: original array index
        var avail = availMap[String(ing.item_id)] || {};
        var dotClass = 'bp-ing-status-dot bp-ing-status-dot--' + escapeHTML(avail.status || 'unknown');
        var stockText = avail.stock_on_hand != null ? avail.stock_on_hand + ' ' + escapeHTML(ing.unit || '') + ' available' : ''; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        var dotTitle = avail.status === 'unknown' ? 'Stock data loading — try again shortly'
          : (avail.batches_possible != null ? avail.batches_possible + ' batch(es) possible' : ''); // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        var qty = parseFloat(ing.quantity) || 0;
        var costEach = parseFloat(ing.purchase_rate) || 0;
        var retailEach = parseFloat(ing.rate) || 0;
        // 73-07/CR-02: catalog_unit (the unit the rate is priced per) is DISTINCT
        // from ing.unit (the recipe-line unit) — do NOT pass ing as both args to
        // bpIngredientLineCost, that collapses the two units and no-ops conversion.
        var catalogUnit = ing.catalog_unit || ing.unit;
        var costResult = bpIngredientLineCost({ unit: catalogUnit, rate: costEach }, { unit: ing.unit, quantity: qty });
        var retailResult = bpIngredientLineCost({ unit: catalogUnit, rate: retailEach }, { unit: ing.unit, quantity: qty });
        var lineCost = costResult.ok ? costResult.cost : 0;
        var lineRetail = retailResult.ok ? retailResult.cost : 0;
        if (costEach > 0 && costResult.ok) totalCost += lineCost;
        if (retailEach > 0 && retailResult.ok) totalRetail += lineRetail;

        html += '<tr class="bp-recipes-ing-row" data-ing-idx="' + idx + '" data-item-id="' + escapeHTML(String(ing.item_id || '')) + '">';
        html += '<td class="bp-ing-autocomplete-wrap">';
        html += '<input type="text" class="bp-input bp-ing-search" value="' + escapeHTML(ing.item_name || '') + '" placeholder="Search ingredient…" />';
        html += '</td>';
        html += '<td><input type="number" class="bp-input bp-ing-qty" value="' + escapeHTML(String(ing.quantity || '')) + '" step="any" min="0" inputmode="decimal" /></td>';
        var unitOpts = unitOptionsFor(ing.catalog_unit, ing.unit);
        html += '<td class="bp-ing-unit"><select class="bp-input bp-ing-unit-select" aria-label="Unit for ' + escapeHTML(ing.item_name || 'ingredient') + '">';
        unitOpts.forEach(function (u) {
          var sel = String(u).toLowerCase() === String(ing.unit || '').toLowerCase() ? ' selected' : '';
          html += '<option value="' + escapeHTML(u) + '"' + sel + '>' + escapeHTML(u) + '</option>';
        });
        html += '</select></td>';
        html += '<td class="bp-ing-cost">' + (costEach > 0 ? (costResult.ok ? '$' + lineCost.toFixed(2) : '<span class="bp-ing-cost-unconvertible" title="' + escapeHTML(costResult.error || 'Cannot convert units') + '">N/A</span>') : '—') + '</td>';
        html += '<td class="bp-ing-retail">' + (retailEach > 0 ? (retailResult.ok ? '$' + lineRetail.toFixed(2) : '<span class="bp-ing-cost-unconvertible" title="' + escapeHTML(retailResult.error || 'Cannot convert units') + '">N/A</span>') : '—') + '</td>';
        html += '<td><span class="bp-ing-stock-hint">' + escapeHTML(stockText) + '</span></td>';
        html += '<td><span class="' + dotClass + '" title="' + escapeHTML(dotTitle) + '"></span></td>';
        html += '<td><button type="button" class="btn-secondary bp-ing-remove" aria-label="Remove ' + escapeHTML(ing.item_name || 'ingredient') + '">&#10005;</button></td>';
        html += '</tr>';
      });
    });
    tbody.innerHTML = html;

    updateIngredientTotalsBp(totalCost, totalRetail, ingredients.length);
    attachIngredientRowListeners();
    updateActivateGuardrail();
  }

  function updateIngredientTotalsBp(totalCost, totalRetail, ingCount) {
    var tfoot = document.getElementById('bp-recipe-ing-tfoot');
    if (!tfoot) return;
    var cost = totalCost || 0;
    var retail = totalRetail || 0;
    var count = ingCount || 0;
    if (count > 0 && (cost > 0 || retail > 0)) {
      tfoot.innerHTML = '<tr class="bp-recipes-ing-totals">' +
        '<td colspan="3"><strong>Totals</strong></td>' +
        '<td class="bp-ing-cost"><strong>' + (cost > 0 ? '$' + cost.toFixed(2) : '—') + '</strong></td>' +
        '<td class="bp-ing-retail"><strong>' + (retail > 0 ? '$' + retail.toFixed(2) : '—') + '</strong></td>' +
        '<td colspan="3"></td></tr>';
    } else {
      tfoot.innerHTML = '';
    }
  }

  function attachIngredientRowListeners() {
    var tbody = document.getElementById('bp-recipe-ing-tbody');
    if (!tbody) return;

    // Remove buttons
    tbody.querySelectorAll('.bp-ing-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.bp-recipes-ing-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        if (isNaN(idx) || idx < 0) return;
        _recipesState.currentIngredients.splice(idx, 1);
        renderIngredientRows(_recipesState.currentIngredients, _recipesState.availability);
      });
    });

    // Quantity change
    tbody.querySelectorAll('.bp-ing-qty').forEach(function (input) {
      input.addEventListener('change', function () {
        var row = input.closest('.bp-recipes-ing-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        if (!isNaN(idx) && _recipesState.currentIngredients[idx]) {
          _recipesState.currentIngredients[idx].quantity = parseFloat(input.value) || 0;
        }
        // Re-render totals inline (without full re-render) — unit-aware (73-07/CR-02)
        var totalCost = 0;
        var totalRetail = 0;
        _recipesState.currentIngredients.forEach(function (ing) {
          var qty = parseFloat(ing.quantity) || 0;
          var costEach = parseFloat(ing.purchase_rate) || 0;
          var retailEach = parseFloat(ing.rate) || 0;
          var catalogUnit = ing.catalog_unit || ing.unit;
          var costResult = bpIngredientLineCost({ unit: catalogUnit, rate: costEach }, { unit: ing.unit, quantity: qty });
          var retailResult = bpIngredientLineCost({ unit: catalogUnit, rate: retailEach }, { unit: ing.unit, quantity: qty });
          if (costEach > 0 && costResult.ok) totalCost += costResult.cost;
          if (retailEach > 0 && retailResult.ok) totalRetail += retailResult.cost;
        });
        updateIngredientTotalsBp(totalCost, totalRetail, _recipesState.currentIngredients.length);
        updateActivateGuardrail();
      });
    });

    // Unit change — re-render fully so cost/retail/availability recompute
    // against the new unit (a unit edit can flip a line between priceable and
    // N/A, which an inline totals update would not reflect).
    tbody.querySelectorAll('.bp-ing-unit-select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var row = sel.closest('.bp-recipes-ing-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        if (!isNaN(idx) && _recipesState.currentIngredients[idx]) {
          _recipesState.currentIngredients[idx].unit = sel.value;
        }
        renderIngredientRows(_recipesState.currentIngredients, _recipesState.availability);
        updateActivateGuardrail();
      });
    });

    // Autocomplete search inputs
    tbody.querySelectorAll('.bp-ing-search').forEach(function (input) {
      input.addEventListener('input', function () {
        showIngredientAutocompleteBp(input);
      });
      input.addEventListener('focus', function () {
        if (!input.value) showIngredientAutocompleteBp(input);
      });
      input.addEventListener('blur', function () {
        setTimeout(function () { hideIngredientAutocompleteBp(input); }, 200);
      });
    });
  }

  // Autocomplete helpers

  function filterIngredientCatalog(query) {
    var q = (query || '').toLowerCase().trim();
    if (!q) return _recipesState.catalog.slice(0, 6);
    return _recipesState.catalog.filter(function (item) {
      return (item.name || '').toLowerCase().indexOf(q) !== -1 ||
             (item.sku || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 6);
  }

  function showIngredientAutocompleteBp(input) {
    hideIngredientAutocompleteBp(input);
    if (!_recipesState.catalogLoaded) return;
    var matches = filterIngredientCatalog(input.value);
    if (matches.length === 0) return;

    var drop = document.createElement('div');
    drop.className = 'bp-ing-autocomplete-drop';
    drop.setAttribute('role', 'listbox');
    matches.forEach(function (item) {
      var opt = document.createElement('div');
      opt.setAttribute('role', 'option');
      var stockLabel = item.stock_on_hand != null ? item.stock_on_hand : '?'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      var unitLabel = item.unit || '';
      opt.innerHTML = escapeHTML(item.name || '') + ' &mdash; ' + escapeHTML(item.sku || '') +
        ' <span class="bp-ing-stock-hint">(' + stockLabel + (unitLabel ? ' ' + escapeHTML(unitLabel) : '') + ' available)</span>';
      opt.addEventListener('mousedown', function (e) {
        e.preventDefault(); // Prevent blur before selection
        selectIngredientFromAutocompleteBp(input, item);
      });
      drop.appendChild(opt);
    });
    input.parentNode.appendChild(drop);
  }

  function hideIngredientAutocompleteBp(input) {
    var existing = input.parentNode && input.parentNode.querySelector('.bp-ing-autocomplete-drop');
    if (existing) existing.remove();
  }

  function selectIngredientFromAutocompleteBp(input, item) {
    var row = input.closest('.bp-recipes-ing-row');
    var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
    input.value = item.name || '';
    hideIngredientAutocompleteBp(input);

    if (!isNaN(idx) && _recipesState.currentIngredients[idx]) {
      _recipesState.currentIngredients[idx].item_id = item.item_id;
      _recipesState.currentIngredients[idx].item_name = item.name || '';
      _recipesState.currentIngredients[idx].sku = item.sku || '';
      _recipesState.currentIngredients[idx].unit = item.unit || '';
      // 73-07/CR-02: record the selected catalog item's unit DISTINCTLY from
      // the line unit above — see enrichIngredientsWithCatalogRates note.
      _recipesState.currentIngredients[idx].catalog_unit = item.unit || '';
      _recipesState.currentIngredients[idx].purchase_rate = parseFloat(item.purchase_rate) || 0;
      _recipesState.currentIngredients[idx].rate = parseFloat(item.rate || item.price_per_unit) || 0;
    }

    // Update unit display and stock hint inline
    var unitTd = row && row.querySelector('.bp-ing-unit');
    if (unitTd) unitTd.textContent = item.unit || '';
    var hintSpan = row && row.querySelector('.bp-ing-stock-hint');
    if (hintSpan) {
      var stockVal = item.stock_on_hand != null ? item.stock_on_hand : '?'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      hintSpan.textContent = stockVal + ' ' + (item.unit || '') + ' available';
    }
    if (row) row.setAttribute('data-item-id', item.item_id || '');

    // Recalc totals — unit-aware (73-07/CR-02)
    var totalCost = 0;
    var totalRetail = 0;
    _recipesState.currentIngredients.forEach(function (ing) {
      var qty = parseFloat(ing.quantity) || 0;
      var costEach = parseFloat(ing.purchase_rate) || 0;
      var retailEach = parseFloat(ing.rate) || 0;
      var catalogUnit = ing.catalog_unit || ing.unit;
      var costResult = bpIngredientLineCost({ unit: catalogUnit, rate: costEach }, { unit: ing.unit, quantity: qty });
      var retailResult = bpIngredientLineCost({ unit: catalogUnit, rate: retailEach }, { unit: ing.unit, quantity: qty });
      if (costEach > 0 && costResult.ok) totalCost += costResult.cost;
      if (retailEach > 0 && retailResult.ok) totalRetail += retailResult.cost;
    });
    updateIngredientTotalsBp(totalCost, totalRetail, _recipesState.currentIngredients.length);
    updateActivateGuardrail();
  }

  function addIngredientRow() {
    _recipesState.currentIngredients.push({
      item_id: '',
      item_name: '',
      sku: '',
      quantity: 0,
      unit: ''
    });
    renderIngredientRows(_recipesState.currentIngredients, _recipesState.availability);
    // Focus the new search input
    var tbody = document.getElementById('bp-recipe-ing-tbody');
    if (tbody) {
      var lastSearch = tbody.querySelector('.bp-recipes-ing-row:last-child .bp-ing-search');
      if (lastSearch) lastSearch.focus();
    }
  }

  // ===== Phase 90-09 (D-21): recipe editor similar-name assist + Start from =====
  // New-recipe mode only. Lists up to 5 similar recipes (all statuses) while the name is typed and
  // lets staff start from one via the existing clone path (bpCloneRecipe -> bpCloneRecipePayload).
  var _bpNameAssistTimer = null;
  var _bpNameAssistLoading = false;

  function clearBpRecipeNameAssist() {
    var box = document.getElementById('bp-recipe-name-similar');
    if (box) box.innerHTML = '';
  }

  function renderBpRecipeNameAssist() {
    var nameEl = document.getElementById('bp-recipe-name');
    var box = document.getElementById('bp-recipe-name-similar');
    if (!nameEl || !box) return;
    if (_recipesState.currentRecipeId) { box.innerHTML = ''; return; }
    var lib = bpRecipePickerLib();
    if (!lib || !_recipesState.allForDupCheck) { box.innerHTML = ''; return; }
    var m = lib.findRecipeNameMatches(_recipesState.allForDupCheck, nameEl.value);
    var list = m.exact.concat(m.similar).slice(0, 5);
    var html = '';
    if (m.exact.length) {
      html += '<div class="bp-recipe-dup" role="alert">A recipe named \'' + escapeHTML(m.exact[0].name || '') + '\' already exists.</div>';
    }
    if (list.length) {
      html += '<div class="bp-recipe-similar">' + list.map(function (r) {
        return '<div class="bp-recipe-similar-row">' +
          '<div class="bp-recipe-similar-info"><span class="bp-recipe-opt-name">' + escapeHTML(r.name || '') + '</span>' +
          (r.style ? '<span class="bp-recipe-opt-style">' + escapeHTML(r.style) + '</span>' : '') + '</div>' +
          '<button type="button" class="btn-secondary bp-recipe-start-from" data-rid="' + escapeHTML(r.recipe_id || '') +
          '" data-rname="' + escapeHTML(r.name || '') + '">Start from this recipe</button></div>';
      }).join('') + '</div>';
    }
    box.innerHTML = html;
  }

  function initBpRecipeNameAssist() {
    var nameEl = document.getElementById('bp-recipe-name');
    if (!nameEl || !nameEl.parentNode) return;
    var box = document.getElementById('bp-recipe-name-similar');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bp-recipe-name-similar';
      nameEl.parentNode.insertBefore(box, nameEl.nextSibling);
    }
    box.innerHTML = '';
    if (!box._bpBound) {
      box._bpBound = true;
      box.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.bp-recipe-start-from') : null;
        if (!btn || btn.disabled) return;
        bpStartRecipeFromExisting(btn.getAttribute('data-rid'), btn.getAttribute('data-rname'), btn);
      });
    }
    if (!nameEl._bpAssistBound) {
      nameEl._bpAssistBound = true;
      nameEl.addEventListener('input', function () {
        clearTimeout(_bpNameAssistTimer);
        _bpNameAssistTimer = setTimeout(renderBpRecipeNameAssist, 200);
      });
    }
    var url = mwUrl();
    if (!_recipesState.allForDupCheck && url && !_bpNameAssistLoading) {
      _bpNameAssistLoading = true;
      fetch(url + '/api/recipes?status=all', { credentials: 'include', headers: getRecipesMwHeaders() })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (data) {
          _bpNameAssistLoading = false;
          _recipesState.allForDupCheck = data.recipes || [];
          renderBpRecipeNameAssist();
        })
        .catch(function () { _bpNameAssistLoading = false; });
    }
  }

  function bpRecipeFormIsDirty() {
    var get = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    return (_recipesState.currentIngredients || []).length > 0 || !!get('bp-recipe-style') || !!get('bp-recipe-description');
  }

  function bpStartRecipeFromExisting(recipeId, recipeName, btn) {
    var url = mwUrl();
    if (!url || !recipeId) return;
    function proceed() {
      var box = document.getElementById('bp-recipe-name-similar');
      var oldErr = box ? box.querySelector('.bp-recipe-start-error') : null;
      if (oldErr) oldErr.parentNode.removeChild(oldErr);
      if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
      return fetch(url + '/api/recipes/' + encodeURIComponent(recipeId), { credentials: 'include', headers: getRecipesMwHeaders() })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (detail) {
          _recipesState.currentRecipe = detail.recipe || detail;
          _recipesState.currentIngredients = (detail.ingredients || []).slice();
          bpCloneRecipe();
          var nameEl = document.getElementById('bp-recipe-name');
          if (nameEl) { nameEl.focus(); if (nameEl.select) nameEl.select(); }
        })
        .catch(function () {
          if (btn) { btn.disabled = false; btn.textContent = 'Start from this recipe'; }
          var b = document.getElementById('bp-recipe-name-similar');
          if (b) {
            var err = document.createElement('div');
            err.className = 'bp-recipe-dup bp-recipe-start-error';
            err.setAttribute('role', 'alert');
            err.textContent = 'Could not load that recipe. Try again.';
            b.appendChild(err);
          }
        });
    }
    if (bpRecipeFormIsDirty()) {
      showConfirmSheet("Replace what you have entered with a copy of '" + (recipeName || '') + "'?",
        'Start from copy', 'bp-confirm-btn--primary', proceed);
      return;
    }
    return proceed();
  }

  // Pure helper: builds a clone draft payload from a source recipe + ingredients.
  // Returns { recipe, ingredients } — both are deep copies; source is NOT mutated.
  // Exported for unit tests.
  function bpCloneRecipePayload(sourceRecipe, sourceIngredients) {
    var r = sourceRecipe || {};
    var clonedRecipe = {
      recipe_id: null,
      name: 'Copy of ' + (r.name || ''),
      style: r.style || '',
      beer_category: r.beer_category || '',
      description: r.description || '',
      batch_size_l: r.batch_size_l || 0,
      abv: r.abv || 0,
      ibu: r.ibu || 0,
      target_og: bpFiniteGravity(r.target_og),
      target_fg: bpFiniteGravity(r.target_fg),
      colour_srm: r.colour_srm || 0,
      pricing_mode: r.pricing_mode || 'locked',
      locked_price: r.locked_price || 0,
      service_fee: r.service_fee != null ? r.service_fee : 45, // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      materials_fee: r.materials_fee != null ? r.materials_fee : 5, // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      status: 'draft'
    };
    var ings = Array.isArray(sourceIngredients) ? sourceIngredients : [];
    var clonedIngredients = ings.map(function (ing) {
      return {
        item_id: ing.item_id || '',
        item_name: ing.item_name || '',
        sku: ing.sku || '',
        quantity: ing.quantity || 0,
        unit: ing.unit || '',
        purchase_rate: ing.purchase_rate || 0,
        rate: ing.rate || 0
      };
    });
    return { recipe: clonedRecipe, ingredients: clonedIngredients };
  }

  // State-dependent: opens the editor in new-recipe mode pre-filled from the current recipe.
  // Relies on _recipesState.currentRecipe + currentIngredients being set.
  function bpCloneRecipe() {
    if (!_recipesState.currentRecipe) {
      showToast('No recipe open to clone.', 'warning');
      return;
    }
    var payload = bpCloneRecipePayload(_recipesState.currentRecipe, _recipesState.currentIngredients);

    // Enter new-recipe editor mode (recipeId = null)
    _recipesState.currentRecipeId = null;
    _recipesState.currentRecipe = payload.recipe;
    _recipesState.currentIngredients = payload.ingredients;
    _recipesState.availability = null;

    showRecipesDetailView();

    var titleEl = document.getElementById('bp-recipe-detail-title');
    if (titleEl) titleEl.textContent = 'New Recipe';

    var saveBtn = document.getElementById('bp-recipes-save-btn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Recipe'; }

    // Hide Delete and Clone buttons in new-recipe mode
    var deleteBtn = document.getElementById('bp-recipe-delete');
    if (deleteBtn) deleteBtn.style.display = 'none';
    var cloneBtn = document.getElementById('bp-recipe-clone');
    if (cloneBtn) cloneBtn.style.display = 'none';

    populateRecipeForm(payload.recipe);
    renderAvailabilityBannerBp(null);
    renderIngredientRows(payload.ingredients, null);
    updateActivateGuardrail();
    clearBpRecipeNameAssist();
  }

  // Activate guardrail (D-06): evaluate and reflect on the Activate button
  function updateActivateGuardrail() {
    var btn = document.getElementById('bp-recipe-activate');
    if (!btn) return;
    var lockedPriceEl = document.getElementById('bp-recipe-locked-price');
    var formData = { locked_price: lockedPriceEl ? lockedPriceEl.value : '' };
    var validIngredients = _recipesState.currentIngredients.filter(function (ing) {
      return ing.item_id && ing.quantity > 0;
    });
    var check = canActivateRecipe(formData, validIngredients);
    btn.disabled = !check.ok;
    btn.title = check.ok ? '' : (check.reason || '');
  }

  // ===== D-05: Recipe editor save resilience =====
  //
  // The recipe editor is the ONLY major BrewPad form NOT protected by the
  // _formSavers draft system, and saveRecipe() used to ignore HTTP status
  // (parsed r.json() without checking r.ok) -- so a 422/502 could be misread
  // as success and a session-expiry/reload silently lost the edits.

  // D-05a: builds the recipe-draft snapshot. Returns null when there is
  // nothing worth saving (editor closed / no name entered yet). Registered
  // as a _formSavers saver AND called directly on save-failure below.
  function recipeDraftSnapshot() {
    var detailView = document.getElementById('bp-recipes-detail-view');
    if (!detailView || detailView.style.display === 'none') return null;
    var formData = readRecipeFormData();
    if (!formData.name) return null;
    return {
      recipeId: _recipesState.currentRecipeId,
      formData: formData,
      ingredients: (_recipesState.currentIngredients || []).slice()
    };
  }

  // D-05a: snapshot the recipe draft immediately (not only on the
  // session-logout path) -- called from saveRecipe's failure branch so
  // a failed save (network, 422, 502...) never orphans in-progress work.
  function saveRecipeDraftNow() {
    try {
      var data = recipeDraftSnapshot();
      if (data) sessionStorage.setItem(RECIPE_DRAFT_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function clearRecipeDraft() {
    try { sessionStorage.removeItem(RECIPE_DRAFT_KEY); } catch (e) {}
  }

  // D-05c: highlight the ingredient row named by the D-03 `cause` (item_name,
  // falling back to item_id match) so staff can see exactly which line failed.
  function highlightIngredientRowByCause(cause) {
    if (!cause) return;
    var ingredients = _recipesState.currentIngredients || [];
    var idx = -1;
    for (var i = 0; i < ingredients.length; i++) {
      var ing = ingredients[i];
      if ((ing.item_name && ing.item_name === cause) || (ing.item_id && String(ing.item_id) === String(cause))) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    var tbody = document.getElementById('bp-recipe-ing-tbody');
    if (!tbody) return;
    var row = tbody.querySelector('.bp-recipes-ing-row[data-ing-idx="' + idx + '"]');
    if (row) {
      row.className += ' bp-ing-row--error';
      if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
    }
  }

  // Save recipe (POST create / PUT update)
  function saveRecipe() {
    var url = mwUrl();
    if (!url) { showToast('Middleware not configured', 'error'); return; }

    var formData = buildRecipePayload(readRecipeFormData(), _recipesState.currentIngredients);

    if (!formData.name) {
      showToast('Recipe name is required.', 'warning');
      return;
    }

    // D-06 activation guardrail (frontend) — also checked server-side
    if (formData.status === 'active') {
      var guard = canActivateRecipe(formData, formData.ingredients);
      if (!guard.ok) {
        var statusErrEl = document.getElementById('bp-recipe-status-error');
        if (statusErrEl) statusErrEl.textContent = guard.reason;
        var statusEl = document.getElementById('bp-recipe-status');
        if (statusEl) statusEl.value = _recipesState.previousStatus;
        return;
      }
    }

    var recipeId = _recipesState.currentRecipeId;
    var method = recipeId ? 'PUT' : 'POST';
    var endpoint = recipeId
      ? url + '/api/recipes/' + encodeURIComponent(recipeId)
      : url + '/api/recipes';

    // D-03: optimistic-concurrency token (existing recipe only). Set before
    // submitRecipeSave so a transient-failure Retry reuses the same token.
    if (recipeId && _recipesState.currentRecipe && _recipesState.currentRecipe.updated_at) {
      formData.expected_updated_at = _recipesState.currentRecipe.updated_at;
    }

    return submitRecipeSave(endpoint, method, formData, recipeId);
  }

  // D-05d: factored out of saveRecipe so a retry can re-submit the EXACT
  // same already-built payload (formData) without re-reading the form.
  function submitRecipeSave(endpoint, method, formData, recipeId) {
    var saveBtn = document.getElementById('bp-recipes-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    return fetch(endpoint, {
      method: method,
      credentials: 'include',
      headers: getRecipesMwHeaders(),
      body: JSON.stringify(formData)
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { httpOk: r.ok, status: r.status, data: data };
        });
      })
      .then(function (result) {
        // D-05b: a non-2xx response is ALWAYS a failure — never rely solely
        // on the body shape (`!data.ok && data.error`), which let a 422/502
        // with an unexpected body slip through as "success".
        if (!result.httpOk) {
          var httpErr = new Error((result.data && result.data.error) || ('Save failed (HTTP ' + result.status + ')'));
          httpErr.status = result.status;
          httpErr.code = result.data && result.data.code;
          httpErr.cause = result.data && result.data.cause;
          throw httpErr;
        }
        var data = result.data;
        if (!data.ok && data.error) throw new Error(data.error);
        showToast(recipeId ? 'Recipe saved.' : 'Recipe created.', 'success');
        clearRecipeDraft();
        if (!recipeId && data.recipe_id) {
          _recipesState.currentRecipeId = data.recipe_id;
          openRecipeDetail(data.recipe_id);
        } else {
          openRecipeDetail(recipeId);
        }
        loadRecipeList('all');
      })
      .catch(function (err) {
        // D-05a: never orphan in-progress work — snapshot the draft on ANY failure.
        saveRecipeDraftNow();

        var status = err && err.status;
        var code = err && err.code;
        var cause = err && err.cause;
        var msg = (err && err.message) ? err.message : 'Please check your connection and try again.';

        // D-03: stale editor -- never auto-retried (409 is not transient); offer a reload.
        if (code === 'stale_recipe') {
          showToast(msg, 'error', {
            actionLabel: 'Reload',
            onAction: function () { openRecipeDetail(recipeId); }
          });
          return;
        }

        // D-05c: consume the D-03 code/cause contract; fall back to the human
        // error string when absent (older/other responses may not carry them).
        if (code === 'unit_mismatch' && cause) {
          if (msg.indexOf(cause) === -1) {
            msg = 'Unit mismatch on "' + cause + '": ' + msg;
          }
          highlightIngredientRowByCause(cause);
        }

        // D-05d: transient (network / gateway) failures offer a retry that
        // re-submits the SAME formData -- no form re-read.
        var isTransient = !status || status === 502 || status === 503 || status === 504;
        var toastOpts = isTransient ? {
          actionLabel: 'Retry',
          onAction: function () { submitRecipeSave(endpoint, method, formData, recipeId); }
        } : undefined;

        showToast('Could not save recipe. ' + msg, 'error', toastOpts);
      })
      .finally(function () {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Recipe'; }
      });
  }

  // Confirm-gated delete (D-03, D-04).
  // Calls showConfirmSheet with the danger variant — no one-tap delete on the shared iPad.
  function deleteRecipe(recipeId, name) {
    var url = mwUrl();
    if (!url) { showToast('Middleware not configured', 'error'); return; }
    showConfirmSheet(
      recipeDeleteConfirmMessage(name),
      'Delete',
      'bp-confirm-btn--danger',
      function () {
        var delUrl = url + '/api/recipes/' + encodeURIComponent(recipeId);
        var cur = _recipesState.currentRecipe;
        if (cur && cur.recipe_id === recipeId && cur.updated_at) {
          delUrl += '?expected_updated_at=' + encodeURIComponent(cur.updated_at);
        }
        fetch(delUrl, {
          method: 'DELETE',
          credentials: 'include',
          headers: getRecipesMwHeaders()
        })
          .then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (data) {
              return { status: r.status, data: data };
            });
          })
          .then(function (result) {
            var data = result.data;
            if (result.status === 409 && data && data.code === 'stale_recipe') {
              var staleErr = new Error(data.error || 'This recipe was changed since you opened it \u2014 reload to see the latest');
              staleErr.code = 'stale_recipe';
              throw staleErr;
            }
            if (!data.ok && data.error) throw new Error(data.error);
            showToast('Recipe deleted.', 'success');
            loadRecipeList('all');
            showRecipesListView();
          })
          .catch(function (err) {
            if (err && err.code === 'stale_recipe') {
              showToast(err.message, 'error', {
                actionLabel: 'Reload',
                onAction: function () { openRecipeDetail(recipeId); }
              });
              return;
            }
            showToast('Could not delete recipe. Please try again.', 'error');
          });
      }
    );
  }

  function readRecipeFormData() {
    var get = function (id) { return document.getElementById(id); };
    return {
      name: get('bp-recipe-name') ? get('bp-recipe-name').value.trim() : '',
      style: get('bp-recipe-style') ? get('bp-recipe-style').value.trim() : '',
      beer_category: get('bp-recipe-beer-category') ? get('bp-recipe-beer-category').value : '',
      description: get('bp-recipe-description') ? get('bp-recipe-description').value.trim() : '',
      batch_size_l: parseFloat(get('bp-recipe-batch-size') ? get('bp-recipe-batch-size').value : 0) || 0,
      abv: parseFloat(get('bp-recipe-abv') ? get('bp-recipe-abv').value : 0) || 0,
      ibu: parseInt(get('bp-recipe-ibu') ? get('bp-recipe-ibu').value : 0, 10) || 0,
      target_og: bpReadGravityInput('bp-recipe-target-og'),
      target_fg: bpReadGravityInput('bp-recipe-target-fg'),
      colour_srm: parseInt(get('bp-recipe-colour-srm') ? get('bp-recipe-colour-srm').value : 0, 10) || 0,
      pricing_mode: get('bp-recipe-pricing-mode') ? get('bp-recipe-pricing-mode').value : 'locked',
      locked_price: parseFloat(get('bp-recipe-locked-price') ? get('bp-recipe-locked-price').value : 0) || 0,
      service_fee: parseFloat(get('bp-recipe-service-fee') ? get('bp-recipe-service-fee').value : 45) || 45,
      materials_fee: parseFloat(get('bp-recipe-materials-fee') ? get('bp-recipe-materials-fee').value : 5) || 5,
      status: get('bp-recipe-status') ? get('bp-recipe-status').value : 'draft'
    };
  }

  // ===== Dashboard =====

  function eagerLoad() {
    // Show loading in dashboard (the first visible panel)
    var dashInner = document.getElementById('bp-dashboard-inner');
    if (dashInner && !document.getElementById('bp-dash-v2')) dashInner.innerHTML = '<div class="bp-skeleton-block"></div><div class="bp-skeleton-block" style="height:120px;margin-top:12px;"></div>';

    // Wrap each call so a single failure doesn't reject the whole Promise.all —
    // a partial result is better than a blank dashboard.
    function settle(p) {
      return p.then(function (r) { return r; }).catch(function () { return null; });
    }

    _eagerLoading = true;
    Promise.all([
      settle(adminApiGet('get_dashboard_stats')),
      settle(adminApiGet('get_batches', { status: 'all' })),   // fetch ALL statuses at once
      settle(adminApiGet('get_vessels')),
      settle(adminApiGet('get_ferm_schedules')),
      settle(adminApiGet('get_tasks_upcoming', { limit: 200 }))
    ]).then(function (results) {
      // Sheets mode answers invalid_action for the aggregate: fall back to the summary read.
      if (results[0]) { results[0] = dashAggregateFromStats(results[0]); return results; }
      return fetchSummaryAggregate().then(function (agg) { results[0] = agg; return results; });
    }).then(function (results) {
      _eagerLoading = false;
      var r0 = results[0], r1 = results[1], r2 = results[2], r3 = results[3], r4 = results[4];

      if (r0) {
        _dashData     = r0.stats;
        _dashSummary  = r0.summary;
        _dashLoadTime = Date.now();
      }

      if (r1) {
        _allBatchesData  = (r1.data && r1.data.batches) || [];
        _batchesLoaded   = true;
        _batchesLoadTime = Date.now();
      }

      if (r2) {
        _vesselsData      = (r2.data && r2.data.vessels) || [];
        _vesselsCacheTime = Date.now();
        _vesselsMap       = {};
        _vesselsData.forEach(function (v) { _vesselsMap[String(v.vessel_id)] = v; });
      }

      if (r3) {
        _fermSchedules          = (r3.data && r3.data.schedules) || [];
        _fermSchedulesCacheTime = Date.now();
      }

      if (r4) {
        _upcomingTasks    = (r4.data && r4.data.tasks) || [];
        _upcomingLoaded   = true;
        _upcomingLoadTime = Date.now();
      }

      // Mark eager-load done if at least the core (summary + batches) succeeded.
      // If everything failed, fall back to the separate-load path.
      if (r0 || r1) {
        _eagerLoadDone = true;
        _eagerLoadTime = Date.now();
        renderDashboard();
        startDashAutoRefresh();
      } else {
        // All calls failed — graceful fallback: load dashboard + batches separately
        _eagerLoadDone = false;
        loadDashboard();
        startDashAutoRefresh();
      }
    });
  }

  function startDashAutoRefresh() {
    if (_dashAutoRefreshTimer) clearInterval(_dashAutoRefreshTimer);
    _dashAutoRefreshTimer = setInterval(function () {
      if (document.hidden) return;
      if (_activeTab === 'dashboard') loadDashboard();
    }, 300000); // 5min — single user, no concurrent edits
  }

  // Phase 94 (D-21): one aggregate read replaces the summary call. Sheets mode
  // answers invalid_action, so fall back to the summary + the get_batches rows.
  function dashAggregateFromStats(r) {
    var stats = (r && r.data) || null;
    return { stats: stats, summary: (stats && stats.summary) || null };
  }

  function dashAggregateFromSummary(r) {
    return { stats: null, summary: (r && r.data) || null };
  }

  // Summary-only aggregate (never rejects: null on failure, like settle()).
  function fetchSummaryAggregate() {
    return adminApiGet('get_batch_dashboard_summary').then(dashAggregateFromSummary, function () { return null; });
  }

  function fetchDashboardAggregate() {
    return adminApiGet('get_dashboard_stats').then(dashAggregateFromStats, function () {
      return adminApiGet('get_batch_dashboard_summary').then(dashAggregateFromSummary);
    });
  }

  function loadDashboard() {
    _dashLoadTime = Date.now();
    // Fetch aggregate + upcoming tasks together for the workload chart
    // (returns the thenable so callers can chain on completion — e.g. the
    // Ready-to-Bottle filter's not-loaded path applies the filter after this resolves)
    return Promise.all([
      fetchDashboardAggregate(),
      adminApiGet('get_tasks_upcoming', { limit: 100 })
    ]).then(function (results) {
      _dashData = results[0].stats;
      _dashSummary = results[0].summary;
      _upcomingTasks = (results[1].data && results[1].data.tasks) || _upcomingTasks;
      if (results[1].data) { _upcomingLoaded = true; _upcomingLoadTime = Date.now(); }
      renderDashboard();
    }).catch(function () {
      // Degrade gracefully: try the aggregate alone
      return fetchDashboardAggregate().then(function (r) {
        _dashData = r.stats;
        _dashSummary = r.summary;
        renderDashboard();
      }).catch(function (e) {
        var inner = document.getElementById('bp-dashboard-inner');
        if (inner) inner.innerHTML = '<p class="bp-empty">Failed to load dashboard: ' + escapeHTML(e.message) + '. Reopen the Dashboard tab to try again.</p>';
      });
    });
  }

  // Lazy-load the Zoho catalog snapshot once; on success caches sku->product map and
  // re-renders the dashboard (Wine Breakdown card). On failure sets error flag + re-renders.
  // Guard: _dashWineSkuLoading prevents a second in-flight fetch from being issued.
  function loadWineSnapshot() {
    if (_dashWineSkuLookup !== null || _dashWineSkuError || _dashWineSkuLoading) return;
    _dashWineSkuLoading = true;
    fetch('/content/zoho-snapshot.json')
      .then(function (r) {
        if (!r.ok) throw new Error('Snapshot fetch failed: ' + r.status);
        return r.json();
      })
      .then(function (snap) {
        _dashWineSkuLookup = buildSkuLookup(snap.products || []);
        _dashWineSkuLoading = false;
        renderDashboard();
      })
      .catch(function () {
        _dashWineSkuError = true;
        _dashWineSkuLoading = false;
        renderDashboard();
      });
  }

  // ===========================================================================
  // Phase 95-06: v2 dashboard shell, opt-in switch and global filter bar.
  // ===========================================================================
  var DASH_V2_CONTROLS = [
    { key: 'type', label: 'Type', opts: [['all', 'All'], ['wine', 'Wine'], ['beer', 'Beer'], ['cider', 'Cider']] },
    { key: 'period', label: 'Period', opts: [['30d', '30d'], ['90d', '90d'], ['6mo', '6m'], ['12mo', '12m'], ['ytd', 'YTD'], ['all', 'All'], ['custom', 'Custom']] },
    { key: 'group', label: 'Group by', opts: [['week', 'Week'], ['month', 'Month']] },
    { key: 'measure', label: 'Measure', opts: [['batches', 'Batches'], ['litres', 'Litres']] }
  ];
  var DASH_V2_SOURCES = [['all', 'All sources'], ['kiosk', 'Kiosk'], ['online', 'Online'], ['manual', 'Manual'], ['zoho_scan', 'Zoho scan'], ['research', 'Research'], ['internal', 'Internal'], ['unknown', 'Unknown']];

  function isDashV2() { return _dashV2On === true; }

  function readDashFiltersFromEnv() {
    var stored = null;
    try { stored = localStorage.getItem('bp_dash_filters'); } catch (e) { stored = null; }
    return resolveDashFilters(location.hash, stored, todayPacific());
  }

  function writeDashFiltersToEnv(state) {
    try {
      history.replaceState(null, '', location.pathname + location.search + '#' + serializeDashFilters(state));
    } catch (e) { /* history unavailable */ }
    try { localStorage.setItem('bp_dash_filters', JSON.stringify(state)); } catch (e2) { /* private mode */ }
  }

  function initDashV2Flag() {
    var stored = null;
    try { stored = localStorage.getItem('bp_dash_v2'); } catch (e) { stored = null; }
    var f = dashV2FlagFrom(location.search, location.hash, stored);
    _dashV2On = f.on === true;
    if (f.persist !== null) {
      try { localStorage.setItem('bp_dash_v2', f.persist); } catch (e2) { /* private mode */ }
    }
    _dashV2State = readDashFiltersFromEnv();
  }

  // Drops dash=... from the query string and dash/filter keys from the hash.
  function stripDashFromUrl() {
    var params = String(location.search || '').replace(/^\?/, '').split('&');
    var keep = [];
    var i;
    for (i = 0; i < params.length; i++) {
      if (params[i] && params[i].split('=')[0] !== 'dash') keep.push(params[i]);
    }
    var hparts = String(location.hash || '').replace(/^#/, '').split('&');
    var hkeep = [];
    for (i = 0; i < hparts.length; i++) {
      var hk = hparts[i].split('=')[0];
      if (hparts[i] && hk !== 'dash' && DASH_FILTER_KEYS.indexOf(hk) === -1) hkeep.push(hparts[i]);
    }
    var url = location.pathname + (keep.length ? '?' + keep.join('&') : '') + (hkeep.length ? '#' + hkeep.join('&') : '');
    try { history.replaceState(null, '', url); } catch (e) { /* history unavailable */ }
  }

  function destroyDashV2Charts() {
    var keys = Object.keys(_dashV2Charts);
    for (var i = 0; i < keys.length; i++) {
      try { if (_dashV2Charts[keys[i]] && _dashV2Charts[keys[i]].destroy) _dashV2Charts[keys[i]].destroy(); } catch (e) { /* already gone */ }
    }
    _dashV2Charts = {};
  }

  function syncDashSwitch() {
    var btn = document.getElementById('bp-dash-switch');
    if (!btn) return;
    btn.hidden = false;
    btn.textContent = isDashV2() ? 'Back to classic dashboard' : 'Try new dashboard';
  }

  function setDashV2(on) {
    _dashV2On = on === true;
    try { localStorage.setItem('bp_dash_v2', _dashV2On ? '1' : '0'); } catch (e) { /* private mode */ }
    if (!_dashV2On) destroyDashV2Charts();
    stripDashFromUrl();
    if (_dashV2On) {
      _dashV2State = readDashFiltersFromEnv();
      writeDashFiltersToEnv(_dashV2State);
    }
    renderDashboard();
  }

  function dashV2IsPhone() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
  }

  // Review WR-06: Split View / Slide Over or a rotation can cross 600px with no filter tap, so
  // follow the media query. Bound once, on the first v2 render; addListener is older iPad Safari.
  var _dashV2ModeBound = false;
  function onDashV2ModeChange() {
    if (!isDashV2() || !document.getElementById('bp-dash-v2')) return;
    closeDashV2Sheet(false);
    updateDashV2Bar();
  }
  function bindDashV2ModeListener() {
    if (_dashV2ModeBound || !window.matchMedia) return;
    var mq = window.matchMedia('(max-width: 600px)');
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener('change', onDashV2ModeChange);
    else if (mq.addListener) mq.addListener(onDashV2ModeChange);
    else return;
    _dashV2ModeBound = true;
  }

  function dashV2SegHtml(ctl) {
    var h = '<div class="bp-dash-filter"><span class="bp-dash-filter-label">' + ctl.label + '</span>';
    h += '<div class="bp-seg" role="radiogroup" aria-label="' + ctl.label + '">';
    for (var i = 0; i < ctl.opts.length; i++) {
      h += '<button type="button" class="bp-seg-btn" role="radio" aria-checked="false" tabindex="-1" data-dash-ctl="' + ctl.key + '" data-val="' + ctl.opts[i][0] + '">' + ctl.opts[i][1] + '</button>';
    }
    return h + '</div></div>';
  }

  function dashV2RangeHtml() {
    return '<div class="bp-dash-range-fields">' +
      '<label class="bp-dash-filter-label">From<input type="date" class="bp-select" data-dash-from></label>' +
      '<label class="bp-dash-filter-label">To<input type="date" class="bp-select" data-dash-to></label>' +
      '<button type="button" class="bp-btn" data-dash-apply-range disabled>Apply Date Range</button></div>' +
      '<div class="bp-dash-range-error" role="alert" hidden>From must be on or before To.</div>';
  }

  function dashV2ControlsHtml() {
    var h = '';
    for (var i = 0; i < DASH_V2_CONTROLS.length; i++) h += dashV2SegHtml(DASH_V2_CONTROLS[i]);
    h += '<div class="bp-dash-filter"><span class="bp-dash-filter-label">Source</span>';
    h += '<select class="bp-select" data-dash-ctl="source" aria-label="Source">';
    for (var j = 0; j < DASH_V2_SOURCES.length; j++) {
      h += '<option value="' + DASH_V2_SOURCES[j][0] + '">' + DASH_V2_SOURCES[j][1] + '</option>';
    }
    h += '</select></div>';
    h += '<div class="bp-dash-filter"><button type="button" class="bp-seg-btn bp-dash-staff" data-dash-staff aria-pressed="false">Include staff batches</button></div>';
    return h;
  }

  function buildDashV2Bar() {
    var bar = document.getElementById('bp-dash-filters');
    if (!bar) return;
    if (dashV2IsPhone()) {
      bar.setAttribute('data-mode', 'phone');
      bar.innerHTML = '<button type="button" class="bp-seg-btn bp-dash-filters-btn" data-dash-open-sheet aria-haspopup="dialog">Filters <span class="bp-dash-badge" hidden></span></button>' +
        '<span class="bp-dash-summary"></span>' +
        '<button type="button" class="bp-link-btn" data-dash-reset hidden>Reset filters</button>';
    } else {
      bar.setAttribute('data-mode', 'tablet');
      bar.innerHTML = dashV2ControlsHtml() +
        '<button type="button" class="bp-link-btn" data-dash-reset hidden>Reset filters</button>';
    }
  }

  // Marks the selected segments / select / toggle inside root from state.
  function paintDashV2Controls(root, state, rangeOpen) {
    var btns = root.querySelectorAll('.bp-seg-btn[data-dash-ctl]');
    var i;
    for (i = 0; i < btns.length; i++) {
      var key = btns[i].getAttribute('data-dash-ctl');
      var val = btns[i].getAttribute('data-val');
      var cur = (key === 'period' && rangeOpen) ? 'custom' : state[key];
      var on = cur === val;
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
      btns[i].setAttribute('tabindex', on ? '0' : '-1');
      if (key === 'period' && val === 'custom') {
        btns[i].textContent = state.period === 'custom' ? dashPeriodLabel(state) : 'Custom';
      }
    }
    var sel = root.querySelector('select[data-dash-ctl="source"]');
    if (sel) sel.value = state.source;
    var staff = root.querySelector('[data-dash-staff]');
    if (staff) staff.setAttribute('aria-pressed', state.staff === '1' ? 'true' : 'false');
  }

  function updateDashV2Bar() {
    var bar = document.getElementById('bp-dash-filters');
    if (!bar || !_dashV2State) return;
    var phone = dashV2IsPhone();
    if ((bar.getAttribute('data-mode') === 'phone') !== phone || !bar.firstChild) buildDashV2Bar();
    var n = countNonDefaultFilters(_dashV2State);
    if (phone) {
      var badge = bar.querySelector('.bp-dash-badge');
      if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
      var sum = bar.querySelector('.bp-dash-summary');
      if (sum) sum.textContent = dashFilterSummary(_dashV2State);
    } else {
      paintDashV2Controls(bar, _dashV2State, _dashV2RangeOpen);
    }
    var reset = bar.querySelector('[data-dash-reset]');
    if (reset) reset.hidden = n === 0;
    var range = document.getElementById('bp-dash-range');
    if (range) {
      range.hidden = phone || !_dashV2RangeOpen;
      if (!range.hidden && !range.firstChild) {
        range.innerHTML = dashV2RangeHtml();
        validateDashV2Range(range);
      }
    }
  }

  function validateDashV2Range(box) {
    var from = box.querySelector('[data-dash-from]');
    var to = box.querySelector('[data-dash-to]');
    var apply = box.querySelector('[data-dash-apply-range]');
    var err = box.querySelector('.bp-dash-range-error');
    var today = todayPacific();
    from.max = today;
    to.max = today;
    var ok = isRealYmd(from.value) && isRealYmd(to.value) && from.value <= to.value && to.value <= today;
    var bad = !!(from.value && to.value && from.value > to.value);
    apply.disabled = !ok;
    err.hidden = !bad;
    return ok;
  }

  function commitDashV2State(next) {
    _dashV2State = sanitizeDashFilters(next, todayPacific());
    _dashV2RangeOpen = false;
    writeDashFiltersToEnv(_dashV2State);
    refreshDashV2();
  }

  // No data source yet: placeholder tiles and widgets, then one batch-list load (unless the
  // boot eager load is still in flight; it re-renders the dashboard when it lands).
  function showDashV2NoData(afterLoad) {
    _dashV2Model = null;
    _dashV2Seq++;
    updateDashV2Bar();
    var tiles = document.getElementById('bp-dash-v2-tiles');
    var failed = afterLoad === true;   // our own load finished and the list is still not loaded
    if (tiles) {
      tiles.innerHTML = failed ?
        '<p class="bp-empty">Dashboard data could not load. Reopen the Dashboard tab to try again.</p>' :
        '<div class="bp-skeleton-block"></div>';
    }
    var msg = failed ? 'No data loaded.' : 'Loading…';
    dashV2Msg('bp-dash-v2-period', 'period', DASH_V2_PERIOD_TITLE, msg);
    dashV2Msg('bp-dash-v2-wine', 'wine', 'Products', msg);
    if (failed || _eagerLoading || _batchesLoading) return;
    loadBatches().then(function () {
      if (isDashV2() && document.getElementById('bp-dash-v2')) refreshDashV2(true);
    });
  }

  function refreshDashV2(afterLoad) {
    if (!document.getElementById('bp-dash-v2')) return;
    if (!_dashV2State) _dashV2State = readDashFiltersFromEnv();
    // Review WR-03: with neither the aggregate nor the batch list loaded, the numbers would
    // all be zero. Show a placeholder and load the list instead (UI-SPEC: no zero placeholders).
    if (!_dashData && !(_allBatchesData && _allBatchesData.length) && !_batchesLoaded) {
      showDashV2NoData(afterLoad);
      return;
    }
    var todayStrP = todayPacific();
    var rows = _dashData ? _dashData.batches : toDashRows(_allBatchesData);
    var asOf = _dashData ? _dashData.asOf : { today: todayStrP, year: parseInt(todayStrP.slice(0, 4), 10), tz: 'America/Vancouver' };
    var staffIds = {};
    var ids = (_dashData && _dashData.staffBatchIds) || [];
    for (var i = 0; i < ids.length; i++) staffIds[ids[i]] = true;
    _dashV2Model = buildDashV2Model(rows || [], asOf, _dashV2State, staffIds, buildScheduleCategoryById(_fermSchedules));
    updateDashV2Bar();
    applyDashV2SectionVisibility(_dashV2State);
    renderDashV2Widgets();
  }

  // ===========================================================================
  // Phase 95-08: v2 widgets (tiles, Batches per period, Wine breakdown) on the one data layer.
  // ===========================================================================

  function dashV2Fmt(n) { return dashGroupThousands(Math.round(Number(n) || 0)); }

  function dashV2DeltaHtml(d) {
    if (!d) return '';
    return '<div class="bp-delta bp-delta--' + escapeHTML(d.tone) + '" aria-label="' + escapeHTML(d.aria) + '">' + escapeHTML(d.text) + '</div>';
  }

  function renderDashV2Tiles(model) {
    var slot = document.getElementById('bp-dash-v2-tiles');
    if (!slot || !model) return;
    var cur = model.cur;
    var prev = model.prev;
    var lit = model.state.measure === 'litres';
    var period = escapeHTML(model.periodLabel);
    function dOpts(kind) { return { kind: kind, win: model.win, prevWin: model.prevWin, insufficient: model.insufficient }; }
    function countDelta(curN, prevN, kind) { return dashV2DeltaHtml(formatDelta(curN, prev ? prevN : null, dOpts(kind))); }
    function val(count, litres) { return lit ? dashV2Fmt(litres) + ' L' : String(count); }
    var kind = lit ? 'litres' : 'count';
    var html = '<div class="bp-stat-grid">';
    html += '<button type="button" class="bp-stat-card bp-stat-card--link" data-dash-drill="activeNow"><div class="bp-stat-num">' +
      val(cur.activeNow, cur.litres.activeNow) + '</div><div class="bp-stat-label">Fermenting now</div><div class="bp-stat-label">Right now</div></button>';
    html += '<button type="button" class="bp-stat-card bp-stat-card--link" data-dash-drill="started"><div class="bp-stat-num">' +
      val(cur.started, cur.litres.started) + '</div><div class="bp-stat-label">Started (' + period + ')</div>' +
      countDelta(lit ? cur.litres.started : cur.started, prev && (lit ? prev.litres.started : prev.started), kind) + '</button>';
    html += '<button type="button" class="bp-stat-card bp-stat-card--link" data-dash-drill="completed"><div class="bp-stat-num">' +
      val(cur.completed, cur.litres.completed) + '</div><div class="bp-stat-label">Completed (' + period + ')</div>' +
      countDelta(lit ? cur.litres.completed : cur.completed, prev && (lit ? prev.litres.completed : prev.completed), kind) + '</button>';
    var cyc = cur.cycle;
    html += '<button type="button" class="bp-stat-card bp-stat-card--link bp-stat-card--wide" data-dash-drill="cycle">';
    html += '<div class="bp-stat-label">Days to complete (median)</div>';
    if (cyc.n > 0) {
      html += '<div class="bp-stat-row"><div class="bp-stat-num">' + cyc.median + '</div><div class="bp-stat-label">mean ' + cyc.mean + 'd</div></div>';
      html += '<div class="bp-stat-label">Based on ' + cyc.n + ' batch' + (cyc.n !== 1 ? 'es' : '') + '</div>';
    } else {
      html += '<div class="bp-stat-row"><div class="bp-stat-num">—</div></div>';
      html += '<div class="bp-stat-label">No completed batches with a completion date in this period</div>';
    }
    html += dashV2DeltaHtml(formatDelta(cyc.median, prev ? prev.cycle.median : null, dOpts('days')));
    html += '</button></div>';
    slot.innerHTML = html;
  }

  function onDashV2TileClick(btn) {
    var model = _dashV2Model;
    if (!model) return;
    var which = btn.getAttribute('data-dash-drill');
    var cur = model.cur;
    var ids = cur.ids[which];
    if (!ids) return;
    var litres = null;
    if (model.state.measure === 'litres' && which !== 'cycle') litres = cur.litres[which];
    var verbs = { activeNow: 'fermenting', started: 'started', completed: 'completed', cycle: 'cycle' };
    var label = dashDrillLabel({
      typeLabel: model.state.type !== 'all' ? (DASH_TYPE_LABELS[model.state.type] || '') : '',
      verb: verbs[which],
      periodLabel: model.periodLabel,
      count: ids.length,
      litres: litres
    });
    openDashDrill({ ids: ids.slice(), label: label });
  }

  function dashV2Widget(slotId, title) {
    var slot = document.getElementById(slotId);
    if (!slot) return null;
    if (!slot.firstChild) {
      slot.innerHTML = '<div class="bp-widget"><div class="bp-widget-head"><div class="bp-widget-titles">' +
        '<h3 class="bp-widget-title"></h3><p class="bp-widget-sub"></p></div><div class="bp-widget-controls"></div></div>' +
        '<p class="bp-widget-note" hidden></p><div class="bp-widget-body"></div></div>';
      slot.querySelector('.bp-widget-title').textContent = title;
    }
    return slot;
  }

  // Header options (segmented controls / selects / Chart-Table toggle). html is built by dash*Html helpers.
  function dashV2SetControls(slotId, html) {
    var slot = document.getElementById(slotId);
    var c = slot && slot.querySelector('.bp-widget-controls');
    if (c) c.innerHTML = html || '';
  }

  function dashV2SetNote(slotId, text) {
    var slot = document.getElementById(slotId);
    var n = slot && slot.querySelector('.bp-widget-note');
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
  }

  function dashV2Opt(w, opt, dflt) {
    var v = _dashV2WidgetOpts[w + ':' + opt];
    return v === undefined ? dflt : v;
  }

  function dashV2DrillReset(w) { _dashV2Drills[w] = []; }

  // labelOrSubject is a prebuilt banner label when isLabel is true, else a subject for dashDrillSubject.
  function dashV2DrillAdd(w, ids, labelOrSubject, isLabel) {
    if (!_dashV2Drills[w]) _dashV2Drills[w] = [];
    var list = ids ? ids.slice() : [];
    _dashV2Drills[w].push({ ids: list, label: isLabel ? String(labelOrSubject) : dashDrillSubject(labelOrSubject, list.length) });
    return _dashV2Drills[w].length - 1;
  }

  // Widget drills: one batch opens its detail (no banner), 2+ open the Batches tab with the banner.
  function openDashBatch(id) {
    _dashDrill = null;
    switchTab('batches');
    selectBatch(id);
  }

  function dashV2Go(ids, label) {
    if (!ids || !ids.length) return;
    if (ids.length === 1) { openDashBatch(ids[0]); return; }
    openDashDrill({ ids: ids.slice(), label: label });
  }

  function destroyDashV2Slot(key) {
    var c = _dashV2Charts[key];
    if (c && c.destroy) { try { c.destroy(); } catch (e) { /* already gone */ } }
    delete _dashV2Charts[key];
  }

  function dashV2Msg(slotId, key, title, msgHtml) {
    var slot = dashV2Widget(slotId, title);
    if (!slot) return;
    slot.style.display = '';
    destroyDashV2Slot(key);
    var body = slot.querySelector('.bp-widget-body');
    body.setAttribute('data-state', 'msg');
    body.innerHTML = '<p class="bp-empty">' + msgHtml + '</p>';
  }

  function dashV2EmptyHtml() {
    return 'No batches match these filters. <button type="button" class="bp-link-btn" data-dash-reset>Reset filters</button>';
  }

  // Returns the (persistent) canvas for a widget slot, creating the chart scaffold once.
  function dashV2Canvas(slotId, title) {
    var slot = dashV2Widget(slotId, title);
    slot.style.display = '';
    var body = slot.querySelector('.bp-widget-body');
    if (body.getAttribute('data-state') !== 'chart') {
      body.setAttribute('data-state', 'chart');
      body.innerHTML = '<div class="bp-chart"><canvas></canvas></div><div class="bp-chart-legend"></div>';
    }
    return { canvas: body.querySelector('canvas'), legend: body.querySelector('.bp-chart-legend'), slot: slot };
  }

  function dashV2LegendHtml(items) {
    var h = '';
    for (var i = 0; i < items.length; i++) {
      h += '<span class="bp-chart-legend-item"><span class="bp-chart-swatch" style="background:' + escapeHTML(items[i].colour) + '"></span>' + escapeHTML(items[i].label) + '</span>';
    }
    return h;
  }

  function renderDashV2Production(model, chartState) {
    var slotId = 'bp-dash-v2-period';
    if (!model || !document.getElementById(slotId)) return;
    var mode = dashV2Opt('g1', 'mode', 'started') === 'completed' ? 'completed' : 'started';
    var view = dashV2Opt('g1', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var g = buildG1Model(model, mode);
    var slot = dashV2Widget(slotId, DASH_V2_PERIOD_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, dashSegHtml('g1', 'mode', [['started', 'Started'], ['completed', 'Completed']], mode, 'Show batches') +
      dashViewToggleHtml('g1', view));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    if (g.empty) { dashV2Msg(slotId, 'period', DASH_V2_PERIOD_TITLE, dashV2EmptyHtml()); return; }
    if (view === 'table') {
      destroyDashV2Slot('period');
      var body = slot.querySelector('.bp-widget-body');
      body.setAttribute('data-state', 'table');
      var tm = { caption: g.table.caption, columns: g.table.columns, rows: [] };
      for (var r = 0; r < g.table.rows.length; r++) {
        var cells = [];
        for (var c = 0; c < g.table.rows[r].cells.length; c++) {
          var src = g.table.rows[r].cells[c];
          var out = { text: src.text };
          if (src.ids) out.drill = dashV2DrillAdd('g1', src.ids, src.label, true);
          cells.push(out);
        }
        tm.rows.push({ cells: cells });
      }
      body.innerHTML = dashTableHtml('g1', tm);
      return;
    }
    if (dashV2ChartBlocked(slotId, 'period', DASH_V2_PERIOD_TITLE, chartState)) return;
    var el = dashV2Canvas(slotId, DASH_V2_PERIOD_TITLE);
    var legend = [];
    for (var i = 0; i < g.series.length; i++) legend.push({ label: g.series[i].label, colour: g.series[i].colour });
    el.legend.innerHTML = dashV2LegendHtml(legend);
    _dashV2Charts.period = chart(el.canvas, {
      type: 'bar',
      labels: g.labels,
      series: g.series,
      stacked: true,
      measure: g.measure,
      tooltipTotal: true,
      ariaLabel: g.ariaLabel,
      onClick: function (hit) {
        var m = _dashV2Model;
        if (!m) return;
        var cm = dashV2Opt('g1', 'mode', 'started') === 'completed' ? 'completed' : 'started';
        var bk = (cm === 'completed' ? m.cur.completedBuckets : m.cur.periodBuckets)[hit.index];
        if (!bk) return;
        var dr = dashG1Drill(bk, hit.key || null, cm);
        dashV2Go(dr.ids, dr.label);
      }
    });
  }

  // Raw rows, staff map and category map for the pipeline/cycle widgets (same sources as refreshDashV2).
  function dashV2ProdCtx() {
    var staffIds = {};
    var sids = (_dashData && _dashData.staffBatchIds) || [];
    for (var i = 0; i < sids.length; i++) staffIds[sids[i]] = true;
    return {
      rows: (_dashData ? _dashData.batches : toDashRows(_allBatchesData)) || [],
      staffIds: staffIds,
      catMap: buildScheduleCategoryById(_fermSchedules)
    };
  }

  function dashV2ReadyIds() {
    var list = (_dashData && _dashData.summary && _dashData.summary.readyToBottle) ||
      (_dashSummary && _dashSummary.readyToBottle) || [];
    var out = {};
    for (var i = 0; i < list.length; i++) {
      var id = list[i] && typeof list[i] === 'object' ? list[i].batch_id : list[i];
      if (id !== undefined && id !== null) out[id] = true;
    }
    return out;
  }

  // Table cells -> dashTableHtml model, registering one drill per clickable cell.
  function dashV2TableModel(w, t) {
    var tm = { caption: t.caption, columns: t.columns, rows: [] };
    for (var r = 0; r < t.rows.length; r++) {
      var cells = [];
      for (var c = 0; c < t.rows[r].cells.length; c++) {
        var src = t.rows[r].cells[c];
        var out = { text: src.text };
        if (src.ids) out.drill = dashV2DrillAdd(w, src.ids, src.subject, false);
        cells.push(out);
      }
      tm.rows.push({ cells: cells });
    }
    return tm;
  }

  function dashV2ShowTable(slotId, chartKey, w, t) {
    destroyDashV2Slot(chartKey);
    var body = document.getElementById(slotId).querySelector('.bp-widget-body');
    body.setAttribute('data-state', 'table');
    body.innerHTML = dashTableHtml(w, dashV2TableModel(w, t));
  }

  var DASH_V2_PIPELINE_TITLE = 'Pipeline';
  var DASH_V2_CYCLE_TITLE = 'Cycle time';

  function renderDashV2Pipeline(model, chartState) {
    var slotId = 'bp-dash-v2-pipeline';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g2', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var ctx = dashV2ProdCtx();
    var g = buildG2Model(ctx.rows, model, { staffIds: ctx.staffIds, catMap: ctx.catMap, readyIds: dashV2ReadyIds() });
    var slot = dashV2Widget(slotId, DASH_V2_PIPELINE_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, dashViewToggleHtml('g2', view));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, g.note);
    if (g.empty) { dashV2Msg(slotId, 'pipeline', DASH_V2_PIPELINE_TITLE, dashV2EmptyHtml()); return; }
    if (view === 'table') { dashV2ShowTable(slotId, 'pipeline', 'g2', g.table); return; }
    if (dashV2ChartBlocked(slotId, 'pipeline', DASH_V2_PIPELINE_TITLE, chartState)) return;
    var el = dashV2Canvas(slotId, DASH_V2_PIPELINE_TITLE);
    el.canvas.parentNode.style.height = (48 * g.labels.length + 32) + 'px';
    var legend = [];
    var i;
    for (i = 0; i < g.series.length; i++) legend.push({ label: g.series[i].label, colour: g.series[i].colour });
    el.legend.innerHTML = dashV2LegendHtml(legend);
    // Drill ids per cell, registered once so the chart and table share the same sets.
    var cellDrill = [];
    for (i = 0; i < g.stages.length; i++) {
      var row = { all: g.stages[i].ids.length ? dashV2DrillAdd('g2', g.stages[i].ids, g.subjectFor(g.stages[i].key, g.stages[i].label, ''), false) : null };
      for (var s = 0; s < g.series.length; s++) {
        var sids = g.cells[g.stages[i].key][g.series[s].key];
        row[g.series[s].key] = sids.length ? dashV2DrillAdd('g2', sids, g.subjectFor(g.stages[i].key, g.stages[i].label, g.series[s].label), false) : null;
      }
      cellDrill.push(row);
    }
    _dashV2Charts.pipeline = chart(el.canvas, {
      type: 'bar',
      horizontal: true,
      stacked: true,
      labels: g.labels,
      series: g.series,
      measure: 'batches',
      ariaLabel: g.ariaLabel,
      dataLabels: function (e, d) { return d === g.series.length - 1 ? String(g.totals[e]) : null; },
      onClick: function (hit) {
        var row2 = cellDrill[hit.index];
        var di = row2 ? (hit.key ? row2[hit.key] : row2.all) : null;
        var entry = di === null || di === undefined ? null : _dashV2Drills.g2[di];
        if (entry) dashV2Go(entry.ids, entry.label);
      }
    });
  }

  function renderDashV2Cycle(model, chartState) {
    var slotId = 'bp-dash-v2-cycle';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g3', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var ctx = dashV2ProdCtx();
    var meta = {};
    var bm = (_dashData && _dashData.batchMeta) || [];
    for (var m = 0; m < bm.length; m++) { if (bm[m] && bm[m].batch_id !== undefined) meta[bm[m].batch_id] = bm[m]; }
    var g = buildG3Model(ctx.rows, model, {
      staffIds: ctx.staffIds, catMap: ctx.catMap, batchMeta: meta,
      product: dashV2Opt('g3', 'product', 'all'), lookup: _dashWineSkuLookup
    });
    var slot = dashV2Widget(slotId, DASH_V2_CYCLE_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, (g.showProduct ? dashSelectHtml('g3', 'product', g.choices, g.product, 'Product') : '') +
      dashViewToggleHtml('g3', view));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    if (g.empty) {
      dashV2Msg(slotId, 'cycle', DASH_V2_CYCLE_TITLE, 'No completed batches in this period. <button type="button" class="bp-link-btn" data-dash-reset>Reset filters</button>');
      return;
    }
    if (view === 'table') { dashV2ShowTable(slotId, 'cycle', 'g3', g.table); return; }
    if (dashV2ChartBlocked(slotId, 'cycle', DASH_V2_CYCLE_TITLE, chartState)) return;
    var el = dashV2Canvas(slotId, DASH_V2_CYCLE_TITLE);
    el.canvas.parentNode.style.height = '';
    var legend = [];
    var i;
    for (i = 0; i < g.series.length; i++) legend.push({ label: g.series[i].label, colour: g.series[i].colour });
    el.legend.innerHTML = dashV2LegendHtml(legend);
    var cellDrill = [];
    for (i = 0; i < g.labels.length; i++) {
      var row = { all: null };
      var all = [];
      for (var s = 0; s < g.series.length; s++) {
        var sids = g.binIds[i][g.series[s].key];
        all = all.concat(sids);
        row[g.series[s].key] = sids.length ? dashV2DrillAdd('g3', sids, g.subjectFor(g.labels[i], g.series[s].label), false) : null;
      }
      if (all.length) row.all = dashV2DrillAdd('g3', all, g.subjectFor(g.labels[i], ''), false);
      cellDrill.push(row);
    }
    _dashV2Charts.cycle = chart(el.canvas, {
      type: 'bar',
      labels: g.labels,
      series: g.series,
      stacked: true,
      measure: 'batches',
      vLines: g.vLines,
      xTitle: 'Days from start to complete',
      yTitle: 'Batches',
      ariaLabel: g.ariaLabel,
      onClick: function (hit) {
        var row2 = cellDrill[hit.index];
        var di = row2 ? (hit.key ? row2[hit.key] : row2.all) : null;
        var entry = di === null || di === undefined ? null : _dashV2Drills.g3[di];
        if (entry) dashV2Go(entry.ids, entry.label);
      }
    });
  }

  var DASH_V2_PRODUCTS_TITLE = 'Products';
  var DASH_V2_SOURCE_TITLE = 'Source mix';

  function dashV2G4Height(n) { return Math.min(440, 32 * Math.max(1, n) + 40) + 'px'; }

  // G4 Products: breakdown (left/top) plus Top 10 (right/below) inside one widget.
  function renderDashV2Products(model, chartState) {
    var slotId = 'bp-dash-v2-wine';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g4', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var tview = dashV2Opt('g4', 'tview', 'chart') === 'table' ? 'table' : 'chart';
    var ctx = dashV2ProdCtx();
    var metaById = dashMetaById(_dashData && _dashData.batchMeta);
    var g = buildG4Model(ctx.rows, model, {
      lookup: _dashWineSkuLookup, metaById: metaById, staffIds: ctx.staffIds, catMap: ctx.catMap,
      type: dashV2Opt('g4', 'type', null), dim: dashV2Opt('g4', 'dim', null)
    });
    var slot = dashV2Widget(slotId, DASH_V2_PRODUCTS_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, (g.showTypeSeg ? dashSegHtml('g4', 'type', g.typeChoices, g.type, 'Product type') : '') +
      (g.dims.length ? '<span class="bp-ctl-group"><span class="bp-ctl-label" aria-hidden="true">Group by</span>' +
        dashSelectHtml('g4', 'dim', g.dims, g.dim, 'Dimension') + '</span>' : ''));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, '');
    destroyDashV2Slot('top10');
    if (g.empty) { dashV2Msg(slotId, 'wine', DASH_V2_PRODUCTS_TITLE, dashV2EmptyHtml()); return; }
    if (g.type === 'wine') {
      if (_dashWineSkuError) { dashV2Msg(slotId, 'wine', DASH_V2_PRODUCTS_TITLE, 'Unable to load catalog data — wine breakdown unavailable.'); return; }
      if (_dashWineSkuLookup === null) {
        loadWineSnapshot();
        dashV2Msg(slotId, 'wine', DASH_V2_PRODUCTS_TITLE, 'Loading…');
        return;
      }
    }
    if ((view === 'chart' || tview === 'chart') && dashV2ChartBlocked(slotId, 'wine', DASH_V2_PRODUCTS_TITLE, chartState)) return;
    var t = buildTop10Model(ctx.rows, model, { metaById: metaById, staffIds: ctx.staffIds, catMap: ctx.catMap });
    destroyDashV2Slot('wine');
    var body = slot.querySelector('.bp-widget-body');
    body.setAttribute('data-state', 'g4');
    var main = view === 'table' ?
      dashTableHtml('g4', dashV2TableModel('g4', g.table)) :
      '<div class="bp-chart"><canvas></canvas></div>';
    var top;
    if (t.empty) {
      top = '<p class="bp-empty">' + dashV2EmptyHtml() + '</p>';
    } else if (tview === 'table') {
      top = dashTableHtml('g4', dashV2TableModel('g4', t.table));
    } else {
      top = '<div class="bp-chart"><canvas></canvas></div><div class="bp-chart-legend"></div>';
    }
    // Each column has its own heading and view toggle, so the two toggles never stack in the header.
    var mainHead = '<div class="bp-g4-tophead"><h4 class="bp-g4-heading">By ' + escapeHTML(String(g.dimLabel || '').toLowerCase()) + '</h4>' +
      dashViewToggleHtml('g4', view) + '</div>';
    body.innerHTML = '<div class="bp-g4"><div class="bp-g4-main">' + mainHead + main + '</div>' +
      '<div class="bp-g4-top"><div class="bp-g4-tophead"><h4 class="bp-g4-subtitle">Top 10 products</h4>' +
      dashSegHtml('g4', 'tview', [['chart', 'Chart'], ['table', 'Table']], tview, 'Top 10 view as') + '</div>' + top + '</div></div>';
    var canvases = body.querySelectorAll('canvas');
    var ci = 0;
    if (view === 'chart') {
      var mc = canvases[ci++];
      mc.parentNode.style.height = dashV2G4Height(g.labels.length);
      _dashV2Charts.wine = chart(mc, {
        type: 'bar',
        horizontal: true,
        labelMaxChars: 24,
        labels: g.labels,
        series: g.series,
        measure: g.measure,
        ariaLabel: g.ariaLabel,
        onClick: function (hit) {
          var bk = g.buckets[hit.index];
          if (bk) dashV2Go(bk.ids, dashDrillSubject(g.subjectFor(bk.label), bk.ids.length));
        }
      });
    }
    if (!t.empty && tview === 'chart') {
      var tc = canvases[ci++];
      tc.parentNode.style.height = dashV2G4Height(t.labels.length);
      var legend = [];
      for (var i = 0; i < t.series.length; i++) legend.push({ label: t.series[i].label, colour: t.series[i].colour });
      tc.parentNode.nextSibling.innerHTML = dashV2LegendHtml(legend);
      _dashV2Charts.top10 = chart(tc, {
        type: 'bar',
        horizontal: true,
        labelMaxChars: 24,
        stacked: true,
        labels: t.labels,
        series: t.series,
        measure: t.measure,
        ariaLabel: t.ariaLabel,
        onClick: function (hit) {
          var en = t.entries[hit.index];
          if (en) dashV2Go(en.ids, dashDrillSubject('Top product ' + en.label, en.ids.length));
        }
      });
    }
  }

  // G9 Source mix: stacked column over time, Count | Share.
  function renderDashV2Source(model, chartState) {
    var slotId = 'bp-dash-v2-source';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g9', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var mode = dashV2Opt('g9', 'mode', 'count') === 'share' ? 'share' : 'count';
    var ctx = dashV2ProdCtx();
    var g = buildG9Model(ctx.rows, model, { mode: mode, staffIds: ctx.staffIds, catMap: ctx.catMap });
    var slot = dashV2Widget(slotId, DASH_V2_SOURCE_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, dashSegHtml('g9', 'mode', [['count', 'Count'], ['share', 'Share']], mode, 'Show as') +
      dashViewToggleHtml('g9', view));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, g.note);
    if (g.empty) { dashV2Msg(slotId, 'source', DASH_V2_SOURCE_TITLE, dashV2EmptyHtml()); return; }
    if (view === 'table') { dashV2ShowTable(slotId, 'source', 'g9', g.table); return; }
    if (dashV2ChartBlocked(slotId, 'source', DASH_V2_SOURCE_TITLE, chartState)) return;
    var el = dashV2Canvas(slotId, DASH_V2_SOURCE_TITLE);
    el.canvas.parentNode.style.height = '';
    var legend = [];
    var i;
    for (i = 0; i < g.series.length; i++) legend.push({ label: g.series[i].label, colour: g.series[i].colour });
    el.legend.innerHTML = dashV2LegendHtml(legend);
    function catIndex(key) {
      for (var q = 0; q < DASH_SOURCE_CATS.length; q++) { if (DASH_SOURCE_CATS[q][0] === key) return q; }
      return -1;
    }
    _dashV2Charts.source = chart(el.canvas, {
      type: 'bar',
      labels: g.labels,
      series: g.series,
      stacked: true,
      percent: g.percent,
      measure: g.percent ? 'batches' : g.measure,
      tooltipTotal: !g.percent,
      tooltipLabel: g.percent ? function (item) {
        var di = item.datasetIndex;
        var raw = g.counts[di] ? g.counts[di][item.dataIndex] : 0;
        var cnt = g.measure === 'litres' ? dashLitresText(raw) : raw + (raw === 1 ? ' batch' : ' batches');
        return item.dataset.label + ': ' + item.parsed.y + '% (' + cnt + ')';
      } : undefined,
      ariaLabel: g.ariaLabel,
      onClick: function (hit) {
        var bi = hit.index;
        if (!g.cells[bi]) return;
        var ids;
        var label = g.labels[bi];
        var subject;
        if (hit.key) {
          var ci = catIndex(hit.key);
          if (ci < 0) return;
          ids = g.cells[bi][ci];
          subject = g.subjectFor(DASH_SOURCE_CATS[ci][1], label);
        } else {
          ids = [];
          for (var q = 0; q < g.cells[bi].length; q++) ids = ids.concat(g.cells[bi][q]);
          subject = g.subjectFor('', label);
        }
        dashV2Go(ids, dashDrillSubject(subject, ids.length));
      }
    });
  }

  var DASH_V2_WORKLOAD_TITLE = 'Workload';
  var DASH_V2_TASKS_TITLE = 'Task health';

  // Quiet note under a widget body (Workload overdue count). The chart canvas is reused across
  // re-renders, so drop the previous note first or a copy piles up on every render.
  function dashV2FootNote(slotId, text) {
    var slot = document.getElementById(slotId);
    var body = slot && slot.querySelector('.bp-widget-body');
    if (!body) return;
    var old = body.querySelectorAll(':scope > .bp-dash-foot-note');
    for (var i = 0; i < old.length; i++) body.removeChild(old[i]);
    if (!text) return;
    var p = document.createElement('p');
    p.className = 'bp-dash-foot-note';
    p.textContent = text;
    body.appendChild(p);
  }

  // G5 Workload: open tasks due per day, stacked by task kind.
  function renderDashV2Workload(model, chartState) {
    var slotId = 'bp-dash-v2-workload';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g5', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var horizon = String(dashV2Opt('g5', 'horizon', '14')) === '30' ? '30' : '14';
    var ctx = dashV2ProdCtx();
    var g = buildG5Model(ctx.rows, _dashData.taskRows, model, { horizon: horizon, staffIds: ctx.staffIds, catMap: ctx.catMap });
    var slot = dashV2Widget(slotId, DASH_V2_WORKLOAD_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, dashSegHtml('g5', 'horizon', [['14', '14 days'], ['30', '30 days']], horizon, 'Days ahead') +
      dashViewToggleHtml('g5', view));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, '');
    if (g.empty) {
      dashV2Msg(slotId, 'workload', DASH_V2_WORKLOAD_TITLE, escapeHTML(g.emptyText));
      dashV2FootNote(slotId, g.note);
      return;
    }
    if (view === 'table') {
      dashV2ShowTable(slotId, 'workload', 'g5', g.table);
      dashV2FootNote(slotId, g.note);
      return;
    }
    if (dashV2ChartBlocked(slotId, 'workload', DASH_V2_WORKLOAD_TITLE, chartState)) return;
    var el = dashV2Canvas(slotId, DASH_V2_WORKLOAD_TITLE);
    el.canvas.parentNode.style.height = '';
    var legend = [];
    var i;
    for (i = 0; i < g.series.length; i++) legend.push({ label: g.series[i].label, colour: g.series[i].colour });
    el.legend.innerHTML = dashV2LegendHtml(legend);
    dashV2FootNote(slotId, g.note);
    _dashV2Charts.workload = chart(el.canvas, {
      type: 'bar',
      stacked: true,
      labels: g.labels,
      series: g.series,
      unit: 'tasks',
      boldTick: 0,
      hitDatasetIndex: true,
      ariaLabel: g.ariaLabel,
      tooltipFooter: function (items) {
        var first = items && items[0];
        return first ? g.footer(first.dataIndex) : '';
      },
      onClick: function (hit) {
        var bi = hit.index;
        if (!g.ids[bi]) return;
        var ids;
        var subject;
        var ki = -1;
        if (hit.key) {
          for (var q = 0; q < g.series.length; q++) { if (g.series[q].key === hit.key) ki = q; }
        }
        if (ki >= 0) {
          ids = g.ids[bi][ki];
          subject = g.subjectFor(hit.key, g.days[bi]);
        } else {
          ids = g.dayIds[bi];
          subject = g.subjectFor('', g.days[bi]);
        }
        dashV2Go(ids, dashDrillSubject(subject, ids.length));
      }
    });
  }

  // G7 Task health: overdue ageing of open tasks plus tasks ticked off over time.
  function renderDashV2Tasks(model, chartState) {
    var slotId = 'bp-dash-v2-tasks';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g7', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var kindOpt = String(dashV2Opt('g7', 'kind', 'all'));
    var ctx = dashV2ProdCtx();
    var g = buildG7Model(ctx.rows, _dashData.taskRows, model, { kind: kindOpt, staffIds: ctx.staffIds, catMap: ctx.catMap });
    var slot = dashV2Widget(slotId, DASH_V2_TASKS_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, dashSelectHtml('g7', 'kind', g.choices, g.kind, 'Task kind') + dashViewToggleHtml('g7', view));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, g.note);
    destroyDashV2Slot('ageing');
    destroyDashV2Slot('completions');
    if (view === 'chart' && dashV2ChartBlocked(slotId, 'ageing', DASH_V2_TASKS_TITLE, chartState)) return;
    var body = slot.querySelector('.bp-widget-body');
    body.setAttribute('data-state', 'g7');
    var ageBlock;
    var compBlock;
    if (g.ageing.empty) {
      ageBlock = '<p class="bp-empty">' + escapeHTML(g.ageing.emptyText) + '</p>';
    } else if (view === 'table') {
      ageBlock = dashTableHtml('g7', dashV2TableModel('g7', g.ageing.table));
    } else {
      ageBlock = '<div class="bp-chart"><canvas></canvas></div>';
    }
    if (g.completions.empty) {
      compBlock = '<p class="bp-empty">' + escapeHTML(g.completions.emptyText) + '</p>';
    } else if (view === 'table') {
      compBlock = dashTableHtml('g7', dashV2TableModel('g7', g.completions.table));
    } else {
      compBlock = '<div class="bp-chart"><canvas></canvas></div>';
    }
    body.innerHTML = '<div class="bp-g7"><div class="bp-g7-block"><h4 class="bp-g4-subtitle">Open tasks past due date</h4>' + ageBlock + '</div>' +
      '<div class="bp-g7-block"><h4 class="bp-g4-subtitle">Tasks ticked off</h4>' + compBlock + '</div></div>';
    if (view !== 'chart') return;
    var cvs = body.querySelectorAll('canvas');
    var ci = 0;
    if (!g.ageing.empty) {
      var ac = cvs[ci++];
      ac.parentNode.style.height = '120px';
      _dashV2Charts.ageing = chart(ac, {
        type: 'bar',
        horizontal: true,
        labels: g.ageing.labels,
        series: [{ key: 'ageing', label: 'Open tasks', data: g.ageing.counts, colour: g.ageing.colours }],
        unit: 'tasks',
        dataLabels: function (e) { return String(g.ageing.counts[e]); },
        ariaLabel: g.ageing.ariaLabel,
        onClick: function (hit) {
          var ids = g.ageing.ids[hit.index];
          if (ids && ids.length) dashV2Go(ids, dashDrillSubject(g.ageing.subjectFor(hit.index), ids.length));
        }
      });
    }
    if (!g.completions.empty) {
      var cc = cvs[ci++];
      cc.parentNode.style.height = '';
      _dashV2Charts.completions = chart(cc, {
        type: 'bar',
        labels: g.completions.labels,
        series: [{ key: 'completed', label: 'Tasks completed', data: g.completions.data, colour: g.completions.colour }],
        unit: 'tasks',
        ariaLabel: g.completions.ariaLabel,
        onClick: function (hit) {
          var ids2 = g.completions.cells[hit.index];
          if (ids2 && ids2.length) dashV2Go(ids2, dashDrillSubject(g.completions.subjectFor(g.completions.labels[hit.index]), ids2.length));
        }
      });
    }
  }

  var DASH_V2_VESSELS_TITLE = 'Vessels';
  var DASH_V2_FERMENT_TITLE = 'Fermentation';

  // Chart region that degrades to a message while Chart.js is loading or failed; lists below still render.
  function dashV2ChartRegion(chartState) {
    if (window.Chart) return '<div class="bp-chart"><canvas></canvas></div>';
    return '<p class="bp-empty">' + (chartState === 'failed' ? DASH_V2_FAILED : DASH_V2_LOADING) + '</p>';
  }

  // Register one drill per list item and return dashListHtml items.
  function dashV2ListItems(w, items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      out.push({
        primary: items[i].primary,
        secondary: items[i].secondary,
        right: items[i].right,
        drill: dashV2DrillAdd(w, items[i].ids, items[i].subject, false)
      });
    }
    return out;
  }

  function dashV2ListBlock(w, listKey, title, items, emptyText, note) {
    return '<div class="bp-g6-list bp-g8-list"><h4 class="bp-g4-subtitle">' + escapeHTML(title) + ' (' + items.length + ')</h4>' +
      (note ? '<p class="bp-dash-foot-note">' + escapeHTML(note) + '</p>' : '') +
      dashListHtml(w, listKey, dashV2ListItems(w, items), { limit: 5, expanded: !!_dashV2Expanded[w + ':' + listKey], emptyText: emptyText }) + '</div>';
  }

  // G6 Vessels: capacity in use per stored vessel type, plus neutral Shared vessels / No vessel lists.
  function renderDashV2Vessels(model, chartState) {
    var slotId = 'bp-dash-v2-vessels';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g6', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var mode = dashV2Opt('g6', 'mode', 'vessels') === 'litres' ? 'litres' : 'vessels';
    var ctx = dashV2ProdCtx();
    var g = buildG6Model(ctx.rows, _dashData.vessels, { mode: mode, staffIds: ctx.staffIds, catMap: ctx.catMap });
    var slot = dashV2Widget(slotId, DASH_V2_VESSELS_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, dashSegHtml('g6', 'mode', [['vessels', 'Vessels'], ['litres', 'Litres']], mode, 'Show as') +
      dashViewToggleHtml('g6', view));
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, g.note);
    destroyDashV2Slot('vessels');
    var body = slot.querySelector('.bp-widget-body');
    body.setAttribute('data-state', 'g6');
    var top;
    if (g.empty) top = '<p class="bp-empty">' + escapeHTML(g.emptyText) + '</p>';
    else if (view === 'table') top = dashTableHtml('g6', dashV2TableModel('g6', g.table));
    else top = dashV2ChartRegion(chartState);
    body.innerHTML = '<div class="bp-g6"><div class="bp-g6-chart">' + top + '</div>' +
      dashV2ListBlock('g6', 'shared', 'Shared vessels', g.shared, 'No vessels are shared right now.', g.sharedNote) +
      dashV2ListBlock('g6', 'novessel', 'No vessel', g.noVessel, 'Every active batch has a vessel.', '') + '</div>';
    var canvas = body.querySelector('canvas');
    if (g.empty || view !== 'chart' || !canvas) return;
    canvas.parentNode.style.height = (48 * g.labels.length + 32) + 'px';
    _dashV2Charts.vessels = chart(canvas, {
      type: 'bar',
      horizontal: true,
      stacked: true,
      labels: g.labels,
      series: g.series,
      unit: g.mode === 'litres' ? undefined : 'vessels',
      measure: g.mode === 'litres' ? 'litres' : undefined,
      inertKeys: ['available'],
      dataLabels: function (e, di) { return di === 1 ? g.label(e) : ''; },
      ariaLabel: g.ariaLabel,
      onClick: function (hit) {
        var t = g.types[hit.index];
        if (t && t.ids.length) dashV2Go(t.ids, dashDrillSubject(t.subject, t.ids.length));
      }
    });
  }

  function dashV2StatsHtml(stats) {
    var h = '<dl class="bp-stat-row">';
    for (var i = 0; i < stats.length; i++) {
      h += '<div><dt>' + escapeHTML(stats[i][0]) + '</dt><dd>' + escapeHTML(stats[i][1]) + '</dd></div>';
    }
    return h + '</dl>';
  }

  // G8 Fermentation: Plato readings by day since start, plus a neutral "No readings yet" list.
  function renderDashV2Ferment(model, chartState) {
    var slotId = 'bp-dash-v2-ferment';
    if (!model || !document.getElementById(slotId)) return;
    var view = dashV2Opt('g8', 'view', 'chart') === 'table' ? 'table' : 'chart';
    var ctx = dashV2ProdCtx();
    var metaById = {};
    var bm = _dashData.batchMeta || [];
    for (var i = 0; i < bm.length; i++) { if (bm[i]) metaById[bm[i].batch_id] = bm[i]; }
    var g = buildG8Model(ctx.rows, _dashData.readings, metaById, model, {
      batch: String(dashV2Opt('g8', 'batch', 'all')), staffIds: ctx.staffIds, catMap: ctx.catMap
    });
    var slot = dashV2Widget(slotId, DASH_V2_FERMENT_TITLE);
    slot.style.display = '';
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, '');
    destroyDashV2Slot('ferment');
    var body = slot.querySelector('.bp-widget-body');
    body.setAttribute('data-state', 'g8');
    if (g.state === 'wrongType') {
      dashV2SetControls(slotId, '');
      body.innerHTML = '<p class="bp-empty">' + escapeHTML(g.stateText) + '</p>';
      return;
    }
    var list = dashV2ListBlock('g8', 'noreadings', 'No readings yet', g.noReadings, g.noReadingsEmpty, '');
    if (g.state === 'noReadings') {
      dashV2SetControls(slotId, '');
      body.innerHTML = '<div class="bp-g8"><p class="bp-empty">' + escapeHTML(g.stateText) + '</p>' + list + '</div>';
      return;
    }
    dashV2SetControls(slotId, dashSelectHtml('g8', 'batch', g.choices, g.batch, 'Batch') + dashViewToggleHtml('g8', view));
    var top = view === 'table' ? dashTableHtml('g8', dashV2TableModel('g8', g.table)) : dashV2ChartRegion(chartState);
    var legend = view === 'chart' && window.Chart ? '<div class="bp-chart-legend"></div>' : '';
    body.innerHTML = '<div class="bp-g8"><div class="bp-g8-chart">' + top + legend +
      (g.note ? '<p class="bp-dash-foot-note">' + escapeHTML(g.note) + '</p>' : '') +
      (g.stats ? dashV2StatsHtml(g.stats) : '') + '</div>' + list + '</div>';
    var canvas = body.querySelector('canvas');
    if (view !== 'chart' || !canvas) return;
    canvas.parentNode.style.height = (dashV2IsPhone() ? 220 : 280) + 'px';
    var items = g.legend.slice();
    for (var s = 0; s < g.series.length; s++) {
      if (g.series[s].key === 'expected') items.push({ label: 'Expected (dashed)', colour: g.series[s].colour });
    }
    body.querySelector('.bp-chart-legend').innerHTML = dashV2LegendHtml(items);
    _dashV2Charts.ferment = chart(canvas, {
      type: 'line',
      xType: 'linear',
      xMin: 0,
      xTitle: 'Days since start',
      yTitle: '°P',
      labels: undefined,
      series: g.series,
      unit: 'plato',
      inertKeys: ['expected'],
      hitDatasetIndex: true,
      ariaLabel: g.ariaLabel,
      onClick: function (hit) {
        var ser = g.series[hit.datasetIndex];
        if (ser && ser.batchId) dashV2Go([ser.batchId], '');
      }
    });
  }

  var DASH_V2_LOADING = 'Loading charts…';
  var DASH_V2_FAILED = 'Charts could not load. Reload the page to try again.';
  var DASH_V2_PERIOD_TITLE = 'Production over time';

  // Returns true (after showing the loading/failure copy) when a chart body cannot render yet.
  function dashV2ChartBlocked(slotId, chartKey, title, chartState) {
    if (window.Chart) return false;
    dashV2Msg(slotId, chartKey, title, chartState === 'failed' ? DASH_V2_FAILED : DASH_V2_LOADING);
    return true;
  }

  // G10 Data health: five neutral accordion categories; counts only, no chart, no red/amber.
  var DASH_V2_HEALTH_TITLE = 'Data health';

  function renderDashV2Health(model) {
    var slotId = 'bp-dash-v2-health';
    if (!model || !document.getElementById(slotId)) return;
    var ctx = dashV2ProdCtx();
    var metaById = {};
    var bm = (_dashData && _dashData.batchMeta) || [];
    for (var m = 0; m < bm.length; m++) { if (bm[m]) metaById[bm[m].batch_id] = bm[m]; }
    var g = buildG10Model(ctx.rows, metaById, { today: model.cur.asOf.today, staffIds: ctx.staffIds, catMap: ctx.catMap });
    var slot = dashV2Widget(slotId, DASH_V2_HEALTH_TITLE);
    slot.style.display = '';
    dashV2SetControls(slotId, '');
    slot.querySelector('.bp-widget-sub').textContent = g.subtitle;
    dashV2SetNote(slotId, g.note);
    destroyDashV2Slot('health');
    var body = slot.querySelector('.bp-widget-body');
    body.setAttribute('data-state', 'g10');
    var h = '<div class="bp-g10">';
    if (g.allZero) h += '<p class="bp-empty">' + escapeHTML(g.emptyText) + '</p>';
    for (var i = 0; i < g.cats.length; i++) {
      var cat = g.cats[i];
      if (cat.count === 0) {
        h += '<div class="bp-health-cat"><div class="bp-health-row"><span>' + escapeHTML(cat.label) + '</span><span class="bp-health-zero">0 ✓</span></div></div>';
        continue;
      }
      var open = !!_dashV2Expanded['acc:g10:' + cat.key];
      h += '<div class="bp-health-cat"><button type="button" class="bp-accordion-head" aria-expanded="' + (open ? 'true' : 'false') +
        '" data-dash-acc="g10:' + cat.key + '"><span>' + escapeHTML(cat.label) + '</span><span class="bp-health-count"><b>' + cat.count + '</b></span></button>';
      if (open) {
        var openIds = [];
        for (var k = 0; k < cat.items.length; k++) openIds.push(cat.items[k].ids[0]);
        var openIdx = dashV2DrillAdd('g10', openIds, cat.label, false);
        h += dashListHtml('g10', 'all' + cat.key, dashV2ListItems('g10', cat.items), { limit: 5, expanded: !!_dashV2Expanded['g10:all' + cat.key], emptyText: '' }) +
          '<button type="button" class="bp-text-btn" data-dash-row="g10:' + openIdx + '">Open these batches</button>';
      }
      h += '</div>';
    }
    body.innerHTML = h + '</div>';
  }

  function onDashV2Accordion(el) {
    var attr = el.getAttribute('data-dash-acc') || '';
    var p = attr.split(':');
    if (p.length !== 2 || p[0] !== 'g10') return;
    var ok = false;
    for (var i = 0; i < DASH_HEALTH_CATS.length; i++) { if (DASH_HEALTH_CATS[i].key === p[1]) ok = true; }
    if (!ok) return;
    _dashV2Expanded['acc:' + attr] = !_dashV2Expanded['acc:' + attr];
    rerenderDashV2Widget('g10');
    var again = document.querySelector('[data-dash-acc="' + attr + '"]');
    if (again) again.focus();
  }

  // Registry: later plans add {key, slot, title, chart, needs, render(model, chartState)}.
  var DASH_V2_WIDGETS = [
    {
      key: 'g1', slot: 'bp-dash-v2-period', title: DASH_V2_PERIOD_TITLE, chart: 'period', needs: [],
      render: function (model, cs) {
        renderDashV2Production(model, cs);
      }
    },
    {
      key: 'g2', slot: 'bp-dash-v2-pipeline', title: DASH_V2_PIPELINE_TITLE, chart: 'pipeline', needs: [],
      render: function (model, cs) { renderDashV2Pipeline(model, cs); }
    },
    {
      key: 'g3', slot: 'bp-dash-v2-cycle', title: DASH_V2_CYCLE_TITLE, chart: 'cycle', needs: [],
      render: function (model, cs) { renderDashV2Cycle(model, cs); }
    },
    {
      key: 'g4', slot: 'bp-dash-v2-wine', title: DASH_V2_PRODUCTS_TITLE, chart: 'wine', needs: [],
      render: function (model, cs) { renderDashV2Products(model, cs); }
    },
    {
      key: 'g9', slot: 'bp-dash-v2-source', title: DASH_V2_SOURCE_TITLE, chart: 'source', needs: [],
      render: function (model, cs) { renderDashV2Source(model, cs); }
    },
    {
      key: 'g5', slot: 'bp-dash-v2-workload', title: DASH_V2_WORKLOAD_TITLE, chart: 'workload', needs: ['taskRows'],
      render: function (model, cs) { renderDashV2Workload(model, cs); }
    },
    {
      key: 'g7', slot: 'bp-dash-v2-tasks', title: DASH_V2_TASKS_TITLE, chart: 'ageing', needs: ['taskRows'],
      render: function (model, cs) { renderDashV2Tasks(model, cs); }
    },
    {
      key: 'g6', slot: 'bp-dash-v2-vessels', title: DASH_V2_VESSELS_TITLE, chart: 'vessels', needs: ['vessels'],
      render: function (model, cs) { renderDashV2Vessels(model, cs); }
    },
    {
      key: 'g8', slot: 'bp-dash-v2-ferment', title: DASH_V2_FERMENT_TITLE, chart: 'ferment', needs: ['readings'],
      render: function (model, cs) { renderDashV2Ferment(model, cs); }
    },
    {
      key: 'g10', slot: 'bp-dash-v2-health', title: DASH_V2_HEALTH_TITLE, chart: 'health', needs: ['batchMeta'],
      render: function (model) { renderDashV2Health(model); }
    }
  ];

  function dashV2WidgetMissing(def) {
    var needs = def.needs || [];
    for (var i = 0; i < needs.length; i++) {
      if (!_dashData || !Array.isArray(_dashData[needs[i]])) return true;
    }
    return false;
  }

  // One widget, isolated: a throw or missing server array only affects that widget.
  function runDashV2Widget(def, model, chartState) {
    if (!document.getElementById(def.slot)) return;
    dashV2DrillReset(def.key);
    try {
      if (dashV2WidgetMissing(def)) {
        dashV2Msg(def.slot, def.chart || def.key, def.title, 'Not available yet. Reopen the Dashboard tab to refresh.');
        return;
      }
      def.render(model, chartState);
    } catch (e) {
      dashV2Msg(def.slot, def.chart || def.key, def.title, DASH_V2_FAILED);
    }
  }

  function renderDashV2AllWidgets(model, chartState) {
    for (var i = 0; i < DASH_V2_WIDGETS.length; i++) runDashV2Widget(DASH_V2_WIDGETS[i], model, chartState);
  }

  function rerenderDashV2Widget(w) {
    var model = _dashV2Model;
    if (!model) return;
    for (var i = 0; i < DASH_V2_WIDGETS.length; i++) {
      if (DASH_V2_WIDGETS[i].key === w) { runDashV2Widget(DASH_V2_WIDGETS[i], model, window.Chart ? 'ready' : _dashV2ChartState); return; }
    }
  }

  function renderDashV2Widgets() {
    var model = _dashV2Model;
    if (!model) return;
    renderDashV2Tiles(model);
    var seq = ++_dashV2Seq;
    if (window.Chart) {
      _dashV2ChartState = 'ready';
      renderDashV2AllWidgets(model, 'ready');
      return;
    }
    _dashV2ChartState = 'pending';
    renderDashV2AllWidgets(model, 'pending');
    loadChartJs().then(function () {
      if (seq !== _dashV2Seq || !isDashV2()) return;
      _dashV2ChartState = 'ready';
      renderDashV2AllWidgets(_dashV2Model, 'ready');
    }, function () {
      if (seq !== _dashV2Seq || !isDashV2()) return;
      _dashV2ChartState = 'failed';
      renderDashV2AllWidgets(_dashV2Model, 'failed');
    });
  }

  function resizeDashV2Charts() {
    var keys = Object.keys(_dashV2Charts);
    for (var i = 0; i < keys.length; i++) {
      var c = _dashV2Charts[keys[i]];
      if (c && c.resize) { try { c.resize(); } catch (e) { /* chart gone */ } }
    }
  }

  function closeDashV2Sheet(restoreFocus) {
    var sheet = document.getElementById('bp-dash-sheet');
    if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
    _dashV2Stage = null;
    if (restoreFocus) {
      var b = document.querySelector('[data-dash-open-sheet]');
      if (b) b.focus();
    }
  }

  function openDashV2Sheet() {
    var shell = document.getElementById('bp-dash-v2');
    if (!shell || document.getElementById('bp-dash-sheet')) return;
    _dashV2Stage = sanitizeDashFilters(_dashV2State, todayPacific());
    var sheet = document.createElement('div');
    sheet.id = 'bp-dash-sheet';
    sheet.className = 'bp-dash-sheet';
    sheet.innerHTML = '<div class="bp-dash-sheet-backdrop" data-dash-close></div>' +
      '<div class="bp-dash-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="bp-dash-sheet-title" tabindex="-1">' +
      '<div class="bp-dash-sheet-head"><h2 id="bp-dash-sheet-title" class="bp-dash-sheet-title">Filters</h2>' +
      '<button type="button" class="bp-link-btn bp-dash-sheet-x" data-dash-close aria-label="Close filters">&#10005;</button></div>' +
      '<div class="bp-dash-sheet-body">' + dashV2ControlsHtml() + '<div class="bp-dash-sheet-range" hidden>' + dashV2RangeHtml() + '</div></div>' +
      '<div class="bp-dash-sheet-foot"><button type="button" class="bp-btn" data-dash-apply-sheet>Apply Filters</button>' +
      '<button type="button" class="bp-link-btn" data-dash-sheet-reset>Reset</button></div></div>';
    shell.appendChild(sheet);
    paintDashV2Controls(sheet, _dashV2Stage, false);
    var rangeBox = sheet.querySelector('.bp-dash-sheet-range');
    validateDashV2Range(rangeBox);
    var panel = sheet.querySelector('.bp-dash-sheet-panel');
    var first = panel.querySelector('[aria-checked="true"]') || panel;
    first.focus();
  }

  function dashV2StageSet(key, val) {
    var next = {};
    var k;
    for (k in _dashV2Stage) { if (Object.prototype.hasOwnProperty.call(_dashV2Stage, k)) next[k] = _dashV2Stage[k]; }
    next[key] = val;
    _dashV2Stage = next;
  }

  function onDashV2Click(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var sheet = document.getElementById('bp-dash-sheet');
    var inSheet = !!(sheet && sheet.contains(t));
    var el;
    if ((el = t.closest('[data-dash-close]'))) { closeDashV2Sheet(true); return; }
    if (t.closest('[data-dash-open-sheet]')) { openDashV2Sheet(); return; }
    if (t.closest('[data-dash-apply-sheet]')) {
      var staged = _dashV2Stage;
      closeDashV2Sheet(true);
      commitDashV2State(staged);
      return;
    }
    if (t.closest('[data-dash-sheet-reset]')) {
      closeDashV2Sheet(true);
      commitDashV2State(DASH_FILTER_DEFAULTS);
      return;
    }
    if ((el = t.closest('[data-dash-drill]'))) { onDashV2TileClick(el); return; }
    if ((el = t.closest('.bp-seg-btn[data-dash-w]'))) { selectDashV2WidgetOpt(el); return; }
    if ((el = t.closest('[data-dash-row]'))) { onDashV2RowClick(el); return; }
    if ((el = t.closest('[data-dash-showall]'))) { onDashV2ShowAll(el); return; }
    if ((el = t.closest('[data-dash-acc]'))) { onDashV2Accordion(el); return; }
    if (t.closest('[data-dash-reset]')) { commitDashV2State(DASH_FILTER_DEFAULTS); return; }
    if ((el = t.closest('[data-dash-apply-range]'))) {
      if (el.disabled) return;
      var box = el.closest('.bp-dash-range, .bp-dash-sheet-range');
      var from = box.querySelector('[data-dash-from]').value;
      var to = box.querySelector('[data-dash-to]').value;
      if (!validateDashV2Range(box)) return;
      if (inSheet) {
        dashV2StageSet('period', 'custom');
        dashV2StageSet('from', from);
        dashV2StageSet('to', to);
        paintDashV2Controls(sheet, _dashV2Stage, false);
      } else {
        var base = {};
        var k;
        for (k in _dashV2State) { if (Object.prototype.hasOwnProperty.call(_dashV2State, k)) base[k] = _dashV2State[k]; }
        base.period = 'custom';
        base.from = from;
        base.to = to;
        commitDashV2State(base);
      }
      return;
    }
    if ((el = t.closest('[data-dash-staff]'))) {
      if (inSheet) {
        dashV2StageSet('staff', _dashV2Stage.staff === '1' ? '0' : '1');
        paintDashV2Controls(sheet, _dashV2Stage, false);
      } else {
        var s2 = sanitizeDashFilters(_dashV2State, todayPacific());
        s2.staff = s2.staff === '1' ? '0' : '1';
        commitDashV2State(s2);
      }
      return;
    }
    if ((el = t.closest('.bp-seg-btn[data-dash-ctl]'))) {
      selectDashV2Segment(el, inSheet);
    }
  }

  // data-dash-w="widget:option:value"
  function selectDashV2WidgetOpt(el) {
    var attr = el.getAttribute('data-dash-w') || '';
    var p = attr.split(':');
    if (p.length !== 3) return;
    _dashV2WidgetOpts[p[0] + ':' + p[1]] = p[2];
    rerenderDashV2Widget(p[0]);
    var again = document.querySelector('[data-dash-w="' + attr + '"]');
    if (again) again.focus();
  }

  // data-dash-row="widget:index" resolves through the in-memory drill registry; unknown keys are ignored.
  function onDashV2RowClick(el) {
    var p = (el.getAttribute('data-dash-row') || '').split(':');
    if (p.length !== 2) return;
    var list = _dashV2Drills[p[0]];
    var entry = list && list[parseInt(p[1], 10)];
    if (!entry) return;
    dashV2Go(entry.ids, entry.label);
  }

  function onDashV2ShowAll(el) {
    var attr = el.getAttribute('data-dash-showall') || '';
    var p = attr.split(':');
    if (p.length !== 2) return;
    _dashV2Expanded[attr] = !_dashV2Expanded[attr];
    rerenderDashV2Widget(p[0]);
    var again = document.querySelector('[data-dash-showall="' + attr + '"]');
    if (again) again.focus();
  }

  function selectDashV2Segment(el, inSheet) {
    var key = el.getAttribute('data-dash-ctl');
    var val = el.getAttribute('data-val');
    if (inSheet) {
      var sheet = document.getElementById('bp-dash-sheet');
      var rangeBox = sheet.querySelector('.bp-dash-sheet-range');
      if (key === 'period' && val === 'custom') {
        rangeBox.hidden = false;
        paintDashV2Controls(sheet, _dashV2Stage, true);
        return;
      }
      rangeBox.hidden = true;
      dashV2StageSet(key, val);
      paintDashV2Controls(sheet, _dashV2Stage, false);
      return;
    }
    if (key === 'period' && val === 'custom') {
      _dashV2RangeOpen = true;
      updateDashV2Bar();
      return;
    }
    var next = sanitizeDashFilters(_dashV2State, todayPacific());
    next[key] = val;
    commitDashV2State(next);
  }

  function onDashV2Change(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var wsel = t.getAttribute('data-dash-wsel');
    if (wsel) {
      var wp = wsel.split(':');
      if (wp.length !== 2) return;
      _dashV2WidgetOpts[wsel] = t.value;
      rerenderDashV2Widget(wp[0]);
      var sel = document.querySelector('[data-dash-wsel="' + wsel + '"]');
      if (sel) sel.focus();
      return;
    }
    if (t.getAttribute('data-dash-ctl') === 'source') {
      var sheet = document.getElementById('bp-dash-sheet');
      if (sheet && sheet.contains(t)) { dashV2StageSet('source', t.value); return; }
      var next = sanitizeDashFilters(_dashV2State, todayPacific());
      next.source = t.value;
      commitDashV2State(next);
    }
  }

  function onDashV2Input(e) {
    var t = e.target;
    if (!t || !t.closest || !(t.hasAttribute('data-dash-from') || t.hasAttribute('data-dash-to'))) return;
    var box = t.closest('.bp-dash-range, .bp-dash-sheet-range');
    if (box) validateDashV2Range(box);
  }

  function onDashV2Keydown(e) {
    var t = e.target;
    if (e.key === 'Escape' && document.getElementById('bp-dash-sheet')) {
      closeDashV2Sheet(true);
      return;
    }
    if (!t || !t.closest || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    var wbtn = t.closest('.bp-seg-btn[data-dash-w]');
    if (wbtn) {
      var wall = wbtn.parentNode.querySelectorAll('.bp-seg-btn');
      var widx = Array.prototype.indexOf.call(wall, wbtn);
      var wn = e.key === 'ArrowRight' ? (widx + 1) % wall.length : (widx - 1 + wall.length) % wall.length;
      e.preventDefault();
      selectDashV2WidgetOpt(wall[wn]);
      return;
    }
    var btn = t.closest('.bp-seg-btn[data-dash-ctl]');
    if (!btn) return;
    var group = btn.parentNode;
    var all = group.querySelectorAll('.bp-seg-btn');
    var idx = Array.prototype.indexOf.call(all, btn);
    var nidx = e.key === 'ArrowRight' ? (idx + 1) % all.length : (idx - 1 + all.length) % all.length;
    e.preventDefault();
    var target = all[nidx];
    var sheet = document.getElementById('bp-dash-sheet');
    selectDashV2Segment(target, !!(sheet && sheet.contains(target)));
    target.focus();
  }

  var DASH_V2_SECTIONS = [
    { key: 'today', title: 'Today', hint: "Right now. The filters above don't apply.", slots: [['bp-dash-v2-today-tasks'], ['bp-dash-v2-rtb'], ['bp-dash-v2-packcal', true]] },
    { key: 'production', title: 'Production', hint: 'Follows the filters above', slots: [['bp-dash-v2-period', true], ['bp-dash-v2-pipeline'], ['bp-dash-v2-cycle']] },
    { key: 'floor', title: 'Floor today', hint: 'Right now, mostly ignores the period filter', slots: [['bp-dash-v2-workload'], ['bp-dash-v2-vessels'], ['bp-dash-v2-tasks', true], ['bp-dash-v2-ferment', true]] },
    {
      key: 'bc', title: 'Beer & cider', hint: 'Follows the Type and Source filters. Staff batches included.', slots: [['bp-dash-v2-bc', true]],
      hidden: function (state) { return !!state && state.type === 'wine'; }
    },
    { key: 'products', title: 'Products & sales', hint: 'Follows the filters above; staff batches hidden by default', slots: [['bp-dash-v2-wine', true], ['bp-dash-v2-source', true]] },
    { key: 'health', title: 'Data health', hint: 'All batches, ignores the filters', slots: [['bp-dash-v2-health', true]] }
  ];

  function dashV2SectionsHtml() {
    var html = '';
    for (var i = 0; i < DASH_V2_SECTIONS.length; i++) {
      var sec = DASH_V2_SECTIONS[i];
      html += '<section class="bp-dash-section" data-dash-sec="' + sec.key + '"><div class="bp-dash-section-head"><h2 class="bp-dash-section-title">' + escapeHTML(sec.title) +
        '</h2><p class="bp-dash-section-hint">' + escapeHTML(sec.hint) + '</p></div><div class="bp-dash-grid">';
      for (var j = 0; j < sec.slots.length; j++) {
        html += '<div id="' + sec.slots[j][0] + '"' + (sec.slots[j][1] ? ' class="bp-dash-full"' : '') + '></div>';
      }
      html += '</div></section>';
    }
    return html;
  }

  // The shell is built once, so per-section visibility (D-16: Beer & cider hidden for Wine) is
  // re-applied on every refresh.
  function applyDashV2SectionVisibility(state) {
    for (var i = 0; i < DASH_V2_SECTIONS.length; i++) {
      var sec = DASH_V2_SECTIONS[i];
      if (typeof sec.hidden !== 'function') continue;
      var el = document.querySelector('section[data-dash-sec="' + sec.key + '"]');
      if (!el) continue;
      if (sec.hidden(state)) el.setAttribute('hidden', ''); else el.removeAttribute('hidden');
    }
  }

  function renderDashboardV2() {
    var inner = document.getElementById('bp-dashboard-inner');
    if (!inner) return;
    if (!document.getElementById('bp-dash-v2')) {
      destroyDashV2Charts();
      inner.innerHTML = '<div id="bp-dash-v2" class="bp-dash-v2">' +
        '<div id="bp-dash-filters" class="bp-dash-filters" role="group" aria-label="Dashboard filters"></div>' +
        '<div id="bp-dash-range" class="bp-dash-range" hidden></div>' +
        '<div id="bp-dash-v2-tiles"></div>' + dashV2SectionsHtml() + '</div>';
      var shell = document.getElementById('bp-dash-v2');
      shell.addEventListener('click', onDashV2Click);
      shell.addEventListener('change', onDashV2Change);
      shell.addEventListener('input', onDashV2Input);
      shell.addEventListener('keydown', onDashV2Keydown);
      _dashV2RangeOpen = false;
    }
    bindDashV2ModeListener();
    if (!_dashV2State) _dashV2State = readDashFiltersFromEnv();
    refreshDashV2();
  }

  // Boot wiring: flag, switch button, hashchange.
  initDashV2Flag();
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#bp-dash-switch')) setDashV2(!isDashV2());
  });
  window.addEventListener('hashchange', function () {
    if (!isDashV2()) return;
    _dashV2State = readDashFiltersFromEnv();
    _dashV2RangeOpen = false;
    refreshDashV2();
  });

  function renderDashboard() {
    syncDashSwitch();
    if (isDashV2()) { return renderDashboardV2(); }
    var inner = document.getElementById('bp-dashboard-inner');
    if (!inner) return;
    var d = _dashSummary || {};
    var html = '';

    // Pipeline strip
    // API returns flat counts: primaryCount, secondaryCount, completeCount
    html += '<div class="bp-pipeline-strip">';
    var stages = [
      { key: 'primary',   label: 'Primary',   icon: '&#127863;', countField: 'primaryCount'   },
      { key: 'secondary', label: 'Secondary', icon: '&#127870;', countField: 'secondaryCount' },
      { key: 'complete',  label: 'Complete',  icon: '&#10003;',  countField: 'completeCount'  }
    ];
    stages.forEach(function (s) {
      var count = d[s.countField] || 0;
      html += '<button type="button" class="bp-pipeline-tile" data-status="' + s.key + '">';
      html += '<span class="bp-pipeline-icon">' + s.icon + '</span>';
      html += '<span class="bp-pipeline-count">' + count + '</span>';
      html += '<span class="bp-pipeline-label">' + s.label + '</span>';
      html += '</button>';
    });
    html += '</div>';

    // Phase 94: every widget below reads one getDashboardData result (D-20).
    var dashRows = _dashData ? _dashData.batches : toDashRows(_allBatchesData);
    var todayStrP = todayPacific();
    var dashAsOf = _dashData ? _dashData.asOf : { today: todayStrP, year: parseInt(todayStrP.slice(0, 4), 10), tz: 'America/Vancouver' };
    var schedCatMap = buildScheduleCategoryById(_fermSchedules);
    var ytd = getDashboardData(dashRows, dashAsOf, { window: 'ytd', scheduleCategoryById: schedCatMap });

    // Stat cards: three year-to-date tiles + the full-width cycle-time tile
    if (dashRows.length > 0) {
      var ytdTitle = escapeHTML('Calendar year to date (' + dashAsOf.year + '), Vancouver time');
      html += '<div class="bp-stat-grid">';
      html += '<div class="bp-stat-card"><div class="bp-stat-num">' + ytd.activeNow + '</div><div class="bp-stat-label">Fermenting now</div></div>';
      html += '<div class="bp-stat-card" title="' + ytdTitle + '"><div class="bp-stat-num">' + ytd.totals.all + '</div><div class="bp-stat-label">Started this year</div></div>';
      html += '<div class="bp-stat-card" title="' + ytdTitle + '"><div class="bp-stat-num">' + ytd.completedTotals.all + '</div><div class="bp-stat-label">Completed this year</div></div>';
      html += '<div class="bp-stat-label bp-stat-caption">This year = Jan 1 to today</div>';

      var cyc = ytd.cycle;
      html += '<div class="bp-stat-card bp-stat-card--wide" role="group" aria-label="Days to complete">';
      html += '<div class="bp-stat-label">Days to complete (median)</div>';
      if (cyc.n > 0) {
        html += '<div class="bp-stat-row"><div class="bp-stat-num">' + cyc.median + '</div><div class="bp-stat-label">mean ' + cyc.mean + 'd</div></div>';
        var basis = 'Based on ' + cyc.n + ' batch' + (cyc.n !== 1 ? 'es' : '');
        html += '<div class="bp-stat-label">' + escapeHTML(basis);
        if (cyc.excluded > 0) {
          html += ', <span class="bp-stat-warn">' + cyc.excluded + ' excluded (no completion date)</span>';
        }
        html += '</div>';
        var typeParts = [];
        for (var cti = 0; cti < DASH_TYPES.length; cti++) {
          var cty = cyc.byType[DASH_TYPES[cti]];
          if (cty && cty.n > 0) {
            typeParts.push('<span><strong>' + escapeHTML(DASH_TYPE_LABELS[DASH_TYPES[cti]]) + '</strong> ' + cty.median + 'd</span>');
          }
        }
        if (typeParts.length) {
          html += '<div class="bp-stat-label bp-stat-types">' + typeParts.join(' &middot; ') + '</div>';
        }
      } else {
        html += '<div class="bp-stat-row"><div class="bp-stat-num">\u2014</div></div>';
        html += '<div class="bp-stat-label">No completed batches with a completion date yet</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Batches by Month bar chart (started batches, last 6 months)
    // When client has full batch data, render stacked bars by beverage type with a legend.
    // Falls back to the server-computed solid-green bars if _allBatchesData is empty.
    var TYPE_COLORS = { wine: '#7b2d3b', beer: '#c8852a', cider: '#d4a72c', seltzer: '#3a9aa6', other: '#9aa0a6' };
    var TYPE_LABELS = { wine: 'Wine', beer: 'Beer', cider: 'Cider', seltzer: 'Seltzer', other: 'Other' };
    var TYPE_ORDER = ['wine', 'beer', 'cider', 'seltzer', 'other'];

    var byMonth = (d && d.batchesByMonth) || [];
    if (byMonth.length > 0 || dashRows.length > 0) {
      html += '<div class="bp-section-header">Batches by Month</div>';
      html += '<div class="bp-stat-label">Started batches only</div>';

      if (dashRows.length > 0) {
        // Stacked bar chart from the shared data layer (started batches only)
        var typedMonths = ytd.monthBuckets;

        // Determine which types have any data at all (for legend)
        var typeHasData = {};
        for (var tm = 0; tm < typedMonths.length; tm++) {
          var mc = typedMonths[tm].counts;
          for (var tk = 0; tk < TYPE_ORDER.length; tk++) {
            if (mc[TYPE_ORDER[tk]] > 0) typeHasData[TYPE_ORDER[tk]] = true;
          }
        }

        // Build legend (one chip per type that has data, or 'other' always shown)
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 4px 8px;">';
        for (var li = 0; li < TYPE_ORDER.length; li++) {
          var lt = TYPE_ORDER[li];
          if (!typeHasData[lt] && lt !== 'other') continue;
          var lHidden = !!_dashChartHiddenTypes[lt];
          var lPressed = lHidden ? 'true' : 'false';
          var lOpacity = lHidden ? '0.4' : '1';
          // Count across all months for this type
          var lTotal = 0;
          for (var lm = 0; lm < typedMonths.length; lm++) {
            lTotal += typedMonths[lm].counts[lt] || 0;
          }
          html += '<span role="button" tabindex="0" aria-pressed="' + lPressed + '" data-bp-chart-type="' + lt + '" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:12px;border:1px solid #ddd;font-size:0.72rem;cursor:pointer;opacity:' + lOpacity + ';background:#fff;">';
          html += '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + TYPE_COLORS[lt] + ';flex-shrink:0;"></span>';
          html += escapeHTML(TYPE_LABELS[lt]) + ' (' + lTotal + ')';
          html += '</span>';
        }
        html += '</div>';

        // Compute max visible total for bar scaling
        var maxVisible = 0;
        for (var vi = 0; vi < typedMonths.length; vi++) {
          var visTotal = 0;
          for (var vt = 0; vt < TYPE_ORDER.length; vt++) {
            if (!_dashChartHiddenTypes[TYPE_ORDER[vt]]) {
              visTotal += typedMonths[vi].counts[TYPE_ORDER[vt]] || 0;
            }
          }
          if (visTotal > maxVisible) maxVisible = visTotal;
        }
        if (maxVisible < 1) maxVisible = 1;

        html += '<div style="display:flex;align-items:flex-end;gap:8px;height:120px;padding:0 4px 0;">';
        for (var bi = 0; bi < typedMonths.length; bi++) {
          var bm = typedMonths[bi];
          // Build tooltip per type
          var tipParts = [];
          for (var bt = 0; bt < TYPE_ORDER.length; bt++) {
            var btype = TYPE_ORDER[bt];
            var bcnt = bm.counts[btype] || 0;
            if (bcnt > 0) tipParts.push(TYPE_LABELS[btype] + ': ' + bcnt);
          }
          var tipTitle = escapeHTML(bm.label) + ' (' + bm.total + ')' + (tipParts.length ? ' — ' + tipParts.join(', ') : '');

          // Visible total for this bar
          var barVisTotal = 0;
          for (var bvt = 0; bvt < TYPE_ORDER.length; bvt++) {
            if (!_dashChartHiddenTypes[TYPE_ORDER[bvt]]) {
              barVisTotal += bm.counts[TYPE_ORDER[bvt]] || 0;
            }
          }
          var barH = Math.round((barVisTotal / maxVisible) * 92) + 4;

          html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;" title="' + tipTitle + '">';
          html += '<div style="font-size:0.7rem;color:#5f5f5f;margin-bottom:2px;">' + barVisTotal + '</div>';
          // Stacked bar column — innermost type on bottom
          html += '<div style="width:70%;max-width:34px;height:' + barH + 'px;display:flex;flex-direction:column-reverse;border-radius:4px 4px 0 0;overflow:hidden;">';
          for (var bs = 0; bs < TYPE_ORDER.length; bs++) {
            var bsType = TYPE_ORDER[bs];
            if (_dashChartHiddenTypes[bsType]) continue;
            var bsCnt = bm.counts[bsType] || 0;
            if (!bsCnt) continue;
            var segH = Math.round((bsCnt / barVisTotal) * barH);
            if (segH < 1) segH = 1;
            html += '<div style="width:100%;height:' + segH + 'px;background:' + TYPE_COLORS[bsType] + ';flex-shrink:0;" title="' + escapeHTML(TYPE_LABELS[bsType]) + ': ' + bsCnt + '"></div>';
          }
          html += '</div>';
          html += '<div style="font-size:0.68rem;color:#5f5f5f;margin-top:4px;">' + escapeHTML(bm.label) + '</div>';
          html += '</div>';
        }
        html += '</div>';

      } else {
        // Fallback: solid-green bars from server-computed batchesByMonth
        var maxMonth = byMonth.reduce(function (mx, x) { return Math.max(mx, x.count || 0); }, 0) || 1;
        html += '<div style="display:flex;align-items:flex-end;gap:8px;height:120px;padding:6px 4px 0;">';
        byMonth.forEach(function (m) {
          var bh = Math.round((m.count / maxMonth) * 92) + 4;
          html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;" title="' + escapeHTML(m.label) + ': ' + m.count + '">';
          html += '<div style="font-size:0.7rem;color:#5f5f5f;margin-bottom:2px;">' + m.count + '</div>';
          html += '<div style="width:70%;max-width:34px;height:' + bh + 'px;background:#4a6f4b;border-radius:4px 4px 0 0;"></div>';
          html += '<div style="font-size:0.68rem;color:#5f5f5f;margin-top:4px;">' + escapeHTML(m.label) + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
    }

    // Wine Breakdown card — horizontal-bar breakdown of wine batches by a user-selectable
    // dimension (subcategory / brand / manufacturer / time) and sample period. Snapshot lazy-loaded.
    html += '<div class="bp-section-header">Wine Breakdown</div>';

    if (_dashWineSkuError) {
      // Snapshot load failed — show muted note; rest of dashboard unaffected
      html += '<p class="bp-empty" style="color:#9aa0a6;font-style:italic;">Unable to load catalog data — wine breakdown unavailable.</p>';
    } else if (_dashWineSkuLookup === null) {
      // Not yet loaded — kick off the fetch and show placeholder
      loadWineSnapshot();
      html += '<p class="bp-empty" style="color:#9aa0a6;font-style:italic;">Loading…</p>';
    } else {
      // Dimension selector chips
      var WINE_DIM_LABELS = { subcategory: 'Subcategory', brand: 'Brand', manufacturer: 'Manufacturer', time: 'Time' };
      var WINE_DIM_ORDER = ['subcategory', 'brand', 'manufacturer', 'time'];
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 4px 6px;">';
      for (var wdi = 0; wdi < WINE_DIM_ORDER.length; wdi++) {
        var wd = WINE_DIM_ORDER[wdi];
        var wdActive = wd === _dashWineDimension;
        var wdBg = wdActive ? '#7b2d3b' : '#fff';
        var wdColor = wdActive ? '#fff' : '#333';
        var wdBorder = wdActive ? '1px solid #7b2d3b' : '1px solid #ddd';
        html += '<span role="button" tabindex="0" aria-pressed="' + (wdActive ? 'true' : 'false') + '" data-bp-wine-dim="' + wd + '" style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:12px;border:' + wdBorder + ';font-size:0.72rem;cursor:pointer;background:' + wdBg + ';color:' + wdColor + ';font-weight:' + (wdActive ? '600' : 'normal') + ';">';
        html += escapeHTML(WINE_DIM_LABELS[wd]);
        html += '</span>';
      }
      html += '</div>';

      // Sample period selector chips — independent of dimension selector
      var WINE_PERIOD_DEFS = [
        { key: '30d',  label: '30 Days',   days: 30 },
        { key: '90d',  label: '90 Days',   days: 90 },
        { key: '6mo',  label: '6 Months',  days: 180 },
        { key: '12mo', label: '12 Months', days: 365 },
        { key: 'all',  label: 'All Time',  days: null }
      ];
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin:0 4px 10px;align-items:center;">';
      html += '<span style="font-size:0.68rem;color:#888;margin-right:2px;">Period:</span>';
      for (var wpi = 0; wpi < WINE_PERIOD_DEFS.length; wpi++) {
        var wp = WINE_PERIOD_DEFS[wpi];
        var wpActive = wp.key === _dashWinePeriod;
        var wpBg = wpActive ? '#5b4a7b' : '#fff';
        var wpColor = wpActive ? '#fff' : '#333';
        var wpBorder = wpActive ? '1px solid #5b4a7b' : '1px solid #ddd';
        html += '<span role="button" tabindex="0" aria-pressed="' + (wpActive ? 'true' : 'false') + '" data-bp-wine-period="' + wp.key + '" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:12px;border:' + wpBorder + ';font-size:0.68rem;cursor:pointer;background:' + wpBg + ';color:' + wpColor + ';font-weight:' + (wpActive ? '600' : 'normal') + ';">';
        html += escapeHTML(wp.label);
        html += '</span>';
      }
      html += '</div>';

      // Compute bucketed data using Plan 01 helpers
      // Phase 94: the wine membership + window come from the shared data layer
      // (same window keys as the period chips); bucketWineDimension then only tallies.
      var wineWin = dashboardWindow(_dashWinePeriod, dashAsOf.today);
      var wineRows = [];
      var wineMerged = {};
      var wsk;
      for (wsk in _dashWineSkuLookup) {
        if (Object.prototype.hasOwnProperty.call(_dashWineSkuLookup, wsk)) wineMerged[wsk] = _dashWineSkuLookup[wsk];
      }
      for (var wri = 0; wri < dashRows.length; wri++) {
        var wr = dashRows[wri];
        if (DASH_STARTED_STATUSES[String(wr.status || '').toLowerCase()] !== true) continue;
        if (!inWindow(wr.start_date, wineWin)) continue;
        if (effectiveBatchType(wr, schedCatMap) !== 'wine') continue;
        wineRows.push({ batch_id: wr.batch_id, category: 'wine', start_date: wr.start_date, product_sku: wr.product_sku });
        if (wr.product_sku) {
          var wsrc = _dashWineSkuLookup[String(wr.product_sku)];
          var wov = {};
          var wdd = {};
          var wpairs = [['subcategory', 'product_subcategory'], ['brand', 'product_brand'], ['manufacturer', 'product_manufacturer']];
          var wany = false;
          for (var wpp = 0; wpp < wpairs.length; wpp++) {
            if (wr[wpairs[wpp][1]]) { wov[wpairs[wpp][0]] = wr[wpairs[wpp][1]]; wany = true; }
          }
          if (wany) {
            var wk2;
            if (wsrc) { for (wk2 in wsrc) { if (Object.prototype.hasOwnProperty.call(wsrc, wk2)) wdd[wk2] = wsrc[wk2]; } }
            for (wk2 in wov) { if (Object.prototype.hasOwnProperty.call(wov, wk2)) wdd[wk2] = wov[wk2]; }
            wineMerged[String(wr.product_sku)] = wdd;
          }
        }
      }
      var wRawBuckets = bucketWineDimension(wineRows, null, wineMerged, _dashWineDimension, null);
      var wBuckets = applyTopN(wRawBuckets, 8);

      // Build empty-state copy reflecting the active period
      var wEmptyMsg;
      if (_dashWinePeriod === 'all') {
        wEmptyMsg = 'No wine batches found.';
      } else if (_dashWinePeriod === '30d') {
        wEmptyMsg = 'No wine batches started in the last 30 days.';
      } else if (_dashWinePeriod === '90d') {
        wEmptyMsg = 'No wine batches started in the last 90 days.';
      } else if (_dashWinePeriod === '12mo') {
        wEmptyMsg = 'No wine batches started in the last 12 months.';
      } else {
        wEmptyMsg = 'No wine batches started in the last 6 months.';
      }

      if (wBuckets.length === 0) {
        html += '<p class="bp-empty">' + wEmptyMsg + '</p>';
      } else {
        // Color palette for wine dimension bars (deterministic by index)
        var WINE_DIM_PALETTE = ['#7b2d3b', '#a34a2b', '#c8852a', '#d4a72c', '#4a6f4b', '#3a9aa6', '#5b6dc8', '#9c5bb5'];
        var wMax = 0;
        for (var wmi = 0; wmi < wBuckets.length; wmi++) {
          if (wBuckets[wmi].count > wMax) wMax = wBuckets[wmi].count;
        }
        if (wMax < 1) wMax = 1;

        // Total wine batches in window
        var wTotal = 0;
        for (var wti = 0; wti < wBuckets.length; wti++) { wTotal += wBuckets[wti].count; }

        html += '<div style="margin:0 4px 8px;">';
        for (var wbi = 0; wbi < wBuckets.length; wbi++) {
          var wb = wBuckets[wbi];
          var wBarColor;
          if (wb.label === 'Other') {
            wBarColor = '#9aa0a6';
          } else if (wb.label === 'Unknown') {
            wBarColor = '#c0b8b0';
          } else {
            wBarColor = WINE_DIM_PALETTE[wbi % WINE_DIM_PALETTE.length];
          }
          var wBarPct = Math.round((wb.count / wMax) * 100);
          if (wBarPct < 2) wBarPct = 2; // minimum visible width
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;" title="' + escapeHTML(wb.label) + ': ' + wb.count + '">';
          html += '<div style="flex:0 0 90px;font-size:0.72rem;color:#444;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHTML(wb.label) + '">' + escapeHTML(wb.label) + '</div>';
          html += '<div style="flex:1;background:#f0f0f0;border-radius:3px;height:16px;position:relative;">';
          html += '<div style="position:absolute;left:0;top:0;height:100%;width:' + wBarPct + '%;background:' + wBarColor + ';border-radius:3px;"></div>';
          html += '</div>';
          html += '<div style="flex:0 0 28px;font-size:0.72rem;color:#555;text-align:right;">' + wb.count + '</div>';
          html += '</div>';
        }
        html += '</div>';
        html += '<div style="font-size:0.7rem;color:#888;text-align:right;margin:0 4px 4px;">Total: ' + wTotal + ' wine batch' + (wTotal !== 1 ? 'es' : '') + '</div>';
      }
    }

    // Attention items — built client-side from scalar counts returned by the API
    // (overdueTasks, tasksDueToday, readyForPackaging)
    var attention = [];
    if (d.overdueTasks > 0) {
      attention.push({ cls: 'bp-attention--danger',
        text: d.overdueTasks + ' overdue task' + (d.overdueTasks !== 1 ? 's' : '') });
    }
    if (d.tasksDueToday > 0) {
      attention.push({ cls: 'bp-attention--warning',
        text: d.tasksDueToday + ' task' + (d.tasksDueToday !== 1 ? 's' : '') + ' due today' });
    }
    html += '<div class="bp-section-header">Needs Attention</div>';
    if (attention.length > 0) {
      html += '<div class="bp-attention-list">';
      attention.forEach(function (item) {
        html += '<div class="bp-attention-item ' + item.cls + '">';
        html += '<span class="bp-attention-dot"></span>';
        html += '<span class="bp-attention-text">' + escapeHTML(item.text) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    } else if (_dashSummary && (!d.readyToBottle || !d.readyToBottle.length) && (!d.needsScheduling || !d.needsScheduling.length)) {
      html += '<p class="bp-empty">All batches on track.</p>';
    }

    // Needs Scheduling — pending batches auto-created from sales, awaiting a schedule/start.
    var pend = (d && d.needsScheduling) || [];
    if (pend.length > 0) {
      var nsOpen = _dashNeedsSchedExpanded;
      html += '<div class="bp-detail-section-title bp-detail-section-toggle bp-needsched-toggle" role="button" tabindex="0" aria-expanded="' + (nsOpen ? 'true' : 'false') + '">';
      html += 'Needs Scheduling (' + pend.length + ') ';
      html += '<span class="bp-section-toggle-icon" style="' + (nsOpen ? 'transform:rotate(90deg);' : '') + '">&#9656;</span>';
      html += '</div>';
      html += '<div class="bp-needsched-body" style="' + (nsOpen ? '' : 'display:none;') + '">';
      html += '<div class="bp-dash-task-list">';
      pend.forEach(function (it) {
        html += '<div class="bp-task-row">';
        html += '<div class="bp-task-body">';
        html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(it.batch_id || '') + '" title="Open batch">' + escapeHTML(it.batch_id || '') + '</button>';
        html += '<span class="bp-task-title">' + escapeHTML(it.product_name || '') + '</span>';
        if (it.customer_name) html += '<span class="bp-task-customer">' + escapeHTML(it.customer_name) + '</span>';
        if (it.source) html += '<span class="bp-task-meta">' + escapeHTML(it.source) + '</span>';
        var since = it.created_at ? String(it.created_at).slice(0, 10) : '';
        html += '<span style="font-size:0.75rem;color:#e67e22;font-weight:600;margin-left:6px;">Awaiting schedule' + (since ? ' — sold ' + escapeHTML(since) : '') + '</span>';
        html += '</div>';
        html += '<div class="bp-task-actions">';
        html += '<button type="button" class="btn bp-btn-sm bp-needsched-activate-btn"' +
          ' title="Activate now with today&#39;s date — no schedule attached"' +
          ' data-batch-id="' + escapeHTML(it.batch_id || '') + '"' +
          ' data-version="' + escapeHTML(it.last_updated || '') + '">Activate now</button>';
        html += '<button type="button" class="btn-secondary bp-btn-sm bp-needsched-sa-btn"' +
          ' title="Pick a schedule and start date, then activate"' +
          ' data-batch-id="' + escapeHTML(it.batch_id || '') + '">Schedule &amp; Activate</button>';
        html += '<button type="button" class="btn-secondary bp-btn-sm bp-danger-btn bp-needsched-delete-btn"' +
          ' data-batch-id="' + escapeHTML(it.batch_id || '') + '"' +
          ' data-product="' + escapeHTML(it.product_name || '') + '"' +
          ' data-customer="' + escapeHTML(it.customer_name || '') + '">Delete</button>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // Ready to Bottle — collapsible list (active batch with an open, due bottling
    // task; does NOT require sibling tasks to be ticked off, which was hiding batches).
    var rtb = (d && d.readyToBottle) || [];
    if (rtb.length > 0) {
      var rtbOpen = _dashRtbExpanded;
      html += '<div class="bp-detail-section-title bp-detail-section-toggle bp-rtb-toggle" role="button" tabindex="0" aria-expanded="' + (rtbOpen ? 'true' : 'false') + '">';
      html += 'Ready to Bottle (' + rtb.length + ') ';
      html += '<span class="bp-section-toggle-icon" style="' + (rtbOpen ? 'transform:rotate(90deg);' : '') + '">&#9656;</span>';
      html += '</div>';
      html += '<div class="bp-rtb-body" style="' + (rtbOpen ? '' : 'display:none;') + '">';
      html += '<div class="bp-dash-task-list">';
      rtb.forEach(function (it) {
        html += '<div class="bp-task-row">';
        html += '<div class="bp-task-body">';
        html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(it.batch_id || '') + '"' +
          (it.overdue ? ' style="background:#ffebee;color:#c62828;border-color:#ef9a9a;"' : '') +
          ' title="Open batch">' + escapeHTML(it.batch_id || '') + '</button>';
        html += '<span class="bp-task-title">' + escapeHTML(it.product_name || '') + '</span>';
        if (it.customer_name) html += '<span class="bp-task-customer">' + escapeHTML(it.customer_name) + '</span>';
        var loc = [it.vessel_id, it.shelf_id].filter(Boolean).join(' · ');
        if (loc) html += '<span class="bp-task-meta">' + escapeHTML(loc) + '</span>';
        if (it.overdue) {
          html += '<span style="font-size:0.75rem;color:#d32f2f;font-weight:600;margin-left:6px;">Overdue — ' + escapeHTML(it.bottling_due) + '</span>';
        } else if (it.bottling_due) {
          html += '<span style="font-size:0.75rem;color:#2e7d32;font-weight:600;margin-left:6px;">Due ' + escapeHTML(it.bottling_due) + '</span>';
        } else {
          html += '<span style="font-size:0.75rem;color:#5f5f5f;margin-left:6px;">Bottling date TBD</span>';
        }
        if (it.has_email) {
          html += '<button type="button" class="bp-rtb-invite-btn" data-batch-id="' + escapeHTML(it.batch_id || '') + '" data-customer="' + escapeHTML(it.customer_name || 'this customer') + '" data-product="' + escapeHTML(it.product_name || '') + '" style="margin-left:8px;font-size:0.72rem;padding:2px 8px;border-radius:6px;border:1px solid #4a6f4b;background:#fff;color:#4a6f4b;cursor:pointer;">Send Invite</button>';
        }
        html += '</div></div>';
      });
      html += '</div></div>';
    }

    // Today's tasks checklist (including overdue)
    var todayDateStr = todayStr();
    var overdueTasks = _upcomingTasks.filter(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
      return !done && t.due_date && String(t.due_date).slice(0, 10) < todayDateStr;
    });
    var todayTasks = _upcomingTasks.filter(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
      return !done && t.due_date && String(t.due_date).slice(0, 10) === todayDateStr;
    });
    if (overdueTasks.length || todayTasks.length) {
      html += '<div class="bp-section-header">Today\u2019s Tasks</div>';
      html += '<div class="bp-dash-task-list">';
      // Overdue tasks first, with visual indicator
      overdueTasks.forEach(function (t) {
        html += '<div class="bp-task-row" data-task-id="' + escapeHTML(t.task_id) + '" style="background:rgba(244,67,54,0.06);border-left:3px solid #f44336;">';
        html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"></label>';
        html += '<div class="bp-task-body">';
        html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(t.batch_id || '') + '" style="background:#ffebee;color:#c62828;border-color:#ef9a9a;">' + escapeHTML(t.batch_id || '') + '</button>';
        html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
        var overdueDate = escapeHTML(String(t.due_date).slice(0, 10));
        html += '<span style="font-size:0.75rem;color:#d32f2f;font-weight:600;margin-left:6px;">Overdue \u2014 ' + overdueDate + '</span>';
        if (getCustomerDisplayName(t)) html += '<span class="bp-task-customer">' + escapeHTML(getCustomerDisplayName(t)) + '</span>';
        var meta = getBatchMeta(t.batch_id);
        if (meta) html += '<span class="bp-task-meta">' + escapeHTML(meta) + '</span>';
        html += '</div></div>';
      });
      // Today's tasks
      todayTasks.forEach(function (t) {
        html += '<div class="bp-task-row" data-task-id="' + escapeHTML(t.task_id) + '">';
        html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"></label>';
        html += '<div class="bp-task-body">';
        html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(t.batch_id || '') + '">' + escapeHTML(t.batch_id || '') + '</button>';
        html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
        if (getCustomerDisplayName(t)) html += '<span class="bp-task-customer">' + escapeHTML(getCustomerDisplayName(t)) + '</span>';
        var meta = getBatchMeta(t.batch_id);
        if (meta) html += '<span class="bp-task-meta">' + escapeHTML(meta) + '</span>';
        html += '</div></div>';
      });
      html += '</div>';
    }

    // 7-day workload bar chart
    if (_upcomingTasks && _upcomingTasks.length > 0) {
      html += '<div class="bp-section-header">Next 7 Days</div>';
      var today7 = todayStr();
      var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var days = [];
      for (var di = 0; di < 7; di++) {
        var dt = new Date(); dt.setDate(dt.getDate() + di);
        var dStr = dt.toISOString().slice(0, 10);
        days.push({ date: dStr, label: di === 0 ? 'Today' : dayNames[dt.getDay()], count: 0 });
      }
      _upcomingTasks.forEach(function (t) {
        var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
        if (done) return;
        var due = t.due_date ? String(t.due_date).slice(0, 10) : '';
        for (var di2 = 0; di2 < days.length; di2++) {
          if (days[di2].date === due) { days[di2].count++; break; }
        }
      });
      var maxCount = 1;
      days.forEach(function (d) { if (d.count > maxCount) maxCount = d.count; });
      html += '<div class="bp-workload-chart">';
      days.forEach(function (d) {
        var pct = Math.round((d.count / maxCount) * 100);
        var barCls = d.date < today7 ? 'bp-wl-bar--overdue' : (d.date === today7 ? 'bp-wl-bar--today' : 'bp-wl-bar--future');
        var expandedCls = _dashExpandedDay === d.date ? ' bp-wl-day--expanded' : '';
        html += '<div class="bp-wl-day' + expandedCls + '" data-date="' + d.date + '">';
        html += '<div class="bp-wl-bar-wrap"><div class="bp-wl-bar ' + barCls + '" style="transform:scaleY(' + (d.count > 0 ? Math.max(pct, 12) / 100 : 0) + ')"></div></div>';
        html += '<div class="bp-wl-count">' + (d.count || '') + '</div>';
        html += '<div class="bp-wl-label">' + escapeHTML(d.label) + '</div>';
        html += '</div>';
      });
      html += '</div>';
      // Expanded task card for tapped workload day — always render when a day is selected
      if (_dashExpandedDay) {
        var expandTasks = _upcomingTasks.filter(function (t) {
          var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
          return !done && t.due_date && String(t.due_date).slice(0, 10) === _dashExpandedDay;
        });
        html += '<div class="bp-wl-expanded-card">';
        html += '<div class="bp-wl-expanded-date">' + fmtDate(_dashExpandedDay) + '</div>';
        if (expandTasks.length) {
          expandTasks.forEach(function (t) {
            html += '<div class="bp-wl-expanded-item">';
            html += '<span class="bp-batch-chip-inline">' + escapeHTML(t.batch_id || '') + '</span> ';
            html += escapeHTML(t.title || ('Step ' + t.step_number));
            html += '</div>';
          });
        } else {
          html += '<p class="bp-empty" style="margin:0;font-size:0.85rem;">No tasks this day.</p>';
        }
        html += '</div>';
      }
    }

    html += '<button type="button" class="bp-fab" id="bp-dash-new-batch">+ New Batch</button>';
    inner.innerHTML = html;

    // Pipeline tile + workload day clicks handled by delegation on #bp-dashboard-inner (see initDelegation)
    var fabBtn = document.getElementById('bp-dash-new-batch');
    if (fabBtn) {
      fabBtn.addEventListener('click', function () {
        switchTab('batches');
        setTimeout(openCreateSheet, 180);
      });
    }
  }

  // ===== Batches =====

  // readyToBottleRows — the intersection of the loaded batch list with the
  // SERVER-computed _dashSummary.readyToBottle set (adminApi.gs:1847-1883). This is
  // the single definition used by BOTH the batch-view Ready-to-Bottle filter rows
  // AND its count chip (so they can never diverge — WR-03).
  function readyToBottleRows() {
    return filterBatchesByReadyToBottle(
      _allBatchesData, (_dashSummary && _dashSummary.readyToBottle) || []);
  }

  // applyBatchFilter — the ONE place that derives _batchesData from _allBatchesData
  // for the active filter. 'readyToBottle' is NOT a batch status: it must intersect
  // the _dashSummary.readyToBottle set rather than fall through to filterBatchesByStatus
  // (which would status-match the literal 'readyToBottle' and always return []). Every
  // re-derive site (switchTab, loadBatches fresh + post-fetch, the filter-button click
  // handler) routes through here so the Ready-to-Bottle filter survives tab switches and
  // post-write reloads (CR-01).
  // Phase 94 (D-07): { batch_id: {batch_type, batch_type_source} } from the dashboard
  // aggregate; empty in sheets mode (rows then fall back to effectiveBatchType).
  function dashTypeById() {
    var out = {};
    var rows = _dashData && _dashData.batches ? _dashData.batches : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && r.batch_id) out[r.batch_id] = { batch_type: r.batch_type, batch_type_source: r.batch_type_source };
    }
    return out;
  }

  function needsTypeRows() {
    return filterBatchesByNeedsType(_allBatchesData, dashTypeById(), buildScheduleCategoryById(_fermSchedules));
  }

  // Phase 95 (D-14): while a dashboard click-through is active, every chip works on
  // the intersection of its normal rows with the drilled id set.
  function drillFilterRows(rows) {
    if (!_dashDrill) return rows;
    return rows.filter(function (b) { return b && _dashDrill.ids[b.batch_id] === true; });
  }

  function applyBatchFilter() {
    var srcRows = drillFilterRows(_allBatchesData);
    if (_batchStatusFilter === 'readyToBottle') {
      _batchesData = drillFilterRows(readyToBottleRows());
    } else if (_batchStatusFilter === 'unlinked') {
      _batchesData = filterBatchesByUnlinked(srcRows);
    } else if (_batchStatusFilter === 'needsType') {
      _batchesData = drillFilterRows(needsTypeRows());
    } else {
      _batchesData = filterBatchesByStatus(srcRows, _batchStatusFilter);
    }
  }

  // openDashDrill(spec) - spec = { ids: string[], label: string }. Shows exactly spec.ids on the
  // Batches tab (chip 'all', search/product cleared) under a dismissible banner.
  function openDashDrill(spec) {
    var ids = (spec && spec.ids) || [];
    var map = {};
    for (var i = 0; i < ids.length; i++) map[ids[i]] = true;
    _dashDrill = { ids: map, count: ids.length, label: String((spec && spec.label) || '') };
    _batchStatusFilter = 'all';
    _batchSearch = '';
    _batchProductFilter = '';
    _batchesLoaded = false;
    var searchEl = document.getElementById('bp-batch-search');
    if (searchEl) searchEl.value = '';
    switchTab('batches');
  }

  // Phase 95-10 UAT: the bottom tab bar always opens the normal Batches list. Only a dashboard
  // click (openDashDrill) shows a drilled set, so a leftover drill is dropped here.
  function handleTabBarClick(tab) {
    if (tab === 'batches' && _dashDrill) {
      _dashDrill = null;
      _batchStatusFilter = 'active';
    }
    switchTab(tab);
  }

  // Review WR-01: code that forces a status filter (not a chip tap) drops any leftover
  // dashboard drill, otherwise the drilled id set hides the rows the caller wants shown.
  function setBatchStatusFilterProgrammatic(status) {
    _dashDrill = null;
    _batchStatusFilter = status;
  }

  function clearDashDrill() {
    _dashDrill = null;
    _batchStatusFilter = 'active';
    if (_allBatchesData.length === 0) { loadBatches(); return; }
    applyBatchFilter();
    renderBatchList();
  }

  // refreshReadyToBottleFilterView — after a task write + loadDashboard() refetch,
  // keep the batch-view Ready-to-Bottle filter live WITHOUT a page reload: if that
  // filter is the active one and the batch list is on screen, re-derive from the
  // freshly-refetched _dashSummary.readyToBottle and re-render. No-op otherwise
  // (switchTab re-derives on next entry, since _allBatchesData is preserved). This
  // is what lets a completed bottling task drop the batch from BOTH the dashboard
  // Ready-to-Bottle card and the batch-view filter list at once (WR-01 invariant).
  function refreshReadyToBottleFilterView() {
    if (_activeTab === 'batches' && _batchStatusFilter === 'readyToBottle') {
      applyBatchFilter();
      renderBatchList();
    }
  }

  // Returns a thenable that resolves once the batch list is loaded (or immediately
  // when served from cache / a fetch is already in flight). Callers that need
  // _allBatchesData populated before acting (e.g. the Ready-to-Bottle filter's
  // not-loaded path, WR-02) can chain on it; existing fire-and-forget callers are
  // unaffected. The fetch chain's .catch means the returned promise never rejects.
  function loadBatches() {
    // If eager-loaded cache is fresh, derive filtered list client-side (instant)
    var now = Date.now();
    if (_allBatchesData.length > 0 && now - _batchesLoadTime < CACHE_TTL_LONG) {
      applyBatchFilter();
      _batchesLoaded = true;
      renderBatchList();
      return Promise.resolve();
    }

    // Cache stale — re-fetch all
    if (_batchesLoading) return Promise.resolve();
    _batchesLoading = true;
    _batchesLoadTime = Date.now();

    // Show loading skeleton — use results container if shell exists, otherwise full pane
    var resultsEl = document.getElementById('bp-batch-results');
    if (resultsEl) {
      resultsEl.innerHTML = '<div class="bp-skeleton-block"></div>';
    } else {
      var listPane = document.getElementById('bp-batch-list-pane');
      if (listPane) listPane.innerHTML = '<div class="bp-panel-inner"><div class="bp-skeleton-block"></div></div>';
    }

    return adminApiGet('get_batches', { status: 'all' })
      .then(function (r) {
        _allBatchesData = (r.data && r.data.batches) || [];
        applyBatchFilter();
        _batchesLoaded = true;
        _batchesLoading = false;
        _batchDetailPreloaded = false; // allow top-3 preload on fresh batch list
        renderBatchList();
      })
      .catch(function (err) {
        _batchesLoading = false;
        // Show error — use results container if shell exists, otherwise full pane
        var errResults = document.getElementById('bp-batch-results');
        if (errResults) {
          errResults.innerHTML = '<p class="bp-empty">Failed to load batches: ' + escapeHTML(err.message) + '</p>';
        } else {
          var lp = document.getElementById('bp-batch-list-pane');
          if (lp) lp.innerHTML = '<div class="bp-panel-inner"><p class="bp-empty">Failed to load batches: ' + escapeHTML(err.message) + '</p></div>';
        }
      });
  }

  // selectBatchStatusFilter(filterBtn) — a batch-view status chip was clicked. afterBatchWrite empties
  // _allBatchesData after a list-affecting save so the next view refetches; every
  // chip must therefore load an emptied list BEFORE filtering it, or the view shows
  // no batches at all (owner report 2026-10-22: "all the batch data disappears").
  // Phase 90 fixed this for Unlinked only. Ready-to-Bottle also needs _dashSummary
  // (its rows are the intersection, WR-02). loadDashboard/loadBatches fail soft; all
  // filtering routes through applyBatchFilter (CR-01).
  function selectBatchStatusFilter(filterBtn) {
    _batchStatusFilter = filterBtn.getAttribute('data-status');
    var loads = [];
    if (_allBatchesData.length === 0) loads.push(loadBatches());
    if (_batchStatusFilter === 'readyToBottle' && !_dashSummary) loads.push(loadDashboard());
    return Promise.all(loads).then(function () {
      applyBatchFilter();
      renderBatchList();
    });
  }

  // applyTaskToggleToList — keep a list card's "N/M tasks" in step with a task
  // ticked or unticked elsewhere. Task writes keep the cached list on purpose
  // (listAffecting:false, WR-01), so without this the card showed the old count.
  function applyTaskToggleToList(batchId, checked) {
    var b = null;
    for (var i = 0; i < _allBatchesData.length; i++) {
      if (String(_allBatchesData[i].batch_id) === String(batchId)) { b = _allBatchesData[i]; break; }
    }
    if (!b) return;
    var total = parseInt(b.tasks_total, 10) || 0;
    var done = (parseInt(b.tasks_done, 10) || 0) + (checked ? 1 : -1);
    b.tasks_done = Math.max(0, Math.min(total, done));
    if (document.getElementById('bp-batch-results')) renderBatchList();
  }

  // syncListTaskCounts — set a list card's task counts exactly from a freshly
  // fetched batch detail, correcting any optimistic +1/-1 (e.g. a tick and untick
  // inside the 300 ms save debounce).
  function syncListTaskCounts(batchId, tasks) {
    if (!Array.isArray(tasks)) return;
    var b = null;
    for (var i = 0; i < _allBatchesData.length; i++) {
      if (String(_allBatchesData[i].batch_id) === String(batchId)) { b = _allBatchesData[i]; break; }
    }
    if (!b) return;
    b.tasks_total = tasks.length;
    b.tasks_done = tasks.filter(function (t) {
      return t.completed === true || t.completed === 'TRUE' || t.completed === '1';
    }).length;
    if (document.getElementById('bp-batch-results')) renderBatchList();
  }

  var STATUS_LABELS = { primary: 'Primary', secondary: 'Secondary', complete: 'Complete', active: 'Active', packaging: 'Packaging', pending: 'Pending' };
  var STATUS_COLORS = { primary: 'info', secondary: 'warning', complete: 'success', active: 'info', packaging: 'warning', pending: 'neutral' };

  function renderBatchList() {
    var pane = document.getElementById('bp-batch-list-pane');
    if (!pane) return;

    var search = _batchSearch.toLowerCase().trim();
    var filtered = _batchesData.filter(function (b) {
      if (!search) return true;
      var hay = (String(b.batch_id) + ' ' + String(b.product_name || '') + ' ' +
        String(getCustomerDisplayName(b) || b.customer_name || '') + ' ' + String(b.vessel_id || '')).toLowerCase();
      return hay.indexOf(search) !== -1;
    });
    if (_batchProductFilter) {
      filtered = filtered.filter(function (b) {
        return b.product_name === _batchProductFilter;
      });
    }

    // First render: build the persistent shell (sub-tabs + filter bar + search row + results container)
    // The shell is only created when #bp-batch-results doesn't exist in the DOM.
    if (!document.getElementById('bp-batch-results')) {
      var shellHtml = '<div class="bp-panel-inner">';

      // Sub-tabs: Batches | Schedules
      shellHtml += '<div class="bp-batch-subtabs">';
      shellHtml += '<button type="button" class="bp-batch-subtab' + (_batchSubView === 'batches' ? ' bp-batch-subtab--active' : '') + '" data-subview="batches">Batches</button>';
      shellHtml += '<button type="button" class="bp-batch-subtab' + (_batchSubView === 'schedules' ? ' bp-batch-subtab--active' : '') + '" data-subview="schedules">Schedules</button>';
      shellHtml += '</div>';

      // Batch list content wrapper
      shellHtml += '<div id="bp-batch-list-content"' + (_batchSubView !== 'batches' ? ' style="display:none;"' : '') + '>';

      // Phase 95 (D-14): dashboard click-through banner slot (filled on every render)
      shellHtml += '<div id="bp-drill-banner-slot"></div>';

      // Filter bar
      shellHtml += '<div class="bp-batch-filters">';
      var filterOpts = [
        { val: 'pending', label: 'Pending' },
        { val: 'active', label: 'Active' },
        { val: 'primary', label: 'Primary' },
        { val: 'secondary', label: 'Secondary' },
        { val: 'complete', label: 'Complete' },
        { val: 'readyToBottle', label: 'Ready to Bottle' },
        { val: 'unlinked', label: 'Unlinked' },
        { val: 'needsType', label: 'Needs a type' }
      ];
      var pendingCount = _allBatchesData.filter(function (b) {
        return String(b.status || '').toLowerCase() === 'pending';
      }).length;
      // Count from the SAME intersection the rows use (readyToBottleRows), not the raw
      // _dashSummary.readyToBottle length — otherwise a readyToBottle batch_id absent
      // from _allBatchesData (data gap / cleared cache) inflates the chip above the
      // number of rows actually rendered (WR-03).
      var readyToBottleCount = readyToBottleRows().length;
      filterOpts.forEach(function (f) {
        var active = _batchStatusFilter === f.val ? ' bp-filter-btn--active' : '';
        var count = f.val === 'pending' ? pendingCount : (f.val === 'readyToBottle' ? readyToBottleCount : 0);
        var badge = ((f.val === 'pending' || f.val === 'readyToBottle') && count > 0)
          ? ' <span style="display:inline-block;min-width:16px;padding:0 5px;border-radius:8px;background:#e67e22;color:#fff;font-size:0.72rem;font-weight:700;line-height:16px;text-align:center;">' + count + '</span>'
          : '';
        // Phase 90 (D-06/D-24): the Unlinked count is always shown, including (0).
        var chipLabel = f.val === 'unlinked' ? f.label + ' (' + filterBatchesByUnlinked(_allBatchesData).length + ')' : f.label;
        // Phase 94 (D-07): same always-shown count as Unlinked, no badge.
        if (f.val === 'needsType') chipLabel = f.label + ' (' + needsTypeRows().length + ')';
        shellHtml += '<button type="button" class="bp-filter-btn' + active + '" data-status="' + f.val + '">' + chipLabel + badge + '</button>';
      });
      shellHtml += '<select id="bp-batch-product-filter" class="bp-filter-select"><option value="">All Products</option></select>';
      shellHtml += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-pull-from-zoho">Pull from Zoho</button>';
      shellHtml += '</div>';

      // Search + new batch + view toggle
      shellHtml += '<div class="bp-batch-search-row">';
      shellHtml += '<input type="search" class="bp-search-input" id="bp-batch-search" placeholder="Search batches\u2026" value="' + escapeHTML(_batchSearch) + '" autocomplete="off" inputmode="search">';
      shellHtml += '<button type="button" class="bp-view-toggle btn-secondary bp-btn-sm" id="bp-batch-view-toggle" title="' + (_batchViewMode === 'cards' ? 'Switch to table view' : 'Switch to card view') + '">' + (_batchViewMode === 'cards' ? '\u2630' : '\u229e') + '</button>';
      shellHtml += '<button type="button" class="btn bp-new-batch-btn" id="bp-list-new-batch">+ New Batch</button>';
      shellHtml += '</div>';

      // Results container — updated on every render
      shellHtml += '<div id="bp-batch-results"></div>';
      shellHtml += '</div>'; // close #bp-batch-list-content

      // Schedules sub-view
      shellHtml += '<div id="bp-schedules-list"' + (_batchSubView !== 'schedules' ? ' style="display:none;"' : '') + '></div>';

      shellHtml += '</div>'; // close .bp-panel-inner
      pane.innerHTML = shellHtml;

      // Attach search listener ONCE — reads value from the persistent input
      var searchInput = document.getElementById('bp-batch-search');
      if (searchInput) {
        searchInput.addEventListener('input', function () {
          clearTimeout(_batchSearchTimer);
          _batchSearchTimer = setTimeout(function () {
            _batchSearchTimer = null;
            _batchSearch = searchInput.value;
            renderBatchList();
          }, 200);
        });
      }

      // Product filter dropdown — attached ONCE
      var productFilter = document.getElementById('bp-batch-product-filter');
      if (productFilter) {
        productFilter.addEventListener('change', function () {
          _batchProductFilter = productFilter.value;
          renderBatchList();
        });
      }

      // New batch button — attached ONCE
      var newBatchBtn = document.getElementById('bp-list-new-batch');
      if (newBatchBtn) newBatchBtn.addEventListener('click', openCreateSheet);

      // Pull from Zoho button — attached ONCE
      var pullFromZohoBtn = document.getElementById('bp-pull-from-zoho');
      if (pullFromZohoBtn) pullFromZohoBtn.addEventListener('click', openPullFromZohoSheet);

      // Filter button + view toggle + batch card/row clicks handled by delegation
      // on #bp-batch-list-pane (see initDelegation)
    }

    // Update filter button active states (they persist in the shell)
    Array.prototype.forEach.call(pane.querySelectorAll('.bp-filter-btn'), function (btn) {
      btn.classList.toggle('bp-filter-btn--active', btn.getAttribute('data-status') === _batchStatusFilter);
      // The shell persists across renders, so keep the Unlinked count live.
      if (btn.getAttribute('data-status') === 'unlinked') {
        btn.textContent = 'Unlinked (' + filterBatchesByUnlinked(_allBatchesData).length + ')';
      }
      if (btn.getAttribute('data-status') === 'needsType') {
        btn.textContent = 'Needs a type (' + needsTypeRows().length + ')';
      }
    });

    // Update product filter dropdown options
    var productFilterEl = document.getElementById('bp-batch-product-filter');
    if (productFilterEl) {
      var productNames = [];
      _allBatchesData.forEach(function (b) {
        if (b.product_name && productNames.indexOf(b.product_name) === -1) {
          productNames.push(b.product_name);
        }
      });
      productNames.sort();
      var optHtml = '<option value="">All Products</option>';
      productNames.forEach(function (p) {
        optHtml += '<option value="' + escapeHTML(p) + '"' + (_batchProductFilter === p ? ' selected' : '') + '>' + escapeHTML(p) + '</option>';
      });
      productFilterEl.innerHTML = optHtml;
      productFilterEl.style.display = productNames.length > 1 ? '' : 'none';
    }

    // Update view toggle icon/title
    var viewToggle = document.getElementById('bp-batch-view-toggle');
    if (viewToggle) {
      viewToggle.title = _batchViewMode === 'cards' ? 'Switch to table view' : 'Switch to card view';
      viewToggle.textContent = _batchViewMode === 'cards' ? '\u2630' : '\u229e';
    }

    // Phase 95 (D-14): banner above the chips; label escaped (T-95-26)
    var bannerSlot = document.getElementById('bp-drill-banner-slot');
    if (bannerSlot) {
      if (_dashDrill) {
        bannerSlot.innerHTML = '<div class="bp-drill-banner" role="status"><span class="bp-drill-banner-text">' + escapeHTML(_dashDrill.label) + '</span>' +
          '<button type="button" class="bp-drill-banner-close" data-action="clear-dash-drill" aria-label="Clear dashboard filter">\u2715</button></div>';
      } else {
        bannerSlot.innerHTML = '';
      }
    }

    // Always: update just the results container
    var resultsEl = document.getElementById('bp-batch-results');
    if (!resultsEl) return;

    var resultsHtml = '';
    if (_dashDrill && filtered.length > 0) {
      resultsHtml += '<h3 class="bp-drill-heading">' + filtered.length + (filtered.length === 1 ? ' batch shown' : ' batches shown') + '</h3>';
    }
    if (filtered.length === 0) {
      if (_dashDrill) {
        resultsHtml += '<p class="bp-empty">No batches in this set any more.</p>';
      } else if (_batchStatusFilter === 'pending') {
        resultsHtml += '<p class="bp-empty"><strong>No pending batches</strong><br>Kiosk sales with Maker&#39;s Fee and kiosk recipe sales will appear here automatically.</p>';
      } else if (_batchStatusFilter === 'unlinked') {
        resultsHtml += '<p class="bp-empty"><strong>Every batch is linked</strong><br>Batches without an invoice are marked Internal.</p>';
      } else if (_batchStatusFilter === 'needsType') {
        resultsHtml += '<p class="bp-empty">Every batch has a type.</p>';
      } else {
        resultsHtml += '<p class="bp-empty">No batches found.</p>';
      }
    } else if (_batchViewMode === 'table') {
      // Compact table view
      var today = todayStr();
      var sortedFiltered = filtered.slice().sort(function (a, b) {
        var av, bv;
        if (_batchTableSortCol === 'days') {
          av = a.start_date ? Date.now() - new Date(a.start_date) : 0;
          bv = b.start_date ? Date.now() - new Date(b.start_date) : 0;
          return (av - bv) * _batchTableSortDir;
        }
        av = String(a[_batchTableSortCol] || '').toLowerCase();
        bv = String(b[_batchTableSortCol] || '').toLowerCase();
        return av < bv ? -_batchTableSortDir : av > bv ? _batchTableSortDir : 0;
      });
      function batchSortIcon(col) {
        if (_batchTableSortCol !== col) return '<span class="bp-sort-icon">&#8645;</span>';
        return '<span class="bp-sort-icon">' + (_batchTableSortDir === 1 ? '&#8593;' : '&#8595;') + '</span>';
      }
      resultsHtml += '<table class="bp-batch-table"><thead><tr>';
      resultsHtml += '<th class="bp-sort-th' + (_batchTableSortCol === 'batch_id' ? ' bp-sort-active' : '') + '" data-sort="batch_id">Batch ' + batchSortIcon('batch_id') + '</th>';
      resultsHtml += '<th class="bp-sort-th' + (_batchTableSortCol === 'product_name' ? ' bp-sort-active' : '') + '" data-sort="product_name">Product ' + batchSortIcon('product_name') + '</th>';
      resultsHtml += '<th class="bp-sort-th' + (_batchTableSortCol === 'customer_name' ? ' bp-sort-active' : '') + '" data-sort="customer_name">Customer ' + batchSortIcon('customer_name') + '</th>';
      resultsHtml += '<th>Vessel / Loc</th>';
      resultsHtml += '<th class="bp-sort-th' + (_batchTableSortCol === 'status' ? ' bp-sort-active' : '') + '" data-sort="status">Stage ' + batchSortIcon('status') + '</th>';
      resultsHtml += '<th class="bp-sort-th' + (_batchTableSortCol === 'days' ? ' bp-sort-active' : '') + '" data-sort="days">Days ' + batchSortIcon('days') + '</th>';
      resultsHtml += '</tr></thead><tbody>';
      sortedFiltered.forEach(function (b) {
        var statusKey = String(b.status || '').toLowerCase();
        var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
        var statusColor = STATUS_COLORS[statusKey] || 'info';
        var isSelected = b.batch_id === _selectedBatchId;
        var overdueCount = 0;
        for (var oi = 0; oi < _upcomingTasks.length; oi++) {
          var ot = _upcomingTasks[oi];
          if (ot.batch_id !== b.batch_id) continue;
          var done = ot.completed === true || ot.completed === 'TRUE' || ot.completed === '1';
          if (done) continue;
          var due = ot.due_date ? String(ot.due_date).substring(0, 10) : '';
          if (due && due < today) overdueCount++;
        }
        var days;
        if (isFutureStart(b.start_date)) {
          // Not started yet \u2014 show the scheduled start instead of a negative day count.
          days = '<span class="bp-batch-scheduled bp-batch-scheduled--cell"><span class="bp-batch-scheduled-icon" aria-hidden="true">\u25f7</span>' + escapeHTML(fmtShortDate(b.start_date)) + '</span>';
        } else {
          days = b.start_date ? Math.floor((Date.now() - new Date(b.start_date)) / 86400000) : '\u2014';
        }
        var loc = [b.vessel_id, b.shelf_id && b.bin_id ? b.shelf_id + '-' + b.bin_id : (b.shelf_id || b.bin_id || '')].filter(Boolean).join(' ');
        var rowCls = (isSelected ? 'bp-batch-tr--selected' : '') + (overdueCount > 0 ? ' bp-batch-tr--urgent' : '');
        var unitLabel = computeUnitLabel(b, _allBatchesData);
        resultsHtml += '<tr class="' + rowCls + '" data-batch-id="' + escapeHTML(b.batch_id) + '">';
        resultsHtml += '<td class="bp-batch-tr-id">' + escapeHTML(b.batch_id) + (overdueCount > 0 ? ' <span class="bp-urgent-dot">\u25cf</span>' : '') + '</td>';
        resultsHtml += '<td>' + escapeHTML(b.product_name || b.product_sku || '\u2014') + (unitLabel ? ' <span class="bp-batch-unit">\u2014 ' + escapeHTML(unitLabel) + '</span>' : '') + '</td>';
        resultsHtml += '<td>' + escapeHTML(getCustomerDisplayName(b) || '\u2014') + '</td>';
        resultsHtml += '<td>' + escapeHTML(loc || '\u2014') + '</td>';
        resultsHtml += '<td><span class="bp-status-badge bp-status-badge--' + statusColor + '" style="font-size:0.72rem;padding:1px 6px;">' + escapeHTML(statusLabel) + '</span>';
        if (shouldShowKioskBadge(b.source, statusKey)) {
          resultsHtml += ' <span class="bp-kiosk-badge">Kiosk</span>';
        }
        if (shouldShowInternalBadge(b.source)) {
          resultsHtml += ' <span class="bp-source-badge bp-source-badge--internal">Internal</span>';
        }
        resultsHtml += '</td>';
        resultsHtml += '<td>' + days + '</td>';
        resultsHtml += '</tr>';
      });
      resultsHtml += '</tbody></table>';
    } else {
      // Card view (default)
      resultsHtml += '<div class="bp-batch-cards">';
      filtered.forEach(function (b) {
        var statusKey = String(b.status || '').toLowerCase();
        var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
        var statusColor = STATUS_COLORS[statusKey] || 'info';
        var tasksDone = parseInt(b.tasks_done) || 0;
        var tasksTotal = parseInt(b.tasks_total) || 0;
        var isSelected = b.batch_id === _selectedBatchId;

        var today = todayStr();
        var overdueCount = 0;
        for (var oi = 0; oi < _upcomingTasks.length; oi++) {
          var ot = _upcomingTasks[oi];
          if (ot.batch_id !== b.batch_id) continue;
          var done = ot.completed === true || ot.completed === 'TRUE' || ot.completed === '1';
          if (done) continue;
          var due = ot.due_date ? String(ot.due_date).substring(0, 10) : '';
          if (due && due < today) overdueCount++;
        }
        var cardCls = 'bp-batch-card' +
          (isSelected ? ' bp-batch-card--selected' : '') +
          (overdueCount > 0 ? ' bp-batch-card--urgent' : '');
        var cardUnitLabel = computeUnitLabel(b, _allBatchesData);

        resultsHtml += '<div class="' + cardCls + '" data-batch-id="' + escapeHTML(b.batch_id) + '">';
        resultsHtml += '<div class="bp-batch-card-header">';
        resultsHtml += '<span class="bp-batch-id">' + escapeHTML(b.batch_id) + '</span>';
        resultsHtml += '<span class="bp-status-badge bp-status-badge--' + statusColor + '">' + escapeHTML(statusLabel) + '</span>';
        if (shouldShowKioskBadge(b.source, statusKey)) {
          resultsHtml += ' <span class="bp-kiosk-badge">Kiosk</span>';
        }
        if (shouldShowInternalBadge(b.source)) {
          resultsHtml += ' <span class="bp-source-badge bp-source-badge--internal">Internal</span>';
        }
        resultsHtml += '</div>';
        resultsHtml += '<div class="bp-batch-card-name">' + escapeHTML(b.product_name || b.product_sku || '\u2014') +
          (cardUnitLabel ? ' <span class="bp-batch-unit">\u2014 ' + escapeHTML(cardUnitLabel) + '</span>' : '') + '</div>';
        if (getCustomerDisplayName(b)) resultsHtml += '<div class="bp-batch-card-customer">' + escapeHTML(getCustomerDisplayName(b)) + '</div>';
        if (isFutureStart(b.start_date)) {
          resultsHtml += '<div class="bp-batch-scheduled"><span class="bp-batch-scheduled-icon" aria-hidden="true">\u25f7</span>Starts ' + escapeHTML(fmtShortDate(b.start_date)) + '</div>';
        }
        resultsHtml += '<div class="bp-batch-card-footer">';
        if (tasksTotal > 0) resultsHtml += '<span class="bp-task-progress">' + tasksDone + '/' + tasksTotal + ' tasks</span>';
        var loc = [b.shelf_id, b.bin_id, b.vessel_id].filter(Boolean).join(' \u00b7 ');
        if (loc) resultsHtml += '<span class="bp-batch-loc">' + escapeHTML(loc) + '</span>';
        resultsHtml += '</div>';
        resultsHtml += '</div>';
      });
      resultsHtml += '</div>';
    }
    resultsEl.innerHTML = resultsHtml;

    // Improvement 3: Preload top 3 batch details in background (once after initial list load)
    if (!_batchDetailPreloaded) {
      _batchDetailPreloaded = true;
      setTimeout(function () {
        var cards = pane.querySelectorAll('.bp-batch-card, tr[data-batch-id]');
        var preloadCount = Math.min(cards.length, 3);
        for (var pi = 0; pi < preloadCount; pi++) {
          (function (bid) {
            var cacheKey = 'sv-bp-batch-' + bid;
            try {
              var raw = sessionStorage.getItem(cacheKey);
              if (raw && (Date.now() - JSON.parse(raw).ts < 120000)) return;
            } catch (e) {}
            adminApiGet('get_batch', { batch_id: bid })
              .then(function (result) {
                try { sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: result.data || {} })); } catch (e2) {}
              })
              .catch(function () {});
          })(cards[pi].getAttribute('data-batch-id'));
        }
      }, 500);
    }
  }

  // Improvement 2: Show partial detail immediately from list data while full detail loads
  function renderPartialBatchDetail(b) {
    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (!detailPane) return;
    detailPane.style.display = '';

    var statusKey = String(b.status || '').toLowerCase();
    var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
    var statusColor = STATUS_COLORS[statusKey] || 'info';

    var html = '<div class="bp-detail-content">';

    // Header — matches renderBatchDetail structure
    html += '<div class="bp-detail-header">';
    html += '<button type="button" class="btn-secondary bp-btn-sm bp-detail-back" id="bp-detail-back" aria-label="Back to batch list">\u2190</button>';
    html += '<div class="bp-detail-title-group">';
    html += '<span class="bp-detail-batch-id">' + escapeHTML(b.batch_id || '') + '</span>';
    html += '<span class="bp-status-badge bp-status-badge--' + statusColor + '">' + escapeHTML(statusLabel) + '</span>';
    html += '</div>';
    html += '</div>';

    // Info grid — matches renderBatchDetail structure
    html += '<div class="bp-detail-info">';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Product</span><span>' + escapeHTML(b.product_name || b.product_sku || '\u2014') + '</span></div>';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Customer</span><span>' + escapeHTML(getCustomerDisplayName(b) || '\u2014') + '</span></div>';
    var loc = [b.vessel_id, b.shelf_id, b.bin_id].filter(Boolean).join(' \u00b7 ');
    if (loc) html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Location</span><span>' + escapeHTML(loc) + '</span></div>';
    if (b.start_date) html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Start</span><span>' + fmtDate(b.start_date) + '</span></div>';
    html += '</div>';

    // Loading skeletons for tasks, readings, notes
    html += '<div class="bp-detail-section"><div class="bp-detail-section-title">Tasks</div>';
    html += '<div class="bp-skeleton-block" style="height:80px;"></div></div>';
    html += '<div class="bp-detail-section"><div class="bp-detail-section-title">Measurements</div>';
    html += '<div class="bp-skeleton-block" style="height:60px;"></div></div>';

    html += '</div>';
    detailPane.innerHTML = html;

    // Back button (portrait) — so user can navigate away while loading
    var backBtn = document.getElementById('bp-detail-back');
    if (backBtn) backBtn.addEventListener('click', closeBatchDetail);

    // On mobile/portrait, scroll to detail pane
    if (window.innerWidth < 768) {
      detailPane.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function selectBatch(batchId) {
    // If the detail pane is already showing this exact batch (user tapped same card twice),
    // just ensure it is visible and skip the redundant network fetch.
    if (_detailBatchId === batchId && _selectedBatchId === batchId) {
      var existingDetail = document.getElementById('bp-batch-detail-pane');
      if (existingDetail && existingDetail.style.display !== 'none' &&
          existingDetail.querySelector('.bp-detail-content')) {
        return;
      }
    }

    _selectedBatchId = batchId;
    _chartCache = {};   // invalidate cached chart for previous batch

    // Update selected highlight in list
    Array.prototype.forEach.call(document.querySelectorAll('.bp-batch-card'), function (card) {
      card.classList.toggle('bp-batch-card--selected', card.getAttribute('data-batch-id') === batchId);
    });

    // Check sessionStorage cache (2-minute TTL)
    var BATCH_CACHE_KEY = 'sv-bp-batch-' + batchId;
    var BATCH_CACHE_TTL = 120000; // 2 minutes
    var cached = null;
    try {
      var raw = sessionStorage.getItem(BATCH_CACHE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < BATCH_CACHE_TTL) cached = parsed.data;
      }
    } catch (e) {}

    // Improvement 2: Show partial detail immediately from list data (when not cached)
    if (!cached) {
      var listBatch = null;
      for (var i = 0; i < _allBatchesData.length; i++) {
        if (_allBatchesData[i].batch_id === batchId) { listBatch = _allBatchesData[i]; break; }
      }
      if (listBatch) {
        renderPartialBatchDetail(listBatch);
      }
    }

    // Show detail pane with skeleton (or cached content)
    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (detailPane) {
      detailPane.style.display = '';
      if (!cached && !document.querySelector('.bp-detail-content')) {
        detailPane.innerHTML = '<div class="bp-detail-content"><div class="bp-skeleton-block"></div>' +
          '<div class="bp-skeleton-block" style="margin-top:10px;height:140px;"></div></div>';
      }
      // Portrait: trigger slide-in and inert the list so focus can't escape behind the overlay
      setTimeout(function () {
        detailPane.classList.add('bp-detail-slide-in');
        var isPortrait = window.innerWidth <= 900 || (window.matchMedia && window.matchMedia('(orientation: portrait)').matches);
        var listPane = document.getElementById('bp-batch-list-pane');
        if (listPane && isPortrait) listPane.setAttribute('inert', '');
      }, 10);
    }

    if (cached) {
      // Render from cache immediately
      renderBatchDetail(cached);
      // Then refresh in background silently
      adminApiGet('get_batch', { batch_id: batchId })
        .then(function (result) {
          var data = result.data || {};
          try { sessionStorage.setItem(BATCH_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
          // Only re-render if this batch is still selected
          if (_selectedBatchId === batchId) {
            renderBatchDetail(data);
          }
        })
        .catch(function () {}); // silently ignore background refresh failures
      return;
    }

    var vesselProm = (_vesselsData && Date.now() - _vesselsCacheTime < CACHE_TTL)
      ? Promise.resolve()
      : adminApiGet('get_vessels').then(function (r) {
          _vesselsData = (r.data && r.data.vessels) || [];
          _vesselsCacheTime = Date.now();
          _vesselsMap = {};
          _vesselsData.forEach(function (v) { _vesselsMap[String(v.vessel_id)] = v; });
        }).catch(function () { _vesselsData = []; _vesselsCacheTime = Date.now(); _vesselsMap = {}; });

    // Improvement 1: Use preload promise if touchstart already started fetching this batch
    var batchProm;
    if (_preloadBatchId === batchId && _preloadPromise) {
      batchProm = _preloadPromise;
      _preloadBatchId = null;
      _preloadPromise = null;
    } else {
      batchProm = adminApiGet('get_batch', { batch_id: batchId });
    }

    Promise.all([batchProm, vesselProm])
      .then(function (results) {
        var data = results[0].data || {};
        try { sessionStorage.setItem(BATCH_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
        renderBatchDetail(data);
      })
      .catch(function (err) {
        var dp = document.getElementById('bp-batch-detail-pane');
        if (dp) dp.innerHTML = '<div class="bp-detail-content"><p class="bp-empty">Failed: ' + escapeHTML(err.message) + '</p></div>';
      });
  }

  // subText (optional, Phase 90-03): muted second line under the message.
  function showConfirmSheet(message, okLabel, okCls, onOk, subText) {
    var sheet = document.getElementById('bp-confirm-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'bp-confirm-sheet';
      sheet.className = 'bp-confirm-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.innerHTML =
        '<div class="bp-confirm-sheet-inner">' +
        '<p class="bp-confirm-sheet-msg" id="bp-confirm-sheet-msg"></p>' +
        '<div class="bp-confirm-sheet-actions">' +
        '<button type="button" id="bp-confirm-sheet-ok" class="btn"></button>' +
        '<button type="button" id="bp-confirm-sheet-cancel" class="btn-secondary">Cancel</button>' +
        '</div></div>';
      document.body.appendChild(sheet);
    }
    var msgEl = document.getElementById('bp-confirm-sheet-msg');
    msgEl.textContent = message;
    if (subText) {
      var subEl = document.createElement('span');
      subEl.className = 'bp-confirm-sheet-sub';
      subEl.style.display = 'block';
      subEl.textContent = subText;
      msgEl.appendChild(subEl);
    }
    var okBtn = document.getElementById('bp-confirm-sheet-ok');
    okBtn.textContent = okLabel;
    okBtn.className = 'btn ' + (okCls || '');

    function hide() {
      sheet.classList.remove('bp-confirm-sheet--visible');
      okBtn.removeEventListener('click', handleOk);
      document.getElementById('bp-confirm-sheet-cancel').removeEventListener('click', hide);
      sheet.removeEventListener('click', handleBackdrop);
    }
    function handleOk() { hide(); onOk(); }
    function handleBackdrop(e) { if (e.target === sheet) hide(); }

    okBtn.addEventListener('click', handleOk);
    document.getElementById('bp-confirm-sheet-cancel').addEventListener('click', hide);
    sheet.addEventListener('click', handleBackdrop);
    sheet.classList.add('bp-confirm-sheet--visible');
  }

  // ===== Pull from Zoho (Phase 29.3) =====

  // Hide and destroy the pull sheet (allows re-creation on next open).
  function hidePullSheet() {
    var sheet = document.getElementById('bp-pull-sheet');
    if (sheet) {
      sheet.classList.remove('bp-confirm-sheet--visible');
      sheet.removeEventListener('click', _pullSheetBackdropHandler);
    }
  }

  // Backdrop click handler stored so it can be removed on hide.
  function _pullSheetBackdropHandler(e) {
    if (e.target === document.getElementById('bp-pull-sheet')) {
      hidePullSheet();
    }
  }

  // Render (or re-render) the candidate list inside the pull sheet inner div.
  function renderPullCandidates(candidates) {
    var inner = document.getElementById('bp-pull-sheet-inner');
    if (!inner) return;

    var heading = '<p style="font-size:1.05rem;font-weight:600;margin:0 0 12px;">' +
      'Found ' + candidates.length + ' invoice' + (candidates.length !== 1 ? 's' : '') +
      ' to import:</p>';

    var rows = '';
    for (var i = 0; i < candidates.length; i++) {
      rows += buildPullCandidateRowHtml(candidates[i]);
    }

    inner.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
      '<strong style="font-size:1.1rem;">Pull from Zoho</strong>' +
      '<button type="button" id="bp-pull-sheet-close" class="btn-secondary bp-btn-sm" aria-label="Close">&#x2715;</button>' +
      '</div>' +
      '<div class="bp-pull-single-import" style="display:flex;gap:8px;align-items:center;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border-subtle);">' +
      '<input type="text" id="bp-pull-import-number" placeholder="INV-000000 or SO-000000" class="bp-search-input" style="flex:1;min-width:0;" autocomplete="off" autocapitalize="characters" inputmode="text">' +
      '<button type="button" id="bp-pull-import-btn" class="btn bp-btn-sm">Import</button>' +
      '</div>' +
      '<div id="bp-pull-candidates">' +
      heading + rows +
      '</div>' +
      '<div class="bp-confirm-sheet-actions" style="margin-top:16px;">' +
      '<button type="button" id="bp-pull-create-btn" class="btn bp-confirm-btn--primary">Create Batches</button>' +
      '<button type="button" id="bp-pull-cancel-btn" class="btn-secondary">Cancel</button>' +
      '</div>';

    // Wire close/cancel buttons
    var closeBtn = document.getElementById('bp-pull-sheet-close');
    if (closeBtn) closeBtn.addEventListener('click', hidePullSheet);
    var cancelBtn = document.getElementById('bp-pull-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', hidePullSheet);

    // Wire single-import button
    var importBtn = document.getElementById('bp-pull-import-btn');
    if (importBtn) {
      importBtn.addEventListener('click', function () {
        var numInput = document.getElementById('bp-pull-import-number');
        var num = numInput ? numInput.value.trim() : '';
        if (!isValidImportNumber(num)) {
          showToast('Enter a valid INV-XXXXXX or SO-XXXXXX number', 'warn');
          return;
        }
        importBtn.disabled = true;
        importBtn.textContent = 'Scanning…';
        fetch(mwUrl() + '/api/batch/scan-invoices?number=' + encodeURIComponent(num), {
          method: 'GET',
          credentials: 'include'
        })
          .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
          .then(function (resp) {
            importBtn.disabled = false;
            importBtn.textContent = 'Import';
            if (resp.status !== 200) {
              showToast('Scan failed: ' + escapeHTML((resp.data && resp.data.message) || 'server error'), 'error');
              return;
            }
            var found = (resp.data && resp.data.candidates) || [];
            if (found.length === 0) {
              showToast('No importable invoice found for ' + escapeHTML(num), 'info');
              return;
            }
            renderPullCandidates(found);
          })
          .catch(function () {
            importBtn.disabled = false;
            importBtn.textContent = 'Import';
            showToast('Scan failed — check connection', 'error');
          });
      });
    }

    // Wire Create Batches button
    var createBtn = document.getElementById('bp-pull-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        // Collect checked candidates
        var selected = [];
        var checkboxes = document.querySelectorAll('#bp-pull-candidates .bp-pull-candidate-row');
        for (var ci = 0; ci < candidates.length; ci++) {
          var row = checkboxes[ci];
          var chk = row ? row.querySelector('.bp-pull-candidate-chk') : null;
          if (chk && chk.checked) selected.push(candidates[ci]);
        }
        if (selected.length === 0) {
          showToast('Select at least one invoice to import', 'warn');
          return;
        }
        createBtn.disabled = true;
        createBtn.textContent = 'Creating…';
        var payload = buildBulkCreatePayload(selected);
        fetch(mwUrl() + '/api/batch/bulk-create', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
          .then(function (resp) {
            createBtn.disabled = false;
            createBtn.textContent = 'Create Batches';
            if (resp.status !== 200) {
              showToast('Bulk create failed: ' + escapeHTML((resp.data && resp.data.message) || 'server error'), 'error');
              return;
            }
            var results = (resp.data && resp.data.results) || [];
            var summary = summarizeBulkResults(results);
            if (summary.failCount === 0) {
              showToast(summary.message, 'success');
              hidePullSheet();
            } else if (summary.okCount > 0) {
              showToast(summary.message, 'warn');
              hidePullSheet();
            } else {
              showToast(summary.message, 'error');
            }
            // Bust cache and reload batch list after any successful creates.
            // Force the filter to 'pending' so freshly created batches are immediately visible.
            if (summary.okCount > 0) {
              setBatchStatusFilterProgrammatic('pending');
              _batchesLoaded = false;
              _allBatchesData = [];
              _batchesLoadTime = 0;
              loadBatches();
            }
          })
          .catch(function () {
            createBtn.disabled = false;
            createBtn.textContent = 'Create Batches';
            showToast('Failed to create batches — check connection', 'error');
          });
      });
    }
  }

  // Open the Pull from Zoho sheet with Scan + single-import controls.
  // Shows an initial loading state, fetches /api/batch/scan-invoices, then renders candidates.
  function openPullFromZohoSheet() {
    var sheet = document.getElementById('bp-pull-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'bp-pull-sheet';
      sheet.className = 'bp-confirm-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.innerHTML = '<div class="bp-confirm-sheet-inner" id="bp-pull-sheet-inner"></div>';
      document.body.appendChild(sheet);
    }
    // WR-02 fix: remove any prior registration before re-adding to prevent accumulation
    // on rapid re-opens (sheet element is reused; hidePullSheet only removes one registration).
    sheet.removeEventListener('click', _pullSheetBackdropHandler);
    sheet.addEventListener('click', _pullSheetBackdropHandler);
    sheet.classList.add('bp-confirm-sheet--visible');

    var inner = document.getElementById('bp-pull-sheet-inner');
    if (inner) {
      inner.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
        '<strong style="font-size:1.1rem;">Pull from Zoho</strong>' +
        '<button type="button" id="bp-pull-sheet-close" class="btn-secondary bp-btn-sm" aria-label="Close">&#x2715;</button>' +
        '</div>' +
        '<div class="bp-pull-single-import" style="display:flex;gap:8px;align-items:center;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border-subtle);">' +
        '<input type="text" id="bp-pull-import-number" placeholder="INV-000000 or SO-000000" class="bp-search-input" style="flex:1;min-width:0;" autocomplete="off" autocapitalize="characters" inputmode="text">' +
        '<button type="button" id="bp-pull-import-btn" class="btn bp-btn-sm">Import</button>' +
        '</div>' +
        '<p id="bp-pull-scan-status" style="color:var(--ink-muted);font-size:0.95rem;">Scanning recent Zoho invoices…</p>' +
        '<div class="bp-confirm-sheet-actions" style="margin-top:16px;">' +
        '<button type="button" id="bp-pull-cancel-btn" class="btn-secondary">Cancel</button>' +
        '</div>';

      var closeBtn = document.getElementById('bp-pull-sheet-close');
      if (closeBtn) closeBtn.addEventListener('click', hidePullSheet);
      var cancelBtn = document.getElementById('bp-pull-cancel-btn');
      if (cancelBtn) cancelBtn.addEventListener('click', hidePullSheet);

      // Wire single-import button in initial state (before scan result)
      var importBtn = document.getElementById('bp-pull-import-btn');
      if (importBtn) {
        importBtn.addEventListener('click', function () {
          var numInput = document.getElementById('bp-pull-import-number');
          var num = numInput ? numInput.value.trim() : '';
          if (!isValidImportNumber(num)) {
            showToast('Enter a valid INV-XXXXXX or SO-XXXXXX number', 'warn');
            return;
          }
          importBtn.disabled = true;
          importBtn.textContent = 'Scanning…';
          fetch(mwUrl() + '/api/batch/scan-invoices?number=' + encodeURIComponent(num), {
            method: 'GET',
            credentials: 'include'
          })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
            .then(function (resp) {
              importBtn.disabled = false;
              importBtn.textContent = 'Import';
              if (resp.status !== 200) {
                showToast('Scan failed: ' + escapeHTML((resp.data && resp.data.message) || 'server error'), 'error');
                return;
              }
              var found = (resp.data && resp.data.candidates) || [];
              if (found.length === 0) {
                showToast('No importable invoice found for ' + escapeHTML(num), 'info');
                return;
              }
              renderPullCandidates(found);
            })
            .catch(function () {
              importBtn.disabled = false;
              importBtn.textContent = 'Import';
              showToast('Scan failed — check connection', 'error');
            });
        });
      }
    }

    // Kick off the background scan
    fetch(mwUrl() + '/api/batch/scan-invoices', {
      method: 'GET',
      credentials: 'include'
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (resp) {
        if (resp.status !== 200) {
          var statusEl = document.getElementById('bp-pull-scan-status');
          if (statusEl) statusEl.textContent = 'Scan failed: ' + ((resp.data && resp.data.message) || 'server error');
          showToast('Scan failed: ' + escapeHTML((resp.data && resp.data.message) || 'server error'), 'error');
          return;
        }
        var candidates = (resp.data && resp.data.candidates) || [];
        if (candidates.length === 0) {
          var statusEl2 = document.getElementById('bp-pull-scan-status');
          if (statusEl2) statusEl2.textContent = 'No new invoices found to import.';
          showToast('No new invoices found to import', 'info');
          return;
        }
        renderPullCandidates(candidates);
      })
      .catch(function () {
        var statusEl3 = document.getElementById('bp-pull-scan-status');
        if (statusEl3) statusEl3.textContent = 'Scan failed — check connection.';
        showToast('Scan failed — check connection', 'error');
      });
  }

  function showTransferLocationSheet(task) {
    var batchId = task.batch_id || '';
    var batch = null;
    for (var i = 0; i < _allBatchesData.length; i++) {
      if (_allBatchesData[i].batch_id === batchId) { batch = _allBatchesData[i]; break; }
    }
    var currentVessel = batch ? (batch.vessel_id || '') : '';
    var currentShelf  = batch ? (batch.shelf_id  || '') : '';
    var currentBin    = batch ? (batch.bin_id    || '') : '';

    var sheet = document.getElementById('bp-transfer-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'bp-transfer-sheet';
      sheet.className = 'bp-confirm-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      document.body.appendChild(sheet);
    }

    sheet.innerHTML =
      '<div class="bp-confirm-sheet-inner">' +
      '<p class="bp-confirm-sheet-msg">Update location for <strong>' + escapeHTML(batchId) + '</strong> after transfer?</p>' +
      '<div class="bp-vessel-wrap" style="margin-bottom:8px;">' +
      '<input type="text" id="bp-trf-vessel-text" class="bp-inline-input" placeholder="Vessel\u2026" autocomplete="off">' +
      '<button type="button" class="bp-clear-btn" id="bp-trf-vessel-clear" title="Clear vessel">\u00d7</button>' +
      '<div class="bp-vessel-dropdown" id="bp-trf-vessel-dropdown" style="display:none;"></div>' +
      '<input type="hidden" id="bp-trf-vessel-id">' +
      '</div>' +
      '<div class="bp-form-row" style="gap:8px;margin-bottom:12px;">' +
      '<input type="text" id="bp-trf-shelf" class="bp-inline-input bp-shelf-input" placeholder="Shelf" style="width:64px;" value="' + escapeHTML(currentShelf) + '">' +
      '<input type="text" id="bp-trf-bin"   class="bp-inline-input bp-bin-input"   placeholder="Bin"   style="width:64px;" value="' + escapeHTML(currentBin) + '">' +
      '</div>' +
      '<div class="bp-confirm-sheet-actions">' +
      '<button type="button" class="btn" id="bp-trf-ok">Update Location</button>' +
      '<button type="button" class="btn-secondary" id="bp-trf-skip">Skip</button>' +
      '</div></div>';

    function hide() { sheet.classList.remove('bp-confirm-sheet--visible'); }

    var vesselInput    = document.getElementById('bp-trf-vessel-text');
    var vesselDropdown = document.getElementById('bp-trf-vessel-dropdown');
    var vesselHidden   = document.getElementById('bp-trf-vessel-id');
    vesselHidden.value = currentVessel;
    if (currentVessel && _vesselsData) {
      for (var vi = 0; vi < _vesselsData.length; vi++) {
        if (String(_vesselsData[vi].vessel_id) === String(currentVessel)) {
          vesselInput.value = buildVesselLabel(_vesselsData[vi]);
          break;
        }
      }
    }
    bindVesselSearch(vesselInput, vesselDropdown, vesselHidden, currentVessel);
    bindShelfInput(document.getElementById('bp-trf-shelf'));
    bindBinInput(document.getElementById('bp-trf-bin'));

    var trfClearBtn = document.getElementById('bp-trf-vessel-clear');
    if (trfClearBtn) {
      trfClearBtn.addEventListener('click', function () {
        vesselHidden.value = '';
        vesselInput.value = '';
        vesselInput.focus();
      });
    }

    document.getElementById('bp-trf-skip').addEventListener('click', hide);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) hide(); });

    document.getElementById('bp-trf-ok').addEventListener('click', function () {
      var vessel = vesselHidden.value.trim();
      var shelf  = document.getElementById('bp-trf-shelf').value.trim();
      var bin    = document.getElementById('bp-trf-bin').value.trim();
      var okBtn  = document.getElementById('bp-trf-ok');
      okBtn.disabled = true;
      adminApiPost('update_batch', { batch_id: batchId, updates: { vessel_id: vessel, shelf_id: shelf, bin_id: bin } })
        .then(function () {
          if (batch) { batch.vessel_id = vessel; batch.shelf_id = shelf; batch.bin_id = bin; }
          hide();
          showToast('Location updated', 'success');
          afterBatchWrite(batchId, { listAffecting: true }); // bust snapshot + list cards (#3)
        })
        .catch(function (err) {
          okBtn.disabled = false;
          showToast('Failed: ' + err.message, 'error');
        });
    });

    sheet.classList.add('bp-confirm-sheet--visible');
  }

  // Phase 16: Recipe section helpers

  function buildRecipeIngredientTable(ingredients, editable) {
    if (!ingredients || !ingredients.length) return '<p style="color:var(--ink-muted);font-size:0.85rem;">No ingredients listed.</p>';
    var html = '<table class="bp-recipe-ing-table"><thead><tr>';
    html += '<th scope="col">Ingredient</th>';
    html += '<th scope="col" style="text-align:right;">Qty</th>';
    html += '<th scope="col">Unit</th></tr></thead><tbody>';
    // Grouped sections (RDISP-03, D-09..D-11). Helper reorders by section, so data-idx
    // must map to the ORIGINAL array position (via indexOf) for readIngredientTableEdits.
    var groups = (typeof groupRecipeIngredients === 'function')
      ? groupRecipeIngredients(ingredients)
      : [{ label: '', count: ingredients.length, items: ingredients }];
    groups.forEach(function (group) {
      if (group.label) {
        html += '<tr class="bp-recipe-ing-group"><td colspan="3"><strong>' + escapeHTML(group.label) + ' (' + group.count + ')</strong></td></tr>';
      }
      group.items.forEach(function (ing) {
        var i = ingredients.indexOf(ing);
        html += '<tr>';
        html += '<td>' + escapeHTML(ing.item_name || '') + '</td>';
        if (editable) {
          html += '<td style="text-align:right;"><input type="number" class="bp-inline-input bp-recipe-qty" data-idx="' + i + '" value="' + escapeHTML(String(ing.quantity || '')) + '" style="width:70px;text-align:right;" step="any" min="0"></td>';
        } else {
          html += '<td style="text-align:right;">' + escapeHTML(String(ing.quantity || '')) + '</td>';
        }
        html += '<td>' + escapeHTML(ing.unit || '') + '</td>';
        html += '</tr>';
      });
    });
    html += '</tbody></table>';
    return html;
  }

  function readIngredientTableEdits(wrap, snapIngredients) {
    var inputs = wrap.querySelectorAll('.bp-recipe-qty');
    var result = [];
    Array.prototype.forEach.call(inputs, function (input) {
      var idx = parseInt(input.getAttribute('data-idx'), 10);
      if (!isNaN(idx) && snapIngredients && snapIngredients[idx]) {
        var copy = {};
        Object.keys(snapIngredients[idx]).forEach(function (k) { copy[k] = snapIngredients[idx][k]; });
        copy.quantity = parseFloat(input.value) || 0;
        result.push(copy);
      }
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // wireAttachExpandedPanel — wires the Phase 36 controls inside
  // #bp-recipe-attach-expanded after a recipe has been resolved.
  // Called by openRecipeAttachPanel when a recipe option is selected.
  // ---------------------------------------------------------------------------
  function wireAttachExpandedPanel(b, sectionBodyEl) {
    // GAP-5: inject the expanded panel content INTO sectionBodyEl (which lives inside the
    // scrollable .bp-batch-detail-pane) so it is never clipped by
    // .bp-batches-panel { overflow:hidden }.
    // Approach (a): clone the <template id="bp-recipe-attach-expanded-tpl"> content and
    // append it into sectionBodyEl. Remove any prior injected panel first.
    var _bpAttachExpandedEl = sectionBodyEl ? sectionBodyEl.querySelector('#bp-recipe-attach-expanded-injected') : null;
    if (_bpAttachExpandedEl) _bpAttachExpandedEl.parentNode.removeChild(_bpAttachExpandedEl);

    var tpl = document.getElementById('bp-recipe-attach-expanded-tpl');
    if (tpl && sectionBodyEl) {
      var frag;
      if (tpl.content) {
        // Real <template> element (browser + jsdom ≥ 16)
        frag = tpl.content.cloneNode(true);
      } else {
        // Fallback: tpl is a regular element (jsdom < 16 or test env without template support)
        var wrapper = document.createElement('div');
        wrapper.id = 'bp-recipe-attach-expanded-injected';
        wrapper.innerHTML = tpl.innerHTML;
        frag = wrapper;
      }
      // Wrap in a container so we can find/remove it later
      if (frag.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */) {
        var container = document.createElement('div');
        container.id = 'bp-recipe-attach-expanded-injected';
        container.appendChild(frag);
        frag = container;
      }
      sectionBodyEl.appendChild(frag);
    }

    // Reset attach-flow state
    _bpModifiedIngredients = null;
    _bpScaleFactor         = 1.0;

    // Populate _bpAttachCatalog from _recipesState.catalog (may need lazy load)
    if (_recipesState.catalogLoaded) {
      _bpAttachCatalog = Array.isArray(_recipesState.catalog) ? _recipesState.catalog.slice() : [];
    } else {
      // Non-blocking: load catalog async; advisory will refresh when done
      loadIngredientCatalogForRecipes().then(function () {
        _bpAttachCatalog = _recipesState.catalog.slice();
        refreshBpStockAdvisory();
        // Update save-as-new visibility if it changed
        var sanWrap = document.getElementById('bp-save-as-new-wrap');
        if (sanWrap) sanWrap.style.display = _bpModifiedIngredients ? '' : 'none';
      }).catch(function () {});
    }

    // ---- Volume control wiring (ported from admin.js lines 11150-11190) ----
    // display/record only — BrewPad attach never charges (D-10); factor only changes the recorded target_volume_l
    var volWrap     = document.getElementById('bp-recipe-volume-wrap');
    var volInput    = document.getElementById('bp-target-volume');
    var factorInput = document.getElementById('bp-target-factor');
    var factorRdout = document.getElementById('bp-scale-factor-readout');
    var snap        = _bpResolvedRecipe ? (_bpResolvedRecipe.recipe || {}) : {};
    var baseVol     = Number(snap.batch_size_l) || 0;

    _bpTargetVolumeL = baseVol > 0 ? baseVol : null;
    _bpScaleFactor   = 1.0;

    if (volWrap) volWrap.style.display = '';
    if (baseVol > 0) {
      if (volInput) {
        volInput.value    = baseVol;
        volInput.max      = baseVol * 10;
        volInput.disabled = false;
      }
      if (factorInput) {
        factorInput.value    = '1.00';
        factorInput.max      = '10';
        factorInput.disabled = false;
      }
      if (factorRdout) factorRdout.textContent = '1.0\xd7 base ' + baseVol.toFixed(1) + ' L';
    } else {
      // D-01 no-base disable — both inputs greyed when recipe has no batch_size_l
      if (volInput)    volInput.disabled    = true;
      if (factorInput) factorInput.disabled = true;
      if (factorRdout) factorRdout.textContent = 'Set batch size (L) on this recipe to enable scaling';
    }

    // factor oninput: clamp to (0, 10], compute litres (nearest 0.5), update state + readout.
    // display/record only — NO fetch, NO quote, NO charge (D-10 / BFAC-5).
    if (factorInput) {
      factorInput.oninput = function () {
        var rawFactor = parseFloat(factorInput.value);
        if (!(rawFactor > 0)) return;  // reject ≤0 (BFAC-3)
        if (rawFactor > 10) rawFactor = 10;
        factorInput.value = rawFactor.toString();
        var roundedLitres = Math.round(rawFactor * baseVol * 2) / 2;
        if (volInput) volInput.value = roundedLitres;
        _bpTargetVolumeL = roundedLitres;
        _bpScaleFactor   = rawFactor;
        if (factorRdout) {
          factorRdout.textContent = rawFactor.toFixed(2) + '\xd7 base ' + baseVol.toFixed(1) + ' L';
        }
        refreshBpStockAdvisory();
        // No kioskScheduleRecipeQuote / recipe-quote / recipe-sale / Helcim call — D-10.
      };
    }

    if (volInput) {
      volInput.oninput = function () {
        var val = parseFloat(volInput.value) || 0;
        _bpTargetVolumeL = val > 0 ? val : null;
        var factor = (val > 0 && baseVol > 0) ? val / baseVol : 1;
        _bpScaleFactor = factor;
        // BFAC-2: sync factor input display (two-way sync)
        if (factorInput) factorInput.value = factor.toFixed(2);
        if (factorRdout) {
          factorRdout.textContent = factor.toFixed(2) + '\xd7 base ' + baseVol.toFixed(1) + ' L';
        }
        refreshBpStockAdvisory();
      };
    }

    // ---- Modify ingredients toggle ----
    var modifyWrap   = document.getElementById('bp-recipe-modify-wrap');
    var modifyToggle = document.getElementById('bp-modify-toggle');
    var modifyPanel  = document.getElementById('bp-modify-panel');
    var sanWrap      = document.getElementById('bp-save-as-new-wrap');

    if (modifyWrap) modifyWrap.style.display = '';

    if (modifyToggle && modifyPanel) {
      modifyToggle.onclick = function () {
        var isOpen = modifyPanel.style.display !== 'none';
        if (!isOpen) {
          // Expand: deep-copy base ingredients into _bpModifiedIngredients on first open
          if (!_bpModifiedIngredients && _bpResolvedRecipe) {
            _bpModifiedIngredients = (_bpResolvedRecipe.ingredients || []).map(function (ing) {
              return Object.assign({}, ing);
            });
          }
          renderBpModifyRows();
          modifyPanel.style.display = '';
          modifyToggle.textContent = 'Modify Ingredients ▲';
          if (sanWrap) sanWrap.style.display = '';
        } else {
          modifyPanel.style.display = 'none';
          modifyToggle.textContent = 'Modify Ingredients';
        }
      };
    }

    // ---- Add Ingredient button ----
    var addRowBtn = document.getElementById('bp-modify-add-row');
    if (addRowBtn) {
      addRowBtn.onclick = function () {
        if (!_bpModifiedIngredients && _bpResolvedRecipe) {
          _bpModifiedIngredients = (_bpResolvedRecipe.ingredients || []).map(function (ing) {
            return Object.assign({}, ing);
          });
        }
        if (!_bpModifiedIngredients) _bpModifiedIngredients = [];
        _bpModifiedIngredients.push({ item_id: '', item_name: '', quantity: 0, unit: '', cf_type: '', cf_subcategory: '', display_group: '' });
        renderBpModifyRows();
        refreshBpStockAdvisory();
        if (sanWrap) sanWrap.style.display = '';
        // Focus last search input
        var tbody = document.getElementById('bp-modify-tbody');
        if (tbody) {
          var lastSearch = tbody.querySelector('.bp-recipe-ing-row:last-child .bp-ing-search');
          if (lastSearch) lastSearch.focus();
        }
      };
    }

    // ---- Advisory initial render ----
    refreshBpStockAdvisory();

    // ---- Attach confirm button ----
    var confirmBtn = document.getElementById('bp-recipe-attach-confirm-btn');
    if (confirmBtn) {
      confirmBtn.style.display = '';
      confirmBtn.onclick = null;
      confirmBtn.onclick = function () {
        confirmBtn.disabled = true;
        bpAttachRecipe(b.batch_id).then(function () {
          var snap2 = buildBpAttachSnapshot();
          b.recipe_id = _bpResolvedRecipe && _bpResolvedRecipe.recipe && _bpResolvedRecipe.recipe.recipe_id;
          b.recipe_snapshot = JSON.stringify(snap2);
          afterBatchWrite(b.batch_id, { listAffecting: false }); // bust stale snapshot (#27)
          showToast('Recipe attached', 'success');
          loadRecipeList('all'); // refresh recipe list to reflect any recipe status changes
          // GAP-5: the injected expanded panel lives inside sectionBodyEl;
          // renderRecipeSectionBody replaces sectionBodyEl.innerHTML, removing it automatically.
          renderRecipeSectionBody(sectionBodyEl, b, snap2);
        }).catch(function (err) {
          confirmBtn.disabled = false;
          showToast('Failed: ' + (err.message || 'Unknown error'), 'error');
        });
      };
    }

    // ---- Save-as-new wiring ----
    var sanBtn       = document.getElementById('bp-save-as-new-btn');
    var sanPrompt    = document.getElementById('bp-save-as-new-prompt');
    var sanNameInput = document.getElementById('bp-new-recipe-name');
    var sanSaveBtn   = document.getElementById('bp-save-draft-btn');
    var sanCancelBtn = document.getElementById('bp-save-cancel-btn');

    // Hidden until modifications exist (set visible when modify expanded)
    if (sanWrap) sanWrap.style.display = 'none';

    if (sanBtn && sanPrompt) {
      sanBtn.onclick = function () {
        sanPrompt.style.display = '';
        if (sanNameInput) sanNameInput.value = '';
        if (sanNameInput) sanNameInput.focus();
      };
    }
    if (sanCancelBtn && sanPrompt) {
      sanCancelBtn.onclick = function () {
        sanPrompt.style.display = 'none';
      };
    }
    if (sanSaveBtn) {
      sanSaveBtn.onclick = function () {
        var name = sanNameInput ? sanNameInput.value.trim() : '';
        if (!name) {
          if (sanNameInput) sanNameInput.focus();
          return;
        }
        sanSaveBtn.disabled = true;
        var baseList = _bpModifiedIngredients || (_bpResolvedRecipe ? (_bpResolvedRecipe.ingredients || []) : []);
        bpSaveAsNewRecipe(name, baseList).then(function () {
          if (sanPrompt) sanPrompt.style.display = 'none';
          loadRecipeList('all'); // refresh recipe list so new draft appears (#28)
        }).catch(function () {
          sanSaveBtn.disabled = false;
        });
      };
    }
  }

  // ===== Phase 90-09: shared full-list recipe dropdown (D-19/D-20/D-23) =====
  // One renderer + opener for the four BrewPad recipe pickers (attach, new-batch
  // Recipes tab, waitlist per-row attach, waitlist manual-add). Opens ALL active
  // recipes A-Z (no cap) on focus or click; typing narrows by name or style via
  // RecipePicker.filterRecipes. Each picker keeps its own catalog variable and
  // selection side-effects and passes them in.
  function bpRecipePickerLib() {
    if (typeof window !== 'undefined' && !window.RecipePicker && typeof require === 'function') {
      // Test-only: js/lib/recipe-picker.js is a plain <script> in brewpad.html.
      try { window.RecipePicker = require('./lib/recipe-picker.js'); } catch (e) { /* helper unavailable */ }
    }
    return (typeof window !== 'undefined' && window.RecipePicker) || null;
  }

  // catalog: array of recipes (ignored for status 'loading' / 'error').
  // opts: { status: 'loading'|'error', onSelect(rid, rname, e), touch: bool, onRetry() }
  function renderRecipeDropdown(dropdownEl, catalog, term, opts) {
    if (!dropdownEl) return;
    opts = opts || {};
    var lib = bpRecipePickerLib();
    var html;
    if (opts.status === 'loading') {
      html = '<div class="bp-vessel-option bp-vessel-option--empty">Loading recipes…</div>';
    } else if (opts.status === 'error') {
      html = '<div class="bp-vessel-option bp-vessel-option--empty bp-recipe-retry" role="button">Could not load recipes. Tap to retry.</div>';
    } else {
      var list = lib ? lib.filterRecipes(catalog || [], term) : (catalog || []);
      if (list.length === 0) {
        html = '<div class="bp-vessel-option bp-vessel-option--empty">' +
          ((catalog && catalog.length) ? 'No recipes found. Clear the search to see all.' : 'No recipes found') + '</div>';
      } else {
        html = list.map(function (r) {
          return '<div class="bp-vessel-option" role="option" data-rid="' + escapeHTML(r.recipe_id || '') +
            '" data-rname="' + escapeHTML(r.name || '') + '">' +
            '<span class="bp-recipe-opt-name">' + escapeHTML(r.name || '') + '</span>' +
            (r.style ? '<span class="bp-recipe-opt-style">' + escapeHTML(r.style) + '</span>' : '') +
            '</div>';
        }).join('');
      }
    }
    dropdownEl.classList.add('bp-recipe-dropdown');
    dropdownEl.setAttribute('role', 'listbox');
    dropdownEl.innerHTML = html;
    dropdownEl.style.display = '';
    if (opts.status === 'error' && opts.onRetry) {
      var retryEl = dropdownEl.querySelector('.bp-recipe-retry');
      if (retryEl) {
        retryEl.addEventListener('mousedown', function (e) { e.preventDefault(); opts.onRetry(); });
        retryEl.addEventListener('touchstart', function (e) { e.preventDefault(); opts.onRetry(); }, { passive: false });
      }
    }
    if (opts.onSelect) {
      Array.prototype.forEach.call(dropdownEl.querySelectorAll('.bp-vessel-option[data-rid]'), function (opt) {
        function pick(e) {
          e.preventDefault();
          if (opts.touch) e.stopPropagation();
          opts.onSelect(opt.getAttribute('data-rid'), opt.getAttribute('data-rname'), e);
        }
        opt.addEventListener('mousedown', pick);
        if (opts.touch) opt.addEventListener('touchstart', pick, { passive: false });
      });
    }
  }

  // Builds one picker around an input + dropdown. cfg: { input, dropdown,
  // getCatalog, setCatalog, onSelect, touch, guard }. Returns { show, close }.
  // A failed fetch leaves the catalog null so the next open retries.
  function bpCreateRecipePicker(cfg) {
    var input = cfg.input;
    var dropdown = cfg.dropdown;
    var inflight = false;
    var lastTerm = '';

    function setExpanded(v) { if (input) input.setAttribute('aria-expanded', v ? 'true' : 'false'); }

    function close() {
      if (dropdown) dropdown.style.display = 'none';
      setExpanded(false);
    }

    function show(term) {
      if (cfg.guard && !cfg.guard()) return;
      lastTerm = term || '';
      var catalog = cfg.getCatalog();
      if (!catalog) {
        renderRecipeDropdown(dropdown, null, lastTerm, { status: 'loading' });
        setExpanded(true);
        if (inflight) return;
        inflight = true;
        Promise.resolve(fetch(mwUrl() + '/api/recipes?status=active', { credentials: 'include' }))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            inflight = false;
            cfg.setCatalog(data.recipes || []);
            show(lastTerm);
          })
          .catch(function () {
            inflight = false;
            cfg.setCatalog(null);
            renderRecipeDropdown(dropdown, null, lastTerm, {
              status: 'error',
              onRetry: function () { show(lastTerm); }
            });
            setExpanded(true);
          });
        return;
      }
      renderRecipeDropdown(dropdown, catalog, lastTerm, { onSelect: cfg.onSelect, touch: cfg.touch });
      setExpanded(true);
    }

    if (input && dropdown) {
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      if (dropdown.id) input.setAttribute('aria-controls', dropdown.id);
      dropdown.setAttribute('role', 'listbox');
      dropdown.classList.add('bp-recipe-dropdown');
      input.addEventListener('focus', function () { show(input.value); });
      // iPad Safari: tapping an already-focused input fires click, not focus.
      input.addEventListener('click', function () { show(input.value); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' || e.keyCode === 27) close();
      });
    }
    return { show: show, close: close };
  }

  function openRecipeAttachPanel(b, sectionBodyEl) {
    if (!sectionBodyEl) return;
    var emptyDiv = sectionBodyEl.querySelector('.bp-recipe-empty');
    if (!emptyDiv) return;

    // Reset attach-flow state on panel open
    _bpResolvedRecipe      = null;
    _bpModifiedIngredients = null;
    _bpTargetVolumeL       = null;
    _bpScaleFactor         = 1.0;

    // GAP-5: remove any previously-injected expanded panel from sectionBodyEl on panel open
    var _prevInjected = sectionBodyEl.querySelector('#bp-recipe-attach-expanded-injected');
    if (_prevInjected) _prevInjected.parentNode.removeChild(_prevInjected);

    emptyDiv.innerHTML =
      '<div class="bp-vessel-wrap" id="bp-recipe-attach-wrap">' +
      '<input type="text" id="bp-recipe-attach-input" class="bp-inline-input" placeholder="Search recipes…" autocomplete="off">' +
      '<div class="bp-vessel-dropdown" id="bp-recipe-attach-dropdown" style="display:none;"></div>' +
      '</div>' +
      '<div id="bp-attach-resolved-info" style="display:none;margin:6px 0;color:var(--ink-secondary);font-size:0.85rem;"></div>' +
      '<button type="button" class="btn-secondary bp-btn-sm" id="bp-recipe-attach-cancel" style="margin-top:6px;">Cancel</button>';

    var input = document.getElementById('bp-recipe-attach-input');
    var dropdown = document.getElementById('bp-recipe-attach-dropdown');
    var cancelBtn = document.getElementById('bp-recipe-attach-cancel');
    var resolvedInfo = document.getElementById('bp-attach-resolved-info');
    var _catalog = null;

    var picker = bpCreateRecipePicker({
      input: input,
      dropdown: dropdown,
      getCatalog: function () { return _catalog; },
      setCatalog: function (v) { _catalog = v; },
      onSelect: function (rid, rname) {
        input.value = rname || '';
        picker.close();

        // Phase 36: RESOLVE only — do NOT write the batch
        fetch(mwUrl() + '/api/recipes/' + encodeURIComponent(rid), { credentials: 'include' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var snap = data.recipe || {};
            var ingredients = (data.ingredients || []).map(function (i) {
              return { item_id: i.item_id, item_name: i.item_name, quantity: i.quantity, unit: i.unit,
                       cf_type: i.cf_type || '', cf_subcategory: i.cf_subcategory || '', display_group: i.display_group || '',
                       stock_on_hand: i.stock_on_hand != null ? i.stock_on_hand : null }; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
            });

            // Store resolved recipe — no update_batch call here (D-10)
            _bpResolvedRecipe = { recipe: snap, ingredients: ingredients };

            // Show resolved info label
            if (resolvedInfo) {
              resolvedInfo.textContent = escapeHTML(snap.name || rid);
              resolvedInfo.style.display = '';
            }

            // GAP-5: wireAttachExpandedPanel injects the expanded panel INTO sectionBodyEl
            // (the scrollable detail pane), so no explicit show/hide of a static sibling needed.
            wireAttachExpandedPanel(b, sectionBodyEl);
          })
          .catch(function (err) { showToast('Failed to load recipe: ' + err.message, 'error'); });
      }
    });
    function showAttachOptions(term) { picker.show(term); }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        // Reset state
        _bpResolvedRecipe      = null;
        _bpModifiedIngredients = null;
        _bpTargetVolumeL       = null;
        _bpScaleFactor         = 1.0;
        // GAP-5: remove injected panel on cancel (it lives inside sectionBodyEl)
        var injected = sectionBodyEl ? sectionBodyEl.querySelector('#bp-recipe-attach-expanded-injected') : null;
        if (injected) injected.parentNode.removeChild(injected);
        emptyDiv.innerHTML =
          '<p style="color:var(--ink-secondary);font-size:0.82rem;margin:0 0 8px 0;">No recipe attached to this batch.</p>' +
          '<div class="bp-recipe-btn-row">' +
          '<button type="button" class="btn-secondary bp-btn-sm" id="bp-recipe-attach-btn">Attach Recipe</button>' +
          '<button type="button" class="btn bp-btn-sm" id="bp-recipe-create-btn">Create Recipe</button>' +
          '</div>';
        bindRecipeEmptyBtns(b, sectionBodyEl, emptyDiv);
      });
    }

    if (input) {
      input.addEventListener('input', function () {
        clearTimeout(input._timer);
        input._timer = setTimeout(function () { showAttachOptions(input.value); }, 200);
      });
      input.addEventListener('blur', function () {
        setTimeout(function () { picker.close(); }, 200);
      });
      input.focus();
    }
  }

  function openRecipeFromBatchSheet(b, sectionBodyEl) {
    var createBtn = document.getElementById('bp-recipe-create-btn');
    if (createBtn) createBtn.disabled = true;

    // Build a dedicated recipe-create sheet dynamically
    var existing = document.getElementById('bp-recipe-create-sheet');
    if (existing) existing.parentNode.removeChild(existing);

    var appEl = document.getElementById('bp-app') || document.body;
    var sheetEl = document.createElement('div');
    sheetEl.id = 'bp-recipe-create-sheet';
    sheetEl.className = 'bp-create-sheet';
    sheetEl.style.display = '';
    sheetEl.innerHTML =
      '<div class="bp-create-sheet-inner" id="bp-recipe-create-sheet-inner">' +
      '<div class="bp-create-sheet-header">' +
      '<span class="bp-create-sheet-title">Create Recipe from Batch</span>' +
      '<button type="button" class="bp-create-sheet-close" id="bp-recipe-sheet-close">×</button>' +
      '</div>' +
      '<div class="bp-create-sheet-body" id="bp-recipe-create-body">' +
      '<div class="bp-form-group">' +
        '<label>Name <span class="bp-required">*</span></label>' +
        '<input type="text" id="bp-rcs-name" class="bp-inline-input" value="' + escapeHTML(b.product_name || '') + '" required>' +
      '</div>' +
      '<div class="bp-form-group">' +
        '<label>Style</label>' +
        '<input type="text" id="bp-rcs-style" class="bp-inline-input" placeholder="e.g. Cabernet Sauvignon">' +
      '</div>' +
      '<div class="bp-form-group">' +
        '<label>ABV (%)</label>' +
        '<input type="number" id="bp-rcs-abv" class="bp-inline-input" step="0.1" min="0">' +
      '</div>' +
      '<div class="bp-form-group">' +
        '<label>IBU</label>' +
        '<input type="number" id="bp-rcs-ibu" class="bp-inline-input" step="1" min="0">' +
      '</div>' +
      '<div class="bp-form-group">' +
        '<label>Batch Size (L)</label>' +
        '<input type="number" id="bp-rcs-batch-size" class="bp-inline-input" step="0.5" min="0">' +
      '</div>' +
      '<div class="bp-form-actions">' +
        '<button type="button" class="btn" id="bp-rcs-save">Save Recipe</button>' +
        '<button type="button" class="btn-secondary" id="bp-rcs-cancel">Cancel</button>' +
      '</div>' +
      '</div>' +
      '</div>';
    appEl.appendChild(sheetEl);

    function closeRcSheet() {
      sheetEl.classList.remove('bp-create-sheet--open');
      setTimeout(function () {
        if (sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
      }, 180);
      if (createBtn) createBtn.disabled = false;
    }

    setTimeout(function () { sheetEl.classList.add('bp-create-sheet--open'); }, 10);

    sheetEl.addEventListener('click', function (e) { if (e.target === sheetEl) closeRcSheet(); });
    var closeX = document.getElementById('bp-recipe-sheet-close');
    if (closeX) closeX.addEventListener('click', closeRcSheet);
    var cancelRcs = document.getElementById('bp-rcs-cancel');
    if (cancelRcs) cancelRcs.addEventListener('click', closeRcSheet);

    var saveRcs = document.getElementById('bp-rcs-save');
    if (saveRcs) {
      saveRcs.addEventListener('click', function () {
        var nameVal = (document.getElementById('bp-rcs-name') || {}).value || '';
        if (!nameVal.trim()) { showToast('Recipe name is required.', 'error'); return; }
        saveRcs.disabled = true;
        var payload = {
          name: nameVal.trim(),
          style: (document.getElementById('bp-rcs-style') || {}).value || '',
          abv: parseFloat((document.getElementById('bp-rcs-abv') || {}).value) || 0,
          ibu: parseFloat((document.getElementById('bp-rcs-ibu') || {}).value) || 0,
          batch_size_l: parseFloat((document.getElementById('bp-rcs-batch-size') || {}).value) || 0,
          locked_price: 0,
          status: 'draft',
          ingredients: []
        };
        fetch(mwUrl() + '/api/recipes', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.ok && data.error) throw new Error(data.error);
            var newId = (data.recipe && data.recipe.recipe_id) || data.recipe_id || '';
            var snap = {
              name: payload.name, style: payload.style,
              abv: payload.abv, ibu: payload.ibu,
              batch_size_l: payload.batch_size_l, notes: '',
              ingredients: []
            };
            return adminApiPost('update_batch', {
              batch_id: b.batch_id,
              updates: { recipe_id: newId, recipe_snapshot: JSON.stringify(snap) }
            }).then(function () {
              b.recipe_id = newId;
              b.recipe_snapshot = JSON.stringify(snap);
              afterBatchWrite(b.batch_id, { listAffecting: false }); // bust stale snapshot (#4)
              showToast('Recipe created and linked', 'success');
              closeRcSheet();
              loadRecipeList('all'); // refresh recipe list so new recipe appears (#recipes-CRUD)
              if (sectionBodyEl) renderRecipeSectionBody(sectionBodyEl, b, snap);
            });
          })
          .catch(function (err) {
            showToast('Could not create recipe. Please try again.', 'error');
            saveRcs.disabled = false;
          });
      });
    }

    var firstInput = document.getElementById('bp-rcs-name');
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 50);
  }

  function buildRecipeSummaryHtml(snap) {
    var html = '<div class="bp-recipe-summary" id="bp-recipe-meta-wrap">';
    if (snap.name) html += '<div><span class="bp-detail-info-label">Name</span> ' + escapeHTML(snap.name) + '</div>';
    if (snap.style) html += '<div><span class="bp-detail-info-label">Style</span> ' + escapeHTML(snap.style) + '</div>';
    if (snap.abv) html += '<div><span class="bp-detail-info-label">ABV</span> ' + escapeHTML(String(snap.abv)) + '%</div>';
    if (snap.ibu) html += '<div><span class="bp-detail-info-label">IBU</span> ' + escapeHTML(String(snap.ibu)) + '</div>';
    if (snap.batch_size_l) html += '<div><span class="bp-detail-info-label">Batch Size</span> ' + escapeHTML(String(snap.batch_size_l)) + ' L</div>';
    if (snap.notes) html += '<div style="width:100%;"><span class="bp-detail-info-label">Notes</span> ' + escapeHTML(snap.notes) + '</div>';
    html += '</div>';
    return html;
  }

  function renderRecipeSectionBody(sectionBodyEl, b, snap) {
    if (!sectionBodyEl) return;
    sectionBodyEl.innerHTML =
      buildRecipeSummaryHtml(snap) +
      '<div id="bp-recipe-ingredient-wrap">' + buildRecipeIngredientTable(snap.ingredients || [], false) + '</div>' +
      '<div class="bp-detail-actions" style="border-top:none;padding-top:8px;">' +
        '<button type="button" class="btn bp-btn-sm" id="bp-recipe-edit-btn">Edit Snapshot</button>' +
        '<button type="button" class="btn bp-btn-sm" id="bp-recipe-save-btn" style="display:none;">Save Changes</button>' +
        '<button type="button" class="btn-secondary bp-btn-sm" id="bp-recipe-cancel-btn" style="display:none;">Discard Changes</button>' +
      '</div>';
    bindRecipeEditHandlers(b, sectionBodyEl, snap);
  }

  function bindRecipeEditHandlers(b, sectionBodyEl, snapRef) {
    var snap = snapRef; // mutable local reference
    var editBtn = document.getElementById('bp-recipe-edit-btn');
    var saveBtn = document.getElementById('bp-recipe-save-btn');
    var cancelBtn = document.getElementById('bp-recipe-cancel-btn');
    var ingredientWrap = document.getElementById('bp-recipe-ingredient-wrap');
    var metaWrap = document.getElementById('bp-recipe-meta-wrap');

    if (editBtn) {
      editBtn.addEventListener('click', function () {
        // Replace read-only metadata with editable form fields (D-04: all fields)
        if (metaWrap) {
          metaWrap.className = 'bp-recipe-edit-form';
          metaWrap.id = 'bp-recipe-meta-wrap';
          metaWrap.innerHTML =
            '<div class="bp-recipe-edit-row">' +
              '<label class="bp-recipe-edit-label">Name</label>' +
              '<input type="text" id="bp-recipe-edit-name" class="bp-inline-input" value="' + escapeHTML(snap.name || '') + '">' +
            '</div>' +
            '<div class="bp-recipe-edit-row">' +
              '<label class="bp-recipe-edit-label">Style</label>' +
              '<input type="text" id="bp-recipe-edit-style" class="bp-inline-input" value="' + escapeHTML(snap.style || '') + '">' +
            '</div>' +
            '<div class="bp-recipe-edit-row-inline">' +
              '<div><label class="bp-recipe-edit-label">ABV (%)</label>' +
                '<input type="number" id="bp-recipe-edit-abv" class="bp-inline-input" value="' + escapeHTML(String(snap.abv || '')) + '" step="0.1" min="0" style="width:80px;"></div>' +
              '<div><label class="bp-recipe-edit-label">IBU</label>' +
                '<input type="number" id="bp-recipe-edit-ibu" class="bp-inline-input" value="' + escapeHTML(String(snap.ibu || '')) + '" step="1" min="0" style="width:80px;"></div>' +
              '<div><label class="bp-recipe-edit-label">Batch Size (L)</label>' +
                '<input type="number" id="bp-recipe-edit-batch-size" class="bp-inline-input" value="' + escapeHTML(String(snap.batch_size_l || '')) + '" step="0.5" min="0" style="width:80px;"></div>' +
            '</div>' +
            '<div class="bp-recipe-edit-row">' +
              '<label class="bp-recipe-edit-label">Notes</label>' +
              '<textarea id="bp-recipe-edit-notes" class="bp-inline-input" rows="2">' + escapeHTML(snap.notes || '') + '</textarea>' +
            '</div>';
        }
        if (ingredientWrap) ingredientWrap.innerHTML = buildRecipeIngredientTable(snap.ingredients || [], true);
        editBtn.style.display = 'none';
        if (saveBtn) saveBtn.style.display = '';
        if (cancelBtn) cancelBtn.style.display = '';
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        saveBtn.disabled = true;
        var editedIngredients = ingredientWrap ? readIngredientTableEdits(ingredientWrap, snap.ingredients) : (snap.ingredients || []);
        var editedSnap = {
          name: (document.getElementById('bp-recipe-edit-name') || {}).value || snap.name || '',
          style: (document.getElementById('bp-recipe-edit-style') || {}).value || '',
          abv: parseFloat((document.getElementById('bp-recipe-edit-abv') || {}).value) || snap.abv || 0,
          ibu: parseFloat((document.getElementById('bp-recipe-edit-ibu') || {}).value) || snap.ibu || 0,
          batch_size_l: parseFloat((document.getElementById('bp-recipe-edit-batch-size') || {}).value) || snap.batch_size_l || 0,
          notes: (document.getElementById('bp-recipe-edit-notes') || {}).value || '',
          ingredients: editedIngredients
        };
        adminApiPost('update_batch', {
          batch_id: b.batch_id,
          updates: { recipe_snapshot: JSON.stringify(editedSnap) }
        })
          .then(function () {
            snap = editedSnap;
            b.recipe_snapshot = JSON.stringify(editedSnap);
            afterBatchWrite(b.batch_id, { listAffecting: false }); // bust stale snapshot (#5)
            showToast('Recipe snapshot saved', 'success');
            renderRecipeSectionBody(sectionBodyEl, b, snap);
          })
          .catch(function (err) {
            showToast('Save failed: ' + err.message, 'error');
            saveBtn.disabled = false;
          });
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        renderRecipeSectionBody(sectionBodyEl, b, snap);
      });
    }
  }

  function bindRecipeEmptyBtns(b, sectionBodyEl, emptyDiv) {
    var attachBtn = document.getElementById('bp-recipe-attach-btn');
    if (attachBtn) {
      attachBtn.addEventListener('click', function () {
        openRecipeAttachPanel(b, sectionBodyEl);
      });
    }
    var createBtn = document.getElementById('bp-recipe-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        openRecipeFromBatchSheet(b, sectionBodyEl);
      });
    }
  }

  function renderBatchDetail(data) {
    var b = data.batch || {};
    var tasks = data.tasks || [];
    var readings = data.plato_readings || [];

    _detailPlatoStaging = [];
    _detailPlatoReadings = readings.slice();
    _detailStartDate = b.start_date || null;
    _detailBatchId = b.batch_id;
    _currentBatchDetail = b;

    var statusKey = String(b.status || '').toLowerCase();
    var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
    var statusColor = STATUS_COLORS[statusKey] || 'info';

    var currentVesselLabel = b.vessel_id || '';
    if (b.vessel_id) {
      var cv = _vesselsMap[String(b.vessel_id)] || null;
      if (cv) currentVesselLabel = buildVesselLabel(cv);
    }

    var html = '<div class="bp-detail-content">';

    // Header
    html += '<div class="bp-detail-header">';
    html += '<button type="button" class="btn-secondary bp-btn-sm bp-detail-back" id="bp-detail-back" aria-label="Back to batch list">\u2190</button>';
    html += '<div class="bp-detail-title-group">';
    html += '<span class="bp-detail-batch-id">' + escapeHTML(b.batch_id) + '</span>';
    html += '<span class="bp-status-badge bp-status-badge--' + statusColor + ' bp-status-clickable" id="bp-detail-status">' + escapeHTML(statusLabel) + '</span>';
    if (shouldShowInternalBadge(b.source)) {
      html += '<span class="bp-source-badge bp-source-badge--internal" id="bp-detail-internal-badge">Internal</span>';
    }
    html += '</div>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-qr-btn" title="Generate printable QR code for public batch page">Print QR</button>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-label-btn" title="Download bottle label as PDF">Label PDF</button>';
    html += '</div>';

    // Info grid
    html += '<div class="bp-detail-info">';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Product</span><span>' + escapeHTML(b.product_name || b.product_sku || '\u2014') + '</span></div>';
    var typeInfo = batchTypeInfo(b);
    var typeLabel = typeInfo.type.charAt(0).toUpperCase() + typeInfo.type.slice(1);
    if (statusKey === 'disabled' || statusKey === 'deleted' || !_dashData) {
      html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Type</span><span id="bp-detail-type-text">' + escapeHTML(typeLabel) + '</span></div>';
    } else {
      html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Type</span><span>';
      html += '<select class="bp-select" id="bp-detail-type" aria-label="Batch type">';
      TYPE_OPTIONS.forEach(function (o) {
        html += '<option value="' + o[0] + '"' + (o[0] === typeInfo.type ? ' selected' : '') + '>' + o[1] + '</option>';
      });
      html += '</select>';
      html += '<span class="bp-stat-label" id="bp-detail-type-hint" style="display:block;">' + escapeHTML(typeInfo.hint) + '</span>';
      html += '</span></div>';
    }
    // Phase 95 (D-08): staff flag, right after Type
    var isStaff = b.staff_batch === true || b.staff_batch === 'true' || b.staff_batch === 1;
    if (statusKey === 'disabled' || statusKey === 'deleted') {
      html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Staff batch</span><span id="bp-detail-staff-text">' + (isStaff ? 'Yes' : 'No') + '</span></div>';
    } else {
      var staffSrc = String(b.source || '').trim().toLowerCase();
      var staffHint = !isStaff ? '' : (STAFF_SOURCE_HINTS[staffSrc] || 'Set by hand');
      html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Staff batch</span><span>';
      html += '<label class="bp-detail-staff-label" style="display:flex;align-items:center;gap:8px;min-height:44px;">';
      html += '<input type="checkbox" id="bp-detail-staff"' + (isStaff ? ' checked' : '') + ' style="width:44px;height:44px;margin:0;">';
      html += '<span>Staff, family or R&amp;D (hidden from mix charts)</span></label>';
      if (staffHint) html += '<span class="bp-stat-label" id="bp-detail-staff-hint" style="display:block;">' + escapeHTML(staffHint) + '</span>';
      html += '</span></div>';
    }
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Customer</span><span id="bp-detail-customer">' + escapeHTML(getCustomerDisplayName(b) || '\u2014') + '</span></div>';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Email</span><span id="bp-detail-email">' + escapeHTML(b.customer_email || '\u2014') + '</span></div>';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Phone</span><span id="bp-detail-phone">' + escapeHTML(b.customer_phone || '\u2014') + '</span></div>';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Start</span><span>' + fmtDate(b.start_date) + '</span></div>';
    if (b.zoho_so_number) {
      html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Zoho Ref</span><span>' + escapeHTML(b.zoho_so_number) + '<span class="bp-sync-indicator" id="bp-sync-indicator" style="display:none;"></span></span></div>';
    }
    html += '</div>';

    // Invoice linking
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Invoice</div>';
    html += '<div class="bp-link-so-wrap">';
    if (b.zoho_so_number) {
      html += '<div class="bp-so-linked-display" id="bp-so-linked-display">';
      html += '<span class="bp-so-linked-text">' + escapeHTML(b.zoho_so_number) + '</span>';
      html += '<button type="button" class="bp-so-change-btn" id="bp-so-change-link">Change Linked Order</button>';
      if (isValidZohoNumber(b.zoho_so_number)) {
        html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-zoho-refresh-btn">Refresh from Zoho</button>';
      }
      html += '</div>';
    } else {
      html += '<div id="bp-so-linked-display" style="display:none;"></div>';
    }
    html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-link-so-btn"' + (b.zoho_so_number ? ' style="display:none;"' : '') + '>Link to Invoice</button>';
    html += '<div id="bp-link-so-search" style="display:none;">';
    html += '<div class="bp-so-search-wrap">';
    html += '<input type="text" id="bp-so-search-input" class="bp-inline-input" placeholder="Customer name or invoice number…" autocomplete="off">';
    html += '<button type="button" class="bp-so-dismiss-link" id="bp-so-dismiss">' + (b.zoho_so_number ? 'Keep current link' : 'Close search') + '</button>';
    html += '</div>';
    html += '<div class="bp-so-results" id="bp-so-search-results"></div>';
    html += '</div>';

    // Phase 90-06 (D-07): guided review for unlinked batches, filled after mount.
    if (filterBatchesByUnlinked([b]).length === 1) {
      html += '<div id="bp-link-review" class="bp-link-review"></div>';
    }
    if (shouldShowInternalBadge(b.source)) {
      html += '<button type="button" class="bp-so-change-btn" id="bp-unmark-internal">Mark as not internal</button>';
    }

    // Change Customer button — rendered unconditionally (D-03: no linked SO = direct save)
    html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-reassign-btn">Change Customer</button>';

    // Reassign search panel (hidden by default)
    html += '<div id="bp-reassign-panel" class="bp-reassign-panel" style="display:none;">';
    html += '<div class="bp-so-search-wrap bp-reassign-search-wrap">';
    html += '<input type="text" id="bp-reassign-search-input" class="bp-inline-input" placeholder="Search by name, email or phone…" autocomplete="off">';
    html += '<button type="button" class="bp-so-dismiss-link" id="bp-reassign-dismiss">Cancel</button>';
    html += '</div>';
    html += '<div class="bp-so-results bp-reassign-results" id="bp-reassign-results"></div>';

    // "Add new customer" toggle link
    html += '<button type="button" class="bp-reassign-addnew-toggle" id="bp-reassign-addnew-toggle">+ Add new customer</button>';

    // Inline add-new form (hidden by default)
    html += '<div id="bp-reassign-addnew" class="bp-reassign-addnew" style="display:none;">';
    html += '<input type="text" id="bp-reassign-new-name" class="bp-inline-input" placeholder="Full name *" autocomplete="off">';
    html += '<input type="email" id="bp-reassign-new-email" class="bp-inline-input" placeholder="Email" autocomplete="off">';
    html += '<input type="tel" id="bp-reassign-new-phone" class="bp-inline-input" placeholder="Phone" autocomplete="off">';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-reassign-new-save">Save New Customer</button>';
    html += '</div>';
    html += '</div>';

    html += '</div>';
    html += '</div>';

    // Location
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Location</div>';
    html += '<div class="bp-location-edit">';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-edit-vessel-text" class="bp-inline-input" value="' + escapeHTML(currentVesselLabel) + '" placeholder="Search vessels\u2026" autocomplete="off">';
    html += '<button type="button" class="bp-clear-btn" id="bp-edit-vessel-clear" title="Clear vessel">\u00d7</button>';
    html += '<div class="bp-vessel-dropdown" id="bp-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-edit-vessel" value="' + escapeHTML(b.vessel_id || '') + '">';
    html += '</div>';
    html += '<input type="text" id="bp-edit-shelf" class="bp-inline-input bp-shelf-input" value="' + escapeHTML(b.shelf_id || '') + '" placeholder="A">';
    html += '<input type="text" id="bp-edit-bin" class="bp-inline-input bp-bin-input" value="' + escapeHTML(b.bin_id || '') + '" placeholder="01">';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-save-location">Save</button>';
    html += '</div></div>';

    // Lifecycle timeline
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Lifecycle</div>';
    html += '<div id="bp-lifecycle-timeline">' + buildLifecycleTimeline(b, null) + '</div>';
    html += '</div>';

    // Tasks
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Tasks</div>';
    html += '<div id="bp-detail-tasks">' + renderDetailTasks(tasks) + '</div>';
    html += '</div>';

    // Readings
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Measurements</div>';
    html += '<div id="bp-detail-readings">' + renderDetailReadings(_detailPlatoReadings, _detailStartDate) + '</div>';
    html += '</div>';

    // Notes
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Notes</div>';
    html += '<textarea id="bp-detail-notes" class="bp-inline-input bp-notes-input" rows="3" placeholder="Auto-saved\u2026">' + escapeHTML(b.notes || '') + '</textarea>';
    html += '</div>';

    // Recipe section (Phase 16)
    var _batchSnap = null;
    if (b.recipe_snapshot) {
      try { _batchSnap = JSON.parse(b.recipe_snapshot); } catch (e) { _batchSnap = null; }
    }
    html += '<div class="bp-detail-section bp-detail-section--recipe">';
    html += '<div class="bp-detail-section-title bp-detail-section-toggle" id="bp-recipe-section-toggle" role="button" tabindex="0" aria-expanded="false">';
    html += 'Recipe <span class="bp-section-toggle-icon">&#9656;</span>';
    html += '</div>';
    html += '<div id="bp-recipe-section-body" style="display:none;">';
    if (_batchSnap) {
      html += buildRecipeSummaryHtml(_batchSnap);
      html += '<div id="bp-recipe-ingredient-wrap">' + buildRecipeIngredientTable(_batchSnap.ingredients || [], false) + '</div>';
      html += '<div class="bp-detail-actions" style="border-top:none;padding-top:8px;">';
      html += '<button type="button" class="btn bp-btn-sm" id="bp-recipe-edit-btn">Edit Snapshot</button>';
      html += '<button type="button" class="btn bp-btn-sm" id="bp-recipe-save-btn" style="display:none;">Save Changes</button>';
      html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-recipe-cancel-btn" style="display:none;">Discard Changes</button>';
      html += '</div>';
    } else {
      html += '<div class="bp-recipe-empty">';
      html += '<p style="color:var(--ink-secondary);font-size:0.82rem;margin:0 0 8px 0;">No recipe attached to this batch.</p>';
      html += '<div class="bp-recipe-btn-row">';
      html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-recipe-attach-btn">Attach Recipe</button>';
      html += '<button type="button" class="btn bp-btn-sm" id="bp-recipe-create-btn">Create Recipe</button>';
      html += '</div></div>';
    }
    html += '</div></div>';

    // Footer actions
    html += '<div class="bp-detail-actions">';
    if (statusKey === 'pending') {
      html += '<p class="bp-pending-activate-hint">This batch is pending. Activate it now with today&#39;s date, or schedule it first.</p>';
      html += '<button type="button" class="btn bp-btn-sm" id="bp-activate-detail-btn"' +
        ' title="Activate now with today&#39;s date — no schedule attached">Activate now</button>';
      html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-sa-detail-btn"' +
        ' title="Pick a schedule and start date, then activate">Schedule &amp; Activate</button>';
    } else if (statusKey !== 'complete' && tasks.length === 0) {
      // Active batch with no schedule (e.g. activated via "Activate now") — let staff
      // attach a schedule afterward to generate its tasks. Reuses the guided sheet,
      // which drives the same update_batch_schedule action.
      html += '<p class="bp-pending-activate-hint">This batch has no schedule, so it has no tasks. Add a schedule to generate them.</p>';
      html += '<button type="button" class="btn bp-btn-sm" id="bp-add-schedule-btn"' +
        ' title="Pick a schedule and start date to generate this batch&#39;s tasks">Add Schedule</button>';
    } else if (statusKey !== 'complete' && tasks.length > 0) {
      // Active batch that already has a schedule — let staff swap it. Re-applying recomputes
      // upcoming tasks from the start date; completed tasks are preserved server-side.
      html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-change-schedule-btn"' +
        ' title="Swap this batch&#39;s schedule and recompute its tasks — completed tasks are kept">Change Schedule</button>';
    }
    if (b.customer_email) {
      var inviteSentAt = b.bottling_invite_sent_at || '';
      if (inviteSentAt) {
        var sentTo = b.bottling_invite_email || b.customer_email || '';
        html += '<p class="bp-invite-sent-note" id="bp-invite-sent-note">Invite sent ' +
          escapeHTML(fmtDate(inviteSentAt)) +
          (sentTo ? ' to ' + escapeHTML(sentTo) : '') + '</p>';
      }
      html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-bottling-invite-btn">' +
        (inviteSentAt ? 'Resend Invite' : 'Send Bottling Invite') + '</button>';
    }
    html += '<button type="button" class="btn-secondary bp-btn-sm bp-danger-btn" id="bp-delete-batch-btn">Delete Batch</button>';
    html += '</div>';

    html += '</div>';

    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (!detailPane) return;
    detailPane.innerHTML = html;

    var linkReviewEl = document.getElementById('bp-link-review');
    if (linkReviewEl) initLinkReview(b, linkReviewEl);
    var typeSelect = document.getElementById('bp-detail-type');
    if (typeSelect) {
      var prevType = typeSelect.value;
      typeSelect.addEventListener('change', function () {
        var nextType = typeSelect.value;
        typeSelect.disabled = true;
        setBatchType(b.batch_id, nextType).then(function () {
          prevType = nextType;
          typeSelect.disabled = false;
          var hintEl = document.getElementById('bp-detail-type-hint');
          if (hintEl) hintEl.textContent = TYPE_SOURCE_HINTS.manual;
          showToast('Type updated', 'success');
        }).catch(function () {
          typeSelect.value = prevType;
          typeSelect.disabled = false;
          showToast('Could not update type. Try again.', 'error');
        });
      });
    }
    var staffBox = document.getElementById('bp-detail-staff');
    if (staffBox) {
      staffBox.addEventListener('change', function () {
        var nextStaff = staffBox.checked;
        staffBox.disabled = true;
        setStaffBatch(b.batch_id, nextStaff).then(function () {
          b.staff_batch = nextStaff;
          staffBox.disabled = false;
          var hintEl = document.getElementById('bp-detail-staff-hint');
          if (hintEl) hintEl.textContent = nextStaff ? 'Set by hand' : '';
          showToast('Staff flag updated', 'success');
        }).catch(function () {
          staffBox.checked = !nextStaff;
          staffBox.disabled = false;
          showToast('Could not update staff flag. Try again.', 'error');
        });
      });
    }
    var unmarkInternalBtn = document.getElementById('bp-unmark-internal');
    if (unmarkInternalBtn) {
      unmarkInternalBtn.addEventListener('click', function () {
        unmarkInternalBtn.disabled = true;
        markBatchSource(b.batch_id, 'manual').then(function () {
          b.source = 'manual';
          var badge = document.getElementById('bp-detail-internal-badge');
          if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
          if (unmarkInternalBtn.parentNode) unmarkInternalBtn.parentNode.removeChild(unmarkInternalBtn);
          showToast('Marked as not internal', 'success');
        }).catch(function (err) {
          unmarkInternalBtn.disabled = false;
          showToast('Failed: ' + ((err && err.message) || 'could not update'), 'error');
        });
      });
    }

    // Recipe section toggle + interactions (Phase 16)
    var toggleBtn = document.getElementById('bp-recipe-section-toggle');
    var recipeBody = document.getElementById('bp-recipe-section-body');
    if (toggleBtn && recipeBody) {
      function handleRecipeToggle() {
        var expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        toggleBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        recipeBody.style.display = expanded ? 'none' : '';
        var icon = toggleBtn.querySelector('.bp-section-toggle-icon');
        if (icon) icon.style.transform = expanded ? '' : 'rotate(90deg)';
      }
      toggleBtn.addEventListener('click', handleRecipeToggle);
      toggleBtn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRecipeToggle(); }
      });
    }
    if (_batchSnap && recipeBody) {
      bindRecipeEditHandlers(b, recipeBody, _batchSnap);
    }
    if (!_batchSnap && recipeBody) {
      var emptyDiv = recipeBody.querySelector('.bp-recipe-empty');
      bindRecipeEmptyBtns(b, recipeBody, emptyDiv);
    }

    // Back button (portrait)
    var backBtn = document.getElementById('bp-detail-back');
    if (backBtn) backBtn.addEventListener('click', closeBatchDetail);

    // Vessel search
    var vesselTextInput = document.getElementById('bp-edit-vessel-text');
    var vesselDropdown = document.getElementById('bp-vessel-dropdown');
    var vesselHidden = document.getElementById('bp-edit-vessel');
    if (vesselTextInput && vesselDropdown && vesselHidden) {
      bindVesselSearch(vesselTextInput, vesselDropdown, vesselHidden, b.vessel_id || '');
    }

    var editVesselClearBtn = document.getElementById('bp-edit-vessel-clear');
    if (editVesselClearBtn && vesselTextInput && vesselHidden) {
      editVesselClearBtn.addEventListener('click', function () {
        vesselHidden.value = '';
        vesselTextInput.value = '';
        vesselTextInput.focus();
      });
    }

    // Shelf + Bin
    var shelfEl = document.getElementById('bp-edit-shelf');
    var binEl = document.getElementById('bp-edit-bin');
    if (shelfEl) bindShelfInput(shelfEl);
    if (binEl) bindBinInput(binEl);

    // Save location
    var saveLocBtn = document.getElementById('bp-save-location');
    if (saveLocBtn) {
      saveLocBtn.addEventListener('click', function () {
        var vessel = vesselHidden ? vesselHidden.value.trim() : '';
        var shelf = shelfEl ? shelfEl.value.trim() : '';
        var bin = binEl ? binEl.value.trim() : '';
        saveLocBtn.disabled = true;
        adminApiPost('update_batch', {
          batch_id: b.batch_id,
          updates: { vessel_id: vessel, shelf_id: shelf, bin_id: bin }
        })
          .then(function () {
            showToast('Location saved', 'success');
            b.vessel_id = vessel; b.shelf_id = shelf; b.bin_id = bin;
            saveLocBtn.disabled = false;
            _batchesLoaded = false;
            _allBatchesData = [];
            _eagerLoadTime = 0;
            try { sessionStorage.removeItem('sv-bp-batch-' + b.batch_id); } catch (e) {}
          })
          .catch(function (err) {
            showToast('Failed: ' + err.message, 'error');
            saveLocBtn.disabled = false;
          });
      });
    }

    // Status badge — keyboard accessible
    var statusBadge = document.getElementById('bp-detail-status');
    if (statusBadge) {
      statusBadge.setAttribute('role', 'button');
      statusBadge.setAttribute('tabindex', '0');
      statusBadge.setAttribute('aria-label', 'Batch status: ' + (STATUS_LABELS[statusKey] || b.status || '') + '. Click to change.');
      statusBadge.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); statusBadge.click(); }
      });
      statusBadge.addEventListener('click', function () {
        var cur = String(b.status || '').toLowerCase();

        // Pending batches must go through the activation flow, not the cycle
        if (cur === 'pending') {
          showConfirmSheet(
            'Activate ' + b.batch_id + ' now? No schedule will be attached and the start date is set to today.',
            'Activate', '',
            function () {
              adminApiPost('update_batch', {
                batch_id: b.batch_id,
                updates: { status: 'primary', start_date: todayPacific() },
                expectedVersion: b.last_updated
              }).then(function (res) {
                b.status = 'primary';
                // WR-03: refresh the optimistic-lock version so an immediate follow-up
                // (e.g. Add Schedule) doesn't fail with a spurious version conflict.
                if (res && res.newVersion) b.last_updated = res.newVersion;
                showToast('Batch activated', 'success');
                callSyncZoho(b.batch_id, b.zoho_so_number, 'active');
                for (var bi = 0; bi < _batchesData.length; bi++) {
                  if (_batchesData[bi].batch_id === b.batch_id) { _batchesData[bi].status = 'primary'; break; }
                }
                for (var bi2 = 0; bi2 < _allBatchesData.length; bi2++) {
                  if (_allBatchesData[bi2].batch_id === b.batch_id) { _allBatchesData[bi2].status = 'primary'; break; }
                }
                _batchesLoaded = false;
                _dashLoadTime = 0;
                try { sessionStorage.removeItem('sv-bp-batch-' + b.batch_id); } catch (e2) {}
                // WR-03: full re-render so the pending-only footer (Activate / Schedule &
                // Activate) is replaced with the active-state actions instead of leaving
                // stale buttons that carry an outdated version.
                renderBatchDetail(data);
                renderBatchList();
              }).catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
            }
          );
          return;  // CRITICAL: bail before existing cycle logic
        }

        var order = ['primary', 'secondary', 'complete'];
        var idx = order.indexOf(cur);
        var next = order[(idx + 1) % order.length];
        showConfirmSheet(
          'Move ' + b.batch_id + ' to \u201c' + (STATUS_LABELS[next] || next) + '\u201d?',
          'Confirm', 'bp-confirm-btn--primary',
          function () {
        adminApiPost('update_batch', { batch_id: b.batch_id, updates: { status: next } })
          .then(function () {
            b.status = next;
            statusBadge.textContent = STATUS_LABELS[next] || next;
            statusBadge.className = 'bp-status-badge bp-status-badge--' + (STATUS_COLORS[next] || 'info') + ' bp-status-clickable';
            statusBadge.setAttribute('aria-label', 'Batch status: ' + (STATUS_LABELS[next] || next) + '. Click to change.');
            showToast('Status updated', 'success');
            var syncStatus = 'active';
            if (next === 'complete') syncStatus = 'complete';
            callSyncZoho(b.batch_id, b.zoho_so_number, syncStatus);
            // Update the cached batch and refresh list immediately
            for (var bi = 0; bi < _batchesData.length; bi++) {
              if (_batchesData[bi].batch_id === b.batch_id) { _batchesData[bi].status = next; break; }
            }
            for (var bi2 = 0; bi2 < _allBatchesData.length; bi2++) {
              if (_allBatchesData[bi2].batch_id === b.batch_id) { _allBatchesData[bi2].status = next; break; }
            }
            _batchesLoaded = false;
            _dashLoadTime = 0;
            renderBatchList();
            try { sessionStorage.removeItem('sv-bp-batch-' + b.batch_id); } catch (e) {}
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
          }
        );
      });
    }

    // Pending-only detail footer: Activate + Schedule & Activate
    var activateDetailBtn = document.getElementById('bp-activate-detail-btn');
    if (activateDetailBtn) {
      activateDetailBtn.addEventListener('click', function () {
        showConfirmSheet(
          'Activate ' + escapeHTML(b.batch_id) + ' now? No schedule will be attached and the start date is set to today. Use "Schedule & Activate" if you need a schedule.',
          'Activate', '',
          function () {
            activateDetailBtn.disabled = true;
            adminApiPost('update_batch', {
              batch_id: b.batch_id,
              updates: { status: 'primary', start_date: todayPacific() },
              expectedVersion: b.last_updated
            }).then(function (res) {
              b.status = 'primary';
              // WR-03: refresh the optimistic-lock version so a follow-up Add Schedule
              // on the freshly-activated batch doesn't fail with a spurious conflict.
              if (res && res.newVersion) b.last_updated = res.newVersion;
              showToast('Batch activated', 'success');
              callSyncZoho(b.batch_id, b.zoho_so_number, 'active');
              for (var bi = 0; bi < _batchesData.length; bi++) {
                if (_batchesData[bi].batch_id === b.batch_id) { _batchesData[bi].status = 'primary'; break; }
              }
              for (var bi2 = 0; bi2 < _allBatchesData.length; bi2++) {
                if (_allBatchesData[bi2].batch_id === b.batch_id) { _allBatchesData[bi2].status = 'primary'; break; }
              }
              _batchesLoaded = false;
              _dashLoadTime = 0;
              try { sessionStorage.removeItem('sv-bp-batch-' + b.batch_id); } catch (e2) {}
              renderBatchDetail(data);
              renderBatchList();
            }).catch(function (err) {
              showToast('Failed: ' + err.message, 'error');
              activateDetailBtn.disabled = false;
            });
          }
        );
      });
    }

    var saDetailBtn = document.getElementById('bp-sa-detail-btn');
    if (saDetailBtn) {
      saDetailBtn.addEventListener('click', function () {
        openScheduleActivateSheet(b);
      });
    }

    // Active batch with no schedule — open the same guided sheet in "schedule" mode.
    var addScheduleBtn = document.getElementById('bp-add-schedule-btn');
    if (addScheduleBtn) {
      addScheduleBtn.addEventListener('click', function () {
        openScheduleActivateSheet(b, 'schedule');
      });
    }

    // Active batch with an existing schedule — open the guided sheet in "change" mode.
    var changeScheduleBtn = document.getElementById('bp-change-schedule-btn');
    if (changeScheduleBtn) {
      changeScheduleBtn.addEventListener('click', function () {
        openScheduleActivateSheet(b, 'change');
      });
    }

    // Invoice linking event listeners
    var linkSoBtn = document.getElementById('bp-link-so-btn');
    if (linkSoBtn) {
      linkSoBtn.addEventListener('click', function () {
        linkSoBtn.style.display = 'none';
        var searchWrap = document.getElementById('bp-link-so-search');
        if (searchWrap) searchWrap.style.display = '';
        var searchInput = document.getElementById('bp-so-search-input');
        if (searchInput) searchInput.focus();
      });
    }

    var soSearchInput = document.getElementById('bp-so-search-input');
    if (soSearchInput) {
      soSearchInput.addEventListener('input', function () {
        var term = soSearchInput.value.trim();
        clearTimeout(_soSearchTimer);
        if (!term || term.length < 2) {
          var resultsEl = document.getElementById('bp-so-search-results');
          if (resultsEl) resultsEl.innerHTML = '';
          return;
        }
        _soSearchTimer = setTimeout(function () {
          fetchSoSearch(term);
        }, 400);
      });
    }

    var soDismiss = document.getElementById('bp-so-dismiss');
    if (soDismiss) {
      soDismiss.addEventListener('click', function () {
        var searchWrap = document.getElementById('bp-link-so-search');
        if (searchWrap) searchWrap.style.display = 'none';
        var linkedDisplay = document.getElementById('bp-so-linked-display');
        if (linkedDisplay && linkedDisplay.innerHTML.trim()) {
          linkedDisplay.style.display = '';
        } else {
          if (linkSoBtn) linkSoBtn.style.display = '';
        }
      });
    }

    var changeLink = document.getElementById('bp-so-change-link');
    if (changeLink) {
      changeLink.addEventListener('click', function () {
        var linkedDisplay = document.getElementById('bp-so-linked-display');
        if (linkedDisplay) linkedDisplay.style.display = 'none';
        var searchWrap = document.getElementById('bp-link-so-search');
        if (searchWrap) searchWrap.style.display = '';
        var dismissLink = document.getElementById('bp-so-dismiss');
        if (dismissLink) dismissLink.textContent = 'Keep current link';
        var searchInput = document.getElementById('bp-so-search-input');
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
      });
    }

    // Refresh-from-Zoho handler (ZSYNC-01, Phase 29)
    var zohoRefreshBtn = document.getElementById('bp-zoho-refresh-btn');
    if (zohoRefreshBtn) {
      zohoRefreshBtn.addEventListener('click', function () {
        var soNumber = _currentBatchDetail ? _currentBatchDetail.zoho_so_number : b.zoho_so_number;
        var batchId = _currentBatchDetail ? _currentBatchDetail.batch_id : b.batch_id;

        zohoRefreshBtn.disabled = true;
        zohoRefreshBtn.textContent = 'Refreshing…';

        fetch(mwUrl() + '/api/batch/customer-by-number?number=' + encodeURIComponent(soNumber), {
          credentials: 'include'
        })
          .then(function (r) {
            if (r.status === 404) return r.json().then(function (d) { throw { status: 404, error: d.error }; });
            if (r.status === 502) return r.json().then(function (d) { throw { status: 502, error: d.error }; });
            if (r.status === 400) return r.json().then(function (d) { throw { status: 400, error: d.error }; });
            if (!r.ok) return r.json().then(function (d) { throw { status: r.status, error: d.error }; });
            return r.json();
          })
          .then(function (data) {
            var updates = buildRefreshUpdates(data);

            // CR-02: derive firstname/lastname from refreshed name so
            // getCustomerDisplayName shows the new name for all batches.
            if (updates.customer_name) {
              var nameParts = splitCustomerName(updates.customer_name);
              updates.customer_firstname = nameParts.customer_firstname;
              updates.customer_lastname = nameParts.customer_lastname;
            }

            // D-12: skip update_batch if nothing changed
            if (compareRefreshFields(data, _currentBatchDetail || b)) {
              showToast('Already up to date', 'success');
              zohoRefreshBtn.disabled = false;
              zohoRefreshBtn.textContent = 'Refresh from Zoho';
              return;
            }

            var batchVersion = _currentBatchDetail ? _currentBatchDetail.last_updated : b.last_updated;

            adminApiPost('update_batch', {
              batch_id: batchId,
              expectedVersion: batchVersion,
              updates: updates
            }).then(function (result) {
              // Update version for subsequent saves in same session
              if (result && result.newVersion) {
                if (_currentBatchDetail) _currentBatchDetail.last_updated = result.newVersion;
              }

              // D-05: in-place patch of _currentBatchDetail and DOM
              var keys = Object.keys(updates);
              for (var ki = 0; ki < keys.length; ki++) {
                var k = keys[ki];
                if (_currentBatchDetail) _currentBatchDetail[k] = updates[k];
                b[k] = updates[k];
              }

              // Patch DOM nodes in place.
              // textContent never interprets markup, so no escapeHTML needed here
              // — escaping on textContent only double-encodes entities (WR-03).
              var nameNode = document.getElementById('bp-detail-customer');
              if (nameNode) {
                nameNode.textContent = getCustomerDisplayName(_currentBatchDetail || b) || '—';
              }
              var emailNode = document.getElementById('bp-detail-email');
              if (emailNode) {
                emailNode.textContent = (_currentBatchDetail || b).customer_email || '—';
              }
              var phoneNode = document.getElementById('bp-detail-phone');
              if (phoneNode) {
                phoneNode.textContent = (_currentBatchDetail || b).customer_phone || '—';
              }

              // D-06: patch in-memory list caches
              var patchLists = [_batchesData, _allBatchesData];
              for (var li = 0; li < patchLists.length; li++) {
                if (!patchLists[li]) continue;
                for (var pi = 0; pi < patchLists[li].length; pi++) {
                  if (String(patchLists[li][pi].batch_id) === String(batchId)) {
                    for (var pk = 0; pk < keys.length; pk++) {
                      patchLists[li][pi][keys[pk]] = updates[keys[pk]];
                    }
                    break;
                  }
                }
              }

              // Bust sessionStorage snapshot
              try { sessionStorage.removeItem('sv-bp-batch-' + batchId); } catch (e) {}

              // Toast per endpoint state (D-10/D-11)
              var docStatus = data.document_status ? String(data.document_status).toLowerCase() : '';
              if (docStatus === 'void' || docStatus === 'deleted') {
                showToast('Updated — note: ' + escapeHTML(soNumber) + ' is ' + escapeHTML(docStatus) + ' in Zoho', 'warn');
              } else if (data.contact_unavailable) {
                showToast('Name updated — email/phone not available in Zoho for ' + escapeHTML(soNumber), 'success');
              } else {
                showToast('Customer info updated from ' + escapeHTML(soNumber), 'success');
              }

              zohoRefreshBtn.disabled = false;
              zohoRefreshBtn.textContent = 'Refresh from Zoho';
            }).catch(function (err) {
              zohoRefreshBtn.disabled = false;
              zohoRefreshBtn.textContent = 'Refresh from Zoho';
              var msg = err && err.message ? err.message : (err && err.error ? err.error : '');
              if (isVersionConflict(msg)) {
                showToast('Batch was updated elsewhere — please reload', 'error');
              } else {
                showToast('Refresh failed — try again', 'error');
              }
            });
          })
          .catch(function (err) {
            zohoRefreshBtn.disabled = false;
            zohoRefreshBtn.textContent = 'Refresh from Zoho';
            if (err && err.status === 400) {
              showToast('This Zoho reference is not a valid INV/SO number', 'error');
            } else if (err && err.status === 404) {
              showToast(escapeHTML(soNumber) + ' no longer exists in Zoho', 'error');
            } else if (err && err.status === 502) {
              showToast('Zoho unreachable — try again later', 'error');
            } else {
              var msg = err && err.message ? err.message : '';
              if (isVersionConflict(msg)) {
                showToast('Batch was updated elsewhere — please reload', 'error');
              } else {
                showToast('Refresh failed — try again', 'error');
              }
            }
          });
      });
    }

    // Change Customer reassign controls (Phase 29.1)
    var reassignBtn = document.getElementById('bp-reassign-btn');
    if (reassignBtn) {
      reassignBtn.addEventListener('click', function () {
        var panel = document.getElementById('bp-reassign-panel');
        if (!panel) return;
        var isVisible = panel.style.display !== 'none';
        panel.style.display = isVisible ? 'none' : '';
        if (!isVisible) {
          var searchInput = document.getElementById('bp-reassign-search-input');
          if (searchInput) { searchInput.value = ''; searchInput.focus(); }
          var resultsEl = document.getElementById('bp-reassign-results');
          if (resultsEl) resultsEl.innerHTML = '';
          var addNewForm = document.getElementById('bp-reassign-addnew');
          if (addNewForm) addNewForm.style.display = 'none';
        }
      });
    }

    var reassignSearchInput = document.getElementById('bp-reassign-search-input');
    if (reassignSearchInput) {
      reassignSearchInput.addEventListener('input', function () {
        var term = reassignSearchInput.value.trim();
        clearTimeout(_reassignSearchTimer);
        if (!term || term.length < 2) {
          var resultsEl = document.getElementById('bp-reassign-results');
          if (resultsEl) resultsEl.innerHTML = '';
          return;
        }
        _reassignSearchTimer = setTimeout(function () {
          fetchReassignSearch(term);
        }, 400);
      });
    }

    var reassignDismiss = document.getElementById('bp-reassign-dismiss');
    if (reassignDismiss) {
      reassignDismiss.addEventListener('click', function () {
        var panel = document.getElementById('bp-reassign-panel');
        if (panel) panel.style.display = 'none';
        _pendingReassign = null;
      });
    }

    var reassignAddNewToggle = document.getElementById('bp-reassign-addnew-toggle');
    if (reassignAddNewToggle) {
      reassignAddNewToggle.addEventListener('click', function () {
        var addNewForm = document.getElementById('bp-reassign-addnew');
        if (!addNewForm) return;
        var isVisible = addNewForm.style.display !== 'none';
        addNewForm.style.display = isVisible ? 'none' : '';
        if (!isVisible) {
          var nameInput = document.getElementById('bp-reassign-new-name');
          if (nameInput) { nameInput.value = ''; nameInput.focus(); }
          var emailInput = document.getElementById('bp-reassign-new-email');
          if (emailInput) emailInput.value = '';
          var phoneInput = document.getElementById('bp-reassign-new-phone');
          if (phoneInput) phoneInput.value = '';
        }
      });
    }

    var reassignNewSave = document.getElementById('bp-reassign-new-save');
    if (reassignNewSave) {
      reassignNewSave.addEventListener('click', function () {
        var nameInput = document.getElementById('bp-reassign-new-name');
        var emailInput = document.getElementById('bp-reassign-new-email');
        var phoneInput = document.getElementById('bp-reassign-new-phone');
        var name = nameInput ? nameInput.value.trim() : '';
        var email = emailInput ? emailInput.value.trim() : '';
        var phone = phoneInput ? phoneInput.value.trim() : '';
        if (!name) {
          showToast('Name is required to add a new customer', 'error');
          return;
        }
        _pendingReassign = { name: name, email: email, phone: phone };
        submitReassign();
      });
    }

    // Lazy-fetch invoice date for timeline
    if (b.zoho_so_number) {
      var searchTerm = getCustomerDisplayName(b) || '';
      if (searchTerm) {
        fetch(mwUrl() + '/api/batch/search-invoices?search=' + encodeURIComponent(searchTerm), {
          credentials: 'include'
        }).then(function (r) { return r.json(); })
          .then(function (data) {
            var invoices = data.invoices || [];
            var matchingInv = null;
            for (var k = 0; k < invoices.length; k++) {
              if (invoices[k].invoice_number === b.zoho_so_number) {
                matchingInv = invoices[k];
                break;
              }
            }
            if (matchingInv && matchingInv.date) {
              var timelineEl = document.getElementById('bp-lifecycle-timeline');
              if (timelineEl) {
                timelineEl.innerHTML = buildLifecycleTimeline(b, matchingInv.date);
              }
            }
          })
          .catch(function () {});
      }
    }

    // Readings handlers
    bindDetailReadingHandlers(b.batch_id);

    // Notes auto-save (2 s debounce)
    var notesTextarea = document.getElementById('bp-detail-notes');
    if (notesTextarea) {
      notesTextarea.addEventListener('input', function () {
        clearTimeout(_notesAutoSaveTimer);
        _notesAutoSaveTimer = setTimeout(function () {
          var notes = notesTextarea.value || '';
          adminApiPost('update_batch', { batch_id: b.batch_id, updates: { notes: notes } })
            .then(function () {
              b.notes = notes;
              showToast('Notes saved', 'success');
              try { sessionStorage.removeItem('sv-bp-batch-' + b.batch_id); } catch (e) {}
            })
            .catch(function (err) { showToast('Notes save failed: ' + err.message, 'error'); });
        }, 2000);
      });
    }

    // QR
    var qrBtn = document.getElementById('bp-detail-qr-btn');
    if (qrBtn) {
      qrBtn.addEventListener('click', function () {
        var token = b.access_token || '';
        if (!token) {
          adminApiGet('get_batch', { batch_id: b.batch_id }).then(function (r) {
            var bt = (r.data && r.data.batch && r.data.batch.access_token) || '';
            if (!bt) { showToast('No access token for this batch', 'warn'); return; }
            openBatchQR(b.batch_id, bt);
          }).catch(function () { showToast('Failed to load batch token', 'error'); });
          return;
        }
        openBatchQR(b.batch_id, token);
      });
    }

    // Label PDF
    var labelBtn = document.getElementById('bp-detail-label-btn');
    if (labelBtn) {
      labelBtn.addEventListener('click', function () {
        var token = b.access_token || '';
        if (!token) {
          adminApiGet('get_batch', { batch_id: b.batch_id }).then(function (r) {
            var bt = (r.data && r.data.batch && r.data.batch.access_token) || '';
            generateBatchLabelPDF(b, tasks, bt);
          }).catch(function () { generateBatchLabelPDF(b, tasks, ''); });
          return;
        }
        generateBatchLabelPDF(b, tasks, token);
      });
    }

    // Delete
    var deleteBtn = document.getElementById('bp-delete-batch-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        // Captured BEFORE the delete fires (Phase 64/OPS-03) — success below never
        // mutates b itself, but capturing up front matches the Needs-Scheduling site's
        // pattern and stays correct regardless of future changes to the success handler.
        var soNum = b.zoho_so_number;
        showConfirmSheet(
          'Delete ' + b.batch_id + '? This cannot be undone.',
          'Delete', 'bp-confirm-btn--danger',
          function () {
            adminApiPost('delete_batch', { batch_id: b.batch_id })
              .then(function () {
                showToast('Batch deleted', 'success');
                if (soNum) reconcileInvoiceStatusAfterDelete(soNum);
                closeBatchDetail();
                _batchesLoaded = false;
                _allBatchesData = [];
                _eagerLoadTime = 0;
                _dashLoadTime = 0;
                loadBatches();
              })
              .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
          }
        );
      });
    }

    // Send bottling invite — emails the customer a self-book Cal.com link via the
    // middleware/Resend (POST /api/batch/bottling-invite).
    var bottlingInviteBtn = document.getElementById('bp-bottling-invite-btn');
    if (bottlingInviteBtn) {
      bottlingInviteBtn.addEventListener('click', function () {
        var inviteEmail = b.customer_email || '';
        var alreadySent = b.bottling_invite_sent_at || '';
        var confirmMsg = alreadySent
          ? 'An invite was already sent ' + fmtDate(alreadySent) + '. Resend a bottling booking invite to ' + inviteEmail + '?'
          : 'Email a bottling booking invite to ' + inviteEmail + '?';
        showConfirmSheet(
          confirmMsg,
          alreadySent ? 'Resend Invite' : 'Send Invite', '',
          function () {
            bottlingInviteBtn.disabled = true;
            postBottlingInvite({
              name: b.customer_name || '',
              email: inviteEmail,
              batchId: b.batch_id,
              productName: b.product_name || ''
            })
              .then(function (resp) {
                var sentAt = (resp && resp.sent_at) || new Date().toISOString();
                b.bottling_invite_sent_at = sentAt;
                b.bottling_invite_email = inviteEmail;
                markInviteSent(sentAt, inviteEmail);
                showToast('Bottling invite sent to ' + inviteEmail, 'success');
              })
              .catch(function (err) { showToast('Failed: ' + err.message, 'error'); })
              .then(function () { bottlingInviteBtn.disabled = false; });
          }
        );
      });
    }

    // Reflect a just-sent invite in the detail pane without a full re-render:
    // relabel the button "Resend Invite" and show/refresh the "Invite sent …" note.
    function markInviteSent(sentAt, email) {
      if (bottlingInviteBtn) bottlingInviteBtn.textContent = 'Resend Invite';
      var noteText = 'Invite sent ' + fmtDate(sentAt) + (email ? ' to ' + email : '');
      var note = document.getElementById('bp-invite-sent-note');
      if (note) {
        note.textContent = noteText;
      } else if (bottlingInviteBtn && bottlingInviteBtn.parentNode) {
        note = document.createElement('p');
        note.className = 'bp-invite-sent-note';
        note.id = 'bp-invite-sent-note';
        note.textContent = noteText;
        bottlingInviteBtn.parentNode.insertBefore(note, bottlingInviteBtn);
      }
    }
  }

  function openBatchQR(batchId, token) {
    if (typeof qrcode === 'undefined') { showToast('QR library not loaded', 'error'); return; }
    var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(token);
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    var win = window.open('', '_blank');
    if (win) {
      win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
        escapeHTML(batchId) + '</title></head><body style="text-align:center;padding:2rem;font-family:sans-serif;">' +
        qr.createImgTag(5) + '<br><code style="font-size:1.1rem;">' + escapeHTML(batchId) + '</code></body></html>');
      win.document.close();
      setTimeout(function () { win.print(); }, 400);
    }
  }

  // Matches the 4"×6" admin panel label format exactly (black & white)
  function generateBatchLabelPDF(b, tasks, accessToken) {
    if (typeof window.jspdf === 'undefined') { showToast('PDF library not loaded', 'error'); return; }
    showToast('Generating label\u2026', 'info');
    function imgToDataURL(path, cb) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        cb(c.toDataURL('image/png'));
      };
      img.onerror = function () { cb(null); };
      img.src = path;
    }
    imgToDataURL('images/label-icon.png', function (iconData) {
      imgToDataURL('images/label-wordmark.png', function (wordmarkData) {
        _buildLabelPDF(b, tasks, accessToken, iconData, wordmarkData);
      });
    });
  }

  function _buildLabelPDF(b, tasks, accessToken, iconData, wordmarkData) {
    var jsPDF = window.jspdf.jsPDF;
    // 4in × 6in — matches admin panel label CSS (@page { size: 4in 6in })
    var W = 4, H = 6;
    var doc = new jsPDF({ unit: 'in', format: [W, H] });
    var px = 0.25, py = 0.2;     // padding: 0.2in 0.25in
    var cW = W - px * 2;          // content width: 3.5in
    var y = py;

    // All black & white
    doc.setTextColor(0); doc.setDrawColor(0); doc.setFillColor(0);

    // ── TOP ROW: logos + QR ──────────────────────────────────
    var rowH = 0.77;  // fits QR (72px ≈ 0.75in) + padding

    // Icon (48px ≈ 0.5in square)
    var iconH = 0.5, iconW = 0.5;
    if (iconData) doc.addImage(iconData, 'PNG', px, y + (rowH - iconH) / 2, iconW, iconH);

    // Wordmark (20px tall ≈ 0.208in; aspect ~5.5:1)
    var wmH = 0.208, wmW = wmH * 5.5;
    if (wordmarkData) doc.addImage(wordmarkData, 'PNG', px + iconW + 0.07, y + (rowH - wmH) / 2, wmW, wmH);

    // QR code (72px ≈ 0.75in) drawn from module matrix — no SVG/image needed
    var qrSz = 0.75;
    var qrX = W - px - qrSz, qrY = y + (rowH - qrSz) / 2;
    if (typeof qrcode !== 'undefined' && accessToken && b.batch_id) {
      var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(b.batch_id) + '&token=' + encodeURIComponent(accessToken);
      var qr = qrcode(0, 'M'); qr.addData(url); qr.make();
      var mc = qr.getModuleCount(), cs = qrSz / mc;
      for (var ri = 0; ri < mc; ri++) {
        for (var ci = 0; ci < mc; ci++) {
          if (qr.isDark(ri, ci)) doc.rect(qrX + ci * cs, qrY + ri * cs, cs, cs, 'F');
        }
      }
    } else {
      // Placeholder box when no token
      doc.setLineWidth(0.01); doc.rect(qrX, qrY, qrSz, qrSz);
    }

    // Border-bottom (1.5px) + margin-bottom (6px)
    y += rowH + 0.05;
    doc.setLineWidth(0.016); doc.line(px, y, W - px, y);
    y += 0.07;

    // ── BATCH ID (15px bold, letter-spacing 1px) ─────────────
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text(b.batch_id || '', W / 2, y + 0.11, { align: 'center', charSpace: 0.01 });
    y += 0.19;

    // ── PRODUCT NAME (11px, font-weight 600) ─────────────────
    doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    var pname = doc.splitTextToSize(b.product_name || b.product_sku || '', cW);
    doc.text(pname, W / 2, y + 0.1, { align: 'center' });
    y += 0.1 * pname.length + 0.12;

    // ── INFO GRID (9.5px, 2-col key:val, line-height 1.5) ─────
    var lblRX = px + 1.0;  // right edge of label col (text-align: right)
    var valLX = px + 1.08; // left edge of value col
    var iRh   = 0.148;     // 9.5px × 1.5 / 96dpi
    doc.setFontSize(6.85);

    function infoRow(label, value) {
      doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
      doc.text(label + ':', lblRX, y + 0.076, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      if (value) {
        doc.text(String(value), valLX, y + 0.076);
      } else {
        doc.setLineWidth(0.007);
        doc.line(valLX, y + 0.09, W - px, y + 0.09);
      }
      y += iRh;
    }

    var loc = [b.shelf_id, b.bin_id, b.vessel_id].filter(Boolean).join(' \u2013 ') || null;
    infoRow('Customer', getCustomerDisplayName(b) || null);
    infoRow('Email', b.customer_email || null);
    infoRow('Phone', b.customer_phone || null);
    infoRow('Start Date', b.start_date ? String(b.start_date).slice(0, 10) : null);
    infoRow('Primary Location', loc);
    infoRow('Transfer 1', null);
    infoRow('Transfer 2', null);
    infoRow('Transfer 3', null);
    y += 0.03;

    // ── SCHEDULE (8.5px, section-title + table) ───────────────
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.1); doc.setTextColor(0);
    doc.text('SCHEDULE', px, y + 0.07);
    y += 0.09;
    doc.setLineWidth(0.005); doc.line(px, y, W - px, y);
    y += 0.04;

    var startMs = b.start_date ? new Date(String(b.start_date).slice(0, 10) + 'T00:00:00').getTime() : null;
    var sRows = [];
    if (tasks && tasks.length) {
      tasks.slice(0, 8).forEach(function (t, i) {
        var dayLbl;
        if (i === 0) {
          dayLbl = 'Day 1';
        } else if (startMs && t.due_date && t.due_date !== 'TBD') {
          var diff = Math.round((new Date(String(t.due_date).slice(0, 10) + 'T00:00:00').getTime() - startMs) / 86400000);
          dayLbl = 'Day ' + (diff + 1);
        } else {
          dayLbl = '';
        }
        var dueLbl = (!t.due_date || t.due_date === 'TBD') ? 'TBD' : String(t.due_date).slice(0, 10);
        sRows.push([dayLbl, t.title || ('Step ' + t.step_number), dueLbl]);
      });
    }
    while (sRows.length < 8) sRows.push(null);

    var sRh = 0.119; // 8.5px × 1.4 / 96dpi
    doc.setFontSize(6.1);
    sRows.forEach(function (row) {
      if (row) {
        doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
        doc.text(row[0], px, y + 0.076);
        doc.setFont('helvetica', 'normal');
        doc.text(doc.splitTextToSize(row[1], cW - 1.05)[0], px + 0.52, y + 0.076);
        doc.setTextColor(85, 85, 85);
        doc.text(row[2], W - px, y + 0.076, { align: 'right' });
        doc.setTextColor(0);
      }
      y += sRh;
    });
    y += 0.03;

    // ── NOTES BOX (flex:1 — expand to fill remaining space) ───
    // Reserve space for the agreement section below
    var agreementReserve = 1.18;
    var notesH = Math.max(H - py - agreementReserve - y, 0.2);
    doc.setDrawColor(153, 153, 153); doc.setLineWidth(0.009);
    doc.rect(px, y, cW, notesH);
    // "NOTES" label tag (white knockout)
    doc.setFillColor(255, 255, 255);
    doc.rect(px + 0.03, y - 0.046, 0.28, 0.075, 'F');
    doc.setFillColor(0);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(5.1); doc.setTextColor(0);
    doc.text('NOTES', px + 0.05, y + 0.022);
    y += notesH + 0.04;

    // ── CUSTOMER AGREEMENT ────────────────────────────────────
    doc.setDrawColor(153, 153, 153); doc.setLineWidth(0.009);
    doc.line(px, y, W - px, y);
    y += 0.045;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(5.1); doc.setTextColor(0);
    doc.text('CUSTOMER AGREEMENT', W / 2, y + 0.055, { align: 'center', charSpace: 0.005 });
    y += 0.09;

    var agText = 'By signing, I request assistance and guidance, as required, in preparing my wine must for fermentation. I acknowledge that by default, Steins & Vines will add a natural shell fish derivative, Chitosan, for the purpose of clearing. I consent to my name, telephone number, address and email (if supplied) being kept in a database with the understanding that this information will not be sold or exchanged. I acknowledge that the wine made for me by Steins & Vines is for my personal use only. I acknowledge that Steins & Vines has transferred ownership of my wine and all ingredients to me.';
    doc.setFont('helvetica', 'normal'); doc.setFontSize(4.65); doc.setTextColor(51, 51, 51);
    var agLines = doc.splitTextToSize(agText, cW);
    doc.text(agLines, px, y + 0.05, { align: 'justify', lineHeightFactor: 1.35 });
    y += agLines.length * (4.65 / 72 * 1.35) + 0.06;

    // Email row
    doc.setDrawColor(0); doc.setLineWidth(0.009);
    doc.line(px, y + 0.09, W - px, y + 0.09);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(4.3); doc.setTextColor(85, 85, 85);
    doc.text('Email', W / 2, y + 0.14, { align: 'center' });
    y += 0.19;

    // Signature + Date
    var sigW = cW * 0.6;
    doc.setDrawColor(0); doc.setLineWidth(0.009);
    doc.line(px, y + 0.1, px + sigW, y + 0.1);
    doc.setFontSize(4.3); doc.setTextColor(85, 85, 85);
    doc.text('Signature', px + sigW / 2, y + 0.155, { align: 'center' });

    var dateSigX = px + sigW + 0.05;
    var dateSigW = cW - sigW - 0.05;
    doc.line(dateSigX, y + 0.1, dateSigX + dateSigW, y + 0.1);
    doc.text('Date', dateSigX + dateSigW / 2, y + 0.155, { align: 'center' });

    // Direct download — no print dialog
    doc.save('label-' + (b.batch_id || 'batch') + '.pdf');
    showToast('Label saved', 'success');
  }

  function renderDetailTasks(tasks) {
    if (!tasks || tasks.length === 0) return '<p class="bp-empty">No tasks for this batch.</p>';
    var html = '<div class="bp-task-list">';
    tasks.forEach(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
      var overdue = !done && isOverdue(t.due_date);
      var today = !done && isToday(t.due_date);
      var rowCls = 'bp-task-row' +
        (done ? ' bp-task-row--done' : '') +
        (overdue ? ' bp-task-row--overdue' : '') +
        (today ? ' bp-task-row--today' : '');
      html += '<div class="' + rowCls + '">';
      html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"' + (done ? ' checked' : '') + '></label>';
      html += '<div class="bp-task-body">';
      html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
      if (t.due_date) html += '<span class="bp-task-due">' + fmtDate(t.due_date) + '</span>';
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function renderDetailReadings(readings, startDate) {
    var html = renderDataGapWarning(readings);
    if (readings && readings.length >= 2) {
      var cacheKey = (_detailBatchId || '') + '-' + readings.length + '-' + (readings[readings.length - 1] ? readings[readings.length - 1].timestamp : '');
      if (!_chartCache[cacheKey]) {
        _chartCache[cacheKey] = renderPlatoChart(readings, startDate);
      }
      html += _chartCache[cacheKey];
    }
    if (readings && readings.length >= 2) {
      var ogReading = null, fgReading = null;
      for (var ri = 0; ri < readings.length; ri++) {
        if (readings[ri].degrees_plato != null && !ogReading) ogReading = readings[ri]; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        if (readings[ri].degrees_plato != null) fgReading = readings[ri]; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      }
      if (ogReading && fgReading && ogReading !== fgReading) {
        var og = parseFloat(ogReading.degrees_plato);
        var fg = parseFloat(fgReading.degrees_plato);
        var abv = calcAbv(og, fg);
        html += '<div class="bp-abv-strip">';
        html += '<span class="bp-abv-label">Est. ABV</span>';
        html += '<span class="bp-abv-val">' + abv.toFixed(1) + '%</span>';
        html += '<span class="bp-abv-detail">' + og.toFixed(1) + '°P → ' + fg.toFixed(1) + '°P</span>';
        html += '</div>';
      }
    }
    if (readings && readings.length > 0) {
      html += '<table class="bp-readings-table" aria-label="Plato readings"><thead><tr><th>Date</th><th>&deg;P</th><th>Temp</th><th>pH</th><th>Notes</th><th class="bp-reading-th-actions"></th></tr></thead><tbody>';
      var rdLen = readings.length;
      readings.slice().reverse().slice(0, 10).forEach(function (r, i) {
        var actualIdx = rdLen - 1 - i;
        html += '<tr>';
        html += '<td>' + fmtDate(r.timestamp) + '</td>';
        html += '<td>' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '</td>'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        html += '<td>' + escapeHTML(r.temperature != null ? r.temperature : '') + '</td>'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        html += '<td>' + escapeHTML(r.ph != null ? r.ph : '') + '</td>'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        html += '<td>' + escapeHTML(r.notes || '') + '</td>';
        html += '<td class="bp-reading-actions">';
        html += '<button class="bp-reading-edit" data-idx="' + actualIdx + '" title="Edit">\u270E</button>';
        html += '<button class="bp-reading-del" data-idx="' + actualIdx + '" title="Delete">&times;</button>';
        html += '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="bp-empty">No readings yet.</p>';
    }
    html += '<div class="bp-reading-add-row">';
    html += '<input type="date" id="bp-detail-plato-date" class="bp-inline-input" style="width:120px;">';
    html += '<input type="number" id="bp-detail-plato-val" step="0.1" max="40" placeholder="&deg;P" class="bp-inline-input" style="width:64px;">';
    html += '<input type="number" id="bp-detail-plato-temp" step="0.1" placeholder="Temp" class="bp-inline-input" style="width:64px;">';
    html += '<input type="number" id="bp-detail-plato-ph" step="0.01" min="0" max="14" placeholder="pH" class="bp-inline-input" style="width:60px;">';
    html += '<input type="text" id="bp-detail-plato-notes" placeholder="Notes" class="bp-inline-input" style="flex:1;">';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-add-reading">+ Add</button>';
    html += '</div>';
    html += '<div id="bp-detail-staging-wrap">' + renderDetailStagingTable() + '</div>';
    return html;
  }

  function renderDetailStagingTable() {
    if (_detailPlatoStaging.length === 0) return '';
    var html = '<table class="bp-readings-table bp-staging-table"><thead><tr><th>Date</th><th>&deg;P</th><th>Temp</th><th>pH</th><th>Notes</th><th></th></tr></thead><tbody>';
    _detailPlatoStaging.forEach(function (r, i) {
      html += '<tr>';
      html += '<td>' + escapeHTML(r.timestamp) + '</td>';
      html += '<td>' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '</td>'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      html += '<td>' + escapeHTML(r.temperature != null ? r.temperature : '') + '</td>'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      html += '<td>' + escapeHTML(r.ph != null ? r.ph : '') + '</td>'; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      html += '<td>' + escapeHTML(r.notes || '') + '</td>';
      html += '<td><button type="button" class="bp-staging-remove" data-idx="' + i + '">&times;</button></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-submit-readings">Submit All (' + _detailPlatoStaging.length + ')</button>';
    return html;
  }

  function bindDetailReadingHandlers(batchId) {
    var dateInput = document.getElementById('bp-detail-plato-date');
    if (dateInput) dateInput.value = todayStr();

    var addBtn = document.getElementById('bp-detail-add-reading');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var dateVal = (document.getElementById('bp-detail-plato-date') || {}).value || '';
        var gravRaw = (document.getElementById('bp-detail-plato-val') || {}).value || '';
        var tempRaw = (document.getElementById('bp-detail-plato-temp') || {}).value || '';
        var phRaw   = (document.getElementById('bp-detail-plato-ph') || {}).value || '';
        var notesVal = (document.getElementById('bp-detail-plato-notes') || {}).value || '';
        if (!dateVal) { showToast('Enter a date', 'error'); return; }
        if (gravRaw === '' && tempRaw === '' && phRaw === '') { showToast('Enter at least one measurement', 'error'); return; }
        var row = { timestamp: dateVal };
        if (gravRaw !== '') row.degrees_plato = parseFloat(gravRaw);
        if (tempRaw !== '') row.temperature   = parseFloat(tempRaw);
        if (phRaw   !== '') row.ph            = parseFloat(phRaw);
        if (notesVal) row.notes = notesVal;
        _detailPlatoStaging.push(row);
        var stagingWrap = document.getElementById('bp-detail-staging-wrap');
        if (stagingWrap) stagingWrap.innerHTML = renderDetailStagingTable();
        bindDetailStagingHandlers(batchId);
        ['bp-detail-plato-val', 'bp-detail-plato-temp', 'bp-detail-plato-ph', 'bp-detail-plato-notes'].forEach(function (id) {
          var el = document.getElementById(id); if (el) el.value = '';
        });
      });
    }
    bindDetailStagingHandlers(batchId);
  }

  function bindDetailStagingHandlers(batchId) {
    // Staging remove buttons handled by delegation on #bp-batch-detail-pane (see initDelegation)
    var submitBtn = document.getElementById('bp-detail-submit-readings');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        if (!_detailPlatoStaging.length) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting\u2026';
        var rows = _detailPlatoStaging.slice();
        var stagingBackup = _detailPlatoStaging.slice();
        var readingTimeout = setTimeout(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit All (' + _detailPlatoStaging.length + ')';
          showToast('Request timed out — readings preserved', 'error');
        }, 60000);
        adminApiPost('bulk_add_plato_readings', { batch_id: batchId, readings: rows })
          .then(function (result) {
            clearTimeout(readingTimeout);
            showToast(rows.length + ' reading' + (rows.length !== 1 ? 's' : '') + ' recorded', 'success');
            var results = (result && result.results) || [];
            rows.forEach(function (r, i) {
              r.reading_id = (results[i] && results[i].reading_id) || ('confirmed-' + Date.now() + i);
              _detailPlatoReadings.push(r);
            });
            _detailPlatoStaging = [];
            _chartCache = {};   // new reading → invalidate memoized chart
            afterBatchWrite(batchId, { listAffecting: false }); // bust stale detail snapshot (#13)
            var readingsEl = document.getElementById('bp-detail-readings');
            if (readingsEl) {
              readingsEl.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
              bindDetailReadingHandlers(batchId);
            }
          })
          .catch(function (err) {
            clearTimeout(readingTimeout);
            showToast('Failed: ' + err.message + ' — readings preserved', 'error');
            _detailPlatoStaging = stagingBackup; // Restore staging on network failure
            submitBtn.disabled = false;
            var wrap = document.getElementById('bp-detail-staging-wrap');
            if (wrap) wrap.innerHTML = renderDetailStagingTable();
            bindDetailStagingHandlers(batchId);
          });
      });
    }
  }

  function closeBatchDetail() {
    var returnTab = _batchDetailReturnTab;
    _batchDetailReturnTab = null;
    _selectedBatchId = null;
    // Restore list pane interactivity (was inert when detail overlaid it in portrait)
    var listPane = document.getElementById('bp-batch-list-pane');
    if (listPane) listPane.removeAttribute('inert');
    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (detailPane) {
      detailPane.classList.remove('bp-detail-slide-in');
      setTimeout(function () {
        // If a new batch was selected during the close animation (e.g. a dashboard chip
        // switched to the Batches tab and immediately opened a batch), don't hide it —
        // the deferred hide would otherwise clobber the freshly-opened detail pane.
        if (_selectedBatchId) return;
        detailPane.style.display = 'none';
        if (returnTab) switchTab(returnTab);
      }, 180);
    } else if (returnTab) {
      switchTab(returnTab);
    }
    Array.prototype.forEach.call(document.querySelectorAll('.bp-batch-card'), function (c) {
      c.classList.remove('bp-batch-card--selected');
    });
  }

  function openReadingEditRow(idx) {
    var r = _detailPlatoReadings[idx];
    if (!r) return;
    var tbody = document.querySelector('#bp-detail-readings tbody');
    if (!tbody) return;
    // rows are rendered reversed; idx is actual position in _detailPlatoReadings
    // rendered row position = len - 1 - idx
    var rowPos = _detailPlatoReadings.length - 1 - idx;
    var rows = tbody.querySelectorAll('tr');
    var rowEl = rows[rowPos];
    if (!rowEl) return;
    rowEl.className = 'bp-reading-edit-row';
    rowEl.innerHTML =
      '<td><input class="bp-inline-input" id="re-date" type="date" value="' + escapeHTML(r.timestamp ? String(r.timestamp).slice(0, 10) : '') + '" style="width:110px;"></td>' +
      '<td><input class="bp-inline-input" id="re-plato" type="number" inputmode="decimal" step="0.1" max="40" value="' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '" style="width:56px;"></td>' + // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      '<td><input class="bp-inline-input" id="re-temp" type="number" inputmode="decimal" step="0.1" value="' + escapeHTML(r.temperature != null ? r.temperature : '') + '" style="width:56px;"></td>' + // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      '<td><input class="bp-inline-input" id="re-ph" type="number" inputmode="decimal" step="0.01" min="0" max="14" value="' + escapeHTML(r.ph != null ? r.ph : '') + '" style="width:52px;"></td>' + // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      '<td><input class="bp-inline-input" id="re-notes" type="text" value="' + escapeHTML(r.notes || '') + '" style="width:100%;"></td>' +
      '<td class="bp-reading-actions">' +
      '<button class="btn bp-btn-sm bp-reading-save-edit" data-idx="' + idx + '">Save</button>' +
      '<button class="bp-reading-cancel-edit btn-secondary bp-btn-sm" data-idx="' + idx + '">\u00d7</button>' +
      '</td>';
  }

  // ===== Vessel Search (adapted from admin.js) =====

  function buildVesselLabel(v) {
    var vid = String(v.vessel_id || '');
    var parts = [vid];
    if (typeof v.label === 'string' && v.label) parts.push(v.label);
    if (v.type) parts.push(v.type);
    if (v.capacity_liters) parts.push(v.capacity_liters + 'L');
    if (v.material) parts.push(v.material);
    return parts.join(' \u2014 ');
  }

  function bindVesselSearch(input, dropdownEl, hiddenEl, currentVesselId) {
    function showOptions(term) {
      if (!_vesselsData) { dropdownEl.style.display = 'none'; return; }
      var matches = _vesselsData.filter(function (v) {
        var vid = String(v.vessel_id || '');
        var status = String(v.status || '').toLowerCase();
        var available = !status || status === 'available' || status === 'empty';
        if (!available && vid !== currentVesselId) return false;
        if (!term) return true;
        var s = (vid + ' ' + (typeof v.label === 'string' ? v.label : '') + ' ' + (v.type || '') + ' ' + (v.capacity_liters || '') + ' ' + (v.location || '')).toLowerCase();
        return s.indexOf(term.toLowerCase()) !== -1;
      });
      if (matches.length === 0) {
        dropdownEl.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">No available vessels</div>';
      } else {
        dropdownEl.innerHTML = matches.map(function (v) {
          return '<div class="bp-vessel-option" data-vid="' + escapeHTML(String(v.vessel_id)) + '">' + escapeHTML(buildVesselLabel(v)) + '</div>';
        }).join('');
      }
      dropdownEl.style.display = '';
      Array.prototype.forEach.call(dropdownEl.querySelectorAll('.bp-vessel-option[data-vid]'), function (opt) {
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          var vid = opt.getAttribute('data-vid');
          hiddenEl.value = vid;
          var v = null;
          for (var i = 0; i < _vesselsData.length; i++) {
            if (String(_vesselsData[i].vessel_id) === vid) { v = _vesselsData[i]; break; }
          }
          input.value = v ? buildVesselLabel(v) : vid;
          dropdownEl.style.display = 'none';
        });
      });
    }

    input.addEventListener('focus', function () { if (!input.value.trim()) showOptions(''); });
    var timer;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { showOptions(input.value.trim()); }, 150);
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { dropdownEl.style.display = 'none'; }, 200);
    });
  }

  function bindShelfInput(el) {
    el.setAttribute('maxlength', '1');
    el.addEventListener('input', function () { el.value = el.value.replace(/[^a-zA-Z]/g, '').toUpperCase(); });
    el.addEventListener('blur',  function () { el.value = el.value.replace(/[^a-zA-Z]/g, '').toUpperCase(); });
  }

  function bindBinInput(el) {
    el.setAttribute('maxlength', '2');
    el.addEventListener('input', function () { el.value = el.value.replace(/[^0-9]/g, ''); });
    el.addEventListener('blur', function () {
      var n = parseInt(el.value, 10);
      if (isNaN(n) || n < 1) { el.value = ''; return; }
      if (n > 36) n = 36;
      el.value = n < 10 ? '0' + n : String(n);
    });
  }

  // ===== Plato Chart (enhanced) =====

  function renderPlatoChart(readings, startDate) {
    if (!readings || readings.length < 2) return '';
    var W = 480; var H = 160; var PAD = 34;
    var start = startDate ? new Date(startDate) : new Date(readings[0].timestamp);

    var points = readings.map(function (r) {
      var d = new Date(r.timestamp);
      return {
        day: Math.round((d - start) / 86400000),
        plato: r.degrees_plato != null ? Number(r.degrees_plato) : NaN, // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        temp: r.temperature != null ? Number(r.temperature) : NaN // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
      };
    }).filter(function (p) { return !isNaN(p.plato); });
    if (points.length < 2) return '';

    var maxDay = Math.max.apply(null, points.map(function (p) { return p.day; })) || 1;
    var maxP = Math.max.apply(null, points.map(function (p) { return p.plato; }));
    var minP = Math.min.apply(null, points.map(function (p) { return p.plato; }));
    if (maxP === minP) { maxP += 2; minP = Math.max(0, minP - 1); }
    var pRange = maxP - minP;

    function toX(day) { return PAD + (day / maxDay) * (W - PAD * 2); }
    function toY(plato) { return H - PAD - ((plato - minP) / pRange) * (H - PAD * 2); }

    // Fermentation rate (slope over last 2 readings)
    var rateStr = '';
    var lastTwo = points.slice(-2);
    if (lastTwo.length === 2 && lastTwo[1].day > lastTwo[0].day) {
      var rate = (lastTwo[0].plato - lastTwo[1].plato) / (lastTwo[1].day - lastTwo[0].day);
      rateStr = rate.toFixed(2) + '\u00b0P/day';
    }

    // Stuck fermentation: < 0.2°P change in last 5 days, batch is >5 days old
    var stuckWarning = '';
    if (maxDay > 5 && points.length >= 2) {
      var recent = points.filter(function (p) { return p.day >= maxDay - 5; });
      if (recent.length >= 2) {
        var gravChange = Math.abs(recent[0].plato - recent[recent.length - 1].plato);
        if (gravChange < 0.2) stuckWarning = 'Fermentation may be stalled (<0.2\u00b0P in 5 days)';
      }
    }

    // Build polyline for gravity
    var polyPoints = points.map(function (p) { return toX(p.day) + ',' + toY(p.plato); }).join(' ');
    var dots = points.map(function (p) {
      return '<circle cx="' + toX(p.day) + '" cy="' + toY(p.plato) + '" r="3.5" fill="#4a6f4b" stroke="#fff" stroke-width="1"/>';
    }).join('');

    // Temperature overlay
    var tempPts = points.filter(function (p) { return !isNaN(p.temp); });
    var tempPolyline = '';
    var tempLegend = '';
    if (tempPts.length >= 2) {
      var maxT = Math.max.apply(null, tempPts.map(function (p) { return p.temp; }));
      var minT = Math.min.apply(null, tempPts.map(function (p) { return p.temp; }));
      if (maxT === minT) { maxT += 2; minT -= 2; }
      var tRange = maxT - minT;
      function toYT(t) { return H - PAD - ((t - minT) / tRange) * (H - PAD * 2); }
      var tPoly = tempPts.map(function (p) { return toX(p.day) + ',' + toYT(p.temp); }).join(' ');
      tempPolyline = '<polyline points="' + tPoly + '" fill="none" stroke="#d67a3a" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.75"/>';
      // Temp axis labels on right
      var rightEdge = W - PAD + 4;
      tempPolyline += '<text x="' + rightEdge + '" y="' + (PAD + 4) + '" font-size="8" fill="#d67a3a">' + maxT.toFixed(0) + '\u00b0</text>';
      tempPolyline += '<text x="' + rightEdge + '" y="' + (H - PAD) + '" font-size="8" fill="#d67a3a">' + minT.toFixed(0) + '\u00b0</text>';
      tempLegend = '<line x1="' + (W - PAD - 44) + '" y1="' + (PAD - 10) + '" x2="' + (W - PAD - 30) + '" y2="' + (PAD - 10) + '" stroke="#d67a3a" stroke-width="1.5" stroke-dasharray="4 3"/>' +
        '<text x="' + (W - PAD - 27) + '" y="' + (PAD - 6) + '" font-size="8" fill="#d67a3a">Temp</text>';
    }

    // Mid grid line for reference
    var midP = minP + pRange / 2;
    var midY = toY(midP);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="bp-plato-chart" role="img" aria-label="Fermentation gravity curve">';
    // Background grid
    svg += '<line x1="' + PAD + '" y1="' + midY + '" x2="' + (W - PAD) + '" y2="' + midY + '" stroke="#e8e2ca" stroke-width="1" stroke-dasharray="4 3"/>';
    svg += '<text x="2" y="' + (midY + 3) + '" font-size="8" fill="#c4b49a">' + midP.toFixed(1) + '</text>';
    // Axes
    svg += '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="#c4b49a" stroke-width="1"/>';
    svg += '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (H - PAD) + '" stroke="#c4b49a" stroke-width="1"/>';
    // Axis labels
    svg += '<text x="' + PAD + '" y="' + (H - 4) + '" font-size="8" fill="#9a8672">Day 0</text>';
    svg += '<text x="' + (W - PAD) + '" y="' + (H - 4) + '" font-size="8" fill="#9a8672" text-anchor="end">Day ' + maxDay + '</text>';
    svg += '<text x="2" y="' + (PAD + 4) + '" font-size="8" fill="#9a8672">' + maxP.toFixed(1) + '</text>';
    svg += '<text x="2" y="' + (H - PAD) + '" font-size="8" fill="#9a8672">' + minP.toFixed(1) + '</text>';
    svg += '<text x="' + (W / 2) + '" y="' + (H - 4) + '" font-size="8" fill="#9a8672" text-anchor="middle">\u00b0Plato</text>';
    // Gravity legend
    svg += '<line x1="' + (PAD + 4) + '" y1="' + (PAD - 10) + '" x2="' + (PAD + 18) + '" y2="' + (PAD - 10) + '" stroke="#4a6f4b" stroke-width="2"/>';
    svg += '<text x="' + (PAD + 21) + '" y="' + (PAD - 6) + '" font-size="8" fill="#4a6f4b">Gravity</text>';
    if (tempLegend) svg += tempLegend;
    // Lines + overlays
    if (tempPolyline) svg += tempPolyline;
    svg += '<polyline points="' + polyPoints + '" fill="none" stroke="#4a6f4b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    svg += dots;
    svg += '</svg>';

    var html = '<div class="bp-chart-wrap">';
    if (stuckWarning) html += '<div class="bp-chart-warning bp-chart-warning--danger">\u26a0\ufe0f ' + stuckWarning + '</div>';
    if (rateStr) html += '<div class="bp-chart-meta">Rate: <strong>' + rateStr + '</strong></div>';
    html += svg + '</div>';
    return html;
  }

  // ===== Create Batch Bottom Sheet =====

  function openCreateSheet() {
    var sheet = document.getElementById('bp-create-sheet');
    var inner = document.getElementById('bp-create-sheet-inner');
    if (!sheet || !inner) return;
    sheet.style.display = '';
    setTimeout(function () { sheet.classList.add('bp-create-sheet--open'); }, 10);
    buildCreateForm(inner);
    // Backdrop tap to dismiss: tap outside the inner sheet panel closes it.
    sheet.addEventListener('click', function handleBackdropClick(e) {
      if (e.target === sheet) {
        closeCreateSheet();
        sheet.removeEventListener('click', handleBackdropClick);
      }
    });
    // Focus first input after slide-in animation completes
    setTimeout(function () {
      var firstInput = inner.querySelector('input[type="text"], input[type="search"]');
      if (firstInput) firstInput.focus();
    }, 260);
  }

  function closeCreateSheet() {
    var sheet = document.getElementById('bp-create-sheet');
    if (!sheet) return;
    sheet.classList.remove('bp-create-sheet--open');
    setTimeout(function () { sheet.style.display = 'none'; }, 180);
  }

  // ===== Schedule & Activate Bottom Sheet =====

  function scheduleActionLabel(mode) {
    if (mode === 'change') return 'Update Schedule';
    if (mode === 'schedule') return 'Add Schedule';
    return 'Schedule & Activate';
  }

  // mode: 'activate' (pending → primary, default) | 'schedule' (active, no schedule yet) | 'change' (active, replace existing schedule)
  function buildScheduleActivateSheetHtml(batch, mode) {
    var isChange = mode === 'change';
    var scheduleOnly = mode === 'schedule' || isChange; // active batch — do not change status
    var titleText = isChange ? 'Change Schedule' : (scheduleOnly ? 'Add Schedule' : 'Schedule & Activate');
    var submitLabel = scheduleActionLabel(mode);
    // Keep an already-active batch's real start date; only fall back to today for pending activation.
    var startDefault = scheduleOnly && batch.start_date ? String(batch.start_date).slice(0, 10) : todayPacific();
    var currentSchedId = isChange ? String(batch.schedule_id || '') : '';

    var schedOptions = '<option value="">— Select a schedule —</option>';
    _fermSchedules.forEach(function (s) {
      var sel = (currentSchedId && String(s.schedule_id) === currentSchedId) ? ' selected' : '';
      schedOptions += '<option value="' + escapeHTML(s.schedule_id) + '"' + sel + '>' +
        escapeHTML(s.name || s.schedule_id) + '</option>';
    });

    var html = '<div class="bp-create-form">';
    html += '<div class="bp-create-form-header">';
    html += '<span class="bp-create-form-title">' + escapeHTML(titleText) + '</span>';
    html += '<button type="button" class="bp-create-close" id="bp-sa-close">&times;</button>';
    html += '</div>';

    html += '<p style="margin:0 0 12px 0;font-size:0.85rem;color:var(--ink-secondary);">';
    html += (isChange ? 'Changing schedule for ' : (scheduleOnly ? 'Scheduling ' : 'Activating ')) + '<strong>' + escapeHTML(batch.batch_id || '') + '</strong>';
    if (batch.product_name) {
      html += ' — ' + escapeHTML(batch.product_name || '');
    }
    html += '</p>';

    if (isChange) {
      html += '<p style="margin:0 0 12px 0;font-size:0.8rem;color:var(--batch-warning);background:var(--batch-warning-bg);padding:8px 10px;border-radius:var(--r-sm);">';
      html += 'Changing the schedule recomputes upcoming tasks from the start date. Completed tasks are kept.';
      html += '</p>';
    }

    // Schedule select
    html += '<div class="bp-form-group"><label for="bp-sa-schedule-select">Schedule <span style="color:#c0392b;">*</span></label>';
    html += '<select id="bp-sa-schedule-select" class="bp-select">' + schedOptions + '</select>';
    html += '</div>';

    // Schedule step preview
    html += '<div id="bp-sa-schedule-preview"></div>';

    // Start date
    html += '<div class="bp-form-group"><label for="bp-sa-start-date">Start Date</label>';
    html += '<input type="date" id="bp-sa-start-date" class="bp-inline-input" value="' + escapeHTML(startDefault) + '">';
    html += '</div>';

    // Vessel search
    html += '<div class="bp-form-group"><label for="bp-sa-vessel-search">Vessel (optional)</label>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-sa-vessel-search" class="bp-inline-input" placeholder="Search vessels…" autocomplete="off">';
    html += '<div class="bp-vessel-dropdown" id="bp-sa-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-sa-vessel">';
    html += '</div></div>';

    // Shelf
    html += '<div class="bp-form-group bp-form-row">';
    html += '<div><label for="bp-sa-shelf">Shelf (optional)</label>';
    html += '<input type="text" id="bp-sa-shelf" class="bp-inline-input" placeholder="e.g. A">';
    html += '</div>';
    // Bin
    html += '<div><label for="bp-sa-bin">Bin (optional)</label>';
    html += '<input type="text" id="bp-sa-bin" class="bp-inline-input" placeholder="e.g. 3">';
    html += '</div></div>';

    // Submit
    html += '<div class="bp-form-actions">';
    html += '<button type="button" id="bp-sa-submit" class="btn">' + escapeHTML(submitLabel) + '</button>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  function openScheduleActivateSheet(batch, mode) {
    var scheduleOnly = mode === 'schedule' || mode === 'change';
    function _buildAndShow(b) {
      var sheet = document.getElementById('bp-sa-sheet');
      if (!sheet) {
        sheet = document.createElement('div');
        sheet.id = 'bp-sa-sheet';
        sheet.className = 'bp-create-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        var inner = document.createElement('div');
        inner.id = 'bp-sa-sheet-inner';
        inner.className = 'bp-create-sheet-inner';
        sheet.appendChild(inner);
        document.body.appendChild(sheet);
      }

      var inner = document.getElementById('bp-sa-sheet-inner');
      if (!inner) return;
      inner.innerHTML = buildScheduleActivateSheetHtml(b, mode);

      // Show with animation lifecycle (mirror openCreateSheet)
      sheet.style.display = '';
      setTimeout(function () { sheet.classList.add('bp-create-sheet--open'); }, 10);

      // Backdrop tap to dismiss
      sheet.addEventListener('click', function handleSaBackdrop(e) {
        if (e.target === sheet) {
          closeScheduleActivateSheet();
          sheet.removeEventListener('click', handleSaBackdrop);
        }
      });

      // Close button
      var closeBtn = document.getElementById('bp-sa-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', closeScheduleActivateSheet);
      }

      // Focus first input after animation
      setTimeout(function () {
        var firstInput = inner.querySelector('input[type="text"], input[type="search"], select');
        if (firstInput) firstInput.focus();
      }, 260);

      // Schedule select -> preview
      var schedSelect = document.getElementById('bp-sa-schedule-select');
      var preview = document.getElementById('bp-sa-schedule-preview');
      function renderSchedPreview(schedId) {
        if (!preview) return;
        var sched = null;
        for (var si = 0; si < _fermSchedules.length; si++) {
          if (_fermSchedules[si].schedule_id === schedId) { sched = _fermSchedules[si]; break; }
        }
        if (!sched) { preview.innerHTML = ''; return; }
        var steps = sched.steps_parsed || [];
        if (!steps.length && sched.steps) {
          try { steps = JSON.parse(sched.steps); } catch (eparse) {}
        }
        var pHtml = '<div class="schedule-preview-steps" style="margin:0 0 12px 0;">';
        steps.forEach(function (s) {
          var dayLabel = s.is_packaging ? 'TBD' : ('Day ' + s.day_offset);
          var badges = '';
          if (s.is_transfer) {
            badges += ' <span class="batch-task-badge batch-task-badge--transfer">Transfer</span>';
          }
          if (s.is_packaging) {
            badges += ' <span class="batch-task-badge batch-task-badge--pkg">Packaging</span>';
          }
          pHtml += '<div class="schedule-preview-step" style="font-size:0.82rem;margin-bottom:4px;">' +
            '<strong>' + escapeHTML(dayLabel) + ':</strong> ' +
            escapeHTML(s.title || '') + badges +
            (s.description ? ' — ' + escapeHTML(s.description) : '') +
            '</div>';
        });
        pHtml += '</div>';
        preview.innerHTML = pHtml;
      }
      if (schedSelect && preview) {
        schedSelect.addEventListener('change', function () {
          renderSchedPreview(schedSelect.value);
        });
        // In change mode the current schedule is pre-selected — show its preview immediately.
        if (schedSelect.value) renderSchedPreview(schedSelect.value);
      }

      // Vessel / shelf / bin bindings
      var vesselSearch = document.getElementById('bp-sa-vessel-search');
      var vesselDropdown = document.getElementById('bp-sa-vessel-dropdown');
      var vesselHidden = document.getElementById('bp-sa-vessel');
      if (vesselSearch && vesselDropdown && vesselHidden) {
        bindVesselSearch(vesselSearch, vesselDropdown, vesselHidden, '');
      }
      var saShelf = document.getElementById('bp-sa-shelf');
      var saBin = document.getElementById('bp-sa-bin');
      if (saShelf) bindShelfInput(saShelf);
      if (saBin) bindBinInput(saBin);

      // Submit handler — two-step step1Done orchestration
      var submitBtn = document.getElementById('bp-sa-submit');
      if (submitBtn) {
        submitBtn.addEventListener('click', function () {
          var schedSelect2 = document.getElementById('bp-sa-schedule-select');
          var schedId2 = schedSelect2 ? schedSelect2.value : '';
          if (!schedId2) {
            showToast('Please select a schedule', 'error');
            return;
          }

          var sched2 = null;
          for (var si2 = 0; si2 < _fermSchedules.length; si2++) {
            if (_fermSchedules[si2].schedule_id === schedId2) { sched2 = _fermSchedules[si2]; break; }
          }
          if (!sched2) {
            showToast('Schedule not found — please refresh and try again', 'error');
            return;
          }

          var schedSteps = sched2.steps_parsed || [];
          if (!schedSteps.length && sched2.steps) {
            try { schedSteps = JSON.parse(sched2.steps); } catch (eparse2) {}
          }

          var startDateEl = document.getElementById('bp-sa-start-date');
          var startDate = (startDateEl && startDateEl.value) ? startDateEl.value : todayPacific();

          // Activation promotes a pending batch to primary; schedule-only mode must NOT
          // change the status of an already-active batch (could be secondary/packaging).
          var batchUpdates = scheduleOnly ? { start_date: startDate } : { status: 'primary', start_date: startDate };
          var vesselHidden2 = document.getElementById('bp-sa-vessel');
          var saShelf2 = document.getElementById('bp-sa-shelf');
          var saBin2 = document.getElementById('bp-sa-bin');
          if (vesselHidden2 && vesselHidden2.value.trim()) {
            batchUpdates.vessel_id = vesselHidden2.value.trim();
          }
          if (saShelf2 && saShelf2.value.trim()) {
            batchUpdates.shelf_id = saShelf2.value.trim();
          }
          if (saBin2 && saBin2.value.trim()) {
            batchUpdates.bin_id = saBin2.value.trim();
          }

          submitBtn.disabled = true;
          submitBtn.textContent = scheduleOnly ? 'Saving…' : 'Activating…';

          var step1Done = false;
          adminApiPost('update_batch', {
            batch_id: b.batch_id,
            expectedVersion: b.last_updated,
            updates: batchUpdates
          }).then(function (step1Result) {
            step1Done = true;
            var newVersion = step1Result.newVersion || b.last_updated;
            return adminApiPost('update_batch_schedule', {
              batch_id: b.batch_id,
              expectedVersion: newVersion,
              schedule_id: schedId2,
              schedule_snapshot: schedSteps
            }).then(function (step2Result) {
              var okMsg;
              if (mode === 'change') {
                var changed = (step2Result.tasks_updated || 0) + (step2Result.tasks_created || 0);
                okMsg = 'Schedule updated — ' + changed + ' task' + (changed !== 1 ? 's' : '') + ' adjusted';
              } else if (scheduleOnly) {
                var added = step2Result.tasks_created || 0;
                okMsg = 'Schedule added — ' + added + ' task' + (added !== 1 ? 's' : '') + ' created';
              } else {
                var sched = step2Result.tasks_created || 0;
                okMsg = 'Batch activated with ' + sched + ' task' + (sched !== 1 ? 's' : '') + ' scheduled';
              }
              showToast(okMsg, 'success');
              closeScheduleActivateSheet();
              // Bust snapshot + list/dash + re-render open detail (#14 — worst offender)
              afterBatchWrite(b.batch_id, { listAffecting: true, refreshOpenDetail: true });
              loadDashboard();
            });
          }).catch(function (err) {
            var msg = err.message || 'Unknown error';
            if (!step1Done && (msg.indexOf('version_conflict') !== -1 || msg.indexOf('Batch was modified') !== -1)) {
              showToast('Version conflict — refresh and try again', 'error');
            } else if (step1Done) {
              showToast('Batch saved, but the schedule didn\'t apply — try Add Schedule again from the batch detail', 'warning');
              closeScheduleActivateSheet();
              // step1 succeeded (batch updated) so bust the snapshot, but no re-render since
              // schedule tasks weren't created — user will see partial state on re-open.
              afterBatchWrite(b.batch_id, { listAffecting: true });
              loadDashboard();
            } else {
              showToast('Failed: ' + msg, 'error');
            }
            submitBtn.disabled = false;
            submitBtn.textContent = scheduleActionLabel(mode);
          });
        });
      }
    }

    // _fermSchedules guard (Pitfall 4): load schedules first if empty
    if (!_fermSchedules || _fermSchedules.length === 0) {
      var reloadProm = reloadSchedules();
      if (reloadProm && typeof reloadProm.then === 'function') {
        reloadProm.then(function () { _buildAndShow(batch); })
          .catch(function () { _buildAndShow(batch); });
      } else {
        // reloadSchedules may not return a promise; open after a short delay
        setTimeout(function () { _buildAndShow(batch); }, 400);
      }
    } else {
      _buildAndShow(batch);
    }
  }

  function closeScheduleActivateSheet() {
    var sheet = document.getElementById('bp-sa-sheet');
    if (!sheet) return;
    sheet.classList.remove('bp-create-sheet--open');
    setTimeout(function () { sheet.style.display = 'none'; }, 180);
  }

  function buildCreateForm(container) {
    var today = todayStr();

    var schedOptions = '<option value="">\u2014 None \u2014</option>';
    _fermSchedules.forEach(function (s) {
      schedOptions += '<option value="' + escapeHTML(s.schedule_id) + '">' +
        escapeHTML(s.name || s.schedule_id) + '</option>';
    });

    var html = '<div class="bp-create-form">';
    html += '<div class="bp-create-form-header">';
    html += '<span class="bp-create-form-title">New Batch</span>';
    html += '<button type="button" class="bp-create-close" id="bp-create-close">&times;</button>';
    html += '</div>';

    // Product \u2014 tabbed picker per D-01 (Phase 16)
    html += '<div class="bp-form-group"><label>Product</label>';
    html += '<div class="bp-product-tabs">';
    html += '<div class="bp-product-tab-bar">';
    html += '<button type="button" class="bp-product-tab bp-product-tab--active" data-picker-tab="kits">Kits</button>';
    html += '<button type="button" class="bp-product-tab" data-picker-tab="recipes">Recipes</button>';
    html += '</div>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-new-product-text" class="bp-inline-input" placeholder="Search kits\u2026" autocomplete="off">';
    html += '<div class="bp-vessel-dropdown" id="bp-new-product-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-new-product-sku">';
    html += '<input type="hidden" id="bp-new-product-name">';
    html += '<input type="hidden" id="bp-new-recipe-id">';
    html += '<input type="hidden" id="bp-new-recipe-snapshot">';
    html += '</div></div></div>';

    // Customer
    html += '<div class="bp-form-group"><label>Customer <span class="bp-optional">(optional)</span></label>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-new-customer-text" class="bp-inline-input" placeholder="Search customers\u2026" autocomplete="off">';
    html += '<div class="bp-vessel-dropdown" id="bp-new-customer-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-new-customer-id">';
    html += '<input type="hidden" id="bp-new-customer-name-hidden">';
    html += '<input type="hidden" id="bp-new-customer-firstname-hidden">';
    html += '<input type="hidden" id="bp-new-customer-lastname-hidden">';
    html += '<input type="hidden" id="bp-new-customer-email">';
    html += '</div>';
    html += '<div id="bp-new-customer-section" style="display:none;" class="bp-new-customer-wrap">';
    html += '<div class="bp-form-subgroup">';
    html += '<input type="text"  id="bp-nc-firstname"  class="bp-inline-input" placeholder="First name *" autocomplete="given-name">';
    html += '<input type="text"  id="bp-nc-lastname"  class="bp-inline-input" placeholder="Last name" autocomplete="family-name">';
    html += '<input type="email" id="bp-nc-email" class="bp-inline-input" placeholder="Email *" autocomplete="email" inputmode="email">';
    html += '<input type="tel"   id="bp-nc-phone" class="bp-inline-input" placeholder="Phone (optional)" autocomplete="tel" inputmode="tel">';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-nc-save">Add Customer</button>';
    html += '</div></div></div>';

    // Invoice (Phase 90-03, D-01/D-02): optional link captured at create time.
    html += '<div class="bp-form-group" id="bp-new-so-group"><label>Invoice <span class="bp-optional">(optional)</span></label>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-new-so-search-input" class="bp-inline-input" placeholder="Search invoices by number or customer" autocomplete="off">';
    html += '<div id="bp-new-so-chip" style="display:none;"></div>';
    html += '<div class="bp-vessel-dropdown" id="bp-new-so-results" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-new-so-number">';
    html += '<input type="hidden" id="bp-new-so-id">';
    html += '</div>';
    html += '<label class="bp-check-row" for="bp-new-no-invoice"><input type="checkbox" id="bp-new-no-invoice"> <span>No invoice (internal batch)</span></label>';
    html += '</div>';

    // Start date
    html += '<div class="bp-form-group"><label>Start Date</label>';
    html += '<input type="date" id="bp-new-start-date" class="bp-inline-input" value="' + today + '"></div>';

    // Schedule
    html += '<div class="bp-form-group"><label>Schedule Template <span class="bp-optional">(optional)</span></label>';
    html += '<select id="bp-new-schedule" class="bp-inline-input">' + schedOptions + '</select></div>';

    // Vessel
    html += '<div class="bp-form-group"><label>Vessel <span class="bp-optional">(optional)</span></label>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-new-vessel-text" class="bp-inline-input" placeholder="Search vessels\u2026" autocomplete="off">';
    html += '<button type="button" class="bp-clear-btn" id="bp-new-vessel-clear" title="Clear vessel">\u00d7</button>';
    html += '<div class="bp-vessel-dropdown" id="bp-new-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-new-vessel">';
    html += '</div></div>';

    // Shelf + Bin
    html += '<div class="bp-form-group bp-form-row">';
    html += '<div><label>Shelf <span class="bp-optional">(optional)</span></label><input type="text" id="bp-new-shelf" class="bp-inline-input bp-shelf-input" placeholder="A"></div>';
    html += '<div><label>Bin <span class="bp-optional">(optional)</span></label><input type="text" id="bp-new-bin" class="bp-inline-input bp-bin-input" placeholder="01"></div>';
    html += '</div>';

    // Notes
    html += '<div class="bp-form-group"><label>Notes <span class="bp-optional">(optional)</span></label>';
    html += '<textarea id="bp-new-notes" class="bp-inline-input" rows="2"></textarea></div>';

    html += '<div class="bp-form-actions">';
    html += '<button type="button" class="btn-secondary" id="bp-create-cancel">Cancel</button>';
    html += '<button type="button" class="btn" id="bp-create-submit">Create Batch</button>';
    html += '</div></div>';

    container.innerHTML = html;

    document.getElementById('bp-create-close').addEventListener('click', closeCreateSheet);
    document.getElementById('bp-create-cancel').addEventListener('click', closeCreateSheet);

    _productPickerTab = 'kits'; // reset tab state on each form open
    bindProductSearch();
    bindRecipePickerSearch();

    // Phase 16: Tab switcher — binds Kits/Recipes tab buttons
    Array.prototype.forEach.call(document.querySelectorAll('.bp-product-tab'), function (btn) {
      btn.addEventListener('click', function () {
        _productPickerTab = btn.getAttribute('data-picker-tab') || 'kits';
        Array.prototype.forEach.call(document.querySelectorAll('.bp-product-tab'), function (b) {
          b.classList.toggle('bp-product-tab--active', b === btn);
        });
        var input = document.getElementById('bp-new-product-text');
        var dropdown = document.getElementById('bp-new-product-dropdown');
        var skuHidden = document.getElementById('bp-new-product-sku');
        var nameHidden = document.getElementById('bp-new-product-name');
        var recipeIdHidden = document.getElementById('bp-new-recipe-id');
        var snapshotHidden = document.getElementById('bp-new-recipe-snapshot');
        if (input) {
          input.value = '';
          input.placeholder = _productPickerTab === 'kits' ? 'Search kits…' : 'Search recipes…';
          input.focus();
        }
        if (dropdown) dropdown.style.display = 'none';
        if (skuHidden) skuHidden.value = '';
        if (nameHidden) nameHidden.value = '';
        if (recipeIdHidden) recipeIdHidden.value = '';
        if (snapshotHidden) snapshotHidden.value = '';
      });
    });

    bindCustomerSearch();
    bindCreateInvoicePicker();

    var vInput = document.getElementById('bp-new-vessel-text');
    var vDropdown = document.getElementById('bp-new-vessel-dropdown');
    var vHidden = document.getElementById('bp-new-vessel');
    if (vInput && vDropdown && vHidden) bindVesselSearch(vInput, vDropdown, vHidden, '');

    var vClearBtn = document.getElementById('bp-new-vessel-clear');
    if (vClearBtn && vInput && vHidden) {
      vClearBtn.addEventListener('click', function () {
        vHidden.value = '';
        vInput.value = '';
        vInput.focus();
      });
    }

    var shelfEl = document.getElementById('bp-new-shelf');
    var binEl = document.getElementById('bp-new-bin');
    if (shelfEl) bindShelfInput(shelfEl);
    if (binEl) bindBinInput(binEl);

    var submitBtn = document.getElementById('bp-create-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var productName = (document.getElementById('bp-new-product-name') || {}).value || '';
        if (!productName) {
          var textEl = document.getElementById('bp-new-product-text');
          if (textEl && textEl.value.trim()) productName = textEl.value.trim();
        }
        if (!productName) { showToast('Product is required', 'error'); return; }

        var productSku  = (document.getElementById('bp-new-product-sku') || {}).value || '';
        var startDate   = (document.getElementById('bp-new-start-date') || {}).value || today;
        var scheduleId  = (document.getElementById('bp-new-schedule') || {}).value || '';
        var vesselId    = (document.getElementById('bp-new-vessel') || {}).value || '';
        var shelf       = (document.getElementById('bp-new-shelf') || {}).value || '';
        var bin         = (document.getElementById('bp-new-bin') || {}).value || '';
        var notes       = (document.getElementById('bp-new-notes') || {}).value || '';
        var customerFirstname = (document.getElementById('bp-new-customer-firstname-hidden') || {}).value || '';
        var customerLastname  = (document.getElementById('bp-new-customer-lastname-hidden') || {}).value || '';
        var customerName = (document.getElementById('bp-new-customer-name-hidden') || {}).value || '';
        // Fallback: if user typed directly (no search/select), split the text input
        if (!customerFirstname) {
          var custText = document.getElementById('bp-new-customer-text');
          if (custText && custText.value.trim()) {
            var nameParts = custText.value.trim().split(/\s+/);
            customerFirstname = nameParts[0] || '';
            customerLastname  = nameParts.slice(1).join(' ') || '';
            customerName = custText.value.trim();
          }
        }
        if (!customerName) {
          customerName = ((customerFirstname || '') + ' ' + (customerLastname || '')).trim();
        }
        var customerEmail = (document.getElementById('bp-new-customer-email') || {}).value || '';

        var soNumber   = (document.getElementById('bp-new-so-number') || {}).value || '';
        var noInvoice  = !!((document.getElementById('bp-new-no-invoice') || {}).checked);
        var customerId = (document.getElementById('bp-new-customer-id') || {}).value || '';
        // Captured BEFORE the call: a successful create clears _allBatchesData.
        var linkedIds  = createSheetLinkedBatchIds(soNumber);

        function doCreate() {
          var oldErr = document.getElementById('bp-new-create-error');
          if (oldErr && oldErr.parentNode) oldErr.parentNode.removeChild(oldErr);
          submitBtn.disabled = true;
          var payload = {
            product_name: productName,
            product_sku: productSku,
            customer_firstname: customerFirstname || 'Walk-In',
            customer_lastname: customerLastname || '',
            customer_name: customerName || 'Walk-In',
            customer_email: customerEmail,
            start_date: startDate,
            vessel_id: vesselId,
            shelf_id: shelf,
            bin_id: bin,
            schedule_id: scheduleId,
            notes: notes,
            recipe_id: (document.getElementById('bp-new-recipe-id') || {}).value || '',
            recipe_snapshot: (document.getElementById('bp-new-recipe-snapshot') || {}).value || '',
            // undefined values are dropped by JSON.stringify, so only applicable keys are sent
            customer_id: customerId || undefined,
            zoho_so_number: soNumber || undefined,
            source: (!soNumber && noInvoice) ? 'internal' : undefined
          };
          adminApiPost('create_batch', payload)
            .then(function (result) {
              showToast('Batch ' + (result.batch_id || '') + ' created', 'success');
              if (soNumber) reconcileInvoiceStatus(soNumber);
              closeCreateSheet();
              _batchesLoaded = false;
              _allBatchesData = [];
              _eagerLoadTime = 0;
              _upcomingLoaded = false;
              _measBatches = [];
              _dashLoadTime = 0;
              loadBatches();
            })
            .catch(function (err) {
              submitBtn.disabled = false;
              if (err && err.code === 'duplicate_so_number') {
                showCreateDuplicateBanner(linkedIds);
                return;
              }
              showToast('Failed: ' + err.message, 'error');
            });
        }

        if (!soNumber && !noInvoice) {
          showConfirmSheet('Create without invoice?', 'Create batch', 'bp-confirm-btn--primary', doCreate,
            'You can link an invoice later from the batch.');
        } else {
          doCreate();
        }
      });
    }
  }

  function bindProductSearch() {
    var input    = document.getElementById('bp-new-product-text');
    var dropdown = document.getElementById('bp-new-product-dropdown');
    var skuHidden  = document.getElementById('bp-new-product-sku');
    var nameHidden = document.getElementById('bp-new-product-name');
    if (!input || !dropdown || !skuHidden || !nameHidden) return;

    function showProductOptions(term) {
      if (_productPickerTab !== 'kits') return; // Phase 16: guard \u2014 kits tab only
      if (!_kitCatalog) {
        dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">Loading catalog\u2026</div>';
        dropdown.style.display = '';
        loadKitCatalog(function () { showProductOptions(term); });
        return;
      }
      var matches = _kitCatalog.filter(function (p) {
        if (!term) return true;
        return ((p.name || '') + ' ' + (p.sku || '')).toLowerCase().indexOf(term.toLowerCase()) !== -1;
      }).slice(0, 15);
      if (matches.length === 0) {
        dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">No kits found \u2014 type to use free text</div>';
      } else {
        dropdown.innerHTML = matches.map(function (p) {
          return '<div class="bp-vessel-option" data-sku="' + escapeHTML(p.sku || p.item_id || '') +
            '" data-name="' + escapeHTML(p.name || '') + '">' + escapeHTML(p.name || p.sku) + '</div>';
        }).join('');
      }
      dropdown.style.display = '';
      Array.prototype.forEach.call(dropdown.querySelectorAll('.bp-vessel-option[data-sku]'), function (opt) {
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          skuHidden.value  = opt.getAttribute('data-sku');
          nameHidden.value = opt.getAttribute('data-name');
          input.value = opt.getAttribute('data-name');
          dropdown.style.display = 'none';
        });
      });
    }

    input.addEventListener('focus', function () { showProductOptions(input.value); });
    var timer;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      skuHidden.value = ''; nameHidden.value = '';
      timer = setTimeout(function () { showProductOptions(input.value); }, 200);
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { dropdown.style.display = 'none'; }, 200);
    });
  }

  // Phase 16: Recipe picker search — fetches /api/recipes?status=active from middleware
  function bindRecipePickerSearch() {
    var input    = document.getElementById('bp-new-product-text');
    var dropdown = document.getElementById('bp-new-product-dropdown');
    var nameHidden = document.getElementById('bp-new-product-name');
    var recipeIdHidden = document.getElementById('bp-new-recipe-id');
    var snapshotHidden = document.getElementById('bp-new-recipe-snapshot');
    if (!input || !dropdown) return;

    var _recipeCatalog = null;

    var picker = bpCreateRecipePicker({
      input: input,
      dropdown: dropdown,
      touch: true,
      guard: function () { return _productPickerTab === 'recipes'; },
      getCatalog: function () { return _recipeCatalog; },
      setCatalog: function (v) { _recipeCatalog = v; },
      // Selecting a recipe: fetch full detail for snapshot, then populate hiddens
      onSelect: function (rid, rname) {
        input.value = rname;
        if (nameHidden) nameHidden.value = rname;
        if (recipeIdHidden) recipeIdHidden.value = rid;
        picker.close();
        fetch(mwUrl() + '/api/recipes/' + encodeURIComponent(rid), {
          credentials: 'include'
        }).then(function (r) { return r.json(); })
          .then(function (data) {
            var snap = data.recipe || {};
            var minimal = {
              name: snap.name, style: snap.style, abv: snap.abv,
              ibu: snap.ibu, batch_size_l: snap.batch_size_l,
              ingredients: (data.ingredients || []).map(function (i) {
                return { item_id: i.item_id, item_name: i.item_name, quantity: i.quantity, unit: i.unit, cf_type: i.cf_type || '', cf_subcategory: i.cf_subcategory || '', display_group: i.display_group || '' };
              })
            };
            if (snapshotHidden) snapshotHidden.value = JSON.stringify(minimal);
          })
          .catch(function () { if (snapshotHidden) snapshotHidden.value = ''; });
      }
    });
    function showRecipeOptions(term) { picker.show(term); }

    var timer;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      if (nameHidden) nameHidden.value = '';
      if (recipeIdHidden) recipeIdHidden.value = '';
      if (snapshotHidden) snapshotHidden.value = '';
      timer = setTimeout(function () {
        if (_productPickerTab === 'recipes') showRecipeOptions(input.value);
      }, 200);
    });
    // blur already handled by existing bindProductSearch — shared input element
  }

  function loadKitCatalog(cb) {
    if (_kitCatalog) { if (cb) cb(); return; }
    fetch(mwUrl() + '/api/products')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _kitCatalog = (data.items || []).map(function (p) {
          return { sku: p.sku || p.item_id || '', name: p.name || '' };
        });
        if (cb) cb();
      })
      .catch(function () {
        _kitCatalog = []; // graceful degradation — free text still works
        if (cb) cb();
      });
  }

  // Phase 90-03 (D-01/D-02/D-09/D-10): create-sheet invoice picker. Reuses fetchSoSearch;
  // selecting only fills hidden fields and shows a chip. Nothing is written until Create batch.
  function createSheetLinkedBatchIds(invoiceNumber) {
    var ids = [];
    var want = String(invoiceNumber || '').toLowerCase();
    if (!want) return ids;
    for (var i = 0; i < _allBatchesData.length; i++) {
      var b = _allBatchesData[i];
      if (String(b.zoho_so_number || '').toLowerCase() === want && b.batch_id) ids.push(b.batch_id);
    }
    return ids;
  }

  // Inline danger banner above the submit button; never auto-retries (Phase 90-03, D-09).
  function showCreateDuplicateBanner(linkedIds) {
    var actions = document.querySelector('#bp-create-submit');
    actions = actions && actions.parentNode;
    if (!actions || !actions.parentNode) return;
    var banner = document.getElementById('bp-new-create-error');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'bp-new-create-error';
      banner.className = 'bp-form-error';
      banner.setAttribute('role', 'alert');
      actions.parentNode.insertBefore(banner, actions);
    }
    banner.textContent = 'That invoice already has a batch for this product' +
      (linkedIds && linkedIds.length ? ' (' + linkedIds.join(', ') + ')' : '') +
      '. Create without an invoice and link it from the batch instead.';
  }

  function bindCreateInvoicePicker() {
    var input   = document.getElementById('bp-new-so-search-input');
    var results = document.getElementById('bp-new-so-results');
    var chip    = document.getElementById('bp-new-so-chip');
    var soNum   = document.getElementById('bp-new-so-number');
    var soId    = document.getElementById('bp-new-so-id');
    var noInv   = document.getElementById('bp-new-no-invoice');
    var custText = document.getElementById('bp-new-customer-text');
    if (!input || !results || !chip || !soNum || !soId || !noInv) return;

    var timer;
    var touched = false;   // staff typed in the invoice box themselves; stop re-seeding

    function hideResults() {
      results.style.display = 'none';
      results.innerHTML = '';
    }

    function runSearch(term) {
      results.style.display = '';
      fetchSoSearch(term, {
        resultsId: 'bp-new-so-results',
        onSelect: selectCreateInvoice,
        renderExtra: function (inv) {
          var ids = createSheetLinkedBatchIds(inv.invoice_number);
          if (!ids.length) return '';
          return '<span class="bp-so-linked-warn">Already linked to ' + ids.map(escapeHTML).join(', ') + '</span>';
        }
      });
    }

    function selectCreateInvoice(inv) {
      soNum.value = inv.invoice_number || '';
      soId.value = inv.invoice_id || '';
      noInv.checked = false;
      input.style.display = 'none';
      hideResults();
      chip.innerHTML = '<span class="bp-linked-chip"><span class="bp-linked-chip-text">' + escapeHTML(inv.invoice_number) +
        '</span><button type="button" class="bp-linked-chip-x" aria-label="Clear invoice">\u00d7</button></span>';
      chip.style.display = '';
      var x = chip.querySelector('.bp-linked-chip-x');
      if (x) x.addEventListener('click', clearInvoice);
    }

    function clearInvoice() {
      soNum.value = '';
      soId.value = '';
      chip.innerHTML = '';
      chip.style.display = 'none';
      input.style.display = '';
    }

    function seedFromCustomer() {
      if (touched || soNum.value || noInv.checked || !custText) return;
      input.value = custText.value;
    }

    input.addEventListener('input', function () {
      touched = true;
      clearTimeout(timer);
      var term = input.value.trim();
      if (term.length < 2) { hideResults(); return; }
      timer = setTimeout(function () { runSearch(term); }, 400);
    });

    input.addEventListener('focus', function () {
      seedFromCustomer();
      var term = input.value.trim();
      if (!input.disabled && !soNum.value && term.length >= 2 && !results.innerHTML) runSearch(term);
    });

    if (custText) {
      custText.addEventListener('input', seedFromCustomer);
      custText.addEventListener('blur', function () { setTimeout(seedFromCustomer, 300); });
    }

    noInv.addEventListener('change', function () {
      clearTimeout(timer);
      if (noInv.checked) {
        clearInvoice();
        hideResults();
        input.value = '';
        input.disabled = true;
      } else {
        input.disabled = false;
        touched = false;
        seedFromCustomer();
      }
    });
  }

  function bindCustomerSearch() {
    var input    = document.getElementById('bp-new-customer-text');
    var dropdown = document.getElementById('bp-new-customer-dropdown');
    var custId    = document.getElementById('bp-new-customer-id');
    var custName  = document.getElementById('bp-new-customer-name-hidden');
    var custFirstname = document.getElementById('bp-new-customer-firstname-hidden');
    var custLastname  = document.getElementById('bp-new-customer-lastname-hidden');
    var custEmail = document.getElementById('bp-new-customer-email');
    var ncSection = document.getElementById('bp-new-customer-section');
    if (!input || !dropdown) return;

    var base = mwUrl();
    var timer;
    var _custSearchAbort = null;

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (ncSection) ncSection.style.display = q.length >= 2 ? '' : 'none';
      if (!q || q.length < 2) { dropdown.style.display = 'none'; return; }
      timer = setTimeout(function () {
        if (_custSearchAbort) { try { _custSearchAbort.abort(); } catch (e) {} }
        _custSearchAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        // The /api gate requires the session cookie, so the search must send
        // credentials:'include' — same as the sibling reassign search
        // (fetchReassignSearch) and the new-customer POST below.
        var fetchOpts = { credentials: 'include' };
        if (_custSearchAbort) fetchOpts.signal = _custSearchAbort.signal;
        fetch(base + '/api/contacts?search=' + encodeURIComponent(q), fetchOpts)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var contacts = (data.contacts || []).slice(0, 10);
            if (!contacts.length) {
              dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">No results \u2014 fill form below to add</div>';
            } else {
              dropdown.innerHTML = contacts.map(function (c) {
                return '<div class="bp-vessel-option" data-cid="' + escapeHTML(c.contact_id || '') +
                  '" data-cname="' + escapeHTML(c.contact_name || c.name || '') +
                  '" data-cemail="' + escapeHTML(c.email || '') + '">' +
                  escapeHTML(c.contact_name || c.name || '') +
                  (c.email ? ' <span class="bp-cust-email">' + escapeHTML(c.email) + '</span>' : '') +
                  '</div>';
              }).join('');
            }
            dropdown.style.display = '';
            Array.prototype.forEach.call(dropdown.querySelectorAll('.bp-vessel-option[data-cid]'), function (opt) {
              opt.addEventListener('mousedown', function (e) {
                e.preventDefault();
                var fullName = opt.getAttribute('data-cname');
                var nameParts = fullName.split(/\s+/);
                if (custId)    custId.value    = opt.getAttribute('data-cid');
                if (custName)  custName.value  = fullName;
                if (custFirstname) custFirstname.value = nameParts[0] || '';
                if (custLastname)  custLastname.value  = nameParts.slice(1).join(' ') || '';
                if (custEmail) custEmail.value = opt.getAttribute('data-cemail');
                input.value = fullName;
                dropdown.style.display = 'none';
                if (ncSection) ncSection.style.display = 'none';
              });
            });
          })
          .catch(function (err) {
            if (err && err.name === 'AbortError') return; // stale request cancelled — ignore
            dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">Search failed \u2014 fill form to add manually</div>';
            dropdown.style.display = '';
          });
      }, 250);
    });

    input.addEventListener('blur', function () {
      setTimeout(function () { dropdown.style.display = 'none'; }, 200);
    });

    // New customer save
    var ncSaveBtn = document.getElementById('bp-nc-save');
    if (ncSaveBtn) {
      ncSaveBtn.addEventListener('click', function () {
        var firstName = ((document.getElementById('bp-nc-firstname') || {}).value || '').trim();
        var lastName  = ((document.getElementById('bp-nc-lastname') || {}).value || '').trim();
        var name  = (firstName + ' ' + lastName).trim();
        var email = ((document.getElementById('bp-nc-email') || {}).value || '').trim();
        var phone = ((document.getElementById('bp-nc-phone') || {}).value || '').trim();
        if (!firstName) { showToast('First name is required', 'error'); return; }
        if (!email)     { showToast('Email is required', 'error'); return; }
        ncSaveBtn.disabled = true;
        fetch(base + '/api/contacts', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, first_name: firstName, last_name: lastName, email: email, phone: phone })
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            ncSaveBtn.disabled = false;
            if (data.contact_id) {
              if (custId)    custId.value    = data.contact_id;
              if (custName)  custName.value  = name;
              if (custFirstname) custFirstname.value = firstName;
              if (custLastname)  custLastname.value  = lastName;
              if (custEmail) custEmail.value = email;
              input.value = name;
              if (ncSection) ncSection.style.display = 'none';
              showToast('Customer added', 'success');
            } else {
              showToast(data.error || 'Failed to create customer', 'error');
            }
          })
          .catch(function () {
            ncSaveBtn.disabled = false;
            showToast('Failed to create customer', 'error');
          });
      });
    }
  }

  // ===== Tasks Tab =====

  function loadTasks() {
    // Show cached data immediately if we have it (instant response)
    if (_upcomingLoaded && _upcomingTasks.length > 0) {
      renderTasks();
    } else {
      var inner = document.getElementById('bp-tasks-inner');
      if (inner) inner.innerHTML = '<div class="bp-skeleton-block"></div>';
    }
    // Always kick off a background refresh
    _upcomingLoadTime = Date.now();
    adminApiGet('get_tasks_upcoming', { limit: 60 })
      .then(function (result) {
        _upcomingTasks = (result.data && result.data.tasks) || [];
        _upcomingLoaded = true;
        renderTasks();
      })
      .catch(function (err) {
        // Only show error if we have no cached data to display
        if (!_upcomingLoaded) {
          var inner2 = document.getElementById('bp-tasks-inner');
          if (inner2) inner2.innerHTML = '<p class="bp-empty">Failed to load tasks: ' + escapeHTML(err.message) + '</p>';
        }
      });
  }

  function renderTasks() {
    var inner = document.getElementById('bp-tasks-inner');
    if (!inner) return;

    // Preserve search focus state before innerHTML wipe
    var prevSearchEl = document.getElementById('bp-task-search');
    var hadSearchFocus = prevSearchEl && document.activeElement === prevSearchEl;
    var searchSelStart = prevSearchEl ? prevSearchEl.selectionStart : 0;
    var searchSelEnd = prevSearchEl ? prevSearchEl.selectionEnd : 0;

    var today = todayStr();
    var weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    var weekEndStr = weekEnd.toISOString().slice(0, 10);

    var groups = [
      { key: 'overdue', label: 'Overdue',   tasks: [], cls: 'bp-group--danger' },
      { key: 'today',   label: 'Today',     tasks: [], cls: 'bp-group--warning' },
      { key: 'week',    label: 'This Week', tasks: [], cls: '' },
      { key: 'later',   label: 'Later',     tasks: [], cls: '' }
    ];

    // Filter tasks by status/type
    var filteredTasks = _upcomingTasks.filter(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
      if (_taskFilter === 'incomplete') return !done;
      if (_taskFilter === 'transfer') return !done && String(t.is_transfer).toUpperCase() === 'TRUE';
      if (_taskFilter === 'packaging') return !done && String(t.is_packaging).toUpperCase() === 'TRUE';
      return true; // 'all'
    });

    // Apply text search
    if (_taskSearch) {
      var searchLower = _taskSearch.toLowerCase();
      filteredTasks = filteredTasks.filter(function (t) {
        return ((t.title || '') + ' ' + (t.product_name || '') + ' ' + (getCustomerDisplayName(t) || '') + ' ' + (t.batch_id || '')).toLowerCase().indexOf(searchLower) !== -1;
      });
    }

    filteredTasks.forEach(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';

      var isPkg = t.is_packaging === true || t.is_packaging === 'TRUE';
      var due = t.due_date ? String(t.due_date).substring(0, 10) : '';

      // Packaging/bottling tasks with no due date are "TBD" — hide until all
      // other non-packaging tasks for the same batch are complete.
      if (!done && isPkg && !due) {
        var otherPending = _upcomingTasks.some(function (other) {
          if (other.task_id === t.task_id) return false;
          if (other.batch_id !== t.batch_id) return false;
          var otherDone = other.completed === true || other.completed === 'TRUE' || other.completed === '1';
          if (otherDone) return false;
          var otherIsPkg = other.is_packaging === true || other.is_packaging === 'TRUE';
          return !otherIsPkg;
        });
        if (otherPending) return; // not ready yet
      }

      if (!due || due < today) { groups[0].tasks.push(t); }
      else if (due === today)  { groups[1].tasks.push(t); }
      else if (due <= weekEndStr) { groups[2].tasks.push(t); }
      else { groups[3].tasks.push(t); }
    });

    var html = '<div class="bp-tasks-toolbar">';
    html += '<input type="search" class="bp-search-input" id="bp-task-search" placeholder="Search tasks\u2026" value="' + escapeHTML(_taskSearch) + '" autocomplete="off" inputmode="search">';
    html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-tasks-refresh">\u21bb Refresh</button>';
    html += '</div>';

    html += '<div class="bp-task-filters">';
    var taskFilterOpts = [
      { val: 'incomplete', label: 'To Do' },
      { val: 'all', label: 'All' },
      { val: 'transfer', label: 'Transfers' },
      { val: 'packaging', label: 'Packaging' }
    ];
    taskFilterOpts.forEach(function (f) {
      var active = _taskFilter === f.val ? ' bp-filter-btn--active' : '';
      html += '<button type="button" class="bp-filter-btn' + active + '" data-task-filter="' + f.val + '">' + f.label + '</button>';
    });
    html += '</div>';

    var hasAny = groups.some(function (g) { return g.tasks.length > 0; });
    if (!hasAny) {
      html += '<p class="bp-empty">No upcoming tasks \u2014 all caught up!</p>';
    } else {
      groups.forEach(function (g) {
        if (g.tasks.length === 0) return;
        html += '<div class="bp-task-group ' + g.cls + '">';
        html += '<div class="bp-task-group-header">' + g.label +
          ' <span class="bp-task-group-count">(' + g.tasks.length + ')</span></div>';
        g.tasks.forEach(function (t) {
          var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
          html += '<div class="bp-task-row' + (done ? ' bp-task-row--done' : '') + '" data-task-id="' + escapeHTML(t.task_id) + '">';
          html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"' + (done ? ' checked' : '') + '></label>';
          html += '<div class="bp-task-body">';
          html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(t.batch_id || '') + '" title="Open batch">' + escapeHTML(t.batch_id || '') + '</button>';
          html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
          if (t.due_date) html += '<span class="bp-task-due">' + fmtDate(t.due_date) + '</span>';
          if (getCustomerDisplayName(t)) html += '<span class="bp-task-customer">' + escapeHTML(getCustomerDisplayName(t)) + '</span>';
          var meta = getBatchMeta(t.batch_id);
          if (meta) html += '<span class="bp-task-meta">' + escapeHTML(meta) + '</span>';
          html += '</div></div>';
        });
        html += '</div>';
      });
    }

    inner.innerHTML = html;

    // Restore search focus + cursor position after innerHTML wipe
    var newSearchEl = document.getElementById('bp-task-search');
    if (newSearchEl && hadSearchFocus) {
      newSearchEl.focus();
      try { newSearchEl.setSelectionRange(searchSelStart, searchSelEnd); } catch (e) {}
    }

    // Wire search input with debounce
    if (newSearchEl) {
      newSearchEl.addEventListener('input', function () {
        clearTimeout(_taskSearchTimer);
        _taskSearchTimer = setTimeout(function () {
          _taskSearch = newSearchEl.value;
          renderTasks();
        }, 200);
      });
    }

    var refreshBtn = document.getElementById('bp-tasks-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        _upcomingLoaded = false;
        loadTasks();
      });
    }

    // Checkbox auto-save + batch chip navigation handled by delegation on #bp-tasks-inner (see initDelegation)
  }

  // ===== Measurements Tab =====

  function loadMeasurementBatches() {
    var inner = document.getElementById('bp-measurements-inner');
    if (!inner) return;
    // Use cached all-batches data filtered to active — no network call
    if (_allBatchesData.length > 0) {
      _measBatches = _allBatchesData.filter(function (b) {
        var s = String(b.status || '').toLowerCase();
        return s === 'primary' || s === 'secondary' || s === 'active';
      });
      renderMeasurementsUI();
      return;
    }
    // Fallback: fetch if not cached
    inner.innerHTML = '<div class="bp-skeleton-block"></div>';
    adminApiGet('get_batches', { status: 'active' })
      .then(function (result) {
        _measBatches = (result.data && result.data.batches) || [];
        renderMeasurementsUI();
      })
      .catch(function (err) {
        inner.innerHTML = '<p class="bp-empty">Failed: ' + escapeHTML(err.message) + '</p>';
      });
  }

  function renderMeasurementsUI() {
    var inner = document.getElementById('bp-measurements-inner');
    if (!inner) return;
    _measSharedDate = todayStr();
    _measMultiData = {};
    _measFilterText = '';

    var html = '<div class="bp-panel-inner bp-meas-wrap">';

    // Header: shared date + filter
    html += '<div class="bp-meas-header-row">';
    html += '<div class="bp-meas-date-group">';
    html += '<label class="bp-meas-date-label">Date</label>';
    html += '<input type="date" id="bp-meas-shared-date" class="bp-inline-input" value="' + todayStr() + '">';
    html += '</div>';
    html += '<input type="search" id="bp-meas-filter" class="bp-inline-input bp-meas-filter-input" placeholder="Filter batches\u2026" autocomplete="off">';
    html += '</div>';

    // Batch grid
    html += '<div class="bp-meas-grid-wrap" id="bp-meas-grid-wrap">';
    html += renderMeasGrid();
    html += '</div>';

    // Submit footer
    html += '<div class="bp-meas-footer">';
    html += '<button type="button" class="btn" id="bp-meas-submit-all" disabled>Submit Readings</button>';
    html += '<span class="bp-meas-footer-count" id="bp-meas-submit-count"></span>';
    html += '</div>';

    html += '</div>';
    inner.innerHTML = html;

    bindMeasEvents();
  }

  function getMeasSortVal(b) {
    if (_measSortCol === 'location') return (String(b.shelf_id || '') + String(b.bin_id || '')).toLowerCase();
    return String(b[_measSortCol] || '').toLowerCase();
  }

  function renderMeasGrid() {
    // Sorted copy — filtering is done via CSS display toggle later
    var batches = _measBatches.slice().sort(function (a, b) {
      var av = getMeasSortVal(a);
      var bv = getMeasSortVal(b);
      return av < bv ? -_measSortDir : av > bv ? _measSortDir : 0;
    });

    if (batches.length === 0) {
      return '<p class="bp-empty">No active batches.</p>';
    }

    function measSortIcon(col) {
      if (_measSortCol !== col) return '<span class="bp-sort-icon">&#8645;</span>';
      return '<span class="bp-sort-icon">' + (_measSortDir === 1 ? '&#8593;' : '&#8595;') + '</span>';
    }

    var html = '<table class="bp-meas-multi-table"><thead><tr>';
    html += '<th class="bp-meas-col-id bp-sort-th' + (_measSortCol === 'batch_id' ? ' bp-sort-active' : '') + '" data-sort="batch_id">Batch ' + measSortIcon('batch_id') + '</th>';
    html += '<th class="bp-meas-col-product bp-sort-th' + (_measSortCol === 'product_name' ? ' bp-sort-active' : '') + '" data-sort="product_name">Product ' + measSortIcon('product_name') + '</th>';
    html += '<th class="bp-meas-col-loc">' +
      '<span class="bp-sort-th' + (_measSortCol === 'vessel_id' ? ' bp-sort-active' : '') + '" data-sort="vessel_id">Vessel' + measSortIcon('vessel_id') + '</span>' +
      '<span class="bp-sort-sep"> / </span>' +
      '<span class="bp-sort-th' + (_measSortCol === 'location' ? ' bp-sort-active' : '') + '" data-sort="location">Loc' + measSortIcon('location') + '</span>' +
      '</th>';
    html += '<th class="bp-meas-col-num">&deg;P</th>';
    html += '<th class="bp-meas-col-num">Temp&deg;C</th>';
    html += '<th class="bp-meas-col-num">pH</th>';
    html += '<th class="bp-meas-col-notes">Notes</th>';
    html += '</tr></thead><tbody>';

    batches.forEach(function (b) {
      var saved = _measMultiData[b.batch_id] || {};
      var loc = b.vessel_id || '\u2014';
      if (b.shelf_id || b.bin_id) loc += ' ' + [b.shelf_id, b.bin_id].filter(Boolean).join('-');
      html += '<tr class="bp-meas-multi-row" data-batch-id="' + escapeHTML(b.batch_id) + '">';
      html += '<td class="bp-meas-col-id"><button type="button" class="bp-batch-chip" data-batch-id="' +
        escapeHTML(b.batch_id) + '" title="Open in Batches tab">' + escapeHTML(b.batch_id) + '</button></td>';
      html += '<td class="bp-meas-col-product">' + escapeHTML(b.product_name || b.product_sku || '\u2014') + '</td>';
      html += '<td class="bp-meas-col-loc">' + escapeHTML(loc) + '</td>';
      html += '<td class="bp-meas-col-num"><input type="number" inputmode="decimal" class="bp-meas-cell bp-meas-cell-plato" step="0.1" max="40" placeholder="\u2014" value="' + escapeHTML(saved.plato || '') + '"></td>';
      html += '<td class="bp-meas-col-num"><input type="number" inputmode="decimal" class="bp-meas-cell bp-meas-cell-temp" step="0.1" placeholder="\u2014" value="' + escapeHTML(saved.temp || '') + '"></td>';
      html += '<td class="bp-meas-col-num"><input type="number" inputmode="decimal" class="bp-meas-cell bp-meas-cell-ph" step="0.01" min="0" max="14" placeholder="\u2014" value="' + escapeHTML(saved.ph || '') + '"></td>';
      html += '<td class="bp-meas-col-notes"><input type="text" class="bp-meas-cell bp-meas-cell-notes" placeholder="optional" value="' + escapeHTML(saved.notes || '') + '"></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<p class="bp-empty" id="bp-meas-grid-empty" style="display:none;">No batches match filter.</p>';
    return html;
  }

  function bindMeasEvents() {
    var dateInput = document.getElementById('bp-meas-shared-date');
    if (dateInput) {
      dateInput.addEventListener('change', function () { _measSharedDate = dateInput.value; });
    }

    var filterInput = document.getElementById('bp-meas-filter');
    if (filterInput) {
      filterInput.addEventListener('input', function () {
        clearTimeout(_measFilterTimer);
        _measFilterTimer = setTimeout(function () {
          // Filter by toggling row visibility — DOM stays intact, inputs keep their values
          var lower = filterInput.value.toLowerCase().trim();
          var anyVisible = false;
          Array.prototype.forEach.call(
            document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
            function (row) {
              var batchId = row.getAttribute('data-batch-id');
              var b = null;
              for (var fi = 0; fi < _measBatches.length; fi++) {
                if (_measBatches[fi].batch_id === batchId) { b = _measBatches[fi]; break; }
              }
              var match = !lower || (b && (String(b.batch_id || '') + ' ' + String(b.product_name || '') + ' ' +
                String(b.vessel_id || '') + ' ' + String(b.shelf_id || '') + ' ' + String(b.bin_id || '')).toLowerCase().indexOf(lower) !== -1);
              row.style.display = match ? '' : 'none';
              if (match) anyVisible = true;
            }
          );
          // Show "no match" empty message if nothing visible
          var emptyMsg = document.getElementById('bp-meas-grid-empty');
          if (emptyMsg) emptyMsg.style.display = anyVisible ? 'none' : '';
          updateMeasSubmitCount();
        }, 150);
      });
    }

    var submitBtn = document.getElementById('bp-meas-submit-all');
    if (submitBtn) submitBtn.addEventListener('click', submitMultiBatchReadings);

    // Meas cell input + batch chip clicks handled by delegation on #bp-measurements-inner (see initDelegation)
  }

  function saveMeasGridValues() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
      function (row) {
        var batchId = row.getAttribute('data-batch-id');
        var plato = (row.querySelector('.bp-meas-cell-plato') || {}).value || '';
        var temp  = (row.querySelector('.bp-meas-cell-temp')  || {}).value || '';
        var ph    = (row.querySelector('.bp-meas-cell-ph')    || {}).value || '';
        var notes = (row.querySelector('.bp-meas-cell-notes') || {}).value || '';
        if (plato || temp || ph || notes) {
          _measMultiData[batchId] = { plato: plato, temp: temp, ph: ph, notes: notes };
        } else {
          delete _measMultiData[batchId];
        }
      }
    );
  }

  function updateMeasSubmitCount() {
    var count = 0;
    Array.prototype.forEach.call(
      document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
      function (row) {
        var plato = (row.querySelector('.bp-meas-cell-plato') || {}).value || '';
        var temp  = (row.querySelector('.bp-meas-cell-temp')  || {}).value || '';
        var ph    = (row.querySelector('.bp-meas-cell-ph')    || {}).value || '';
        if (plato || temp || ph) count++;
      }
    );
    var countEl = document.getElementById('bp-meas-submit-count');
    if (countEl) countEl.textContent = count > 0 ? count + ' batch' + (count !== 1 ? 'es' : '') + ' with readings' : '';
    var submitBtn = document.getElementById('bp-meas-submit-all');
    if (submitBtn) submitBtn.disabled = count === 0;
  }

  function submitMultiBatchReadings() {
    var date = (document.getElementById('bp-meas-shared-date') || {}).value || todayStr();
    var entries = [];
    Array.prototype.forEach.call(
      document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
      function (row) {
        var batchId = row.getAttribute('data-batch-id');
        var plato = (row.querySelector('.bp-meas-cell-plato') || {}).value || '';
        var temp  = (row.querySelector('.bp-meas-cell-temp')  || {}).value || '';
        var ph    = (row.querySelector('.bp-meas-cell-ph')    || {}).value || '';
        var notes = (row.querySelector('.bp-meas-cell-notes') || {}).value || '';
        if (!plato && !temp && !ph) return;
        var reading = { timestamp: date };
        if (plato !== '') reading.degrees_plato = parseFloat(plato);
        if (temp  !== '') reading.temperature   = parseFloat(temp);
        if (ph    !== '') reading.ph            = parseFloat(ph);
        if (notes) reading.notes = notes;
        entries.push({ batchId: batchId, reading: reading });
      }
    );

    if (!entries.length) { showToast('No measurements to submit', 'error'); return; }

    var submitBtn = document.getElementById('bp-meas-submit-all');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting\u2026'; }

    var measTimeout = setTimeout(function () {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Readings'; }
      showToast('Request timed out', 'error');
    }, 60000);

    // One API call per batch (bulk_add_plato_readings is per-batch)
    var promises = entries.map(function (entry) {
      return adminApiPost('bulk_add_plato_readings', {
        batch_id: entry.batchId,
        readings: [entry.reading]
      });
    });

    Promise.allSettled(promises)
      .then(function (results) {
        clearTimeout(measTimeout);
        var succeeded = [];
        var failed = [];
        results.forEach(function (r, i) {
          if (r.status === 'fulfilled') {
            succeeded.push(entries[i]);
          } else {
            failed.push(entries[i]);
          }
        });

        // Clear cells only for batches that succeeded and bust their detail snapshots (#16)
        succeeded.forEach(function (entry) {
          var row = document.querySelector('.bp-meas-multi-row[data-batch-id="' + entry.batchId + '"]');
          if (row) {
            Array.prototype.forEach.call(row.querySelectorAll('.bp-meas-cell'), function (inp) { inp.value = ''; });
            row.classList.remove('bp-meas-row--error');
          }
          afterBatchWrite(entry.batchId, { listAffecting: false }); // bust stale detail snapshot per measured batch (#16)
        });

        // Highlight rows that failed
        failed.forEach(function (entry) {
          var row = document.querySelector('.bp-meas-multi-row[data-batch-id="' + entry.batchId + '"]');
          if (row) row.classList.add('bp-meas-row--error');
        });

        if (failed.length === 0) {
          if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
          showToast(succeeded.length + ' batch' + (succeeded.length !== 1 ? 'es' : '') + ' recorded', 'success');
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submit Readings'; }
          var countEl = document.getElementById('bp-meas-submit-count');
          if (countEl) countEl.textContent = '';
        } else if (succeeded.length === 0) {
          showToast('All submissions failed \u2014 check connection', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Readings'; }
        } else {
          showToast(succeeded.length + ' of ' + entries.length + ' recorded. ' + failed.length + ' failed \u2014 highlighted in red.', 'warn');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Retry Failed'; }
        }
        _measMultiData = {};
      });
  }

  // ===== Waitlist Tab (Phase 78) =====

  function loadWaitlist() {
    var panel = document.getElementById('bp-panel-waitlist');
    if (!panel) return;
    panel.innerHTML = '<div class="bp-skeleton-block"></div>';
    adminApiGet('get_waitlist')
      .then(function (res) {
        _waitlistRows = res.data || [];
        renderWaitlist();
      })
      .catch(function () {
        panel.innerHTML = '<p class="bp-empty-state">Could not load the waitlist. Please try again.</p>';
      });
  }

  function renderWaitlist() {
    var panel = document.getElementById('bp-panel-waitlist');
    if (!panel) return;

    var sorted = sortWaitlistRows(_waitlistRows);
    var positions = computeWaitlistQueuePositions(sorted);
    var withPositions = sorted.map(function (row, i) { return { row: row, pos: positions[i] }; });
    var filtered = filterWaitlistRows(withPositions.map(function (wp) { return wp.row; }), _waitlistFilter, _waitlistSearch);
    // Re-attach the FULL-list-derived position to each filtered row, keyed by id.
    var posById = {};
    withPositions.forEach(function (wp) { if (wp.row && wp.row.id != null) posById[wp.row.id] = wp.pos; }); // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
    var showCategory = shouldShowWaitlistCategoryColumn(_waitlistRows);

    var html = '<div class="bp-panel-inner" aria-live="polite" aria-atomic="false">';
    html += '<h2 class="bp-section-header">BEER WAITLIST</h2>';

    html += '<div class="bp-tasks-toolbar">';
    html += '<input type="search" class="bp-search-input" id="bp-waitlist-search" placeholder="Search email…" value="' + escapeHTML(_waitlistSearch) + '" autocomplete="off" inputmode="search">';
    html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-waitlist-refresh">↻ Refresh</button>';
    html += '<button type="button" class="btn bp-new-batch-btn" id="bp-waitlist-add-trigger">+ Add to Waitlist</button>';
    html += '</div>';

    html += '<div class="bp-batch-filters">';
    var waitlistFilterOpts = [
      { val: 'all', label: 'All' },
      { val: 'waiting', label: 'Waiting' },
      { val: 'contacted', label: 'Contacted' },
      { val: 'booked', label: 'Booked' },
      { val: 'removed', label: 'Removed' },
      { val: 'notSynced', label: 'Not Synced' }
    ];
    waitlistFilterOpts.forEach(function (f) {
      var active = _waitlistFilter === f.val ? ' bp-filter-btn--active' : '';
      html += '<button type="button" class="bp-filter-btn' + active + '" data-waitlist-filter="' + f.val + '">' + f.label + '</button>';
    });
    html += '</div>';

    if (_waitlistRows.length === 0) {
      html += '<p class="bp-empty-state">No one on the beer waitlist yet.</p>';
      html += '<p class="bp-empty-state">New signups from the beer page will appear here, in order.</p>';
    } else if (filtered.length === 0) {
      html += '<p class="bp-empty-state">No entries match this filter.</p>';
    } else {
      // UI-SPEC Phase-Specific Decision 1: up to 9 columns at BrewPad's iPad-landscape
      // width would compress uncomfortably -- wrap in a horizontal-scroll wrapper
      // (copies #bp-recipes-ingredients-editor's pattern) rather than shrinking cells.
      html += '<div class="bp-waitlist-table-wrap">';
      html += '<table class="bp-active-batches-table" aria-label="Beer waitlist">';
      html += '<thead><tr><th>#</th><th>Customer</th><th>Recipes</th>';
      if (showCategory) html += '<th>Category</th>';
      html += '<th>Signed up</th><th>Status</th><th>Contact</th><th>Notes</th><th></th></tr></thead>';
      html += '<tbody>';
      filtered.forEach(function (row) {
        var pos = row.id != null ? posById[row.id] : null; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        var status = row.status;
        var label = WAITLIST_STATUS_LABELS[status] || status;
        var color = WAITLIST_STATUS_COLORS[status] || 'neutral';
        var actionable = status !== 'booked' && status !== 'removed';
        var ariaLabel = actionable
          ? 'Waitlist status: ' + label + '. Tap to advance.'
          : 'Waitlist status: ' + label + '.';
        var syncBadge = isWaitlistSynced(row.mailerlite_synced)
          ? '<span class="bp-sync-badge">✓ Synced</span>'
          : '<span class="bp-sync-badge bp-sync-badge--warning">⚠ Not synced</span>';

        // D-13 pin marker (Phase 80-03). A `waiting` row shows the pin target number
        // when pinned, the computed queue number otherwise (unchanged from today). A
        // non-`waiting` row (which computeWaitlistQueuePositions never numbers) shows
        // `📌 —` when pinned, plain `—` when unpinned (UI-SPEC Phase-Specific Decision 5
        // -- pin control renders on EVERY row regardless of status).
        var pinnedPos = parseWaitlistPosition(row.position);
        var isPinned = pinnedPos !== null;
        var posMarker;
        if (status === 'waiting') {
          posMarker = isPinned
            ? '<span class="bp-waitlist-pin-marker">📌 ' + pinnedPos + '</span>'
            : (pos != null ? pos : '—'); // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
        } else {
          posMarker = isPinned ? '<span class="bp-waitlist-pin-marker">📌 —</span>' : '—';
        }

        // D-02 Customer cell: linked rows show "{name} — {email} — {phone}" (phone
        // segment AND its leading separator omitted when customer_phone is empty).
        // Unlinked rows keep today's exact bare-email + sync-badge rendering.
        // Phase 80-04 (D-01): a "Link customer"/"Change" trigger opens the per-row
        // customer-link panel in place of this cell -- see openWaitlistLinkPanel.
        var linkTriggerHtml = ' <button type="button" class="bp-so-change-btn" data-waitlist-link-trigger="' +
          escapeHTML(row.id) + '">' + (row.zoho_contact_id ? 'Change' : 'Link customer') + '</button>';
        var customerCell;
        if (row.zoho_contact_id) {
          var custBits = [escapeHTML(row.customer_name || ''), escapeHTML(row.email)];
          if (row.customer_phone) custBits.push(escapeHTML(row.customer_phone));
          customerCell = custBits.join(' — ') + syncBadge + linkTriggerHtml;
        } else {
          customerCell = escapeHTML(row.email) + syncBadge + linkTriggerHtml;
        }

        // D-15/D-16 Recipes cell: one display-only chip per attached recipe id, in
        // stored order, showing the catalog-resolved NAME (falls back to the raw id
        // when the catalog hasn't resolved it yet -- see waitlistResolveRecipeName)
        // plus a remove '×'. Phase 80-04 (D-15): an attach trigger opens the per-row
        // recipe picker in place of this cell.
        var recipeIds = parseWaitlistRecipeIds(row.recipe_ids);
        var recipeChipsHtml = recipeIds.map(function (rid) {
          var rname = waitlistResolveRecipeName(rid);
          return '<span class="bp-batch-chip-inline">' + escapeHTML(rname) +
            ' <button type="button" class="bp-reading-del" data-waitlist-recipe-remove-id="' + escapeHTML(row.id) +
            '" data-waitlist-recipe-remove-rid="' + escapeHTML(rid) + '" aria-label="Remove ' + escapeHTML(rname) + '">×</button></span>';
        }).join(' ');
        var recipesCell = (recipeIds.length === 0
          ? '<span class="bp-waitlist-no-recipes">No recipes attached</span>'
          : recipeChipsHtml) +
          ' <button type="button" class="bp-reassign-addnew-toggle" data-waitlist-recipe-attach-trigger="' + escapeHTML(row.id) + '">+ Attach recipe</button>';

        html += '<tr>';
        html += '<td class="bp-waitlist-pos">' + posMarker +
          " <button type=\"button\" class=\"bp-reading-edit\" data-waitlist-pin-id=\"" + escapeHTML(row.id) + "\" aria-label=\"Pin this row's position\">📌</button>" +
          (isPinned ? '<button type="button" class="bp-reading-del" data-waitlist-clear-pin-id="' + escapeHTML(row.id) + '" aria-label="Clear pin">×</button>' : '') +
          '</td>';
        html += '<td>' + customerCell + '</td>';
        html += '<td>' + recipesCell + '</td>';
        if (showCategory) html += '<td>' + escapeHTML(row.category || '—') + '</td>';
        html += '<td>' + fmtShortDate(row.signed_up_at) + '</td>';
        html += '<td><span class="bp-status-badge bp-status-badge--' + color + (actionable ? ' bp-status-clickable' : '') +
          '" data-waitlist-id="' + escapeHTML(row.id) + '" aria-label="' + escapeHTML(ariaLabel) + '">' + escapeHTML(label) + '</span></td>';
        // Phase 80-05 (D-04/D-07): the Contact button is a bare-verb `.btn bp-btn-sm`
        // (UI-SPEC Copywriting Contract, Contact action) reusing the actionable
        // predicate already computed above (Phase-Specific Decision 3) -- offering
        // the action on a booked/removed row would allow staff to send an email
        // whose second-leg status write is guaranteed to be refused server-side.
        html += '<td><button type="button" class="btn bp-btn-sm" data-waitlist-contact-trigger="' + escapeHTML(row.id) + '"' +
          (actionable ? '' : ' disabled') + '>Contact</button></td>';
        html += '<td>' + escapeHTML(row.notes || '—') +
          ' <button type="button" class="bp-reading-edit" data-waitlist-notes-id="' + escapeHTML(row.id) + '">✎</button></td>';
        html += '<td><button type="button" class="bp-reading-del" data-waitlist-remove-id="' + escapeHTML(row.id) + '" aria-label="Remove from waitlist">×</button></td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      html += '</div>';
    }

    html += '</div>';
    panel.innerHTML = html;

    // Search + refresh bind directly (stable single ids), matching the Tasks
    // toolbar convention. Filter chips + per-row actions (status/remove/notes)
    // are handled by delegation on #bp-panel-waitlist — see initDelegation.
    var searchEl = document.getElementById('bp-waitlist-search');
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        clearTimeout(_waitlistSearchTimer);
        _waitlistSearchTimer = setTimeout(function () {
          _waitlistSearch = searchEl.value;
          renderWaitlist();
        }, 200);
      });
    }

    var refreshBtn = document.getElementById('bp-waitlist-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () { loadWaitlist(); });
    }

    // Phase 80-05 (D-21): manual-add toolbar trigger, same stable-single-id
    // direct-binding convention as Search/Refresh above.
    var addTriggerBtn = document.getElementById('bp-waitlist-add-trigger');
    if (addTriggerBtn) {
      addTriggerBtn.addEventListener('click', function () { openWaitlistAddSheet(); });
    }
  }

  function findWaitlistRow(id) {
    for (var i = 0; i < _waitlistRows.length; i++) {
      if (String(_waitlistRows[i].id) === String(id)) return _waitlistRows[i];
    }
    return null;
  }

  // Tap-to-cycle a waitlist status badge forward one step (D-05, UI-SPEC.md §2).
  // ONE-WAY: nextWaitlistStatus returns null for 'booked'/'removed'/unknown, and this
  // handler bails out immediately in that case -- no confirm sheet, no write, no
  // toast. This is a deliberate deviation from the batch-status handler
  // (js/brewpad.js ~2455), which wraps around via `% order.length`; wrapping here
  // would silently reopen a booked customer's spot.
  function advanceWaitlistStatus(badgeEl, id) {
    var row = findWaitlistRow(id);
    if (!row) return;
    var next = nextWaitlistStatus(row.status);
    if (next === null) return; // booked/removed/unknown -- not actionable, no-op
    showConfirmSheet(
      'Mark ' + row.email + ' as “' + (WAITLIST_STATUS_LABELS[next] || next) + '”?',
      'Confirm', 'bp-confirm-btn--primary',
      function () {
        adminApiPost('update_waitlist_status', { id: row.id, status: next })
          .then(function () {
            row.status = next;
            renderWaitlist();
            showToast('Status updated', 'success');
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      }
    );
  }

  // Remove is a separate, always-danger-styled affordance, independent of the status
  // badge (D-05, UI-SPEC.md §2) -- a status write to 'removed', not a row deletion, so
  // the audit trail and signup ordering survive (D-01).
  function removeWaitlistEntry(id) {
    var row = findWaitlistRow(id);
    if (!row) return;
    showConfirmSheet(
      'Remove ' + row.email + ' from the beer waitlist? This cannot be undone.',
      'Remove', 'bp-confirm-btn--danger',
      function () {
        adminApiPost('update_waitlist_status', { id: row.id, status: 'removed' })
          .then(function () {
            row.status = 'removed';
            renderWaitlist();
            showToast('Removed from waitlist', 'success');
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      }
    );
  }

  // Inline notes editor -- row-becomes-input shape copied from openReadingEditRow()
  // (js/brewpad.js:6644-6666). The client input is not a trust boundary; sanitizeInput()
  // runs server-side in updateWaitlistStatus. escapeHTML on render is the client's job.
  function openWaitlistNotesEdit(cellEl, id) {
    var row = findWaitlistRow(id);
    if (!row || !cellEl) return;
    cellEl.innerHTML =
      '<input class="bp-inline-input" data-waitlist-notes-input="' + escapeHTML(id) + '" type="text" value="' + escapeHTML(row.notes || '') + '" style="width:100%;">' +
      '<button type="button" class="btn bp-btn-sm" data-waitlist-notes-save="' + escapeHTML(id) + '">Save</button>' +
      '<button type="button" class="btn-secondary bp-btn-sm" data-waitlist-notes-cancel="' + escapeHTML(id) + '">×</button>';
    var input = cellEl.querySelector('input');
    if (input) input.focus();
  }

  function saveWaitlistNotes(id, value) {
    var row = findWaitlistRow(id);
    if (!row) return;
    adminApiPost('update_waitlist_status', { id: row.id, notes: value })
      .then(function () {
        row.notes = value;
        renderWaitlist();
        showToast('Notes saved', 'success');
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // Inline position (pin) editor -- row-becomes-input shape copied from
  // openWaitlistNotesEdit above (D-13, UI-SPEC.md Queue pin section). Opens on tapping
  // the pin icon, for EVERY row regardless of status (UI-SPEC Phase-Specific
  // Decision 5), pre-filled with the row's current pin target (blank when unpinned).
  function openWaitlistPositionEdit(cellEl, id) {
    var row = findWaitlistRow(id);
    if (!row || !cellEl) return;
    var currentPos = parseWaitlistPosition(row.position);
    cellEl.innerHTML =
      '<input class="bp-inline-input" data-waitlist-position-input="' + escapeHTML(id) + '" type="number" min="1" step="1" placeholder="Position" value="' + (currentPos !== null ? currentPos : '') + '" style="width:70px;">' +
      '<button type="button" class="btn bp-btn-sm" data-waitlist-position-save="' + escapeHTML(id) + '">Save</button>' +
      '<button type="button" class="btn-secondary bp-btn-sm" data-waitlist-position-cancel="' + escapeHTML(id) + '">×</button>' +
      '<div class="bp-waitlist-pos-error" data-waitlist-position-error></div>';
    var input = cellEl.querySelector('input');
    if (input) input.focus();
  }

  // D-12: setting/clearing a pin is always reversible -- neither this nor
  // clearWaitlistPin below use showConfirmSheet (UI-SPEC.md Queue pin section, unlike
  // the destructive Remove control). Validates a positive integer BEFORE issuing any
  // request; an invalid value shows the inline error and writes nothing (T-80-18 --
  // this is UX, the server re-validates authoritatively).
  function saveWaitlistPosition(cellEl, id, rawValue) {
    var row = findWaitlistRow(id);
    if (!row || !cellEl) return;
    var n = Number(rawValue);
    var isValid = rawValue !== '' && rawValue !== null && rawValue !== undefined &&
      !isNaN(n) && isFinite(n) && n >= 1 && Math.floor(n) === n;
    if (!isValid) {
      var errEl = cellEl.querySelector('[data-waitlist-position-error]');
      if (errEl) errEl.textContent = 'Enter a position of 1 or higher.';
      return;
    }
    return adminApiPost('update_waitlist_status', { id: id, position: n })
      .then(function () {
        row.position = n;
        renderWaitlist();
        showToast('Pinned to position ' + n, 'success');
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // One-tap, no confirm sheet (D-12) -- a single-cell write clearing this row's
  // position only; never iterates or touches any other row.
  function clearWaitlistPin(id) {
    var row = findWaitlistRow(id);
    if (!row) return;
    return adminApiPost('update_waitlist_status', { id: id, position: '' })
      .then(function () {
        row.position = '';
        renderWaitlist();
        showToast('Pin cleared', 'success');
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // ===== Phase 80-04: per-row customer-link panel (D-01/D-02/D-03/D-03a) =====
  //
  // Reuse-not-rebuild: verbatim reuse of the reassign panel markup/CSS
  // (js/brewpad.js:5556-5572 region, css/brewpad.css:1977-2021 .bp-reassign-*)
  // and fetchReassignSearch's exact fetch shape (js/brewpad.js:2139), re-id'd per
  // row so two rows can never collide (bp-waitlist-link-{id}-*). The cell-becomes-
  // editor transform mirrors openWaitlistNotesEdit above.

  var _waitlistLinkSearchTimer = null;

  // Opens the search panel in place of the Customer cell. No sheet, no navigation.
  function openWaitlistLinkPanel(cellEl, id) {
    var row = findWaitlistRow(id);
    if (!row || !cellEl) return;
    cellEl.innerHTML =
      '<div class="bp-reassign-panel">' +
      '<div class="bp-so-search-wrap bp-reassign-search-wrap">' +
      '<input type="text" id="bp-waitlist-link-' + escapeHTML(id) + '-search-input" class="bp-inline-input" placeholder="Search by name, email or phone…" autocomplete="off">' +
      '<button type="button" class="bp-so-dismiss-link" data-waitlist-link-cancel="' + escapeHTML(id) + '">Cancel</button>' +
      '</div>' +
      '<div class="bp-so-results bp-reassign-results" id="bp-waitlist-link-' + escapeHTML(id) + '-results"></div>' +
      '<button type="button" class="bp-reassign-addnew-toggle" data-waitlist-link-addnew-toggle="' + escapeHTML(id) + '">+ Add new customer</button>' +
      '<div id="bp-waitlist-link-' + escapeHTML(id) + '-addnew" class="bp-reassign-addnew" style="display:none;">' +
      '<input type="text" id="bp-waitlist-link-' + escapeHTML(id) + '-new-name" class="bp-inline-input" placeholder="Full name *" autocomplete="off">' +
      '<input type="email" id="bp-waitlist-link-' + escapeHTML(id) + '-new-email" class="bp-inline-input" placeholder="Email" autocomplete="off">' +
      '<input type="tel" id="bp-waitlist-link-' + escapeHTML(id) + '-new-phone" class="bp-inline-input" placeholder="Phone" autocomplete="off">' +
      '<button type="button" class="btn bp-btn-sm" data-waitlist-link-new-save="' + escapeHTML(id) + '">Save New Customer</button>' +
      '</div>' +
      '</div>';

    var searchInput = document.getElementById('bp-waitlist-link-' + id + '-search-input');
    if (searchInput) {
      searchInput.focus();
      searchInput.addEventListener('input', function () {
        var term = searchInput.value.trim();
        clearTimeout(_waitlistLinkSearchTimer);
        if (!term || term.length < 2) {
          var resultsEl = document.getElementById('bp-waitlist-link-' + id + '-results');
          if (resultsEl) resultsEl.innerHTML = '';
          return;
        }
        _waitlistLinkSearchTimer = setTimeout(function () {
          fetchWaitlistLinkSearch(id, term);
        }, 400);
      });
    }
  }

  // Reuses fetchReassignSearch's exact /api/contacts/search?q= fetch shape
  // (js/brewpad.js:2139), rendering into this row's namespaced results container.
  function fetchWaitlistLinkSearch(id, term) {
    var resultsEl = document.getElementById('bp-waitlist-link-' + id + '-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">Searching…</div>';

    return fetch(mwUrl() + '/api/contacts/search?q=' + encodeURIComponent(term), {
      credentials: 'include'
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        var contacts = data.contacts || [];
        if (contacts.length === 0) {
          resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">No matching customers found</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < contacts.length; i++) {
          var c = contacts[i];
          html += '<div class="bp-so-result-item bp-reassign-result-item"'
               + ' data-contact-id="' + escapeHTML(c.contact_id || '') + '"'
               + ' data-name="' + escapeHTML(c.contact_name || '') + '"'
               + ' data-email="' + escapeHTML(c.email || '') + '"'
               + ' data-phone="' + escapeHTML(c.phone || '') + '">';
          html += '<span class="bp-so-result-name">' + escapeHTML(c.contact_name || '') + '</span>';
          if (c.email || c.phone) {
            html += '<span class="bp-so-result-meta">' + escapeHTML(c.email || '') + (c.email && c.phone ? ' · ' : '') + escapeHTML(c.phone || '') + '</span>';
          }
          html += '</div>';
        }
        resultsEl.innerHTML = html;

        var items = resultsEl.querySelectorAll('.bp-reassign-result-item[data-contact-id]');
        for (var j = 0; j < items.length; j++) {
          items[j].addEventListener('click', function () {
            linkWaitlistCustomer(id, {
              contact_id: this.getAttribute('data-contact-id'),
              name: this.getAttribute('data-name'),
              email: this.getAttribute('data-email'),
              phone: this.getAttribute('data-phone')
            });
          });
        }
      })
      .catch(function () {
        resultsEl.innerHTML = '<div class="bp-so-result-item" style="color:var(--ink-muted);">Search unavailable — check connection</div>';
      });
  }

  // D-02 write-through: one adminApiPost carrying id, zoho_contact_id, customer_name
  // and -- ONLY when the row's current customer_phone is empty -- customer_phone
  // (D-03a: a hand-typed phone from a manual add, plan 80-05, must never be
  // clobbered by a later contact link). Reads the current value from
  // findWaitlistRow(id); does not re-fetch.
  function linkWaitlistCustomer(id, picked) {
    var row = findWaitlistRow(id);
    if (!row || !picked) return;
    var payload = { id: id, zoho_contact_id: picked.contact_id, customer_name: picked.name || '' };
    if (!row.customer_phone) payload.customer_phone = picked.phone || '';
    return adminApiPost('update_waitlist_status', payload)
      .then(function () {
        row.zoho_contact_id = picked.contact_id;
        row.customer_name = picked.name || '';
        if (!row.customer_phone) row.customer_phone = picked.phone || '';
        renderWaitlist();
        showToast('Customer linked', 'success');
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // Create-inline: reuses the existing POST /api/contacts {name, first_name,
  // last_name, email, phone} shape (js/brewpad.js reassign new-save handler,
  // :6217-6233 region), splitting the typed full name into first/last exactly as
  // that handler does. On a contact_id response, treats it identically to
  // selecting a search result. A failure toasts and leaves the panel/typed values
  // untouched (no re-render).
  function saveWaitlistNewCustomer(id) {
    var nameInput = document.getElementById('bp-waitlist-link-' + id + '-new-name');
    var emailInput = document.getElementById('bp-waitlist-link-' + id + '-new-email');
    var phoneInput = document.getElementById('bp-waitlist-link-' + id + '-new-phone');
    var name = nameInput ? nameInput.value.trim() : '';
    var email = emailInput ? emailInput.value.trim() : '';
    var phone = phoneInput ? phoneInput.value.trim() : '';
    if (!name) {
      showToast('Name is required to add a new customer', 'error');
      return;
    }
    var nameParts = name.split(/\s+/);
    var firstName = nameParts[0] || '';
    var lastName = nameParts.slice(1).join(' ') || '';

    return fetch(mwUrl() + '/api/contacts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, first_name: firstName, last_name: lastName, email: email, phone: phone })
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, data: data || {} }; });
    }).then(function (result) {
      if (!result.ok || !result.data.contact_id) {
        throw new Error((result.data && (result.data.message || result.data.error)) || 'Unable to create contact');
      }
      return linkWaitlistCustomer(id, { contact_id: result.data.contact_id, name: name, email: email, phone: phone });
    }).catch(function (err) {
      showToast('Failed: ' + err.message, 'error');
    });
  }

  // ===== Phase 80-04: per-row recipe multi-select attach (D-15/D-16) =====
  //
  // Own-lazy-fetch catalog cache, copied verbatim from showAttachOptions's shape
  // (js/brewpad.js:5196-5222 region, the Batches-tab attach dropdown) -- adapted
  // from single-select-with-resolve to multi-select-display-only. D-16: this
  // NEVER reads the Recipes-tab's own catalog state (populated only once
  // initRecipesTab() has run) and NEVER fetches a per-recipe detail endpoint --
  // attaching is display-only, no stock check, no batch pre-fill, no pricing.
  var _waitlistRecipeCatalog = null;

  // Resolves a recipe id to its catalog name; falls back to the raw id when the
  // catalog hasn't loaded yet or doesn't contain this id.
  function waitlistResolveRecipeName(rid) {
    if (!_waitlistRecipeCatalog) return rid;
    for (var i = 0; i < _waitlistRecipeCatalog.length; i++) {
      if (_waitlistRecipeCatalog[i].recipe_id === rid) return _waitlistRecipeCatalog[i].name || rid;
    }
    return rid;
  }

  // Opens the recipe picker in place of the Recipes cell. No sheet, no navigation.
  function openWaitlistRecipeAttachPanel(cellEl, id) {
    var row = findWaitlistRow(id);
    if (!row || !cellEl) return;
    renderWaitlistRecipeAttachPanel(cellEl, id);
  }

  // Renders the attached chips (with remove ×) plus the search box/dropdown, and
  // wires the dropdown's own lazy-fetch. Re-invoked after each attach/duplicate-
  // skip so the picker stays open for a second selection (D-15).
  function renderWaitlistRecipeAttachPanel(cellEl, id) {
    var row = findWaitlistRow(id);
    if (!row || !cellEl) return;
    var attachedIds = parseWaitlistRecipeIds(row.recipe_ids);
    var chipsHtml = attachedIds.map(function (rid) {
      var rname = waitlistResolveRecipeName(rid);
      return '<span class="bp-batch-chip-inline">' + escapeHTML(rname) +
        ' <button type="button" class="bp-reading-del" data-waitlist-recipe-remove-id="' + escapeHTML(id) +
        '" data-waitlist-recipe-remove-rid="' + escapeHTML(rid) + '" aria-label="Remove ' + escapeHTML(rname) + '">×</button></span>';
    }).join(' ');

    cellEl.innerHTML =
      (attachedIds.length === 0 ? '<span class="bp-waitlist-no-recipes">No recipes attached</span> ' : chipsHtml + ' ') +
      '<div class="bp-vessel-wrap" style="margin-top:4px;">' +
      '<input type="text" id="bp-waitlist-recipe-' + escapeHTML(id) + '-input" class="bp-inline-input" placeholder="Search recipes…" autocomplete="off">' +
      '<div class="bp-vessel-dropdown" id="bp-waitlist-recipe-' + escapeHTML(id) + '-dropdown" style="display:none;"></div>' +
      '</div>' +
      '<button type="button" class="bp-so-dismiss-link" data-waitlist-recipe-attach-cancel="' + escapeHTML(id) + '" style="margin-top:4px;">Cancel</button>';

    var input = document.getElementById('bp-waitlist-recipe-' + id + '-input');
    var dropdown = document.getElementById('bp-waitlist-recipe-' + id + '-dropdown');
    if (!input || !dropdown) return;

    var picker = bpCreateRecipePicker({
      input: input,
      dropdown: dropdown,
      getCatalog: function () { return _waitlistRecipeCatalog; },
      setCatalog: function (v) { _waitlistRecipeCatalog = v; },
      onSelect: function (rid, rname) {
        attachWaitlistRecipe(id, rid, rname, cellEl);
      }
    });
    function showWaitlistRecipeOptions(term) { picker.show(term); }

    input.focus();
    input.addEventListener('input', function () {
      showWaitlistRecipeOptions(input.value.trim());
    });
    showWaitlistRecipeOptions('');
  }

  // Appends {recipe_id} to the row's attached list (skipping a duplicate with no
  // write) and issues one adminApiPost carrying the pipe-joined ids in selection
  // order (mirrors the Apps Script serializeWaitlistRecipeIds contract from plan
  // 80-01). Keeps the picker open afterward (D-15) instead of collapsing the cell.
  function attachWaitlistRecipe(id, rid, rname, cellEl) {
    var row = findWaitlistRow(id);
    if (!row || !rid) return;
    var attachedIds = parseWaitlistRecipeIds(row.recipe_ids);
    if (attachedIds.indexOf(rid) !== -1) {
      renderWaitlistRecipeAttachPanel(cellEl, id);
      return;
    }
    attachedIds.push(rid);
    var serialized = attachedIds.join('|');
    return adminApiPost('update_waitlist_status', { id: id, recipe_ids: serialized })
      .then(function () {
        row.recipe_ids = serialized;
        if (!_waitlistRecipeCatalog) _waitlistRecipeCatalog = [];
        var alreadyCached = false;
        for (var i = 0; i < _waitlistRecipeCatalog.length; i++) {
          if (_waitlistRecipeCatalog[i].recipe_id === rid) { alreadyCached = true; break; }
        }
        if (!alreadyCached) _waitlistRecipeCatalog.push({ recipe_id: rid, name: rname });
        showToast('Recipe attached', 'success');
        renderWaitlistRecipeAttachPanel(cellEl, id);
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // Chip '×' -- writes the remaining ids immediately, no showConfirmSheet (D-15/
  // UI-SPEC Decision 6: removal is reversible). Removing the last id writes an
  // empty string; renderWaitlist() then shows "No recipes attached".
  function removeWaitlistRecipe(id, rid) {
    var row = findWaitlistRow(id);
    if (!row) return;
    var remaining = parseWaitlistRecipeIds(row.recipe_ids).filter(function (existing) { return existing !== rid; });
    var serialized = remaining.join('|');
    return adminApiPost('update_waitlist_status', { id: id, recipe_ids: serialized })
      .then(function () {
        row.recipe_ids = serialized;
        renderWaitlist();
        showToast('Recipe removed', 'success');
      })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }

  // ===== Phase 80-05: Contact review sheet with fail-closed send (D-04-D-09) =====
  //
  // Reuse-not-rebuild: verbatim reuse of the .bp-create-sheet shell from
  // openRecipeFromBatchSheet (js/brewpad.js:5292-5350 region), re-id'd
  // bp-waitlist-contact-sheet. The booking link is resolved client-side from
  // the already-public, already-24h-cached GET /api/bookings/services -- never
  // a new Cal.com call, never a hardcoded bottling-invite-style booking-URL construction. The
  // send itself never touches adminApiPost -- the status write to 'contacted'
  // happens ONLY server-side, inside POST /api/waitlist/:id/contact's
  // resolved-send branch (D-08).

  // Opens the sheet in place, shows the loading state synchronously, then
  // resolves the booking link before rendering the editable form. Returns the
  // fetch promise so tests can await sheet-population.
  function openWaitlistContactSheet(id) {
    var row = findWaitlistRow(id);
    if (!row) return;

    var existing = document.getElementById('bp-waitlist-contact-sheet');
    if (existing) existing.parentNode.removeChild(existing);

    var appEl = document.getElementById('bp-app') || document.body;
    var sheetEl = document.createElement('div');
    sheetEl.id = 'bp-waitlist-contact-sheet';
    sheetEl.className = 'bp-create-sheet';
    sheetEl.style.display = '';
    sheetEl.innerHTML =
      '<div class="bp-create-sheet-inner" id="bp-waitlist-contact-sheet-inner">' +
      '<div class="bp-create-sheet-header">' +
      '<span class="bp-create-sheet-title">Contact ' + escapeHTML(row.customer_name || row.email) + '</span>' +
      '<button type="button" class="bp-create-sheet-close" id="bp-waitlist-contact-close">×</button>' +
      '</div>' +
      '<div class="bp-create-sheet-body" id="bp-waitlist-contact-body"><p>Preparing email…</p></div>' +
      '</div>';
    appEl.appendChild(sheetEl);

    function closeContactSheet() {
      sheetEl.classList.remove('bp-create-sheet--open');
      setTimeout(function () {
        if (sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
      }, 180);
    }

    setTimeout(function () { sheetEl.classList.add('bp-create-sheet--open'); }, 10);
    sheetEl.addEventListener('click', function (e) { if (e.target === sheetEl) closeContactSheet(); });
    var closeX = document.getElementById('bp-waitlist-contact-close');
    if (closeX) closeX.addEventListener('click', closeContactSheet);

    return fetch(mwUrl() + '/api/bookings/services', { credentials: 'include' })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data || {} }; }); })
      .then(function (result) {
        // WR-04: select the beer-waitlist service EXPLICITLY, never positionally.
        // A null/unmatched WAITLIST_BOOKING_SLUG yields no service, so bookingUrl
        // stays falsy and the catch below shows "Could not prepare the booking
        // link" -- fail closed. See WAITLIST_BOOKING_SLUG's TODO(80-CUTOVER §1a).
        var services = (result.ok && result.data && result.data.services) || [];
        var svc = null;
        for (var si = 0; si < services.length; si++) {
          if (services[si] && WAITLIST_BOOKING_SLUG && services[si].slug === WAITLIST_BOOKING_SLUG) {
            svc = services[si];
            break;
          }
        }
        var bookingUrl = svc && svc.bookingUrl;
        var bodyEl = document.getElementById('bp-waitlist-contact-body');
        if (!bodyEl) return;
        if (!bookingUrl) throw new Error('no booking link');
        renderWaitlistContactForm(bodyEl, row, bookingUrl, closeContactSheet);
      })
      .catch(function () {
        var bodyEl = document.getElementById('bp-waitlist-contact-body');
        if (!bodyEl) return;
        bodyEl.innerHTML =
          '<p>Could not prepare the booking link. Please try again.</p>' +
          '<div class="bp-form-actions">' +
          '<button type="button" class="btn-secondary" id="bp-waitlist-contact-cancel-only">Cancel</button>' +
          '</div>';
        var cancelOnly = document.getElementById('bp-waitlist-contact-cancel-only');
        if (cancelOnly) cancelOnly.addEventListener('click', closeContactSheet);
      });
  }

  // Renders the editable To/Subject/Body form once the booking link has
  // resolved. The To field is read-only display only -- sendWaitlistContact
  // below reads row.email directly, never this input's value (T-80-28).
  function renderWaitlistContactForm(bodyEl, row, bookingUrl, closeContactSheet) {
    var firstName = (row.customer_name || '').split(/\s+/)[0] || 'there';
    var defaultSubject = 'Your spot on the Steins & Vines beer waitlist is ready!';
    var defaultBody = 'Hi ' + firstName + ',\n\nGreat news — it’s your turn on the beer waitlist! You can book your fermentation time here:\n\n' +
      bookingUrl + '\n\nIf you have any questions, just reply to this email.\n\nCheers,\nSteins & Vines';

    bodyEl.innerHTML =
      '<div class="bp-form-group">' +
      '<label>To</label>' +
      '<input type="email" class="bp-inline-input" value="' + escapeHTML(row.email) + '" readonly>' +
      '</div>' +
      '<div class="bp-form-group">' +
      '<label>Subject</label>' +
      '<input type="text" id="bp-waitlist-contact-subject" class="bp-inline-input" value="' + escapeHTML(defaultSubject) + '">' +
      '</div>' +
      '<div class="bp-form-group">' +
      '<label>Body</label>' +
      '<textarea id="bp-waitlist-contact-body-input" class="bp-inline-input bp-notes-input" rows="8">' + escapeHTML(defaultBody) + '</textarea>' +
      '</div>' +
      '<div class="bp-waitlist-form-error" id="bp-waitlist-contact-error" style="display:none;"></div>' +
      '<div class="bp-form-actions">' +
      '<button type="button" class="btn" id="bp-waitlist-contact-send">Send</button>' +
      '<button type="button" class="btn-secondary" id="bp-waitlist-contact-cancel">Cancel</button>' +
      '</div>';

    var cancelBtn = document.getElementById('bp-waitlist-contact-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeContactSheet);

    var sendBtn = document.getElementById('bp-waitlist-contact-send');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        var subjectInput = document.getElementById('bp-waitlist-contact-subject');
        var bodyInput = document.getElementById('bp-waitlist-contact-body-input');
        var errEl = document.getElementById('bp-waitlist-contact-error');
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        sendBtn.disabled = true;
        sendWaitlistContact(row, subjectInput ? subjectInput.value : '', bodyInput ? bodyInput.value : '', bookingUrl)
          .then(function (data) {
            row.status = 'contacted';
            if (data && data.contacted_at) row.contacted_at = data.contacted_at;
            closeContactSheet();
            renderWaitlist();
            showToast('Email sent — marked Contacted', 'success');
          })
          .catch(function (err) {
            var writeFailed = !!(err && err.writeFailed);
            // WR-01: on contact_write_failed the email HAS already gone out --
            // only the row advance failed. Re-arming Send would put "send a
            // duplicate" one tap away in exactly the state where D-07/D-08 say
            // no path may send twice. Leave Send dead; Cancel is the way out.
            sendBtn.disabled = writeFailed;
            if (errEl) {
              var msg = 'Could not send. Please try again.';
              if (writeFailed) msg += ' The email went out, but the row was not advanced — do not re-send.';
              errEl.textContent = msg;
              errEl.style.display = '';
            }
          });
      });
    }
  }

  // The single POST to /api/waitlist/:id/contact (D-05/D-08). `to` is read
  // from the row object, never the DOM -- see T-80-28. Never calls
  // adminApiPost: the status write to 'contacted' lives entirely server-side.
  function sendWaitlistContact(row, subject, body, bookingUrl) {
    return fetch(mwUrl() + '/api/waitlist/' + encodeURIComponent(row.id) + '/contact', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: row.email, subject: subject, body: body, bookingUrl: bookingUrl })
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || !data || data.ok !== true) {
          var err = new Error((data && data.error) || 'send_failed');
          err.writeFailed = !!(data && data.error === 'contact_write_failed');
          throw err;
        }
        return data;
      });
    });
  }

  // ===== Phase 80-05: manual-add sheet with the D-23 disclosure state (D-21-D-25) =====
  //
  // Reuse-not-rebuild: .bp-create-sheet shell verbatim, re-id'd
  // bp-waitlist-add-sheet. The recipe field reuses the multi-select picker's
  // markup/classes and lazy-fetch catalog cache from the 80-04 per-row attach
  // panel (_waitlistRecipeCatalog, showWaitlistRecipeOptions's shape) -- but
  // selections accumulate in a LOCAL array here rather than writing
  // immediately per-tap, since this row does not exist until submit.

  function openWaitlistAddSheet() {
    var existing = document.getElementById('bp-waitlist-add-sheet');
    if (existing) existing.parentNode.removeChild(existing);

    var appEl = document.getElementById('bp-app') || document.body;
    var sheetEl = document.createElement('div');
    sheetEl.id = 'bp-waitlist-add-sheet';
    sheetEl.className = 'bp-create-sheet';
    sheetEl.style.display = '';
    sheetEl.innerHTML =
      '<div class="bp-create-sheet-inner" id="bp-waitlist-add-sheet-inner">' +
      '<div class="bp-create-sheet-header">' +
      '<span class="bp-create-sheet-title">Add to Waitlist</span>' +
      '<button type="button" class="bp-create-sheet-close" id="bp-waitlist-add-close">×</button>' +
      '</div>' +
      '<div class="bp-create-sheet-body" id="bp-waitlist-add-body"></div>' +
      '</div>';
    appEl.appendChild(sheetEl);

    function closeAddSheet() {
      sheetEl.classList.remove('bp-create-sheet--open');
      setTimeout(function () {
        if (sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
      }, 180);
    }

    setTimeout(function () { sheetEl.classList.add('bp-create-sheet--open'); }, 10);
    sheetEl.addEventListener('click', function (e) { if (e.target === sheetEl) closeAddSheet(); });
    var closeX = document.getElementById('bp-waitlist-add-close');
    if (closeX) closeX.addEventListener('click', closeAddSheet);

    renderWaitlistAddForm(closeAddSheet);
  }

  function renderWaitlistAddForm(closeAddSheet) {
    var bodyEl = document.getElementById('bp-waitlist-add-body');
    if (!bodyEl) return;
    // Local to this sheet instance -- not written until submit (D-25: this row
    // does not exist server-side yet, so there is nothing to attach ids to).
    var selectedRecipes = [];

    bodyEl.innerHTML =
      '<div class="bp-form-group">' +
      '<label>Email <span class="bp-required">*</span></label>' +
      '<input type="email" id="bp-waitlist-add-email" class="bp-inline-input" placeholder="customer@example.com" autocomplete="off">' +
      '<div class="bp-waitlist-form-error" id="bp-waitlist-add-email-error" style="display:none;"></div>' +
      '</div>' +
      '<div class="bp-form-group">' +
      '<label>Name <span class="bp-optional">optional</span></label>' +
      '<input type="text" id="bp-waitlist-add-name" class="bp-inline-input" autocomplete="off">' +
      '</div>' +
      '<div class="bp-form-group">' +
      '<label>Phone <span class="bp-optional">optional</span></label>' +
      '<input type="tel" id="bp-waitlist-add-phone" class="bp-inline-input" autocomplete="off">' +
      '</div>' +
      '<div class="bp-form-group">' +
      '<label>Recipes <span class="bp-optional">optional</span></label>' +
      '<div id="bp-waitlist-add-recipe-chips"></div>' +
      '<div class="bp-vessel-wrap" style="margin-top:4px;">' +
      '<input type="text" id="bp-waitlist-add-recipe-input" class="bp-inline-input" placeholder="Search recipes…" autocomplete="off">' +
      '<div class="bp-vessel-dropdown" id="bp-waitlist-add-recipe-dropdown" style="display:none;"></div>' +
      '</div>' +
      '</div>' +
      '<div class="bp-waitlist-form-error" id="bp-waitlist-add-error" style="display:none;"></div>' +
      '<div class="bp-form-actions">' +
      '<button type="button" class="btn" id="bp-waitlist-add-submit">Add to Waitlist</button>' +
      '<button type="button" class="btn-secondary" id="bp-waitlist-add-cancel">Cancel</button>' +
      '</div>';

    var cancelBtn = document.getElementById('bp-waitlist-add-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeAddSheet);

    function renderAddRecipeChips() {
      var chipsEl = document.getElementById('bp-waitlist-add-recipe-chips');
      if (!chipsEl) return;
      chipsEl.innerHTML = selectedRecipes.map(function (r) {
        return '<span class="bp-batch-chip-inline">' + escapeHTML(r.name) +
          ' <button type="button" class="bp-reading-del" data-waitlist-add-recipe-remove="' + escapeHTML(r.recipe_id) +
          '" aria-label="Remove ' + escapeHTML(r.name) + '">×</button></span>';
      }).join(' ');
      Array.prototype.forEach.call(chipsEl.querySelectorAll('[data-waitlist-add-recipe-remove]'), function (btn) {
        btn.addEventListener('click', function () {
          var rid = btn.getAttribute('data-waitlist-add-recipe-remove');
          selectedRecipes = selectedRecipes.filter(function (r) { return r.recipe_id !== rid; });
          renderAddRecipeChips();
        });
      });
    }

    var recipeInput = document.getElementById('bp-waitlist-add-recipe-input');
    var recipeDropdown = document.getElementById('bp-waitlist-add-recipe-dropdown');

    // Shares _waitlistRecipeCatalog with the 80-04 per-row attach panel (own
    // lazy-fetch, never _recipesState) -- D-16: display-only, no detail fetch.
    var addPicker = recipeInput && recipeDropdown ? bpCreateRecipePicker({
      input: recipeInput,
      dropdown: recipeDropdown,
      getCatalog: function () { return _waitlistRecipeCatalog; },
      setCatalog: function (v) { _waitlistRecipeCatalog = v; },
      onSelect: function (rid, rname) {
        if (!selectedRecipes.some(function (r) { return r.recipe_id === rid; })) {
          selectedRecipes.push({ recipe_id: rid, name: rname });
          renderAddRecipeChips();
        }
        addPicker.close();
        recipeInput.value = '';
      }
    }) : null;

    if (recipeInput && addPicker) {
      recipeInput.addEventListener('input', function () { addPicker.show(recipeInput.value); });
      recipeInput.addEventListener('blur', function () {
        setTimeout(function () { addPicker.close(); }, 200);
      });
    }

    var submitBtn = document.getElementById('bp-waitlist-add-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        submitWaitlistAdd(submitBtn, selectedRecipes, closeAddSheet);
      });
    }
  }

  // Email regex matches the middleware's own validation
  // (apps-script/adminApi.gs addWaitlistEntry) so client-side rejection never
  // diverges from the server's.
  var WAITLIST_ADD_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function submitWaitlistAdd(submitBtn, selectedRecipes, closeAddSheet) {
    var emailInput = document.getElementById('bp-waitlist-add-email');
    var nameInput = document.getElementById('bp-waitlist-add-name');
    var phoneInput = document.getElementById('bp-waitlist-add-phone');
    var emailErrorEl = document.getElementById('bp-waitlist-add-email-error');
    var errorEl = document.getElementById('bp-waitlist-add-error');
    if (emailErrorEl) { emailErrorEl.textContent = ''; emailErrorEl.style.display = 'none'; }
    if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }

    var email = emailInput ? emailInput.value.trim() : '';
    var name = nameInput ? nameInput.value.trim() : '';
    var phone = phoneInput ? phoneInput.value.trim() : '';

    if (!email) {
      if (emailErrorEl) { emailErrorEl.textContent = 'Email is required.'; emailErrorEl.style.display = ''; }
      return;
    }
    if (!WAITLIST_ADD_EMAIL_RE.test(email)) {
      if (emailErrorEl) { emailErrorEl.textContent = 'Enter a valid email address.'; emailErrorEl.style.display = ''; }
      return;
    }

    submitBtn.disabled = true;
    var existingById = {};

    adminApiGet('get_waitlist')
      .then(function (res) {
        (res.data || []).forEach(function (r) { existingById[String(r.id)] = r; });
        return adminApiPost('add_waitlist_entry', { email: email, category: 'beer' });
      })
      .then(function (addResult) {
        var newId = addResult && addResult.id;
        // D-23 RACE: this diff-against-snapshot check has a narrow race
        // window. If a second write lands the same email between the
        // get_waitlist snapshot above and the add_waitlist_entry call just
        // made -- another staff member's manual add, or a public beer.html
        // signup landing in between -- the shared handler's dedupe returns
        // the PRE-EXISTING row's id, but that id is absent from THIS
        // snapshot, so this check would incorrectly follow the new-row
        // branch instead of showing the disclosure below. The snapshot diff
        // was chosen deliberately over having the shared handler return a
        // decision flag directly, because changing that return shape would
        // also change what the public signup path receives -- exactly the
        // Phase 78 D-06 non-disclosure boundary this phase must not weaken.
        // The resulting false-negative is an ACCEPTED risk, not an
        // oversight: this is a staff-only surface backed by a single Sheet,
        // concurrent manual adds are infrequent, and the failure mode is a
        // missing disclosure (staff simply re-check the list) -- never a
        // leak, since the public path is structurally unaffected either way.
        if (Object.prototype.hasOwnProperty.call(existingById, String(newId))) {
          // WR-05 (1): the typed optional fields are still deliberately NOT written
          // to a matched row -- applying them would change the D-23/D-06 disclosure
          // semantics. But dropping them silently read as "the details were merged",
          // so the sheet now says outright which ones were discarded.
          var droppedFields = [];
          if (name) droppedFields.push('name');
          if (phone) droppedFields.push('phone');
          if (selectedRecipes.length) droppedFields.push('recipes');

          // WR-05 (2): the snapshot's status is the PRE-write value and may already
          // be wrong -- addWaitlistEntry reinstates a matched `removed` row to
          // `waiting` server-side, so the snapshot would claim "currently Removed"
          // for a row that is now Waiting. Re-read for the status only.
          // signed_up_at deliberately keeps using the pre-write value: the
          // post-write one is refreshed by the reinstate, and the honest answer to
          // "when did they sign up" is the original.
          return adminApiGet('get_waitlist')
            .then(function (fresh) {
              var freshRows = (fresh && fresh.data) || [];
              for (var fi = 0; fi < freshRows.length; fi++) {
                if (freshRows[fi] && String(freshRows[fi].id) === String(newId)) return freshRows[fi];
              }
              return null;
            })
            .catch(function () { return null; })
            .then(function (freshRow) {
              showWaitlistAddDisclosure(
                email, existingById[String(newId)], closeAddSheet, freshRow, droppedFields
              );
              submitBtn.disabled = false;
              return null;
            });
        }

        var optionalUpdates = {};
        if (name) optionalUpdates.customer_name = name;
        if (phone) optionalUpdates.customer_phone = phone;
        if (selectedRecipes.length) {
          optionalUpdates.recipe_ids = selectedRecipes.map(function (r) { return r.recipe_id; }).join('|');
        }
        var hasOptional = Object.keys(optionalUpdates).length > 0;
        var writeChain = hasOptional
          ? adminApiPost('update_waitlist_status', Object.assign({ id: newId }, optionalUpdates))
          : Promise.resolve();

        return writeChain.then(function () {
          // D-24: fire-and-forget, mirrors the public signup path's own block
          // -- the sheet close/toast below does not wait on this.
          fetch(mwUrl() + '/api/waitlist/' + encodeURIComponent(newId) + '/mailerlite-sync', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email })
          }).catch(function () {});
          closeAddSheet();
          loadWaitlist();
          showToast('Added to waitlist', 'success');
        });
      })
      .catch(function (err) {
        submitBtn.disabled = false;
        if (errorEl) {
          errorEl.textContent = 'Failed: ' + (err && err.message ? err.message : 'Unknown error');
          errorEl.style.display = '';
        }
      });
  }

  // D-23: the dedupe-hit disclosure swaps the sheet BODY's innerHTML in
  // place (UI-SPEC Phase-Specific Decision 4) -- no new sheet, no toast, so
  // the message is durable until staff deliberately dismiss it.
  //
  // signed_up_at comes from the PRE-write snapshot on purpose: a reinstated
  // `removed` row's timestamp refreshes server-side, and the honest answer to
  // "when did they sign up" is the pre-write value.
  //
  // WR-05: `status` does NOT get that same treatment. The pre-write snapshot can
  // already be wrong by the time this renders (a matched `removed` row has just
  // been reinstated to `waiting`), so freshRow -- a post-write re-read -- wins
  // when it is available, falling back to the snapshot when the re-read failed.
  function showWaitlistAddDisclosure(email, existingRow, closeAddSheet, freshRow, droppedFields) {
    var bodyEl = document.getElementById('bp-waitlist-add-body');
    if (!bodyEl) return;
    var currentStatus = (freshRow && freshRow.status) || existingRow.status;
    var statusLabel = WAITLIST_STATUS_LABELS[currentStatus] || currentStatus;
    var droppedNote = '';
    if (droppedFields && droppedFields.length) {
      // Say plainly that these were discarded -- "already on the list" on its own
      // reads as though the typed details were merged into the existing row.
      // Read as a sentence, not a comma-spliced array: "name and phone",
      // "name, phone and recipes". A staff member skimming this needs to see
      // exactly which of their inputs went nowhere.
      var fieldList = droppedFields.length > 1
        ? droppedFields.slice(0, -1).join(', ') + ' and ' + droppedFields[droppedFields.length - 1]
        : droppedFields[0];
      droppedNote = '<p><strong>The ' + escapeHTML(fieldList) +
        ' you entered ' + (droppedFields.length > 1 ? 'were' : 'was') +
        ' not saved.</strong> Nothing on the existing row was changed — edit it directly if you need to update ' +
        (droppedFields.length > 1 ? 'those details' : 'it') + '.</p>';
    }
    bodyEl.innerHTML =
      '<p>' + escapeHTML(email) + ' is already on the beer waitlist — signed up ' +
      escapeHTML(fmtShortDate(existingRow.signed_up_at)) + ', currently ' + escapeHTML(statusLabel) + '.</p>' +
      droppedNote +
      '<div class="bp-form-actions">' +
      '<button type="button" class="btn-secondary" id="bp-waitlist-add-gotit">Got It</button>' +
      '</div>';
    var gotItBtn = document.getElementById('bp-waitlist-add-gotit');
    if (gotItBtn) {
      gotItBtn.addEventListener('click', function () {
        closeAddSheet();
        loadWaitlist();
      });
    }
  }

  // ===== Schedule Template Editor =====

  function reloadSchedules() {
    adminApiGet('get_ferm_schedules')
      .then(function (r) {
        _fermSchedules = (r.data && r.data.schedules) || [];
        _fermSchedulesCacheTime = Date.now();
        renderBrewpadSchedules();
      })
      .catch(function (err) {
        showToast('Failed to reload schedules: ' + err.message, 'error');
      });
  }

  // D-16: body for delete/archive of an existing schedule -- carries the
  // last_updated the editor loaded as expected_updated_at (omitted if unknown).
  function scheduleTokenPayload(sid) {
    var payload = { schedule_id: sid };
    for (var i = 0; i < _fermSchedules.length; i++) {
      if (String(_fermSchedules[i].schedule_id) === String(sid)) {
        if (_fermSchedules[i].last_updated) payload.expected_updated_at = _fermSchedules[i].last_updated;
        break;
      }
    }
    return payload;
  }

  var STALE_SCHEDULE_MESSAGE = 'This schedule was changed since you opened it \u2014 reload to see the latest';

  function showStaleScheduleToast(err) {
    showToast((err && err.message) || STALE_SCHEDULE_MESSAGE, 'error', {
      actionLabel: 'Reload',
      duration: 15000,
      onAction: reloadSchedules
    });
  }

  function archiveSchedule(sid) {
    return adminApiPost('archive_ferm_schedule', scheduleTokenPayload(sid))
      .then(function () {
        showToast('Schedule archived', 'success');
        reloadSchedules();
      })
      .catch(function (err) {
        if (err && err.code === 'stale_schedule') { showStaleScheduleToast(err); return; }
        showToast('Failed: ' + err.message, 'error');
      });
  }

  // D-15: a schedule that recipes or batches still reference cannot be deleted;
  // the server answers 409 schedule_in_use and the toast offers Archive instead.
  function deleteSchedule(sid) {
    return adminApiPost('delete_ferm_schedule', scheduleTokenPayload(sid))
      .then(function () {
        showToast('Schedule deleted', 'success');
        reloadSchedules();
      })
      .catch(function (err) {
        if (err && err.code === 'stale_schedule') { showStaleScheduleToast(err); return; }
        if (err && err.code === 'schedule_in_use') {
          showToast(err.message || 'This schedule is in use. Archive it instead.', 'error', {
            actionLabel: 'Archive instead',
            duration: 15000,
            onAction: function () { archiveSchedule(sid); }
          });
          return;
        }
        showToast('Failed: ' + err.message, 'error');
      });
  }

  function renderBrewpadSchedules() {
    var container = document.getElementById('bp-schedules-list');
    if (!container) return;

    if (_fermSchedules.length === 0) {
      container.innerHTML = '<p class="bp-empty">No schedule templates yet.</p>' +
        '<button type="button" class="btn bp-sched-create-btn" id="bp-sched-create">+ New Schedule</button>';
      return;
    }

    var html = '';
    _fermSchedules.forEach(function (s) {
      var steps = s.steps_parsed || [];
      if (!steps.length && s.steps) {
        try { steps = JSON.parse(s.steps); } catch (e) {}
      }
      html += '<div class="bp-sched-card" data-sched-id="' + escapeHTML(s.schedule_id) + '">';
      html += '<div class="bp-sched-card-header">';
      html += '<strong>' + escapeHTML(s.name || 'Untitled') + '</strong>';
      html += '<div class="bp-sched-card-actions">';
      html += '<button type="button" class="btn-secondary bp-btn-sm bp-sched-edit" data-sched-id="' + escapeHTML(s.schedule_id) + '">Edit</button>';
      html += '<button type="button" class="btn-secondary bp-btn-sm bp-danger-btn bp-sched-delete" data-sched-id="' + escapeHTML(s.schedule_id) + '">Delete</button>';
      html += '</div></div>';
      if (s.category) html += '<div class="bp-sched-meta">Category: ' + escapeHTML(s.category) + '</div>';
      html += '<div class="bp-sched-meta">' + steps.length + ' step' + (steps.length !== 1 ? 's' : '') + '</div>';
      html += '<div class="bp-sched-steps">';
      steps.forEach(function (st) {
        var dayLabel = st.is_packaging ? 'TBD' : ('Day ' + st.day_offset);
        html += '<div class="bp-sched-step">';
        html += '<span class="bp-sched-step-day">' + dayLabel + '</span> ';
        html += escapeHTML(st.title || '');
        if (st.is_transfer) html += ' <span class="bp-badge bp-badge--transfer">Transfer</span>';
        if (st.is_packaging) html += ' <span class="bp-badge bp-badge--pkg">Packaging</span>';
        html += '</div>';
      });
      html += '</div></div>';
    });

    html += '<button type="button" class="btn bp-sched-create-btn" id="bp-sched-create">+ New Schedule</button>';
    container.innerHTML = html;
  }

  function openSchedSheet(existing) {
    var sheet = document.getElementById('bp-sched-sheet');
    var inner = document.getElementById('bp-sched-sheet-inner');
    if (!sheet || !inner) return;
    sheet.style.display = '';
    setTimeout(function () { sheet.classList.add('bp-sched-sheet--open'); }, 10);
    buildSchedForm(inner, existing);
    sheet.addEventListener('click', function handleBackdropClick(e) {
      if (e.target === sheet) {
        closeSchedSheet();
        sheet.removeEventListener('click', handleBackdropClick);
      }
    });
    setTimeout(function () {
      var firstInput = inner.querySelector('input[type="text"]');
      if (firstInput) firstInput.focus();
    }, 260);
  }

  function closeSchedSheet() {
    var sheet = document.getElementById('bp-sched-sheet');
    if (!sheet) return;
    sheet.classList.remove('bp-sched-sheet--open');
    setTimeout(function () { sheet.style.display = 'none'; }, 180);
  }

  // How many recipes point at a schedule template (mirrors admin D-15). Counts
  // against the recipe list this session has loaded; ensureRecipeListForSched
  // fetches it once when the Recipes tab has not been opened yet.
  function countRecipesUsingSchedule(scheduleId) {
    if (!scheduleId) return 0;
    return (_recipesState.list || []).filter(function (r) {
      return r && String(r.schedule_id || '') === String(scheduleId);
    }).length;
  }
  function ensureRecipeListForSched(cb) {
    if ((_recipesState.list || []).length > 0) { cb(); return; }
    var url = mwUrl();
    if (!url) { cb(); return; }
    fetch(url + '/api/recipes?status=all', { credentials: 'include', headers: getRecipesMwHeaders() })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        if ((_recipesState.list || []).length === 0) { _recipesState.list = data.recipes || []; }
        cb();
      })
      .catch(function () { cb(); });
  }

  function openEditSchedSheet(schedId) {
    var sched = null;
    for (var i = 0; i < _fermSchedules.length; i++) {
      if (_fermSchedules[i].schedule_id === schedId) { sched = _fermSchedules[i]; break; }
    }
    if (!sched) { showToast('Schedule not found', 'error'); return; }
    ensureRecipeListForSched(function () { openSchedSheet(sched); });
  }

  function buildSchedForm(container, existing) {
    var isEdit = !!existing;
    var regularSteps = [];
    var pkgTitle = 'Bottling / Packaging';
    var pkgDesc = '';
    if (existing) {
      var allSteps = existing.steps_parsed || [];
      if (!allSteps.length && existing.steps) {
        try { allSteps = JSON.parse(existing.steps); } catch (e) {}
      }
      allSteps.forEach(function (s) {
        if (s.is_packaging) {
          pkgTitle = s.title || pkgTitle;
          pkgDesc = s.description || pkgDesc;
        } else {
          regularSteps.push(s);
        }
      });
    }
    if (regularSteps.length === 0) {
      regularSteps = [{ step_number: 1, day_offset: 0, title: '', description: '' }];
    }

    var html = '<div class="bp-sched-form">';
    html += '<div class="bp-sched-form-header">';
    html += '<span class="bp-sched-form-title">' + (isEdit ? 'Edit' : 'New') + ' Schedule Template</span>';
    html += '<button type="button" class="bp-create-close" id="bp-sched-close">&times;</button>';
    html += '</div>';

    if (isEdit) {
      var usedByCount = countRecipesUsingSchedule(existing.schedule_id);
      if (usedByCount > 0) {
        html += '<p class="bp-sched-blast-radius" id="bp-sched-blast-radius">Used by ' + usedByCount + ' public recipe' + (usedByCount === 1 ? '' : 's') +
          '. Changing day offsets will change what customers are told.</p>';
      }
    }

    // Name
    html += '<div class="bp-sched-form-group"><label>Template Name</label>';
    html += '<input type="text" id="bp-sched-name" class="bp-inline-input" value="' + escapeHTML(existing ? existing.name || '' : '') + '" placeholder="e.g. Standard Wine 6-Week"></div>';

    // Description
    html += '<div class="bp-sched-form-group"><label>Description <span class="bp-optional">(optional)</span></label>';
    html += '<textarea id="bp-sched-desc" class="bp-inline-input" rows="2" placeholder="Brief description">' + escapeHTML(existing ? existing.description || '' : '') + '</textarea></div>';

    // Category
    html += '<div class="bp-sched-form-group"><label>Category</label>';
    html += '<select id="bp-sched-category" class="bp-inline-input">';
    html += '<option value="">None</option>';
    ['wine', 'beer', 'cider', 'seltzer'].forEach(function (c) {
      html += '<option value="' + c + '"' + (existing && existing.category === c ? ' selected' : '') + '>' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>';
    });
    html += '</select></div>';

    // Steps
    html += '<div class="bp-sched-form-group"><label>Fermentation Steps</label>';
    html += '<p class="bp-sched-form-hint">Add each step with its day offset from the start date. Steps are sorted by day automatically. Check "Transfer" if the step involves moving to a new vessel.</p>';
    html += '<div class="bp-sched-steps-header">';
    html += '<span class="bp-sched-col-day">Day</span>';
    html += '<span class="bp-sched-col-title">Title</span>';
    html += '<span class="bp-sched-col-desc">Description</span>';
    html += '<span class="bp-sched-col-transfer">Transfer</span>';
    html += '<span class="bp-sched-col-actions"></span>';
    html += '</div>';
    html += '<div id="bp-sched-steps-container"></div>';
    html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-sched-add-step" style="margin-top:8px;">+ Add Step</button>';
    html += '</div>';

    // Packaging step
    html += '<div class="bp-sched-pkg-section">';
    html += '<div class="bp-sched-pkg-label">Packaging Step <span class="bp-sched-pkg-note">(always last, date TBD)</span></div>';
    html += '<div class="bp-sched-pkg-row">';
    html += '<input type="text" id="bp-sched-pkg-title" class="bp-inline-input" value="' + escapeHTML(pkgTitle) + '" placeholder="Title">';
    html += '<input type="text" id="bp-sched-pkg-desc" class="bp-inline-input" value="' + escapeHTML(pkgDesc) + '" placeholder="Description (optional)">';
    html += '</div></div>';

    // Actions
    html += '<div class="bp-form-actions" style="margin-top:16px;">';
    html += '<button type="button" class="btn-secondary" id="bp-sched-cancel">Cancel</button>';
    html += '<button type="button" class="btn" id="bp-sched-submit">' + (isEdit ? 'Update Template' : 'Create Template') + '</button>';
    html += '</div></div>';

    container.innerHTML = html;

    // Wire close/cancel
    document.getElementById('bp-sched-close').addEventListener('click', closeSchedSheet);
    document.getElementById('bp-sched-cancel').addEventListener('click', closeSchedSheet);

    // Steps state + rendering
    var stepsContainer = document.getElementById('bp-sched-steps-container');
    _schedSteps = regularSteps.slice();

    function renderSteps() {
      var sHtml = '';
      _schedSteps.forEach(function (s, idx) {
        sHtml += '<div class="bp-sched-step-row" data-idx="' + idx + '">';
        sHtml += '<input type="number" class="bp-inline-input bp-sched-step-day" value="' + (s.day_offset || 0) + '" placeholder="Day" min="0" style="width:60px;">';
        sHtml += '<input type="text" class="bp-inline-input bp-sched-step-title" value="' + escapeHTML(s.title || '') + '" placeholder="Step title">';
        sHtml += '<input type="text" class="bp-inline-input bp-sched-step-desc" value="' + escapeHTML(s.description || '') + '" placeholder="Description (optional)">';
        sHtml += '<label class="bp-sched-transfer-check"><input type="checkbox" class="bp-sched-step-transfer"' + (s.is_transfer ? ' checked' : '') + '></label>';
        sHtml += '<button type="button" class="bp-sched-step-remove" title="Remove step">&times;</button>';
        sHtml += '</div>';
      });
      stepsContainer.innerHTML = sHtml;

      Array.prototype.forEach.call(stepsContainer.querySelectorAll('.bp-sched-step-row'), function (row) {
        var idx = parseInt(row.getAttribute('data-idx'), 10);
        row.querySelector('.bp-sched-step-day').addEventListener('change', function () {
          _schedSteps[idx].day_offset = parseInt(this.value, 10) || 0;
        });
        row.querySelector('.bp-sched-step-title').addEventListener('change', function () {
          _schedSteps[idx].title = this.value;
        });
        row.querySelector('.bp-sched-step-desc').addEventListener('change', function () {
          _schedSteps[idx].description = this.value;
        });
        row.querySelector('.bp-sched-step-transfer').addEventListener('change', function () {
          _schedSteps[idx].is_transfer = this.checked;
        });
        row.querySelector('.bp-sched-step-remove').addEventListener('click', function () {
          if (_schedSteps.length <= 1) { showToast('Need at least 1 fermentation step', 'error'); return; }
          _schedSteps.splice(idx, 1);
          renderSteps();
        });
      });
    }
    renderSteps();

    // Add step
    document.getElementById('bp-sched-add-step').addEventListener('click', function () {
      var maxDay = 0;
      _schedSteps.forEach(function (s) { if (s.day_offset > maxDay) maxDay = s.day_offset; });
      _schedSteps.push({ step_number: 0, day_offset: maxDay + 7, title: '', description: '' });
      renderSteps();
    });

    // Submit
    document.getElementById('bp-sched-submit').addEventListener('click', function () {
      var name = document.getElementById('bp-sched-name').value.trim();
      if (!name) { showToast('Enter a template name', 'error'); return; }

      // Read current values from inputs (in case user typed without triggering change)
      Array.prototype.forEach.call(stepsContainer.querySelectorAll('.bp-sched-step-row'), function (row) {
        var idx = parseInt(row.getAttribute('data-idx'), 10);
        _schedSteps[idx].day_offset = parseInt(row.querySelector('.bp-sched-step-day').value, 10) || 0;
        _schedSteps[idx].title = row.querySelector('.bp-sched-step-title').value;
        _schedSteps[idx].description = row.querySelector('.bp-sched-step-desc').value;
        _schedSteps[idx].is_transfer = row.querySelector('.bp-sched-step-transfer').checked;
      });

      // Validate regular steps have titles
      var emptyTitle = false;
      _schedSteps.forEach(function (s) { if (!s.title || !s.title.trim()) emptyTitle = true; });
      if (emptyTitle) { showToast('Every step needs a title', 'error'); return; }

      // Sort regular steps by day_offset, then build final steps array
      var sorted = _schedSteps.slice().sort(function (a, b) { return a.day_offset - b.day_offset; });
      var steps = sorted.map(function (s, idx) {
        return {
          step_number: idx + 1,
          day_offset: s.day_offset,
          title: s.title,
          description: s.description || '',
          is_packaging: false,
          is_transfer: !!s.is_transfer
        };
      });

      // Append packaging as final step
      steps.push({
        step_number: steps.length + 1,
        day_offset: -1,
        title: document.getElementById('bp-sched-pkg-title').value || 'Bottling / Packaging',
        description: document.getElementById('bp-sched-pkg-desc').value || '',
        is_packaging: true
      });

      var payload = {
        name: name,
        description: document.getElementById('bp-sched-desc').value || '',
        category: document.getElementById('bp-sched-category').value || '',
        steps: steps
      };

      var action = isEdit ? 'update_ferm_schedule' : 'create_ferm_schedule';
      if (isEdit) {
        payload.schedule_id = existing.schedule_id;
        if (existing.last_updated) payload.expected_updated_at = existing.last_updated;
      }

      var submitBtn = document.getElementById('bp-sched-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';

      adminApiPost(action, payload)
        .then(function () {
          showToast('Schedule ' + (isEdit ? 'updated' : 'created'), 'success');
          closeSchedSheet();
          reloadSchedules();
        })
        .catch(function (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = isEdit ? 'Update Template' : 'Create Template';
          // D-16: stale editor -- 409 is never auto-retried; the draft stays in the form.
          if (err && err.code === 'stale_schedule') {
            showStaleScheduleToast(err);
            return;
          }
          showToast('Failed: ' + err.message, 'error');
        });
    });
  }

  // ===== Event Delegation (one-time setup) =====

  function initDelegation() {
    // Dashboard: pipeline tile + workload day clicks
    var dashInner = document.getElementById('bp-dashboard-inner');
    if (dashInner) {
      dashInner.addEventListener('click', function (e) {
        var tile = e.target.closest('.bp-pipeline-tile');
        if (tile) {
          _dashDrill = null;
          _batchStatusFilter = tile.getAttribute('data-status');
          _batchSearch = '';
          _batchesLoaded = false;
          switchTab('batches');
          return;
        }
        var batchRow = e.target.closest('tr[data-batch-id]');
        if (batchRow) {
          switchTab('batches');
          selectBatch(batchRow.getAttribute('data-batch-id'));
          return;
        }
        var rtbInvite = e.target.closest('.bp-rtb-invite-btn[data-batch-id]');
        if (rtbInvite) {
          var ibid = rtbInvite.getAttribute('data-batch-id');
          var iwho = rtbInvite.getAttribute('data-customer') || 'this customer';
          var iname = rtbInvite.getAttribute('data-customer') || '';
          if (iname === 'this customer') iname = '';
          showConfirmSheet('Send a bottling booking invite to ' + iwho + '?', 'Send Invite', '', function () {
            rtbInvite.disabled = true;
            sendBottlingInviteForBatch({
              name: iname,
              batchId: ibid,
              productName: rtbInvite.getAttribute('data-product') || ''
            })
              .then(function () { showToast('Bottling invite sent', 'success'); })
              .catch(function (err) { showToast('Failed: ' + err.message, 'error'); })
              .then(function () { rtbInvite.disabled = false; });
          });
          return;
        }
        var nsActivateBtn = e.target.closest('.bp-needsched-activate-btn');
        if (nsActivateBtn) {
          var bid = nsActivateBtn.getAttribute('data-batch-id');
          var ver = nsActivateBtn.getAttribute('data-version');
          showConfirmSheet(
            'Activate ' + bid + ' now? No schedule will be attached and the start date is set to today. Use "Schedule & Activate" if you need a schedule.',
            'Activate', '',
            function () {
              nsActivateBtn.disabled = true;
              adminApiPost('update_batch', {
                batch_id: bid,
                expectedVersion: ver,
                updates: { status: 'primary', start_date: todayPacific() }
              }).then(function () {
                showToast('Batch activated', 'success');
                // Bust snapshot so re-opening the batch shows the new 'primary' status (#18)
                afterBatchWrite(bid, { listAffecting: true });
                loadDashboard();
              }).catch(function (err) {
                showToast('Failed: ' + err.message, 'error');
                nsActivateBtn.disabled = false;
              });
            }
          );
          return;
        }
        var nsSaBtn = e.target.closest('.bp-needsched-sa-btn');
        if (nsSaBtn) {
          var bid2 = nsSaBtn.getAttribute('data-batch-id');
          var batchRow = null;
          for (var i = 0; i < _allBatchesData.length; i++) {
            if (_allBatchesData[i].batch_id === bid2) { batchRow = _allBatchesData[i]; break; }
          }
          if (batchRow) {
            openScheduleActivateSheet(batchRow);
          } else {
            nsSaBtn.disabled = true;
            adminApiGet('get_batch', { batch_id: bid2 })
              .then(function (r) { openScheduleActivateSheet((r.data && r.data.batch) || { batch_id: bid2 }); })
              .catch(function (err) { showToast('Failed: ' + err.message, 'error'); nsSaBtn.disabled = false; });
          }
          return;
        }
        var nsDelBtn = e.target.closest('.bp-needsched-delete-btn');
        if (nsDelBtn) {
          var bid = nsDelBtn.getAttribute('data-batch-id');
          if (!bid) { showToast('Missing batch ID', 'error'); return; }
          var prod = nsDelBtn.getAttribute('data-product');
          var cust = nsDelBtn.getAttribute('data-customer');
          // Phase 64/OPS-03: resolve zoho_so_number from _allBatchesData BEFORE the
          // delete fires — the success handler below sets _allBatchesData = [], so a
          // post-delete lookup would always find nothing (CAUTION in the plan).
          var nsSoNum = '';
          for (var nsi = 0; nsi < _allBatchesData.length; nsi++) {
            if (_allBatchesData[nsi].batch_id === bid) { nsSoNum = _allBatchesData[nsi].zoho_so_number || ''; break; }
          }
          showConfirmSheet(
            'Delete ' + bid + ' (' + prod + (cust ? ' — ' + cust : '') + ')? Any attached tasks will be removed. This cannot be undone.',
            'Delete', 'bp-confirm-btn--danger',
            function () {
              nsDelBtn.disabled = true;
              adminApiPost('delete_batch', { batch_id: bid })
                .then(function () {
                  showToast('Batch ' + bid + ' deleted', 'success');
                  if (nsSoNum) reconcileInvoiceStatusAfterDelete(nsSoNum);
                  _batchesLoaded = false;
                  _allBatchesData = [];
                  _eagerLoadTime = 0;
                  _dashLoadTime = 0;
                  // Re-render the dashboard the button lives on (refetches
                  // _dashSummary so the deleted Needs Scheduling row goes away);
                  // cache flags above keep the batches tab fresh on next visit.
                  loadDashboard();
                })
                .catch(function (err) {
                  showToast('Failed: ' + err.message, 'error');
                  nsDelBtn.disabled = false;
                });
            }
          );
          return;
        }
        var chip = e.target.closest('.bp-batch-chip[data-batch-id]');
        if (chip) {
          switchTab('batches');
          selectBatch(chip.getAttribute('data-batch-id'));
          return;
        }
        var rtbToggle = e.target.closest('.bp-rtb-toggle');
        if (rtbToggle) {
          _dashRtbExpanded = !_dashRtbExpanded;
          renderDashboard();
          return;
        }
        var nsToggle = e.target.closest('.bp-needsched-toggle');
        if (nsToggle) {
          _dashNeedsSchedExpanded = !_dashNeedsSchedExpanded;
          renderDashboard();
          return;
        }
        var chartTypeChip = e.target.closest('[data-bp-chart-type]');
        if (chartTypeChip) {
          var ctype = chartTypeChip.getAttribute('data-bp-chart-type');
          if (ctype) {
            if (_dashChartHiddenTypes[ctype]) {
              delete _dashChartHiddenTypes[ctype];
            } else {
              _dashChartHiddenTypes[ctype] = true;
            }
            renderDashboard();
          }
          return;
        }
        var wineDimChip = e.target.closest('[data-bp-wine-dim]');
        if (wineDimChip) {
          var wdim = wineDimChip.getAttribute('data-bp-wine-dim');
          if (wdim && wdim !== _dashWineDimension) {
            _dashWineDimension = wdim;
            renderDashboard();
          }
          return;
        }
        var winePeriodChip = e.target.closest('[data-bp-wine-period]');
        if (winePeriodChip) {
          var wperiod = winePeriodChip.getAttribute('data-bp-wine-period');
          if (wperiod && wperiod !== _dashWinePeriod) {
            _dashWinePeriod = wperiod;
            renderDashboard();
          }
          return;
        }
        var day = e.target.closest('.bp-wl-day');
        if (day) {
          var date = day.getAttribute('data-date');
          _dashExpandedDay = (_dashExpandedDay === date) ? null : date;
          renderDashboard();
          return;
        }
      });
      dashInner.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var kChip = e.target.closest('[data-bp-chart-type]');
        if (kChip) {
          e.preventDefault();
          var ktype = kChip.getAttribute('data-bp-chart-type');
          if (ktype) {
            if (_dashChartHiddenTypes[ktype]) {
              delete _dashChartHiddenTypes[ktype];
            } else {
              _dashChartHiddenTypes[ktype] = true;
            }
            renderDashboard();
          }
        }
        var kWineDim = e.target.closest('[data-bp-wine-dim]');
        if (kWineDim) {
          e.preventDefault();
          var kwdim = kWineDim.getAttribute('data-bp-wine-dim');
          if (kwdim && kwdim !== _dashWineDimension) {
            _dashWineDimension = kwdim;
            renderDashboard();
          }
        }
        var kWinePeriod = e.target.closest('[data-bp-wine-period]');
        if (kWinePeriod) {
          e.preventDefault();
          var kwperiod = kWinePeriod.getAttribute('data-bp-wine-period');
          if (kwperiod && kwperiod !== _dashWinePeriod) {
            _dashWinePeriod = kwperiod;
            renderDashboard();
          }
        }
      });
      dashInner.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox' || !cb.hasAttribute('data-task-id')) return;
        var taskId = cb.getAttribute('data-task-id');
        var checked = cb.checked;
        var task = null;
        for (var ti = 0; ti < _upcomingTasks.length; ti++) {
          if (_upcomingTasks[ti].task_id === taskId) { task = _upcomingTasks[ti]; break; }
        }
        if (navigator.vibrate) navigator.vibrate(checked ? [40, 20, 60] : 20);
        var row = cb.closest('.bp-task-row');
        if (row) row.classList.toggle('bp-task-row--done', checked);
        if (row) row.setAttribute('data-save-state', 'saving');
        clearTimeout(_taskSaveTimers[taskId]);
        _taskSaveTimers[taskId] = setTimeout(function () {
          delete _taskSaveTimers[taskId];
          // batch_id MUST be sent so the server can bust the per-batch detail cache
          // (gb:<batchId>); without it the get_batch refetch returns the stale batch
          // and the checkbox reverts until the 5-min TTL / next login.
          adminApiPost('bulk_update_batch_tasks', { batch_id: task ? task.batch_id : _selectedBatchId, tasks: [{ task_id: taskId, updates: { completed: checked } }] })
            .then(function () {
              for (var i = 0; i < _upcomingTasks.length; i++) {
                if (_upcomingTasks[i].task_id === taskId) {
                  _upcomingTasks[i].completed = checked ? 'TRUE' : 'FALSE';
                  break;
                }
              }
              if (row) {
                row.setAttribute('data-save-state', 'saved');
                setTimeout(function () { if (row) row.removeAttribute('data-save-state'); }, 1500);
              }
              // Bust the task's batch detail snapshot using task.batch_id (not _selectedBatchId)
              // so that re-opening the batch shows the updated task state (#20). Use
              // listAffecting:false: readyToBottle freshness comes from loadDashboard()
              // refetching _dashSummary, NOT from clearing _allBatchesData — clearing it
              // would blank the dashboard stat cards + month chart until the user visits
              // the Batches tab (WR-01). loadDashboard() then keeps the batch-view
              // readyToBottle filter live if it's the active view.
              if (task && task.batch_id) afterBatchWrite(task.batch_id, { listAffecting: false });
              applyTaskToggleToList(task ? task.batch_id : _selectedBatchId, checked);
              loadDashboard().then(refreshReadyToBottleFilterView);
              var titleLower = task ? (task.title || '').toLowerCase() : '';
              var isVesselChange = checked && task && (
                String(task.is_transfer).toUpperCase() === 'TRUE' ||
                titleLower.indexOf('transfer') !== -1 ||
                titleLower.indexOf('rack') !== -1 ||
                titleLower.indexOf('filter') !== -1
              );
              if (checked && row && !isVesselChange) {
                row.style.transition = 'opacity 0.3s, max-height 0.3s';
                row.style.opacity = '0';
                row.style.maxHeight = '0';
                row.style.overflow = 'hidden';
                setTimeout(function () { renderDashboard(); }, 400);
              }
              if (isVesselChange) {
                setTimeout(function () { showTransferLocationSheet(task); }, 450);
              }
            })
            .catch(function () {
              cb.checked = !checked;
              if (row) row.classList.toggle('bp-task-row--done', !checked);
              if (row) row.setAttribute('data-save-state', 'error');
              showToast('Save failed \u2014 try again', 'error');
            });
        }, 300);
      });
    }

    // Batch list: sub-tabs + filter button + schedule cards + batch card clicks
    var batchListPane = document.getElementById('bp-batch-list-pane');
    if (batchListPane) {
      batchListPane.addEventListener('click', function (e) {
        // Sub-tab switching (Batches / Schedules)
        var subtab = e.target.closest('.bp-batch-subtab');
        if (subtab) {
          var view = subtab.getAttribute('data-subview');
          if (view && view !== _batchSubView) {
            _batchSubView = view;
            Array.prototype.forEach.call(batchListPane.querySelectorAll('.bp-batch-subtab'), function (btn) {
              btn.classList.toggle('bp-batch-subtab--active', btn.getAttribute('data-subview') === view);
            });
            var batchContent = document.getElementById('bp-batch-list-content');
            var schedContent = document.getElementById('bp-schedules-list');
            if (batchContent) batchContent.style.display = (view === 'batches') ? '' : 'none';
            if (schedContent) schedContent.style.display = (view === 'schedules') ? '' : 'none';
            if (view === 'schedules') renderBrewpadSchedules();
          }
          return;
        }

        // Schedule card actions (delegated)
        var schedEdit = e.target.closest('.bp-sched-edit');
        if (schedEdit) {
          openEditSchedSheet(schedEdit.getAttribute('data-sched-id'));
          return;
        }
        var schedDelete = e.target.closest('.bp-sched-delete');
        if (schedDelete) {
          var sid = schedDelete.getAttribute('data-sched-id');
          showConfirmSheet('Delete this schedule template?', 'Delete', 'bp-confirm-btn--danger', function () {
            deleteSchedule(sid);
          });
          return;
        }
        if (e.target.closest('#bp-sched-create')) {
          openSchedSheet(null);
          return;
        }

        if (e.target.closest('[data-action="clear-dash-drill"]')) {
          clearDashDrill();
          return;
        }
        var filterBtn = e.target.closest('.bp-filter-btn');
        if (filterBtn) {
          selectBatchStatusFilter(filterBtn);
          return;
        }
        if (e.target.closest('#bp-batch-view-toggle')) {
          _batchViewMode = (_batchViewMode === 'cards') ? 'table' : 'cards';
          renderBatchList();
          return;
        }
        var sortTh = e.target.closest('th[data-sort]');
        if (sortTh) {
          var col = sortTh.getAttribute('data-sort');
          _batchTableSortDir = (_batchTableSortCol === col) ? -_batchTableSortDir : 1;
          _batchTableSortCol = col;
          renderBatchList();
          return;
        }
        var card = e.target.closest('.bp-batch-card');
        if (card) { selectBatch(card.getAttribute('data-batch-id')); return; }
        var row = e.target.closest('tr[data-batch-id]');
        if (row) selectBatch(row.getAttribute('data-batch-id'));
      });

      // Improvement 1: Preload on touchstart — start fetching ~300ms before click fires
      batchListPane.addEventListener('touchstart', function (e) {
        var card = e.target.closest('.bp-batch-card');
        if (!card) {
          var row = e.target.closest('tr[data-batch-id]');
          if (row) card = row;
        }
        if (!card) return;
        var batchId = card.getAttribute('data-batch-id');
        if (!batchId || batchId === _preloadBatchId) return;

        // Check if already in sessionStorage cache
        var cacheKey = 'sv-bp-batch-' + batchId;
        try {
          var raw = sessionStorage.getItem(cacheKey);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (Date.now() - parsed.ts < 120000) return; // already cached, no preload needed
          }
        } catch (e2) {}

        _preloadBatchId = batchId;
        _preloadPromise = adminApiGet('get_batch', { batch_id: batchId });
        _preloadPromise.then(function (result) {
          // Cache the preloaded result
          try {
            sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: result.data || {} }));
          } catch (e3) {}
        }).catch(function () {
          _preloadPromise = null;
          _preloadBatchId = null;
        });
      }, { passive: true });
    }

    // Tasks tab: checkbox auto-save + batch chip navigation
    var tasksInner = document.getElementById('bp-tasks-inner');
    if (tasksInner) {
      tasksInner.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox' || !cb.hasAttribute('data-task-id')) return;
        var taskId = cb.getAttribute('data-task-id');
        var checked = cb.checked;
        var task = null;
        for (var ti = 0; ti < _upcomingTasks.length; ti++) {
          if (_upcomingTasks[ti].task_id === taskId) { task = _upcomingTasks[ti]; break; }
        }
        if (navigator.vibrate) navigator.vibrate(checked ? [40, 20, 60] : 20);
        var row = cb.closest('.bp-task-row');
        if (row) row.classList.toggle('bp-task-row--done', checked);
        if (row) row.setAttribute('data-save-state', 'saving');
        clearTimeout(_taskSaveTimers[taskId]);
        _taskSaveTimers[taskId] = setTimeout(function () {
          delete _taskSaveTimers[taskId];
          // batch_id MUST be sent so the server can bust the per-batch detail cache
          // (gb:<batchId>); without it the get_batch refetch returns the stale batch
          // and the checkbox reverts until the 5-min TTL / next login.
          adminApiPost('bulk_update_batch_tasks', { batch_id: task ? task.batch_id : _selectedBatchId, tasks: [{ task_id: taskId, updates: { completed: checked } }] })
            .then(function () {
              for (var i = 0; i < _upcomingTasks.length; i++) {
                if (_upcomingTasks[i].task_id === taskId) {
                  _upcomingTasks[i].completed = checked ? 'TRUE' : 'FALSE';
                  break;
                }
              }
              if (row) {
                row.setAttribute('data-save-state', 'saved');
                setTimeout(function () { if (row) row.removeAttribute('data-save-state'); }, 1500);
              }
              // Bust the task's batch detail snapshot using task.batch_id (not _selectedBatchId)
              // so that re-opening the batch shows the updated task state (#21). Use
              // listAffecting:false so the dashboard stat cards/chart aren't blanked (WR-01);
              // loadDashboard() refetches _dashSummary for readyToBottle freshness and keeps
              // the batch-view readyToBottle filter live if it's the active view.
              if (task && task.batch_id) afterBatchWrite(task.batch_id, { listAffecting: false });
              applyTaskToggleToList(task ? task.batch_id : _selectedBatchId, checked);
              loadDashboard().then(refreshReadyToBottleFilterView);
              var titleLower2 = task ? (task.title || '').toLowerCase() : '';
              var isVesselChange2 = checked && task && (
                String(task.is_transfer).toUpperCase() === 'TRUE' ||
                titleLower2.indexOf('transfer') !== -1 ||
                titleLower2.indexOf('rack') !== -1 ||
                titleLower2.indexOf('filter') !== -1
              );
              if (checked && row && !isVesselChange2) {
                row.style.transition = 'opacity 0.3s, max-height 0.3s';
                row.style.opacity = '0';
                row.style.maxHeight = '0';
                row.style.overflow = 'hidden';
                setTimeout(function () { renderTasks(); }, 400);
              }
              if (isVesselChange2) {
                setTimeout(function () { showTransferLocationSheet(task); }, 450);
              }
            })
            .catch(function () {
              cb.checked = !checked;
              if (row) row.classList.toggle('bp-task-row--done', !checked);
              if (row) row.setAttribute('data-save-state', 'error');
              showToast('Save failed \u2014 try again', 'error');
            });
        }, 300);
      });
      tasksInner.addEventListener('click', function (e) {
        var filterBtn = e.target.closest('.bp-filter-btn[data-task-filter]');
        if (filterBtn) {
          _taskFilter = filterBtn.getAttribute('data-task-filter');
          renderTasks();
          return;
        }
        var chip = e.target.closest('.bp-batch-chip[data-batch-id]');
        if (!chip) return;
        e.stopPropagation();
        _batchDetailReturnTab = 'tasks';
        switchTab('batches');
        selectBatch(chip.getAttribute('data-batch-id'));
      });
    }

    // Measurements: meas cell input + batch chip navigation + sort headers
    // Delegate on #bp-measurements-inner (stable) since #bp-meas-grid-wrap is dynamically created
    var measInner = document.getElementById('bp-measurements-inner');
    if (measInner) {
      measInner.addEventListener('input', function (e) {
        if (e.target.classList.contains('bp-meas-cell')) updateMeasSubmitCount();
      });
      measInner.addEventListener('click', function (e) {
        var th = e.target.closest('[data-sort]');
        if (th) {
          var col = th.getAttribute('data-sort');
          _measSortDir = (_measSortCol === col) ? -_measSortDir : 1;
          _measSortCol = col;
          saveMeasGridValues();
          var gridWrap = document.getElementById('bp-meas-grid-wrap');
          if (gridWrap) gridWrap.innerHTML = renderMeasGrid();
          updateMeasSubmitCount();
          return;
        }
        var chip = e.target.closest('.bp-batch-chip[data-batch-id]');
        if (!chip) return;
        e.stopPropagation();
        switchTab('batches');
        selectBatch(chip.getAttribute('data-batch-id'));
      });
    }

    // Waitlist (Phase 78): filter chips + status advance + remove + inline notes edit.
    // Delegate on #bp-panel-waitlist (stable) since the toolbar/table are rebuilt on
    // every renderWaitlist() call.
    var waitlistPanel = document.getElementById('bp-panel-waitlist');
    if (waitlistPanel) {
      waitlistPanel.addEventListener('click', function (e) {
        var filterBtn = e.target.closest('.bp-filter-btn[data-waitlist-filter]');
        if (filterBtn) {
          _waitlistFilter = filterBtn.getAttribute('data-waitlist-filter');
          renderWaitlist();
          return;
        }
        var statusBadge = e.target.closest('.bp-status-clickable[data-waitlist-id]');
        if (statusBadge) {
          advanceWaitlistStatus(statusBadge, statusBadge.getAttribute('data-waitlist-id'));
          return;
        }
        var removeBtn = e.target.closest('.bp-reading-del[data-waitlist-remove-id]');
        if (removeBtn) {
          removeWaitlistEntry(removeBtn.getAttribute('data-waitlist-remove-id'));
          return;
        }
        var notesEditBtn = e.target.closest('.bp-reading-edit[data-waitlist-notes-id]');
        if (notesEditBtn) {
          openWaitlistNotesEdit(notesEditBtn.parentNode, notesEditBtn.getAttribute('data-waitlist-notes-id'));
          return;
        }
        var notesCancelBtn = e.target.closest('[data-waitlist-notes-cancel]');
        if (notesCancelBtn) {
          renderWaitlist();
          return;
        }
        var notesSaveBtn = e.target.closest('[data-waitlist-notes-save]');
        if (notesSaveBtn) {
          var savedId = notesSaveBtn.getAttribute('data-waitlist-notes-save');
          var input = waitlistPanel.querySelector('[data-waitlist-notes-input="' + savedId + '"]');
          saveWaitlistNotes(savedId, input ? input.value : '');
          return;
        }
        // Phase 80-03: pin marker / inline position editor (D-10-D-14).
        var pinBtn = e.target.closest('.bp-reading-edit[data-waitlist-pin-id]');
        if (pinBtn) {
          openWaitlistPositionEdit(pinBtn.closest('td'), pinBtn.getAttribute('data-waitlist-pin-id'));
          return;
        }
        var clearPinBtn = e.target.closest('.bp-reading-del[data-waitlist-clear-pin-id]');
        if (clearPinBtn) {
          clearWaitlistPin(clearPinBtn.getAttribute('data-waitlist-clear-pin-id'));
          return;
        }
        var positionCancelBtn = e.target.closest('[data-waitlist-position-cancel]');
        if (positionCancelBtn) {
          renderWaitlist();
          return;
        }
        var positionSaveBtn = e.target.closest('[data-waitlist-position-save]');
        if (positionSaveBtn) {
          var positionId = positionSaveBtn.getAttribute('data-waitlist-position-save');
          var positionCellEl = positionSaveBtn.closest('td');
          var positionInput = positionCellEl ? positionCellEl.querySelector('[data-waitlist-position-input]') : null;
          saveWaitlistPosition(positionCellEl, positionId, positionInput ? positionInput.value : '');
          return;
        }
        // Phase 80-04: per-row customer-link panel (D-01/D-02/D-03a).
        var linkTrigger = e.target.closest('[data-waitlist-link-trigger]');
        if (linkTrigger) {
          openWaitlistLinkPanel(linkTrigger.closest('td'), linkTrigger.getAttribute('data-waitlist-link-trigger'));
          return;
        }
        var linkCancelBtn = e.target.closest('[data-waitlist-link-cancel]');
        if (linkCancelBtn) {
          renderWaitlist();
          return;
        }
        var linkAddNewToggle = e.target.closest('[data-waitlist-link-addnew-toggle]');
        if (linkAddNewToggle) {
          var linkRowId = linkAddNewToggle.getAttribute('data-waitlist-link-addnew-toggle');
          var linkAddNewForm = document.getElementById('bp-waitlist-link-' + linkRowId + '-addnew');
          if (linkAddNewForm) {
            var linkAddNewVisible = linkAddNewForm.style.display !== 'none';
            linkAddNewForm.style.display = linkAddNewVisible ? 'none' : '';
            if (!linkAddNewVisible) {
              var linkNameInput = document.getElementById('bp-waitlist-link-' + linkRowId + '-new-name');
              if (linkNameInput) linkNameInput.focus();
            }
          }
          return;
        }
        var linkNewSaveBtn = e.target.closest('[data-waitlist-link-new-save]');
        if (linkNewSaveBtn) {
          saveWaitlistNewCustomer(linkNewSaveBtn.getAttribute('data-waitlist-link-new-save'));
          return;
        }
        // Phase 80-04: per-row recipe multi-select attach (D-15/D-16).
        var recipeAttachTrigger = e.target.closest('[data-waitlist-recipe-attach-trigger]');
        if (recipeAttachTrigger) {
          openWaitlistRecipeAttachPanel(recipeAttachTrigger.closest('td'), recipeAttachTrigger.getAttribute('data-waitlist-recipe-attach-trigger'));
          return;
        }
        var recipeAttachCancelBtn = e.target.closest('[data-waitlist-recipe-attach-cancel]');
        if (recipeAttachCancelBtn) {
          renderWaitlist();
          return;
        }
        var recipeRemoveBtn = e.target.closest('[data-waitlist-recipe-remove-id]');
        if (recipeRemoveBtn) {
          removeWaitlistRecipe(recipeRemoveBtn.getAttribute('data-waitlist-recipe-remove-id'), recipeRemoveBtn.getAttribute('data-waitlist-recipe-remove-rid'));
          return;
        }
        // Phase 80-05: Contact review sheet trigger (D-04-D-09). Defensive
        // `.disabled` guard alongside the native `disabled` attribute already
        // preventing the click -- belt-and-suspenders, matches T-80-30's intent
        // that a booked/removed row can never reach the send flow.
        var contactTrigger = e.target.closest('.btn[data-waitlist-contact-trigger]');
        if (contactTrigger && !contactTrigger.disabled) {
          openWaitlistContactSheet(contactTrigger.getAttribute('data-waitlist-contact-trigger'));
        }
      });
    }

    // Detail pane: task checkbox auto-save + staging remove buttons
    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (detailPane) {
      detailPane.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox' || !cb.hasAttribute('data-task-id')) return;
        if (!cb.closest('#bp-detail-tasks')) return;
        var taskId = cb.getAttribute('data-task-id');
        var checked = cb.checked;
        if (navigator.vibrate) navigator.vibrate(checked ? [40, 20, 60] : 20);
        var row = cb.closest('.bp-task-row');
        if (row) row.classList.toggle('bp-task-row--done', checked);
        if (row) row.setAttribute('data-save-state', 'saving');
        clearTimeout(_taskSaveTimers[taskId]);
        _taskSaveTimers[taskId] = setTimeout(function () {
          delete _taskSaveTimers[taskId];
          // batch_id MUST be sent so the server can bust the per-batch detail cache
          // (gb:<batchId>); without it the get_batch refetch returns the stale batch
          // and the checkbox reverts until the 5-min TTL / next login.
          adminApiPost('bulk_update_batch_tasks', { batch_id: _selectedBatchId, tasks: [{ task_id: taskId, updates: { completed: checked } }] })
            .then(function () {
              for (var i = 0; i < _upcomingTasks.length; i++) {
                if (_upcomingTasks[i].task_id === taskId) {
                  _upcomingTasks[i].completed = checked ? 'TRUE' : 'FALSE';
                  break;
                }
              }
              if (row) {
                row.setAttribute('data-save-state', 'saved');
                setTimeout(function () { if (row) row.removeAttribute('data-save-state'); }, 1500);
              }
              // Completing a task here also changes readyToBottle: refetch the dashboard
              // for freshness and refresh the open detail pane. Use listAffecting:false so
              // the dashboard stat cards/chart aren't blanked (WR-01) — freshness comes
              // from loadDashboard() refetching _dashSummary, not from clearing
              // _allBatchesData (#2; this handler had no afterBatchWrite before).
              applyTaskToggleToList(_selectedBatchId, checked);
              if (_selectedBatchId) afterBatchWrite(_selectedBatchId, { listAffecting: false, refreshOpenDetail: true });
              loadDashboard().then(refreshReadyToBottleFilterView);
            })
            .catch(function () {
              cb.checked = !checked;
              if (row) row.classList.toggle('bp-task-row--done', !checked);
              if (row) row.setAttribute('data-save-state', 'error');
              showToast('Save failed \u2014 try again', 'error');
            });
        }, 300);
      });
      detailPane.addEventListener('click', function (e) {
        var removeBtn = e.target.closest('.bp-staging-remove');
        if (removeBtn) {
          var idx = parseInt(removeBtn.getAttribute('data-idx'), 10);
          _detailPlatoStaging.splice(idx, 1);
          var wrap = document.getElementById('bp-detail-staging-wrap');
          if (wrap) {
            wrap.innerHTML = renderDetailStagingTable();
            bindDetailStagingHandlers(_detailBatchId);
          }
          return;
        }

        var delBtn = e.target.closest('.bp-reading-del');
        if (delBtn) {
          var idx = parseInt(delBtn.getAttribute('data-idx'), 10);
          var r = _detailPlatoReadings[idx];
          if (!r) return;
          showConfirmSheet('Delete reading from ' + fmtDate(r.timestamp) + '?', 'Delete', 'bp-confirm-btn--danger', function () {
            adminApiPost('delete_plato_reading', { reading_id: r.reading_id })
              .then(function () {
                _detailPlatoReadings.splice(idx, 1);
                _chartCache = {};
                afterBatchWrite(_detailBatchId, { listAffecting: false }); // bust stale detail snapshot (#23)
                var el = document.getElementById('bp-detail-readings');
                if (el) el.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
                bindDetailReadingHandlers(_detailBatchId);
                showToast('Reading deleted', 'success');
              })
              .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
          });
          return;
        }

        var editBtn = e.target.closest('.bp-reading-edit');
        if (editBtn) {
          var idx = parseInt(editBtn.getAttribute('data-idx'), 10);
          openReadingEditRow(idx);
          return;
        }

        var saveEditBtn = e.target.closest('.bp-reading-save-edit');
        if (saveEditBtn) {
          var idx = parseInt(saveEditBtn.getAttribute('data-idx'), 10);
          var r = _detailPlatoReadings[idx];
          if (!r) return;
          var updates = {};
          var dateVal = (document.getElementById('re-date') || {}).value;
          var platoVal = (document.getElementById('re-plato') || {}).value;
          var tempVal = (document.getElementById('re-temp') || {}).value;
          var phVal = (document.getElementById('re-ph') || {}).value;
          var notesVal = (document.getElementById('re-notes') || {}).value;
          if (dateVal) updates.timestamp = dateVal;
          if (platoVal !== '') updates.degrees_plato = parseFloat(platoVal);
          if (tempVal !== '') updates.temperature = parseFloat(tempVal);
          if (phVal !== '') updates.ph = parseFloat(phVal);
          updates.notes = notesVal;
          adminApiPost('update_plato_reading', { reading_id: r.reading_id, updates: updates })
            .then(function () {
              for (var k in updates) { if (Object.prototype.hasOwnProperty.call(updates, k)) r[k] = updates[k]; }
              _chartCache = {};
              afterBatchWrite(_detailBatchId, { listAffecting: false }); // bust stale detail snapshot (#24)
              var el = document.getElementById('bp-detail-readings');
              if (el) el.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
              bindDetailReadingHandlers(_detailBatchId);
              showToast('Reading updated', 'success');
            })
            .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
          return;
        }

        var cancelEditBtn = e.target.closest('.bp-reading-cancel-edit');
        if (cancelEditBtn) {
          var el = document.getElementById('bp-detail-readings');
          if (el) el.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
          bindDetailReadingHandlers(_detailBatchId);
          return;
        }
      });
    }

    // Recipes panel: row click → detail, search input → re-render
    var recipesInner = document.getElementById('bp-recipes-inner');
    if (recipesInner) {
      recipesInner.addEventListener('click', function (e) {
        var row = e.target.closest('.bp-recipes-row[data-recipe-id]');
        if (row) {
          var recipeId = row.getAttribute('data-recipe-id');
          if (recipeId && typeof openRecipeDetail === 'function') {
            openRecipeDetail(recipeId);
          }
          return;
        }
      });
      recipesInner.addEventListener('input', function (e) {
        if (e.target && e.target.id === 'bp-recipes-search') {
          renderRecipeList();
        }
      });
    }

    // Recipes panel: full panel delegation for editor controls
    var recipesPanel = document.getElementById('bp-panel-recipes');
    if (recipesPanel) {
      recipesPanel.addEventListener('click', function (e) {
        // New Recipe button
        if (e.target && e.target.id === 'bp-recipes-new-btn') {
          openRecipeDetail(null);
          return;
        }
        // Back to list button
        if (e.target && e.target.id === 'bp-recipes-back-btn') {
          showRecipesListView();
          return;
        }
        // Save Recipe button
        if (e.target && e.target.id === 'bp-recipes-save-btn') {
          saveRecipe();
          return;
        }
        // Activate button — sets status to active and saves
        if (e.target && e.target.id === 'bp-recipe-activate') {
          var statusEl = document.getElementById('bp-recipe-status');
          if (statusEl) statusEl.value = 'active';
          saveRecipe();
          return;
        }
        // Delete Recipe button (only shown for existing recipes)
        if (e.target && e.target.id === 'bp-recipe-delete') {
          var rid = _recipesState.currentRecipeId;
          var rname = _recipesState.currentRecipe && _recipesState.currentRecipe.name;
          if (rid) deleteRecipe(rid, rname);
          return;
        }
        // Clone Recipe button (only shown for existing recipes — opens editable draft)
        if (e.target && e.target.id === 'bp-recipe-clone') {
          bpCloneRecipe();
          return;
        }
        // Add Ingredient button
        if (e.target && e.target.id === 'bp-recipes-add-ingredient-btn') {
          addIngredientRow();
          return;
        }
      });

      // Re-evaluate guardrail when locked price changes
      recipesPanel.addEventListener('input', function (e) {
        if (e.target && e.target.id === 'bp-recipe-locked-price') {
          updateActivateGuardrail();
        }
      });
    }
  }

  // ===== Form Saver Registry =====
  // Each saver: { key: string, save: fn -> object|null, restore: fn(data) }
  // save() returns null if there is nothing to save (form not open / no data entered).
  // restore() repopulates DOM fields; uses 150ms setTimeout to let tab/sheet render first.

  // Saver 1: Create-batch form
  _formSavers.push({
    key: 'sv-brewpad-form-draft',
    save: function () {
      var createSheet = document.getElementById('bp-create-sheet');
      if (!createSheet || createSheet.style.display === 'none') return null;
      var formState = {};
      var draftFields = [
        ['bp-new-product-text', 'productText'],
        ['bp-new-product-sku', 'productSku'],
        ['bp-new-product-name', 'productName'],
        ['bp-new-customer-text', 'customerText'],
        ['bp-new-customer-id', 'customerId'],
        ['bp-new-customer-name-hidden', 'customerNameHidden'],
        ['bp-new-customer-firstname-hidden', 'customerFirstnameHidden'],
        ['bp-new-customer-lastname-hidden', 'customerLastnameHidden'],
        ['bp-new-customer-email', 'customerEmail'],
        ['bp-new-start-date', 'startDate'],
        ['bp-new-schedule', 'schedule'],
        ['bp-new-vessel-text', 'vesselText'],
        ['bp-new-vessel', 'vessel'],
        ['bp-new-shelf', 'shelf'],
        ['bp-new-bin', 'bin'],
        ['bp-new-notes', 'notes']
      ];
      var hasData = false;
      for (var i = 0; i < draftFields.length; i++) {
        var el = document.getElementById(draftFields[i][0]);
        if (el && el.value) { formState[draftFields[i][1]] = el.value; hasData = true; }
      }
      return hasData ? formState : null;
    },
    restore: function (draft) {
      switchTab('batches');
      openCreateSheet();
      setTimeout(function () {
        var fields = [
          ['bp-new-product-text', 'productText'],
          ['bp-new-product-sku', 'productSku'],
          ['bp-new-product-name', 'productName'],
          ['bp-new-customer-text', 'customerText'],
          ['bp-new-customer-id', 'customerId'],
          ['bp-new-customer-name-hidden', 'customerNameHidden'],
          ['bp-new-customer-firstname-hidden', 'customerFirstnameHidden'],
          ['bp-new-customer-lastname-hidden', 'customerLastnameHidden'],
          ['bp-new-customer-email', 'customerEmail'],
          ['bp-new-start-date', 'startDate'],
          ['bp-new-schedule', 'schedule'],
          ['bp-new-vessel-text', 'vesselText'],
          ['bp-new-vessel', 'vessel'],
          ['bp-new-shelf', 'shelf'],
          ['bp-new-bin', 'bin'],
          ['bp-new-notes', 'notes']
        ];
        for (var i = 0; i < fields.length; i++) {
          var el = document.getElementById(fields[i][0]);
          if (el && draft[fields[i][1]]) el.value = draft[fields[i][1]];
        }
      }, 150);
    }
  });

  // Saver 2: Multi-batch measurements
  _formSavers.push({
    key: 'sv-brewpad-meas-draft',
    save: function () {
      if (typeof saveMeasGridValues === 'function') saveMeasGridValues();
      var hasEntries = false;
      for (var k in _measMultiData) { if (_measMultiData.hasOwnProperty(k)) { hasEntries = true; break; } }
      if (!hasEntries) return null;
      return { measData: _measMultiData, sharedDate: _measSharedDate || '' };
    },
    restore: function (draft) {
      if (draft.measData) {
        for (var k in draft.measData) {
          if (draft.measData.hasOwnProperty(k)) _measMultiData[k] = draft.measData[k];
        }
      }
      if (draft.sharedDate) _measSharedDate = draft.sharedDate;
    }
  });

  // Saver 3: Batch detail (location + notes)
  _formSavers.push({
    key: 'sv-brewpad-detail-draft',
    save: function () {
      if (!_detailBatchId) return null;
      var vessel = document.getElementById('bp-edit-vessel');
      var shelf = document.getElementById('bp-edit-shelf');
      var bin = document.getElementById('bp-edit-bin');
      var notes = document.getElementById('bp-detail-notes');
      var hasData = false;
      var state = { batchId: _detailBatchId };
      if (vessel && vessel.value) { state.vessel = vessel.value; hasData = true; }
      if (shelf && shelf.value) { state.shelf = shelf.value; hasData = true; }
      if (bin && bin.value) { state.bin = bin.value; hasData = true; }
      if (notes && notes.value) { state.notes = notes.value; hasData = true; }
      return hasData ? state : null;
    },
    restore: function (draft) {
      if (!draft.batchId) return;
      _detailBatchId = draft.batchId;
      setTimeout(function () {
        var vessel = document.getElementById('bp-edit-vessel');
        var shelf = document.getElementById('bp-edit-shelf');
        var bin = document.getElementById('bp-edit-bin');
        var notes = document.getElementById('bp-detail-notes');
        if (vessel && draft.vessel) vessel.value = draft.vessel;
        if (shelf && draft.shelf) shelf.value = draft.shelf;
        if (bin && draft.bin) bin.value = draft.bin;
        if (notes && draft.notes) notes.value = draft.notes;
      }, 150);
    }
  });

  // Saver 4: Single-reading entry in batch detail
  _formSavers.push({
    key: 'sv-brewpad-reading-draft',
    save: function () {
      if (!_detailBatchId) return null;
      var state = { batchId: _detailBatchId };
      var hasData = false;
      var readingFields = [
        ['bp-detail-plato-date', 'platoDate'],
        ['bp-detail-plato-val', 'platoVal'],
        ['bp-detail-plato-temp', 'platoTemp'],
        ['bp-detail-plato-ph', 'platoPh'],
        ['bp-detail-plato-notes', 'platoNotes']
      ];
      for (var i = 0; i < readingFields.length; i++) {
        var el = document.getElementById(readingFields[i][0]);
        if (el && el.value) { state[readingFields[i][1]] = el.value; hasData = true; }
      }
      if (_detailPlatoStaging && _detailPlatoStaging.length > 0) {
        state.staging = _detailPlatoStaging;
        hasData = true;
      }
      return hasData ? state : null;
    },
    restore: function (draft) {
      if (!draft.batchId) return;
      _detailBatchId = draft.batchId;
      if (draft.staging) _detailPlatoStaging = draft.staging;
      setTimeout(function () {
        var fields = [
          ['bp-detail-plato-date', 'platoDate'],
          ['bp-detail-plato-val', 'platoVal'],
          ['bp-detail-plato-temp', 'platoTemp'],
          ['bp-detail-plato-ph', 'platoPh'],
          ['bp-detail-plato-notes', 'platoNotes']
        ];
        for (var i = 0; i < fields.length; i++) {
          var el = document.getElementById(fields[i][0]);
          if (el && draft[fields[i][1]]) el.value = draft[fields[i][1]];
        }
      }, 150);
    }
  });

  // Saver 5: Schedule template editor
  _formSavers.push({
    key: 'sv-brewpad-sched-draft',
    save: function () {
      var schedSheet = document.getElementById('bp-sched-sheet');
      if (!schedSheet || schedSheet.style.display === 'none') return null;
      var state = {};
      var hasData = false;
      var schedFields = [
        ['bp-sched-name', 'name'],
        ['bp-sched-desc', 'desc'],
        ['bp-sched-category', 'category'],
        ['bp-sched-pkg-title', 'pkgTitle'],
        ['bp-sched-pkg-desc', 'pkgDesc']
      ];
      for (var i = 0; i < schedFields.length; i++) {
        var el = document.getElementById(schedFields[i][0]);
        if (el && el.value) { state[schedFields[i][1]] = el.value; hasData = true; }
      }
      if (_schedSteps && _schedSteps.length > 0) {
        state.steps = _schedSteps;
        hasData = true;
      }
      if (typeof _editingScheduleId !== 'undefined' && _editingScheduleId) {
        state.editingId = _editingScheduleId;
      }
      return hasData ? state : null;
    },
    restore: function (draft) {
      switchTab('schedules');
      openSchedSheet(draft.editingId || null);
      setTimeout(function () {
        var fields = [
          ['bp-sched-name', 'name'],
          ['bp-sched-desc', 'desc'],
          ['bp-sched-category', 'category'],
          ['bp-sched-pkg-title', 'pkgTitle'],
          ['bp-sched-pkg-desc', 'pkgDesc']
        ];
        for (var i = 0; i < fields.length; i++) {
          var el = document.getElementById(fields[i][0]);
          if (el && draft[fields[i][1]]) el.value = draft[fields[i][1]];
        }
        if (draft.steps) _schedSteps = draft.steps;
      }, 150);
    }
  });

  // Saver 6: Recipe editor (D-05a). The recipe editor was previously the
  // ONLY major BrewPad form NOT draft-protected -- a failed save (D-05b/c) or
  // a session-expiry/reload could silently lose in-progress recipe edits.
  // save() is also invoked directly from submitRecipeSave's failure branch
  // (saveRecipeDraftNow), not only via this registry's saveAllFormDrafts/
  // session-logout (_enterLoggedOutState) path.
  _formSavers.push({
    key: RECIPE_DRAFT_KEY,
    save: recipeDraftSnapshot,
    restore: function (draft) {
      switchTab('recipes');
      _recipesState.currentRecipeId = draft.recipeId || null;
      _recipesState.currentIngredients = draft.ingredients || [];
      showRecipesDetailView();
      setTimeout(function () {
        populateRecipeForm(draft.formData);
        renderIngredientRows(_recipesState.currentIngredients, null);
      }, 150);
    }
  });

  // ===== Bootstrap =====

  document.addEventListener('DOMContentLoaded', function () {
    // Wire tab bar
    var _batchTabPreloaded = false;
    function triggerBatchPreload() {
      if (_batchTabPreloaded || _batchesLoading) return;
      if (_allBatchesData.length > 0 && Date.now() - _batchesLoadTime < CACHE_TTL_LONG) return;
      _batchTabPreloaded = true;
      adminApiGet('get_batches', { status: 'all' }).then(function (r) {
        _allBatchesData = (r.data && r.data.batches) || [];
        _batchesLoaded = true;
        _batchesLoadTime = Date.now();
      }).catch(function () {});
    }
    Array.prototype.forEach.call(document.querySelectorAll('.bp-tab'), function (btn) {
      btn.addEventListener('click', function () {
        handleTabBarClick(btn.getAttribute('data-tab'));
      });
      // Preload batch data on hover/touch of the batches tab
      if (btn.getAttribute('data-tab') === 'batches') {
        btn.addEventListener('mouseenter', triggerBatchPreload);
        btn.addEventListener('touchstart', triggerBatchPreload, { passive: true });
      }
    });

    initDelegation();

    // waitForGoogleIdentity defined in js/lib/auth.js
    waitForGoogleIdentity(initGoogleAuth);
  });

  // Plan 36-21: export auth helpers for testing initGoogleAuth session-persistence fix.
  // Uses Object.assign so closures can access IIFE-scoped state (accessToken, userEmail).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign(module.exports || {}, {
      _initGoogleAuth: initGoogleAuth,
      _countRecipesUsingScheduleForTest: countRecipesUsingSchedule,
      _bpPopulateRecipeFormForTest: populateRecipeForm,
      _bpReadRecipeFormDataForTest: readRecipeFormData,
      _buildSchedFormForTest: buildSchedForm,
      _deleteScheduleForTest: deleteSchedule,
      _archiveScheduleForTest: archiveSchedule,
      _setFermSchedulesForTest: function (list) { _fermSchedules = list; },
      _setVesselsDataForTest: function (list) { _vesselsData = list; },
      _buildVesselLabelForTest: buildVesselLabel,
      _bindVesselSearchForTest: bindVesselSearch,
      _setRecipesListForTest: function (list) { _recipesState.list = list; },
      _getAccessToken: function () { return accessToken; },
      _setAccessTokenForTest: function (v) { accessToken = v; },
      _getUserEmail:   function () { return userEmail; },
      _checkAuthorization: checkAuthorization,
      // 64-03: test seam for the adminApiGet token-transport regression test --
      // adminApiGet has no other public caller that isolates a single call/response.
      _adminApiGetForTest: adminApiGet,
      // Phase 76-03: parallel seam for adminApiPost (mirrors _adminApiGetForTest).
      _adminApiPostForTest: adminApiPost,
      // Phase 90-03: seams for the invoice search characterization + create-sheet tests.
      _fetchSoSearchForTest: fetchSoSearch,
      _buildCreateFormForTest: buildCreateForm,
      _setAllBatchesDataForTest: function (list) { _allBatchesData = list; },
      _setDetailBatchIdForTest: function (v) { _detailBatchId = v; },
      // Read-retry regression seam: fetchWithRetry retries transient 502/503/504
      // for reads (retryStatuses) but never for writes.
      _fetchWithRetryForTest: fetchWithRetry,
      // Phase 76-03 (D-03): exported so Task 1's regression tests can drive the
      // single global middleware-401 interceptor directly -- under Jest the
      // fetch-wrapper IIFE at the top of this file never runs (module !==
      // undefined guard), so this is the only reachable path to it in tests.
      _handleMiddlewareResponse: _handleMiddlewareResponse,
      // Allow tests to reset IIFE-scoped auth state between runs.
      _resetAuthStateForTest: function () {
        accessToken = null;
        userEmail = null;
        tokenClient = null;
        _googleResumeTimer = null;
        _refreshInFlight = false;
        _sessionLoggedOut = false;
        _lastTokenTime = 0;
      }
    });
  }

  // Phase 36: export state-dependent attach-flow helpers for testing.
  // Uses Object.assign into module.exports so these closures can access IIFE-scoped state.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign(module.exports || {}, {
      buildBpAttachSnapshot: buildBpAttachSnapshot,
      refreshBpStockAdvisory: refreshBpStockAdvisory,
      bpSaveAsNewRecipe: bpSaveAsNewRecipe,
      bpAttachRecipe: bpAttachRecipe,
      // Plan 36-19: pure helpers for recipe list style + clone
      renderRecipeListHtml: renderRecipeListHtml,
      bpCloneRecipePayload: bpCloneRecipePayload,
      // State accessors for testing
      _bpGetTargetVolumeL:       function () { return _bpTargetVolumeL; },
      _bpSetTargetVolumeL:       function (v) { _bpTargetVolumeL = v; },
      _bpGetScaleFactor:         function () { return _bpScaleFactor; },
      _bpSetScaleFactor:         function (v) { _bpScaleFactor = v; },
      _bpGetModifiedIngredients: function () { return _bpModifiedIngredients; },
      _bpSetModifiedIngredients: function (v) { _bpModifiedIngredients = v; },
      _bpGetResolvedRecipe:      function () { return _bpResolvedRecipe; },
      _bpSetResolvedRecipe:      function (v) { _bpResolvedRecipe = v; },
      _bpSetCatalogForTest:      function (v) { _bpAttachCatalog = v || []; },
      // Phase 36-11: test hook to drive wireAttachExpandedPanel for BFAC factor tests
      _bpWireAttachExpandedPanel: function (b, sectionBodyEl) {
        return wireAttachExpandedPanel(b || {}, sectionBodyEl || document.body);
      },
      // Plan 36-22: cache-busting helper — exported from IIFE so it can access state vars
      afterBatchWrite: afterBatchWrite,
      // Phase 69: filter-derivation seam — exported so behavioral tests can drive the
      // readyToBottle re-derive path (CR-01) without a DOM change-event.
      applyBatchFilter: applyBatchFilter,
      selectBatchStatusFilter: selectBatchStatusFilter,
      applyTaskToggleToList: applyTaskToggleToList,
      syncListTaskCounts: syncListTaskCounts,
      // Phase 69: the single readyToBottle intersection that drives BOTH the filter rows
      // AND the count chip (WR-03) — exported so a test can pin that they cannot diverge.
      readyToBottleRows: readyToBottleRows,
      sendBottlingInviteForBatch: sendBottlingInviteForBatch,
      // Test-only: render the batch-detail pane (bottling-invite send-tracking UI).
      _renderBatchDetailForTest: renderBatchDetail,
      _renderBatchListForTest: renderBatchList,
      _openDashDrillForTest: openDashDrill,
      _clearDashDrillForTest: clearDashDrill,
      _renderPullCandidatesForTest: renderPullCandidates,
      _setStaffBatchForTest: setStaffBatch,
      _handleTabBarClickForTest: handleTabBarClick,
      _switchTabForTest: switchTab,
      _initDelegationForTest: initDelegation,
      _loadLinkCandidatesForTest: loadLinkCandidates,
      _linkBatchToInvoiceForTest: linkBatchToInvoice,
      _markBatchSourceForTest: markBatchSource,
      // Phase 80-03: test-only seams for renderWaitlist -- sets the IIFE-scoped
      // _waitlistRows/_waitlistFilter/_waitlistSearch state, then renders into
      // #bp-panel-waitlist so a jsdom test can inspect the resulting markup.
      renderWaitlist: renderWaitlist,
      _setWaitlistStateForTest: function (patch) {
        patch = patch || {};
        if ('rows' in patch) _waitlistRows = patch.rows;
        if ('filter' in patch) _waitlistFilter = patch.filter;
        if ('search' in patch) _waitlistSearch = patch.search;
      },
      // Phase 80-03: test-only seams for the pin/inline-position-editor flow --
      // initDelegation() (which normally wires the click handlers below) only runs
      // from a DOMContentLoaded listener the Jest harness never fires, so tests drive
      // these directly instead.
      _openWaitlistPositionEditForTest: openWaitlistPositionEdit,
      _saveWaitlistPositionForTest: saveWaitlistPosition,
      _clearWaitlistPinForTest: clearWaitlistPin,
      // Phase 80-04: test-only seams for the customer-link panel (D-01/D-02/D-03a) --
      // same rationale as the 80-03 seams above (initDelegation never fires under Jest).
      _openWaitlistLinkPanelForTest: openWaitlistLinkPanel,
      _fetchWaitlistLinkSearchForTest: fetchWaitlistLinkSearch,
      _linkWaitlistCustomerForTest: linkWaitlistCustomer,
      _saveWaitlistNewCustomerForTest: saveWaitlistNewCustomer,
      // Phase 80-04: test-only seams for the recipe multi-select attach flow (D-15/D-16).
      _openWaitlistRecipeAttachPanelForTest: openWaitlistRecipeAttachPanel,
      _attachWaitlistRecipeForTest: attachWaitlistRecipe,
      _removeWaitlistRecipeForTest: removeWaitlistRecipe,
      waitlistResolveRecipeName: waitlistResolveRecipeName,
      _setWaitlistRecipeCatalogForTest: function (v) { _waitlistRecipeCatalog = v; },
      _getWaitlistRecipeCatalogForTest: function () { return _waitlistRecipeCatalog; },
      // Phase 80-05: test-only seam for the Contact review sheet (D-04-D-09) --
      // initDelegation() never fires under Jest, so tests drive the sheet open
      // directly and interact with the real DOM elements it renders.
      _openWaitlistContactSheetForTest: openWaitlistContactSheet,
      // Phase 80-05: test-only seam for the manual-add sheet (D-21-D-25) --
      // same rationale as the Contact sheet seam above.
      _openWaitlistAddSheetForTest: openWaitlistAddSheet,
      // Phase 90-09: seams for the shared recipe dropdown across the four pickers.
      _openRecipeAttachPanelForTest: openRecipeAttachPanel,
      _bindRecipePickerSearchForTest: bindRecipePickerSearch,
      _setProductPickerTabForTest: function (v) { _productPickerTab = v; },
      // Phase 90-09 Task 2: editor name assist / Start from seams.
      _openRecipeDetailForTest: openRecipeDetail,
      _initBpRecipeNameAssistForTest: function () { return initBpRecipeNameAssist(); },
      _bpStartRecipeFromExistingForTest: function (id, name, btn) { return bpStartRecipeFromExisting(id, name, btn); },
      // Plan 36-22: test-only state accessors for the cache-bust state vars
      _renderDashboardForTest: function () { renderDashboard(); },
      _renderDashboardV2ForTest: function () { renderDashboardV2(); },
      _setDashV2ForTest: function (on) { _dashV2On = on === true; },
      _initDashV2FlagForTest: function () { initDashV2Flag(); },
      _setDashV2ChartsForTest: function (m) { _dashV2Charts = m; },
      // Phase 96-04: framework seams (registry + helpers) so tests can mount throwaway widgets.
      _dashV2FrameForTest: {
        widgets: DASH_V2_WIDGETS,
        opts: _dashV2WidgetOpts,
        expanded: _dashV2Expanded,
        opt: dashV2Opt,
        drillAdd: dashV2DrillAdd,
        scaffold: dashV2Widget,
        setControls: dashV2SetControls,
        setNote: dashV2SetNote,
        msg: dashV2Msg,
        openBatch: openDashBatch
      },
      _loadDashboardForTest: function () { return loadDashboard(); },
      _eagerLoadForTest: function () { return eagerLoad(); },
      getStateForTest: function () {
        return {
          _batchesLoaded: _batchesLoaded,
          _allBatchesData: _allBatchesData,
          _eagerLoadTime: _eagerLoadTime,
          _dashLoadTime: _dashLoadTime,
          _preloadBatchId: _preloadBatchId,
          _preloadPromise: _preloadPromise,
          // Phase 69: batch-view filter state so tests can assert re-derive behavior
          _batchStatusFilter: _batchStatusFilter,
          _batchesData: _batchesData,
          _dashSummary: _dashSummary,
          _dashData: _dashData,
          _dashV2State: _dashV2State,
          _dashV2Model: _dashV2Model,
          _dashDrill: _dashDrill,
          _selectedBatchId: _selectedBatchId,
          _batchSearch: _batchSearch,
          _batchProductFilter: _batchProductFilter
        };
      },
      _setStateForTest: function (patch) {
        if ('_batchesLoaded'  in patch) _batchesLoaded  = patch._batchesLoaded;
        if ('_allBatchesData' in patch) _allBatchesData = patch._allBatchesData;
        if ('_eagerLoadTime'  in patch) _eagerLoadTime  = patch._eagerLoadTime;
        if ('_dashLoadTime'   in patch) _dashLoadTime   = patch._dashLoadTime;
        if ('_preloadBatchId' in patch) _preloadBatchId = patch._preloadBatchId;
        if ('_preloadPromise' in patch) _preloadPromise = patch._preloadPromise;
        // Phase 69: batch-view filter state
        if ('_batchStatusFilter' in patch) _batchStatusFilter = patch._batchStatusFilter;
        if ('_batchesData'       in patch) _batchesData       = patch._batchesData;
        if ('_dashSummary'       in patch) _dashSummary       = patch._dashSummary;
        if ('_dashData' in patch) _dashData = patch._dashData;
        if ('_upcomingTasks' in patch) _upcomingTasks = patch._upcomingTasks;
        if ('_upcomingLoaded' in patch) _upcomingLoaded = patch._upcomingLoaded;
        if ('_dashWineSkuLookup' in patch) _dashWineSkuLookup = patch._dashWineSkuLookup;
      },
      // Phase 73-05 (D-05): recipe editor save-resilience test seams.
      saveRecipe: saveRecipe,
      deleteRecipe: deleteRecipe,
      restoreAllFormDrafts: restoreAllFormDrafts,
      renderIngredientRows: renderIngredientRows,
      _getRecipesStateForTest: function () { return _recipesState; },
      _setRecipesStateForTest: function (patch) {
        Object.keys(patch || {}).forEach(function (k) { _recipesState[k] = patch[k]; });
      }
    });
  }

})();

if (typeof module !== 'undefined' && module.exports) {
  // Object.assign preserves Phase 36 state-dependent exports set by the IIFE's inner block
  module.exports = Object.assign(module.exports || {}, {
    escapeHTML: escapeHTML, fmtDate: fmtDate, todayStr: todayStr,
    isOverdue: isOverdue, isToday: isToday,
    filterBatchesByStatus: filterBatchesByStatus,
    filterBatchesByReadyToBottle: filterBatchesByReadyToBottle,
    filterBatchesByUnlinked: filterBatchesByUnlinked,
    isBatchSourceEditable: isBatchSourceEditable,
    shouldShowInternalBadge: shouldShowInternalBadge,
    getCustomerDisplayName: getCustomerDisplayName,
    calcAbv: calcAbv, renderDataGapWarning: renderDataGapWarning,
    isSessionStale: isSessionStale,
    isSessionExpired: isSessionExpired,
    shouldShowKioskBadge: shouldShowKioskBadge,
    computeUnitLabel: computeUnitLabel,
    buildLifecycleTimeline: buildLifecycleTimeline,
    isValidZohoNumber: isValidZohoNumber,
    buildRefreshUpdates: buildRefreshUpdates,
    compareRefreshFields: compareRefreshFields,
    splitCustomerName: splitCustomerName,
    isVersionConflict: isVersionConflict,
    todayPacific: todayPacific,
    fmtShortDate: fmtShortDate,
    isFutureStart: isFutureStart,
    buildCustomerReassignUpdates: buildCustomerReassignUpdates,
    buildPullCandidateRowHtml: buildPullCandidateRowHtml,
    buildBulkCreatePayload: buildBulkCreatePayload,
    summarizeBulkResults: summarizeBulkResults,
    isValidImportNumber: isValidImportNumber,
    resolveBatchType: resolveBatchType,
    buildScheduleCategoryById: buildScheduleCategoryById,
    dayNumber: dayNumber,
    addDays: addDays,
    cycleDays: cycleDays,
    medianOf: medianOf,
    meanOf: meanOf,
    dashboardWindow: dashboardWindow,
    inWindow: inWindow,
    effectiveBatchType: effectiveBatchType,
    toDashRows: toDashRows,
    getDashboardData: getDashboardData,
    weekStartOf: weekStartOf,
    bucketKeyOf: bucketKeyOf,
    bucketLabelOf: bucketLabelOf,
    periodSkeleton: periodSkeleton,
    sourceMatches: sourceMatches,
    batchLitres: batchLitres,
    isStaffRow: isStaffRow,
    windowFromFilters: windowFromFilters,
    previousWindow: previousWindow,
    DASH_FILTER_DEFAULTS: DASH_FILTER_DEFAULTS,
    parseDashHash: parseDashHash,
    sanitizeDashFilters: sanitizeDashFilters,
    buildDashV2Model: buildDashV2Model,
    buildG1Model: buildG1Model,
    buildG2Model: buildG2Model,
    buildG3Model: buildG3Model,
    dashP95: dashP95,
    DASH_G4_DIMS: DASH_G4_DIMS,
    DASH_SOURCE_CATS: DASH_SOURCE_CATS,
    dashSourceCat: dashSourceCat,
    buildG4Model: buildG4Model,
    buildTop10Model: buildTop10Model,
    buildG9Model: buildG9Model,
    DASH_PIPELINE_STAGES: DASH_PIPELINE_STAGES,
    resolveDashFilters: resolveDashFilters,
    serializeDashFilters: serializeDashFilters,
    dashV2FlagFrom: dashV2FlagFrom,
    dashPeriodLabel: dashPeriodLabel,
    dashFilterSummary: dashFilterSummary,
    countNonDefaultFilters: countNonDefaultFilters,
    formatDelta: formatDelta,
    dashDrillLabel: dashDrillLabel,
    mergeWineSkuLookup: mergeWineSkuLookup,
    wineBreakdownBuckets: wineBreakdownBuckets,
    dashDrillSubject: dashDrillSubject,
    dashClassifyRows: dashClassifyRows,
    dashTaskKind: dashTaskKind,
    buildG5Model: buildG5Model,
    buildG7Model: buildG7Model,
    buildG6Model: buildG6Model,
    buildG8Model: buildG8Model,
    buildG10Model: buildG10Model,
    DASH_HEALTH_CATS: DASH_HEALTH_CATS,
    DASH_VESSEL_TYPE_ORDER: DASH_VESSEL_TYPE_ORDER,
    DASH_TASK_KINDS: DASH_TASK_KINDS,
    dashBreakdownBuckets: dashBreakdownBuckets,
    dashSegHtml: dashSegHtml,
    dashSelectHtml: dashSelectHtml,
    dashViewToggleHtml: dashViewToggleHtml,
    dashTableHtml: dashTableHtml,
    dashListHtml: dashListHtml,
    loadChartJs: loadChartJs,
    readChartTheme: readChartTheme,
    chart: chart,
    _loadChartJsForTest: loadChartJs,
    _chartForTest: chart,
    _resetChartJsForTest: function () { _chartJsPromise = null; _chartTheme = null; },
    filterBatchesByNeedsType: filterBatchesByNeedsType,
    bucketBatchesByMonthType: bucketBatchesByMonthType,
    buildSkuLookup: buildSkuLookup,
    normalizeWineTime: normalizeWineTime,
    bucketWineDimension: bucketWineDimension,
    applyTopN: applyTopN,
    filterRecipesByName: filterRecipesByName,
    recipeRowPrice: recipeRowPrice,
    enrichIngredientsWithCatalogRates: enrichIngredientsWithCatalogRates,
    canActivateRecipe: canActivateRecipe,
    buildRecipePayload: buildRecipePayload,
    recipeDeleteConfirmMessage: recipeDeleteConfirmMessage,
    // Phase 36: pure top-level scaling helper (mirrors lib/recipe-scaling.js)
    bpScaleIngredients: bpScaleIngredients,
    // Phase 73-07: unit-aware editor cost helper (mirrors lib/recipe-scaling.js, CR-02)
    bpIngredientLineCost: bpIngredientLineCost,
    bpClassifyUnit: bpClassifyUnit,
    unitOptionsFor: unitOptionsFor,
    // Phase 78-03: pure waitlist helpers (ordering, queue positions, one-way status
    // cycle, filtering, sync normalization, category suppression).
    WAITLIST_STATUS_ORDER: WAITLIST_STATUS_ORDER,
    WAITLIST_STATUS_LABELS: WAITLIST_STATUS_LABELS,
    WAITLIST_STATUS_COLORS: WAITLIST_STATUS_COLORS,
    nextWaitlistStatus: nextWaitlistStatus,
    isWaitlistSynced: isWaitlistSynced,
    sortWaitlistRows: sortWaitlistRows,
    computeWaitlistQueuePositions: computeWaitlistQueuePositions,
    filterWaitlistRows: filterWaitlistRows,
    shouldShowWaitlistCategoryColumn: shouldShowWaitlistCategoryColumn,
    // Phase 80-03 (D-10-D-14): position-aware merge-insert helper.
    parseWaitlistPosition: parseWaitlistPosition,
    // Phase 80-03 (D-15/D-16): client-side recipe_ids parser (display-only chips).
    parseWaitlistRecipeIds: parseWaitlistRecipeIds
    // Plan 36-19: renderRecipeListHtml + bpCloneRecipePayload exported by the IIFE inner block above
    // Plan 36-22: afterBatchWrite + getStateForTest exported by the IIFE inner block above
    // State-dependent attach-flow exports are merged by Object.assign inside the IIFE above
  });
}
