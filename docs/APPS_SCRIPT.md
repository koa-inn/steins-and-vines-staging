# Google Apps Script — Deployment & Operations Guide

## Overview

The Steins & Vines spreadsheet runs four Apps Script files. Three are deployed as standalone web apps; one handles a spreadsheet trigger.

| File | Purpose | Auth model |
|------|---------|------------|
| `apps-script/adminApi.gs` | Full CRUD for admin panel — batch tracking, reservations, kits, homepage | Execute as: **User accessing the web app** |
| `apps-script/trackEvent.gs` | Anonymous product-view/reserve event logging | Execute as: **Me** (script owner), Anyone |
| `apps-script/backup.gs` | Nightly spreadsheet backup to Drive | Time-based trigger (no web app) |
| `apps-script/onFormSubmit.gs` | Legacy form-submit hook (creates Reservations + Holds rows) | Spreadsheet on-form-submit trigger |

---

## What adminApi.gs Does

`adminApi.gs` is the primary backend for staff-facing features. It provides authenticated read/write access to the following Google Sheets tabs:

- **Batches** — batch records (`SV-B-NNNNNN`), status, vessel, dates
- **FermSchedules** — fermentation schedule templates (`FS-NNNN`)
- **BatchTasks** — per-batch task instances (`BT-NNNNNN`)
- **PlatoReadings** — gravity/Plato readings per batch
- **VesselHistory** — vessel assignment audit log
- **Reservations** — customer kit reservations
- **Holds** — per-product hold rows linked to reservations
- **Kits** — kit inventory (on_hold counts, availability)
- **Homepage** — featured product slugs for the homepage widget
- **Config** — staff email whitelist, server token

### Authentication

Every request to `adminApi.gs` is validated in two layers:

1. **Google OAuth** — the script is deployed with _Execute as: User accessing the web app_, so `Session.getActiveUser().getEmail()` returns the caller's actual email. Unauthenticated requests are rejected by Google before reaching the script.
2. **Staff whitelist** — every handler checks the caller's email against the `staff_emails` list in the Config sheet.

**Public endpoints** (no auth, no staff whitelist check):

- `?action=get_featured` — returns featured product SKUs for the homepage
- `?action=get_batch_public&batch_id=SV-B-xxxxxx&token=<hex>` — returns batch detail for QR-scannable public batch page

### Middleware server-to-server calls

The Railway middleware (`zoho-middleware/routes/checkout.js`) calls `APPS_SCRIPT_URL` directly via `axios.post` with a `server_token` field in the JSON body. This bypasses Google OAuth; the script validates the token against the `server_token` value stored in the Config sheet. This is used to write new reservations to the admin panel immediately after checkout.

---

## Where the URL Lives

### Frontend (admin/staff pages)

`ADMIN_API_URL` in `js/admin-config.js` — loaded only on `admin.html`, `brewpad.html`, `kiosk.html`, and `batch.html`. It is not included on any public-facing page.

```js
// js/admin-config.js
SHEETS_CONFIG.ADMIN_API_URL = 'https://script.google.com/macros/s/<deployment-id>/exec';
```

To update the URL after a new deployment, edit this line.

### Middleware (Railway)

Two env vars are set in Railway for the production service:

| Env var | Value |
|---------|-------|
| `APPS_SCRIPT_URL` | The same web app URL as `ADMIN_API_URL` above |
| `APPS_SCRIPT_SERVER_TOKEN` | A shared secret stored in the Config sheet under key `server_token` |

Both are read from `process.env` in `zoho-middleware/routes/checkout.js` — they are never hardcoded in source.

### trackEvent URL

`TRACK_EVENTS_URL` in `js/sheets-config.js` — points to `trackEvent.gs` deployment. This is a separate deployment with a separate URL.

---

## Finding the Current Web App URL

1. Open the Google Spreadsheet.
2. Go to **Extensions → Apps Script**.
3. Click **Deploy → Manage deployments**.
4. The active deployment row shows the current **Web app URL** (ends in `/exec`).

