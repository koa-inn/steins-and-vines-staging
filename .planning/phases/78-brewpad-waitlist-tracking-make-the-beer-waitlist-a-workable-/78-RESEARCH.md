# Phase 78: BrewPad Waitlist Tracking - Research

**Researched:** 2026-09-02
**Domain:** Sheet-backed staff list (Google Apps Script + Express middleware + BrewPad frontend), MailerLite CSV export
**Confidence:** MEDIUM — codebase patterns are HIGH confidence (read directly, line-cited); the D-04 MailerLite CSV question is MEDIUM at best (see Open Questions) and is explicitly flagged for owner verification before cutover.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

## Implementation Decisions

### System of record

- **D-01: A new `Waitlist` tab in the existing STEINS AND VINES spreadsheet is the system of
  record.** Chosen over adding Postgres on Railway or using Zoho contacts. Rationale: it matches
  every other list in the system (`Batches`, `Recipes`, `GiftCards`, `Reservations`), BrewPad
  already reads sheets through `/api/batch/admin-proxy`, and staff hand-editability has just
  proved its operational worth as the gift-card stuck-claim escape hatch (Phase 51, D-12).
  Accepted costs: another manual `adminApi.gs` redeploy with no staging gate (D-09 from Phase 51),
  and sheets are weak under concurrent writes.

- **D-02: The schema carries a `category` column from day one; beer is the first value.**
  Cider/wine/classes can be added later without a schema migration. The BrewPad UI may filter to
  beer initially. Rationale: because `adminApi.gs` has no CI path, every later `.gs` change costs a
  manual owner redeploy — one extra column now is cheap insurance, and cider has already launched.

### Signup failure mode

- **D-03: The sheet write is authoritative and blocking; MailerLite is demoted to best-effort.**
  A signup returns success only if the `Waitlist` row is written. The MailerLite `addSubscriber`
  call becomes fire-and-forget, exactly like the existing staff-notification email
  (`server.js:225-227`). Rationale: mirrors Phase 51's "money never moves without a record" —
  never promise a spot that was not recorded — and removes a third party from the critical path.
  Today a MailerLite outage returns 503 and turns away customers the shop could serve.

  **Consequence accepted:** marketing sync can now drift silently. D-07 is the required mitigation.

  **Planner note:** `POST /api/waitlist` currently returns 503 when MailerLite is unconfigured
  (`server.js:216-219`). Under D-03 that guard must move to the sheet write, not be deleted —
  the endpoint must still fail closed when it cannot record.

- **Write-retry constraint (carried from Phase 77):** the admin proxy collapses upstream errors to
  502; **reads may retry, writes must NOT.** A waitlist row write is a write. Do not add retry
  around it. D-06's idempotency makes a duplicate submission harmless, but that is not licence to
  auto-retry a write whose outcome is unknown.

### Backfill

- **D-04: One-time CSV export from the MailerLite UI, pasted into the `Waitlist` tab at cutover,
  using each subscriber's `subscribed_at` timestamp as queue order.** Chosen over building a
  MailerLite list/read integration. Rationale: `zoho-middleware/lib/mailerlite.js` currently
  exposes only `isConfigured()` and `addSubscriber()` — there is no read path — and this is a
  one-time job. It is also the only option that makes the "in order" promise honest on day one.

  **This is a manual owner step** (like the Apps Script redeploy) and must be captured as a
  `user_setup` item in the plan, not automated.

  **Research must confirm:** that MailerLite's CSV export actually carries a usable signup
  timestamp. If it does not, the ordering promise cannot be honoured for pre-cutover signups and
  the owner needs to be told that explicitly before cutover — do not silently import undated rows
  in arbitrary order.

### Staff workflow

- **D-05: Statuses are `waiting` → `contacted` → `booked`, plus `removed`.** Keeping `contacted`
  distinct from `booked` is the point — it is what lets staff see who has been chased and who is
  still owed a call, which is the actual gap today.

- **D-06: A repeat signup with the same email (and category) is idempotent — no new row, and the
  original queue position is preserved.** The customer still receives the normal success response;
  no error, and no disclosure of whether the address is already on the list. Rationale: protects
  the ordering promise, and mirrors how the gift-card ledger treats a replayed `transaction_ref`.

- **D-07: MailerLite sync state is a persisted column on the row** (e.g. `mailerlite_synced`),
  visible and filterable in BrewPad — not a log line. Rationale: this is Phase 51's criterion-2
  lesson applied directly. A `console.error` vanishes on restart and is invisible to the staff who
  would act on it; a cell survives. This is the required mitigation for D-03's accepted drift.

- **D-08: The waitlist is a standalone list with a free-text notes column.** No linking of a
  `booked` entry to a Zoho customer or a BrewPad batch in this phase. Rationale: identity matching
  (same email, not yet a contact; batch created before or after booking?) is a real design problem
  that deserves its own phase, and the shippable gap here is visibility and ordering.

### Claude's Discretion

- Exact column names and order for the `Waitlist` tab, provided D-02 (`category`), D-05 (status
  values), D-07 (sync flag) and D-08 (notes) are all representable, plus an arrival timestamp that
  can order the queue.
- Where the BrewPad surface lives (new tab vs section) and its visual treatment.
- Whether status transitions are a dropdown or buttons.

### Deferred Ideas (OUT OF SCOPE)

- **Linking a booked entry to a Zoho customer or BrewPad batch** (D-08). Needs an identity-matching
  rule for emails that are not yet contacts, and a decision on whether the batch exists before or
  after booking. Own phase.
- **Generalising the waitlist UI to cider / wine / classes.** The schema is ready via D-02; the UI
  and any category-specific copy are not in scope here.
