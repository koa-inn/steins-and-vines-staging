# Phase 80: BrewPad waitlist — work the queue - Pattern Map

**Mapped:** 2026-09-04
**Files analyzed:** 8 (all modified, zero net-new files per RESEARCH.md's "Recommended Project Structure")
**Analogs found:** 8 / 8

No new files are created by this phase (RESEARCH.md is explicit: "No new files. All work lands
inside the existing four files Phase 78 already established as the pattern owners" — plus a fifth,
`zoho-middleware/lib/mailer.js`, discovered in this pass, and two test files that must be extended
rather than created fresh). Every "file" below is an existing file gaining new functions/routes/
rules. Analogs are therefore **sibling functions within the same file, or a structurally identical
function in a neighboring file** — not a different subsystem entirely.

## File Classification

| Modified File | Role | Data Flow | Closest Analog | Match Quality |
|----------------|------|-----------|-----------------|----------------|
| `apps-script/adminApi.gs` (`ensureWaitlistSheet`, `addWaitlistEntry`, `updateWaitlistStatus`, new `serializeWaitlistRecipeIds`/`parseWaitlistRecipeIds`) | model / migration | CRUD | same file's existing `ensureWaitlistSheet`/`addWaitlistEntry`/`updateWaitlistStatus` (Phase 78) | exact — extending, not replacing, the same functions |
| `zoho-middleware/routes/pos.js` (`ADMIN_PROXY_ACTIONS` entry) | config | request-response | same file's existing allow-list entries (`update_waitlist_status`, `get_waitlist`) | exact |
| `zoho-middleware/routes/pos.js` (NEW `POST /api/waitlist/:id/contact`) | controller/route | request-response (server-orchestrated, two-step) | `router.post('/api/batch/reassign-customer', ...)` (`pos.js:3622`) — same file, same auth tier, same "resolve then write" shape | role-match, strong |
| `zoho-middleware/lib/mailer.js` (NEW `sendWaitlistContact`) | service | request-response | same file's `sendBottlingInvite` (`:346-390`) | exact |
| `js/brewpad.js` — customer-link inline UI | component | CRUD (client-orchestrated read + write) | `fetchReassignSearch` (`:2088-2134`) + new-customer save handler (`:7743-7781`) | exact — explicit reuse per CONTEXT.md D-01 |
| `js/brewpad.js` — recipe-attach multi-select UI | component | CRUD (display-only) | `openRecipeAttachPanel`/`showAttachOptions` (`:5116-5239`) | role-match, strong (single→multi-select adaptation) |
| `js/brewpad.js` — contact-compose sheet UI | component | request-response | `openRecipeFromBatchSheet` (`:5241-5297`, `.bp-create-sheet` shape) | exact (sheet shell) |
| `js/brewpad.js` — pin/position UI + `sortWaitlistRows` extension | component/utility | transform (pure, render-time) | same file's existing `sortWaitlistRows`/`computeWaitlistQueuePositions` (`:985-1020`) + `openWaitlistNotesEdit` (`:8401-8410`) inline-editor shape | exact — extending the same function |
| `js/brewpad.js` — manual-add sheet UI | component | CRUD | `openRecipeFromBatchSheet` (`.bp-create-sheet` shape, `:5241-5297`) | role-match, strong |
| `css/brewpad.css` (additive rules) | config/style | n/a | `.bp-create-sheet`/`.bp-form-group`/`.bp-batch-chip-inline`/`.bp-reading-edit`/`.bp-reading-del` (existing tokens, see UI-SPEC Component Inventory) | exact — reuse verbatim, no new tokens |
| `zoho-middleware/__tests__/waitlist-admin-proxy.test.js` (flip `add_waitlist_entry` assertion) | test | n/a | same file's existing `update_waitlist_status`/`get_waitlist` test blocks | exact |
| NEW: `zoho-middleware/__tests__/waitlist-contact.test.js` (or added `describe` block in an existing waitlist test file) | test | n/a | `zoho-middleware/__tests__/waitlist-route.test.js` (server-boot mock harness) | role-match, strong |
| `tests/frontend/adminapi-waitlist-pure.test.js` (extend with `recipe_ids` parse/serialize) | test | n/a | same file's existing `new Function` source-extraction harness | exact |
| `tests/frontend/brewpad-waitlist.test.js` (extend with `sortWaitlistRows` position tests) | test | n/a | same file's existing `nextWaitlistStatus`/filter tests | exact |
| `docs/APPS_SCRIPT.md` (Waitlist section update) | docs | n/a | same doc's existing (stale) Waitlist section | exact |

---

## Pattern Assignments

### `apps-script/adminApi.gs` — `ensureWaitlistSheet` (schema/migration, D-17/D-18)

**Analog:** same function, current form (`apps-script/adminApi.gs:4868-4905`).

**Core pattern to extend** — header list is a flat array checked by name (order-independent), so
D-17's six new names are simply appended to `headerNames`:

```javascript
// Source: apps-script/adminApi.gs:4868-4905 (existing, VERIFIED)
function ensureWaitlistSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WAITLIST_SHEET_NAME);

  var headerNames = ['id', 'email', 'category', 'status', 'signed_up_at', 'mailerlite_synced', 'notes'];
  // D-17 EXTENSION: append, do NOT insert between existing names —
  //   .concat(['zoho_contact_id', 'customer_name', 'customer_phone', 'recipe_ids', 'position', 'contacted_at'])
  // Column ORDER doesn't matter for THIS function's name-based lookup (headers.indexOf(name)),
  // but see the addWaitlistEntry pitfall below — order DOES matter there.
  ...
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
    return { ok: false, error: 'waitlist_unavailable', missing: missing };
  }
  return { ok: true, sheet: sheet, headers: headers, col: col };
}
```

**Fail-closed pattern to preserve exactly:** missing any required header returns
`{ok:false, error:'waitlist_unavailable', missing:[...]}` and NEVER repairs headers itself
(D-18's non-negotiable ordering constraint depends on this staying unchanged).

---

### `apps-script/adminApi.gs` — `addWaitlistEntry` (must become header-driven, RESEARCH.md Pitfall 1)

**Analog:** same function, current (positional) form — this is the thing being fixed, not just
extended (`apps-script/adminApi.gs:5022-5068`).

**Bug being fixed, concrete:**

```javascript
// Source: apps-script/adminApi.gs:5056-5064 (existing, VERIFIED — the hazard)
var id = Utilities.getUuid();
ensured.sheet.appendRow([
  id,
  waitlistCellSafe(email),
  waitlistCellSafe(category),
  'waiting',
  new Date().toISOString(),
  false,
  ''
]);
```

**Pattern to copy for the fix** — `updateWaitlistStatus`'s header-driven `setValue` shape
(`adminApi.gs:5170-5181`, reproduced below) is the correct pattern already used elsewhere in this
same file. Convert `addWaitlistEntry`'s append to build a same-length array positioned via
`ensured.col[name]` (1-based) rather than a bare literal array, OR write the seven original cells
via `appendRow` as today and then `setValue` each of the six new D-17 defaults via `ensured.col`
indices (empty string / `false` / empty as appropriate) — either shape removes the positional
fragility permanently. `zoho_contact_id`/`customer_name`/`customer_phone`/`recipe_ids` route
through `waitlistCellSafe()` on write (D-19); `position` and `contacted_at` start empty on a new
row (D-11/D-25).

**Dedupe/reinstate pattern, unchanged, reuse verbatim:**

```javascript
// Source: apps-script/adminApi.gs:5039-5053 (existing, VERIFIED)
if (decision.action === 'existing') {
  if (waitlistShouldReinstate(decision.row)) {
    ensured.sheet.getRange(decision.row._row, ensured.col.status).setValue('waiting');
    ensured.sheet.getRange(decision.row._row, ensured.col.signed_up_at)
      .setValue(new Date().toISOString());
    invalidateSheetCache(WAITLIST_SHEET_NAME);
  }
  return { ok: true, id: decision.row.id };
}
```

**D-23 disclosure asymmetry:** `addWaitlistEntry` itself stays a single shared function (D-06
non-disclosure lives in what the *caller* does with the result, not in this function). The
existing `{ok:true, id:...}` return shape stays identical on both paths; D-23's plain disclosure
("already on the list, signed up X") must be composed by the **new middleware/admin-proxy caller**
for the staff path only, reading `decision.action === 'existing'` — do not add a disclosing field
to this function's return value, since the public `POST /api/waitlist` path also calls it and must
never see one (mirrors the existing `waitlistDedupeDecision` comment at `:5037-5038`).

---

### `apps-script/adminApi.gs` — `updateWaitlistStatus` (extend for six new optional fields, D-17/D-19, fold in IN-01)

**Analog:** same function's existing `hasStatus`/`hasNotes`/`hasSynced` shape
(`apps-script/adminApi.gs:5137-5187`) — copy the pattern once per new field, six times.

```javascript
// Source: apps-script/adminApi.gs:5144-5150, 5170-5181 (existing, VERIFIED)
var hasStatus = Object.prototype.hasOwnProperty.call(payload, 'status');
var hasNotes = Object.prototype.hasOwnProperty.call(payload, 'notes');
var hasSynced = Object.prototype.hasOwnProperty.call(payload, 'mailerlite_synced');
// EXTEND with one hasX per D-17 field:
//   hasZohoContactId, hasCustomerName, hasCustomerPhone, hasRecipeIds, hasPosition, hasContactedAt

if (!hasStatus && !hasNotes && !hasSynced /* && !hasZohoContactId && ... */) {
  return { ok: false, error: 'no_fields' };
}
...
if (hasStatus) {
  var statusCol = headers.indexOf('status') + 1;
  // IN-01 fold-in: route status through waitlistCellSafe() here too, matching notes below —
  // sheet.getRange(result.row, statusCol).setValue(waitlistCellSafe(payload.status));
}
if (hasNotes) {
  var notesCol = headers.indexOf('notes') + 1;
  sheet.getRange(result.row, notesCol).setValue(waitlistCellSafe(payload.notes));
}
// EXTEND: hasZohoContactId/hasCustomerName/hasCustomerPhone/hasRecipeIds all route through
// waitlistCellSafe() on write, exactly like notesCol above (D-19). hasPosition validates as a
// positive integer or empty before setValue (V5 in RESEARCH.md's Security Domain — do not trust
// client-side numeric input type alone). hasContactedAt writes an ISO string, same shape as
// signed_up_at elsewhere in this file.
```

**One-way transition guard — preserve exactly, do not bypass:**

```javascript
// Source: apps-script/adminApi.gs:5122-5135, 5163-5165 (existing, VERIFIED — D-07/D-08 depend on this)
function waitlistTransitionAllowed(current, next) {
  var ORDER = ['waiting', 'contacted', 'booked'];
  var cur = String(current === null || current === undefined ? '' : current).trim().toLowerCase();
  var nxt = String(next === null || next === undefined ? '' : next).trim().toLowerCase();
  var known = ORDER.concat(['removed']);
  if (known.indexOf(cur) === -1 || known.indexOf(nxt) === -1) return false;
  if (cur === nxt) return true;
  if (nxt === 'removed') return true;
  if (cur === 'removed') return false;
  return ORDER.indexOf(nxt) > ORDER.indexOf(cur);
}
// ... in updateWaitlistStatus:
if (hasStatus && !waitlistTransitionAllowed(result.data.status, payload.status)) {
  return { ok: false, error: 'invalid_transition' };
}
```

The NEW contact-send middleware endpoint (below) calls this SAME action
(`action: 'update_waitlist_status', status: 'contacted', contacted_at: ...`) — it must go through
this exact guard, not a new bypass path. `waiting → contacted` is already permitted; `contacted →
contacted` is already an allowed no-op (idempotent retry safety); `booked`/`removed` rows correctly
refuse the write (this is WHY the UI-SPEC disables the Contact button on those rows).

**WR-02 (optimistic locking) — explicitly OUT of this diff's scope** per RESEARCH.md Pitfall 4 /
Assumption A3, unless the owner amends D-17. Add a code comment near `updateWaitlistStatus`
documenting the accepted risk if not folded in — do not silently add or silently skip.

---

### `apps-script/adminApi.gs` — NEW pure helpers `serializeWaitlistRecipeIds`/`parseWaitlistRecipeIds` (D-15 discretion)

**Analog:** `waitlistDedupeDecision`'s purity contract (`apps-script/adminApi.gs:4958-5007`) — zero
references to `SpreadsheetApp`/`LockService`/`Session`/`CacheService`/`Logger`, testable via the
`new Function` source-extraction harness.

```javascript
// New, following the same purity discipline as waitlistDedupeDecision/waitlistShouldReinstate
function serializeWaitlistRecipeIds(ids) {
  return (ids || []).filter(function (id) { return id; }).join('|');
}
function parseWaitlistRecipeIds(value) {
  if (!value) return [];
  return String(value).split('|').filter(function (s) { return s !== ''; });
}
// Round-trip cases: [] -> '' -> []; ['SV-R-000003'] -> 'SV-R-000003' -> [...]; order preserved.
// Pipe is safe: recipe_id format is SV-R-000003 (generateNextId, adminApi.gs:3629) — no pipes possible.
```

---

### `zoho-middleware/routes/pos.js` — `ADMIN_PROXY_ACTIONS` (add `add_waitlist_entry`, write-only)

**Analog:** same file's existing allow-list block (`pos.js:3990-4027`).

```javascript
// Source: zoho-middleware/routes/pos.js:3990-4012 (existing, VERIFIED)
var ADMIN_PROXY_ACTIONS = {
  // reads
  get_batch: true,
  get_batches: true,
  get_batch_dashboard_summary: true,
  get_vessels: true,
  get_ferm_schedules: true,
  get_tasks_upcoming: true,
  get_waitlist: true,
  // writes
  create_batch: true,
  update_batch: true,
  ...
  update_waitlist_status: true
  // ADD: add_waitlist_entry: true   <-- write-only, per D-21/D-23; do NOT also add to
  //                                     ADMIN_PROXY_READS (pos.js:4019-4027) — V4 access control,
  //                                     the two-list split is deliberate (RESEARCH.md V4 row).
};
```

Also update `docs/APPS_SCRIPT.md:303`'s now-superseded "deliberately absent from both... would let
a session-tier caller inject arbitrary rows" paragraph alongside this change (RESEARCH.md Pitfall 5)
— it currently documents the OLD rule and will actively mislead the next reader if left as-is.

**Must update in lockstep:** `zoho-middleware/__tests__/waitlist-admin-proxy.test.js:182-186`'s
`add_waitlist_entry is rejected 400 invalid_action` test must flip to assert the opposite, WITH a
comment explaining Phase 80/D-21 reversed the Phase 78 premise (CLAUDE.md rule 10 exception,
explicitly authorized by this phase's context). Add new coverage alongside it for D-23's disclosure
asymmetry.

---

### `zoho-middleware/routes/pos.js` — NEW `POST /api/waitlist/:id/contact` (D-04–D-09, server-orchestrated send-then-write)

**Analog:** `router.post('/api/batch/reassign-customer', ...)` (`pos.js:3622-3654+`) — same file,
same staff-tier auth gate, same "resolve/act then conditionally write downstream" shape.

**Auth pattern (copy verbatim):**

```javascript
// Source: zoho-middleware/routes/pos.js:3622-3624 (existing, VERIFIED)
router.post('/api/batch/reassign-customer', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped (device rejected) — 46-04 interfaces.
```

**Error-normalization pattern (copy verbatim from the admin-proxy handler itself, `pos.js:4058-4065`):**

```javascript
upstream
  .then(function (resp) { res.json(resp.data); })
  .catch(function (err) {
    log.error('[batch/admin-proxy] ' + action + ' failed: ' + (err && err.message));
    res.status(502).json({ ok: false, error: 'server_error' });
  });
```

**New route sketch** (from RESEARCH.md Pattern 1, already validated against live code shapes —
send via `mailer.sendWaitlistContact`, THEN AND ONLY THEN write `update_waitlist_status` with
`status:'contacted', contacted_at:<now>` via the same `axios.post(process.env.APPS_SCRIPT_URL, ...)`
shape the admin-proxy handler already uses at `pos.js:4052-4056`):

```javascript
router.post('/api/waitlist/:id/contact', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
    var id = req.params.id;
    var body = req.body || {};
    mailer.sendWaitlistContact({ to: body.email, subject: body.subject, body: body.body, bookingUrl: body.bookingUrl })
      .then(function () {
        // D-08: ONLY on a resolved send promise does the status write happen.
        return axios.post(process.env.APPS_SCRIPT_URL, JSON.stringify({
          action: 'update_waitlist_status', server_token: process.env.APPS_SCRIPT_SERVER_TOKEN,
          id: id, status: 'contacted', contacted_at: new Date().toISOString()
        }), { headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 5 });
      })
      .then(function () { res.json({ ok: true }); })
      .catch(function (err) {
        res.status(502).json({ ok: false, error: 'contact_failed' });
      });
  });
});
```

**Booking-link source — reuse, do not add a new Cal.com call:**

```javascript
// Source: zoho-middleware/routes/bookings.js:133-166 (existing, VERIFIED — GET /api/bookings/services)
router.get('/api/bookings/services', async function (req, res) {
  ...
  var results = await Promise.all(ids.map(function (id) { return calcom.listEventType(Number(id)); }));
  serviceData = results.map(function (r) {
    var et = (r && r.data) || r || {};
    return { id: et.id, title: et.title, slug: et.slug, ..., bookingUrl: et.bookingUrl || '' };
  });
  ...
});
```

This endpoint is already public/unauthenticated and 24h-cached — BrewPad calls it CLIENT-SIDE to
build the D-05 template preview; only the final send goes through the new staff-tier endpoint.

---

### `zoho-middleware/lib/mailer.js` — NEW `sendWaitlistContact` (D-04–D-06)

**Analog:** `sendBottlingInvite` (`zoho-middleware/lib/mailer.js:346-390`) — nearly verbatim
precedent: Resend send, HTML+plaintext, `htmlEscape`, greeting-by-first-name.

```javascript
// Source: zoho-middleware/lib/mailer.js:346-390 (existing, VERIFIED)
function sendBottlingInvite(data) {
  var email = (data.email || '').trim();
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return Promise.reject(new Error('Invalid or missing customer email'));
  }
  var fullName = (data.name || '').trim();
  var greeting = fullName ? fullName.split(/\s+/)[0] : 'there';
  ...
  var htmlBody =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#2c2c2c;line-height:1.6;">' +
    '<p>Hi ' + htmlEscape(greeting) + ',</p>' +
    ...
    '<p style="margin:24px 0;"><a href="' + bookingUrl + '" ' +
    'style="background:#4a6f4b;color:#ffffff;text-decoration:none;padding:12px 22px;' +
    'border-radius:6px;font-weight:bold;display:inline-block;">Book...</a></p>' +
    '<p>Cheers,<br>Steins &amp; Vines</p></div>';
  var plainBody = 'Hi ' + greeting + ',\n\n' + ... ;
  return sendViaResend({ to: email, replyTo: 'hello@steinsandvines.ca', subject: subject, html: htmlBody, text: plainBody });
}
```

**IMPORTANT deviation from this analog (RESEARCH.md Pitfall 3):** `sendBottlingInvite` builds its
`bookingUrl` from a hardcoded `CALCOM_BOTTLING_BOOKING_URL` env var + manual query params — D-06
explicitly forbids this pattern for the waitlist email. `sendWaitlistContact` must accept a
**pre-resolved `bookingUrl`** as a parameter (sourced from `GET /api/bookings/services`'s
`listEventType`-backed cache, client-side or route-side) rather than constructing one itself.
Additionally, per D-05, `subject`/`body` are **staff-edited-and-passed-in**, not built fresh inside
this function — this function's job is "send exactly what's given," not "build the template."

**Primitive to call, unchanged:**

```javascript
// Source: zoho-middleware/lib/mailer.js:55-87 (existing, VERIFIED)
function sendViaResend(msg) {
  if (!isConfigured()) return Promise.reject(new Error('RESEND_API_KEY not set'));
  if (!msg.to) return Promise.reject(new Error('No recipient provided'));
  var payload = { from: msg.from || fromAddress(), to: Array.isArray(msg.to) ? msg.to : [msg.to], subject: msg.subject, text: msg.text };
  if (msg.html) payload.html = msg.html;
  if (msg.replyTo) payload.reply_to = msg.replyTo;
  return axios.post(RESEND_API + '/emails', payload, {
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    timeout: 15000
  }).then(function (res) { return res.data; })
    .catch(function (err) { throw new Error('Resend send failed: ' + describeError(err)); });
}
```

Add `sendWaitlistContact` to `module.exports` alongside the other named exports (`mailer.js:392+`).

---

### `js/brewpad.js` — Customer-link inline UI (D-01–D-03a)

**Analog 1 — search:** `fetchReassignSearch` (`js/brewpad.js:2088-2134`), reused with a per-row id
namespace swap (`bp-reassign-*` → `bp-waitlist-link-{id}-*`, per UI-SPEC Component Inventory).

```javascript
// Source: js/brewpad.js:2093-2116 (existing, VERIFIED)
fetch(mwUrl() + '/api/contacts/search?q=' + encodeURIComponent(term), { credentials: 'include' })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    var contacts = data.contacts || [];
    if (contacts.length === 0) {
      resultsEl.innerHTML = '<div class="bp-so-result-item" ...>No matching customers found</div>';
      return;
    }
    // renders .bp-reassign-result-item[data-contact-id][data-name][data-email][data-phone],
    // click sets a pending-selection object and submits
  });
```

**Analog 2 — create inline:** new-customer save handler (`js/brewpad.js:7743-7781`).

```javascript
// Source: js/brewpad.js:7754-7759 (existing, VERIFIED — exact D-01 create-half reuse)
fetch(base + '/api/contacts', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: name, first_name: firstName, last_name: lastName, email: email, phone: phone })
})
  .then(function (r) { return r.json(); })
  .then(function (data) {
    if (data.contact_id) { /* populate fields, hide form, showToast('Customer added','success') */ }
    else { showToast(data.error || 'Failed to create customer', 'error'); }
  })
  .catch(function () { showToast('Failed to create customer', 'error'); });
```

**D-02 write-through:** on either success path, write `zoho_contact_id`/`customer_name`/
`customer_phone` via `adminApiPost('update_waitlist_status', {id, zoho_contact_id, customer_name,
customer_phone})` — see `adminApiPost` below. **D-03a guard:** before writing `customer_phone`,
check the row's existing `customer_phone` is empty; if a staff member already typed a phone during
manual add, a subsequent Zoho link must NOT overwrite it.

**Write call pattern to reuse verbatim:**

```javascript
// Source: js/brewpad.js:1694-1711 (existing, VERIFIED)
function adminApiPost(action, payload) {
  payload = payload || {};
  payload.action = action;
  return fetchWithRetry(mwUrl() + '/api/batch/admin-proxy', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok || !data || !data.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
      return data;
    });
  });
}
```

---

### `js/brewpad.js` — Recipe multi-select attach UI (D-15/D-16)

**Analog:** `openRecipeAttachPanel`/`showAttachOptions` (`js/brewpad.js:5116-5239`) — **adapt from
single-select-with-detail-resolve to multi-select-display-only** (RESEARCH.md Pattern 3 / Pitfall 2:
do NOT reuse `_recipesState.list`, it may be unloaded if staff go straight to Waitlist).

```javascript
// Source: js/brewpad.js:5145-5170 (existing, VERIFIED — own-lazy-fetch, independent cache)
function showAttachOptions(term) {
  if (!_catalog) {
    dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">Loading recipes…</div>';
    fetch(mwUrl() + '/api/recipes?status=active', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) { _catalog = data.recipes || []; showAttachOptions(term); })
      .catch(function () { _catalog = []; showAttachOptions(term); });
    return;
  }
  var matches = _catalog.filter(function (r) {
    if (!term) return true;
    return ((r.name || '') + ' ' + (r.style || '')).toLowerCase().indexOf(term.toLowerCase()) !== -1;
  }).slice(0, 15);
  dropdown.innerHTML = matches.length === 0
    ? '<div class="bp-vessel-option bp-vessel-option--empty">No recipes found</div>'
    : matches.map(function (r) {
        return '<div class="bp-vessel-option" data-rid="' + escapeHTML(r.recipe_id || '') +
          '" data-rname="' + escapeHTML(r.name || '') + '">' + escapeHTML(r.name || '') + '</div>';
      }).join('');
  // DEVIATION for D-15/D-16: on click, do NOT fetch /api/recipes/{id} detail (no resolve step) —
  // just append { recipe_id: rid, name: rname } to the row's attached-recipes local array and
  // write recipe_ids via serializeWaitlistRecipeIds() through adminApiPost, same as customer-link.
}
```

**Chip rendering — reuse `.bp-batch-chip-inline` verbatim** (css/brewpad.css:1519-1522), each with
an appended `×` carrying `aria-label="Remove {recipe name}"` (per UI-SPEC Copywriting Contract).

---

### `js/brewpad.js` — Contact-compose sheet + Manual-add sheet (D-04–D-09, D-21–D-25)

**Analog:** `openRecipeFromBatchSheet`'s `.bp-create-sheet` shell (`js/brewpad.js:5241-5297`) —
reuse verbatim for BOTH new sheets, per UI-SPEC Component Inventory (`bp-waitlist-contact-sheet`,
`bp-waitlist-add-sheet`).

```javascript
// Source: js/brewpad.js:5249-5299 (existing, VERIFIED — sheet shell shape)
var appEl = document.getElementById('bp-app') || document.body;
var sheetEl = document.createElement('div');
sheetEl.id = 'bp-recipe-create-sheet';        // -> re-id per new sheet
sheetEl.className = 'bp-create-sheet';
sheetEl.innerHTML =
  '<div class="bp-create-sheet-inner" id="...">' +
  '<div class="bp-create-sheet-header">' +
  '<span class="bp-create-sheet-title">...</span>' +
  '<button type="button" class="bp-create-sheet-close" id="...">×</button>' +
  '</div>' +
  '<div class="bp-create-sheet-body" id="...">' +
    '<div class="bp-form-group"><label>Name <span class="bp-required">*</span></label>' +
    '<input type="text" id="..." class="bp-inline-input" required></div>' +
    '<div class="bp-form-actions">' +
    '<button type="button" class="btn" id="...">Save</button>' +
    '<button type="button" class="btn-secondary" id="...">Cancel</button>' +
    '</div></div></div>';
appEl.appendChild(sheetEl);

function closeSheet() {
  sheetEl.classList.remove('bp-create-sheet--open');
  setTimeout(function () { if (sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl); }, 180);
}
setTimeout(function () { sheetEl.classList.add('bp-create-sheet--open'); }, 10);
sheetEl.addEventListener('click', function (e) { if (e.target === sheetEl) closeSheet(); });
```

**D-08 send-failure — inline in the sheet, not a toast** (per UI-SPEC): on `POST
/api/waitlist/:id/contact` rejection, keep the sheet open, show inline `--batch-danger` text, re-
enable Send. On success, close the sheet and `showToast('Email sent — marked Contacted', 'success')`.

**D-23 disclosure — sheet-state swap, not a new sheet** (per UI-SPEC Phase-Specific Decision 4):
on a dedupe-match response from the manual-add write, swap `.bp-create-sheet-body`'s `innerHTML`
from the form to the disclosure message + single `.btn-secondary` "Got It" — same container, no
new chrome, matching how `renderWaitlist()` already swaps `#bp-panel-waitlist`'s inner content
between loading/empty/populated states (`js/brewpad.js:8246-8342`, reproduced under `renderWaitlist`
below).

---

### `js/brewpad.js` — Pin/position UI (D-10–D-14)

**Analog 1 — the sort function itself, extend in place:**

```javascript
// Source: js/brewpad.js:985-1002 (existing, VERIFIED, unmodified signature)
function sortWaitlistRows(rows) {
  var input = rows || [];
  var indexed = [];
  for (var i = 0; i < input.length; i++) indexed.push({ row: input[i], i: i });
  indexed.sort(function (a, b) {
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
  return indexed.map(function (x) { return x.row; });
}
```

**RESEARCH.md's recommended merge-insert extension** (split pinned/unpinned BEFORE this existing
chronological sort runs, then splice pinned rows into their target index — full sketch in
`80-RESEARCH.md` Architecture Patterns → Pattern 2, lines 264-291). `computeWaitlistQueuePositions`
(`:1008-1020`) needs no changes — it walks whatever array `sortWaitlistRows` returns.

**Analog 2 — inline set-position editor, reuse the notes-editor transform verbatim:**

```javascript
// Source: js/brewpad.js:8401-8410 (existing, VERIFIED — cell-becomes-editor shape)
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
```

For position: `type="number" min="1" step="1"` per UI-SPEC, same Save/× button pair, writes via
`adminApiPost('update_waitlist_status', {id, position})`; clearing writes `{id, position: ''}` or
`null` (D-12 — server side must accept empty as "unpin").

**Clear-pin button — reuse `.bp-reading-del` verbatim** (`css/brewpad.css:1476,1481`), pin-icon
button composed from `.bp-reading-edit`'s sizing/hover with a `📌` glyph instead of `✎`.

---

### `js/brewpad.js` — `renderWaitlist()` (extend for +2 columns, Customer/Recipes/Contact cells)

**Analog:** same function, current 7-column form (`js/brewpad.js:8246-8342`).

```javascript
// Source: js/brewpad.js:8288-8318 (existing, VERIFIED — table body pattern to extend)
html += '<table class="bp-active-batches-table" aria-label="Beer waitlist">';
html += '<thead><tr><th>#</th><th>Email</th>';
if (showCategory) html += '<th>Category</th>';
html += '<th>Signed up</th><th>Status</th><th>Notes</th><th></th></tr></thead>';
html += '<tbody>';
filtered.forEach(function (row) {
  var pos = row.id != null ? posById[row.id] : null;
  ...
  html += '<tr>';
  html += '<td class="bp-waitlist-pos">' + (pos != null ? pos : '—') + '</td>';
  html += '<td>' + escapeHTML(row.email) + syncBadge + '</td>';
  // EXTEND: Customer cell absorbs the D-02 "{Name} — {email} — {phone}" display + Link/Change
  //         trigger; new Recipes cell (chips); new Contact cell (button, disabled per row.actionable)
  ...
  html += '</tr>';
});
html += '</tbody></table>';
```

Per UI-SPEC Phase-Specific Decision 1, wrap the table in a new `.bp-waitlist-table-wrap`
(`overflow-x:auto; -webkit-overflow-scrolling:touch`), copying `#bp-recipes-ingredients-editor`'s
scroll-wrap pattern (`css/brewpad.css:2448-2457`) verbatim — do not shrink cell padding/font-size.

**Actionable predicate to reuse for the Contact button (UI-SPEC Phase-Specific Decision 3):**

```javascript
// Source: js/brewpad.js:8298 (existing, VERIFIED)
var actionable = status !== 'booked' && status !== 'removed';
```

---

### Manual-add toolbar trigger (D-21)

**Analog:** the existing "+ New Batch" toolbar button (`js/brewpad.js:4049` region;
`css/brewpad.css:596-602`) — reuse `.btn bp-new-batch-btn` verbatim, placed in `.bp-tasks-toolbar`
next to Search/Refresh (`renderWaitlist`'s existing toolbar block, `js/brewpad.js:8262-8265`).

---

## Shared Patterns

### Staff-tier auth gate (applies to the new middleware route AND the extended admin-proxy action)
**Source:** `zoho-middleware/routes/pos.js:3622-3624` (and identically at `4029-4030`)
**Apply to:** `POST /api/waitlist/:id/contact`, `add_waitlist_entry`'s admin-proxy path
```javascript
authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // device tier explicitly excluded — staff-only, mirrors T-76-02-03
});
```

### Admin-proxy write shape (applies to every new waitlist field written from BrewPad)
**Source:** `js/brewpad.js:1694-1711` (`adminApiPost`)
**Apply to:** customer-link write, recipe-attach write, pin/clear-pin write, all route through
`adminApiPost('update_waitlist_status', {id, ...})` — never a bespoke fetch call per feature.

### Formula-injection guard (D-19, applies to every new free-text cell)
**Source:** `apps-script/adminApi.gs:4931-4938` (`waitlistCellSafe`)
```javascript
function waitlistCellSafe(value) {
  var sanitized = sanitizeInput(value);
  var firstChar = sanitized.charAt(0);
  if (firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@') {
    return "'" + sanitized;
  }
  return sanitized;
}
```
**Apply to:** `zoho_contact_id`, `customer_name`, `customer_phone`, `recipe_ids`, `notes`, `status`
(IN-01 fold-in) — every free-text cell write in `addWaitlistEntry`/`updateWaitlistStatus`.

### One-way status guard (D-07/D-08, applies to the new contact-send endpoint)
**Source:** `apps-script/adminApi.gs:5122-5135` (`waitlistTransitionAllowed`) — see full excerpt
above under `updateWaitlistStatus`. The new endpoint's post-send write MUST route through this
same server-side guard (it already does, by calling the same `update_waitlist_status` action) —
never add a second code path that writes `status` directly.

### Toast (success/error, sitewide)
**Source:** `js/brewpad.js:1215-1235` (`showToast`)
```javascript
showToast('Failed: ' + err.message, 'error');   // sitewide convention, reuse verbatim
showToast('Customer linked', 'success');
```
**Apply to:** every new success/error state EXCEPT the D-08 contact-send failure, which per UI-SPEC
must render inline in the sheet, not as a toast (transient toasts risk exactly the "did it fail?"
confusion D-08 exists to prevent).

### Confirm sheet (sitewide, NOT used for the new reversible actions)
**Source:** `js/brewpad.js:4432-4467` (`showConfirmSheet`)
**Apply to:** nothing new this phase — explicitly NOT used for clearing a pin (D-12, reversible) or
removing a recipe chip (D-15, reversible); both write immediately on tap, matching the low-friction
bar Phase 78 set for notes edits.

### Sheet shell (`.bp-create-sheet`)
**Source:** `js/brewpad.js:5241-5297` + `css/brewpad.css:1201-1290`
**Apply to:** Contact review sheet, Manual Add sheet — both reuse this shell verbatim, re-id'd.

---

## No Analog Found

None. Every file/function this phase touches has a same-file or same-role sibling analog — this
phase is explicitly "wiring, not invention" per RESEARCH.md's Summary; no capability requires a
pattern from outside the existing BrewPad/Apps-Script/middleware codebase.

---

## Metadata

**Analog search scope:** `apps-script/adminApi.gs` (waitlist section, lines 4868-5193),
`js/brewpad.js` (waitlist panel + reassign/recipe-attach/sheet/toast/confirm-sheet helpers, lines
985-1044, 1215-1235, 1669-1715, 2088-2134, 4432-4467, 5116-5299, 6160-6182, 7730-7782, 8246-8422),
`zoho-middleware/routes/pos.js` (admin-proxy + contacts/search + reassign-customer, lines 3576-4067),
`zoho-middleware/routes/bookings.js` (contacts POST + bookings/services GET, lines 133-175, 391-465),
`zoho-middleware/lib/mailer.js` (full file, esp. 1-95, 340-393), `zoho-middleware/lib/calcom.js`
(1-58), `css/brewpad.css` (token classes cited above), plus four existing test files
(`waitlist-admin-proxy.test.js`, `adminapi-waitlist-pure.test.js`, `brewpad-waitlist.test.js`,
`mailer.test.js`) as testing-pattern analogs.

**Files scanned:** 8 modified files + 4 test-pattern analogs, all read directly this session (no
excerpt below is copied from RESEARCH.md without independent verification against current line
numbers).

**Pattern extraction date:** 2026-09-04
