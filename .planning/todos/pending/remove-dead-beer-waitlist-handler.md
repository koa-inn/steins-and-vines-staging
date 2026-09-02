---
title: "SUPERSEDED — do NOT delete setupBeerWaitlistForm (WR-02 follow-up)"
status: pending
created: 2026-08-25
updated: 2026-09-02
source: phase 72 code review (72-REVIEW.md, finding WR-02); premise invalidated by phase 74-06
area: frontend / cleanup
priority: low
---

## ⚠ STOP — the original instruction is now unsafe

This todo originally said to delete `setupBeerWaitlistForm()`, its call site, and
`tests/frontend/checkout-waitlist.test.js` as dead code. **Do not do that.**

When it was written (2026-08-25, during phase 72) the handler's only target was the
homepage "Beer Is Coming" form, which 72-02 removed — so it really was dead.

**Phase 74-06 then wired the same handler to a NEW, live form.** Verified 2026-09-02:

- `beer.html:285-289` — live `#beer-waitlist-form` / `#beer-waitlist-email` / `#beer-waitlist-confirm`
- `js/modules/13-init.js:440` — `setupBeerWaitlistForm()` under `if (page === 'beer')` — **LIVE**
- `js/modules/12-checkout.js:1689` — the handler POSTs to `/api/waitlist`, the real endpoint
  (`zoho-middleware/server.js:211` → MailerLite + staff notification)

Deleting the handler or its test would silently take down beer waitlist signups on the
live beer page. The waitlist is load-bearing: after the phase 74 UAT revision it is the
only route into the ferment-in-store beer experience, and `beer.html` promises customers
"we work through the list in order".

## What is actually still dead

Exactly one thing — the **homepage** call site:

- `js/modules/13-init.js:380` — `setupBeerWaitlistForm()` inside `if (page === 'home')`.
  The homepage form was removed in 72-02 and never replaced, so this call is a guarded
  no-op (`getElementById('beer-waitlist-form')` returns null and the function returns early).

## How to apply (revised, minimal)

1. Delete ONLY the `setupBeerWaitlistForm();` call on `js/modules/13-init.js:380`
   (the `page === 'home'` branch). Leave the `page === 'beer'` call on :440 alone.
2. Keep `setupBeerWaitlistForm()` in `js/modules/12-checkout.js` — it is live code.
3. Keep `tests/frontend/checkout-waitlist.test.js` — it covers live behaviour
   (CLAUDE.md rule #10 applies normally; there is no longer a reason to remove it).
4. `npm run build`, `npm run lint`, `npm test`, `cd zoho-middleware && npm test` — all green.
5. Confirm `beer.html` still submits successfully end-to-end before considering this done.

## Related

Phase 78 (BrewPad waitlist tracking) will build the internal/staff side of this waitlist.
Anyone touching waitlist code should read that phase's context first.
