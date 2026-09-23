# Phase 82: Store-Agnostic Prerequisites - Pattern Map

**Mapped:** 2026-09-23
**Files analyzed:** 8 (2 new middleware test files, 1 new frontend test file, 5 modified files)
**Analogs found:** 8 / 8 (all files have a direct, in-repo, already-shipped analog — this phase is explicitly "clone Phase 76's pattern," per RESEARCH.md's Primary Recommendation)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `zoho-middleware/routes/pos.js` (+ `POST /api/admin/proxy`, + shared forwarding helper) | route | request-response (proxy/forward) | `zoho-middleware/routes/pos.js:3991-4076` (`/api/batch/admin-proxy`, same file) | exact |
| `zoho-middleware/routes/pos.js` (+ 3 `POST/GET /api/batch/public/*` routes) | route | request-response (token-authenticated proxy) | `zoho-middleware/routes/pos.js:3991-4076` (`/api/batch/admin-proxy`) for shape; `apps-script/adminApi.gs` `handleBatchTokenPost`/`handleGetBatchPublic` for upstream contract | exact (shape) / role-match (auth model differs: token not session) |
| `zoho-middleware/__tests__/admin-proxy.test.js` (new) | test | request-response | `zoho-middleware/__tests__/batch-admin-proxy.test.js` (full file, 268 lines) | exact |
| `zoho-middleware/__tests__/batch-public.test.js` (new) | test | request-response | `zoho-middleware/__tests__/batch-admin-proxy.test.js` (mock harness) + no-session-required variant needed | role-match |
| `apps-script/adminApi.gs` (+7 `doPost` server_token entries, +`get_ingredients`, +lock fixes, -4 dead actions) | controller (Apps Script dispatch) | CRUD / request-response | Same file — existing `doPost` server_token if-chain (`:262-383`) and staff-auth `switch` (`:391-497`) | exact |
| `js/admin.js` (`adminApiGet`/`adminApiPost`/`fetchWithRetry` internals, delete Sheets fallbacks) | service (frontend API client) | request-response | `js/brewpad.js:1700-1786` (`fetchWithRetry`, `adminApiGet`, `adminApiPost`, `mwUrl`) | exact |
| `js/admin.js` (2 `update_batch_task` call sites missing `batch_id`) | component (event handler) | CRUD | Same file, other `adminApiPost('update_batch_task', ...)` call sites that already include `batch_id` | exact |
| `js/batch.js` (apiUrl → MIDDLEWARE_URL, 3 fetches repointed, + module.exports seam) | component (page controller) | request-response | `js/admin.js` fetch-interceptor IIFE (`:1-40`) for the token/header pattern; `js/brewpad.js` module.exports blocks (`:10837-10988`) for the test-seam pattern | role-match |
| `tests/frontend/batch-public-proxy.test.js` (new, net-new file) | test | request-response | `tests/frontend/brewpad-read-retry.test.js` (harness/mocking pattern) + `tests/frontend/admin-session-auth.test.js` (DOM/global stub pattern) | role-match |

## Pattern Assignments

### `zoho-middleware/routes/pos.js` — new `POST /api/admin/proxy` + shared forwarding helper

**Analog:** same file, `/api/batch/admin-proxy` (lines 3981-4076)

**Full reference implementation to clone (lines 3991-4076):**
```javascript
// ---------------------------------------------------------------------------
// Phase 76-02: single allow-listed Apps-Script proxy for BrewPad's batch/
// dashboard/reading/schedule reads AND writes (D-76). Session/legacy tier
// only (device excluded — BrewPad is session-scoped, not kiosk-scoped).
//
// Hardcoded allow-list — NEVER a free-form req.body.action passthrough
// (T-76-02-01). Any action not a key here is rejected 400 invalid_action
// before Apps Script is ever called.
// ---------------------------------------------------------------------------
var ADMIN_PROXY_ACTIONS = {
  get_batch: true, get_batches: true, /* ...reads... */
  create_batch: true, update_batch: true, /* ...writes... */
};

var ADMIN_PROXY_READS = {
  get_batch: true, get_batches: true, /* reads only, subset of ADMIN_PROXY_ACTIONS */
};

router.post('/api/batch/admin-proxy', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
    var body = req.body || {};
    var action = (body.action || '').toLowerCase();
    if (!ADMIN_PROXY_ACTIONS[action]) {
      return res.status(400).json({ ok: false, error: 'invalid_action' });
    }

    // identity is proven solely by requireTiers above — never accept a
    // client-supplied Google token as a fallback identity.
    var payload = Object.assign({}, body, {
      action: action,
      server_token: process.env.APPS_SCRIPT_SERVER_TOKEN
    });
    delete payload.token;

    var upstream = ADMIN_PROXY_READS[action]
      ? axios.get(process.env.APPS_SCRIPT_URL, { params: payload, timeout: 15000, maxRedirects: 5 })
      : axios.post(process.env.APPS_SCRIPT_URL, JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 5
        });

    upstream
      .then(function (resp) { res.json(resp.data); })
      .catch(function (err) {
        log.error('[batch/admin-proxy] ' + action + ' failed: ' + (err && err.message));
        res.status(502).json({ ok: false, error: 'server_error' });
      });
  });
});
```

**What to change for `/api/admin/proxy` (D-05):**
- New `ADMIN_PROXY_ACTIONS`-equivalent object (e.g. `ADMIN_PANEL_PROXY_ACTIONS`) — larger allowlist covering all `admin.js` actions listed in CONTEXT D-01 (`get_kits`, `get_holds`, `get_schedule`, `get_reservations`, `update_hold`, `update_reservation`, `update_homepage`) plus the new `get_ingredients` read (D-15). Name it distinctly from `ADMIN_PROXY_ACTIONS` to avoid collision in the same file.
- Extract the `.then()/.catch()` + GET-vs-POST branch (lines 4055-4074) into a shared function, e.g. `forwardToAppsScript(action, payload, isRead, logTag)`, called by both routes (D-05 explicit ask; naming is Claude's Discretion).
- Auth: identical `authTiers.requireTiers(['legacy', 'session'])(...)` wrapper (D-06).
- 400 `invalid_action` gate BEFORE any network call — same shape, non-negotiable (V4/Anti-Pattern).

**Error handling pattern (502 collapse):** identical `.catch()` block, `res.status(502).json({ok:false, error:'server_error'})` — never differentiate error types here (V-mitigation: writes handle the double-apply risk client-side by never retrying, not server-side).

---

### `zoho-middleware/routes/pos.js` — new `/api/batch/public/*` routes (D-13)

**Analog (shape):** same `/api/batch/admin-proxy` pattern, but with the auth wrapper REMOVED (these are token-authenticated by Apps Script, not session-authenticated) and per-IP rate limiting ADDED (D-14).

**Rate-limit analog** — `zoho-middleware/server.js:594-615` (`clientErrorLimiter`/`telemetryLimiter`, the existing bounded-unauthenticated-endpoint pattern):
```javascript
// Source: zoho-middleware/server.js:594-602
var clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore(60 * 1000, 'client-error'),
  skip: redisUnavailableSkip,
  message: { error: 'Too many client-error reports, slow down' }
});
// ...
app.use('/api/kiosk/client-error', clientErrorLimiter);
```
Mirror this exactly for a new `batchPublicLimiter`, mounted via `app.use('/api/batch/public', batchPublicLimiter)` in `server.js` near line 620 (Claude's Discretion on exact `max`/`windowMs`).

**Route shape** (no `authTiers` wrapper; forward `batch_token`/`token` straight through per D-13 — do NOT re-validate format):
```javascript
router.get('/api/batch/public/:id', function (req, res) {
  var payload = { action: 'get_batch_public', batch_id: req.params.id, token: req.query.token };
  axios.get(process.env.APPS_SCRIPT_URL, { params: payload, timeout: 15000, maxRedirects: 5 })
    .then(function (resp) { res.json(resp.data); })
    .catch(function (err) {
      log.error('[batch/public] get_batch_public failed: ' + (err && err.message));
      res.status(502).json({ ok: false, error: 'server_error' });
    });
});

router.post('/api/batch/public/:id/tasks', function (req, res) {
  var payload = Object.assign({}, req.body, { action: 'update_batch_task', batch_id: req.params.id });
  axios.post(process.env.APPS_SCRIPT_URL, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 5
  })
    .then(function (resp) { res.json(resp.data); })
    .catch(function (err) { res.status(502).json({ ok: false, error: 'server_error' }); });
});
// POST /api/batch/public/:id/readings -> action: 'bulk_add_plato_readings', same shape
```
No `server_token` injected here (D-13: identity is the batch token, forwarded as-is; Apps Script's existing `handleBatchTokenPost`/`handleGetBatchPublic` do the validation — do not duplicate it, per "Don't Hand-Roll" in RESEARCH.md).

---

### `zoho-middleware/__tests__/admin-proxy.test.js` (new)

**Analog:** `zoho-middleware/__tests__/batch-admin-proxy.test.js` (full file, 268 lines) — copy verbatim and adapt:
- Same `jest.mock('express', ...)` router-capture harness (lines 25-37)
- Same `jest.mock('axios', ...)`, `jest.mock('../lib/session', ...)` (mock-mirrors-real-contract), same `callHandler(method, path, req)` helper (lines 109-125)
- Same 5 test classes to replicate for `/api/admin/proxy`: (1) valid session + read action → `axios.get`, token stripped; (2) write action → `axios.post`, token stripped; (3) action outside allowlist → 400 `invalid_action`, Apps Script never called; (4) no credential → 401; (5) axios rejection → 502.
- Add one assertion class specific to this proxy: `get_ingredients` (new read) routes via `axios.get` — mirrors Test 1/1b exactly.

**Auth mock block to reuse verbatim (lines 91-142):**
```javascript
jest.mock('../lib/session', function () {
  return {
    createSession: jest.fn().mockResolvedValue('mock-sid'),
    getSession: jest.fn().mockResolvedValue(null),
    destroySession: jest.fn().mockResolvedValue(),
    touchSession: jest.fn().mockResolvedValue(null)
  };
});
var session = require('../lib/session');
require('../routes/pos');
var axios = require('axios');
function callHandler(method, path, req) { /* ...same as batch-admin-proxy.test.js:109-125... */ }
```

---

### `zoho-middleware/__tests__/batch-public.test.js` (new)

**Analog:** `zoho-middleware/__tests__/batch-admin-proxy.test.js` for the mock-express/mock-axios harness shape, MODIFIED to drop the `authTiers`/session assertions (these routes are unauthenticated by design — D-13) and instead assert:
1. `GET /api/batch/public/:id?token=...` forwards `{action:'get_batch_public', batch_id, token}` via `axios.get`, NO `server_token` injected, NO `authTiers` call.
2. `POST /api/batch/public/:id/tasks` forwards `update_batch_task` with `batch_token` intact via `axios.post`.
3. `POST /api/batch/public/:id/readings` forwards `bulk_add_plato_readings`.
4. Upstream axios rejection → 502 (same as Test 4 in the analog, lines 235-244).
5. Malformed/missing token is NOT rejected by the middleware itself (per D-13, "middleware does NOT validate tokens itself") — assert the request still reaches Apps Script and the middleware passes through whatever Apps Script returns (e.g. `{ok:false, error:'invalid_token'}`), not a middleware-level 400.

---

### `apps-script/adminApi.gs` — 7 new `doPost` server_token entries (D-11)

**Analog:** same file, existing server_token if-chain block, e.g. `update_batch` (lines 338-342):
```javascript
// Source: apps-script/adminApi.gs:338-342 (existing pattern to replicate x7)
if (action === 'update_batch') {
  var sUpdateBatchResult = updateBatch(payload, 'middleware');
  _invalidateBatchCache(payload.batch_id);
  return _jsonResponse(sUpdateBatchResult);
}
```
Add, inside the same `if (payload.server_token) { ... }` branch (starts line 262), before the `default`/closing of that block:
```javascript
if (action === 'update_reservation') {
  return _jsonResponse(updateReservation(payload, 'middleware'));
}
if (action === 'update_hold') {
  return _jsonResponse(updateHold(payload, 'middleware'));
}
if (action === 'update_homepage') {
  return _jsonResponse(updateHomepage(payload));
}
if (action === 'add_batch_task') {
  var sAddBatchTaskResult = addBatchTask(payload, 'middleware');
  _invalidateBatchCache(payload.batch_id);
  return _jsonResponse(sAddBatchTaskResult);
}
if (action === 'update_batch_task') {
  var sUpdateBatchTaskResult = updateBatchTask(payload, 'middleware');
  _invalidateBatchCache(payload.batch_id);
  return _jsonResponse(sUpdateBatchTaskResult);
}
if (action === 'propagate_ferm_schedule') {
  return _jsonResponse(propagateFermSchedule(payload, 'middleware'));
}
if (action === 'regenerate_batch_token') {
  var sRegenResult = regenerateBatchToken(payload);
  _invalidateBatchCache(payload.batch_id);
  return _jsonResponse(sRegenResult);
}
```
Function signatures confirmed live at `updateReservation` (`:972`), `updateHold` (`:1055`), `updateHomepage` (`:1174`), `updateBatchTask` (`:2716`), `addBatchTask` (`:2823`), `propagateFermSchedule` (`:3245`), `regenerateBatchToken` (`:3399`) — each already called with the identical `(payload, authResult.email)` or `(payload)` shape from the staff-auth `switch` (lines 391-497), so `'middleware'` is a drop-in replacement for `authResult.email` (matches existing `update_batch`/`create_batch` precedent verbatim).

**Reads need NO Apps Script change** — `doGet`'s `server_token` bypass (lines 100-108) dispatches any action through `handleReadAction` with no allowlist; do not add read-side entries here (Pitfall 3).

---

### `apps-script/adminApi.gs` — `get_ingredients` new read action (D-15)

**Analog:** `getKits()` (lines 744-751), identical shape:
```javascript
// Source pattern: apps-script/adminApi.gs:744-751 (getKits, copy verbatim)
function getKits() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(KITS_SHEET_NAME);
  if (!sheet) return { values: [] };
  var data = sheet.getDataRange().getValues();
  return { values: data };
}
```
New function:
```javascript
function getIngredients() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INGREDIENTS_SHEET_NAME); // new const near line 49-63, alongside HOLDS_SHEET_NAME etc.
  if (!sheet) return { values: [] };
  return { values: sheet.getDataRange().getValues() };
}
```
Register in `handleReadAction`'s switch (existing `case 'get_kits':` at line 165 is the sibling to copy — add `case 'get_ingredients': return { ok: true, data: getIngredients() };`). `admin.js`'s `parseSheetData(result.data, 'ingredients')` needs zero reshaping since the `{values: [[...]]}` shape is identical to what `sheetsGet()` used to return.

---

### `apps-script/adminApi.gs` — 4 dead-action deletions (D-02)

**Pattern:** delete both the `case` in `handleReadAction`'s switch AND the standalone function, for each of:
- `case 'get_config':` (switch line 168) + `function getConfig()` (lines 753-764)
- `case 'update_schedule':` (staff-switch line ~399) + `function updateSchedule(payload)` (line 1143)
- `case 'update_kits':` (staff-switch line ~405) + `function updateKits(payload)` (line 1218)
- `case 'get_homepage':` (switch line 162) + `function getHomepage()` (lines 735-742)

Before deleting each, re-grep per D-02: `grep -rn "get_config\|update_schedule\|update_kits\|get_homepage" js/ zoho-middleware/ apps-script/ tests/` to confirm zero remaining callers (RESEARCH.md's State-of-the-Art table already re-verified this at research time, but the planner must re-verify at implementation time since admin.js is being edited concurrently).

---

### `apps-script/adminApi.gs` — lock fixes (D-18, Pitfall 6 — two SEPARATE edits)

**Fix 1 — `updateGiftCardInvoice` gets a lock (currently has NONE):**

Current (no lock), lines 4847-4866:
```javascript
// Source: apps-script/adminApi.gs:4847-4866 (current, NO lock)
function updateGiftCardInvoice(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var invoiceNumber = sanitizeInput(payload.zoho_invoice_number || '');
  if (!certNum || !invoiceNumber) return { ok: false, error: 'missing_fields' };
  var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
  if (result.row === -1) return { ok: false, error: 'not_found' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var invoiceCol = headers.indexOf('zoho_invoice_number') + 1;
  var updatedCol = headers.indexOf('last_updated') + 1;
  if (invoiceCol > 0) sheet.getRange(result.row, invoiceCol).setValue(invoiceNumber);
  if (updatedCol > 0) sheet.getRange(result.row, updatedCol).setValue(new Date().toISOString());
  invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
  return { ok: true };
}
```
**Analog for the lock shape:** `createBatch`'s existing lock (lines 2227-2228, and the closing `finally` further down in the same function) — every other locked function in this file uses this exact `try { ... } finally { lock.releaseLock(); }` shape around `acquireScriptLock(timeoutMs)`:
```javascript
// Source: apps-script/adminApi.gs:1252-1256 (acquireScriptLock, unchanged)
function acquireScriptLock(timeoutMs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 10000);
  return lock;
}
```
Fixed shape (15s convention, matching the majority of the other 10 `acquireScriptLock` call sites):
```javascript
function updateGiftCardInvoice(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var invoiceNumber = sanitizeInput(payload.zoho_invoice_number || '');
  if (!certNum || !invoiceNumber) return { ok: false, error: 'missing_fields' };
  var lock = acquireScriptLock(15000);
  try {
    var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
    if (result.row === -1) return { ok: false, error: 'not_found' };
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var invoiceCol = headers.indexOf('zoho_invoice_number') + 1;
    var updatedCol = headers.indexOf('last_updated') + 1;
    if (invoiceCol > 0) sheet.getRange(result.row, invoiceCol).setValue(invoiceNumber);
    if (updatedCol > 0) sheet.getRange(result.row, updatedCol).setValue(new Date().toISOString());
    invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
```

**Fix 2 — `createBatch`'s dedup guard moves INSIDE the lock (TOCTOU close):**

Current: the dedup guard (check-then-decide, lines 2158-2193) runs entirely BEFORE `acquireScriptLock(15000)` is called at line 2227. The fix moves the guard's read (the `sheetToObjects(BATCHES_SHEET_NAME)` scan + `matching.length >= allowedUnits` decision) to execute AFTER the lock is acquired, inside the same `try` block that already wraps ID generation (line 2229) and the row append — so two concurrent `createBatch` calls for the same invoice+SKU can no longer both pass the check before either appends. Location: `apps-script/adminApi.gs:2129-2280ish` (function body); lock acquired at `:2227`. This is a distinct, single-function edit from Fix 1 — plan and verify separately (Pitfall 6: different verification shapes — TOCTOU fix needs a concurrent-request test, invoice-lock fix just needs the lock present).

---

### `js/admin.js` — `adminApiGet`/`adminApiPost`/`fetchWithRetry` transport rewrite (D-05, D-06, D-08)

**Analog:** `js/brewpad.js:1700-1786` (already-shipped Phase 76 reference implementation) — copy this shape into `admin.js`, replacing the current `SHEETS_CONFIG.ADMIN_API_URL`-based implementation.

**Current admin.js (to be replaced), lines 634-730:**
```javascript
// Source: js/admin.js:634-646 (current fetchWithRetry — retries EVERYTHING, no status awareness)
function fetchWithRetry(url, options, retries) {
  if (retries === undefined) retries = 1;
  return fetch(url, options).catch(function (err) {
    if (retries > 0) {
      return new Promise(function (resolve) { setTimeout(resolve, 1000); })
        .then(function () { return fetchWithRetry(url, options, retries - 1); });
    }
    throw err;
  });
}
// admin.js:677-730 — adminApiGet/adminApiPost currently POST {action, token: accessToken}
// directly to SHEETS_CONFIG.ADMIN_API_URL with text/plain, and call
// isUnauthorizedError(data)/handleUnauthorized() on a body-substring match.
```

**Target shape (mirror brewpad.js verbatim, lines 1700-1786):**
```javascript
// Source: js/brewpad.js:1711-1786 (live in prod — the exact pattern to replicate in admin.js)
function fetchWithRetry(url, options, retries, retryStatuses) {
  if (retries === undefined) retries = 1;
  function backoffRetry() {
    return new Promise(function (resolve) { setTimeout(resolve, 1000); })
      .then(function () { return fetchWithRetry(url, options, retries - 1, retryStatuses); });
  }
  return fetch(url, options).then(function (r) {
    if (retryStatuses && retries > 0 && retryStatuses.indexOf(r.status) !== -1) return backoffRetry();
    return r;
  }, function (err) {
    if (retries > 0) return backoffRetry();
    throw err;
  });
}

function adminApiGet(action, params) {
  var body = { action: action };
  if (params) { Object.keys(params).forEach(function (key) { body[key] = params[key]; }); }
  return fetchWithRetry(mwUrl() + '/api/admin/proxy', {
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
  return fetchWithRetry(mwUrl() + '/api/admin/proxy', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })  // no retryStatuses — writes never retry (D-08)
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
Note: `admin.js` already has a `mwUrl()`-equivalent via `SHEETS_CONFIG.MIDDLEWARE_URL` accessed directly elsewhere (confirmed at `js/admin.js:20` in the fetch-interceptor IIFE) — either add a small `mwUrl()` helper mirroring `brewpad.js:1784-1786` or inline `SHEETS_CONFIG.MIDDLEWARE_URL`; both are consistent with existing admin.js style.

**401 handling (D-07):** delete `isUnauthorizedError`/`handleUnauthorized` (admin.js:655-675) body-substring detection entirely; real 401s are now handled by whatever `_handleMiddlewareResponse`-equivalent interceptor pattern the fetch-wrapper IIFE at the top of the file uses (mirror `js/brewpad.js:1690-1698`'s `_handleMiddlewareResponse` hook if admin.js does not already have an equivalent — check `admin-session-auth.test.js` for the current 401 handling admin.js already has from Phase 46, since CONTEXT says "Phase 76 D-01..D-05 carried forward").

**Deletion targets (D-16), all in `js/admin.js`:**
- `sheetsGet`/`sheetsUpdate`/`sheetsAppend`/`sheetsBatchUpdate` (lines 734-835) — full removal
- The `check_auth` calls inside `sheetsUpdate`/`sheetsAppend`/`sheetsBatchUpdate` (lines 748-756, 779-787, 809-818) — removed along with the functions themselves
- `loadAllData`'s fallback branch — the entire `if (SHEETS_CONFIG.ADMIN_API_URL) { ... } ` gate at line 846 stays as the ONLY path (delete the `return;` at 872 is no longer needed once the fallback below it, lines 875-895, is deleted) — also fold the ingredients read (currently `sheetsGet(SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS + '!A:Z')` at line 863) into the same `Promise.all([...])` as `adminApiGet('get_ingredients')`, matching how `get_kits`/`get_holds`/`get_schedule` are already loaded (lines 848, 850, 851).
- After deletion, grep-confirm `check_auth` has no remaining caller before deleting the action itself server-side (D-16 final clause).

---

### `js/admin.js` — 2 missing `batch_id` call sites (D-09, Pitfall 2)

**Analog:** every OTHER `adminApiPost('update_batch_task', ...)` call site in the same file that already includes `batch_id`.

**Site 1 — transfer-confirm, ~line 6345** (currently missing `batch_id`, `batchId` is in scope):
```javascript
// Current (js/admin.js, transfer-confirm handler) — MISSING batch_id
adminApiPost('update_batch_task', {
  task_id: taskId,
  updates: { completed: true },
  transfer_location: { vessel_id: vesselId, shelf_id: shelfId, bin_id: binId }
}).then(...)
// FIX: add batch_id: batchId to the payload object (batchId is already in scope —
// used two lines later at openBatchDetail(batchId))
```

**Site 2 — skip-transfer, ~line 6367** (currently missing `batch_id`):
```javascript
// Current (js/admin.js, skip-transfer handler) — MISSING batch_id
adminApiPost('update_batch_task', { task_id: taskId, updates: { completed: true } })
// FIX: adminApiPost('update_batch_task', { task_id: taskId, updates: { completed: true }, batch_id: batchId })
```
Verification command (per RESEARCH.md Pitfall 2): `grep -n "adminApiPost('update_batch_task'" js/admin.js` — every match must include `batch_id` after the fix.

**Pitfall 1 flag (`bulk_update_batch_tasks`, ~line 8042):** the calendar-view call site builds `tasksArr` spanning possibly multiple batches — no single `batch_id` fixes this. RESEARCH.md's recommended fix is server-side: change `bulkUpdateBatchTasks` (`apps-script/adminApi.gs:2807-2819`) to invalidate `gb:<batch_id>` per task using each task's own looked-up `batch_id`, independent of `payload.batch_id`. Flag this as an explicit planning decision — do not silently defer or silently "fix" with the wrong mechanism.

---

### `js/batch.js` — transport rewrite + module.exports test seam (D-13, Pitfall 4)

**Analog for token/fetch pattern:** `js/admin.js`'s fetch-wrapper IIFE (lines 1-40) for how a header/credential gets attached only to `MIDDLEWARE_URL` requests — batch.js does NOT need a session token (batch_token is in the URL/body already, per D-13), so this is a role-match, not a literal copy; use it to see the `SHEETS_CONFIG.MIDDLEWARE_URL` access pattern (line 20: `(typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL) || ''`).

**Current `js/batch.js` (full file read, 406 lines) — 3 call sites to repoint:**
```javascript
// Source: js/batch.js:29-30 (init) — apiUrl currently sourced from ADMIN_API_URL
apiUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.ADMIN_API_URL) || '';
if (!apiUrl) { showError('Configuration error'); return; }

// Source: js/batch.js:46 (loadBatch, GET) — direct Apps-Script GET with query params
var url = apiUrl + '?action=get_batch_public&batch_id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(batchToken);
fetch(url).then(...)

// Source: js/batch.js:142-155 (toggleTask, POST) — direct Apps-Script POST, text/plain
var payload = { action: 'update_batch_task', batch_token: batchToken, batch_id: batchId, task_id: taskId, updates: { completed: completed } };
fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) })

// Source: js/batch.js:289-298 (bulk plato submit, POST) — same direct pattern
fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'bulk_add_plato_readings', batch_token: batchToken, batch_id: batchId, readings: _platoStagingRows }) })

