# Phase 80: BrewPad waitlist — work the queue - Context

**Gathered:** 2026-09-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the Phase 78 beer waitlist from a queue staff *read* into one they *work*, without leaving
BrewPad. Five capabilities on the existing Waitlist tab:

1. **Link a row to its Zoho customer** — search existing contacts, or create one inline.
2. **Attach the recipes** that person intends to brew.
3. **Contact them** — a templated email carrying a Cal.com booking link.
4. **Override queue order** by hand when reality demands it.
5. **Add someone to the waitlist manually** — walk-ins and word-of-mouth interest.

**Explicitly NOT in this phase:** batch creation or pre-fill from a waitlist row; ingredient-stock
advisories; inbound-reply handling; booking on the customer's behalf; generalising the waitlist UI
to cider/wine/classes. See `<deferred>`.

</domain>

<decisions>
## Implementation Decisions

### Customer linking
- **D-01:** Staff can **link an existing Zoho contact OR create one inline** from the waitlist row.
  Both halves already exist in BrewPad and should be reused, not rebuilt — see `<code_context>`.
- **D-02:** The sheet stores **`zoho_contact_id` + `customer_name` + `customer_phone`**. Name and
  phone are denormalized display caches so the queue renders "Jane Smith — jane@example.com —
  604-555-0123" with **no per-row Zoho lookup on load**. Phone is surfaced because staff need to be
  able to call someone straight from the queue.
  *(Owner decision, revising an earlier draft of this decision that excluded phone as the most
  sensitive field. Accepted consequence: a customer name and phone now live in a Google Sheet that
  staging and production share. The email was already there; this widens it. Noted once, not a
  blocker.)*
- **D-03:** The cached `customer_name`/`customer_phone` may go stale if the contact is edited in
  Zoho. Accepted: they are display conveniences, never identifiers. `zoho_contact_id` is the only
  thing anything keys off.
- **D-03a:** Phone is populated **either** from the linked Zoho contact at link time **or** typed
  directly during a manual add (D-21). Linking a contact must **not** silently overwrite a
  non-empty manually-entered phone.

### Contact action
- **D-04:** The contact email sends via **Resend (`zoho-middleware/lib/mailer.js`)**, NOT MailerLite.
  `lib/mailerlite.js` states its own boundary — "Used for list-building … NOT transactional email" —
  and only exposes `isConfigured`/`addSubscriber`. **The substantive reason:** MailerLite is
  marketing email and honours unsubscribes, so a customer who unsubscribed would silently never
  receive "your spot is ready" — the one message that must arrive. This extends Phase 78's D-03
  (MailerLite is marketing sync, never the critical path).
- **D-05:** The email is **templated and reviewable before sending** — staff see the resolved
  subject/body, can edit, then send. Not a blind fire.
- **D-06:** The email carries a **Cal.com booking link** so the customer self-books.
  `zoho-middleware/lib/calcom.js` is used ONLY to resolve the correct event-type link
  (`listEventType`). **`getSlots` and `createBooking` are explicitly out of scope** — no embedded
  live availability (it goes stale between send and click) and no booking on their behalf.
- **D-07:** On a **confirmed successful send**, the row's status auto-advances to `contacted`.
  Forward-only and safe by construction: Phase 78's `waitlistTransitionAllowed` already permits
  `waiting → contacted`, treats `contacted → contacted` as an allowed no-op, and refuses anything
  backward — so a `booked` row is untouched by a follow-up send.
- **D-08:** **If the send fails, the status does not change.** Fail-closed, mirroring Phase 78's
  D-03 stance that the durable record must never claim something that did not happen.
- **D-09:** The row records **when it was last contacted** (`contacted_at`), so staff can see how
  long someone has been waiting on a reply.

### Queue override
- **D-10:** A **`position` column that is normally empty**. Rows with no position sort by
  `signed_up_at` exactly as today; setting a position **pins** that row, and unpinned rows continue
  to flow chronologically around it. Nothing changes until staff deliberately intervene.
- **D-11:** **New signups always append unpinned**, at the natural chronological end. They never
  need a position assigned, so the public signup path is completely unaffected by this feature.
- **D-12:** **Clearing a position restores true signup order** for that row. The override is always
  reversible, and `signed_up_at` remains the underlying truth — D-04 of Phase 78 (backfilled rows
  in real signup order) is preserved intact.
- **D-13:** A pinned row is **visibly marked in BrewPad** with a control to clear the pin, so staff
  can always tell the queue is not purely chronological and why a row is where it is.