- **Automated MailerLite re-sync / reconciliation** (a repeatable import, or retrying failed
  syncs). D-04 covers a one-time manual import and D-07 makes drift visible; automation is a later
  call once the drift rate is known.
- **Removing the genuinely dead homepage call site** at `js/modules/13-init.js:380`
  (`setupBeerWaitlistForm()` under `page === 'home'`). Tracked in
  `.planning/todos/pending/remove-dead-beer-waitlist-handler.md`. Small and adjacent, but it is
  frontend cleanup, not waitlist tracking — fold it in only if a plan already touches that file.

### Reviewed Todos (not folded)
`gsd-sdk query todo.match-phase 78` returned twelve keyword matches; none are about waitlist
tracking. They matched on generic tokens ("beer", "brewpad", "status", "source") and were reviewed
and rejected: the beer/cider launch-pages todo, three BrewPad batch-view todos, five kiosk todos, a
GTM/analytics todo, a deploy-workflow todo, and a Kits pricing-row todo. The only genuine waitlist
hit was `remove-dead-beer-waitlist-handler.md`, which is a canonical reference here (read before
touching waitlist JS), not scope to fold.
</user_constraints>

## Summary

This phase does not introduce new technology. Every piece of the implementation has a live, working precedent already in this codebase: the gift-card ledger (Phase 51) is the sheet-bootstrap + idempotent-decision + durable-flag pattern to copy almost verbatim; the BrewPad tab-switching shell (`js/brewpad.js:2300-2339` + `brewpad.html:288-309`) is the exact spot a sixth tab gets added; the `/api/batch/admin-proxy` route (`zoho-middleware/routes/pos.js:4026-4064`) is the existing, already-hardened transport BrewPad uses to reach Apps Script, gated by two parallel hardcoded whitelists that both need new entries. The riskiest unknowns are not technical difficulty but process: (1) whether MailerLite's CSV export actually carries a usable per-subscriber timestamp for the D-04 backfill (could not be verified past MEDIUM confidence from public docs — flagged for the owner to check directly in their MailerLite account before cutover), and (2) the two-hop deploy reality this codebase always has for `.gs` changes (middleware auto-deploys on push; Apps Script does not, and a mismatch between "new middleware whitelist entry" and "old deployed adminApi.gs" produces a clean `invalid_action` 400/500 that looks like a bug but is actually just an un-redeployed script).

**Primary recommendation:** Copy the Phase 51 gift-card ledger's sheet-bootstrap + append/settle/flag shape for the `Waitlist` tab (`ensureGiftCardLedgerSheet` → `ensureWaitlistSheet`; `appendGiftCardClaim`/`settleGiftCardClaim` are overkill for this phase — a plain `sheetToObjects()` scan + `findRowById`-style status write, mirroring `voidGiftCard`, is the right level of ceremony for a non-money-path list). Add the new read/write actions to **both** `ADMIN_PROXY_ACTIONS`/`ADMIN_PROXY_READS` in `pos.js` and the `doPost`/`handleReadAction` dispatch in `adminApi.gs` — missing either half is the most likely integration bug. Do not add `_cachedGet` caching to the waitlist list read; the gift-card list (`get_gift_cards`) already sets the precedent of skipping the cache layer entirely for a low-volume staff list, which sidesteps the Phase 69 stale-cache bug class outright.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Public waitlist signup capture (email validation, rate limit) | API / Backend | — | Already lives in `zoho-middleware/server.js:211-233`; extended, not rebuilt |
| Waitlist system of record (rows, statuses, timestamps) | Database / Storage | — | New `Waitlist` sheet tab, owned by `apps-script/adminApi.gs` (D-01) |
| Idempotent signup dedupe decision (D-06) | API / Backend | Database / Storage | Pure decision logic belongs in Apps Script (mirrors `giftCardLedgerDecision`), but requires a full-table read from Storage to evaluate |
| Staff waitlist view + ordering (BrewPad UI) | Browser / Client | API / Backend | Rendered client-side in `js/brewpad.js`; data fetched via the existing admin-proxy |
| Staff status transitions (contacted/booked/removed) | API / Backend | Browser / Client | Write handler in `adminApi.gs`, invoked from a BrewPad button/dropdown |
| MailerLite marketing sync (fire-and-forget) | API / Backend | — | `zoho-middleware/lib/mailerlite.js`, unchanged surface, demoted to best-effort (D-03) |
| Mailerlite-sync-state visibility (D-07) | Database / Storage | Browser / Client | Persisted column on the Waitlist row, rendered/filterable in BrewPad |
| One-time CSV backfill (D-04) | Database / Storage | — | Manual owner paste into the sheet; no code path, `user_setup` task only |
| Write authorization (server_token / session tier) | API / Backend | — | Reuses existing `SERVER_WRITE_TOKEN` / `authTiers.requireTiers(['legacy','session'])`, no new auth surface |

## Standard Stack

No new libraries. Every dependency this phase touches is already installed and already load-bearing elsewhere in the repo.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| axios | ^1.13.5 `[VERIFIED: zoho-middleware/package.json:24]` | Middleware → Apps Script HTTP calls | Already the transport for every other Apps-Script-backed write (`routes/gift-cards.js`, `routes/pos.js`, `lib/checkout-helpers.js`) |
| express-rate-limit + Redis store | already installed | `waitlistLimiter` (`zoho-middleware/server.js:200-209`) | Already fronts `/api/waitlist`; D-03 does not change it |
| Google Apps Script (V8 runtime) | n/a (Google-hosted) | `Waitlist` sheet tab, dispatch, decision logic | Existing system of record for every other staff list (`Batches`, `Recipes`, `GiftCards`, `Reservations`) |

