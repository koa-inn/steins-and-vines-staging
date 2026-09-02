# Phase 51: Gift-Card Ledger Integrity - Pattern Map

**Mapped:** 2026-09-02
**Files analyzed:** 6 (2 primary edit targets, 2 secondary/discretionary edit targets, 1 test file, 1 owner-checkpoint plan to imitate)
**Analogs found:** 4 strong / 2 partial / 1 genuinely novel (no analog exists)

**Read this first:** unlike most phases, the primary edit target (`apps-script/adminApi.gs`) has
**no local execution environment** — `npm test` cannot exercise a single Sheets write in this file.
Every pattern below drawn from `adminApi.gs` is a *structural* analog (same file, same idioms), not
a *tested* one. The planner should treat the ledger-write logic itself as novel and unverifiable
except by the Phase 79-04 style live-probe checkpoint.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps-script/adminApi.gs` — new `GiftCardTransactions` sheet bootstrap function | migration/setup | event-driven (idempotent one-shot) | `setupRecipeTabs()` (`:4048-4106`) | exact — same file, same `getSheetByName() \|\| insertSheet()` idiom |
| `apps-script/adminApi.gs` — `redeemGiftCard` (`:4204-4256`) rewritten to claim-before-mutate | service/handler | CRUD (money-mutating) | itself (pre-image) + `updateBatch`'s `VesselHistory` append (`:2415-2429`) for the claim-append shape | role-match — VesselHistory is the only append-only ledger precedent in the file |
| `apps-script/adminApi.gs` — `reloadGiftCard` (`:4264-4306`) same rewrite | service/handler | CRUD (money-mutating) | same as above | role-match |
| `apps-script/adminApi.gs` — new ledger-read helper (e.g. `findLedgerEntry(certNum, txRef)`) | utility | CRUD (read) | `checkLocationConflict` (`:1386-1401`) — `sheetToObjects` + manual multi-field filter loop | role-match — `findRowById` does NOT fit (column-A-only) |
| `apps-script/adminApi.gs` — `voidGiftCard` (`:4314-4351`), optional per Claude's-discretion | service/handler | CRUD (status-only) | itself (pre-image); no atomicity defect today (single status write) | exact (if touched at all) |
| `apps-script/adminApi.gs` — `updateGiftCardInvoice` (`:4358-4377`), optional per Claude's-discretion | service/handler | CRUD | `redeemGiftCard`'s lock usage, if brought under `acquireScriptLock` | role-match |
| `zoho-middleware/routes/gift-cards.js` / `routes/pos.js` gift-card call sites | route/controller | request-response (proxy to Apps Script) | itself — no restructuring expected unless response shape changes | exact, low-risk (thin passthrough) |
| `zoho-middleware/__tests__/*` new/changed gift-card tests | test | request-response (mocked) | `zoho-middleware/__tests__/pos-gift-card.test.js` | exact, but see "No Analog Found" — it cannot reach the ledger |

## Pattern Assignments

### `apps-script/adminApi.gs` — create `GiftCardTransactions` sheet (D-10)

**Analog:** `setupRecipeTabs()` (`apps-script/adminApi.gs:4044-4106`) — the only place in this file
that creates a sheet programmatically. Confirms D-10 is *following* an established pattern, not
inventing one.

**Core pattern** (lines 4048-4067, trimmed):
```javascript
function setupRecipeTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var recipesSheet = ss.getSheetByName(RECIPES_SHEET_NAME);
  if (!recipesSheet) {
    recipesSheet = ss.insertSheet(RECIPES_SHEET_NAME);
    recipesSheet.appendRow([
      'recipe_id', 'name', 'style', /* ... */
    ]);
    recipesSheet.getRange(1, 1, 1, 17).setFontWeight('bold');
    recipesSheet.setFrozenRows(1);
    Logger.log('Created Recipes tab with 17 columns');
  } else {
    Logger.log('Recipes tab already exists — skipped');
  }
  // ... second tab, same shape ...
}
```
This is a **standalone function meant to be run manually from the Apps Script editor** ("Run
manually from Apps Script editor... Safe to re-run — skips tabs that already exist"), NOT called
from `doPost`/`doGet` dispatch. It is idempotent by construction (`if (!sheet)`). The equivalent for
this phase is a `setupGiftCardTransactionsTab()` (or folded into a `setupGiftCardLedger()`) run once
by the owner post-deploy, using the exact same `getSheetByName() || insertSheet()` + `appendRow`
header + `setFontWeight('bold')` + `setFrozenRows(1)` shape.

**Sheet-name constant declaration pattern** (`apps-script/adminApi.gs:56-59`):
```javascript
var VESSEL_HISTORY_SHEET_NAME = 'VesselHistory';
var RECIPES_SHEET_NAME = 'Recipes';
var RECIPE_INGREDIENTS_SHEET_NAME = 'RecipeIngredients';
var GIFT_CARDS_SHEET_NAME = 'GiftCards';
```
Add `var GIFT_CARD_TRANSACTIONS_SHEET_NAME = 'GiftCardTransactions';` alongside these — same block,
same naming convention (`<Concept>_SHEET_NAME`).

**Do NOT copy `generateNextId`'s pattern for the ledger's own row-id if a running counter is wanted**
— `generateNextId` (`:1241-1263`) scans column A for the max existing numeric suffix, which is safe
for a low-write-rate sheet (`VesselHistory`, `Recipes`) but was exactly the O(n) full-column-scan
class of cost the Phase 79 research targeted for RecipeIngredients. For a ledger that grows on every
redeem/reload, `Utilities.getUuid()` or a timestamp+cert composite key is a cheaper alternative worth
raising with the planner — flagging, not deciding, since column-1 scans (`VesselHistory`'s
`generateNextId(VESSEL_HISTORY_SHEET_NAME, 'VH-', 6)`) are the only existing precedent and cost is a
new concern this phase introduces.

---

### `apps-script/adminApi.gs` — `redeemGiftCard` / `reloadGiftCard` claim-before-mutate rewrite

**Analog for the append-only write itself:** the `VesselHistory` append inside `updateBatch`
(`apps-script/adminApi.gs:2415-2429`):
```javascript
var ss = SpreadsheetApp.getActiveSpreadsheet();
var vesselSheet = ss.getSheetByName(VESSEL_HISTORY_SHEET_NAME);
if (vesselSheet) {
  var vhId = generateNextId(VESSEL_HISTORY_SHEET_NAME, 'VH-', 6);
  vesselSheet.appendRow([
    vhId,
    payload.batch_id,
    current.vessel_id || '',
    current.shelf_id || '',
    current.bin_id || '',
    now,
    userEmail,
    sanitizeInput(updates.transfer_notes || '')
  ]);
}
```
Two important, load-bearing observations from reading this in context:

1. **This append happens BEFORE the mutating field writes** (the `allowedFields.forEach` loop that
   actually changes `Batches` columns starts at line 2450, twenty lines later). Structurally this
   *is* a claim-before-mutate shape — VesselHistory is written first, then the state change follows.
   That makes it the closest structural precedent for D-02's "write the claim row before the balance
   changes."
2. **But it is NOT wrapped in the same `acquireScriptLock` critical section as `redeemGiftCard`/
   `reloadGiftCard`** — `updateBatch`'s lock usage was not traced further here since it is out of
   phase scope; the planner should verify `updateBatch`'s lock boundaries before treating this as
   proof that "append then mutate, same lock" is an already-tested pattern in this codebase. It is
   the closest analog, not a proven one.
3. **VesselHistory has no read-guard.** Nothing in `adminApi.gs` reads `VesselHistory` back to decide
   whether to skip a write (no idempotency check against it). The gift-card ledger's core new
   requirement — reading the ledger back as the idempotency guard instead of `last_tx_ref` — has **no
   precedent anywhere in this file.** This part of D-02 is genuinely novel; say so plainly to the
   planner rather than implying VesselHistory already does this.

**Current (pre-fix) redeemGiftCard, full function** (`apps-script/adminApi.gs:4204-4256`) — this is
the exact code the plan will restructure:
```javascript
function redeemGiftCard(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var amount = parseFloat(payload.amount);
  var txRef = String(payload.transaction_ref || '');

  if (!certNum || isNaN(amount) || amount <= 0 || !txRef) {
    return { ok: false, error: 'missing_fields' };
  }

  var lock = acquireScriptLock(15000);
  try {
    var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
    if (result.row === -1) return { ok: false, error: 'not_found' };

    var gc = result.data;

    // T-44-05: idempotency — same tx_ref returns prior result without decrementing
    if (String(gc.last_tx_ref) === String(txRef)) {
      return { ok: true, idempotent: true, new_balance: parseFloat(gc.current_balance) || 0 };
    }

    if (String(gc.status) !== 'active') {
      return { ok: false, error: 'invalid_status', status: gc.status };
    }

    var balance = parseFloat(gc.current_balance) || 0;
    if (amount > balance + 0.001) {
      return { ok: false, error: 'insufficient_balance', balance: balance };
    }

    var newBalance = Math.round((balance - amount) * 100) / 100;
    var newStatus = newBalance <= 0 ? 'depleted' : 'active';
    var now = new Date().toISOString();

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var balCol = headers.indexOf('current_balance') + 1;
    var statusCol = headers.indexOf('status') + 1;
    var updatedCol = headers.indexOf('last_updated') + 1;
    var txRefCol = headers.indexOf('last_tx_ref') + 1;

    sheet.getRange(result.row, balCol).setValue(newBalance);
    sheet.getRange(result.row, statusCol).setValue(newStatus);
    sheet.getRange(result.row, updatedCol).setValue(now);
    sheet.getRange(result.row, txRefCol).setValue(txRef);

    invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
    return { ok: true, new_balance: newBalance, status: newStatus };
  } finally {
    lock.releaseLock();
  }
}
```
`reloadGiftCard` (`:4264-4306`) is byte-for-byte the same shape with `+` instead of `-`, no
`insufficient_balance` check, and a `void`-status guard instead of an `active`-status guard. Any fix
must be applied to both — D-07 is explicit that fixing only one leaves the bug half-live.

**Header-driven column resolution pattern** (repeated identically in `redeemGiftCard`,
`reloadGiftCard`, `voidGiftCard`, `updateGiftCardInvoice`):
```javascript
var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
var balCol = headers.indexOf('current_balance') + 1;
```
Copy this idiom for any new column added to `GiftCardTransactions` or `GiftCards` — the file never
hardcodes column indices positionally (per the file's own comment at `:4112-4114`).

**Lock acquisition pattern** (used identically by all four gift-card handlers):
```javascript
var lock = acquireScriptLock(15000);
try {
  // ... read, check, write ...
} finally {
  lock.releaseLock();
}
```
`acquireScriptLock` (`apps-script/adminApi.gs:1235-1239`):
```javascript
function acquireScriptLock(timeoutMs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 10000);
  return lock;
}
```
D-06 already establishes this lock protects against **concurrent** double-spend, not the **single
interrupted execution** this phase targets — the lock does not help with the crash-mid-write window
at all (the lock is held by the one execution that crashes; nothing else is contending). Preserve
this lock usage for its existing purpose; do not treat it as solving D-02.

**Read/lookup helper — `findRowById`** (`apps-script/adminApi.gs:1472` onward, relevant excerpt):
```javascript
function findRowById(sheetName, id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return { sheet: sheet, row: -1, data: null, headers: null };
  // ... matches id against COLUMN A ONLY (first header key) ...
}
```
**This does not fit the ledger.** `findRowById` matches strictly against column A. A ledger guard
needs to find a row by the pair `(cert_number, tx_ref)` (or `tx_ref` alone if `tx_ref` is
sheet-global-unique) — neither is a single-column-A lookup unless `tx_ref` itself is made column A of
`GiftCardTransactions`. The closest existing multi-field-filter precedent is `checkLocationConflict`:

**Multi-field filter pattern** (`apps-script/adminApi.gs:1386-1401`):
```javascript
function checkLocationConflict(vesselId, shelfId, binId, excludeBatchId) {
  if (!vesselId) return '';
  var batches = sheetToObjects(BATCHES_SHEET_NAME);
  for (var i = 0; i < batches.length; i++) {
    var b = batches[i];
    if (excludeBatchId && String(b.batch_id) === String(excludeBatchId)) continue;
    var s = String(b.status || '').toLowerCase();
    if (s !== 'primary' && s !== 'secondary') continue;
    if (String(b.vessel_id || '') === String(vesselId) &&
        String(b.shelf_id || '') === String(shelfId || '') &&
        String(b.bin_id || '') === String(binId || '')) {
      return String(b.batch_id);
    }
  }
  return '';
}
```
`sheetToObjects` (`apps-script/adminApi.gs:1422-1454`) full-reads a sheet into row objects and caches
per-request (`_sheetCache`); `checkLocationConflict` then does a manual linear filter. This is the
pattern to copy for a `findLedgerEntry(certNum, txRef)`-style guard — NOT `findRowById`. Note
`sheetToObjects`'s cache is invalidated via `invalidateSheetCache(sheetName)` (`:1459-1465`), the
same call already used after every `GiftCards` write (`invalidateSheetCache(GIFT_CARDS_SHEET_NAME)`)
— a new `GiftCardTransactions` write must invalidate its own cache key identically, or a same-request
re-read (unlikely today, but the ledger read-then-write sequence makes it newly relevant) could see a
stale ledger.

---

### `apps-script/adminApi.gs` — gift-card action dispatch (no change expected, context only)

**Analog:** the dispatch block itself (`apps-script/adminApi.gs:298-319`):
```javascript
// Gift-card lifecycle actions (server_token-gated, D-05)
if (action === 'issue_gift_card') {
  return _jsonResponse(issueGiftCard(payload));
}
if (action === 'lookup_gift_card') {
  return _jsonResponse(lookupGiftCard(payload));
}
if (action === 'redeem_gift_card') {
  return _jsonResponse(redeemGiftCard(payload));
}
if (action === 'reload_gift_card') {
  return _jsonResponse(reloadGiftCard(payload));
}
if (action === 'void_gift_card') {
  return _jsonResponse(voidGiftCard(payload));
}
if (action === 'update_gift_card_invoice') {
  return _jsonResponse(updateGiftCardInvoice(payload));
}
if (action === 'get_next_cert_number') {
  return _jsonResponse({ ok: true, suggested: generateNextId(GIFT_CARDS_SHEET_NAME, 'GC-', 6) });
}
```
No new action is required by CONTEXT.md's decisions — the fix lives entirely inside the existing
`redeemGiftCard`/`reloadGiftCard` function bodies. If the response shape changes (e.g. adding
`needs_manual_review` to the Apps Script response itself, per D-08's "ledger row is the natural
home"), every caller enumerated below must be checked against the new shape.

---

## Shared Patterns

### Claim-before-mutate — NO analog closes the actual gap (answer to research Q2)

Two candidate "claim" patterns exist in the codebase; **neither is in the same failure domain as the
Apps Script write it would need to guard**, which is exactly D-06's point:

1. **`lib/money-path.js` (`zoho-middleware/lib/money-path.js:56-127`)** —
   `acquireIdempotencyLock` / `assertTxnNotReplayed` / `markTxnUsed` write to **Redis**, from
   **Node.js**, guarding the **middleware's own** retry/replay behaviour (Helcim transaction ids,
   checkout idempotency keys). None of the three ever calls into `adminApi.gs`. If Apps Script dies
   mid-write after these already marked the transaction "used" in Redis, Redis's claim is
   already-committed truth that doesn't match Sheets reality — the reverse of what's needed.
2. **`KIOSK_PENDING_CHARGE_PREFIX` pending-charge record** (`zoho-middleware/routes/pos.js:898-909`):
   ```javascript
   // D-13 (45-07): persist pending-charge context for the reconciliation backstop (45-08).
   // Written fire-and-forget after every successful push so a client-side timeout
   // leaves a reconcilable trail.  Key = KIOSK_PENDING_CHARGE_PREFIX + refNumber.
   var pendingCacheKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber;
   var pendingContext = { reference_number: refNumber, amount: terminal_amount, /* ... */ };
   cache.set(pendingCacheKey, pendingContext, KIOSK_PENDING_CHARGE_TTL).catch(function () {});
   ```
   This is a genuine claim-before-mutate: written to Redis **after the terminal push succeeds but
   before the client's confirm/response cycle completes**, specifically so a client-side timeout
   still leaves a reconcilable trail. It is the best *middleware-side* precedent for "durable record
   written early, reconciled later" — but it protects the **Helcim terminal charge**, a call the
   middleware itself makes. It has no bearing on an Apps Script execution that the middleware has
   already handed a fire-and-forget `axios.post` to (see Q3/Q4 below) — restating D-06's constraint
   concretely: a Redis claim written by Node cannot survive or detect a crash inside Google's Apps
   Script runtime, a completely separate process on a separate host.

**Conclusion for the planner:** the durable claim D-02 requires must be written **inside
`redeemGiftCard`/`reloadGiftCard` themselves, in the same Sheets write sequence, before the balance
`setValue`** — there is no existing helper or pattern anywhere in the codebase that already does
this. This is the single most novel piece of code in the phase.

### `needs_manual_review` — confirmed response-flag/Redis-sentinel only (answer to research Q6)

Grep across the middleware turned up no sheet or database write for `needs_manual_review` — it is
set only as a JSON response field. Two direct examples:

`zoho-middleware/routes/pos.js:1845-1847` (gift-card activation failure path):
```javascript
if (giftCardActivationFailed) {
  // ...
  result.needs_manual_review = true;
}
```
`zoho-middleware/__tests__/pos-money.test.js` (T12, void-failure path) confirms the Redis-sentinel
half of the claim:
```javascript
expect(statusCapture.code).toBe(502);
expect(body.needs_manual_review).toBe(true);
// sv:void-failure: record must be persisted
var cacheSetCalls = cache.set.mock.calls;
var voidFailureRecord = cacheSetCalls.find(function (c) {
  return typeof c[0] === 'string' && c[0].indexOf('sv:void-failure:') === 0;
});
expect(voidFailureRecord).toBeTruthy();
expect(voidFailureRecord[1].needs_manual_review).toBe(true);
```
`zoho-middleware/__tests__/pos-gift-card.test.js:1273` names the exact scenario this phase must make
durable:
```javascript
test('confirm: issue activation failure → 201 with gift_card_activation_failed:true + needs_manual_review:true + CRITICAL log', function (done) { ... });
```
CONTEXT.md's D-08 claim is **confirmed accurate**: today `needs_manual_review` never touches a sheet
row. There is no analog for "persist `needs_manual_review` on the `GiftCards`/`GiftCardTransactions`
row" anywhere in the codebase — this is new, and the regression test the plan writes must assert a
persisted field (a ledger-row status/flag column), not merely the response body or the
`sv:void-failure:` cache key, per D-08's explicit instruction.

### Owner-redeploy checkpoint + live-probe structure (answer to research Q7, D-09)

**Source:** `.planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-04-PLAN.md`
**Apply to:** this phase's final wave, verbatim structure.

The reusable shape, extracted directly from 79-04:

1. **A preceding `auto` task is read-only and pre-flight-verifies the diff** before any owner
   involvement — grep-counts every expected function/pattern addition, confirms no forbidden file was
   touched (`git diff --name-only <range>` enumerated exactly), runs `npm test` /
   `cd zoho-middleware && npm test` / `npm run lint`, and assembles the "probe brief" (concrete
   values the owner needs — e.g. a specific low-value test cert number, baseline behaviour to beat).
   It explicitly does **not** touch `APPS_SCRIPT_URL` / `APPS_SCRIPT_SERVER_TOKEN`.
2. **A `checkpoint:human-verify` / `gate: blocking-human` task** with:
   - `<read_first>` pointing at the rewritten function, the pre-flight task's recorded values, and
     the prior redeploy-checkpoint precedent (79-04 itself cites 76-01).
   - `<action>`: present the checkpoint and BLOCK — do not redeploy on the owner's behalf, do not run
     any probe requiring the server token.
   - `<what-built>`: plain-language summary of what shipped and the explicit statement **"None of
     this is live yet"** plus the blast-radius warning (one deployment/one Sheet serves both staging
     and prod).
   - `<how-to-verify>`: numbered steps — **Step 1: record BEFORE state** (so any deviation is
     detectable), **Step 2: record the current deployment version as rollback point, then deploy**,
     **Step 3+: probes in the DANGEROUS direction first** (Phase 79's Probe C pattern: "prove your
     edits are NOT silently thrown away... **If X does NOT persist: STOP IMMEDIATELY and roll back**"
     — this is the exact template D-11 calls for: prove a replayed `transaction_ref` does NOT change
     the balance a second time, using a disposable low-value test cert per D-11).
   - `<resume-signal>`: a literal phrase the owner types back, or a description of the failure mode.
3. **`<threat_model>` STRIDE register** naming the redeploy blast radius, the server-token exposure
   risk in any curl-based probe, and "declaring success from a stopwatch alone" as a Repudiation risk
   mitigated by requiring multiple independent probes (id-stability + a direct-diagnostics call),
   not speed alone.

Reuse this shape unmodified for Phase 51's redeploy wave; only the concrete probes change (redeem a
$1 test cert, replay the identical `transaction_ref`, confirm balance is unchanged the second time —
D-11's dangerous-direction requirement — plus a `needs_manual_review` persistence probe for D-08).

### Gift-card call graph (answer to research Q3) — every surface a response-shape change touches

Confirmed via grep across `zoho-middleware/` and `js/`:

| Caller | File:approx line | Action | Notes |
|---|---|---|---|
| `GET /api/kiosk/gift-card/next-number` | `zoho-middleware/routes/gift-cards.js:50-72` | `get_next_cert_number` | cached 30s (M8), unaffected by this phase |
| `GET /api/kiosk/gift-card/lookup` | `zoho-middleware/routes/gift-cards.js:85-108` | `lookup_gift_card` | never cached (balance-freshness), unaffected |
| `POST /api/kiosk/gift-card/void` | `zoho-middleware/routes/gift-cards.js:122-159` | `void_gift_card` | only touched if Claude's-discretion item on `voidGiftCard` is exercised |
| `/api/kiosk/sale` pre-charge balance clamp | `zoho-middleware/routes/pos.js:719-759` (`lookup_gift_card` POST at `:739-744`) | `lookup_gift_card` | reads `r.data.current_balance` — no shape change needed unless `lookup_gift_card`'s response is touched |
| `/api/kiosk/sale/confirm` pre-payment re-clamp | `zoho-middleware/routes/pos.js:1396-1428` (`lookup_gift_card` POST at `:1400-1405`) | `lookup_gift_card` | same as above |
| `/api/kiosk/sale/confirm` redeem step | `zoho-middleware/routes/pos.js:1706-1735` | `redeem_gift_card` | reads `r.ok` and `r.error` only today; **this is the call site that must handle any new response fields** (e.g. a durable `needs_manual_review` echoed back, or a new `idempotent_replay` discriminator) |
| `/api/kiosk/sale/confirm` issue step | `zoho-middleware/routes/pos.js:1747-1784` | `issue_gift_card` then `update_gift_card_invoice` | out of scope (M18), but shares the `giftCardActivationFailed` flag with the redeem/reload steps — touching that flag's semantics affects this path too |
| `/api/kiosk/sale/confirm` reload step | `zoho-middleware/routes/pos.js:1786-1813` | `reload_gift_card` | reads `r.ok`/`r.error` only — same note as redeem step |

No gift-card call sites exist in `pos-recipe.js` or `admin.js` (admin.js consumes the shared
`js/kiosk-core.js` per the Phase 48 de-fork — no second copy). `js/kiosk-core.js` is the single
client-side authority for gift-card panel UI and the `transaction_ref`/`idempotency_key` minting
(see next section).

**Every one of the above reads only `{ ok, error, data? }`-shaped responses today.** If the plan adds
new fields to `redeemGiftCard`'s/`reloadGiftCard`'s return value (e.g. `needs_manual_review`,
`idempotent: true` is already returned today at `:4222` and IS consumed nowhere — the middleware
currently ignores the existing `idempotent` flag entirely at `pos.js:1715-1727`), that is a
backward-compatible additive change to all seven call sites above; no existing call site destructures
beyond `r.ok`/`r.data`/`r.error`, so additive fields are safe but currently silently dropped unless
the plan explicitly wires them through.

### `transaction_ref` generation and stability — LOUD FINDING (answer to research Q4)

**Server side (Apps Script):** `transaction_ref` is taken as-is from the request payload
(`apps-script/adminApi.gs:4207`, `:4267`: `var txRef = String(payload.transaction_ref || '');`) — no
minting happens in Apps Script. The value is entirely client/middleware-supplied.

**Middleware side:** in `/api/kiosk/sale/confirm` (`zoho-middleware/routes/pos.js:1333`):
```javascript
var refNumber = (body.reference_number || 'KIOSK-' + Date.now()).slice(0, 64);
```
and later, both money-moving Apps Script calls use this SAME `refNumber` as `transaction_ref`
(`:1713`, `:1793`). So the middleware itself never regenerates the ref mid-request — it is whatever
`body.reference_number` the client sent for this one HTTP call, falling back to a fresh mint only if
the client omitted it entirely.

**Client side — this is where stability actually breaks (`js/kiosk-core.js`):**
```javascript
// kiosk-core.js:2618-2623 (inside kioskStartCheckout / the "proceed to payment" entry point)
// Mint the ONE key for this attempt now that it is actually proceeding.
// Every re-entry within this attempt (GC panel Skip/Proceed, the
// stock-override resubmit) reads this SAME closure-captured value via
// the local `refNumber` below — never re-minted per invocation.
_kioskPaymentInFlight = true;
_kioskPaymentKey = 'KIOSK-' + Date.now();
```
```javascript
// kiosk-core.js:2813
var refNumber = _kioskPaymentKey || ('KIOSK-' + Date.now());
```
```javascript
// kiosk-core.js:2486-2493 — called from kioskShowError on EVERY terminal outcome
function _kioskEndPaymentAttempt() {
  _kioskPaymentInFlight = false;
  _kioskPaymentKey = null;
  // ...
}
```
```javascript
// kiosk-core.js:2521-2527 — the Retry button
if (retryBtn) {
  retryBtn.style.display = canRetry ? '' : 'none';
  retryBtn.onclick = function () {
    kioskShowView('browse');
    kioskStartCheckout();   // <-- re-enters the mint site at :2622-2623, fresh Date.now()
  };
}
```

**Plainly stated: `transaction_ref` is stable WITHIN a single payment attempt** (it survives the
gift-card panel's own Skip/Proceed round trip and the stock-override resubmit flow, by explicit
design comment) **but is NOT stable across a client-visible retry.** Every `kioskShowError(...,
canRetry=true)` call first clears `_kioskPaymentKey` to `null` (`_kioskEndPaymentAttempt`, called
unconditionally at the top of `kioskShowError`) and the Retry button re-enters `kioskStartCheckout()`,
which mints a brand-new `'KIOSK-' + Date.now()`. **A staff member tapping Retry after a failed sale
never resends the same `transaction_ref` — they start an entirely new sale, new terminal charge, new
everything.**

**What this means for the phase design:**
- A ledger keyed on `tx_ref` **cannot** detect the "staff retries the whole sale after an error"
  class of replay — that class does not exist today, because retries never reuse the ref.
- The double-decrement window this phase actually closes (per ROADMAP's root-cause block) is a
  **single interrupted execution inside one `/confirm` request's fire-and-forget
  `axios.post({action:'redeem_gift_card', transaction_ref: refNumber})` call**
  (`pos.js:1706-1735`) — and today, if that specific `axios.post` fails or times out, the code path
  (`:1728-1733`) logs CRITICAL and sets `giftCardActivationFailed = true`; **it does not automatically
  retry the call with the same `transaction_ref` at all.** No code path in this repo currently
  re-sends an identical `redeem_gift_card`/`reload_gift_card` payload.
- Therefore the realistic replay vector the durable claim guards against is **a manual retry** — a
  support engineer or the owner re-POSTing the identical payload directly to Apps Script during
  reconciliation (exactly what D-11's live probe simulates), or a future automated retry the
  reconciliation/backstop system might add. **The planner should design D-11's probe and D-02's guard
  around this manual/direct-replay scenario, not around the current kiosk client's Retry button**,
  since the client never exercises the vulnerable path today. This does not reduce the defect's
  severity (a crash mid-write still leaves the balance silently wrong even without any retry — the
  bigger problem is simply that the state is now inconsistent and unrecoverable, not just
  "double-decremented on retry"), but it does mean **there is no existing automated regression test
  that can exercise the actual client-triggered replay**, because the client-triggered replay does
  not exist. Flag this to the planner explicitly rather than assuming a client-side reproduction is
  possible.

### Gift-card test coverage — confirmed mocked-through, cannot reach Apps Script (answer to research Q5)

`zoho-middleware/__tests__/pos-gift-card.test.js` and siblings (`pos-giftcard.test.js`,
`gift-cards.test.js`, `giftcard-account-failclosed.test.js`) all `jest.mock('axios', ...)`
(`pos-gift-card.test.js:18-21`) and assert against `axiosMock.post.mock.calls` — e.g.:
```javascript
test('ordering: redeem_gift_card axios.post called AFTER both zohoPost payment calls', function (done) {
  // ...
  axiosMock.post.mockImplementation(function (url, body) {
    var parsed = JSON.parse(body);
    callOrder.push('axiosPost:' + (parsed && parsed.action));
    // ...
```
This confirms Phase 79's finding generalizes here too: **the middleware suite never reaches
`adminApi.gs`.** Every existing gift-card test proves "the middleware called axios.post with the
right JSON body in the right order," never "the Sheets write happened correctly, once, atomically."
**Criteria 6/7 (durable `needs_manual_review`, atomicity) cannot get real automated coverage from
this suite as it exists** — they need either (a) a genuinely new unit-testable extraction of the pure
comparison/decision logic out of `redeemGiftCard`/`reloadGiftCard` (mirroring the Phase 79
`tests/frontend/adminapi-recipe-pure.test.js` precedent, which tested pure helpers extracted from
`adminApi.gs` without needing `SpreadsheetApp`), or (b) the live-probe checkpoint (D-11). The planner
should plan for a pure-logic-extraction test file analogous to `adminapi-recipe-pure.test.js` if any
part of the new guard logic (e.g. deciding claim-vs-mutate ordering, or the ledger-lookup filter) can
be isolated from `SpreadsheetApp` calls.

## No Analog Found

| File/Concern | Role | Data Flow | Reason |
|---|---|---|---|
| Ledger read-as-idempotency-guard (replacing the `last_tx_ref` check) | service logic | CRUD | No sheet in this codebase is ever read back as a pre-mutation idempotency check before this phase — `VesselHistory` is written but never read back to gate a write. This is new logic, not an adapted pattern. |
| Claim-before-mutate write that survives an Apps Script execution crash | service logic | CRUD | No existing Apps Script function writes a durable marker BEFORE its own mutating writes in a way that has been proven to survive an interrupted execution (VesselHistory's ordering is suggestive but untested against this exact failure mode, and it guards a different field, not idempotency). |
| Durable `needs_manual_review` persisted on a sheet row | data model | CRUD | Confirmed above: today it is a response flag / Redis sentinel only, never a sheet write, anywhere in the codebase. |
| A regression test that actually reaches `redeemGiftCard`'s Sheets writes | test | request-response | The entire middleware test suite mocks `axios` before it ever reaches Apps Script (confirmed above); no test in this repo exercises `SpreadsheetApp` at all — it cannot run outside Google's environment. |

## Metadata

**Analog search scope:** `apps-script/adminApi.gs` (full-file grep + targeted reads), `zoho-middleware/lib/money-path.js`, `zoho-middleware/routes/pos.js`, `zoho-middleware/routes/gift-cards.js`, `js/kiosk-core.js`, `js/admin.js`, `zoho-middleware/__tests__/pos-gift-card.test.js` + siblings, `.planning/phases/79-.../79-04-PLAN.md`
**Files scanned:** ~10 directly read/greped in depth; call-graph grep swept `zoho-middleware/routes/`, `zoho-middleware/lib/`, `js/`
**Pattern extraction date:** 2026-09-02
