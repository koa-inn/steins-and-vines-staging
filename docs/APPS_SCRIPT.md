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

## Railway Env Vars Checklist

When setting up a new Railway deployment from scratch:

```
APPS_SCRIPT_URL=https://script.google.com/macros/s/<deployment-id>/exec
APPS_SCRIPT_SERVER_TOKEN=<32+ char secret matching Config sheet server_token>
```

Both vars are validated at startup by `zoho-middleware/lib/validateEnv.js`. A missing value will cause a startup warning and silently skip reservation notifications.
