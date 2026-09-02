---
phase: 51-gift-card-ledger-integrity
plan: 01
subsystem: apps-script-gift-card-ledger
tags: [gift-card, idempotency, apps-script, ledger, D-12, money-path-prep]
dependency-graph:
  requires: []
  provides:
    - GIFT_CARD_TRANSACTIONS_SHEET_NAME
    - giftCardLedgerDecision (pure D-12 idempotency decision)
    - normalizeCertNumber, roundGiftCardAmount, ledgerFlagTrue
    - ensureGiftCardLedgerSheet, appendGiftCardClaim, settleGiftCardClaim, flagGiftCardClaim
    - setupGiftCardLedger
  affects:
    - apps-script/adminApi.gs (additive only; redeemGiftCard/reloadGiftCard untouched)
tech-stack:
  added: []
  patterns:
    - "Pure-logic extraction from an untestable Apps Script file (adminapi-recipe-pure.test.js precedent)"
    - "Claim-before-mutate append-only ledger (D-02), self-healing + fail-closed bootstrap (D-10)"
key-files:
  created:
    - tests/frontend/adminapi-giftcard-ledger.test.js
  modified:
    - apps-script/adminApi.gs
decisions:
  - "giftCardLedgerDecision's consumed-ref replay rule is intentionally NOT forgiving (unlike the claimed-status check) — a tx_ref stays replay-protected after the staff escape hatch clears the card-level block; only deleting the row fully resets a ref"
  - "appendGiftCardClaim mints tx_id via Utilities.getUuid(), not generateNextId() — avoids the O(n) column-A scan on a ledger that grows every redeem/reload"
metrics:
  duration: "~35 min"
  completed: 2026-09-02
---

# Phase 51 Plan 01: Gift-Card Ledger Substrate + Pure Idempotency Decision Summary

Built the D-12 idempotency decision as a pure, fully-tested function extracted from `apps-script/adminApi.gs`, plus the `GiftCardTransactions` ledger's self-healing/fail-closed bootstrap and its claim/settle/flag write helpers — all additive, none of it wired into the money path yet.

## What Was Built

**Task 1 (RED):** `tests/frontend/adminapi-giftcard-ledger.test.js` — a new Jest suite following the `adminapi-recipe-pure.test.js` precedent (loads the real `.gs` file via `fs.readFileSync` + `new Function`, no `SpreadsheetApp` stub). Initial run: **45 failing / 2 passing / 47 total**, every `giftCardLedgerDecision`-related failure a `TypeError: api.<name> is not a function` (RED for the right reason — no `ReferenceError`/`SyntaxError`). The two passing tests (independent of the unimplemented helpers) were the whole-file syntax-evaluation gate and the pre-existing GiftCards 10-column schema check.

**Task 2 (GREEN):** Implemented the four pure helpers in `adminApi.gs`, placed immediately before the `// ─── Gift Card Lifecycle (Phase 44) ───` banner:
- `normalizeCertNumber(value)` — trim + uppercase, `''` for null/undefined
- `roundGiftCardAmount(number)` — `Math.round(n * 100) / 100`
- `ledgerFlagTrue(cellValue)` — normalizes Sheets' boolean/string/number cell representations
- `giftCardLedgerDecision(rows, certNumber, txRef)` — the core D-12 decision, priority-ordered: settled-same-ref replay → consumed-ref replay (any other status matching cert+ref) → same-ref-claimed block → different-ref-claimed block (the actual D-12 double-debit case) → proceed. `unsettled` is always populated from the any-claimed-row observation regardless of the returned action.

Suite went to **47/47 green** after this task. `GIFT_CARD_TRANSACTIONS_SHEET_NAME = 'GiftCardTransactions'` was added to the sheet-name constant block alongside `GIFT_CARDS_SHEET_NAME`.

**Task 3:** Implemented the five ledger IO helpers (touch `SpreadsheetApp`, unit-testable only by source shape):
- `ensureGiftCardLedgerSheet()` — creates the 12-column `GiftCardTransactions` tab inline if absent (`setupRecipeTabs()` idiom: `insertSheet` + `appendRow` header + bold + freeze row 1), resolves every column by `headers.indexOf(name) + 1`, and returns `{ ok: false, error: 'ledger_unavailable', missing: [...] }` on any drifted/missing column — no positional fallback, no auto-repair on a money path.
- `appendGiftCardClaim(ledger, certNumber, txRef, kind, amount, balanceBefore)` — appends the CLAIM row (`status: 'claimed'`) before any balance write would occur, mints `tx_id` via `Utilities.getUuid()` (not `generateNextId`, which scans column A on every call), reads back the written `tx_id` to confirm the write landed, invalidates the sheet cache.
- `settleGiftCardClaim(ledger, row, txId, balanceAfter)` — re-verifies the `tx_id` cell still matches before writing `balance_after`/`status: 'settled'`/`settled_at`; returns `false` without writing on a mismatch.
- `flagGiftCardClaim(ledger, row, noteText)` — durably sets `needs_manual_review = true` and the sanitized note, leaving `status` unchanged so the row keeps blocking (the persisted half of D-08 — today `needs_manual_review` only ever exists as a middleware response field / Redis sentinel).
- `setupGiftCardLedger()` — owner-run wrapper placed next to `setupRecipeTabs()`, logs tab-ready or missing-columns.