// Source: js/batch.js:388 (auto-refresh poll, GET) — SAME url as loadBatch, duplicated
var url = apiUrl + '?action=get_batch_public&batch_id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(batchToken);
```
**Target (D-13):**
- `init()`: `apiUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL) || '';` (rename var or repurpose; keep `!apiUrl` guard)
- `loadBatch()` / auto-refresh poll: `fetch(apiUrl + '/api/batch/public/' + encodeURIComponent(batchId) + '?token=' + encodeURIComponent(batchToken))` — GET, no `action` param needed (route implies it), response shape unchanged (`{ok, data: {batch, tasks, plato_readings, vessel_history}}`).
- `toggleTask()`: `fetch(apiUrl + '/api/batch/public/' + encodeURIComponent(batchId) + '/tasks', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({batch_token: batchToken, task_id: taskId, updates: {completed: completed}})})` — drop `action`/`batch_id` from the body (both now implicit in the URL/route), keep `batch_token`.
- Bulk plato submit: `fetch(apiUrl + '/api/batch/public/' + encodeURIComponent(batchId) + '/readings', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({batch_token: batchToken, readings: _platoStagingRows})})`.
- Switch `Content-Type` from `text/plain` to `application/json` (no longer talking to Apps Script directly, no CORS-preflight concern against the middleware — confirm middleware's body-parser accepts JSON, matching every other `/api/*` POST route in `pos.js`).

**Test seam to add (net-new, Pitfall 4) — mirror `js/brewpad.js`'s bottom-of-file pattern:**
```javascript
// Source: js/brewpad.js:10986-10988 (pattern to replicate at the bottom of js/batch.js)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Object.assign(module.exports || {}, {
    // expose whatever internal functions/setters the new
    // tests/frontend/batch-public-proxy.test.js needs to drive directly
  });
}
```

---

### `tests/frontend/batch-public-proxy.test.js` (new, net-new — Pitfall 4)

**Analog for harness/mocking shape:** `tests/frontend/brewpad-read-retry.test.js` (global stubs: `document`, `window`, `navigator`, `google.accounts.oauth2`, `fetch`, `localStorage`) — copy the stub block verbatim:
```javascript
// Source: tests/frontend/brewpad-read-retry.test.js:18-30
global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();
global.localStorage = { /* ...simple in-memory shim... */ };
```
**Analog for DOM-fixture + `SHEETS_CONFIG` stub shape:** `tests/frontend/admin-session-auth.test.js:14-42` (`document.body.innerHTML = ...`, `global.SHEETS_CONFIG = {MIDDLEWARE_URL: ..., ADMIN_API_URL: ''}`, `require('../../js/admin.js')`) — adapt: batch.js's DOM fixture needs the batch-page elements (`#batch-loading`, `#batch-content`, `#batch-error`, `#batch-toast-container`, task checkboxes) instead of admin's dashboard shell.

