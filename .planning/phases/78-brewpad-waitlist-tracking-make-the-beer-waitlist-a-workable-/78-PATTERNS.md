# Phase 78: BrewPad Waitlist Tracking — Pattern Map

**Mapped:** 2026-09-02
**Files analyzed:** 8 (6 source + 2 test)
**Analogs found:** 8 / 8

## Build/Test Conventions Constraining These Files

- `js/brewpad.js` is **standalone** — it is NOT one of the numbered `js/modules/*` files concatenated into `js/main.js`/`js/main.min.js` by `npm run build`. It is served directly (`<script src="js/brewpad.js">` in `brewpad.html`). Editing it directly is correct; `npm run build` is not required for this file. Contrast: `js/modules/12-checkout.js` and `js/modules/13-init.js` (the live/dead waitlist-form call sites, out of scope for rewrite this phase) ARE build inputs — never edit `js/main.js`/`js/main.min.js` directly if either of those two needs a touch.
- `apps-script/adminApi.gs` has **no CI deploy path**. Any change requires a manual owner redeploy of the single Web App deployment that serves both staging and production simultaneously (no staging gate at this layer). Plans must include an explicit `user_setup`/`checkpoint:human-verify` task for this, sequenced before/alongside any middleware deploy that depends on the new actions (Pitfall 2/3 in RESEARCH.md).
- `zoho-middleware/**` auto-deploys to Railway on `git push origin main` (staging) / `git push production main --force` (prod). Ordinary CLAUDE.md test/lint gates apply: `cd zoho-middleware && npm test` before commit.
- `css/brewpad.css` is self-contained — "no dependency on admin.css or styles.css" (line 2). All new rules are additive; do not introduce Tailwind/shadcn/a component library (none exists in this stack).
- CSP: `brewpad.html` is staff-only, not a public page — no CSP `<meta>` update needed for this phase (per UI-SPEC.md's CSP Note).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps-script/adminApi.gs` — `Waitlist` sheet constant | config | CRUD | `GIFT_CARD_TRANSACTIONS_SHEET_NAME` const (`:60`) | exact |
| `apps-script/adminApi.gs` — `ensureWaitlistSheet()` / `setupWaitlist()` | model / migration | CRUD (bootstrap) | `ensureGiftCardLedgerSheet()` / `setupGiftCardLedger()` (`:4114-4121`, `:4262-4294`) | exact |
| `apps-script/adminApi.gs` — `waitlistDedupeDecision(rows, email, category)` | utility (pure) | transform | `giftCardLedgerDecision()` (`:4188-4245`) | exact |
| `apps-script/adminApi.gs` — `addWaitlistEntry(payload)` | controller (write handler) | CRUD (append) | `addReservation()` (`:910-949`) — plain append, no lock | exact |
| `apps-script/adminApi.gs` — `updateWaitlistStatus(payload)` | controller (write handler) | CRUD (mutate) | `voidGiftCard()` (`:4738-4775`) shape, **without** the lock (see Shared Patterns → No-Lock) | role-match |
| `apps-script/adminApi.gs` — `getWaitlist()` | controller (read handler) | CRUD (list) | `getGiftCards()` (`:4807-4822`) | exact |
| `apps-script/adminApi.gs` — `doPost()` server_token block routing | route (dispatch) | request-response | existing `if (action === 'void_gift_card') …` chain (`:299-320`) | exact |
| `apps-script/adminApi.gs` — `handleReadAction()` switch routing | route (dispatch) | request-response | existing `case 'get_gift_cards': …` (`:228-229`) | exact |
| `zoho-middleware/server.js` — `POST /api/waitlist` blocking sheet write | controller (route handler) | request-response (blocking) | `callAppsScript()` in `zoho-middleware/routes/gift-cards.js` (`:23-39`) | exact (pattern), file itself has no analog in `server.js` |
| `zoho-middleware/server.js` — MailerLite call demoted to fire-and-forget | service call | event-driven (fire-and-forget) | staff-notification email at `server.js:225-227` (same file, same shape) | exact |
| `zoho-middleware/routes/pos.js` — `ADMIN_PROXY_ACTIONS` / `ADMIN_PROXY_READS` new entries | config (whitelist) | request-response | existing `get_batches`/`update_batch` entries (`:3990-4024`) | exact |
| `js/brewpad.js` — waitlist panel render/load/status functions | component | CRUD (list + status transitions) | Tasks panel (`loadTasks()`/toolbar, `:7662-7842`) for list shape; batch-status tap-to-cycle (`:5690-5714`) for status transitions | exact (composite) |
| `js/brewpad.js` — `switchTab()` extension | route (client-side tab dispatch) | request-response | existing `panels` array + else-if chain (`:2302-2340`) | exact |
| `brewpad.html` — 6th tab button + `#bp-panel-waitlist` | component (markup) | — | existing 5 `.bp-tab` buttons + `#bp-panel-*` sections (`:288-309`, `:62-153`) | exact |
| `css/brewpad.css` — additive rules (sync badge variant, if any beyond reuse) | config (styles) | — | `.bp-kiosk-badge` (`:424-435`), `.bp-status-badge--*` (`:412-421`) | exact |
| `zoho-middleware/__tests__/waitlist-route.test.js` (new) | test | request-response | `zoho-middleware/__tests__/checkout-captured-amount.test.js` (server-boot mock harness, since `/api/waitlist` lives in `server.js` not a router file) + `gift-cards.test.js` (axios-mock pattern) | exact (composite) |
| `tests/frontend/adminapi-waitlist-pure.test.js` (new) | test | transform | `tests/frontend/adminapi-giftcard-ledger.test.js` (source-extraction `new Function` harness) | exact |

## Pattern Assignments

### `apps-script/adminApi.gs` — sheet constant + bootstrap (`ensureWaitlistSheet`/`setupWaitlist`)

**Analog:** `ensureGiftCardLedgerSheet()` / `setupGiftCardLedger()`

**Sheet-name constant block** (`adminApi.gs:46-60`) — add `var WAITLIST_SHEET_NAME = 'Waitlist';` alongside the existing block:
```javascript
var CONFIG_SHEET_NAME = 'Config';
var RESERVATIONS_SHEET_NAME = 'Reservations';
...
var GIFT_CARDS_SHEET_NAME = 'GiftCards';
var GIFT_CARD_TRANSACTIONS_SHEET_NAME = 'GiftCardTransactions';
```

**Idempotent bootstrap** (`adminApi.gs:4262-4294`) — copy this shape exactly, self-healing on missing tab, **fail-closed** (never repair headers, never fall back to a positional write) on drifted columns:
```javascript
function ensureGiftCardLedgerSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(GIFT_CARD_TRANSACTIONS_SHEET_NAME);

  var headerNames = [
    'tx_id', 'cert_number', 'tx_ref', 'kind', 'amount', 'balance_before',
    'balance_after', 'status', 'needs_manual_review', 'created_at', 'settled_at', 'notes'
  ];

  if (!sheet) {
    sheet = ss.insertSheet(GIFT_CARD_TRANSACTIONS_SHEET_NAME);
    sheet.appendRow(headerNames);
    sheet.getRange(1, 1, 1, headerNames.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('Created GiftCardTransactions tab with ' + headerNames.length + ' columns');
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  var missing = [];
  for (var i = 0; i < headerNames.length; i++) {
    var name = headerNames[i];
    var idx = headers.indexOf(name) + 1;
    col[name] = idx;
    if (idx === 0) missing.push(name);
  }

  if (missing.length > 0) {
    return { ok: false, error: 'ledger_unavailable', missing: missing };
  }

  return { ok: true, sheet: sheet, headers: headers, col: col };
}
```
For `Waitlist`, the header set should represent (per CONTEXT.md D-02/D-05/D-07/D-08 + RESEARCH.md Open Question 2's recommendation): `id` (generated, column A — mirrors `Utilities.getUuid()` used for `tx_id`, NOT the customer email, so `findRowById` stays a safe column-A key even once D-02's multi-category future lands), `email`, `category`, `status`, `signed_up_at`, `mailerlite_synced`, `notes`.

**Owner-run setup wrapper** (`adminApi.gs:4114-4121`):
```javascript
function setupGiftCardLedger() {
  var result = ensureGiftCardLedgerSheet();
  if (result.ok) {
    Logger.log('GiftCardTransactions tab ready (12 columns).');
  } else {
    Logger.log('GiftCardTransactions tab is missing required columns: ' + result.missing.join(', '));
  }
}
```

---

### `apps-script/adminApi.gs` — `waitlistDedupeDecision` (D-06 idempotency, pure function)

**Analog:** `giftCardLedgerDecision()` (`adminApi.gs:4188-4245`) and its normalize helper `normalizeCertNumber()` (`:4136-4139`)

**Critical constraint:** must be **strictly pure** — no `SpreadsheetApp`/`LockService`/`Session`/`CacheService`/`Logger` reference anywhere in the body, and no reliance on module-level mutable state (`_sheetCache`). This is what makes it unit-testable via the `new Function` extraction harness (see Testing section below). The 51-suite enforces this on the gift-card decision by asserting on the raw source text — a `waitlistDedupeDecision` test file should do the same.
```javascript
function normalizeCertNumber(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}
```
Mirror this exact shape for `normalizeEmail(value)` (trim + lowercase, not uppercase — emails are case-insensitive but conventionally lowercased). `waitlistDedupeDecision(rows, email, category)` loops `rows` once, matches on normalized `email` + `category`, and returns `{action: 'existing'|'new', row: Object|null}` — proportionate to a non-money list. **Do NOT** copy `appendGiftCardClaim`/`settleGiftCardClaim`/`flagGiftCardClaim`'s three-step claim-before-mutate ceremony (Anti-Pattern in RESEARCH.md) — that exists to survive a crash mid-money-movement, which a waitlist signup is not.

---

### `apps-script/adminApi.gs` — `addWaitlistEntry(payload)` (write handler, append)

**Analog:** `addReservation()` (`adminApi.gs:910-949`) — the correct rigor level: **no `acquireScriptLock`**, plain `sheet.appendRow(...)`, `sanitizeInput()` on every free-text field.
```javascript
function addReservation(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RESERVATIONS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };
  ...
  sheet.appendRow([
    reservationId,
    sanitizeInput(payload.customer_name || ''),
    sanitizeInput(payload.customer_email || ''),
    ...
  ]);

  return { ok: true, reservation_id: reservationId };
}
```
`addWaitlistEntry` should: call `ensureWaitlistSheet()` first (fail closed if `{ok:false}`), read existing rows via `sheetToObjects(WAITLIST_SHEET_NAME)`, run `waitlistDedupeDecision(rows, email, category)` — on `'existing'`, return the SAME generic success shape as a new row (D-06: never disclose membership in the response), on `'new'`, `appendRow` with `Utilities.getUuid()` as `id`, sanitized `email`/`category`/`notes`, `status: 'waiting'`, `signed_up_at: new Date().toISOString()`, `mailerlite_synced: false`.

---

### `apps-script/adminApi.gs` — `updateWaitlistStatus(payload)` (write handler, mutate)

**Analog:** `voidGiftCard()` (`adminApi.gs:4738-4775`) for the **lookup-then-setValue shape only** — see Shared Patterns → "No Lock Needed" below for why the lock itself must NOT be copied:
```javascript
function voidGiftCard(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  ...
  var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
  if (result.row === -1) return { ok: false, error: 'not_found' };
  ...
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var statusCol = headers.indexOf('status') + 1;
  ...
  sheet.getRange(result.row, statusCol).setValue('void');
  ...
  invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
  return { ok: true, status: 'void' };
}
```
`findRowById` (`adminApi.gs:1473-`) matches on **column A only** — since `id` is column A for `Waitlist` (per the schema decision above), `updateWaitlistStatus(payload)` with `{id, status}` can use `findRowById(WAITLIST_SHEET_NAME, id)` directly. Resolve `status`/`notes`/`mailerlite_synced` column indices at runtime via `headers.indexOf(name) + 1` (never hardcode column letters — every handler in this file does this specifically so staff reordering columns doesn't silently corrupt writes). Call `invalidateSheetCache(WAITLIST_SHEET_NAME)` after the write. **Skip** `acquireScriptLock()` entirely (see Shared Patterns).

---

### `apps-script/adminApi.gs` — `getWaitlist()` (read handler)

**Analog:** `getGiftCards()` (`adminApi.gs:4807-4822`) — plain `sheetToObjects()` scan, explicit field allowlist in the map, **no `_cachedGet` wrapper**:
```javascript
function getGiftCards() {
  var cards = sheetToObjects(GIFT_CARDS_SHEET_NAME);
  return cards.map(function(gc) {
    return {
      cert_number: gc.cert_number,
      face_value: parseFloat(gc.face_value) || 0,
      current_balance: parseFloat(gc.current_balance) || 0,
      status: gc.status,
      issued_date: gc.issued_date,
      issued_by: gc.issued_by,
      zoho_invoice_number: gc.zoho_invoice_number,
      notes: gc.notes,
      last_updated: gc.last_updated
    };
  });
}
```
`getWaitlist()` should return every row via `sheetToObjects(WAITLIST_SHEET_NAME)` mapped to the field allowlist (`id`, `email`, `category`, `status`, `signed_up_at`, `mailerlite_synced`, `notes`, `_row` is stripped by the explicit map — matches `getGiftCards`' convention of never leaking `_row` to the client). **Do not** wrap in `_cachedGet` — `get_gift_cards` deliberately skips the cache layer for a low-volume staff list (Anti-Pattern in RESEARCH.md, sidesteps the Phase 69 stale-cache bug class).

---

### `apps-script/adminApi.gs` — dispatch wiring

**doPost server_token block** (`adminApi.gs:299-320`) — add three `if (action === '...')` branches inside the existing `if (payload.server_token) { ... }` block, following the exact style of the gift-card block immediately above them:
```javascript
if (action === 'void_gift_card') {
  return _jsonResponse(voidGiftCard(payload));
}
if (action === 'update_gift_card_invoice') {
  return _jsonResponse(updateGiftCardInvoice(payload));
}
```
Add: `add_waitlist_entry` → `addWaitlistEntry(payload)`, `update_waitlist_status` → `updateWaitlistStatus(payload)`.

**handleReadAction switch** (`adminApi.gs:227-229`):
```javascript
// Gift card admin list (D-06 list action for admin view)
case 'get_gift_cards':
  return { ok: true, data: getGiftCards() };
```
Add: `case 'get_waitlist': return { ok: true, data: getWaitlist() };`

---

### `zoho-middleware/server.js` — `POST /api/waitlist` (blocking sheet write + demoted MailerLite)

**Current handler** (`server.js:211-232`, full function, this is what gets modified):
```javascript
app.post('/api/waitlist', waitlistLimiter, async function (req, res) {
  var email = (req.body.email || '').trim();
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Valid email is required' });

  if (!mailerlite.isConfigured()) {
    console.error('[waitlist] MAILERLITE_API_KEY not set — cannot add subscriber');
    return res.status(503).json({ error: 'Waitlist is temporarily unavailable' });
  }

  try {
    var groupId = (process.env.MAILERLITE_WAITLIST_GROUP_ID || '').trim();
    await mailerlite.addSubscriber(email, groupId ? [groupId] : []);
    // Fire-and-forget staff heads-up — must not block or fail the signup.
    mailer.sendWaitlistNotification({ email: email })
      .catch(function (err) { console.error('[waitlist] staff notify failed:', err.message); });
    res.json({ success: true });
  } catch (err) {
    console.error('[waitlist] MailerLite subscribe failed:', err.message);
    res.status(500).json({ error: 'Could not join waitlist. Please try again.' });
  }
});
```

**Blocking-call pattern to copy** — `callAppsScript()` from `zoho-middleware/routes/gift-cards.js:23-39` (server.js does NOT currently `require('axios')` — this needs adding at the top of the file, per RESEARCH.md's explicit note):
```javascript
function callAppsScript(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;

  var body = Object.assign({}, payload, {
    action: action,
    server_token: token
  });

  return axios.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 12000,
    maxRedirects: 5
  }).then(function (resp) {
    return resp.data || {};
  });
}
```
`gift-cards.js`/`recipes.js`/`pos-recipe.js` each carry their own private copy of this helper — there is no shared `lib/apps-script.js`. RESEARCH.md's judgment call (A2): a fourth local copy in `server.js` is the in-scope choice; do not extract a shared helper as part of this phase (CLAUDE.md rule 3 — don't touch unrelated code).

**Fire-and-forget pattern (unchanged, MailerLite demoted to this shape)** — the existing staff-notification email at `server.js:225-227` is the exact model:
```javascript
mailer.sendWaitlistNotification({ email: email })
  .catch(function (err) { console.error('[waitlist] staff notify failed:', err.message); });
```

**Planner note (from CONTEXT.md, load-bearing):** the current 503-on-`!mailerlite.isConfigured()` guard must be **moved to gate on the sheet-write call failing**, not deleted — the endpoint must still fail closed (503) when it cannot record, but a MailerLite outage alone must no longer 503.

**Write-retry constraint:** do NOT wrap the `callAppsScript('add_waitlist_entry', ...)` call in any retry loop — a duplicate submission is made harmless by D-06's idempotency, but that is not license to auto-retry a write whose outcome is unknown (Pitfall 4 in RESEARCH.md — a non-JSON HTML error response may mean the write already happened).

---

### `zoho-middleware/routes/pos.js` — admin-proxy whitelists

**Analog:** the existing two-object gate (`pos.js:3990-4024`), full excerpt (this is the exact block both new entries land in):
```javascript
var ADMIN_PROXY_ACTIONS = {
  // reads
  get_batch: true,
  get_batches: true,
  get_batch_dashboard_summary: true,
  get_vessels: true,
  get_ferm_schedules: true,
  get_tasks_upcoming: true,
  // writes
  create_batch: true,
  update_batch: true,
  update_batch_schedule: true,
  delete_batch: true,
  bulk_add_plato_readings: true,
  bulk_update_batch_tasks: true,
  update_plato_reading: true,
  delete_plato_reading: true,
  create_ferm_schedule: true,
  update_ferm_schedule: true,
  delete_ferm_schedule: true
};

var ADMIN_PROXY_READS = {
  get_batch: true,
  get_batches: true,
  get_batch_dashboard_summary: true,
  get_vessels: true,
  get_ferm_schedules: true,
  get_tasks_upcoming: true
};
```
Add `get_waitlist: true` to **BOTH** objects (it's a read — must be in `ADMIN_PROXY_READS` too, so it's forwarded as a GET rather than falling through `doPost`'s server_token if-chain to `invalid_action`, per the hotfix note at `pos.js:4012-4016`). Add `update_waitlist_status: true` to `ADMIN_PROXY_ACTIONS` **only** (it's a write). This is Pitfall 1 in RESEARCH.md — forgetting either half produces a clean `400 invalid_action` that looks like a bug but is just a missed whitelist entry.

The router handler itself (`pos.js:4026-4064`) needs **no changes** — it already branches read-vs-write via `ADMIN_PROXY_READS[action]` and forwards with `maxRedirects: 5`:
```javascript
var upstream = ADMIN_PROXY_READS[action]
  ? axios.get(process.env.APPS_SCRIPT_URL, { params: payload, timeout: 15000, maxRedirects: 5 })
  : axios.post(process.env.APPS_SCRIPT_URL, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 5
    });
```

---

### `js/brewpad.js` — `switchTab()` extension

**Analog:** existing function, full excerpt (`brewpad.js:2302-2340`):
```javascript
function switchTab(tab) {
  _activeTab = tab;
  if (_batchSearchTimer) { clearTimeout(_batchSearchTimer); _batchSearchTimer = null; }

  Array.prototype.forEach.call(document.querySelectorAll('.bp-tab'), function (btn) {
    var isActive = btn.getAttribute('data-tab') === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  var panels = ['dashboard', 'batches', 'tasks', 'measurements', 'recipes'];
  panels.forEach(function (p) {
    var el = document.getElementById('bp-panel-' + p);
    if (el) el.style.display = (p === tab) ? '' : 'none';
  });

  var now = Date.now();
  if (tab === 'dashboard') {
    if (now - _dashLoadTime > CACHE_TTL_LONG) loadDashboard();
  } else if (tab === 'batches') {
    ...
  } else if (tab === 'tasks') {
    loadTasks();
  } else if (tab === 'measurements') {
    loadMeasurementBatches();
  } else if (tab === 'recipes') {
    initRecipesTab();
  }
}
```
Add `'waitlist'` to the `panels` array and an `else if (tab === 'waitlist') { loadWaitlist(); }` branch (or similar, following the same cache-freshness gate as `dashboard` if the panel should avoid refetching on every tab switch — Tasks/Recipes reload unconditionally on every switch, which is the simpler and probably correct choice here given low data volume).

---

### `js/brewpad.js` — `adminApiGet`/`adminApiPost` (reused as-is, zero changes)

**Read-retry / write-no-retry asymmetry** (`brewpad.js:1518-1590`, full excerpt of all three functions):
```javascript
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
    if (retries > 0) return backoffRetry();
    throw err;
  });
}

function adminApiGet(action, params) {
  var body = { action: action };
  if (params) Object.keys(params).forEach(function (key) { body[key] = params[key]; });
  // Reads are idempotent: retry twice on transient 502/503/504 (Apps-Script cold-start).
  return fetchWithRetry(mwUrl() + '/api/batch/admin-proxy', {
    method: 'POST', credentials: 'include',
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
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || !data || !data.ok) {
          throw new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
        }
        return data;
      });
    });
}
```
Note `adminApiPost` calls `fetchWithRetry` with NO 3rd/4th argument — `retries` defaults to `1` (network-rejection-only retry), `retryStatuses` is `undefined` so an actual 502/503/504 HTTP response is never retried. This IS the write-retry-must-not-happen rule already implemented — no code change needed here, just call these two helpers as-is: `adminApiGet('get_waitlist')` and `adminApiPost('update_waitlist_status', { id: row.id, status: 'contacted' })`.

---

### `js/brewpad.js` — status tap-to-cycle (with the ONE deliberate deviation UI-SPEC.md calls out)

**Analog:** batch-status cycle handler (`brewpad.js:5690-5714`):
```javascript
var order = ['primary', 'secondary', 'complete'];
var idx = order.indexOf(cur);
var next = order[(idx + 1) % order.length];
showConfirmSheet(
  'Move ' + b.batch_id + ' to “' + (STATUS_LABELS[next] || next) + '”?',
  'Confirm', 'bp-confirm-btn--primary',
  function () {
    adminApiPost('update_batch', { batch_id: b.batch_id, updates: { status: next } })
      .then(function () {
        b.status = next;
        statusBadge.textContent = STATUS_LABELS[next] || next;
        statusBadge.className = 'bp-status-badge bp-status-badge--' + (STATUS_COLORS[next] || 'info') + ' bp-status-clickable';
        statusBadge.setAttribute('aria-label', 'Batch status: ' + (STATUS_LABELS[next] || next) + '. Click to change.');
        showToast('Status updated', 'success');
        ...
      }).catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  }
);
```
Const objects to mirror (`brewpad.js:3857-3858`):
```javascript
var STATUS_LABELS = { primary: 'Primary', secondary: 'Secondary', complete: 'Complete', active: 'Active', packaging: 'Packaging', pending: 'Pending' };
var STATUS_COLORS = { primary: 'info', secondary: 'warning', complete: 'success', active: 'info', packaging: 'warning', pending: 'neutral' };
```
**MANDATORY deviation (UI-SPEC.md Phase-Specific Decision 2, correctness-driven, not style):** the batch cycle is a true loop via `% order.length`. The waitlist cycle is **one-way**: `order = ['waiting', 'contacted', 'booked']`; when `cur === 'booked'`, the tap handler must be a no-op (return early — no confirm sheet, no write, no toast). Do **not** apply `% order.length` wraparound — that would silently reopen a booked customer's spot. `removed` is reached only via the separate danger-styled Remove `×` button (`.bp-reading-del`'s visual treatment, `css/brewpad.css` near `:1476-1481`), never via the tap-to-cycle badge.

---

### `js/brewpad.js` — `showConfirmSheet()` (reused verbatim, zero changes)

**Full function** (`brewpad.js:4308-4343`):
```javascript
function showConfirmSheet(message, okLabel, okCls, onOk) {
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
  document.getElementById('bp-confirm-sheet-msg').textContent = message;
  var okBtn = document.getElementById('bp-confirm-sheet-ok');
  okBtn.textContent = okLabel;
  okBtn.className = 'btn ' + (okCls || '');
  ...
  sheet.classList.add('bp-confirm-sheet--visible');
}
```
Call this unchanged for BOTH the status-advance confirm (`bp-confirm-btn--primary`) and the Remove confirm (`bp-confirm-btn--danger`) per UI-SPEC.md's Copywriting Contract.

---

### `js/brewpad.js` — inline notes editor

**Analog:** `openReadingEditRow()` (`brewpad.js:6644-6666`), full excerpt:
```javascript
function openReadingEditRow(idx) {
  var r = _detailPlatoReadings[idx];
  if (!r) return;
  var tbody = document.querySelector('#bp-detail-readings tbody');
  if (!tbody) return;
  var rowPos = _detailPlatoReadings.length - 1 - idx;
  var rows = tbody.querySelectorAll('tr');
  var rowEl = rows[rowPos];
  if (!rowEl) return;
  rowEl.className = 'bp-reading-edit-row';
  rowEl.innerHTML =
    '<td><input class="bp-inline-input" id="re-date" type="date" value="' + escapeHTML(...) + '" style="width:110px;"></td>' +
    ...
    '<td class="bp-reading-actions">' +
    '<button class="btn bp-btn-sm bp-reading-save-edit" data-idx="' + idx + '">Save</button>' +
    '<button class="bp-reading-cancel-edit btn-secondary bp-btn-sm" data-idx="' + idx + '">×</button>' +
    '</td>';
}
```
Copy the row-becomes-input shape for the `notes` cell: replace the rendered `<td>` with `<input class="bp-inline-input" ...>` + `Save`/`×` buttons (`btn bp-btn-sm` / `btn-secondary bp-btn-sm`), collapsing back to rendered (possibly-truncated) text on save/cancel. Always sanitize on the SERVER side via `sanitizeInput()` in `updateWaitlistStatus`/a dedicated `updateWaitlistNotes` handler — the client input is not itself a trust boundary.

---

### `js/brewpad.js` — Tasks toolbar (search + filter chips shape for the waitlist toolbar)

**Analog:** `loadTasks()` render fragment (`brewpad.js:7752-7768`):
```javascript
var html = '<div class="bp-tasks-toolbar">';
html += '<input type="search" class="bp-search-input" id="bp-task-search" placeholder="Search tasks…" value="' + escapeHTML(_taskSearch) + '" autocomplete="off" inputmode="search">';
html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-tasks-refresh">↻ Refresh</button>';
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
```
Mirror this shape exactly for the waitlist panel: `bp-search-input` placeholder `"Search email…"` per UI-SPEC.md, and a `.bp-batch-filters`/`.bp-filter-btn` row for the **All · Waiting · Contacted · Booked · Removed · Not Synced** chips (UI-SPEC.md's `.bp-batch-filters` class is the closer citation for this one, `css/brewpad.css:545-570`, functionally identical CSS to `.bp-task-filters`).

---

### `brewpad.html` — 6th tab + panel markup

**Tab bar** (`brewpad.html:288-310`), full excerpt — 5 existing buttons shown, add a 6th following the identical shape:
```html
<nav class="bp-tab-bar" aria-label="Main navigation">
  <button type="button" class="bp-tab active" data-tab="dashboard" aria-label="Dashboard" aria-pressed="true">
    <span class="bp-tab-icon" aria-hidden="true">&#127968;</span>
    <span class="bp-tab-label">Dashboard</span>
  </button>
  ...
  <button type="button" class="bp-tab" data-tab="recipes" aria-label="Recipes" aria-pressed="false">
    <span class="bp-tab-icon" aria-hidden="true">&#128221;</span>
    <span class="bp-tab-label">Recipes</span>
  </button>
</nav>
```
Add: `<button type="button" class="bp-tab" data-tab="waitlist" aria-label="Waitlist" aria-pressed="false"><span class="bp-tab-icon" aria-hidden="true">&#128203;</span><span class="bp-tab-label">Waitlist</span></button>` (UI-SPEC.md's specified icon/copy).

**Panel section markers** (`brewpad.html:62-153`) — each panel is `<div id="bp-panel-{tab}" class="bp-panel" style="display:none;">…</div>` inside `.bp-panels` (`:62`), e.g. `:139` `bp-panel-tasks`, `:146` `bp-panel-measurements`. Add `<div id="bp-panel-waitlist" class="bp-panel" style="display:none;">…</div>` following the same shape — single-pane table per UI-SPEC.md Decision 1 (no list/detail split like Batches).

---

### `css/brewpad.css` — reused classes (verbatim, per UI-SPEC.md Component Inventory)

No new spacing/typography tokens — every value below is copied from an existing rule, not invented:

**Status badge** (`:403-421`):
```css
.bp-status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.bp-status-badge--success { background: var(--batch-success-bg); color: var(--batch-success); }
.bp-status-badge--warning { background: var(--batch-warning-bg); color: var(--batch-warning); }
.bp-status-badge--danger  { background: var(--batch-danger-bg);  color: var(--batch-danger);  }
.bp-status-badge--info    { background: var(--batch-info-bg);    color: var(--batch-info);    }
.bp-status-badge--neutral { background: rgba(154, 134, 114, 0.10); color: var(--ink-secondary); }
.bp-status-clickable { cursor: pointer; }
.bp-status-clickable:hover { opacity: 0.8; }
```
Map: `waiting`→`--neutral`, `contacted`→`--warning`, `booked`→`--success`, `removed`→`--danger` (per UI-SPEC.md Color table).

**Sync pill** (`.bp-kiosk-badge`, `:424-435`) — reuse the visual weight, add a warning-color variant:
```css
.bp-kiosk-badge {
  display: inline-block;
  font-size: 0.72rem;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
  white-space: nowrap;
  background: rgba(74, 111, 138, 0.12);
  color: var(--batch-info);
  margin-left: 4px;
  vertical-align: middle;
}
```
New `.bp-sync-badge` / `.bp-sync-badge--warning` should copy this shape with `--batch-warning`/`--batch-warning-bg` swapped in for the "Not synced" state.

**Table shape** (`.bp-active-batches-table`, `:1499-1507`):
```css
.bp-active-batches-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 16px; }
.bp-active-batches-table th {
  text-align: left; font-size: 0.72rem; color: var(--ink-secondary); padding: 4px 6px;
  border-bottom: 1px solid var(--ledger-line); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
}
.bp-active-batches-table td { padding: 8px 6px; border-bottom: 1px solid var(--ledger-line); }
.bp-active-batches-table tr:last-child td { border-bottom: none; }
```
Copy this shape for a new `.bp-waitlist-table` (or reuse `.bp-active-batches-table` directly if the column count/width needs match closely enough — planner's call).

**Filter row** (`.bp-batch-filters`/`.bp-filter-btn`, `:545-570`) and **search input** (`.bp-search-input`, `:578-594`) — both already ≥44px min-height touch targets, reuse verbatim (see full excerpts inline above in the Tasks-toolbar pattern section).

**Empty state** (`.bp-empty-state`, `:2620-2626`):
```css
.bp-empty-state,
.bp-recipe-ing-empty {
  color: var(--ink-tertiary);
  font-size: 0.9rem;
  text-align: center;
  padding: 1.25rem 0;
}
```

**Remove `×` button** — reuse `.bp-reading-del`'s hover treatment (`css/brewpad.css:1476-1481` area): `color` transitions to `var(--batch-danger)` on hover, `background: rgba(168,50,50,0.1)`.

---

### Test: `zoho-middleware/__tests__/<new>-waitlist-route.test.js` (or extend an existing waitlist-adjacent file)

**Analog A — server-boot mock harness** (needed because `/api/waitlist` lives directly in `server.js`, not a `routes/*.js` router): `zoho-middleware/__tests__/checkout-captured-amount.test.js:18-40`
```javascript
jest.mock('../lib/zohoAuth', function () {
  return { init: jest.fn().mockResolvedValue(), isAuthenticated: jest.fn().mockReturnValue(true) };
});
jest.mock('../lib/validateEnv', function () { return jest.fn(); });
jest.mock('../lib/checkRedis', function () { return jest.fn().mockResolvedValue(); });
jest.mock('../lib/checkMailer', function () { return jest.fn(); });
jest.mock('../lib/brewpad-integration', function () {
  return { syncBatch: jest.fn(), init: jest.fn(), createBatchesFromSale: jest.fn() };
});
jest.mock('node-cron', function () { return { schedule: jest.fn() }; });
jest.mock('@sentry/node', function () {
  return { init: jest.fn(), setupExpressErrorHandler: jest.fn(), captureException: jest.fn() };
});
jest.mock('../lib/mailerlite', function () {
  return { isConfigured: jest.fn().mockReturnValue(false), addSubscriber: jest.fn().mockResolvedValue() };
});
```
Then `require('supertest')` against `require('../server')` and POST to `/api/waitlist`, asserting the new axios/Apps-Script mock was called with `action: 'add_waitlist_entry'` and that a MailerLite failure alone no longer produces a 503 (D-03's core assertion).

**Analog B — axios-mock pattern for Apps Script calls**: `zoho-middleware/__tests__/gift-cards.test.js:14-18`
```javascript
jest.mock('axios', function () {
  return { post: jest.fn().mockResolvedValue({ data: { ok: true } }) };
});
```

**Existing coverage not to duplicate:** `tests/frontend/checkout-waitlist.test.js` already covers the CLIENT side (`setupBeerWaitlistForm()` POSTing to `/api/waitlist` and handling `{success:true/false}`) — do not modify per CLAUDE.md rule 10; this phase's middleware change must keep that response shape (`{success:true}` / `{success:false}` or error) unchanged so the existing client test keeps passing.

---

### Test: `tests/frontend/<new>-adminapi-waitlist-pure.test.js`

**Analog:** `tests/frontend/adminapi-giftcard-ledger.test.js` (source-extraction harness, `new Function`), full loader excerpt (lines 1-54):
```javascript
var fs = require('fs');
var path = require('path');
var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');
var _cachedApi = null;
function loadAdminApi() {
  if (_cachedApi) return _cachedApi;
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var factory = new Function(
    src + '\nreturn {' +
      'normalizeCertNumber: (typeof normalizeCertNumber !== "undefined" ? normalizeCertNumber : undefined),' +
      ...
      '};'
  );
  _cachedApi = factory();
  return _cachedApi;
}
```
This is the ONLY testable-in-CI part of the Apps Script side of this phase — `waitlistDedupeDecision` should be tested this exact way (load the real file, extract the pure function, assert on `{action, row}` outcomes for: first signup, exact-duplicate email+category, same email different category, case/whitespace variance). `ensureWaitlistSheet`/`addWaitlistEntry`/`updateWaitlistStatus`/`getWaitlist` (the actual Sheets I/O) can only be asserted by source-shape review (regex/text assertions on the raw file, same technique the gift-card suite uses for `ensureGiftCardLedgerSheet`'s shape) plus a live probe after redeploy — never by an automated Jest suite that touches `SpreadsheetApp`.

---

## Shared Patterns

### No-Lock-Needed (concurrency posture)

**Source:** `addReservation()` (`adminApi.gs:910-949`, no lock) vs. `voidGiftCard()`/`issueGiftCard()`/`redeemGiftCard()`/`reloadGiftCard()` (all take `acquireScriptLock`)
**Apply to:** `addWaitlistEntry`, `updateWaitlistStatus` — **do NOT** call `acquireScriptLock()` in either. D-01 already accepts "sheets are weak under concurrent writes" as a cost for this phase; only money-adjacent gift-card handlers take the lock. Copying the lock here is Pitfall 5 in RESEARCH.md — a plan task proposing `acquireScriptLock` for either waitlist handler is a signal to push back.
```javascript
function acquireScriptLock(timeoutMs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 10000);
  return lock;
}
```
(cited for completeness — this function itself is NOT to be called from the new waitlist handlers)

### Runtime column resolution (never hardcode column letters)

**Source:** every write handler in `adminApi.gs`, e.g. `voidGiftCard`:
```javascript
var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
var statusCol = headers.indexOf('status') + 1;
```
**Apply to:** `updateWaitlistStatus`. Resolves correctly even if staff reorder columns by hand.

### `sheetToObjects` / `_row` convention

**Source:** `adminApi.gs:1423-1455`
```javascript
function sheetToObjects(sheetName, skipCache) {
  ...
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (val instanceof Date) val = val.toISOString();
      obj[headers[j]] = val;
    }
    obj._row = i + 1; // 1-based row for updates
    result.push(obj);
  }
  ...
}
```
**Apply to:** `getWaitlist()` (uses this to read) and `updateWaitlistStatus` if it ever needs a full-table scan fallback instead of `findRowById`. `_row` is per-request-cache-populated and must never be sent to the client (strip it in the explicit field map, as `getGiftCards()` does).

### `sanitizeInput()` (XSS strip, NOT formula-injection-safe — known open gap)

**Source:** `adminApi.gs:3433-3451`
```javascript
function sanitizeInput(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return String(input);
  var sanitized = input;
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/javascript\s*:/gi, '');
  ...
}
```
**Apply to:** every free-text field written by `addWaitlistEntry`/`updateWaitlistStatus` (`email`, `category`, `notes`). **Known gap (M9, deferred project-wide):** does not neutralize a leading `=`/`+`/`-`/`@` (Sheets formula injection). This phase is not obligated to fix it — same posture as every other sheet-backed staff field — but flag it as an accepted risk in the plan rather than silently reproducing it unacknowledged.

### `showToast()` (reused verbatim)

**Source:** `brewpad.js:1093` onward
```javascript
function showToast(message, type, opts) {
  if (!type) type = 'info';
  ...
}
```
**Apply to:** every waitlist write outcome — `showToast('Status updated', 'success')`, `showToast('Removed from waitlist', 'success')`, `showToast('Notes saved', 'success')`, `showToast('Failed: ' + err.message, 'error')` (exact copy strings per UI-SPEC.md).

### `escapeHTML()` on every interpolated value in generated markup

Used throughout `brewpad.js` render functions (e.g. `openReadingEditRow`, task rows) — every `email`/`notes`/`category` value rendered into the waitlist table/inline-editor markup must go through `escapeHTML()` before string-concatenation into `innerHTML`, matching the existing convention everywhere else in this file.

## No Analog Found

None — every file/function in this phase has a strong, cited analog already in the codebase. This is explicitly the finding of RESEARCH.md's summary: "This phase does not introduce new technology... the fourth sheet-backed staff list... and the sixth BrewPad tab."

## Metadata

**Analog search scope:** `apps-script/adminApi.gs`, `zoho-middleware/server.js`, `zoho-middleware/routes/{pos,gift-cards}.js`, `zoho-middleware/lib/checkout-helpers.js`, `js/brewpad.js`, `brewpad.html`, `css/brewpad.css`, `zoho-middleware/__tests__/{gift-cards,checkout-captured-amount}.test.js`, `tests/frontend/{adminapi-giftcard-ledger,checkout-waitlist}.test.js`
**Files scanned:** 12 (all read directly with cited line ranges, no re-reads of overlapping ranges)
**Pattern extraction date:** 2026-09-02
