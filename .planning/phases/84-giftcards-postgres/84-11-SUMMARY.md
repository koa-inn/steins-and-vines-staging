---
phase: 84-giftcards-postgres
plan: 11
subsystem: database
tags: [postgres, gift-cards, production, cutover, dual-write, money-path]

requires:
  - phase: 84-giftcards-postgres
    plan: 10
    provides: "staging rehearsal (UAT owner-approved with gaps)"
provides:
  - "Production GIFT_CARDS_STORE=dual since 2026-10-06 23:00:40Z, backfill verified 0 mismatches"
  - "84-DUAL-LOG.md production prerequisites, cutover and opening-smoke records; dual window day 1 = 2026-10-06"
affects: [84-12-dual-window-flip]

completed: 2026-10-07
status: complete
---

# 84-11 Summary — production cutover to dual

| Task | Result |
|------|--------|
| 1. Production deploy (sheets) | Gated deploy 37506054882 (`af261d83`) after attempt 1 was blocked by a new critical `proxy-addr` advisory (fixed `af261d83`). Guards + migration 0002 applied; beer page verified held back. |
| 2. After-hours cutover | Store closed. Dry run 0 rejects (1 card / 0 ledger rows, $0.00) → promoted 1 card + 1 ledger row → `GIFT_CARDS_STORE=dual` (deploy `d85b5fca`, database_required:true) → verify "1 cards: 0 mismatches". |
| 3. Opening-day smoke | Real lookup on the production kiosk (digits-only entry) 2026-10-07 16:54Z; no `[dual-write]` discrepancy. Adjust-on-active-card visual check deferred — the only production card is void. |

## Owner decisions
- D-05 sale-path attribution: not needed at this time.
- Void keeps `current_balance`: accepted (sheet does the same; no verify mismatch).
- Production pushes must not change customer-facing pages; beer page stays hidden (verified on every deploy).

## Shipped alongside (same day, separate commits, all on production)
`11b5c27b` gift-cert digit entry · `af261d83` proxy-addr 2.0.8 · `26be3828` kiosk per-rate tax rounding (INV-000226 root cause) · `c961e6bb` manual-confirm void uses the real txn id · `7eb2b0f8` Buy Kit kit-only price · `c229d919` Helcim v2 void/refund fields (with the owner raising the API token to Admin) · `fe6e8eb2` reversal/refund webhooks no longer treated as charges.

## Deviations
- RUNBOOK §3 used `--file <path>`; the CLIs need `--file=<path>` — corrected in `f569531a`.
- A live $1.05 kiosk test sale (INV-000229) was used to prove the void path; reversed (56129650), payment deleted, invoice voided.

## Open for 84-12
- ≥7 consecutive days with all six ops (issue, redeem, reload, lookup, void, adjust) observed for real and zero unexplained discrepancies, then the owner flip decision. Redeem was never UAT'd live.
- First active card: confirm Adjust Balance is visible.