**What to assert (mirrors brewpad-read-retry.test.js's 3-test shape, applied to the 3 new routes):**
1. `loadBatch()` fetches `MIDDLEWARE_URL + '/api/batch/public/:id?token=...'` (GET), not the old `ADMIN_API_URL` query-string shape.
2. `toggleTask()` POSTs to `.../tasks` with `application/json`, body has `batch_token` but NOT a duplicated `action`/`batch_id` if the route makes them implicit (per whatever the planner's exact route contract ends up being).
3. Bulk plato submit POSTs to `.../readings`.

---

## Shared Patterns

### Session Auth for admin-authenticated proxy routes
**Source:** `zoho-middleware/routes/pos.js:4039` — `authTiers.requireTiers(['legacy', 'session'])(req, res, function () {...})`
**Apply to:** `/api/admin/proxy` only. Do NOT apply to `/api/batch/public/*` (those are token-authenticated by Apps Script, not session-authenticated — D-13).

### Hardcoded allowlist, never passthrough
**Source:** `zoho-middleware/routes/pos.js:3991-4021` (`ADMIN_PROXY_ACTIONS`) + `4043-4045` (`if (!ADMIN_PROXY_ACTIONS[action]) return res.status(400)...`)
**Apply to:** Both new proxy routes — `/api/admin/proxy` gets its own larger allowlist object; `/api/batch/public/*` has an implicit allowlist of exactly 3 (one action per route, no `action` field needed from the client at all for 2 of the 3 routes since the route path IS the action).

### 502-collapse error handling (never differentiate error types)
**Source:** `zoho-middleware/routes/pos.js:4071-4074`
```javascript
.catch(function (err) {
  log.error('[batch/admin-proxy] ' + action + ' failed: ' + (err && err.message));
  res.status(502).json({ ok: false, error: 'server_error' });
});
```
**Apply to:** every new route added to `pos.js` this phase (admin proxy + all 3 batch-public routes).

### Reads-retry / writes-never-retry
**Source:** `js/brewpad.js:1711-1730` (`fetchWithRetry` with optional 4th `retryStatuses` param)
**Apply to:** `js/admin.js`'s rewritten `fetchWithRetry`/`adminApiGet`/`adminApiPost` (D-08). `js/batch.js` currently has NO retry wrapper at all (plain `fetch(...).then(...).catch(...)`) — CONTEXT does not ask for one to be added; do not introduce retry logic to batch.js unless explicitly planned, since D-12/D-13 say nothing about retry behavior for the public page.

### Token strip / server-side identity injection
**Source:** `zoho-middleware/routes/pos.js:4049-4053`
```javascript
var payload = Object.assign({}, body, { action: action, server_token: process.env.APPS_SCRIPT_SERVER_TOKEN });
delete payload.token;
```
**Apply to:** `/api/admin/proxy` only. `/api/batch/public/*` does NOT inject `server_token` — it forwards the client's `batch_token` unchanged (different identity model, D-13).

### Lock acquire/release shape
**Source:** `apps-script/adminApi.gs:1252-1256` (`acquireScriptLock`) + `createBatch`'s existing `try { ... } finally { lock.releaseLock(); }` wrapping (lines 2227 onward)
**Apply to:** `updateGiftCardInvoice` (new lock, D-18 fix 1) and `createBatch`'s dedup-guard relocation (D-18 fix 2) — two separate edits, same underlying lock idiom.

## No Analog Found

None. Every file this phase touches has a direct, already-shipped, same-repo analog (Phase 76's BrewPad transport migration), per RESEARCH.md's explicit framing: "the work here is mechanical repetition of that pattern onto two more surfaces." The only file with a partial analog is `tests/frontend/batch-public-proxy.test.js`, which needs to be assembled from two existing test files' patterns (harness from `brewpad-read-retry.test.js`, DOM-fixture style from `admin-session-auth.test.js`) rather than cloned from one — flagged above as role-match, not zero-match.

## Metadata

**Analog search scope:** `zoho-middleware/routes/pos.js`, `zoho-middleware/server.js`, `zoho-middleware/__tests__/batch-admin-proxy.test.js`, `apps-script/adminApi.gs`, `js/admin.js`, `js/brewpad.js`, `js/batch.js`, `js/sheets-config.js`, `js/admin-config.js`, `tests/frontend/{admin-session-auth,brewpad-read-retry}.test.js`
**Files scanned:** 11 (all read directly; no Glob/Grep-only files — every candidate analog was opened and excerpted)
**Pattern extraction date:** 2026-09-23
