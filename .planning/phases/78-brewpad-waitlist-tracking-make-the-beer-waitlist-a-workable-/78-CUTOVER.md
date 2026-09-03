# Phase 78 Cutover Runsheet — BrewPad Waitlist Tracking

**Status:** DRAFT — awaiting owner action on Task 1 (Apps Script redeploy). Nothing below Task 1 has
been executed. Do not treat any section past "Task 1" as complete until the owner has actually
performed it and this file has been updated with the real recorded values.

**Written by:** executor agent, plan 78-04, 2026-09-02.
**Purpose:** a single ordered, repeatable runsheet for taking Phase 78 (plans 78-01/02/03) from
committed-but-unverified source to a live, staff-usable beer waitlist. Read this top to bottom in
order — steps are sequence-dependent, not a menu.

---

## 0. Why this order is load-bearing

Plans 78-01/02/03 are all committed to `main` but unverifiable in CI at the boundaries that
matter: no Jest suite in this repo can reach a live Google Sheets write, and `apps-script/adminApi.gs`
has no CI deploy path at all. One Apps Script Web App deployment serves **both** staging and
production simultaneously — there is no staging gate at that layer. If the middleware (which
auto-deploys to staging on `git push origin main`) reaches an environment expecting
`add_waitlist_entry`/`get_waitlist`/`update_waitlist_status` before the Apps Script side is
redeployed, every call gets a clean `{ok:false, error:'invalid_action', message:'Unknown action:
...'}` — a 200 with an error body, not an HTTP error — that looks like a bug but is actually just
an un-redeployed script (`78-RESEARCH.md` Pitfall 2).

**Therefore the hard sequence is: Apps Script redeploy (Task 1) → MailerLite backfill (Task 2) →
staging middleware/frontend deploy (Task 3) → production (explicitly NOT this plan).**

---

## 1. Setup — what already shipped (no action needed here)

These are already committed to `main` and require no further code changes for this cutover:

- **78-01** (`apps-script/adminApi.gs`): `WAITLIST_SHEET_NAME` constant, `ensureWaitlistSheet()`/
  `setupWaitlist()` bootstrap, `normalizeWaitlistEmail`/`waitlistCellSafe`/`waitlistSyncedTrue`/
  `waitlistDedupeDecision` pure helpers, `addWaitlistEntry`/`getWaitlist`/`updateWaitlistStatus`
  handlers, dispatch wiring in `doPost`'s `server_token` block and `handleReadAction`'s switch.
  Commits `e5af4c98`, `abdddc10`.
- **78-02** (`zoho-middleware/server.js`, `zoho-middleware/routes/pos.js`): `POST /api/waitlist`
  rewritten so the sheet write is authoritative (D-03), MailerLite demoted to fire-and-forget with
  a persisted `mailerlite_synced` sync flag (D-07); `get_waitlist`/`update_waitlist_status` added
  to `ADMIN_PROXY_ACTIONS`/`ADMIN_PROXY_READS` (both objects, per the two-whitelist gate).
  Commits `63f6d524`, `2105f61a`.
- **78-03** (`js/brewpad.js`, `brewpad.html`, `css/brewpad.css`): sixth BrewPad "Waitlist" tab —
  ordered queue table, one-way status cycle (`waiting → contacted → booked`, no wraparound back to
  `waiting`), danger-confirmed Remove, inline notes editor, MailerLite sync pill + Not-Synced
  filter, auto-suppressed Category column while every row is `beer`. Commits `8afb671a`,
  `ce79b221`, `f26aacdb`.

None of it is live. The committed source and the deployed Apps Script Web App are two different
things until Task 1 below happens by hand.

---

## 2. Redeploy — Task 1 (BLOCKING, owner action required)

**Owner performs this. The executor cannot run any part of it — there is no CLI or API path to
the Apps Script editor's Run/Deploy buttons.**

