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

## Railway Env Vars Checklist

When setting up a new Railway deployment from scratch:

```
APPS_SCRIPT_URL=https://script.google.com/macros/s/<deployment-id>/exec
APPS_SCRIPT_SERVER_TOKEN=<32+ char secret matching Config sheet server_token>
```

Both vars are validated at startup by `zoho-middleware/lib/validateEnv.js`. A missing value will cause a startup warning and silently skip reservation notifications.
