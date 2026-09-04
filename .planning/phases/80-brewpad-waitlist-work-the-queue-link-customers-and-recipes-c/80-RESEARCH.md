# Phase 80: BrewPad waitlist — work the queue - Research

**Researched:** 2026-09-04
**Domain:** Google Apps Script (Sheets-backed staff list) + Express/Railway middleware + vanilla-ES5 BrewPad frontend — extending the Phase 78 waitlist
**Confidence:** HIGH (every claim below was verified by reading the actual current source, not from Phase 78 documentation, which is in places stale — see Pitfall 6)

## Summary

Phase 78 shipped a working, CR-01/CR-02-hardened waitlist. This phase does not introduce new technology or new external services — everything it needs (contact search/create, Resend email, Cal.com event-type lookup, the recipe catalog, the confirm-sheet/toast/inline-editor UI primitives) already exists and is already live elsewhere in this codebase. The job is wiring, not invention. The single biggest risk is not a missing library — it's the **one Apps Script redeploy that serves both staging and production with no CI gate**, landing six new columns and a rewritten `addWaitlistEntry`/`updateWaitlistStatus` pair correctly, in an order that never 503s a live public signup.

Three findings materially change how this phase should be planned, none of them anticipated by CONTEXT.md's decisions:

1. **`addWaitlistEntry`'s new-row write is POSITIONAL, not header-driven.** `ensureWaitlistSheet` looks up columns by name (order-independent, confirming D-18), but `addWaitlistEntry` itself calls `sheet.appendRow([id, email, category, status, signed_up_at, mailerlite_synced, notes])` — a bare 7-element array. If the six new D-17 columns are inserted *anywhere except after* column G (`notes`), every new public signup silently corrupts itself the moment the code (not just the sheet) is live. This is a hard, non-negotiable ordering rule the cutover runsheet must state explicitly, on top of D-18's "add columns first."
2. **`add_waitlist_entry` is deliberately absent from both admin-proxy whitelists, and an existing test asserts that absence by name.** `zoho-middleware/__tests__/waitlist-admin-proxy.test.js` line 182 explicitly checks `add_waitlist_entry is rejected 400 invalid_action — never reachable from BrewPad`. D-21 (manual add) requires exactly the opposite. This is not a "the plan happens to touch a test" situation — it is a **pre-existing regression test whose premise D-21 invalidates**, and the plan must update it deliberately (with a comment explaining why), not accidentally.
3. **The "contact" action (D-04–D-09) cannot be safely built as a client-orchestrated two-call sequence.** The Resend API key must never reach the browser (same doctrine as `CALCOM_API_KEY`, same doctrine as Phase 46/SEC-02's "no shared secret shipped to the browser"), and D-07/D-08's fail-closed sequencing ("status advances *only* on confirmed send, never on a maybe") is only safe if send-then-write happens inside one server-side request. This phase needs **one new middleware endpoint** that does both steps itself; it cannot be built as "BrewPad calls Resend, then BrewPad calls `update_waitlist_status`."

**Primary recommendation:** build the customer-link and recipe-attach UI as pure client-side reuse of already-public endpoints (`/api/contacts/search`, `POST /api/contacts`, `GET /api/recipes?status=active`) writing through the existing (extended) `update_waitlist_status` action; add exactly one new staff-tier middleware endpoint for the contact-send (send via Resend, then and only then advance status); implement queue-position as a render-time merge-insert that never renumbers stored data; and treat the Apps Script redeploy as a single, carefully ordered production release exactly as Phase 78's runsheet modeled, but this time record the rollback version numbers Phase 78 forgot.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Customer search/link (D-01/D-02/D-03) | Browser/Client (BrewPad) | API/Backend (`/api/contacts/search`, `POST /api/contacts` — pre-existing, unauthenticated-but-staff-only-reachable) | Both endpoints already exist and are already called from BrewPad (`fetchReassignSearch`, inline new-customer form); no new backend code needed, only a new call site and a new write of the returned `contact_id`/`name`/`phone` into the Waitlist row |
| Recipe attach (D-15/D-16) | Browser/Client (BrewPad) | API/Backend (`GET /api/recipes?status=active` — pre-existing) | Same pattern as the Batches-tab recipe-attach dropdown (`js/brewpad.js:5140-5188`); display-only, no batch/stock linkage |
| Contact email send (D-04–D-09) | API/Backend (new middleware endpoint) | Database/Storage (Apps Script `update_waitlist_status`, extended) | Must live server-side: `RESEND_API_KEY` and `CALCOM_API_KEY` are server-only secrets (CLAUDE.md security posture, mirrors SEC-02); the send-then-conditionally-write sequence must be atomic from the client's point of view |
| Queue override / position (D-10–D-14) | Browser/Client (BrewPad render/sort) | Database/Storage (`position` column, written via extended `update_waitlist_status`) | Sorting/merge logic is pure and client-renderable exactly like today's `sortWaitlistRows`; the stored value is a single per-row integer, never renumbered elsewhere |
| Manual add (D-21–D-25) | Browser/Client (BrewPad form) | API/Backend (admin-proxy → `add_waitlist_entry`, newly whitelisted for writes only) | Distinct from the public `POST /api/waitlist` path — reuses the same Apps Script handler but reached via the staff-session admin-proxy, requiring a caller-aware response for D-23's disclosure asymmetry |
| Schema/migration (D-17–D-20) | Database/Storage (`Waitlist` sheet + `adminApi.gs`) | — | Single owner-run redeploy; see Pitfall 1/6 below for the two ordering hazards beyond what D-18 already covers |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

**Customer linking**
- D-01: Staff can link an existing Zoho contact OR create one inline from the waitlist row. Both halves already exist in BrewPad and should be reused, not rebuilt.
- D-02: The sheet stores `zoho_contact_id` + `customer_name` + `customer_phone`. Name and phone are denormalized display caches (no per-row Zoho lookup on load). Phone is surfaced because staff need to call someone straight from the queue. *(Owner decision, revising an earlier draft that excluded phone; a customer name and phone now live in a Google Sheet that staging and production share — the email was already there, this widens it.)*
- D-03: The cached `customer_name`/`customer_phone` may go stale if the contact is edited in Zoho — accepted, they are display conveniences, never identifiers. `zoho_contact_id` is the only thing anything keys off.
- D-03a: Phone is populated either from the linked Zoho contact at link time or typed directly during a manual add (D-21). Linking a contact must NOT silently overwrite a non-empty manually-entered phone.

**Contact action**
- D-04: The contact email sends via Resend (`zoho-middleware/lib/mailer.js`), NOT MailerLite — MailerLite honours unsubscribes and is marketing email; a customer who unsubscribed must still receive "your spot is ready."
- D-05: The email is templated and reviewable before sending — staff see the resolved subject/body, can edit, then send. Not a blind fire.
- D-06 (this phase's D-06 — see note below on numbering collision): The email carries a Cal.com booking link so the customer self-books. `calcom.js` is used ONLY to resolve the correct event-type link (`listEventType`). `getSlots`/`createBooking` are explicitly out of scope.
- D-07: On a confirmed successful send, the row's status auto-advances to `contacted`. Forward-only and safe by construction — `waitlistTransitionAllowed` already permits `waiting → contacted`, treats `contacted → contacted` as an allowed no-op, and refuses backward.
- D-08: If the send fails, the status does not change. Fail-closed.
- D-09: The row records when it was last contacted (`contacted_at`).

**Queue override**
- D-10: A `position` column that is normally empty. Rows with no position sort by `signed_up_at`; setting a position pins that row, unpinned rows flow chronologically around it.
- D-11: New signups always append unpinned, at the natural chronological end.
- D-12: Clearing a position restores true signup order for that row.
- D-13: A pinned row is visibly marked in BrewPad with a control to clear the pin.
- D-14: `beer.html` copy is NOT changed ("we work through the list in order" stays true unless someone intervenes).

**Recipe attachment**
- D-15: A row can carry multiple recipes, attachable/changeable at any time regardless of status.
- D-16: Recipes are display-only in this phase. Nothing downstream reads them.

**Manual add**
- D-21: Staff can add someone to the waitlist directly from BrewPad. Fields: email (required), plus optional phone, name, recipes.
- D-22: Email remains required and remains the dedupe key, exactly as the public form. No phone-only rows.
- D-23: A manual add is NOT subject to Phase 78's D-06 non-disclosure rule — staff SHOULD be told plainly if the person is already on the list, and when they signed up. **Phase 78's D-06 remains fully intact on the public `POST /api/waitlist` path.**
- D-24: A manual add syncs to MailerLite fire-and-forget exactly like a public signup, setting `mailerlite_synced` the same way.
- D-25: `signed_up_at` for a manual add is the moment staff add them; use pinning (D-10), not backdating, to reflect earlier interest.

**Schema and migration (non-negotiable)**
- D-17: The `Waitlist` tab gains: `zoho_contact_id`, `customer_name`, `customer_phone`, `recipe_ids`, `position`, `contacted_at`.
- D-18: MIGRATION ORDER IS LOAD-BEARING — add the columns to the sheet FIRST, then redeploy the Apps Script. `ensureWaitlistSheet` fails closed on any missing required column, returning `waitlist_unavailable` and never repairing headers. Deploying new code before the columns exist takes every public signup down with a 503. The reverse order is safe — existing code maps by header name and ignores unknown columns.
- D-19: All new user-controlled cell writes go through `waitlistCellSafe`.
- D-20: One phase, one migration, one redeploy — `adminApi.gs` has no CI deploy path, and a single Web App deployment serves staging AND production simultaneously.

### Claude's Discretion
- `recipe_ids` storage format — a delimiter (pipe recommended), pure unit-tested parse/serialize helper, must round-trip empty/single/order-preserved lists.
- `position` numeric scheme — sparse integers vs fractional insertion vs renumber-on-write; any is acceptable provided pinning a row never rewrites unrelated rows' `signed_up_at`.
- Whether `customer_name` opportunistically refreshes when a row is next written for another reason.
- Exact template wording for the contact email — draft it, then surface for owner approval during the cutover plan.

### Deferred Ideas (OUT OF SCOPE)
- Booking on the customer's behalf from BrewPad (`createBooking`).
- Live availability embedded in the contact email (`getSlots`).
- Ingredient-stock advisory from attached recipes.
- Batch pre-fill when a row is booked.
- Inbound reply handling in BrewPad.
- Generalising the waitlist UI to cider/wine/classes.
- Automated MailerLite re-sync/reconciliation.
- Recording WHO moved a row and WHY (queue-override audit trail).
- Softening `beer.html`'s "we work through the list in order" copy.

</user_constraints>

## Project Constraints (from CLAUDE.md)

- **Vanilla ES5 only** in `js/brewpad.js` — no `const`/`let`/arrow functions/template literals. `npm run lint` runs `eslint js/ --max-warnings 0`; any ES6 syntax fails the gate.
- **`js/brewpad.min.js` / `css/brewpad.min.css` are build artifacts** — never edit directly. Unlike the numbered `js/modules/*` files, `js/brewpad.js` is NOT concatenated into `js/main.js` (it is served standalone by `brewpad.html`), but it IS still minified by `npm run build` (`minify:js`/`minify:css` invoke `terser`/`cleancss` on it directly) — run `npm run build` after any `js/brewpad.js` or `css/brewpad.css` edit.
- **Before every commit:** `npm test` AND `cd zoho-middleware && npm test` must both pass; `npm run lint` must be clean (both root and `zoho-middleware/`).
- **Write a regression test FIRST when fixing a bug** — applies if this phase folds in the IN-01 fix (see Pitfall 4) or the WR-02 optimistic-lock question.
- **Read existing code/tests and grep for usages before modifying** — the existing `waitlist-admin-proxy.test.js` assertion about `add_waitlist_entry` (see Pitfall 5) is exactly the kind of thing this rule is meant to catch.
- **Security:** never commit `.env`/credentials. `RESEND_API_KEY`/`CALCOM_API_KEY` are Railway env vars, never sent to the browser — the contact-send flow must be server-orchestrated (see Architecture Patterns → Pattern 1).
- **CSP:** `brewpad.html` is staff-only (not a public page). No CSP `<meta>` update is required for this phase (confirmed by 78-UI-SPEC.md's CSP Note and re-confirmed here — nothing in this phase touches a public HTML page's `<head>`).
- **Middleware:** always `cd zoho-middleware` before running middleware commands; it has its own `node_modules`.

## Standard Stack

### Core

No new libraries. Every capability this phase needs is served by dependencies already installed and already in production use:

| Library | Version (installed) | Purpose | Why Standard (here) |
|---------|---------|---------|--------------|
| `axios` | already a `zoho-middleware` dependency | HTTP calls from middleware → Apps Script / Resend / Cal.com | Used identically by every existing Apps-Script-calling route (`gift-cards.js`, `recipes.js`, `server.js`'s `/api/waitlist`) |
| Google Apps Script V8 runtime | n/a (hosted) | `Waitlist` sheet CRUD | Same runtime Phase 78/51 already extended |
| Resend HTTPS API | n/a (external service, already integrated via `lib/mailer.js`) | Transactional contact email | `sendBottlingInvite` is a near-identical existing precedent (Cal.com link + Resend + HTML/plain-text body) — see Code Examples |
| Cal.com API v2 | n/a (external service, already integrated via `lib/calcom.js`) | Resolve booking link | `listEventType` already live via `GET /api/bookings/services` |

**Version verification:** `[VERIFIED: package.json]` — no `npm install` is needed for this phase. Confirmed by reading `zoho-middleware/lib/mailer.js` and `zoho-middleware/lib/calcom.js`: both use only `axios` and Node built-ins (`crypto`), both already `require`d elsewhere in `zoho-middleware`.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Resend | MailerLite | Rejected by D-04 — marketing email honours unsubscribes, would silently drop the one transactional message that must arrive |
| `listEventType` + `bookingUrl` | Hardcoded booking URL (the `sendBottlingInvite` pattern — `CALCOM_BOTTLING_BOOKING_URL` env var + manual `?name=&email=` query params) | D-06 explicitly requires `listEventType`; the hardcoded-URL pattern is a *different*, older precedent in this same codebase (`mailer.js:359-363`) — flagged as an inconsistency in Pitfall 3, not a recommendation to copy |
| `sortWaitlistRows` position field as absolute final rank (recommended, see below) | Fractional/"Lexorank"-style insertion keys | Fractional keys avoid ever touching other rows' cells too, but add float-precision/rebalance complexity this queue's scale (tens of rows) doesn't need — see Code Examples |

## Package Legitimacy Audit

**This phase installs no new npm, pip, or other external packages.** Every capability is served by `axios` (already installed) calling three already-integrated external services (Google Apps Script, Resend, Cal.com), all three already in production use elsewhere in this codebase. `slopcheck`/registry verification is not applicable — there is nothing new to verify.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ BrewPad (js/brewpad.js, browser, ES5)                                   │
│                                                                           │
│  Waitlist tab                                                           │
│   ├─ [Link customer] ──► GET /api/contacts/search?q=  (existing,public) │
│   │                  ──► POST /api/contacts            (existing,public)│
│   │                       │ returns {contact_id}                        │
│   │                       ▼                                             │
│   ├─ [Attach recipes] ──► GET /api/recipes?status=active (existing)     │
│   │                       │ local lazy-loaded catalog (own fetch,       │
│   │                       │ NOT dependent on the Recipes tab having     │
│   │                       │ been opened this session — see Pitfall 2)   │
│   │                       ▼                                             │
│   ├─ [Contact / send] ──► POST /api/waitlist/:id/contact  (NEW, staff)  │
│   │                       │                                             │
│   ├─ [Pin / move]     ──► adminApiPost('update_waitlist_status',        │
│   │                         {id, position})           (extended)        │
│   ├─ [Manual add]     ──► adminApiPost('add_waitlist_entry', {...})     │
│   │                         (NEW admin-proxy whitelist entry — write)   │
│   └─ [Read queue]     ──► adminApiGet('get_waitlist')  (extended field  │
│                             allowlist)                                  │
└──────────────┬─────────────────────────────┬────────────────────────────┘
               │ session-tier only            │ session-tier only, NEW
               ▼                              ▼
┌──────────────────────────────┐   ┌────────────────────────────────────┐
│ /api/batch/admin-proxy       │   │ NEW: POST /api/waitlist/:id/contact │
│ (zoho-middleware/routes/     │   │ (zoho-middleware/routes/pos.js,     │
│  pos.js) — generic action    │   │  staff-tier gated)                  │
│  passthrough, two whitelists │   │                                     │
└──────────────┬────────────────┘  │  1. resolve template server-side    │
               │                   │     (or accept staff-edited body    │
               ▼                   │     from client — D-05)             │
┌──────────────────────────────┐   │  2. mailer.sendViaResend(...)       │
│ Google Apps Script            │   │     ── FAILS → 502, NOTHING else   │
│ (apps-script/adminApi.gs)     │   │        happens (D-08)               │
│  update_waitlist_status       │   │  3. ONLY on confirmed send:         │
│  add_waitlist_entry           │   │     axios→Apps Script               │
│  get_waitlist                 │◄──┼─────update_waitlist_status          │
│  (Waitlist sheet, 13 cols     │   │     {status:'contacted',            │
│   after D-17)                 │   │      contacted_at: now}             │
└────────────────────────────────┘  └────────────────────────────────────┘
               ▲
               │ (unauthenticated, server-token) — unchanged from Phase 78
┌──────────────────────────────┐
│ POST /api/waitlist            │  ← public signup path, NOT touched by
│ (zoho-middleware/server.js)   │    this phase except for column-order
└──────────────────────────────┘    safety in addWaitlistEntry (Pitfall 1)
```

### Recommended Project Structure

No new files. All work lands inside the existing four files Phase 78 already established as the pattern owners:

```
apps-script/adminApi.gs          # ensureWaitlistSheet (13 headers), addWaitlistEntry
                                  # (fix positional appendRow → header-driven),
                                  # updateWaitlistStatus (extend hasX pattern for 6
                                  # new fields, run waitlistTransitionAllowed as today)
zoho-middleware/routes/pos.js    # ADMIN_PROXY_ACTIONS += add_waitlist_entry (write-only);
                                  # NEW: POST /api/waitlist/:id/contact
js/brewpad.js                    # Waitlist panel: customer-link UI, recipe-attach UI,
                                  # contact-compose UI, pin/position UI, manual-add form
css/brewpad.css                  # additive rules only, reuse existing tokens (per
                                  # 78-UI-SPEC.md's spacing/color/typography contract)
```

### Pattern 1: Server-orchestrated send-then-write (the contact action, D-04–D-09)

**What:** A single new middleware endpoint performs the Resend send AND the conditional Apps Script status write, in that order, inside one request handler. The client never calls Resend or Cal.com directly, and never makes two separate calls that could be interrupted between them.

**When to use:** Any action where "did X happen" must gate "is Y now true," and where the client cannot be trusted to sequence two calls correctly (dropped connection, backgrounded tab, etc.).

**Existing precedent to copy nearly verbatim** — `sendBottlingInvite` (`zoho-middleware/lib/mailer.js:346-390`) already builds a Cal.com-linked, Resend-sent, HTML+plaintext email with greeting-by-first-name and htmlEscape'd interpolation:

```javascript
// Source: zoho-middleware/lib/mailer.js:346-390 (existing, verified live)
function sendBottlingInvite(data) {
  var email = (data.email || '').trim();
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return Promise.reject(new Error('Invalid or missing customer email'));
  }
  var baseUrl = process.env.CALCOM_BOTTLING_BOOKING_URL || 'https://cal.com/steins-and-vines-tw8csc/bottling-appointment';
  var bookingUrl = baseUrl + '?name=' + encodeURIComponent(fullName) + '&email=' + encodeURIComponent(email);
  // ...builds htmlBody/plainBody, then:
  return sendViaResend({ to: email, replyTo: 'hello@steinsandvines.ca', subject: subject, html: htmlBody, text: plainBody });
}
```

**New function to add, `sendWaitlistContact(data)` in `lib/mailer.js`**, following the exact same shape but taking a **pre-resolved `bookingUrl`** (fetched by the client from the already-public `GET /api/bookings/services`, or resolved server-side) and an **already-staff-edited subject/body** (D-05 requires staff to see and edit before send — so the template resolution can happen client-side or in a lightweight preview step, but the actual send always goes through this one server function).

**The new route** (`zoho-middleware/routes/pos.js`, staff-tier gated like `/api/batch/admin-proxy`):

```javascript
// Sketch — not existing code, follows the callAppsScript-per-file pattern
// already established (78-PATTERNS.md: no shared lib/apps-script.js)
router.post('/api/waitlist/:id/contact', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
    var id = req.params.id;
    var body = req.body || {};
    mailer.sendWaitlistContact({ to: body.email, subject: body.subject, body: body.body, bookingUrl: body.bookingUrl })
      .then(function () {
        // ONLY on a resolved promise — D-08 fail-closed.
        return axios.post(process.env.APPS_SCRIPT_URL, JSON.stringify({
          action: 'update_waitlist_status', server_token: process.env.APPS_SCRIPT_SERVER_TOKEN,
          id: id, status: 'contacted', contacted_at: new Date().toISOString()
        }), { headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 5 });
      })
      .then(function () { res.json({ ok: true }); })
      .catch(function (err) {
        // Send failed OR the post-send status write failed — either way, D-08:
        // do not report success. Log which leg failed for staff/ops triage.
        res.status(502).json({ ok: false, error: 'contact_failed' });
      });
  });
});
```

**Getting the booking link without a new Cal.com call:** `GET /api/bookings/services` (`zoho-middleware/routes/bookings.js:133-175`) already calls `calcom.listEventType` for both configured event types and caches the result 24h, returning `{id, title, slug, bookingUrl, ...}` per service — **and it is unauthenticated/public already**. BrewPad can call this directly client-side to build the template preview (D-05), with zero new server code for that half. Only the final send needs the new endpoint.

### Pattern 2: Queue position as a render-time merge-insert (D-10–D-14)

**What:** `position` is stored as a plain positive integer meaning "this row's target 1-based rank in the merged queue." It is written ONLY on the pinned row itself, never on any other row. The merge (pinned rows inserted at their target index, unpinned rows filling remaining slots in existing chronological order) happens entirely inside `sortWaitlistRows` at render time — nothing is ever renumbered on disk.

**When to use:** Recommended resolution for the `position` numeric-scheme discretion item. Chosen over sparse-integer or fractional-insertion schemes because: (a) it never writes to any row except the one being pinned/unpinned (strictly satisfies, and exceeds, the Discretion note's "never rewrite unrelated rows' `signed_up_at`" bar — it never rewrites *any* cell on an unrelated row), (b) it maps directly onto the most natural staff mental model ("move this person to position 2"), and (c) it needs no rebalancing logic ever, because unpinned rows never carry a stored position at all (D-11).

**Example (extends the real, currently-shipped `sortWaitlistRows`):**

```javascript
// Source: js/brewpad.js:985-1002 (existing, unmodified signature — VERIFIED)
// Proposed extension — merge pinned rows into their target index BEFORE the
// existing chronological sort/tiebreak logic runs on the unpinned remainder.
function sortWaitlistRows(rows) {
  var input = rows || [];
  var pinned = [];
  var unpinned = [];
  for (var i = 0; i < input.length; i++) {
    var r = input[i];
    var pos = r && r.position;
    if (typeof pos === 'number' && pos > 0) { pinned.push({ row: r, pos: pos, i: i }); }
    else { unpinned.push({ row: r, i: i }); }
  }
  // Unpinned rows keep today's chronological ordering exactly (unchanged logic).
  unpinned.sort(/* existing signed_up_at comparator, unchanged */);
  // Pinned rows insert at their target index, ascending by requested position,
  // with a stable tie-break (two rows pinned to the same slot fall back to
  // original chronological order) — mirrors the existing a.i - b.i tie-break.
  pinned.sort(function (a, b) { return a.pos - b.pos || a.i - b.i; });
  var out = unpinned.map(function (x) { return x.row; });
  pinned.forEach(function (p) {
    var idx = Math.max(0, Math.min(p.pos - 1, out.length));
    out.splice(idx, 0, p.row);
  });
  return out;
}
```

`computeWaitlistQueuePositions` (`js/brewpad.js:1008-1020`) needs **no changes** — it already just walks whatever array `sortWaitlistRows` hands it and numbers the `waiting` rows in order, so pin effects flow through automatically.

**UI implication:** the "move to position" control should present as "move to position: [N]" (a stepper or small numeric input showing current computed rank), not a drag-handle or "swap with row X" — the model is target-index insertion, not adjacency swap.

### Pattern 3: Recipe multi-select reuses the Batches-tab recipe-attach dropdown, not the Recipes-tab cache

**What:** CONTEXT.md's `<code_context>` suggests reusing `_recipesState.list` (the Recipes-tab cache). Do not do this — it is only populated once `initRecipesTab()` has run, which is gated behind `_recipesDataLoaded` and only fires when staff have actually opened the Recipes tab this session (`js/brewpad.js:2486-2492`). A staff member who opens BrewPad and goes straight to Waitlist would see an empty/unloaded recipe picker.

**Existing analog to copy instead** — the Batches-tab recipe-attach dropdown already solves exactly this (own lazy-loaded local cache, independent of any other tab's state):

```javascript
// Source: js/brewpad.js:5145-5170 (existing, single-select — adapt to multi-select for D-15)
function showAttachOptions(term) {
  if (!_catalog) {
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
  // ...renders .bp-vessel-option[data-rid][data-rname] rows, click-to-select
}
```

Recipe identity is `r.recipe_id`, format `SV-R-000003` (`generateNextId(RECIPES_SHEET_NAME, 'SV-R-', 6)`, `apps-script/adminApi.gs:3629`) — no pipe character possible, confirming the pipe-delimiter recommendation for `recipe_ids` storage is safe.

### Anti-Patterns to Avoid

- **Don't route the contact-send through the generic `/api/batch/admin-proxy` action passthrough.** That dispatcher is a single-action, single-upstream-call forwarder (`pos.js:4029-4064`) — it cannot express "send email, then conditionally write," and stuffing that logic into Apps Script itself would mean `adminApi.gs` making an outbound Resend call, which breaks the existing "Apps Script never talks to third parties other than the spreadsheet" boundary and would require shipping `RESEND_API_KEY` into a script property instead of a Railway env var (worse secret-management posture, not better).
- **Don't give `updateWaitlistStatus` a hardcoded positional `setValue` call for the six new fields** — follow the existing `hasStatus`/`hasNotes`/`hasSynced` `Object.prototype.hasOwnProperty` pattern for each new optional field, so a write can touch only the field(s) actually changing (this is what makes "pin one row" and "advance another row's status" independently safe writes).
- **Don't add `acquireScriptLock()`** to any waitlist handler — D-01 already accepts sheets' weak concurrent-write posture, and `docs/APPS_SCRIPT.md` explicitly warns against "fixing" this without a plan review (see Common Pitfalls → WR-02 discussion).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Customer search/create | A new BrewPad-specific contact lookup | `fetchReassignSearch` pattern → `GET /api/contacts/search?q=` (returns `contact_id`/`contact_name`/`email`/`phone` — exact D-02 field shape) + the inline-new-customer-form pattern → `POST /api/contacts` (returns `contact_id`) | Both are live, tested (`checkout-waitlist.test.js` sibling coverage exists for the endpoints via other call sites), and already handle Zoho's `contact_persons` nesting quirk (the INV-000078 fix) |
| Booking link resolution | A new Cal.com call from BrewPad or from the waitlist send endpoint | `GET /api/bookings/services` (already public, already caches `listEventType` results 24h, already returns `bookingUrl`) | Avoids a second place holding `CALCOM_API_KEY`-adjacent logic; reuses an already-live cache |
| Templated email with a booking link | A new templating engine or MJML/handlebars dependency | Plain string interpolation + `htmlEscape()` (already in `mailer.js`), exactly as `sendBottlingInvite` does | The email is one fixed shape ("your spot is ready — book a time") with 2-3 interpolated fields; a templating library is unjustified complexity for this |
| Formula-injection guard for new cell writes | A new sanitizer | `waitlistCellSafe()` (`adminApi.gs:4931-4938`) — already exists, already used for `email`/`category`/`notes` | D-19 requires this explicitly; the six new fields (all free-text or Zoho-sourced strings) should route through it too, even `zoho_contact_id` (numeric-looking but still Zoho-controlled text) for defense-in-depth consistency with IN-01's lesson |
| Queue reordering | A drag-and-drop library, or a full state-machine reorder API | The render-time merge-insert in Pattern 2 above | Tens of rows, staff-only, occasional use — a client-side pure-function merge is proportionate; a server-side reorder API would need locking this list deliberately does not have |

**Key insight:** every "don't hand-roll" item above is not a third-party-library substitution — it's "don't rebuild a sibling code path that already does this exact thing three lines away." The phase's actual risk surface is entirely in correctly wiring six new columns through three Apps Script functions and one new middleware endpoint, not in any algorithmic or library complexity.

## Common Pitfalls

### Pitfall 1: `addWaitlistEntry`'s new-row write is positional — new columns MUST be appended strictly to the right
**What goes wrong:** `apps-script/adminApi.gs:5056-5064` writes new rows via `sheet.appendRow([id, waitlistCellSafe(email), waitlistCellSafe(category), 'waiting', new Date().toISOString(), false, ''])` — a bare 7-element array with no column-name lookup at all. If the owner inserts the six D-17 columns *between* any of the existing 7 (e.g., between `category` and `status`), `ensureWaitlistSheet`'s header-presence check still passes (it only checks names exist, not their order — `[VERIFIED: apps-script/adminApi.gs:4890-4898]`), but every subsequent public signup silently writes `status`'s value into whatever column is now physically in slot 4, corrupting the row.
**Why it happens:** D-18 (and the code's own comment) correctly states column ORDER doesn't matter for `ensureWaitlistSheet`'s lookup — but that guarantee does not extend to `addWaitlistEntry`'s hardcoded positional append, which nobody flagged in Phase 78 because no columns had been added yet.
**How to avoid:** (a) the cutover runsheet must instruct the owner to add the six new columns as **new columns H through M — strictly after `notes` (column G), never inserted between existing columns**; AND (b) as part of this phase's `addWaitlistEntry` edit (which is already being touched to add the new-row defaults for the six columns), convert the append to be header-driven using `ensured.col` indices (matching the rigor `updateWaitlistStatus` already uses), removing this fragility permanently rather than just avoiding it once.
**Warning signs:** after the redeploy, a fresh test signup (`POST /api/waitlist` on staging with a disposable address, mirroring 78-CUTOVER.md's UAT leg 1) whose `status` cell reads anything other than `waiting`, or whose `signed_up_at` cell is blank/boolean, is this bug.

### Pitfall 2: Don't reuse `_recipesState.list` for the recipe picker — it may be empty
**What goes wrong:** `_recipesState.list` is populated lazily by `initRecipesTab()`, which only runs the first time staff open the Recipes tab this session (`js/brewpad.js:2486-2492`, guarded by `_recipesDataLoaded`). A staff member who opens BrewPad and goes straight to the Waitlist tab sees an empty recipe list in the attach dropdown.
**Why it happens:** CONTEXT.md's `<code_context>` assumed "recipe data is already loaded client-side," true only if the Recipes tab has already been visited.
**How to avoid:** use the Batches-tab recipe-attach dropdown's own-lazy-fetch pattern instead (Architecture Patterns → Pattern 3) — a small local cache fetched on first use of the waitlist recipe picker specifically, independent of any other tab.
**Warning signs:** "Attach recipe" shows "No recipes found" immediately on a fresh session with the Waitlist tab opened first.

### Pitfall 3: Two different Cal.com-link patterns already coexist in this codebase — use the `listEventType`/`bookingUrl` one, not the hardcoded-URL one
**What goes wrong:** `mailer.js:359-363` (`sendBottlingInvite`) builds its booking link from a hardcoded `CALCOM_BOTTLING_BOOKING_URL` env var + manually appended query params — it does NOT call `calcom.listEventType`. `routes/bookings.js:150-165` (`GET /api/bookings/services`) DOES call `listEventType` and returns a real `bookingUrl` field. D-06 explicitly mandates the `listEventType` approach. Copying `sendBottlingInvite`'s URL-construction style (easy, since it's the closest email-template precedent) would violate D-06's letter even though the resulting email would look identical to a user.
**Why it happens:** `sendBottlingInvite` predates the general `listEventType`/`bookingUrl` pattern becoming the norm; the codebase has not been retrofitted.
**How to avoid:** copy `sendBottlingInvite`'s *email construction* (HTML+plaintext, `htmlEscape`, Resend call shape) but source the `bookingUrl` value from `GET /api/bookings/services`'s cached `listEventType` result, not from a new hardcoded env var.
**Confirmed via docs `[CITED: cal.com/docs/api-reference/v2/event-types/get-an-event-type]`:** the Cal.com v2 event-types response does contain a real `bookingUrl` field ("Full URL to the booking page for this event type") — `routes/bookings.js`'s `et.bookingUrl || ''` is reading a genuine field, not defaulting to empty in practice.

### Pitfall 4: `updateWaitlistStatus`'s two OPEN Phase 78 review findings — one is cheap to fold in, one conflicts with D-17
- **IN-01 (payload.status not routed through `waitlistCellSafe`)** — confirmed still open by direct read (`adminApi.gs:5170-5172` writes `payload.status` raw). Since this phase is already rewriting `updateWaitlistStatus` to add six new optional fields, folding in `sheet.getRange(...).setValue(waitlistCellSafe(payload.status))` is a one-line, zero-risk addition. **Recommend folding in.**
- **WR-02 (no optimistic locking)** — confirmed still open (no `expectedVersion`/`last_updated` handling anywhere in `updateWaitlistStatus`). The real fix, mirrored from `updateReservation` (`adminApi.gs:972-1007`), needs a `last_updated` column to compare against — **a SEVENTH new column, not among D-17's fixed six.** This phase's concurrent-write surface is materially larger than Phase 78's (customer link, recipe attach, position, notes, and status can all now be edited independently on the same row by different staff), which strengthens the case for locking — but adding it silently would violate D-17's "exactly these six columns" and D-20's "one migration" framing. **Do not silently add or silently skip this — surface it explicitly** (recommend: either get explicit owner sign-off to widen D-17 by one column, or add an explicit code comment near `updateWaitlistStatus` documenting the accepted risk, exactly as 78-REVIEW.md's own suggested remediation for "if accepted, note it explicitly").

### Pitfall 5: `add_waitlist_entry`'s admin-proxy exclusion is asserted by an existing, still-relevant-looking test — it must be deliberately updated, not accidentally broken
**What goes wrong:** `zoho-middleware/__tests__/waitlist-admin-proxy.test.js:182-186` (`'add_waitlist_entry is rejected 400 invalid_action — never reachable from BrewPad'`) directly encodes the Phase 78 decision that D-21 now reverses. This is a genuine, deliberate behavior change to a passing test, which CLAUDE.md rule 10 ("do NOT modify existing tests unless explicitly asked") normally forbids — but D-21 is exactly that explicit ask, one layer removed (via CONTEXT.md).
**Why it happens:** Phase 78 correctly locked this down at the time; Phase 80's owner-added D-21 changes the premise.
**How to avoid:** the plan must call out this specific test by name, explain in the test itself (comment) why the assertion flipped, and add new coverage for the D-23 disclosure asymmetry (staff-path reveals prior signup, public-path does not) alongside it — don't just flip the expectation silently.
**Also note:** `docs/APPS_SCRIPT.md:303` documents the same now-superseded rule ("deliberately absent from both... Widening this to the admin proxy would let a session-tier caller inject arbitrary rows into the public queue") — this doc section needs updating alongside the code change, or it will actively mislead the next reader.

### Pitfall 6: `docs/APPS_SCRIPT.md`'s Waitlist section is already stale — do not treat it as ground truth
**What goes wrong:** `docs/APPS_SCRIPT.md:332-341` states "One-way status transitions are enforced client-side, not by this handler" and describes `updateWaitlistStatus` as accepting any transition. This was true when written, but CR-01 (commit `a706d7b8`, confirmed live via the second Apps Script redeploy in `78-CUTOVER.md` §7b) added exactly this server-side guard (`waitlistTransitionAllowed`, verified present at `adminApi.gs:5122-5135,5163-5165` by direct read). The doc was never updated after the fix landed.
**Why it happens:** `adminApi.gs` has no CI deploy path and no doc-drift check; a post-hoc code-review fix updated the code and the runsheet but not the reference doc.
**How to avoid:** this phase should update `docs/APPS_SCRIPT.md`'s Waitlist section (column count 7→13, the three-actions table, and the now-incorrect one-way-transition paragraph) as part of its own change — it's already touching every piece of code that section documents.

## Code Examples

### Extending `updateWaitlistStatus` for the six new optional fields (Apps Script)

```javascript
// Source pattern: apps-script/adminApi.gs:5144-5150 (existing hasStatus/hasNotes/hasSynced
// shape, VERIFIED) — extend identically, one hasX flag per new optional field.
var hasZohoContactId = Object.prototype.hasOwnProperty.call(payload, 'zoho_contact_id');
var hasCustomerName  = Object.prototype.hasOwnProperty.call(payload, 'customer_name');
var hasCustomerPhone = Object.prototype.hasOwnProperty.call(payload, 'customer_phone');
var hasRecipeIds     = Object.prototype.hasOwnProperty.call(payload, 'recipe_ids');
var hasPosition       = Object.prototype.hasOwnProperty.call(payload, 'position');
var hasContactedAt    = Object.prototype.hasOwnProperty.call(payload, 'contacted_at');
// ...each writes via headers.indexOf(name)+1 (never hardcoded column letters,
// matching every other handler in this file) and waitlistCellSafe() for the
// free-text ones (zoho_contact_id, customer_name, customer_phone, recipe_ids).
```

### `recipe_ids` pure parse/serialize helper (follow `waitlistDedupeDecision`'s purity contract)

```javascript
// New pure functions, testable via the same new-Function extraction harness
// used by tests/frontend/adminapi-waitlist-pure.test.js.
function serializeWaitlistRecipeIds(ids) {
  return (ids || []).filter(function (id) { return id; }).join('|');
}
function parseWaitlistRecipeIds(value) {
  if (!value) return [];
  return String(value).split('|').filter(function (s) { return s !== ''; });
}
// Round-trip cases to test: [] -> '' -> []; ['SV-R-000003'] -> 'SV-R-000003' -> [...];
// ['SV-R-000003','SV-R-000007'] preserves order both directions.
```

### Testing pattern to follow for all four new pure-logic areas

Both existing suites read the real `apps-script/adminApi.gs` file at test time and either (a) extract a pure function via `new Function(src + 'return {...}')` for direct behavioral testing (`adminapi-waitlist-transition.test.js`, `adminapi-waitlist-ensure-sheet.test.js`), or (b) inject a fake `SpreadsheetApp`/`Logger` as `new Function` parameters so branches that touch the Sheets API can actually execute (`adminapi-waitlist-ensure-sheet.test.js`'s `makeFakeSheet`/`makeFakeSpreadsheetApp`, `[VERIFIED: tests/frontend/adminapi-waitlist-ensure-sheet.test.js:27-123]`). For this phase:
- **D-15 recipe parsing** → pure extraction (option a) — trivial, no Sheets I/O.
- **D-10 ordering (`sortWaitlistRows` merge-insert)** → this function already lives in `js/brewpad.js`, not `adminApi.gs`, so it's directly `require`-able/testable in a frontend Jest suite exactly like the existing `brewpad-waitlist.test.js` presumably already does for the current sort/filter helpers — extend that suite, not a new `new Function` harness.
- **D-23 staff-vs-public dedupe disclosure asymmetry** → needs the fake-`SpreadsheetApp` harness (option b), since it depends on `addWaitlistEntry`'s full sheet-read-then-decide flow, not just the pure `waitlistDedupeDecision`.
- **D-07/D-08 send-then-transition sequencing** → this lives in the NEW middleware endpoint, not Apps Script — test it with the existing `zoho-middleware/__tests__/waitlist-route.test.js`-style server-boot mock harness (mock `mailer.sendWaitlistContact` resolved/rejected, mock `axios.post` for the Apps Script call, assert the Apps Script call is made if-and-only-if the mail promise resolved).

## State of the Art

No external library or API version drift relevant to this phase — `axios`, Resend, and Cal.com v2 usage patterns are all current as verified against the live production code and (for Cal.com) the current official docs fetched during this research session.

**Deprecated/outdated within this codebase (not upstream):** `docs/APPS_SCRIPT.md`'s Waitlist section describes pre-CR-01/CR-02 behavior (Pitfall 6) — this is documentation drift, not a real deprecation, but the planner should treat that doc section as unreliable until this phase updates it.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The contact email should link to the `CALCOM_EVENT_TYPE_FERMENT_KIT` event type (not `CALCOM_EVENT_TYPE_BOTTLING`, and no beer-specific event type ID exists in the codebase) | Architecture Patterns → Pattern 1, Open Questions | If wrong, customers get a booking link for the wrong appointment type — low blast radius (staff review the email before send per D-05, so this is catchable at review time, not silently wrong in production) |
| A2 | `RESEND_API_KEY` and `CALCOM_API_KEY`/`CALCOM_EVENT_TYPE_FERMENT_KIT` are already set in Railway production (inferred from `validateEnv.js` listing them as required + existing live features depending on them — NOT confirmed via a live Railway env probe in this research session) | Environment Availability | If either is actually unset, the contact-send feature 502s immediately in production; low risk since other live features (order confirmation, ferment booking) already depend on these exact vars and are known-working per STATE.md |
| A3 | WR-02 (optimistic locking) should be explicitly deferred with a documented comment rather than folded in, because implementing it correctly needs a 7th column beyond D-17's fixed six | Common Pitfalls → Pitfall 4 | If the owner actually wants it folded in, D-17 needs an explicit amendment before planning proceeds — surfaced as an Open Question, not silently decided here |

## Open Questions

> **Status: all three RESOLVED by routing, not by silent decision.** Each question below is
> settled at plan `80-06` Task 2 — a `checkpoint:decision` with `gate="blocking"` that records the
> owner's verdict in `80-CUTOVER.md`'s `## Owner decisions` section before the Apps Script redeploy.
> The per-item annotations name the specific option id that resolves each one.

1. **Which Cal.com event type does the waitlist contact email link to?**
   - What we know: two event-type IDs are configured (`CALCOM_EVENT_TYPE_FERMENT_KIT`, `CALCOM_EVENT_TYPE_BOTTLING`); beer batches conceptually book into the ferment-in-store flow.
   - What's unclear: no waitlist-specific or beer-specific event-type env var exists; nothing in CONTEXT.md pins this down.
   - Recommendation: default to `CALCOM_EVENT_TYPE_FERMENT_KIT` (A1 above), confirm during the cutover/template-approval step already scheduled for the email wording (Claude's Discretion item).
   - **RESOLVED (routed):** plan `80-06` Task 2, option id `eventtype`. The default is implemented in plan `80-05` Task 1 (select the ferment-kit service's `bookingUrl` from `GET /api/bookings/services`); the owner confirms or overturns it at the blocking checkpoint before the redeploy. Overturning changes which service the contact sheet selects — no re-plan.

2. **Should WR-02 (optimistic locking) be folded into this phase, given it needs a column D-17 doesn't list?**
   - What we know: the concurrent-write surface has grown materially since Phase 78 (five independently-editable fields on one row now, not two).
   - What's unclear: whether the owner considers this worth a D-17 amendment (one more column) versus accepting the documented risk.
   - Recommendation: raise explicitly at `/gsd:discuss-phase` or plan-review time rather than deciding silently either way (see Pitfall 4).
   - **RESOLVED (routed):** plan `80-06` Task 2, option id `wr02`. Default is carry-forward with a documented comment (A3). The checkpoint is deliberately placed BEFORE the migration/redeploy in `80-06` because folding WR-02 in requires amending D-17, adding a `last_updated` column to the same migration, and extending plan `80-01`'s `updateWaitlistStatus` — it cannot be retrofitted without a second owner-only redeploy.

3. **Exact contact-email template wording** — already flagged as Claude's Discretion in CONTEXT.md; draft during planning, confirm with owner before the cutover plan is finalized. No research blocker here — `sendBottlingInvite`'s tone/structure is a solid starting template.
   - **RESOLVED (routed):** plan `80-06` Task 2, option id `template`. The subject/body draft is fixed in `80-UI-SPEC.md`'s Copywriting Contract and pre-filled by plan `80-05` Task 1; the owner approves it verbatim or rewords it at the blocking checkpoint. A reword updates the pre-fill strings in `js/brewpad.js` plus a test rerun and `npm run build` — no re-plan. Note this is a review-time default, not a silent send: D-05 makes every individual send staff-reviewable and editable regardless.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `RESEND_API_KEY` (Railway env) | Contact-send endpoint (D-04) | Assumed ✓ — required by `validateEnv.js:36`, already used live by order-confirmation/bottling-invite emails | — | None if actually unset — send endpoint 502s; low risk (A2) |
| `CALCOM_API_KEY` (Railway env) | Booking-link resolution (D-06) | Assumed ✓ — required by `validateEnv.js:62`, already used live by `GET /api/bookings/services` | — | None if actually unset — same 502 path, same low risk |
| `CALCOM_EVENT_TYPE_FERMENT_KIT` (Railway env) | Booking-link resolution (D-06) | Assumed ✓ — required by `validateEnv.js:63`, already used live by the ferment-in-store booking flow | — | None if unset |
| Google Apps Script manual redeploy access | D-17/D-18/D-20 migration | Owner-only, no CLI/API path — same constraint as every prior Apps Script phase | — | None — hard blocker until the owner performs the redeploy, exactly as `78-CUTOVER.md` modeled |

**Missing dependencies with no fallback:** none confirmed missing — all three env vars are inferred present from existing live features; the Apps Script redeploy step has no fallback by design (owner-only action, tracked in the cutover plan, not this research).

## Validation Architecture

Skipped — `.planning/config.json` has `workflow.nyquist_validation: false`.

## Security Domain

`security_enforcement` is not set to `false` in `.planning/config.json` (default enabled) — this section is required.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Every new/extended action (`update_waitlist_status` extension, `add_waitlist_entry` admin-proxy addition, the new contact-send endpoint) must go through `authTiers.requireTiers(['legacy','session'])`, the existing staff-tier gate already used by `/api/batch/admin-proxy` and `/api/batch/reassign-customer` — device (kiosk) tier explicitly excluded, matching Phase 76's T-76-02-03 pattern |
| V3 Session Management | Yes | No new session logic — reuses the existing `x-session-token`/`sv_session` mechanism (Phase 76) unchanged |
| V4 Access Control | Yes | `add_waitlist_entry` must be added to `ADMIN_PROXY_ACTIONS` (writes) but explicitly **NOT** `ADMIN_PROXY_READS` — it is a write-only action; the two-whitelist separation is the existing access-control primitive (`pos.js:4014-4027`) and must not be collapsed |
| V5 Input Validation | Yes | `waitlistCellSafe()` (formula-injection guard, D-19) on every new free-text cell write; email regex validation already present in `addWaitlistEntry`/`POST /api/waitlist` unchanged; `position` must be validated server-side as a positive integer or empty (reject arbitrary strings) even though the client UI likely constrains input type |
| V6 Cryptography | No | No new crypto surface — Cal.com webhook HMAC verification (`verifyWebhook`) is out of scope for this phase (not touched) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Sheets formula injection via a new free-text cell (`customer_name`, `notes`, `recipe_ids` if ever hand-edited) | Tampering | `waitlistCellSafe()` on every write, per D-19 — already the established local mitigation (does not close the project-wide M9 gap, which remains explicitly deferred, `[VERIFIED: 78-PATTERNS.md]`) |
| Widening `add_waitlist_entry` to the admin proxy without a caller-aware D-23 disclosure gate | Information Disclosure / Elevation of Privilege | The staff-only manual-add path must return the D-23 "already on the list, signed up on X" disclosure ONLY when reached via the admin-proxy/session-tier, never leak that same disclosure back onto the public `POST /api/waitlist` response shape — the existing `checkout-waitlist.test.js` client coverage pins the public response shape unchanged, which is the regression guard here |
| Secret leakage to the browser via a client-orchestrated send | Information Disclosure | Resolved by Pattern 1 (server-orchestrated send) — `RESEND_API_KEY`/`CALCOM_API_KEY` never appear in any BrewPad JS or network response body |
| Direct API call bypassing the one-way status guard (the exact CR-01 class of bug) | Tampering | Already fixed server-side (`waitlistTransitionAllowed`) for the four existing statuses; when extending `updateWaitlistStatus` with new optional fields, do not accidentally add a new code path that writes `status` without passing through the existing guard call |

## Sources

### Primary (HIGH confidence — direct source read this session)
- `apps-script/adminApi.gs` (lines 4840-5193) — full Waitlist section: `ensureWaitlistSheet`, `waitlistCellSafe`, `waitlistDedupeDecision`, `waitlistShouldReinstate`, `addWaitlistEntry`, `getWaitlist`, `waitlistTransitionAllowed`, `updateWaitlistStatus`, `findRowById`
- `js/brewpad.js` — pure helpers (lines 946-1140: `sortWaitlistRows`, `computeWaitlistQueuePositions`, `filterWaitlistRows`), waitlist panel (lines 8230-8422), customer search/create (lines 2088-2134, 7700-7781), recipe-attach dropdown (lines 5140-5188)
- `zoho-middleware/routes/pos.js` — `ADMIN_PROXY_ACTIONS`/`ADMIN_PROXY_READS` (lines 3990-4064), `/api/contacts/search` (lines 3576-3619)
- `zoho-middleware/routes/bookings.js` — `GET /api/bookings/services` (lines 133-175), `POST /api/contacts` (lines 391-461)
- `zoho-middleware/lib/mailer.js` — full file, especially `sendBottlingInvite` (346-390) and `sendViaResend` (55-87)
- `zoho-middleware/lib/calcom.js` — full file, `listEventType` (49-58)
- `zoho-middleware/lib/validateEnv.js` — `RESEND_API_KEY`/`CALCOM_API_KEY`/`CALCOM_EVENT_TYPE_*` required-env entries
- `zoho-middleware/__tests__/waitlist-admin-proxy.test.js` — the `add_waitlist_entry`-excluded assertion (line 182)
- `tests/frontend/adminapi-waitlist-ensure-sheet.test.js`, `tests/frontend/adminapi-waitlist-transition.test.js` — testing patterns
- `.planning/phases/78-.../78-CONTEXT.md`, `78-CUTOVER.md`, `78-REVIEW.md`, `78-UI-SPEC.md`, `78-PATTERNS.md` — Phase 78 canonical references
- `docs/APPS_SCRIPT.md` — Waitlist section (confirmed stale in one paragraph, see Pitfall 6)
- `.planning/todos/pending/remove-dead-beer-waitlist-handler.md`

### Secondary (MEDIUM confidence)
- Cal.com API v2 `GET /event-types/{id}` response schema — `[CITED: https://cal.com/docs/api-reference/v2/event-types/get-an-event-type]`, confirmed `bookingUrl` is a real documented field (fetched this session via WebFetch, not from training data)

### Tertiary (LOW confidence)
- None — no unverified WebSearch-only claims are relied upon in this document.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; every reused primitive read directly from live source
- Architecture: HIGH — the server-orchestrated-send requirement and the appendRow positional hazard were both discovered by reading actual code, not inferred
- Pitfalls: HIGH — all six pitfalls are backed by direct source reads (line-cited) or an official-docs fetch, not speculation

**Research date:** 2026-09-04
**Valid until:** 30 days (stable internal codebase; the one external-API claim, Cal.com's `bookingUrl` field, is a documented, stable v2 API contract) — re-verify sooner if `apps-script/adminApi.gs` or `js/brewpad.js` waitlist sections are touched by any other phase before this one plans/executes.
