# Phase 80 Cutover Runsheet — BrewPad Waitlist: Work the Queue

**Status:** Task 1 (this document) and Task 2 (owner approval of five open items) are complete — all
five verdicts are recorded below. Task 2 also surfaced a new blocking prerequisite (§1a: a new
Cal.com event type the `eventtype` verdict requires, which does not exist yet) that gates the
contact-email flow only — §2 and §3 are unaffected. Task 3 (migration → redeploy → probes → staging →
UAT) is still open and requires the owner's hands — there is no CLI or API path to the Google Sheet
header row, the Apps Script editor's Run/Deploy buttons, or a live Cal.com event type. Do not treat
any section below as complete until the owner has performed it and recorded real values here.

**Written by:** executor agent, plan 80-06, 2026-09-04.
**Purpose:** a single ordered, repeatable runsheet for taking Phase 80 (plans 80-01..80-05) from
committed-but-unverified source to a live, staff-usable waitlist-working queue. Read this top to
bottom in order — steps are sequence-dependent, not a menu. Modelled section-for-section on
`.planning/phases/78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-/78-CUTOVER.md`,
which this phase extends.

---

## 0. Why this order is load-bearing

Two ordering rules govern this cutover. Both exist because `apps-script/adminApi.gs` has no CI
deploy path and a single Web App deployment serves **staging AND production simultaneously** — so
this redeploy is effectively a production release for that layer, with no staging gate at all.

**D-18: add the six columns to the sheet FIRST, then redeploy.** `ensureWaitlistSheet` fails closed
on any missing required column — it returns `waitlist_unavailable` and **never repairs headers**.
Redeploying the new code before the columns exist takes every public beer signup on `beer.html`
down with a **503** the instant the deploy goes live, and it stays down until the columns land by
hand. The reverse order is safe: the CURRENTLY-deployed code (`ensureWaitlistSheet`'s Phase-78
7-column check) maps columns by header name and simply ignores any column it doesn't recognize — so
adding six unknown columns to a live sheet does not disturb the code that's running today.

**RESEARCH.md Pitfall 1: append the columns as H, I, J, K, L, M — strictly to the RIGHT of `notes`
(column G) — never inserted between existing columns.** The **currently-deployed**
`addWaitlistEntry` writes every new row via a **literal 7-element positional `appendRow`**
(`[id, email, category, status, signed_up_at, mailerlite_synced, notes]`) — it does not look up
columns by name at all. If the new columns are inserted anywhere to the LEFT of `notes` (e.g.
between `category` and `status`), `ensureWaitlistSheet`'s header-presence check still passes (it
only checks names exist, not their physical order), but every public signup made between the sheet
edit and the redeploy silently writes `status`'s value into whatever column is now physically in
slot 4 — corrupting the row with no error, no 503, nothing that looks broken until someone reads the
sheet. Plan 80-01 replaces this fragile positional write with a header-driven one permanently, but
that fix is not live until §3's redeploy — during the migration window (§2), the OLD, still-fragile
code is what's running, so column placement must be exactly right the first time.

---

## 1. What already shipped (no further code changes needed here)

None of this is live — the committed source and the deployed Apps Script Web App are two different
things until §2/§3 below happen by hand.

- **80-01** (`apps-script/adminApi.gs`, `docs/APPS_SCRIPT.md`): 13-column `ensureWaitlistSheet`,
  header-driven `addWaitlistEntry` (closes RESEARCH Pitfall 1 permanently once deployed),
  `getWaitlist` field allowlist widened to 13 fields, `updateWaitlistStatus` extended to nine
  optional fields with server-side `position` validation and IN-01's `waitlistCellSafe` fold-in for
  `status`. WR-02 (optimistic locking) documented as an accepted carry-forward, not implemented.
  Commits `3bb14feb`, `dc1a6a0b`, `e4effab7`.
- **80-02** (`zoho-middleware/lib/mailer.js`, `zoho-middleware/routes/pos.js`): `sendWaitlistContact`
  (Resend, staff-composed subject/body/bookingUrl passed straight through, no template building in
  `mailer.js`); `POST /api/waitlist/:id/contact` (server-orchestrated send-then-write, staff-tier
  only, distinguishes `contact_failed` from `contact_write_failed`); `POST
  /api/waitlist/:id/mailerlite-sync`; `add_waitlist_entry` added to `ADMIN_PROXY_ACTIONS` (write-only,
  never `ADMIN_PROXY_READS`). Commits `72bdf796`, `2e1f6316`, `63686f94`, `632fd141`, `2f1663fe`.