### Alternatives Considered
None — CONTEXT.md D-01 already closed this decision (sheet tab over Postgres/Zoho contacts) and this research does not re-litigate it.

**Installation:** None required. No `npm install` step for this phase.

## Package Legitimacy Audit

**Not applicable.** This phase installs no new npm, pip, or other external packages — it extends existing middleware code (`axios`, already a dependency) and existing Apps Script code. The slopcheck / registry-verification protocol is skipped for this reason, not because it was bypassed.

## Architecture Patterns

### System Architecture Diagram

```
Customer                    beer.html
   |  fills #beer-waitlist-form
   v
js/modules/12-checkout.js  setupBeerWaitlistForm()
   |  POST {email}
   v
zoho-middleware  POST /api/waitlist  (server.js:211)
   |  1. validate email + waitlistLimiter (Redis, unchanged)
   |  2. [NEW, D-03] BLOCKING: write Waitlist row via Apps Script
   |         -- fails closed (503) if the sheet write fails --
   |  3. [existing] fire-and-forget MailerLite addSubscriber (now best-effort)
   |  4. [existing] fire-and-forget staff notification email (Resend)
   v
apps-script/adminApi.gs  doPost({server_token, action:'add_waitlist_entry', ...})
   |  ensureWaitlistSheet() -> idempotency scan (D-06) -> appendRow / no-op
   v
Google Sheets: Waitlist tab  (system of record, D-01)
   ^
   |  GET/POST via /api/batch/admin-proxy (session-tier only)
   |
js/brewpad.js  new "waitlist" tab
   |  adminApiGet('get_waitlist')      -- list, ordered by signup timestamp
   |  adminApiPost('update_waitlist_status', {row/id, status})
   v
Staff sees ordered queue, marks contacted/booked/removed
```

### Recommended Project Structure

No new files. Every change lands inside existing files:

```
apps-script/adminApi.gs
├── sheet-name constant           (alongside GIFT_CARD_TRANSACTIONS_SHEET_NAME, ~:46-60)
├── ensureWaitlistSheet()         (new, copies ensureGiftCardLedgerSheet shape, ~:4262)
├── waitlistDedupeDecision()      (new, PURE function mirroring giftCardLedgerDecision, ~:4188)
├── addWaitlistEntry(payload)     (new write handler, calls ensureWaitlistSheet + dedupe decision)
├── getWaitlist()                 (new read handler, mirrors getGiftCards(), ~:4807)
├── updateWaitlistStatus(payload) (new write handler, mirrors voidGiftCard's findRowById+setValue shape, ~:4738)
├── doPost() server_token block   (routes 3 new actions, ~:299-320)
└── handleReadAction() switch     (routes 1 new read action, ~:227-230)

zoho-middleware/
├── server.js                     (POST /api/waitlist gains the blocking sheet write, ~:211-233;
│                                   needs `var axios = require('axios');` added at top — not
│                                   currently required in this file)
└── routes/pos.js                 (ADMIN_PROXY_ACTIONS + ADMIN_PROXY_READS gain the new action
                                    names, ~:3990-4024)

js/brewpad.js
├── switchTab()                   (panels array + tab dispatch, ~:2300-2339)
├── new bp-* render/load functions for the waitlist panel
└── adminApiGet/adminApiPost      (existing helpers, ~:1547-1587 — reused as-is)

brewpad.html
├── new <button class="bp-tab" data-tab="waitlist"> in .bp-tab-bar (~:288-309)
└── new #bp-panel-waitlist section inside .bp-panels
```

### Pattern 1: Sheet bootstrap (self-healing, fail-closed on drift)

**What:** A tab-creation function that is safe to call on every request: create the tab with a fixed header row if absent, and return `{ok:false}` (never repair headers, never fall back to positional writes) if an existing tab has drifted columns.
**When to use:** Any new sheet tab this phase creates.
**Example — the exact function to copy the shape of:**
```javascript
// Source: apps-script/adminApi.gs:4262-4294 (ensureGiftCardLedgerSheet, Phase 51, D-10)
function ensureGiftCardLedgerSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(GIFT_CARD_TRANSACTIONS_SHEET_NAME);
  var headerNames = ['tx_id', 'cert_number', /* ... */];
  if (!sheet) {
    sheet = ss.insertSheet(GIFT_CARD_TRANSACTIONS_SHEET_NAME);
    sheet.appendRow(headerNames);
    sheet.getRange(1, 1, 1, headerNames.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {}; var missing = [];
  for (var i = 0; i < headerNames.length; i++) {
    var idx = headers.indexOf(headerNames[i]) + 1;
    col[headerNames[i]] = idx;
    if (idx === 0) missing.push(headerNames[i]);
  }
  if (missing.length > 0) return { ok: false, error: 'ledger_unavailable', missing: missing };
  return { ok: true, sheet: sheet, headers: headers, col: col };
}
```
A `setupWaitlist()` wrapper mirroring `setupGiftCardLedger()` (`adminApi.gs:4114-4121`) should exist too, for the owner to run once manually from the Apps Script editor before the first real signup.

### Pattern 2: Status mutation by lookup-then-setValue (non-money-path, no lock needed)