Extended the test file with source-shape assertions for all five (top-level existence, `getUuid` not `generateNextId`, cache invalidation, `ledger_unavailable` fail path, exact 12-column header order, `sanitizeInput` routing, and the file-wide `generateNextId(` count staying at its pre-plan value). Suite finished at **60/60 green**.

## Verification

- **Frontend suite:** RED 47 total (45 fail / 2 pass) → GREEN 47/47 after Task 2 → GREEN 60/60 after Task 3 (13 new source-shape tests added). Full `npm test`: **1365/1365** (baseline 1352 + 13 net new in this file after the Task 3 extension; the isolated file itself carries 60 tests, several counted are `test.each` expansions).
- **Middleware suite:** `cd zoho-middleware && npm test` — **1527/1527**, unchanged (nothing in the middleware was touched by this plan). Note: this worktree had no `node_modules` under `zoho-middleware/` at session start (never installed, not gitignore-relevant since it's a standard dependency hydration, not a new/unverified package) — ran `npm ci` from the existing `package-lock.json` to make the suite runnable; confirmed `git status --short zoho-middleware/` stayed clean afterward.
- **Lint:** `npm run lint` (`eslint js/ --max-warnings 0`) — clean, no output, exit 0. No ES6 syntax (`=>`, `const`, `let`) introduced in the new `adminApi.gs` block (grep count 0).
- **`generateNextId(` count:** 13 before this plan, 13 after — no existing call site added or removed (verified by both a shell grep and a Jest assertion in the suite itself).
- **Money path:** `git diff HEAD~3..HEAD -- apps-script/adminApi.gs | grep -c "redeemGiftCard\|reloadGiftCard"` → `0`. Neither function was touched. `String(gc.last_tx_ref) === String(txRef)` is present in `redeemGiftCard` (line ~4494) exactly as before.
  - **Finding for 51-02 (not a deviation, no action taken this plan):** `reloadGiftCard` does **not** actually contain an equivalent `last_tx_ref` idempotency check — 51-PATTERNS.md's description of it as "byte-for-byte the same shape [as redeemGiftCard]" is not accurate for the idempotency guard specifically. `reloadGiftCard` reads `gc.last_tx_ref` nowhere; it unconditionally increments the balance on every call. This makes the D-12 fix for reload strictly more urgent than the pattern map implied — flagging for 51-02's planning, out of scope for this plan (D-01: money-path handlers are untouched until 51-02).
- **12-column header row** written by `ensureGiftCardLedgerSheet` (exact order): `tx_id | cert_number | tx_ref | kind | amount | balance_before | balance_after | status | needs_manual_review | created_at | settled_at | notes` — matches `<interfaces>` and mirrors `.planning/notes/sheets-to-postgres-data-conversion.md` §3.1's shape plus the four D-08/D-12-only columns.
- **`git diff --name-only HEAD~3..HEAD`:** exactly `apps-script/adminApi.gs` and `tests/frontend/adminapi-giftcard-ledger.test.js` — no other file touched.
- **No new HTTP surface:** `git diff HEAD~3..HEAD -- apps-script/adminApi.gs` shows exactly two hunks — one at the constant block (line ~57) and one spanning the new setup/pure-helper/IO-helper block starting after `setupRecipeTabs()` (line ~4106 onward). No hunk touches the `doPost`/`doGet` dispatch region.

## Commits

1. `7d21473d` — `test(51-01): RED - pure ledger guard suite for gift-card idempotency`
2. `8cdd3ed8` — `feat(51-01): pure gift-card ledger decision helpers (D-12 unsettled-claim guard)`
3. `e19ef7ab` — `feat(51-01): idempotent GiftCardTransactions bootstrap + claim/settle/flag helpers`

## Deviations from Plan

None — plan executed as written. One out-of-scope environment fix: `zoho-middleware/node_modules` was absent in this worktree (never installed); ran `npm ci` against the existing `package-lock.json` to hydrate it so the middleware suite could run per CLAUDE.md rule 1. This is dependency hydration from an already-committed lockfile, not a new/unverified package install, and `node_modules/` remains gitignored (confirmed clean `git status` afterward).

One finding surfaced for the next plan (documented above, not acted on): `reloadGiftCard` has no idempotency guard at all today, not merely the same atomicity-ordering defect as `redeemGiftCard`. 51-02 should verify this directly against the live file before assuming symmetry with `redeemGiftCard`.

## Known Stubs

None. Nothing in this plan renders to a UI or serves placeholder data — it is pure logic plus inert (unwired) Apps Script helpers.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-51-01-01 through T-51-01-SC, all addressed as designed: no new dispatch branch, header-name column resolution with fail-closed drift handling, `Utilities.getUuid()` instead of the O(n) `generateNextId` scan, and the suite's header comment naming exactly what it cannot prove).

## Self-Check: PASSED
