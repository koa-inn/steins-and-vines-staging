# Phase 80: BrewPad waitlist — work the queue - Discussion Log

**Date:** 2026-09-04
**Mode:** default (interactive)

> Human reference only — audits and retrospectives. Downstream agents read CONTEXT.md, not this file.

## Areas Selected

All four offered areas were selected: Customer matching, Contact action, Queue override, Recipe
attachment. A fifth area (manual add + phone surfacing) was raised by the owner after the four were
settled and folded in rather than deferred.

---

## Customer matching

**Q: What should staff be able to do from the waitlist row?**
Options: link existing + create inline (recommended) / link existing only / auto-match on email.
**Chose:** link existing, create if missing.

*Scout finding that de-risked this after the choice:* both halves already exist in BrewPad —
`fetchReassignSearch` (`js/brewpad.js:2088`) for the type-ahead, and an inline new-customer form
(`js/brewpad.js:7754`) that POSTs to `/api/contacts` and gets a `contact_id` back. `POST /api/contacts`
(`routes/bookings.js:381`) already does find-or-create by email. Largely wiring, not construction.

**Q: What should the sheet store?**
Options: contact_id + name (recommended) / contact_id only / contact_id + name + phone.
**Chose:** contact_id + display name. *Later revised by the owner to include phone — see Manual add.*

---

## Contact action

**Owner interjected before answering the mechanism question**, asking two things:
1. *"Is it possible to have it send through MailerLite or is that not the purpose of that service?"*
2. *"Can it link to our cal.com for booking?"*

**Answers, both grounded in code rather than assumption:**
- **MailerLite: no.** `lib/mailerlite.js` documents its own boundary ("NOT transactional email") and
  exposes only `isConfigured`/`addSubscriber`. The substantive reason beyond convention: MailerLite
  honours unsubscribes, so an unsubscribed customer would silently never receive "your spot is
  ready".
- **Cal.com: yes, and better wired than expected.** `lib/calcom.js` has `listEventType`, `getSlots`,
  `createBooking`, `verifyWebhook` against the v2 API, with `CALCOM_API_KEY` already in play.

This reshaped the options — the original mechanism question (mailto vs templated send) was withdrawn
and replaced with a scope question about how far to take the booking integration.

**Q: How far should the contact email go?**
Options: templated + booking link (recommended) / + live slots / link only / book on their behalf.
**Chose:** templated email + Cal.com booking link. `getSlots` and `createBooking` explicitly out.

**Q: Auto-advance status to `contacted` on send?**
**Chose:** yes, on confirmed successful send only. Safe by construction — Phase 78's
`waitlistTransitionAllowed` is forward-only and treats a re-set as an allowed no-op.

---

## Queue override

**Q: How should manual reorder relate to signup order?**
Options: signup order with pinning override (recommended) / full manual once touched / move up-down only.
**Chose:** empty `position` = today's chronological behaviour; setting one pins that row.

**Q: Should a manual move be visible, and does the site copy change?**
Options: pin indicator only (recommended) / + who and why / silent / + soften beer.html copy.
**Chose:** pin indicator in BrewPad, `beer.html` copy unchanged.

---

## Recipe attachment

**Q: When, and how many per row?**
Options: any time one recipe (recommended) / any time multiple / only once contacted.
**Chose:** any time, **multiple** — declining the recommendation. Consequence accepted: a Sheets cell
must hold a list, so a delimiter and parse/serialize helper are needed.

**Q: Any downstream effect?**
Options: display only (recommended) / + stock advisory / + batch pre-fill.
**Chose:** display only.

---

## Manual add + phone (owner addition)

Raised after the four areas closed: *"I want to be able to manually add in customers to the waitlist
if someone has shown interest via word of mouth"* and *"I would also like to have their phone number
surfaced if we have it for that customer"*.

Folded in rather than deferred, because both need schema columns and this phase already owns the
single migration and redeploy (D-20).

**Q: What identifies a manually-added person?**
Options: email required + phone optional (recommended) / email OR phone / email with placeholder allowed.
**Chose:** email required, phone optional. Keeps email as the dedupe key and keeps the contact action
functional.

*Raised proactively during this question:* Phase 78's D-06 non-disclosure protects customers on the
public form, but a staff-initiated add should do the opposite and tell staff the person is already
listed. Captured as D-23.

**Q: Should manual adds sync to MailerLite?**
Options: yes same as public (recommended) / no, sheet only / staff choose per add.
**Chose:** yes, same fire-and-forget path — keeps the "Not Synced" filter meaning exactly one thing.

---

## Claude's Discretion

- `recipe_ids` delimiter and parse/serialize helper
- `position` numeric scheme (sparse ints vs fractional vs renumber)
- Whether `customer_name`/`customer_phone` opportunistically refresh on write
- Draft contact-email wording (to be surfaced for owner approval, not silently guessed)

## Deferred

Booking on the customer's behalf; live slots in the email; ingredient-stock advisory; batch pre-fill;
inbound reply handling; generalising to cider/wine/classes; automated MailerLite reconciliation;
recording who/why on a pin; softening `beer.html` copy. Full detail in CONTEXT.md `<deferred>`.

## Corrections made during this session

- An earlier draft of D-02 excluded phone as "the most sensitive field". The owner asked for it;
  D-02 was revised and the widened-PII consequence recorded once rather than relitigated.
- "D-06" is overloaded across phases — Phase 78's D-06 is non-disclosure, this phase's D-06 is the
  Cal.com booking link. All cross-phase references are now explicitly qualified.