**What:** Find a row by a key column, resolve target column indices at runtime via `headers.indexOf`, write only the changed cells, invalidate any cache.
**When to use:** `updateWaitlistStatus` (contacted/booked/removed transitions, D-05).
**Example:**
```javascript
// Source: apps-script/adminApi.gs:4738-4775 (voidGiftCard) — note this one DOES take a lock
// because it is money-adjacent (gift card status gates redemption). A waitlist status write
// is not money-adjacent — addReservation (adminApi.gs:910-949) is the better model for "no
// lock needed", since it's a plain sheet list with no concurrent-write money risk either.
function voidGiftCard(payload) {
  var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
  if (result.row === -1) return { ok: false, error: 'not_found' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var statusCol = headers.indexOf('status') + 1;
  sheet.getRange(result.row, statusCol).setValue('void');
  invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
  return { ok: true, status: 'void' };
}
```
`findRowById` (`adminApi.gs:1473-`) matches on **column A only**. If the `Waitlist` tab's column A is a generated `id` (not email), `updateWaitlistStatus` can use `findRowById` directly, keyed on that `id`. If BrewPad instead needs to act on a row without first fetching an id (unlikely, since the list view will already have it), a full `sheetToObjects()` scan is the fallback — same technique as Pattern 3 below.

### Pattern 3: Full-table scan for a decision that isn't a simple key lookup (D-06 idempotency)