1. Open the STEINS AND VINES Apps Script project (script id
   `1uD14PTT2lMWV06FAKcEs6Z_YKsEvnUuk9fOFycu7emiOPyh9jC0KTvUH`, per the Phase 51-03 record — same
   project this phase's `Waitlist` functions were added to). Confirm the editor's `adminApi.gs`
   matches the committed file (`git log -1 --format=%H -- apps-script/adminApi.gs`). If it does
   not, paste the committed file in first.
2. In the function dropdown, select `setupWaitlist` and press **Run**. Authorize if prompted.
   Check the execution log:
   - Expect: `Waitlist tab ready (7 columns).`
   - If instead: `Waitlist tab is missing required columns: ...` — a `Waitlist` tab already exists
     with different headers. Fix the header row by hand to exactly `id, email, category, status,
     signed_up_at, mailerlite_synced, notes` and re-run. **Do not let the script repair headers —
     it is deliberately fail-closed.**
3. Open the spreadsheet and confirm: a `Waitlist` tab exists, row 1 holds those seven headers in
   that exact order, row 1 is bold, row 1 is frozen.
4. **Deploy → Manage deployments → the ACTIVE deployment → Edit (pencil) → Version: New version →
   Deploy.** Do **NOT** create a new deployment — the deployment ID and `/exec` URL must stay the
   same or every `APPS_SCRIPT_URL` in Railway breaks. **Write down the version number you just
   replaced — that is the rollback target.**
5. Live-probe the read action from a terminal with `APPS_SCRIPT_URL` and
   `APPS_SCRIPT_SERVER_TOKEN` to hand:
   ```
   curl -sL "$APPS_SCRIPT_URL?action=get_waitlist&server_token=$APPS_SCRIPT_SERVER_TOKEN"
   ```
   Expect `{"ok":true,"data":[]}` (or `data` holding whatever rows already exist). If you get
   `"error":"invalid_action"` with `Unknown action: get_waitlist`, the redeploy did not take —
   repeat step 4.

   **Curl pitfall (documented live in Phase 51-03, repeated here because it bites every time):**
   do **NOT** combine `-X POST` with `-L`. Apps Script's `/exec` issues a 302 that must be
   followed as a GET; forcing POST through it lands on a Google Drive HTML error page **after**
   the mutation has already executed, so a caller that treats the parse failure as "it didn't
   happen" and retries will double-write. The read probe above is a plain GET — safe.

### Rollback target (fill in after step 4)

| Field | Value |
|---|---|
| Prior version number (rollback target) | `<OWNER TO FILL IN — still outstanding>` |
| New version number (deployed) | `<OWNER TO FILL IN — still outstanding>` |
| Deployment ID (must be unchanged) | `<OWNER TO FILL IN — still outstanding>` |
| Date/time deployed | 2026-09-03, ~12:05 local (owner-confirmed; exact clock time not recorded) |

> **Open gap:** the redeploy is confirmed live by the §3 probe, but the prior version number was
> not captured at the time. Until the three fields above are filled in, the rollback procedure
> below has no target to select. Recover them from **Deploy → Manage deployments → the active
> deployment → Version dropdown** (the version history is retained) before relying on rollback.

### Rollback procedure

If anything downstream (Task 2's probe, Task 3's UAT) surfaces a defect traceable to the Waitlist
redeploy: **Deploy → Manage deployments → the active deployment → Edit → Version → select the
prior version number recorded above → Deploy.** This is a version switch, not a URL migration,
because the deployment ID never changed. The middleware's fail-closed 503-on-sheet-write-failure
behaviour (D-03) means signups **stop** rather than silently going unrecorded during the rollback
window — that is the intended failure mode, not a bug to route around.

---

## 3. Probe gate (Task 1's automated check)

```
curl -sL "$APPS_SCRIPT_URL?action=get_waitlist&server_token=$APPS_SCRIPT_SERVER_TOKEN" | grep -q '"ok":true'
```

Record the result here: **PASS** — 2026-09-03. Response: `{"ok":true,"data":[]}` (empty `data`, as
expected pre-backfill). Run via `railway run -e production -s sv_middleware -- sh -c 'curl -sL
"$APPS_SCRIPT_URL?action=get_waitlist&server_token=$APPS_SCRIPT_SERVER_TOKEN"'`, which injects both
secrets from Railway rather than putting them in shell history.

### Task 1 defect found and fixed during execution

The first `setupWaitlist()` run failed with `Exception: The number of columns in the range must be
at least 1.` at `ensureWaitlistSheet`. Cause: the spreadsheet already had a **blank** `Waitlist`
tab, so the `if (!sheet)` header-write branch was skipped and the function then called
`getRange(1, 1, 1, sheet.getLastColumn())` with `getLastColumn() === 0`. This would also have
thrown on every live waitlist write, since all three handlers call `ensureWaitlistSheet`.

Fixed in `6e07d652`: insert the sheet when absent, then write the header row whenever the sheet has
no content at all — an empty sheet has nothing to clobber, so it is not the drifted-header case,
which still fails closed with `waitlist_unavailable`. Regression coverage added in
`tests/frontend/adminapi-waitlist-ensure-sheet.test.js` (injects a fake `SpreadsheetApp`/`Logger`
so the bootstrap branches execute rather than being asserted by source shape). The fixed file was
pasted into the editor and redeployed; the successful run logged both
`Initialised Waitlist tab with 7 columns` and `Waitlist tab ready (7 columns).`

**Note for whoever maintains this:** `ensureGiftCardLedgerSheet` (Phase 51) has the identical
latent bug — same skip-if-exists structure, same zero-column read. Not fixed here (out of phase
scope); it needs its own ticket.

---

## 4. MailerLite backfill gate — Task 2 (BLOCKING, owner action required)

**Owner performs this. There is no read API in `zoho-middleware/lib/mailerlite.js` (only
`isConfigured()` and `addSubscriber()` exist) — this is a one-time manual CSV export and paste,
and it does not happen until Task 1 is confirmed live, since the paste is verified by re-running
the Task 1 probe.**

### STEP 1 — VERIFICATION GATE (do this before exporting anything)

Log into MailerLite, open the beer waitlist group's subscriber list (the group referenced by
`MAILERLITE_WAITLIST_GROUP_ID`), and click **Set columns** / **Toggle columns**.

