---
title: Cal.com — separate beer canning/bottling appointment type (different station to wine)
status: pending — Cal.com done, middleware wiring outstanding
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

## Decided parameters (owner, 2026-09-05)

| Field | Value |
|---|---|
| Name (customer-visible, appears in booking emails) | **Beer Packaging Appointment** |
| Slug | **`beer-packaging`** |
| Default duration | **30 minutes** |

Rationale: "Packaging" rather than "Canning" because the page now offers bottling as a real choice,
and a customer booking to bottle should not receive an email saying canning. 30 minutes matches the
duration `beer.html` publishes for a standard 30 L batch. The description should note that bottling
takes longer, mirroring how the wine bottling type says "add 15 minutes for each additional kit".

## Cal.com side — DONE 2026-09-05

**The event type already existed.** It was not missing — it was live as **"Canning Appointment"**,
enabled, at the correct in-person address, on `hello@steinsandvines.ca`, but never wired into the
middleware (`/api/bookings/services` returns only three types and this was not one of them). Creating
a second type would have put two competing events on one physical station, so it was **reused and
updated** rather than duplicated (owner decision).

**Event type id: `6028745`** — this is the value the wiring below needs.

| Field | Before | After |
|---|---|---|
| Title | Canning Appointment | **Beer Packaging Appointment** |
| Description | *(empty)* | Packaging your finished beer, done with you here. Canning takes about 30 minutes for a standard 30L batch. Bottling with crown tops or flip-tops is welcome and takes a little longer, so please allow extra time. |
| Available durations | 60 / 90 / 120 / 150 | **30** / 60 / 90 / 120 / 150 |
| Default duration | 60 mins | **30 mins** |
| URL slug | `canning-appointment` | **unchanged — deliberate** |
| Location | In Person, 11-38918 Progress Way | unchanged |

Verified by reload: title, durations and default all persisted.

**Why the slug was left as `canning-appointment`:** the type was already live, so the link may exist
in sent emails or elsewhere. Renaming a slug breaks those links, and the slug is barely
customer-visible next to the title. If it should become `beer-packaging`, that is a deliberate
follow-up with link-breakage accepted — not a silent change.

**Open question for the owner:** the original 60/90/120/150 ladder is preserved, but its meaning is
unclear. If those were meant as *batch counts* at 30 min each, the ladder is now correct with 30
added. If they reflected a real 60-minute minimum for a single batch, then the new 30-minute default
under-books the station and should be reverted.

## Then the code wiring (Claude can do, once the id exists)

Mirrors the `CALCOM_EVENT_TYPE_BEER_WAITLIST` precedent exactly:

- `zoho-middleware/lib/validateEnv.js` — register `CALCOM_EVENT_TYPE_BEER_PACKAGING` (value
  **`6028745`**) alongside the existing `CALCOM_EVENT_TYPE_FERMENT_KIT` / `CALCOM_EVENT_TYPE_BOTTLING`
  entries (~line 63).
- `zoho-middleware/routes/bookings.js`
  - add it to the `ids` array (~line 149-151) so `/api/bookings/services` exposes it;
  - extend the `body.service` selector (~line 319+), which currently maps only `'bottling'` →
    `CALCOM_EVENT_TYPE_BOTTLING` and otherwise defaults to ferment-kit. Follow the existing
    fail-closed-ish pattern, and keep the default backward compatible.
- Set `CALCOM_EVENT_TYPE_BEER_PACKAGING=6028745` on **both** staging and production Railway.

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