**What:** A **pure** function (no `SpreadsheetApp`/`LockService`/`Session`/`CacheService` reference) that takes the sheet's rows as its first argument and returns a decision — never reads the sheet itself. This is what makes it unit-testable outside Apps Script's runtime (see Testing Surface below).
**When to use:** The D-06 "same email + category" dedupe check — cannot be a column-A lookup unless column A is a composite key, so it needs the same shape as `giftCardLedgerDecision`.
**Example:**
```javascript
// Source: apps-script/adminApi.gs:4188-4245 (giftCardLedgerDecision, Phase 51, D-12)
// Cited in 78-CONTEXT.md as the explicit model for D-06.
function giftCardLedgerDecision(rows, certNumber, txRef) {
  var normCert = normalizeCertNumber(certNumber);
  // ... loops rows once, matches on cert_number, returns {action, row, unsettled}
}
```
A `waitlistDedupeDecision(rows, email, category)` following this exact shape — normalize email (trim+lowercase, mirroring `normalizeCertNumber`), loop once, return `{action: 'existing'|'new', row: Object|null}` — is the correct level of rigor here. This does **not** need the claim-before-mutate ceremony (`appendGiftCardClaim`/`settleGiftCardClaim`) — that machinery exists specifically to survive a crash mid-money-movement, which a waitlist signup is not. A plain "scan rows, if match return existing row and do nothing, else appendRow" is proportionate (see Common Pitfalls: don't over-engineer the lock).

### Pattern 4: BrewPad tab addition (frontend integration point)

**What:** BrewPad's bottom tab bar toggles both nav button state and a matching panel's visibility; the same `switchTab()` function drives the initial data load for whichever tab becomes active.
**Example — the exact spot to extend:**
```javascript
// Source: js/brewpad.js:2300-2339 (switchTab)
function switchTab(tab) {
  _activeTab = tab;
  Array.prototype.forEach.call(document.querySelectorAll('.bp-tab'), function (btn) {
    var isActive = btn.getAttribute('data-tab') === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
  var panels = ['dashboard', 'batches', 'tasks', 'measurements', 'recipes']; // add 'waitlist'
  panels.forEach(function (p) {
    var el = document.getElementById('bp-panel-' + p);
    if (el) el.style.display = (p === tab) ? '' : 'none';
  });
  // ... else-if chain below dispatches the initial load per tab; add an else-if for 'waitlist'
}
```
`brewpad.html:288-309` needs a matching `<button class="bp-tab" data-tab="waitlist">` and a new `#bp-panel-waitlist` section inside `.bp-panels`.

### Pattern 5: Middleware → Apps Script blocking call (for the new D-03 authoritative write)

**What:** An awaited `axios.post` with `action` + `server_token` in the JSON body (never query params), `maxRedirects: 5` so Apps Script's 302 redirect resolves correctly.
**Example:**
```javascript
// Source: zoho-middleware/routes/gift-cards.js:22-38 (callAppsScript) — the correct model for a
// BLOCKING write. Do NOT model this on checkout-helpers.js's notifyAdminPanel (add_reservation),
// which is intentionally fire-and-forget ("Fire-and-forget: write the new reservation... so it
// appears immediately in the admin panel") — the opposite of what D-03 requires for /api/waitlist.
function callAppsScript(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  var body = Object.assign({}, payload, { action: action, server_token: token });
  return axios.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 12000,
    maxRedirects: 5
  }).then(function (resp) { return resp.data || {}; });
}
```
**Note:** `gift-cards.js`, `recipes.js`, and `pos-recipe.js` each carry their own private copy of this exact helper — there is no shared `lib/apps-script.js`. `server.js` does not currently `require('axios')` at all. The pragmatic, in-scope choice is a fourth local copy (or a locally-scoped inline call) in `server.js`, not a cross-cutting extraction — CLAUDE.md rule 3 says surface this duplication, not fix it inside an unrelated phase. **Do NOT retry this call from the client or server on failure** — see the write-retry constraint below.

### Anti-Patterns to Avoid
- **Reusing `appendGiftCardClaim`/`settleGiftCardClaim`/`flagGiftCardClaim` verbatim for waitlist rows.** That machinery's entire purpose is surviving a crash between "claim" and "balance write" on a money path. A waitlist signup has no balance to protect — copying the three-step claim ceremony here is over-engineering for D-01's accepted risk level ("sheets are weak under concurrent writes" was explicitly accepted, not something this phase is asked to re-solve at the gift-card level of rigor).
- **Adding `LockService.getScriptLock()` around the waitlist append.** `addReservation` (`adminApi.gs:910-949`), the closest existing precedent for "public form → sheet append", has no lock at all. Only the money-adjacent gift-card handlers (`issueGiftCard`, `voidGiftCard`, `redeemGiftCard`, `reloadGiftCard`) take `acquireScriptLock`. A low-traffic beer waitlist does not warrant it (see Common Pitfalls for the proportionality argument).
- **Wrapping `get_waitlist` in `_cachedGet`.** `get_gift_cards` (`adminApi.gs:228-229`) is the only other staff-list read action, and it deliberately has no cache wrapper. Adding one reintroduces the exact stale-cache bug class Phase 69 hit (`_invalidateBatchCache` omitted the `gds` key, `.planning`/STATE.md Roadmap Evolution, Phase 69) — for a list this size (a handful to a few dozen open entries), the cache buys nothing and adds an invalidation surface to get wrong.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Sheet tab existence/schema-drift check | A new bespoke tab-creation function | Copy `ensureGiftCardLedgerSheet`'s shape | Already handles the "tab missing" and "tab exists but headers drifted" cases correctly and fails closed |
| Row-column resolution | Hardcoded column letters/indices | `headers.indexOf(name) + 1`, resolved at runtime (per-request) | Every existing handler in this file does this specifically so column reordering by staff doesn't silently corrupt writes |
| Duplicate-signup detection | A `Set`/database unique constraint | A pure decision function over `sheetToObjects()` rows (Pattern 3) | Sheets have no native unique-constraint mechanism; this is the established in-repo idiom |
| Apps-Script → middleware transport | A new fetch wrapper in BrewPad | `adminApiGet`/`adminApiPost` (`js/brewpad.js:1547-1587`) | Already implements the read-retry/write-no-retry asymmetry and the correct error-status handling |
| Email format validation | A new regex | The existing `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` in `server.js:213` and `mailerlite.js:38` | Already the project's standard; duplicating it with a slightly different pattern is a drift risk |

**Key insight:** Nothing in this phase is a new capability class for this codebase — it is the fourth sheet-backed staff list (after Batches/Recipes/GiftCards) and the sixth BrewPad tab. The risk is in details (which whitelist did you forget, which column resolution did you hardcode) not in inventing new architecture.

## Common Pitfalls

### Pitfall 1: Forgetting one half of the two-whitelist gate in `pos.js`
**What goes wrong:** A new action works from Apps Script's side (`doPost`/`handleReadAction`) but the middleware still returns `400 invalid_action` because `ADMIN_PROXY_ACTIONS` (write gate, `pos.js:3990-4010`) or `ADMIN_PROXY_READS` (read-vs-write transport selector, `pos.js:4017-4024`) wasn't updated.
**Why it happens:** These are two separate hardcoded objects, deliberately not a free-form passthrough (`T-76-02-01`), so BOTH must be touched: `ADMIN_PROXY_ACTIONS` gates whether the action is allowed through at all; `ADMIN_PROXY_READS` decides whether it's forwarded as a GET (read) or POST (write) to Apps Script. A new read action needs an entry in BOTH objects; a new write action needs an entry in `ADMIN_PROXY_ACTIONS` only.
**How to avoid:** Add `get_waitlist: true` to both objects; add `update_waitlist_status: true` (and, if BrewPad ever needs to add entries directly rather than through the public form, `add_waitlist_entry: true`) to `ADMIN_PROXY_ACTIONS` only.
**Warning signs:** BrewPad UI shows a generic error toast; server logs show `[batch/admin-proxy] <action> failed` at 400, not 502 (502 would mean it reached Apps Script and failed there instead).

### Pitfall 2: The manual Apps Script redeploy is a separate release from the middleware deploy
**What goes wrong:** `git push origin main` auto-deploys the middleware (Railway watches `zoho-middleware/**`) within minutes. `apps-script/adminApi.gs` changes do **not** auto-deploy — Apps Script has no CI path (confirmed repeatedly: Phase 51 D-09, `docs/APPS_SCRIPT.md`, STATE.md "Apps Script changes require manual redeploy — plan authors must flag this"). A plan that ships both halves in one commit will have live middleware code calling actions the still-old deployed Apps Script doesn't recognize, returning `{ok:false, error:'invalid_action', message:'Unknown action: ...'}` from Apps Script itself (a 200 with an error body, not an HTTP error) until the owner manually redeploys.
**How to avoid:** The plan must include an explicit `user_setup`/`checkpoint:human-verify` task for the owner Apps Script redeploy, sequenced before (or atomically alongside) any middleware deploy that depends on the new actions — mirroring Phase 51-03 Task 3 exactly. **Deployment ID stays the same** (no URL/env change needed) — only the "Version" bump matters.
**Warning signs:** A live-probe curl against the deployed `/exec` URL returns `Unknown action` for an action that is clearly present in the committed `adminApi.gs` source.

### Pitfall 3: The single Apps Script deployment serves BOTH staging and production
**What goes wrong:** There is one Apps Script Web App deployment. Redeploying it to add the Waitlist actions goes live everywhere simultaneously — there is no staging gate at the Apps Script layer, even though the middleware itself does have a staging Railway instance.
**Why it happens:** Structural — same spreadsheet, same script project, same deployment URL for both environments (confirmed live in Phase 51-03: `staging and prod share ONE Google Sheet`).
**How to avoid:** Test the new `adminApi.gs` functions via the Apps Script editor's Run button + `Logger.log()` before redeploying (per `docs/APPS_SCRIPT.md`'s own "Adding a New Apps Script Function" checklist), and treat the redeploy itself as the production release, not a staging-safe step.