- If a per-subscriber signup-date field **is** available: record its exact column label and a
  sample value below. Note whether it's a full timestamp or date-only, and whether a timezone is
  stated anywhere. Proceed to Step 2.
- If it is **not** available, or the only date shown is a list-level/import date rather than a
  per-subscriber signup time: **STOP. Do not export. Do not paste.** Report exactly what is and is
  not available and wait for an explicit decision on how pre-cutover signups should be ordered.
  CONTEXT.md D-04 is explicit: undated rows must not be silently imported in arbitrary order.

### MailerLite timestamp findings (fill in after Step 1)

| Field | Value |
|---|---|
| Signup-date column available? | **YES** — gate passes, backfill proceeds |
| Exact column label (if available) | `<OWNER TO FILL IN — pending>` |
| Sample value (copied verbatim) | `2026-08-27 19:16:30` |
| Full timestamp or date-only? | Full timestamp, second resolution (`YYYY-MM-DD HH:MM:SS`) — no coarsening needed |
| Timezone stated? Which one assumed if not? | **UTC** — owner-confirmed against the MailerLite account timezone setting, not assumed. Values map straight to ISO-8601 with a `T` and `.000Z`; no offset arithmetic. Note this is NOT the business timezone: the storefront renders in `America/Vancouver` (`js/brewpad.js:74`), so a backfilled row's displayed local time will read 7h (PDT) / 8h (PST) earlier than the stored stamp — expected, not drift. |

### STEP 2 — export (only if Step 1 found a usable date field)

Toggle the date column on, export the beer waitlist group to CSV.

### STEP 3 — paste

In the `Waitlist` tab, append one row per subscriber below the header, in ascending signup order
(oldest first):