- **D-14:** **`beer.html` copy is NOT changed.** "We work through the list in order" remains
  substantially true — the queue is chronological unless someone intervenes for a reason. Revisit
  only if manual pinning turns out to be routine rather than exceptional.

### Recipe attachment
- **D-15:** A row can carry **multiple recipes**, attachable/changeable **at any time** regardless
  of status — a customer may want two batches, or be undecided between options, and may say so at
  signup or on the phone.
- **D-16:** Recipes are **display-only in this phase**. Nothing downstream reads them: no ingredient
  stock check, no batch pre-fill, no pricing. They exist so staff know what to prep for.

### Manual add (staff-initiated signup)
- **D-21:** Staff can **add someone to the waitlist directly from BrewPad**, for walk-ins and
  word-of-mouth interest. Form fields: **email (required)**, plus optional phone, name, and recipes.
- **D-22:** **Email remains required and remains the dedupe key**, exactly as the public form. A
  phone-only row is explicitly NOT supported — it would break dedupe (two phone-only rows can't be
  matched) and would leave the contact action (D-04) with nothing to send to. Placeholder/fake
  addresses are also rejected: they would pollute MailerLite and hurt deliverability.
- **D-23:** **A manual add is NOT subject to Phase 78's D-06 non-disclosure rule.**
  *(Note: "D-06" is overloaded — Phase 78's D-06 is non-disclosure; THIS phase's D-06 is the Cal.com
  booking link. Every reference below is qualified.)* Phase 78 D-06 protects *customers* on the
  public form. Staff adding someone SHOULD be told plainly if that person is already on the list,
  and when they signed up, so they don't think the add silently failed. This is a deliberate
  asymmetry between the public path and the staff path — the same underlying
  `waitlistDedupeDecision`, opposite disclosure. **Phase 78 D-06 remains fully intact on the public
  `POST /api/waitlist` path**; nothing here weakens it.
- **D-24:** A manual add **syncs to MailerLite fire-and-forget exactly like a public signup**
  (Phase 78 D-03/D-07), setting `mailerlite_synced` the same way. One consistent rule, and the
  "Not Synced" filter keeps meaning exactly one thing (sync drift) rather than conflating drift with
  deliberate non-sync.
- **D-25:** `signed_up_at` for a manual add is **the moment staff add them**. Staff who want to
  reflect earlier interest can pin the row (D-10) rather than backdating the timestamp — backdating
  would corrupt the one field D-04 of Phase 78 exists to keep true.

### Schema and migration (carried from Phase 78, non-negotiable)
- **D-17:** The `Waitlist` tab gains these columns: **`zoho_contact_id`, `customer_name`,
  `customer_phone`, `recipe_ids`, `position`, `contacted_at`**.
- **D-18:** **MIGRATION ORDER IS LOAD-BEARING: add the columns to the sheet FIRST, then redeploy
  the Apps Script.** `ensureWaitlistSheet` fails closed on any missing required column — it returns
  `waitlist_unavailable` and deliberately never repairs headers. Deploying new code before the
  columns exist takes **every public signup down with a 503** until they land. The reverse order is
  safe: existing code maps by header name and ignores unknown columns.
- **D-19:** All new user-controlled cell writes go through **`waitlistCellSafe`** (the `=+-@`
  formula-injection guard). This is the code-review IN-01 lesson from Phase 78 applied up front
  rather than retrofitted.
- **D-20:** One phase, one migration, one redeploy. `apps-script/adminApi.gs` has **no CI deploy
  path**, and a single Web App deployment serves **staging AND production simultaneously** — so the
  owner redeploy is effectively a production release for that layer. This is the explicit reason
  all four features are bundled rather than split across phases.

### Claude's Discretion
- **`recipe_ids` storage format.** A Sheets cell must hold a list. Planner/executor to choose and
  document a delimiter (pipe recommended — recipe ids look like `SV-R-000003` and contain no pipes),
  with a pure, unit-tested parse/serialize helper following Phase 78's `waitlistDedupeDecision`
  pattern. Must round-trip an empty list, a single id, and preserve order.
- **`position` numeric scheme.** Sparse integers vs fractional insertion vs renumber-on-write. Any
  is acceptable provided pinning a row never rewrites unrelated rows' `signed_up_at`.
- **Whether `customer_name` opportunistically refreshes** when a row is next written for another
  reason. Nice-to-have, not required by any decision above.