---

## Redeploying After a Code Change

> Only redeploy `adminApi.gs` if the script logic changes. The URL stays the same as long as you update the existing deployment (not create a new one).

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Make your code changes.
3. Click **Deploy → Manage deployments**.
4. Click the pencil (edit) icon on the active deployment.
5. Change **Version** to **New version**.
6. Click **Deploy**.

The Web app URL does not change when you update an existing deployment. No config updates are needed.

### When a new deployment is created (new URL)

A new deployment produces a new URL. In that case update both:

1. `js/admin-config.js` — update `SHEETS_CONFIG.ADMIN_API_URL`
2. Railway env — update `APPS_SCRIPT_URL` in the Railway dashboard for the `svmiddleware-production` service

Then redeploy the middleware (`git push production main` after staging approval) to pick up the new env value.

---

## Deployment Settings Reference

### adminApi.gs

| Setting | Value |
|---------|-------|
| Type | Web app |
| Execute as | User accessing the web app |
| Who has access | Anyone with Google Account |

### trackEvent.gs

| Setting | Value |
|---------|-------|
| Type | Web app |
| Execute as | Me (script owner) |
| Who has access | Anyone |

---

## Trigger Setup

### backup.gs — Nightly backup trigger

This trigger is set up once by running `setupBackupTrigger()` in the Apps Script editor.

- **Schedule:** Daily at 3 AM (script timezone)
- **Retention:** 14 days
- **Destination folder:** Google Drive folder `Steins-Vines-Backups` (ID `1c28ozHZTYHQ5N20zzyJuK40N8Ywiq188`)

To verify the trigger is active: run `getBackupStatus()` in the editor and check `triggerActive: true` in the logs.

To recreate it: run `setupBackupTrigger()`.

### onFormSubmit.gs — Legacy form trigger

Set up via **Triggers → Add Trigger** in the Apps Script editor:

- Function: `onFormSubmit`
- Event source: From spreadsheet
- Event type: On form submit

This is a legacy handler. New reservations come through the checkout middleware and `notifyAdminPanel()` instead.

---