| Column | How to fill it |
|---|---|
| `id` | Unique per row, never blank. UUIDs, or a stable prefix like `ml-0001`, `ml-0002`. `findRowById` matches on this column — a blank cell makes the row uneditable from BrewPad. |
| `email` | Lowercased. If it begins with `=`, `+`, `-`, or `@`, prefix with a single apostrophe so Sheets stores it as text, not a formula. |
| `category` | `beer` for every row. |
| `status` | `waiting` for every row. |
| `signed_up_at` | The real signup timestamp, ISO-8601 UTC (e.g. `2026-08-14T17:05:00.000Z`). If the export is date-only, use midnight UTC of that date and note the coarsening above. If the timezone is unstated, note the assumption above. |
| `mailerlite_synced` | `TRUE` for every row — these came FROM MailerLite. |
| `notes` | Blank. |

### STEP 4 — verify the paste

Re-run the Task 1 probe and confirm the row count matches the CSV subscriber count, and that
`signed_up_at` values come back as ISO strings:

```
curl -sL "$APPS_SCRIPT_URL?action=get_waitlist&server_token=$APPS_SCRIPT_SERVER_TOKEN" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('data',[])))"
```

### STEP 5 — delete the exported CSV

Delete it from the local machine once the paste is verified. It is a plain-text file of customer
email addresses. Do not attach it to a commit, an issue, or a chat message.

### Backfill result (fill in after Step 4)

| Field | Value |
|---|---|
| CSV subscriber count | `<OWNER TO FILL IN>` |
| Waitlist tab row count after paste | `<OWNER TO FILL IN>` |
| Counts match? | `<OWNER TO FILL IN — YES/NO>` |
| CSV deleted from local machine? | `<OWNER TO FILL IN — YES/NO>` |
| If zero rows imported (Step 1 said NO): blocker description | `<OWNER TO FILL IN, if applicable>` |

---

## 5. Staging deploy — Task 3, part A

Only after Task 1 (redeploy) is confirmed live and Task 2 (backfill, or explicit zero-import
decision) is recorded above:

1. Run the gates on the merged tree: `npm test`, `cd zoho-middleware && npm test`, `npm run lint`.
   All three must exit 0 before pushing.
2. `git push origin main`. Railway auto-deploys the staging middleware (root `railway.toml` watches
   `zoho-middleware/**`); the staging frontend deploys via the Actions workflow. Wait for both,
   then confirm the staging middleware health endpoint returns 200.

### Gate results (fill in)

| Gate | Result |
|---|---|
| `npm test` | `<OWNER/EXECUTOR TO FILL IN>` |
| `cd zoho-middleware && npm test` | `<OWNER/EXECUTOR TO FILL IN>` |
| `npm run lint` | `<OWNER/EXECUTOR TO FILL IN>` |
| `git push origin main` completed | `<OWNER TO FILL IN>` |
| Staging middleware health check | `<OWNER TO FILL IN>` |

**Caveat to hold in mind throughout the UAT below: staging and production share ONE Google Sheet.**
Every write made during UAT lands in the real `Waitlist` tab. Use a disposable address and clean
up afterward.

---

## 6. End-to-end BrewPad UAT — Task 3, part B (owner performs, on staging)

Use a disposable address such as `phase78-probe@example.com` throughout. Check each leg against
`78-UI-SPEC.md`, not against a general impression.

