---
title: ensureGiftCardLedgerSheet crashes on an existing-but-empty GiftCardTransactions tab
status: pending
created: 2026-09-04
source: Phase 78 — identical bug found and fixed in ensureWaitlistSheet (commit 6e07d652)
area: apps-script / gift cards
priority: medium
---

## What

`ensureGiftCardLedgerSheet` (Phase 51, `apps-script/adminApi.gs`) has the same latent defect that
was fixed in `ensureWaitlistSheet` during Phase 78:

```js
if (!sheet) { /* insert + write headers */ }
var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
```

If a `GiftCardTransactions` tab exists but is **completely empty**, the header-write branch is
skipped because `sheet` is truthy, and `getLastColumn()` returns `0`. Apps Script rejects a
zero-column range:

```
Exception: The number of columns in the range must be at least 1.
```

## Why it matters

This is not confined to a setup path. Every gift-card ledger operation calls
`ensureGiftCardLedgerSheet`, so an empty tab would throw on live claim/settle/flag writes — the
same blast radius the waitlist version had. In Phase 78 this fired for real: the spreadsheet
already had a blank `Waitlist` tab and `setupWaitlist()` crashed on the first run.

Reaching the empty state needs someone to create the tab by hand or clear it, so it is unlikely
but not exotic.

## The fix that worked for the waitlist

Insert the sheet when absent, then write the header row whenever the sheet has **no content at
all** — an empty sheet has nothing to clobber, so this is distinct from the drifted-header case,
which must keep failing closed (`ledger_unavailable`, never repairing headers).

See commit `6e07d652` and `tests/frontend/adminapi-waitlist-ensure-sheet.test.js`, which injects a
fake `SpreadsheetApp`/`Logger` so the bootstrap branches actually execute rather than being
asserted by source shape. The same harness pattern applies here.

## Note

`apps-script/adminApi.gs` has no CI deploy path — a fix needs a manual paste + redeploy of the
existing deployment (new version, same deployment ID), and that single deployment serves BOTH
staging and production.