- **80-03/80-04** (`js/brewpad.js`, `css/brewpad.css`): queue/pin mechanics, customer-link panel,
  recipe-attach panel — see `.planning/phases/80-.../80-03-SUMMARY.md` and `80-04-SUMMARY.md` for
  full detail (not re-summarized here; this runsheet's job is the cutover, not a feature recap).
- **80-05** (`js/brewpad.js`, `css/brewpad.css`): Contact column + review sheet with client-resolved
  Cal.com link and D-08 fail-closed send; `+ Add to Waitlist` manual-add sheet with client-side email
  validation, get_waitlist-before-add snapshot, and the D-23 duplicate-signup disclosure. Commits
  `e4a8da0d`, `0114ec54`, `eda9e7b7`, `44ae2816`.

Gates on the fully merged tree at the time this runsheet was written: frontend **1633/1633** (108
suites), middleware **1562/1562** (106 suites), both linters clean, no secrets under `js/`.

---

## 1a. BLOCKING PREREQUISITE — new Cal.com event type for the beer waitlist

**Added at Task 2 (`eventtype` verdict, recorded above). Not covered by any plan in this phase.**

The owner overturned the `eventtype` default. The contact-email flow must NOT resolve its booking
link to `CALCOM_EVENT_TYPE_FERMENT_KIT` or `CALCOM_EVENT_TYPE_BOTTLING` — it needs a **new,
beer/waitlist-specific Cal.com event type** that does not exist yet as of this writing. Because it
doesn't exist, its numeric event-type ID is unknowable right now, so nothing below invents one. This
section stages the work as an ordered prerequisite; it does not perform or implement any of it.

**Established facts this section relies on (verified in code, not re-derived here):**
- `GET /api/bookings/services` (`zoho-middleware/routes/bookings.js:141-144`) reads exactly two env
  vars — `CALCOM_EVENT_TYPE_FERMENT_KIT` and `CALCOM_EVENT_TYPE_BOTTLING` — into an `ids` array,
  filtering out any that are unset. A third event type cannot surface through that endpoint without a
  middleware code change.
- `js/brewpad.js`'s Contact sheet (`openWaitlistContactSheet`, ~line 8949) currently selects
  `result.data.services[0]` — the first entry in that array — which today resolves to
  `CALCOM_EVENT_TYPE_FERMENT_KIT`. It has no concept of "the beer/waitlist service" yet; it just takes
  whatever is first.

### CRITICAL SEQUENCING — read this before touching §2 or §3

- **§2 (Sheet migration) and §3 (Apps Script redeploy) are entirely about the 13-column schema and
  are Cal.com-independent. They are NOT blocked by this prerequisite and may proceed on their own
  schedule**, in the order already specified (§2 before §3).
- **The contact-email flow — and any UAT leg that exercises it — IS blocked** until steps (a)-(e)
  below have landed. §6 leg 7 ("Contact a `waiting` row, end to end") is marked
  `BLOCKED ON §1a PREREQUISITE` below rather than deleted; do not run it until this section's to-fill
  table is complete and the code changes in (c)/(d) have shipped.

### Steps, in order

**(a) Owner creates the new event type in Cal.com.** Cal.com Dashboard → Event Types → + New event
type. Name it for the beer waitlist specifically (e.g. "Beer Waitlist — Fermentation Booking") so
it's distinguishable from the existing Ferment Kit and Bottling event types in the dashboard list.
Record its numeric event-type ID (visible in the event type's settings URL, e.g.
`https://app.cal.com/event-types/<ID>`, or via the Cal.com API) in the to-fill table below.

**(b) Owner adds a Railway env var.** On the `sv_middleware` service, both `staging` and `production`
environments: add `CALCOM_EVENT_TYPE_BEER_WAITLIST` (proposed name — confirm or rename in the table
below) set to the numeric ID from (a).

**(c) Code change — NOT done in this plan.** Extend the `ids` array in
`zoho-middleware/routes/bookings.js` (~line 141) to add `process.env.CALCOM_EVENT_TYPE_BEER_WAITLIST`
as a third element, filtered the same way as the existing two.

**(d) Code change — NOT done in this plan.** `js/brewpad.js`'s Contact sheet must stop taking
`result.data.services[0]` positionally and instead select the beer-waitlist service explicitly (e.g.
by matching on `slug` or `id` against the value recorded in the to-fill table), so it cannot
accidentally keep resolving to the ferment-kit event once a third service is present in the array.

**(e) Deploy.** Once (c) is committed: middleware redeploys to Railway automatically on
`git push origin main` (per §5 below); frontend requires `npm run build` plus the same push, following
the existing staging deploy flow. This does NOT require a new Apps Script redeploy — it is a
middleware/frontend-only change.

**Do NOT implement (c) or (d) speculatively.** The event-type ID does not exist yet, so the change
cannot be tested, and this is scope beyond plan 80-06. Once (a) and (b) are done, raise (c)/(d)/(e) as
their own small plan.

### To-fill table (same style as §3's rollback table)

| Field | Value |
|---|---|
| New Cal.com event type name/title | `<OWNER TO FILL IN>` |
| New Cal.com event type numeric ID | `<OWNER TO FILL IN>` |
| Railway env var name | `CALCOM_EVENT_TYPE_BEER_WAITLIST` (proposed — confirm or rename here: `<OWNER TO FILL IN>`) |
| Railway env var value set on staging | `<OWNER TO FILL IN>` |
| Railway env var value set on production | `<OWNER TO FILL IN>` |
| Resulting Cal.com booking URL | `<OWNER TO FILL IN>` |
| Commit implementing (c) `bookings.js` ids array | `<OWNER/EXECUTOR TO FILL IN — separate plan>` |
| Commit implementing (d) `brewpad.js` explicit selection | `<OWNER/EXECUTOR TO FILL IN — separate plan>` |
| Date/time (c)+(d) redeployed | `<OWNER/EXECUTOR TO FILL IN>` |

---

## 2. Sheet migration (BLOCKING, owner) — MUST happen before §3

**Owner performs this. The executor cannot run any part of it — there is no CLI or API path to the
Google Sheet's header row.**

1. Open the Steins & Vines spreadsheet, go to the `Waitlist` tab.
2. Type these six header values into cells **H1 through M1**, in this exact order, **strictly to the
   right of `notes` (G1)**. Do not touch A1..G1 — do not reorder, retype, or "clean up" anything
   already there.

   | Cell | Value |
   |---|---|
   | H1 | `zoho_contact_id` |
   | I1 | `customer_name` |
   | J1 | `customer_phone` |
   | K1 | `recipe_ids` |
   | L1 | `position` |
   | M1 | `contacted_at` |

3. **Type these values directly — do not paste from a rich source** (a rich-text paste can carry
   hidden formatting/whitespace that a plain-text header comparison in `ensureWaitlistSheet` may not
   match). If a value must be pasted, paste as plain text (Ctrl/Cmd+Shift+V) and verify no leading/
   trailing whitespace.
4. **Leave every data cell in columns H through M empty** for all existing rows (the six historical
   backfilled rows from Phase 78 plus any live rows since). The currently-deployed code never writes
   to these columns, so there is nothing to populate yet — they gain six blank cells each, which is
   correct and expected.
5. **Sheets date-serial paste trap (by reference, in case anything is ever pasted into these columns
   later):** if a date-shaped value (e.g. an ISO timestamp) is ever pasted into `contacted_at`,
   Sheets may silently parse it into a date serial instead of storing it as text — the exact trap
   documented in `78-CUTOVER.md` §4 STEP 3. The guard is the same: format the column as Plain Text
   before pasting, or prefix the value with a single apostrophe. This does not apply to today's
   migration (no cell values are being written, only headers), but flag it for whoever next
   hand-edits this column.

### Verification gate — run BEFORE proceeding to §3

This is the gate that makes §3 safe: it proves the OLD, still-live code tolerates the new columns
without breaking the public signup path.

```bash
curl -sL "$APPS_SCRIPT_URL?action=get_waitlist&server_token=$APPS_SCRIPT_SERVER_TOKEN" | grep -q '"ok":true'
```

Recommended, matching `78-CUTOVER.md`'s pattern of not putting secrets in shell history:
```bash
railway run -e production -s sv_middleware -- sh -c \
  'curl -sL "$APPS_SCRIPT_URL?action=get_waitlist&server_token=$APPS_SCRIPT_SERVER_TOKEN"'
```

Expect `{"ok":true,"data":[...]}` with the existing rows present, each still only carrying the
original 7 fields (the old code's `getWaitlist` doesn't know about the six new columns yet — that's
correct at this point in the sequence). **If this fails, STOP — do not proceed to §3.** A failure
here means the header row is malformed in a way that trips `ensureWaitlistSheet`'s drift check even
though it only checks for the ORIGINAL 7 names' presence — recheck A1..G1 were not accidentally
altered in step 2.

| Field | Value |
|---|---|
| Probe run at (date/time) | `<OWNER TO FILL IN>` |
| Probe result | `<OWNER TO FILL IN — PASS/FAIL>` |
| Response body (first ~200 chars) | `<OWNER TO FILL IN>` |

---

## 3. Apps Script redeploy (BLOCKING, owner) — only after §2's probe passes

**Owner performs this. The executor cannot run any part of it — there is no CLI or API path to the
Apps Script editor's Run/Deploy buttons.**

1. Open the STEINS AND VINES Apps Script project (script id
   `1uD14PTT2lMWV06FAKcEs6Z_YKsEvnUuk9fOFycu7emiOPyh9jC0KTvUH` — same project id `78-CUTOVER.md` §2
   used).
2. Confirm the editor's `adminApi.gs` matches the committed file:
   ```bash
   git log -1 --format=%H -- apps-script/adminApi.gs
   ```
   If the editor's content doesn't match (diff by eye, or copy the editor content out and `diff`
   locally), paste the committed file into the editor before proceeding.
3. In the function dropdown, select `setupWaitlist` and press **Run**. Authorize if prompted. Check
   the execution log:
   - Expect: `Waitlist tab ready (13 columns).`
   - If instead you see a "missing required columns" message: STOP. Do NOT let the script repair
     headers — it is deliberately fail-closed. Go back to §2 and fix the header row by hand to match
     exactly, then re-run.
4. **Deploy → Manage deployments → the ACTIVE deployment → Edit (pencil) → Version: New version →
   Deploy.**

   **Do NOT create a new deployment.** A new deployment produces a new `/exec` URL, which breaks
   every `APPS_SCRIPT_URL` reference in Railway (staging AND production) simultaneously — this must
   remain a version bump on the existing deployment, exactly as `78-CUTOVER.md` §2 and §7b both did.

5. **Fill in this rollback table BEFORE doing anything else** — this is the single most important
   value on this entire runsheet. Phase 78's equivalent table was left empty across BOTH of its
   redeploys (§2 and §7b of `78-CUTOVER.md`), and that gap is still open, unresolved, in
   `78-HUMAN-UAT.md` as of this writing. Do not repeat it here.

   | Field | Value |
   |---|---|
   | Prior version number (the rollback target) | `<OWNER TO FILL IN>` |
   | New version number (just deployed) | `<OWNER TO FILL IN>` |
   | Deployment ID (must be UNCHANGED from before this redeploy) | `<OWNER TO FILL IN>` |
   | Date/time deployed | `<OWNER TO FILL IN>` |

### Rollback procedure

If §4's probes or §6's UAT surface a defect traceable to this redeploy: **Deploy → Manage
deployments → the active deployment → Edit → Version → select the prior version number recorded
above → Deploy.** This is a version switch on the SAME deployment, not a URL migration — the
deployment ID never changes, so no Railway env var needs touching. During the rollback window,
`ensureWaitlistSheet`'s fail-closed behavior means public signups **stop** (503) rather than being
silently recorded incorrectly — that is the intended failure mode here, exactly as it is for every
other Apps Script rollback in this codebase; do not attempt to route around it.

---

## 4. Probe gate — run immediately after §3's redeploy, before §5

All probes are **plain GETs**. **Never combine `-X POST` with `-L`** — Apps Script's `/exec` issues a
302 that must be followed as a GET; forcing POST through it lands on a Google Drive HTML error page
**after** the mutation has already executed, so a caller that treats the parse failure as "it didn't
happen" and retries will double-write. This is the exact trap `78-CUTOVER.md` §2 step 5 documents,
repeated here because — per that same document's own words — "it bites every time."

**a. Read probe — thirteen-field shape**
```bash
curl -sL "$APPS_SCRIPT_URL?action=get_waitlist&server_token=$APPS_SCRIPT_SERVER_TOKEN"
```
Expect `"ok":true` and each row object now carrying `zoho_contact_id`, `customer_name`,
`customer_phone`, `recipe_ids`, `position`, `contacted_at` keys (even if their values are all empty
for the pre-existing rows).

**b. Position validation probe** (use a disposable row id — see §6 cleanup)
```bash
# Valid write:
curl -sL -d 'action=update_waitlist_status&server_token=REDACTED&id=<disposable row id>&position=2' "$APPS_SCRIPT_URL"
# Expect: {"ok":true,"id":"...","status":"..."}

# Invalid write — must be refused, zero cells touched:
curl -sL -d 'action=update_waitlist_status&server_token=REDACTED&id=<disposable row id>&position=0' "$APPS_SCRIPT_URL"
# Expect: {"ok":false,"error":"invalid_position"}
```

**c. One-way transition guard probe, against a `booked` row** (proves CR-01's Phase-78 guard
survived the 80-01 rewrite of `updateWaitlistStatus`)
```bash
curl -sL -d 'action=update_waitlist_status&server_token=REDACTED&id=<a booked row id>&status=waiting' "$APPS_SCRIPT_URL"
# Expect: {"ok":false,"error":"invalid_transition"}
```

**d. Public signup probe — the direct check for Pitfall 1** (submit through the STAGING middleware,
not a raw Apps Script call, so the real customer path is exercised end to end)
```bash
curl -sX POST -H 'Content-Type: application/json' \
  -d '{"email":"phase80-probe@example.com"}' \
  https://svmiddleware-staging.up.railway.app/api/waitlist
```
Then re-read via §4a and find the new row. Expect `status` reads exactly `waiting` and `signed_up_at`
is an ISO-8601 string. **Anything else in those cells IS the Pitfall 1 corruption bug** — a numeric/
boolean `status`, or a blank/serial-number `signed_up_at`, means the six columns landed in the wrong
physical position relative to the OLD code's positional write that ran during the migration window
(§2), or the new code's write is bugged. Roll back immediately per §3's rollback procedure if seen.

### Probe results (fill in after running all four)

| Probe | Result | Response body (key excerpt) |
|---|---|---|
| a. Read — 13-field shape | `<OWNER TO FILL IN>` | `<OWNER TO FILL IN>` |
| b. Position — valid (2) | `<OWNER TO FILL IN>` | `<OWNER TO FILL IN>` |
| b. Position — invalid (0) | `<OWNER TO FILL IN>` | `<OWNER TO FILL IN — expect invalid_position>` |
| c. Transition — booked→waiting | `<OWNER TO FILL IN>` | `<OWNER TO FILL IN — expect invalid_transition>` |
| d. Public signup — status/signed_up_at | `<OWNER TO FILL IN>` | `<OWNER TO FILL IN>` |

---

## 5. Staging deploy — only after §4's four probes all pass

1. Run the gates on the tree that will be pushed:
   ```bash
   npm test
   cd zoho-middleware && npm test && cd ..
   npm run lint
   cd zoho-middleware && npm run lint && cd ..
   npm run build   # confirm clean — no uncommitted .min drift after
   git status --short   # should show nothing outside intentional build artifacts, if any
   ```
2. `git push origin main`. Root `railway.toml` watches `zoho-middleware/**` and auto-deploys the
   staging middleware; the staging frontend deploys via the Actions workflow.
3. Confirm the staging middleware health endpoint returns 200:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://svmiddleware-staging.up.railway.app/health
   ```

**Caveats repeated from `78-CUTOVER.md` (still true, unchanged):**
- `staging.steinsandvines.ca` sits behind Cloudflare, which 403s non-browser user agents — curl
  checks of the staging FRONTEND are not meaningful. Verify it in a real browser (the §6 UAT does
  this anyway).
- **Staging and production share ONE Google Sheet.** Every write made during §6's UAT lands in the
  real `Waitlist` tab. Use a disposable address throughout and clean up afterward (§6's cleanup leg).

### Gate results (fill in)

| Gate | Result |
|---|---|
| `npm test` | PASS — 1643/1643, 108 suites (2026-09-04) |
| `cd zoho-middleware && npm test` | PASS — 1580/1580, 107 suites (2026-09-04) |
| `npm run lint` (root) | PASS — clean, `--max-warnings 0` |
| `cd zoho-middleware && npm run lint` | PASS — clean, `--max-warnings 0` |
| `npm run build` clean | PASS — no `.min` drift; unrelated page restamps reverted |
| `git push origin main` completed | DONE 2026-09-04 — `7f25a731..c9910fcc`, 62 commits, all Phase 80 |
| staging middleware `/health` | PASS — HTTP 200 |
| staging frontend curl check | N/A — Cloudflare 403s non-browser agents (documented caveat); browser check pending |

> **⚠ ORDERING DEVIATION — recorded 2026-09-04.** This section is written as "only after §4's four
> probes all pass". The staging push was performed BEFORE §2 (sheet migration) and §3 (Apps Script
> redeploy), at the owner's explicit request. Consequence: staging now runs the Phase 80 BrewPad
> frontend and middleware against the OLD Apps Script deployment and the un-migrated 7-column
> `Waitlist` sheet. §6's UAT legs cannot pass in this state and must not be attempted until §2 and
> §3 are complete. Nothing about production is affected by this push — but note that §2/§3, when
> they run, still hit the single shared Web App deployment.
| Staging middleware health check | `<OWNER TO FILL IN>` |

---

## 6. UAT leg table — owner performs on staging, checked against `80-UI-SPEC.md`

Use a disposable address such as `phase80-probe@example.com` throughout. Check each leg against
`80-UI-SPEC.md`'s exact copy/behavior, not general impression. Verify every write **server-side
through the deployed `get_waitlist`**, not by UI appearance alone.

| # | Leg | Expected result | Owner result |
|---|---|---|---|
| 1 | **Customer link — existing contact.** On a waitlist row, tap "Link customer", search for an existing Zoho contact, select it. | Row's Customer cell renders `{Name} — {email} — {phone}`; `get_waitlist` shows `zoho_contact_id`/`customer_name`/`customer_phone` populated on that row. | `<OWNER TO FILL IN>` |
| 2 | **Customer link — inline create.** On a different row, tap "Link customer" → "+ Add new customer", fill name/email/phone, save. | New Zoho contact created; row links to it the same as leg 1; `get_waitlist` confirms. | `<OWNER TO FILL IN>` |
| 3 | **D-03a guard.** On a row that already has a hand-typed `customer_phone` (from a manual add, leg 9), link an existing Zoho contact whose phone differs. | The row's `customer_phone` is **unchanged** — linking a contact must not silently overwrite a non-empty manually-entered phone. | `<OWNER TO FILL IN>` |
| 4 | **Recipe attach.** Attach two recipes to a row, then remove one. | Two chips appear, then one; `get_waitlist`'s `recipe_ids` reflects exactly the remaining one, pipe-delimited if more than one remained. | `<OWNER TO FILL IN>` |
| 5 | **Pin to position.** Pin a row to position 2. | Queue visually reorders so that row renders at rank 2; `get_waitlist`'s `position` cell for that row reads `2`; other rows' `signed_up_at` cells are unchanged. | `<OWNER TO FILL IN>` |
| 6 | **Clear pin.** Clear the position set in leg 5. | Row returns to its natural chronological (signup-order) position; `get_waitlist`'s `position` cell for that row is empty. | `<OWNER TO FILL IN>` |
| 7 | **BLOCKED ON §1a PREREQUISITE.** Contact a `waiting` row, end to end. Tap Contact, review the pre-filled subject/body (booking link resolved), send. | The probe address receives the email; `get_waitlist` shows the row's `status` advanced to `contacted` and `contacted_at` holds an ISO timestamp. | `BLOCKED — do not run until §1a steps (a)-(e) land; running this today would exercise the wrong (ferment-kit) event type, not the owner-approved beer-waitlist one` |
| 8 | **D-08 fail-closed send — THE SINGLE MOST IMPORTANT LEG.** Temporarily unset `RESEND_API_KEY` on STAGING Railway only (or address a Resend-rejected address), attempt a Contact send. | Sheet stays open, shows the inline `--batch-danger` error ("Could not send. Please try again."), Send re-enables. **The row's `status` is UNCHANGED** in `get_waitlist` — no partial write. Restore `RESEND_API_KEY` after. | `<OWNER TO FILL IN — must explicitly confirm status UNCHANGED>` |
| 9 | **Contact button disabled on a `booked` row.** Find or advance a row to `booked`, observe the Contact button. | Button renders disabled (`.btn:disabled`, opacity 0.6, `pointer-events:none`); no request is possible. | `<OWNER TO FILL IN>` |
| 10 | **Manual add — brand-new address.** Use `+ Add to Waitlist`, submit a never-before-seen disposable address. | Sheet closes, toast "Added to waitlist"; `get_waitlist` shows a new row, `status:waiting`, `signed_up_at` = now (not backdated). | `<OWNER TO FILL IN>` |
| 11 | **Manual add — already-on-list disclosure (D-23).** Use `+ Add to Waitlist` again with the SAME address from leg 10 (or any existing row's email). | Sheet does NOT close silently — it swaps to the disclosure message naming the signup date and current status, single "Got It" dismissal; no duplicate row created; no optional-field write; no MailerLite sync attempted. | `<OWNER TO FILL IN>` |
| 12 | **Public signup unchanged (D-14, Phase 78 D-06).** Submit `beer.html`'s waitlist form with a fresh disposable address. | Normal success confirmation, no error; response/copy identical to pre-Phase-80 behavior; no disclosure of any prior state. | `<OWNER TO FILL IN>` |
| 13 | **Cleanup.** Delete every probe row created during §4/§6 from the `Waitlist` tab by hand; remove every probe address from the MailerLite beer waitlist group. | Shared production sheet has no leftover probe rows or MailerLite subscribers. | `<OWNER TO FILL IN>` |

### UAT outcome

`<OWNER TO FILL IN — N of 13 legs PASS, summary of any failures, date UAT was driven, browser used>`

---

## 7. Production cutover — explicitly OUT of scope for this plan

The Apps Script layer (§3's redeploy) is already live everywhere the instant it happens — one
deployment serves both staging and production, with no staging-only gate at that layer. The
middleware and frontend halves reach production only via `git push production main --force`, which
is an **owner decision** to batch with the other pending production cutovers already tracked in
`.planning/STATE.md` as of this writing:

- Phase 51 (gift-card ledger integrity) — narrowed-scope complete, live-verified 2026-09-02
- Phase 74 — unshipped per STATE.md's PROJECT.md footer correction
- Phase 78 (BrewPad waitlist tracking) — staging-verified, prod cutover pending
- Phase 79 (recipe write performance) — Apps Script changes rode along in Phase 78's/51's redeploys
  and are already live in production; middleware/frontend halves still need their own staging UAT

Phase 80's middleware/frontend changes should be batched into that same pending production push, not
pushed to production independently. **This runsheet does not authorize or perform that push.**

---

## 8. Open items checklist

- [x] Task 2 — owner decision on the five open items (template wording, Cal.com event type, Contact-
      disabled-on-booked/removed, pin-available-on-every-row, WR-02 carry-forward vs fold-in). See
      the `## Owner decisions` section below — all five verdicts recorded.
- [ ] §1a — NEW blocking prerequisite from the `eventtype` overturn: create the beer-waitlist Cal.com
      event type, add its Railway env var, extend `bookings.js`'s `ids` array, point `brewpad.js`'s
      Contact sheet at it explicitly, redeploy. Blocks the contact-email flow and §6 leg 7 only — does
      NOT block §2 or §3.
- [ ] §2 — sheet migration (six columns H..M) + read probe against the STILL-OLD deployment
- [ ] §3 — Apps Script redeploy + four-row rollback table filled with real values
- [ ] §4 — all four probes recorded with real response bodies
- [ ] §5 — staging deploy gates green + push + health check
- [ ] §6 — all 13 UAT legs recorded, especially leg 8 (D-08 fail-closed) and leg 13 (cleanup)
- [ ] Recover Phase 78's still-missing rollback version numbers (`78-HUMAN-UAT.md`) — the owner is
      already in the Apps Script deployment history for §3 above; this is the natural moment to also
      open the Version dropdown's history and backfill the Phase 78 table while there. Not required
      to unblock Phase 80, but flagged here so the trip isn't wasted. See §3's rollback table for
      where Phase 80's own numbers land — that record will not have Phase 78's gap.
- [ ] Production cutover (out of scope here, batched with Phases 51/74/78/79 per §7)

---

## Owner decisions

**Status: RECORDED — all five verdicts below were returned by the owner and are recorded verbatim.**
Four of five approve the shipped default with no code change required. The fifth (`eventtype`) is
OVERTURNED and introduces a new blocking prerequisite — see **§1a** below, inserted before §2 because
it gates the contact-email flow. §2 (sheet migration) and §3 (Apps Script redeploy) are NOT blocked by
it; they proceed independently on the 13-column schema.

### 1. `template` — Contact email subject and body

**Default (already pre-filled in `js/brewpad.js`'s Contact sheet):**

> Subject: `Your spot on the Steins & Vines beer waitlist is ready!`
>
> Body:
> ```
> Hi {first name or 'there'},
>
> Great news — it's your turn on the beer waitlist! You can book your fermentation time here:
>
> {booking_url}
>
> If you have any questions, just reply to this email.
>
> Cheers,
> Steins & Vines
> ```

Mirrors `sendBottlingInvite`'s tone; staff can still edit per send (D-05) regardless of this default.

**Verdict:** APPROVED AS DRAFTED. No code change, no test rerun, no rebuild needed.

**If reworded:** update the pre-fill strings in `js/brewpad.js`'s contact sheet (plan 80-05 Task 1),
rerun `npx jest --config jest.config.js tests/frontend/brewpad-waitlist-contact.test.js`, run
`npm run build`, and record the new test result here: N/A — template approved as-is, this branch does
not apply.

### 2. `eventtype` — Which Cal.com event type the booking link resolves to

**Default:** `CALCOM_EVENT_TYPE_FERMENT_KIT` — beer batches book into the existing ferment-in-store
flow; no beer- or waitlist-specific event type exists in the codebase today.

**Verdict:** OVERTURNED. The owner wants a NEW beer/waitlist-specific Cal.com event type — not
`CALCOM_EVENT_TYPE_FERMENT_KIT` and not `CALCOM_EVENT_TYPE_BOTTLING`. This event type does not exist
yet. See the new **§1a — BLOCKING PREREQUISITE** section below (inserted before §2 at Task 2) for the
staged, ordered steps to create it, wire it in, and the to-fill table for its real values. §2 and §3
below are NOT blocked by this — only the contact-email flow and its UAT leg are.

**If changed:** update which service's `bookingUrl` the contact sheet selects from
`GET /api/bookings/services` and note the change here: staged in §1a, not implemented in this plan —
the event-type ID does not exist yet and the change cannot be tested speculatively.

### 3. `contactdisabled` — Contact button disabled on booked/removed rows (UI-SPEC Decision 3)

**Default:** disabled, reusing the existing `actionable` predicate (`status !== 'booked' && status
!== 'removed'`). Sending to an already-booked customer would leave the post-send status write
refused by `waitlistTransitionAllowed` (`booked → contacted` is a backward transition) — an email
sent with no record of it.

**Verdict:** APPROVED AS DEFAULT. Contact stays disabled on `booked`/`removed` rows.

**If overturned:** this needs a **paired backend decision** (skip the post-send status write rather
than attempt and fail it, when the row is already past `contacted`) — do NOT work around this in the
frontend alone. Record the resulting design here: N/A — default approved, this branch does not apply.

### 4. `pinallrows` — Pin control on every row vs waiting-only (UI-SPEC Decision 5)

**Default:** every row, so a VIP mid-conversation stays visible near the top of the visual list even
after being contacted.

**Verdict:** APPROVED AS DEFAULT. Pin control stays available on every row.

**If restricted:** one-line render guard on `status === 'waiting'` in the pin-icon render condition.
Record the change here: N/A — default approved, this branch does not apply.

### 5. `wr02` — WR-02 optimistic locking: carried forward, not fixed

**Default:** carry-forward with a code comment (already present in `apps-script/adminApi.gs` above
`updateWaitlistStatus`, citing `78-REVIEW.md`). Closing it needs a 14th `last_updated` column, which
D-17 does not list and D-20's one-migration framing forbids adding silently without amendment.

**Verdict:** APPROVED AS CARRY-FORWARD. Keep the existing code comment citing `78-REVIEW.md`. Do NOT
add a 14th column. Do NOT halt for replanning on this item.

**If the owner wants WR-02 closed:** this is an **architectural change requiring a second redeploy**
and CANNOT be retrofitted after §3's redeploy runs. It requires, in order: (a) explicit amendment of
D-17 to add a 14th column; (b) adding `last_updated` as column N to §2's migration BEFORE §3's
redeploy; (c) extending plan 80-01's `updateWaitlistStatus` with `expectedVersion` handling mirroring
`updateReservation`. If chosen, STOP this runsheet, do not proceed past this Owner decisions section,
and route back through plan authoring for the added scope. Record the decision and next step here:
N/A — carry-forward approved, this branch does not apply.

---

*Phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c*
*Runsheet drafted: 2026-09-04, plan 80-06 Task 1*
