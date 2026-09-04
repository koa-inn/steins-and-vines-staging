---
title: BrewPad adminApiPost retries every write once on a network-level failure
status: pending
created: 2026-09-04
source: Phase 78 code review WR-01 — assessed as pre-existing and out of that phase's scope
area: brewpad / middleware client
priority: low
---

## What

`adminApiPost` (`js/brewpad.js`) calls `fetchWithRetry(url, options)` without a `retries`
argument, which defaults to `1`. On a network-level `fetch()` rejection — offline, DNS, dropped
connection — the POST is re-sent after a 1s backoff:

```js
}, function (err) {
  // Network-level rejection (offline, DNS, dropped connection) — always retryable.
  if (retries > 0) return backoffRetry();
  throw err;
});
```

This applies to **every** BrewPad write, not just the waitlist.

## Why it matters

A network rejection cannot distinguish "the request never arrived" from "it arrived, succeeded,
and the response was lost". That is the same reasoning already recorded for the admin proxy:
reads may retry, writes must not, because the proxy collapses upstream errors to 502.

## Current risk: low

Phase 78's waitlist writes are now idempotent by construction — `waitlistTransitionAllowed`
permits a no-op re-set (`booked -> booked`), and notes writes are last-write-wins on the same
value — so a duplicate delivery is harmless there. The concern is the **other** write actions
reachable through `adminApiPost`, which have not been audited for idempotency.

## Suggested work

1. Audit every action routed through `adminApiPost` for idempotency under duplicate delivery.
2. Either pass `retries = 0` for non-idempotent writes, or give the write path an idempotency key.

Not urgent, and deliberately not bundled into Phase 78 — `adminApiPost`/`fetchWithRetry` predate
it (introduced in `9a07c9d6`, BrewPad v1.2.2) and the phase did not touch them.