- Exact template wording for the contact email — draft it, then surface for owner approval during
  the cutover plan rather than guessing silently.

### Reviewed Todos (not folded)
`gsd-sdk query todo.match-phase 80` returned 14 matches, all scoring 0.60 on generic tokens
("brewpad", "status", "source", "beer"). None concern working the waitlist queue; all reviewed and
rejected. One is a **canonical reference rather than scope** — see `<canonical_refs>`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 78 foundation (this phase extends it directly)
- `.planning/phases/78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-/78-CONTEXT.md` —
  locked decisions D-01..D-08. **D-06 non-disclosure binds everything added here.**
- `.planning/phases/78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-/78-CUTOVER.md` —
  the owner runsheet. §2 and §7b document the redeploy procedure; §4 STEP 3 documents the Sheets
  date-serial paste trap. Read before writing this phase's cutover plan.
- `.planning/phases/78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-/78-REVIEW.md` —
  code review. **WR-02 (no optimistic locking on `updateWaitlistStatus`) and IN-01 (status not
  routed through `waitlistCellSafe`) are still OPEN** and this phase touches that handler.
- `.planning/phases/78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-/78-UI-SPEC.md` —
  the BrewPad Waitlist tab design contract this phase extends.

### Apps Script operations
- `docs/APPS_SCRIPT.md` — deploy/redeploy procedure and the Waitlist section. **Redeploying updates
  the EXISTING deployment as a new version; never create a new deployment (the `/exec` URL must not
  change).**

### Do-not-break references
- `.planning/todos/pending/remove-dead-beer-waitlist-handler.md` — titled **"SUPERSEDED — do NOT
  delete `setupBeerWaitlistForm`"**. Read before touching any waitlist JS; the handler that looks
  dead is not.

### Tracking (open items inherited, not this phase's scope)
- `.planning/phases/78-.../78-HUMAN-UAT.md` — the Apps Script rollback version numbers are still
  unrecorded. **This phase adds another redeploy — record the versions this time.**

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`fetchReassignSearch` (`js/brewpad.js:2088`)** — a working type-ahead customer picker hitting
  `/api/contacts/search`, rendering `contact_id`/`contact_name`/`email`/`phone` with click-to-select
  via `.bp-so-result-item`. **D-01's search half is a re-use, not a build.**
- **The inline new-customer form (`js/brewpad.js:7754`)** — already POSTs
  `{name, first_name, last_name, email, phone}` to `/api/contacts` and receives `contact_id`.
  **D-01's create half is also a re-use.**
- **`POST /api/contacts` (`zoho-middleware/routes/bookings.js:381`)** — "Find an existing Zoho Books
  contact by email, or create a new one." Already handles BrewPad's pre-split name fields.
- **`zoho-middleware/lib/mailer.js`** — Resend with SMTP fallback. `sendCustomerConfirmation` is the
  existing customer-facing precedent; `sendViaResend` is the primitive for D-04. Note
  `sendWaitlistNotification` sends to **staff**, not the customer — it is the inbound alert, not a
  template to reuse.
- **`zoho-middleware/lib/calcom.js`** — Cal.com v2 API: `listEventType`, `getSlots`, `createBooking`,
  `verifyWebhook`. **Only `listEventType` is in scope** (D-06).
- **BrewPad's Recipes tab (`bp-panel-recipes`)** — recipe data is already loaded client-side, so the
  D-15 picker should reuse that cache rather than adding a fetch.
- **Phase 78 pure-helper + fake-`SpreadsheetApp` test pattern** —
  `tests/frontend/adminapi-waitlist-transition.test.js` and `-ensure-sheet.test.js` show how to make
  Apps Script logic genuinely testable instead of source-shape-asserted. Follow it for D-15 parsing
  and D-10 ordering.

### Established Patterns
- **Vanilla ES5 throughout** (`js/brewpad.js`) — no `const`/`let`/arrow functions; iPad Safari is the
  target. Lint runs `--max-warnings 0`.
- **Fail-closed on schema drift** — `ensureWaitlistSheet` refuses to repair headers. This is what
  makes D-18's ordering load-bearing.
- **Two-list admin-proxy allow-list** — `ADMIN_PROXY_ACTIONS` **and** `ADMIN_PROXY_READS` in
  `zoho-middleware/server.js` must BOTH be updated; reads and writes are separated deliberately.
  Any new waitlist action needs the correct list.