### Pitfall 4: Non-JSON HTML error responses from Apps Script may have already performed the write
**What goes wrong:** A caller that treats "the response didn't parse as JSON" as "the request didn't happen" and retries will double-write. Documented live in Phase 51-03: a curl invocation combining `-X POST` with `-L` forced POST through Apps Script's 302 redirect onto a Google Drive HTML error page — but the mutation had already executed before the response the caller saw failed to parse.
**Why it happens:** Apps Script's `/exec` endpoint issues a 302 that must be followed as a GET, not a POST, per its own redirect contract.
**How to avoid:** The production middleware is unaffected (its axios calls use `maxRedirects: 5` and follow correctly). This is purely a **manual verification / curl-testing pitfall** — when the owner or an agent probes the live endpoint by hand during redeploy verification, omit `-X POST` and let curl's 302 handling downgrade to GET (documented in the Phase 51-03 SUMMARY's "Operational findings"). Flag this explicitly in any manual verification steps the plan writes.

### Pitfall 5: Over-engineering the concurrency guard
**What goes wrong:** Copying the gift-card ledger's `LockService` + claim-before-mutate machinery onto a waitlist signup, because it's the freshest and most-discussed precedent in this codebase.
**Why it happens:** Recency bias from Phase 51 being the most recent, most heavily documented sheet-write pattern in the repo.
**How to avoid:** Match the rigor to the risk. D-01 already accepts "sheets are weak under concurrent writes" as a cost for this phase. `addReservation` — a public-form-to-sheet-append with no lock — is the correctly-scoped precedent, not `redeemGiftCard`. A genuine double-submit (same email, same category, within milliseconds) is handled by D-06's idempotency check, not by a lock; the two are different mitigations for different failure modes and only one is warranted here.
**Warning signs:** A plan task proposes `acquireScriptLock` for the waitlist append/status handlers — that's the signal to push back per this research.

### Pitfall 6: Sheets formula-injection risk on free-text fields, still open elsewhere in this codebase
**What goes wrong:** `sanitizeInput()` (`adminApi.gs:3433-`) strips `<script>` tags and inline event handlers but does **not** neutralize a leading `=`, `+`, `-`, or `@` character — the exact class of Sheets formula-injection risk tracked as **M9** in `REQUIREMENTS.md`, explicitly deferred out of Phase 51 (`51-03-SUMMARY.md`: "M9 — formula-injection sanitization... Deferred, D-01"). D-08's free-text `notes` column (and the `email` field itself, if a customer submits `=IMPORTRANGE(...)@evil.com`-shaped input, though the email regex constrains this somewhat) inherit this same unaddressed risk class.
**How to avoid:** This is a known, project-wide, explicitly-deferred gap — not something this phase is obligated to fix. Flag it in the plan as an accepted risk consistent with the rest of the sheet estate (same posture as every other `sanitizeInput()`-protected free-text field today), rather than silently reproducing it without acknowledgment. A cheap local mitigation (strip a leading `=+-@` specifically on the `notes` write) is optional discretion, not a requirement.

## Code Examples

### Reading the waitlist list (BrewPad → middleware → Apps Script)
```javascript
// Source: js/brewpad.js:1547-1566 (adminApiGet, existing helper, reused as-is)
function adminApiGet(action, params) {
  var body = { action: action };
  if (params) Object.keys(params).forEach(function (key) { body[key] = params[key]; });
  // Reads retry twice on transient 502/503/504 (Apps-Script cold-start).
  return fetchWithRetry(mwUrl() + '/api/batch/admin-proxy', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 2, [502, 503, 504]).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok || !data || !data.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
      return data;
    });
  });
}
// Usage: adminApiGet('get_waitlist').then(function (res) { renderWaitlist(res.data); });
```

### Writing a status transition (no retry — write-retry constraint from Phase 77)
```javascript
// Source: js/brewpad.js:1568-1586 (adminApiPost, existing helper, reused as-is — note the
// call to fetchWithRetry with NO retry-count argument, which defaults to `retries = 1` inside
// fetchWithRetry itself (js/brewpad.js:1519) for the underlying network-level-rejection case
// only — retryStatuses is undefined here, so an actual 502/503/504 HTTP response is NOT
// retried, only a hard network failure (offline/DNS) is. This is the write-retry asymmetry
// carried forward from Phase 77/D-03's "reads may retry, writes must NOT" rule.)
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
// Usage: adminApiPost('update_waitlist_status', { id: row.id, status: 'contacted' });
```

### Pure test pattern for the D-06 dedupe decision (no live Sheets runtime needed)
```javascript
// Source: tests/frontend/adminapi-giftcard-ledger.test.js:1-40 (Phase 51's `new Function`
// source-extraction harness, itself following adminapi-recipe-pure.test.js's precedent).
// This loads apps-script/adminApi.gs as TEXT and evaluates only the pure helper functions
// via `new Function`, since SpreadsheetApp/LockService/Session/CacheService have no local
// implementation outside Google's runtime. A `waitlistDedupeDecision` pure function should
// be tested this same way — this is the ONLY testable-in-CI part of the Apps Script side of
// this phase; ensureWaitlistSheet/addWaitlistEntry/updateWaitlistStatus (the actual Sheets
// I/O) can only be asserted by source-shape review + a live probe (mirroring 51-03 Task 3),
// never by an automated Jest suite.
var fs = require('fs');
var src = fs.readFileSync('apps-script/adminApi.gs', 'utf8');
// ... extraction technique continues per the cited file
```

## State of the Art

