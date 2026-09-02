# Phase 78: BrewPad waitlist tracking — make the beer waitlist a workable internal list, not just a MailerLite group - Context

**Gathered:** 2026-09-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Give staff a durable, ordered, workable beer waitlist inside BrewPad.

The customer-facing signup already works and is NOT in scope to rebuild: `beer.html:285`
(`#beer-waitlist-form`) → `setupBeerWaitlistForm()` (`js/modules/12-checkout.js:1689`) →
`POST /api/waitlist` (`zoho-middleware/server.js:211`) → MailerLite + a fire-and-forget staff
notification email. That path is live and load-bearing.

What does not exist is any record staff can read. MailerLite is currently the entire record, and it
is not queryable as an ordered work list — so nobody can see who is waiting, how long they have
waited, or who has already been contacted. Meanwhile `beer.html` promises customers
"Beer batches are booked ahead, and we work through the list in order". This phase builds the
system of record and the BrewPad surface that make that promise true.

**In scope:** a `Waitlist` sheet tab as the system of record; `adminApi.gs` read/write handlers;
middleware wiring so `POST /api/waitlist` records to the sheet; a BrewPad surface listing entries
in order with status transitions; a one-time backfill of existing MailerLite subscribers.

**Out of scope:** rebuilding the public signup form; linking entries to Zoho customers or BrewPad
batches (D-08); generalising the UI beyond beer (D-02 keeps the schema ready, not the UI).

</domain>

<decisions>
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

ROADMAP.md carries no `Canonical refs:` line for Phase 78; the list below was accumulated during
discussion and codebase scouting.

### The live signup path (do not rebuild — extend)
- `zoho-middleware/server.js` §`POST /api/waitlist` (~:211-233) — the endpoint being changed:
  email validation, MailerLite gate, rate limiter, fire-and-forget staff notification.
- `js/modules/12-checkout.js:1689` — `setupBeerWaitlistForm()`, the live client handler.
- `js/modules/13-init.js:440` — the LIVE call site (`page === 'beer'`). Note `:380`
  (`page === 'home'`) is a genuinely dead call, see the deferred section.
- `beer.html:281-289` — the live form, confirmation element, and the "in order" promise copy this
  phase must make true.
- `zoho-middleware/lib/mailerlite.js` — only `isConfigured()` and `addSubscriber()` exist; there is
  no read/list path (drives D-04).

### The pattern to follow (sheet-backed staff list)
- `apps-script/adminApi.gs:46-60` — sheet-name constants; add the `Waitlist` constant alongside.
- `apps-script/adminApi.gs` §`ensureGiftCardLedgerSheet` / `setupGiftCardLedger` — the Phase 51
  idempotent tab-bootstrap pattern, verified live 2026-09-02. Reuse its shape.
- `js/brewpad.js:1556,1575` — how BrewPad calls `/api/batch/admin-proxy`, including the read-retry
  wrapper.
- `.planning/phases/51-gift-card-ledger-integrity/51-03-SUMMARY.md` — deploy + live-probe record;
  documents the manual-redeploy reality (D-09) and the "persisted cell beats a log line" finding
  that D-07 is built on.

### Constraints
- `CLAUDE.md` — build artifacts, CSP-on-every-public-page rule, test/lint gates, `cd zoho-middleware`.
- `docs/APPS_SCRIPT.md` — redeploy procedure and the gift-card ledger runbook precedent for
  writing staff-facing operational docs.
- `.planning/todos/pending/remove-dead-beer-waitlist-handler.md` — **read before touching any
  waitlist JS.** Supersedes an earlier instruction to delete `setupBeerWaitlistForm()`, which
  would break the live form.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Sheet bootstrap pattern:** `ensureGiftCardLedgerSheet()` / `setupGiftCardLedger()` in
  `adminApi.gs` — idempotent create-with-headers, live-verified in Phase 51. The `Waitlist` tab
  should copy this shape rather than inventing a new one.
- **Admin proxy:** `/api/batch/admin-proxy` (`zoho-middleware/routes/pos.js`) already brokers
  BrewPad → Apps Script. No new transport is needed.
- **Server-token auth:** `adminApi.gs` validates writes against the `SERVER_WRITE_TOKEN` script
  property (`:253-257`). The middleware already holds this secret; waitlist writes reuse it.
- **Rate limiter:** `waitlistLimiter` with a Redis store already fronts the endpoint.

### Established Patterns
- Staff lists live as sheet tabs and are read through the admin proxy; BrewPad is an IIFE
  (`js/brewpad.js`, ~3868 lines) — new UI goes inside it, matching existing sections.
- `sheetToObjects()` attaches `_row` (1-based) to every row object; status mutations index by
  `row._row`. Follow this convention for waitlist status writes.
- Apps Script has no CI deploy path — any `.gs` change requires a manual owner redeploy of a
  single deployment that serves BOTH staging and production.

### Integration Points
- `POST /api/waitlist` gains a sheet write ahead of the MailerLite call (D-03).
- `adminApi.gs` gains a `Waitlist` sheet constant, a bootstrap function, a list handler, and a
  status-update handler, routed in the `server_token` write block.
- `js/brewpad.js` gains a waitlist view.

</code_context>

<specifics>
## Specific Ideas

- The ordering promise is a direct quote the implementation must honour: `beer.html` tells
  customers "Beer batches are booked ahead, and we work through the list in order". Queue order is
  a product requirement, not a UI nicety.
- Phase 51's operational lesson was cited repeatedly and shaped D-03 and D-07: a durable cell is an
  operator signal; a log line is not.

</specifics>

<deferred>
## Deferred Ideas

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

</deferred>

---

*Phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-*
*Context gathered: 2026-09-02*