- **Confirm sheets, never native dialogs** — `showConfirmSheet` (`js/brewpad.js:4432`). There is no
  `confirm()`/`alert()` anywhere in BrewPad and none may be introduced.
- **`js/brewpad.js` and `css/brewpad.css` are sources**; `js/brewpad.min.js` / `css/brewpad.min.css`
  are build artifacts — never edit them; run `npm run build`.

### Integration Points
- `apps-script/adminApi.gs` — `ensureWaitlistSheet` (column list), `addWaitlistEntry`,
  `getWaitlist`, `updateWaitlistStatus`. New fields flow through the existing handlers; a new action
  may be needed for the contact send.
- **Manual add (D-21) reaches `add_waitlist_entry` through the ADMIN PROXY**, not the public
  `POST /api/waitlist`. Note `add_waitlist_entry` is currently absent from BOTH admin-proxy
  allow-lists (Phase 78 deliberately kept it off), so this phase must add it to `ADMIN_PROXY_ACTIONS`
  — and the staff path needs the D-23 disclosure that the public path must never have. Expect the
  handler to need a caller-aware return, or a separate staff-only action.
- `js/brewpad.js` — `sortWaitlistRows` (`:985`) compares raw ISO strings with an original-index
  tiebreak. **D-10's `position` must slot in AHEAD of the timestamp compare**, preserving the
  existing "unparseable sorts last" guarantee.
- `zoho-middleware/server.js` — admin-proxy allow-lists, and wherever the contact-send endpoint lands.

</code_context>

<specifics>
## Specific Ideas

- The owner asked directly whether MailerLite could send the contact email and whether it could link
  to Cal.com. The answers shaped D-04 and D-06: MailerLite is the wrong pipe (unsubscribe gating),
  Cal.com is already integrated and is the right destination.
- The intended message is essentially **"your spot is ready — book a time"**, which is why the
  booking link is the payload rather than free-text prose.
- Manual add and phone surfacing were added by the owner after the four original areas were
  settled — "if someone has shown interest via word of mouth", and "I would also like to have their
  phone number surfaced if we have it for that customer". Folded in rather than deferred because
  both need columns, and this phase already owns the one migration and redeploy (D-20).
- Preference throughout for **the smallest thing that is actually correct**: no live slot embedding,
  no booking-on-behalf, no downstream recipe effects — each was offered and each was declined in
  favour of the bounded option.

</specifics>

<deferred>
## Deferred Ideas

- **Booking on the customer's behalf from BrewPad** (`createBooking`). Offered and declined for this
  phase. Natural follow-up once self-service booking is in use.
- **Live availability embedded in the contact email** (`getSlots`). Declined — slots go stale between
  send and click, so the link must remain the source of truth. Revisit if customers report the link
  showing nothing available.
- **Ingredient-stock advisory from attached recipes.** Phase 73 already built unit-aware
  `checkScaledStock`, so the primitive exists. Deferred to keep D-16 display-only.
- **Batch pre-fill when a row is booked.** Reaches into batch creation and overlaps the
  customer/batch linking Phase 78 already deferred to its own phase.
- **Inbound reply handling in BrewPad.** Much larger — needs mailbox integration. Own phase.
- **Generalising the waitlist UI to cider / wine / classes.** Schema already supports it via
  `category` (Phase 78 D-02); the UI and copy are not in scope. Carried forward from Phase 78.
- **Automated MailerLite re-sync / reconciliation.** Carried forward from Phase 78, unchanged.
- **Recording WHO moved a row and WHY.** Offered as a queue-override option and declined; the
  existing `notes` field can carry the "why" informally. Revisit if the queue is ever disputed.
- **Softening `beer.html`'s "we work through the list in order" copy.** Offered and declined (D-14).
  Revisit if manual pinning becomes routine.

### Reviewed Todos (not folded)
All 14 `todo.match-phase 80` results were keyword noise (0.60, on "brewpad"/"status"/"source"/"beer")
and none concern working the waitlist queue: the beer/cider launch-pages todo, three BrewPad
batch-view todos, several kiosk/money-path todos, a GTM/analytics todo, a CI deploy todo, and the two
todos this session filed (`giftcard-ledger-empty-tab-crash`, `brewpad-writes-retry-once`). The only
waitlist-adjacent hit, `remove-dead-beer-waitlist-handler.md`, is a **canonical reference** (do NOT
delete that handler), not scope to fold.

</deferred>

---

*Phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c*
*Context gathered: 2026-09-04*