Not applicable in the "library version drift" sense — this phase makes no framework-version decisions. The one relevant "current vs. superseded" fact:

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| MailerLite as the entire waitlist record | `Waitlist` sheet tab as system of record, MailerLite demoted to best-effort sync | This phase (D-01/D-03) | `POST /api/waitlist`'s 503-on-MailerLite-unconfigured guard (`server.js:216-219`) must move to gate on the sheet write instead, per the CONTEXT.md Planner note — not be deleted |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | MailerLite's subscriber-list UI has a toggleable "date subscribed" column and the CSV export can include it, in a format similar to the API's `subscribed_at` (`yyyy-MM-dd HH:mm:ss`) | Open Questions (D-04) | If the exportable column is missing, coarser than a real timestamp, or in an unstated timezone, the D-04 backfill cannot honestly order pre-cutover signups — the owner must be told explicitly before cutover rather than importing undated rows in arbitrary order (per CONTEXT.md's own instruction) |
| A2 | A fourth local `callAppsScript`-style helper in `server.js` (rather than extracting a shared `lib/apps-script.js`) is the in-scope choice | Pattern 5 | Low — if the planner instead extracts a shared helper, that's a reasonable judgment call, not a correctness risk; flagged only because CLAUDE.md rule 3 favors not touching unrelated code |
| A3 | A plain full-table scan (Pattern 3) without `LockService` is sufficient for this phase's expected waitlist volume (a low-traffic shop) | Common Pitfalls #5 | If signup volume is materially higher than assumed, a true double-submit race becomes more likely — D-06's idempotency check still prevents a duplicate ROW, but two near-simultaneous first-time signups for different emails racing on `appendRow` is a pre-existing, accepted sheet-write risk (D-01), not new here |

## Open Questions

1. **Does MailerLite's CSV export actually carry a usable per-subscriber signup timestamp, and in what format/timezone? (D-04's explicit blocking question)**
   - What we know: MailerLite's REST API subscriber object confirmed exposes a `subscribed_at` field in `yyyy-MM-dd HH:mm:ss` format (`[CITED: developers.mailerlite.com/docs/subscribers.html]`, MEDIUM confidence — timezone not stated in the fetched docs). Multiple secondary sources (MailerLite's own "How To Export Subscribers" help article, aggregated via WebSearch, and a related "how subscribers are found" help page) consistently describe the subscriber list overview as showing "the date they subscribed" as a toggleable column, and state the CSV export mirrors whichever columns are currently visible/toggled on before export (`[CITED, MEDIUM confidence: mailerlite.com/help/how-to-export-subscribers]`, cross-referenced by a second independent summary).
   - What's unclear: I could not obtain a primary-source, verbatim confirmation of (a) the exact CSV column header name for the exported date field, (b) whether it is a date-only or full timestamp in the exported file specifically (vs. the API's full timestamp), or (c) its timezone. WebFetch against MailerLite's own help pages returned only paraphrased summaries from a smaller intermediary model, not the literal article text, for this specific detail — the underlying column list appears to live in a UI screenshot the fetch tool cannot read, not in the article's crawlable text.
   - Recommendation: **Do not treat this as resolved.** Before D-04's backfill task runs, the owner must log into the live MailerLite account, open the beer waitlist group's subscriber list, click "Set columns"/"Toggle columns", and confirm a per-subscriber date field is available and exportable. If it is present, capture its exact format (screenshot or a sample row) for the person doing the CSV-to-sheet paste, since the `Waitlist` tab's timestamp column will need to parse whatever format actually comes out. If it is **absent**, CONTEXT.md D-04 is explicit: do not silently import undated rows in arbitrary order — tell the owner directly that pre-cutover signups cannot be honestly ordered, and get an explicit decision (e.g., import them all as a single "legacy signup" batch dated at cutover, sorted alphabetically or left as a flagged group) before writing any backfill code.