| # | Leg | Expected result | Owner result |
|---|---|---|---|
| 1 | **Signup.** Submit the staging beer page's waitlist form with the probe address. | Form shows its normal success confirmation, no error toast. | `<FILL IN>` |
| 2 | **Record (D-01/D-03).** Open the `Waitlist` tab. | A new row exists: `category`=`beer`, `status`=`waiting`, ISO `signed_up_at`, `mailerlite_synced` reflects whether MailerLite accepted it. | `<FILL IN>` |
| 3 | **Idempotency (D-06).** Submit the SAME address a second time. | Same success confirmation, no disclosure of prior signup; `Waitlist` tab still holds exactly ONE row for it, original `signed_up_at` unchanged. | `<FILL IN>` |
| 4 | **Fail-open on MailerLite (D-03), optional.** If safe: unset `MAILERLITE_API_KEY` on STAGING Railway only, submit a third distinct probe address. | Signup still succeeds (200, confirmation shown); row lands with `mailerlite_synced` FALSE. Restore the env var after. Skip and note if you'd rather not touch staging env vars — `waitlist-route.test.js` T2/T4 already cover the logic in CI. | `<FILL IN>` |
| 5 | **BrewPad read.** Open BrewPad on staging, tap the sixth Waitlist tab (📋). | Rows ordered oldest-signup-first, backfilled MailerLite rows ahead of probe rows; `#` numbers only `waiting` rows (1-based, `—` for non-waiting); each row has a sync pill (`✓ Synced` / `⚠ Not synced`); no `Category` column rendered (all `beer`); filter chips read `All · Waiting · Contacted · Booked · Removed · Not Synced`; search placeholder `Search email…`; `Not Synced` chip isolates exactly the warning-pill rows; partial-email search narrows without a network round-trip. | `<FILL IN>` |
| 6 | **Status (D-05).** Tap the probe row's status badge. | Confirm sheet reads `Mark phase78-probe@example.com as "Contacted"?` with **Confirm**; confirming shows `Status updated` toast, badge turns amber/Contacted, sheet's `status` cell reads `contacted`. Tap again → advances to Booked, confirm sheet again. | `<FILL IN>` |
| 7 | **One-way (D-05 correctness deviation).** With the row `booked`, tap the badge again. | NOTHING happens — no confirm sheet, no toast, no write. Sheet cell still reads `booked`. If it flips back to `waiting`, that is a blocker (the wraparound bug this plan exists to avoid). | `<FILL IN>` |
| 8 | **Remove (D-05).** Tap the row's `×`. | Danger confirm reads `Remove phase78-probe@example.com from the beer waitlist? This cannot be undone.` with **Remove**; confirming shows `Removed from waitlist` toast, sheet's `status` reads `removed`. ROW still exists — removal is a status change, not a deletion. | `<FILL IN>` |
| 9 | **Notes (D-08).** Tap a row's `✎`, type `probe note`, press **Save**. | `Notes saved` toast, sheet's `notes` cell reads `probe note`. Edit again, press `×` (cancel) — nothing written. | `<FILL IN>` |
| 10 | **Cleanup.** Delete the probe rows from the `Waitlist` tab; remove probe addresses from the MailerLite group if they reached it. | Shared production sheet has no leftover probe rows. | `<FILL IN>` |

### UAT outcome

`<OWNER TO FILL IN — "approved" with results above, or list of failed legs with what was observed>`

---

## 7. Production cutover — explicitly OPEN, NOT part of this plan

The Apps Script layer is already live everywhere after Task 1 (one deployment serves both
environments). The middleware and frontend reach production only via `git push production main
--force`, which is an **owner decision** to batch with the other pending production cutovers
already tracked in `.planning/STATE.md`:

- Phase 73 (recipe pricing unit bug) — staging-verified, prod deploy pending
- Phase 75 (BrewPad invoice→batch qty bug) — staging-verified, prod cutover pending
- Phase 76 (BrewPad session-expiry hardening) — code complete + verified, staging deploy + prod
  cutover pending

Phase 78's middleware/frontend changes should be batched into that same pending production push,
not pushed to production independently. **This runsheet does not authorize or perform that push.**

---

## 8. Summary of what remains open as of this write-up

- [ ] Task 1: owner runs `setupWaitlist()`, redeploys Apps Script, records rollback version, confirms probe.
- [ ] Task 2: owner confirms MailerLite timestamp column, backfills (or reports zero-import blocker).
- [ ] Task 3: gates green, `git push origin main`, eleven-leg staging UAT, probe rows cleaned up.
- [ ] Production cutover (out of scope here, batched with Phases 73/75/76).
