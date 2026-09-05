---
title: Cal.com — separate beer canning/bottling appointment type (different station to wine)
status: pending
created: 2026-09-05
source: owner prompt (2026-09-05) — "we should have a separate appointment type for beer in cal.com since it['s] at a different station than the wine bottling"
area: bookings / Cal.com / middleware
priority: medium
---

## What

Beer packaging needs its own Cal.com event type, separate from the existing wine
**Bottling Appointment** (`bottling-appointment`, id `5904690`).

## Why it matters

Two independent reasons, either alone sufficient:

1. **Different physical station.** Beer canning does not happen at the wine bottling station, so the
   two cannot share a calendar without double-booking a resource that only exists once.
2. **Different duration, now published.** `beer.html` tells customers canning takes **about half an
   hour for a standard 30 L batch**. The wine bottling event type is 30 minutes with a documented
   "add 15 minutes per additional kit" note, which is wine-kit framing and does not describe beer.
   Bottling beer (crown top / flip top) is **slower than canning**, so the beer type likely needs
   either a longer default or a duration the staff set per booking.

## Owner action required first

Claude cannot create this — it needs Cal.com account access. Same shape as the `beer-consult`
creation during Phase 80 §1a:

1. Create the event type in Cal.com (suggested slug `beer-packaging` or `beer-canning` — note the
   customer-visible name should cover **both** canning and bottling, since the page now offers both).
2. Note its numeric event-type id.

## Then the code wiring (Claude can do, once the id exists)

Mirrors the `CALCOM_EVENT_TYPE_BEER_WAITLIST` precedent exactly:

- `zoho-middleware/lib/validateEnv.js` — register `CALCOM_EVENT_TYPE_BEER_PACKAGING` alongside the
  existing `CALCOM_EVENT_TYPE_FERMENT_KIT` / `CALCOM_EVENT_TYPE_BOTTLING` entries (~line 63).
- `zoho-middleware/routes/bookings.js`
  - add it to the `ids` array (~line 149-151) so `/api/bookings/services` exposes it;
  - extend the `body.service` selector (~line 319+), which currently maps only `'bottling'` →
    `CALCOM_EVENT_TYPE_BOTTLING` and otherwise defaults to ferment-kit. Follow the existing
    fail-closed-ish pattern, and keep the default backward compatible.
- Set the env var on **both** staging and production Railway.

## Watch out for

- **`/api/bookings/services` is cached and was double-encoding its payload** (fixed in `8a3d7868`).
  When verifying the new type appears, **call the endpoint twice** — the first call is a cache miss
  and will look fine either way.
- **`CALCOM_EVENT_TYPE_BEER_WAITLIST=6955754` is still unset on PRODUCTION Railway** (see Phase 80
  §7). If someone is already in Railway adding the packaging id, set that one at the same time.
- The Phase 80 `WAITLIST_BOOKING_SLUG` work established that selecting a booking link by **slug**
  with a fail-closed no-match guard is the right pattern — `services[0]` is not safe.

## Related

- Wine still bottles, so the existing `bottling-appointment` type stays as-is. Consider renaming it
  customer-side to something unambiguous like "Wine Bottling Appointment", since its current generic
  name appears in booking emails and will read as if it covers beer.
- `beer.html` step 4 + the "Can I have bottles instead of cans?" FAQ are the copy this supports.
