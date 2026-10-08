---
title: "ops-backfill rejects echo unexpected header text (leaked staff emails)"
status: done
created: 2026-10-08
source: phase 86-18 staging rehearsal
area: middleware / backfill
priority: medium (fix before the 86-19 production backfill)
---

## Problem

When a sheet's row 1 is not the expected header, `checkSheetHeaders` emits an
`unexpected_header` reject with the header text as the field name. The Config tab had no header
row, so its first data row (`staff_emails` | `<emails>`) was treated as the headers. The two staff
email addresses were then printed to the terminal and written to
`~/sv-backfill/rejects-Config-*.json`.

The tool's own contract (ops-backfill.js header comment) is "counts, ids, field names, masked
emails only".

## Fix

- In the reject output and files, mask or hash any field or header text that looks like an email
  (or any text with `@`). Better still, never echo `unexpected_header` text for the Config sheet.
- Add a regression test: a Config sheet whose row 1 is `staff_emails | a@x, b@y` must produce
  rejects with no `@` anywhere in the printed lines or the JSON.

## Cleanup

Delete the `~/sv-backfill/rejects-Config-20261008T2152*.json` and `...T2155*.json` files, which
hold the emails. Also move the `STEINS AND VINES (1..3).xlsx` downloads out of `~/Downloads`.

## Resolution (2026-10-08)

Fixed in `scripts/backfill/ops-backfill.js` `checkSheetHeaders`. When a required header is missing, row 1 is treated as data and no `unexpected_header` text is echoed. Otherwise only plain identifier-like names (`/^[A-Za-z][A-Za-z0-9_ ]{0,39}$/`) are named, and anything else becomes `<redacted header>`. The fix covers both the terminal output and the rejects JSON. Regression test: `__tests__/backfill/ops-backfill-header-redaction.test.js`. Local cleanup of the old rejects files and xlsx downloads is still up to the owner.