2. **Exact column layout for the `Waitlist` tab.**
   - What we know: CONTEXT.md leaves this to Claude's discretion, constrained by needing to represent `category` (D-02), status (D-05: `waiting`/`contacted`/`booked`/`removed`), `mailerlite_synced` (D-07), free-text `notes` (D-08), and an arrival timestamp for ordering.
   - What's unclear: Whether column A should be a generated `id` (enabling `findRowById` reuse for status updates, Pattern 2) or the customer's email (which would make D-06's dedupe check a column-A lookup instead of a full scan, but complicates `findRowById`'s "column A = unique key" assumption if the same email can later appear again for a different category, per D-02's multi-category future).
   - Recommendation: Use a generated `id` in column A (mirroring `GiftCards`' `cert_number`-as-key pattern is money-specific; a simple incrementing or UUID-based `id`, mirroring `Utilities.getUuid()` used for `tx_id`, is cleaner and avoids ever needing PII in the lookup key). Keep `email` + `category` as ordinary columns that `waitlistDedupeDecision` scans, exactly as `giftCardLedgerDecision` scans `cert_number` rather than relying on it being column A.

## Environment Availability

Skipped — this phase has no new external tool/service/runtime dependency. `APPS_SCRIPT_URL` and `APPS_SCRIPT_SERVER_TOKEN` are already-configured Railway env vars (`zoho-middleware/.env.example:103`); MailerLite's API key is already configured or gracefully degrades (`mailerlite.isConfigured()` guard, unchanged surface).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | Partial | No new auth surface — public signup stays unauthenticated (rate-limited); staff reads/writes reuse `authTiers.requireTiers(['legacy','session'])` already enforced on `/api/batch/admin-proxy` (`pos.js:4027`) |
| V3 Session Management | No | Unchanged — BrewPad's existing `sv_session`/`x-session-token` model (Phase 76) applies unmodified |
| V4 Access Control | Yes | New `get_waitlist`/`update_waitlist_status` actions must be added to BOTH `ADMIN_PROXY_ACTIONS`/`ADMIN_PROXY_READS` (session-tier gated) and the `adminApi.gs` `server_token` dispatch — device tier is correctly excluded (BrewPad is session-scoped, same as every other admin-proxy action) |
| V5 Input Validation | Yes | Email format validated by the existing regex (`server.js:213`); free-text `notes`/`category` pass through `sanitizeInput()` — same posture as every other staff-editable sheet field in this codebase |
| V6 Cryptography | No | No new secrets — reuses `APPS_SCRIPT_SERVER_TOKEN`/`SERVER_WRITE_TOKEN` |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Waitlist-membership disclosure via signup response (D-06 explicitly requires no disclosure) | Information Disclosure | Return the same generic success response whether the row was newly created or already existed — never branch the HTTP response shape on the dedupe decision's `existing`/`new` outcome |
| Sheets formula injection (`=`, `+`, `-`, `@` leading chars) on the free-text `notes`/email fields | Tampering | **Known open gap (M9), not fixed by this phase** — `sanitizeInput()` does not neutralize this class; flagged in Common Pitfalls #6 as an accepted, project-wide risk unless the planner chooses to add a minimal local mitigation |
| Rate-limit bypass on repeated signup attempts | Denial of Service | Already covered by `waitlistLimiter` (Redis-backed, `server.js:200-209`), unchanged by this phase |
| PII exposure via `get_waitlist` (emails are personal data) | Information Disclosure | Gated behind session/legacy tier only (staff), same posture as `get_gift_cards`/batch data — no public read path is being added |

## Sources

### Primary (HIGH confidence — read directly from the repository)
- `zoho-middleware/server.js:190-233` — current `/api/waitlist` handler, rate limiter, MailerLite gate
- `zoho-middleware/lib/mailerlite.js` — full file, `isConfigured()`/`addSubscriber()` surface
- `apps-script/adminApi.gs:70-234` (doGet, handleReadAction), `:240-360` (doPost server_token dispatch), `:1416-1455` (sheetToObjects), `:1473-1520` (findRowById), `:1236-1240` (acquireScriptLock), `:3404-3424` (_cachedGet/_invalidateBatchCache), `:3433-3450` (sanitizeInput), `:4109-4822` (gift-card ledger: setupGiftCardLedger, ensureGiftCardLedgerSheet, giftCardLedgerDecision, appendGiftCardClaim, settleGiftCardClaim, flagGiftCardClaim, voidGiftCard, getGiftCards), `:910-949` (addReservation)
- `zoho-middleware/routes/pos.js:3990-4064` — ADMIN_PROXY_ACTIONS, ADMIN_PROXY_READS, `/api/batch/admin-proxy`
- `zoho-middleware/routes/gift-cards.js:1-38` — `callAppsScript` blocking-call pattern
- `zoho-middleware/lib/checkout-helpers.js:90-101` — `notifyAdminPanel` fire-and-forget pattern (contrast case)
- `js/brewpad.js:1518-1587` (fetchWithRetry, adminApiGet, adminApiPost), `:2300-2339` (switchTab)
- `brewpad.html:288-309` — bp-tab-bar structure
- `js/modules/12-checkout.js:1689-1710` — setupBeerWaitlistForm (live client handler)
- `js/modules/13-init.js:376-382` (dead home call), `:415-445` (live beer call)
- `beer.html:159-166` (the literal "in order" quote), `:280-292` (live form)
- `tests/frontend/adminapi-giftcard-ledger.test.js:1-40` — pure-extraction test harness pattern
- `tests/frontend/checkout-waitlist.test.js` — existing frontend client coverage
- `zoho-middleware/__tests__/mailer.test.js:162` — only existing coverage of the staff-notification subject line
- `.planning/phases/51-gift-card-ledger-integrity/51-03-SUMMARY.md` — live-deploy record, D-09 manual-redeploy reality, the non-JSON-redirect operational finding
- `.planning/todos/pending/remove-dead-beer-waitlist-handler.md` — supersession note, confirms which call site is genuinely dead
- `.planning/config.json` — `nyquist_validation: false`, `security_enforcement: true`

### Secondary (MEDIUM confidence)
- MailerLite REST API docs (`developers.mailerlite.com/docs/subscribers.html`) — `subscribed_at`/`created_at` field format, fetched via WebFetch
- MailerLite help article "How To Export Subscribers" (`mailerlite.com/help/how-to-export-subscribers`) — export mechanism (toggle columns before export), fetched via WebFetch and cross-referenced via WebSearch aggregation

### Tertiary (LOW confidence — flagged, not relied on for any locked recommendation)
- WebSearch-aggregated claims about a specific "Signup date"/"date they subscribed" CSV column label — consistent across multiple independent search-result summaries but never confirmed against the literal primary-source article text; see Open Questions §1

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, everything read directly from the repo
- Architecture: HIGH — every integration point cited to a real file:line the researcher read
- Pitfalls: HIGH — five of six pitfalls are drawn from documented live incidents in this exact codebase (Phase 51, Phase 69, Phase 76/77); the sixth (formula injection) is a confirmed-open, documented backlog item (M9)
- MailerLite CSV export (D-04): MEDIUM at best — could not obtain primary-source verbatim confirmation of the exact export column name/format/timezone; explicitly flagged for owner manual verification before cutover

**Research date:** 2026-09-02
**Valid until:** 30 days for the codebase-pattern findings (stable, slow-moving internal architecture); the MailerLite finding should be re-verified directly against the live MailerLite account at D-04 execution time regardless of this document's age, since it was never independently confirmed here.