## Adding a New Apps Script Function

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Open `adminApi.gs` (or the relevant file).
3. Add your function. If it should be callable via the web app, add a branch in `doGet` (for reads) or `doPost` (for writes). Follow the existing auth pattern — call `_requireStaff(e)` at the top of any staff-only handler.
4. Test it using the built-in **Run** button in the editor. Use `Logger.log()` and check **View → Logs**.
5. Redeploy using the steps in [Redeploying After a Code Change](#redeploying-after-a-code-change).
6. If the function adds a new action, add a corresponding helper in `js/admin.js` (`adminApiGet` / `adminApiPost`) following the existing pattern.
7. Add the local source file change to `apps-script/adminApi.gs` in the repo so the code stays in sync.

---

## Gift-Card Ledger (GiftCardTransactions)

### What it is and why

Every gift-card redemption or reload writes a row to the `GiftCardTransactions` tab **before** it
touches the balance, and marks that row settled once the balance change succeeds. If the script is
interrupted partway through — a timeout, a quota limit, a transient Google error — the row is left
behind in an unfinished state, and the ledger refuses the next redemption or reload on that
certificate instead of silently changing the balance a second time. Before this existed, a script
that died mid-write could be replayed by the customer's next attempt and debit (or credit) them
twice, because the old idempotency key was written LAST, after the money had already moved. This
closes audit findings H6 (double-debit on redeem) and H7 (duplicate credit on reload), requirement
**MONEY-03**.

### The columns

The tab has exactly these 12 columns, in this order, created by `setupGiftCardLedger()`:

| Column | Meaning |
|---|---|
| `tx_id` | Unique id for this ledger row (a UUID, not a sequence number) |
| `cert_number` | The gift certificate this row belongs to |
| `tx_ref` | The transaction reference the caller sent (the kiosk's payment key) |
| `kind` | `redeem` or `reload` |
| `amount` | The dollar amount of this redemption or reload |
| `balance_before` | The certificate's balance immediately before this change |
| `balance_after` | The certificate's balance immediately after this change (blank until settled) |
| `status` | `claimed` (write started, not yet confirmed), `settled` (write completed), or `resolved` (a staff member cleared a stuck claim by hand) |
| `needs_manual_review` | `true` once a blocked or failed attempt has flagged this row for a human to look at |
| `created_at` | Timestamp the claim row was written |
| `settled_at` | Timestamp the row was marked settled (blank until settled) |
| `notes` | Free-text explanation, filled in automatically when a row is flagged |

### First-time setup

From the Apps Script editor's function dropdown, select `setupGiftCardLedger` and click **Run**.
This is safe to re-run at any time — it does nothing if the tab already exists and its columns are
intact. It is a convenience, not a prerequisite: the tab also self-creates the first time any
redeem or reload actually needs it.

### "A customer says their gift card is refused" — the stuck-claim playbook

Symptom: the kiosk shows a gift-card failure and the middleware log carries `unsettled_claim`.
This means the ledger found a row for that certificate still sitting at `status: claimed` and
refused to move the balance again until a human looks at it. Here is how to clear it:

a. Open the Google Sheet, go to the `GiftCardTransactions` tab, and filter or search the
   `cert_number` column for the customer's certificate.
b. Find the row whose `status` is `claimed`. Its `tx_id` is included in the error the middleware
   logged, so you can match the exact row rather than guessing.
c. Compare that row's `balance_before` against the `current_balance` on the `GiftCards` tab for
   the same certificate:
   - **If they are EQUAL**, the balance never moved — the redemption or reload did not happen.
     The customer still has their money (or their card was never credited). It is safe to re-run
     the sale.
   - **If `current_balance` equals `balance_before` minus (for a redeem) or plus (for a reload)
     `amount`**, the balance DID move — the customer was already charged (or already credited).
     Do **NOT** re-run the sale, or you will charge/credit them a second time.
d. Once you know which case you're in, type `resolved` into that row's `status` cell. That is the
   entire remedy — one cell edit. The certificate works again on the very next attempt.
e. Don't be afraid of getting the exact word wrong: the guard only blocks on the exact value
   `claimed` (case and surrounding spaces are ignored when it checks). Typing anything else into
   `status`, or deleting the row entirely, clears the block. There is no redeploy and no code
   change involved in clearing a stuck claim.
f. One thing that is **not** safe: do not edit `current_balance` on the `GiftCards` tab to "fix" a
   discrepancy without first doing step (c). `current_balance` is the balance of record — trust it,
   don't overwrite it to make numbers match your assumption.

### What `needs_manual_review: TRUE` means

A redemption or reload against this certificate was refused or failed, and a human has not yet
looked at it. This is the first place in the system where that flag is durable — before this
phase it only ever existed as a field in the middleware's JSON response and a Redis sentinel, so
it vanished the moment the process restarted. Now it lives in the sheet cell until someone clears
it via the playbook above.

### Where the error strings surface

`unsettled_claim`, `ledger_unavailable`, `claim_write_failed` and `write_failed` all arrive at
`zoho-middleware/routes/pos.js:1706-1735` and `:1786-1813`, which log CRITICAL and set
`giftCardActivationFailed = true` — the same alert path staff already recognise from the Phase 44
gift-card flow.

---

## Waitlist (Phase 78)

### What it is and why

`beer.html` promises customers "Beer batches are booked ahead, and we work through the list in
order." Before this phase, the only record of who signed up was MailerLite — not queryable as an
ordered work list, so nobody could see who was waiting, how long, or who had already been
contacted. The `Waitlist` tab is now the system of record (D-01): `POST /api/waitlist`'s Apps
Script write is authoritative and blocking; MailerLite is demoted to a best-effort marketing sync
with its drift tracked in a durable cell (`mailerlite_synced`), not a log line (D-07, applying
Phase 51's criterion-2 lesson directly).

This mirrors the `GiftCardTransactions` ledger's bootstrap + pure-decision shape above, but
deliberately at the `addReservation` rigor level, not the gift-card level: **no
`LockService.getScriptLock()`, no claim-before-mutate ceremony.** A waitlist signup moves no
money. D-01 explicitly accepts that sheets are weak under concurrent writes as the cost of reusing
the existing staff-hand-editable pattern; a genuine double-submit (same email, same category,
within milliseconds) is handled by the D-06 idempotency check below, not by a lock — those are
different mitigations for different failure modes and only one is warranted here. Do not "fix"
this by adding a lock later without re-reading `78-RESEARCH.md` Pitfall 5 first.

### The columns

The `Waitlist` tab has exactly these 13 columns, in this order, created by `setupWaitlist()`.
Phase 80 (D-17) extended the original Phase 78 seven-column contract by **appending** six columns
after `notes` — never inserting between the original seven. `ensureWaitlistSheet` looks every
column up by name (`headers.indexOf(name)`), so physical column order never matters to it, but
`addWaitlistEntry`'s write is also header-driven (`ensured.col[name]`, RESEARCH.md Pitfall 1) —
neither handler assumes a fixed positional layout, so a sheet whose columns get reordered by hand
still works correctly as long as every required name is present:

| Column | Meaning |
|---|---|
| `id` | A generated `Utilities.getUuid()` string, never the customer's email. Keeps `findRowById`'s "column A is a unique key" assumption valid once D-02's multi-category future lands (the same email could legitimately appear twice, once per category). Unique and non-blank on every row — `findRowById` matches on this column, and a blank cell makes the row uneditable from BrewPad. |
| `email` | Lowercase-trimmed. Sanitized via `waitlistCellSafe()` on write. |
| `category` | `'beer'` for every row today (D-02 keeps the column ready for cider/wine/classes later without a schema migration). |
| `status` | One of `waiting`, `contacted`, `booked`, `removed` (D-05). Written through `waitlistCellSafe()` (Phase 80 IN-01 fold-in). |
| `signed_up_at` | ISO-8601 UTC (`new Date().toISOString()`). **This is the queue-order key** — the whole point of the backfill is making it real for pre-cutover signups too. |
| `mailerlite_synced` | `TRUE` / `FALSE`. Set by the middleware's best-effort MailerLite sync (D-07); read back via `waitlistSyncedTrue()`, which tolerates a real boolean, the strings `'true'/'yes'/'y'/'1'`, or the number `1`, since a D-04 backfill paste of `TRUE` and a code-written boolean `true` must read back identically. |
| `notes` | Free text (D-08). Sanitized via `waitlistCellSafe()` on write. |
| `zoho_contact_id` | The Zoho Books contact id backing this row, once linked (Phase 80 D-02/D-03). The only identifier anything downstream keys off. Sanitized via `waitlistCellSafe()` on write. Empty on a new signup; populated when staff link a customer. |
| `customer_name` | Denormalized display cache of the linked contact's name (Phase 80 D-03). May go stale if the Zoho contact is later renamed — this phase does not implement opportunistic refresh. Sanitized via `waitlistCellSafe()` on write. |
| `customer_phone` | Denormalized display cache of the linked contact's phone (Phase 80 D-03), same staleness caveat as `customer_name`. Sanitized via `waitlistCellSafe()` on write. |
| `recipe_ids` | Pipe-delimited list of attached `SV-R-` recipe ids (Phase 80 D-15/D-16), e.g. `SV-R-000003\|SV-R-000007`. Display-only — parsed/serialized via the pure `parseWaitlistRecipeIds`/`serializeWaitlistRecipeIds` helpers. Sanitized via `waitlistCellSafe()` on write. |
| `position` | Empty (unpinned) or a positive integer = this row's target 1-based rank in the merged queue (Phase 80 D-10/D-11/D-12). Stored ONLY on the pinned row — pinning writes exactly one cell on exactly one row. Server-validated in `updateWaitlistStatus`: `''`/`null`/`undefined` clears the pin; anything else must be an integer `>= 1` after `Number()` coercion, else `invalid_position` and nothing is written. The actual merge/ranking happens client-side at render time in `js/brewpad.js` — this layer only stores and validates. |
| `contacted_at` | ISO-8601 UTC of the last successful contact send (Phase 80 D-09). Same shape as `signed_up_at`; empty until the first contact email sends. Written through `waitlistCellSafe()` like every other free-text column — the value is client-reachable via the admin proxy, so it is **not** written verbatim (CR-02). |

### First-time setup

From the Apps Script editor's function dropdown, select `setupWaitlist` and click **Run**. Safe to
re-run at any time — it does nothing if the tab already exists and its columns are intact, and it
is fail-closed by design: if a `Waitlist` tab already exists with drifted headers, `setupWaitlist`
does **not** repair or reorder them. It logs which columns are missing and leaves the tab alone;
fix the header row by hand to exactly `id, email, category, status, signed_up_at,
mailerlite_synced, notes, zoho_contact_id, customer_name, customer_phone, recipe_ids, position,
contacted_at` and re-run. **D-18 migration order is load-bearing:** add the six new columns to the
live sheet BEFORE redeploying Phase 80's `adminApi.gs` — deploying the new code first takes every
public signup down with a 503 (`waitlist_unavailable`) until the columns exist. The reverse order
is safe.

### The four actions

| Action | Transport | Auth | On admin proxy? |
|---|---|---|---|
| `add_waitlist_entry` | `doPost` | `server_token` | **Yes, write-only** (Phase 80 D-21 — reverses the Phase 78 rule below). In `ADMIN_PROXY_ACTIONS` (`zoho-middleware/routes/pos.js`), deliberately still absent from `ADMIN_PROXY_READS` — BrewPad's staff manual-add feature needs to create rows, but nothing needs to poll this action as a read. The staff caller discloses a D-06 dedupe hit to the staff member ("already on the list, signed up X") so a manual add can't silently no-op; the public `POST /api/waitlist` path calls this exact same function and must never see that disclosure — the handler's `{ok, id}` return shape is byte-identical on both branches, so the asymmetry lives entirely in the caller, not here (D-23). |
| `get_waitlist` | `doGet` / `handleReadAction` | `server_token` | Yes — read, forwarded as GET. Returns either an array of rows or `ensureWaitlistSheet()`'s failure object directly (`{ok:false, error:'waitlist_unavailable', missing:[...]}`) so a caller can't mistake a broken tab for an empty one. Deliberately **no `_cachedGet` wrapper** — `get_gift_cards` sets the precedent of skipping the cache layer entirely for a low-volume staff list, sidestepping the Phase 69 stale-cache bug class outright. |
| `update_waitlist_status` | `doPost` | `server_token` | Yes — write, forwarded as POST. Accepts `{id, status?, notes?, mailerlite_synced?, zoho_contact_id?, customer_name?, customer_phone?, recipe_ids?, position?, contacted_at?}`; at least one of the nine optional fields is required. Validates `status` against the fixed set and `position` as an integer `>= 1` (or empty) **before** any `setValue` call — a rejected write writes nothing. Two staff-tier middleware endpoints call this action (plan 80-02): `POST /api/waitlist/:id/contact` (sets `status:'contacted'` + `contacted_at` together after a successful send) and `POST /api/waitlist/:id/mailerlite-sync` (sets `mailerlite_synced`). |

**`add_waitlist_entry` request/response:**
```
Request:  { action: 'add_waitlist_entry', server_token, email, category? }
Response: { ok: true, id: '<uuid>' }               // identical shape whether new or a D-06 dedupe hit
          { ok: false, error: 'invalid_email' }
          { ok: false, error: 'waitlist_unavailable', missing: [...] }
```
The dedupe-hit and new-row branches return the byte-identical `{ok, id}` key set — this is D-06's
non-disclosure requirement. No field name may ever differ between the two paths, or a repeat
signup could be inferred by a customer from response shape alone. See "The four actions" above for
how the staff-tier caller (D-23) still discloses a dedupe hit without this function's return shape
changing.

**`get_waitlist` request/response:**
```
Request:  { action: 'get_waitlist', server_token }
Response: { ok: true, data: [ { id, email, category, status, signed_up_at, mailerlite_synced,
            notes, zoho_contact_id, customer_name, customer_phone, recipe_ids, position,
            contacted_at }, ... ] }
          { ok: false, error: 'waitlist_unavailable', missing: [...] }
```

**`update_waitlist_status` request/response:**
```
Request:  { action: 'update_waitlist_status', server_token, id,
            status?, notes?, mailerlite_synced?,
            zoho_contact_id?, customer_name?, customer_phone?, recipe_ids?, position?, contacted_at? }
Response: { ok: true, id, status }
          { ok: false, error: 'not_found' | 'invalid_status' | 'invalid_position' | 'invalid_transition' | 'no_fields' | 'waitlist_unavailable' }
```

**One-way status transitions are enforced server-side by this handler.** (Corrected as of Phase 80;
this section previously — and incorrectly, since commit `a706d7b8`'s CR-01 fix — described a
client-only guard.) `updateWaitlistStatus` checks `waitlistTransitionAllowed(current, next)`
(`adminApi.gs:5179`) against the row's CURRENT status on the sheet, before any `setValue` call — a
rejected transition writes nothing and returns `{ok:false, error:'invalid_transition'}`. A direct
caller (a script, a curl probe, a stale BrewPad tab) can no longer move a `booked` row back to
`waiting`. `js/brewpad.js`'s `nextWaitlistStatus()` mirrors this rule client-side for UX (the
button no-ops with no request sent), but the server no longer trusts that alone.

### Why neither write handler takes a script lock

`addWaitlistEntry` and `updateWaitlistStatus` both skip `acquireScriptLock()`. This is deliberate,
not an oversight: `voidGiftCard`/`redeemGiftCard`/`reloadGiftCard` above take a lock because a
gift card's balance is money-adjacent and a lost update there means a customer's money silently
vanishes or duplicates. A waitlist row is not money-adjacent — the worst case of an unlocked
concurrent write is two near-simultaneous signups landing in a slightly different row order, which
does not corrupt any balance and does not violate D-06's per-address idempotency guarantee (that
guarantee is enforced by the dedupe scan, not by serializing writes). `addReservation`
(`adminApi.gs:910-949`), the closest existing precedent for "public form → sheet append", has no
lock either. Do not add one here without first re-reading `78-RESEARCH.md` Pitfall 5 — copying the
gift-card ledger's locking ceremony onto every new sheet-backed list is exactly the
over-engineering that research flagged and rejected for this phase.

### Deploy topology reminder

Same caveat as everywhere else in this file: **one Apps Script Web App deployment serves both
staging and production.** Redeploying `adminApi.gs` to add or change a waitlist action is a
production release with no staging gate at this layer, even though `zoho-middleware` itself has a
separate staging Railway instance. See `.planning/phases/78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-/78-CUTOVER.md`
for the full ordered runsheet (redeploy → probe → MailerLite backfill gate → staging → UAT).

---

## Railway Env Vars Checklist

When setting up a new Railway deployment from scratch:

```
APPS_SCRIPT_URL=https://script.google.com/macros/s/<deployment-id>/exec
APPS_SCRIPT_SERVER_TOKEN=<32+ char secret matching Config sheet server_token>
```

Both vars are validated at startup by `zoho-middleware/lib/validateEnv.js`. A missing value will cause a startup warning and silently skip reservation notifications.
