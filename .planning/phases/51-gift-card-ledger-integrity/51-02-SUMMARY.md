---
phase: 51-gift-card-ledger-integrity
plan: 02
subsystem: apps-script-gift-card-money-path
tags: [gift-card, idempotency, apps-script, ledger, H6, H7, D-12, money-path]
dependency-graph:
  requires:
    - GIFT_CARD_TRANSACTIONS_SHEET_NAME (51-01)
    - giftCardLedgerDecision (51-01)
    - ensureGiftCardLedgerSheet, appendGiftCardClaim, settleGiftCardClaim, flagGiftCardClaim (51-01)
  provides:
    - redeemGiftCard (claim-before-mutate, ledger-guarded)
    - reloadGiftCard (claim-before-mutate, ledger-guarded — its first idempotency guard ever)
  affects:
    - apps-script/adminApi.gs (redeemGiftCard, reloadGiftCard rewritten; all other gift-card
      handlers unmodified)
tech-stack:
  added: []
  patterns:
    - "Claim-before-mutate: appendGiftCardClaim() before the balance setValue(), settleGiftCardClaim()
      after, both write paths wrapped in try/catch so a throw can never drop needs_manual_review
      once the balance has moved"
    - "Ledger-as-guard: giftCardLedgerDecision() replaces last_tx_ref comparison as the idempotency
      check on both money-moving handlers"
key-files:
  created: []
  modified:
    - apps-script/adminApi.gs
    - tests/frontend/adminapi-giftcard-ledger.test.js
decisions:
  - "appendGiftCardClaim's return carries a plain row-index number in `.row`, but
    settleGiftCardClaim/flagGiftCardClaim both index via `row._row` (the sheetToObjects row
    shape). Fixed locally in both handlers by wrapping once per claim as `{ _row: claim.row }`
    rather than changing either 51-01 helper's signature or return shape (Rule 1 bug, scoped to
    this task's own new call sites)."
  - "updateGiftCardInvoice (decision 44-02) deliberately left standing — NOT brought under
    acquireScriptLock. The ledger route with per-cell writes preserved means the clobber risk the
    lock would address never materialises; adding it would introduce a new waitLock-timeout
    failure mode on a path that has never failed. zoho_invoice_number and last_updated remain
    writable without the mutex; both are single-cell idempotent writes and neither is read by any
    guard introduced in this plan."
  - "voidGiftCard gets no ledger row (excluded by design, not oversight). It moves no money, its
    three writes are status-only, and adding a write would enlarge the diff on a live money path
    for no criterion."
  - "reloadGiftCard had NO idempotency guard of any kind before this phase — confirmed directly
    against the live source (it only ever WROTE last_tx_ref, never read it back). The ledger
    decision is reload's first real idempotency guard, not a reordering of an existing one. This
    makes ROADMAP criterion 1's phrasing (\"reloadGiftCard is idempotent\") a new guarantee, not a
    restored one."
metrics:
  duration: "~50 min"
  completed: 2026-09-02
---

# Phase 51 Plan 02: redeemGiftCard + reloadGiftCard Claim-Before-Mutate Rewrite Summary

Rewrote both gift-card money-moving handlers (`redeemGiftCard`, `reloadGiftCard`) to append a durable `GiftCardTransactions` claim row before the balance `setValue()` and settle it after, replacing the stale `last_tx_ref` idempotency check with a read of the ledger via `giftCardLedgerDecision()` — closing the H6 double-debit and H7 duplicate-credit crash windows (ROADMAP criteria 1, 6, 7).

## What Was Built

**Task 1 (RED):** Extended `tests/frontend/adminapi-giftcard-ledger.test.js` with a parameterized `describe` block per handler (10 assertions each: presence of all five ledger calls, `appendGiftCardClaim(` strictly before the balance `setValue(`, `settleGiftCardClaim(` strictly after, `giftCardLedgerDecision(` before the claim, the `'unsettled_claim'`/`'ledger_unavailable'` literals, the stale guard's absence, exactly four `setValue(`/zero `setValues(`, the lock preserved, the correct `kind` literal, and `needs_manual_review` threaded through at least 5 places), plus business-rule-survival and whole-file shape-stability assertions (`updateGiftCardInvoice` no-lock, `issueGiftCard` 10-column schema, `lookupGiftCard` no-lock, `voidGiftCard` untouched). Initial run: **15 failing / 73 passing / 88 total**, confined to the two new per-handler blocks (8 fails in `redeemGiftCard`'s block — including the last-tx-ref-guard-still-present assertion, since redeem's stale guard was still live at RED — and 7 in `reloadGiftCard`'s, since it never had that guard to begin with). Every one of 51-01's 60 pre-existing assertions and the 13 new whole-file/business-rule assertions passed at RED.

**Task 2 (GREEN — redeem):** Rewrote `redeemGiftCard` per the plan's exact sequence inside the existing `acquireScriptLock(15000)` try/finally: validate → `findRowById` → `ensureGiftCardLedgerSheet()` (fail closed to `ledger_unavailable` before any write) → `giftCardLedgerDecision()` on `sheetToObjects(GIFT_CARD_TRANSACTIONS_SHEET_NAME)` → `replay` returns the current balance with zero writes, `blocked` flags the stuck claim and returns `unsettled_claim` with `claim_tx_id`/`claim_tx_ref`/`claim_created_at`, `proceed` continues → the pre-existing `active`-status and `insufficient_balance` (±0.001) checks, unchanged → `appendGiftCardClaim()` before the four per-cell balance writes (wrapped in try/catch → `write_failed` on throw) → `settleGiftCardClaim()` after (its own try/catch → `settle_failed` on throw or a `false` return) → cache invalidation and `{ ok:true, new_balance, status, tx_id }`. Suite: `redeemGiftCard`'s block went fully GREEN while `reloadGiftCard`'s stayed RED (7 failures) — proving Task 3 had real, non-trivial work.

**Task 3 (GREEN — reload):** Mirrored Task 2's structure exactly in `reloadGiftCard`, with the four documented differences: `kind: 'reload'`, `balance + amount`, no `insufficient_balance` check (reload never had one), and the `String(gc.status) === 'void'` guard restoring status to the literal `'active'`. Verified directly against the live source before writing anything that `reloadGiftCard` had zero read references to `last_tx_ref` — it is a genuinely new guard, not a repaired one. Suite went to **88/88 green**.

**Deviation found and fixed in both Task 2 and Task 3 (Rule 1 — bug, local to this task's new code):** `appendGiftCardClaim`'s return shape carries the claim's row as a plain number (`{ row: rowIndex }`), but `settleGiftCardClaim`/`flagGiftCardClaim` both dereference their `row` parameter as `row._row` (the `sheetToObjects` row shape). Calling `settleGiftCardClaim(ledger, claim.row, ...)` as the plan's prose literally describes would pass a bare number where an object with `._row` is expected, breaking at runtime. Fixed by wrapping once per claim — `var claimRowRef = { _row: claim.row };` — immediately after a successful `appendGiftCardClaim()`, and using `claimRowRef` for every subsequent `settleGiftCardClaim`/`flagGiftCardClaim` call against that same claim in both handlers. Did not touch either 51-01 helper's signature or return shape (out of this plan's file scope and would risk 51-01's own test assertions). The `blocked`-path calls to `flagGiftCardClaim(ledger, decision.row, ...)` needed no such wrapping — `decision.row` already comes from `sheetToObjects()` output and carries `_row` natively.

**Second small deviation (Rule 1 — bug, same category):** the first draft of `reloadGiftCard`'s doc comment quoted the literal removed guard text `String(gc.last_tx_ref) === String(txRef)` for explanatory context. This tripped the plan's own file-wide `grep -c "String(gc.last_tx_ref)" apps-script/adminApi.gs` acceptance criterion (must be exactly 0). Reworded to describe the removed guard without literally reproducing the expression; re-verified the grep count is 0 and the suite stays green.

## Verification

- **Frontend ledger suite:** RED 73/88 (Task 1) → GREEN with `redeemGiftCard` block passing, `reloadGiftCard` block still 7-red (Task 2) → GREEN 88/88 (Task 3, final).
- **Full `npm test`:** 1393/1393 (baseline 1365 + 28 net new in this file).
- **Middleware `npm test`:** 1527/1527 — unchanged count from the 51-01 baseline, confirming no middleware file was touched (this worktree's `zoho-middleware/node_modules` was empty at session start — the same environment-hydration gap 51-01 hit in its own worktree — ran `npm ci` against the committed `package-lock.json`; `git status --short zoho-middleware/` stayed clean afterward, confirming this was dependency hydration, not a new/unverified install).
- **Lint:** `npm run lint` (`eslint js/ --max-warnings 0`) clean, exit 0.
- **Source-order measurements** (final, via a standalone brace-matcher script mirroring the test file's `sliceFunctionSource`):

  | Handler | `giftCardLedgerDecision(` idx | `appendGiftCardClaim(` idx | balance `setValue(` idx | `settleGiftCardClaim(` idx |
  |---|---|---|---|---|
  | `redeemGiftCard` | (before 2037) | 2037 | 3035 | 4018 |
  | `reloadGiftCard` | (before 1896) | 1896 | 2808 | 3814 |

  Both handlers: `giftCardLedgerDecision(` < `appendGiftCardClaim(` < balance `setValue(` < `settleGiftCardClaim(`, strictly, confirming claim-before-mutate ordering in the source text.
- **Per-handler `setValue`/`setValues` counts:** both handlers exactly 4 `setValue(` calls, 0 `setValues(` — the D-05 non-contiguous-column trap was not re-entered.
- **`needs_manual_review` counts:** 8 within `redeemGiftCard`'s slice, 8 within `reloadGiftCard`'s slice, 19 file-wide (both well above the plan's ≥5/≥10 thresholds).
- **`grep -c "String(gc.last_tx_ref)" apps-script/adminApi.gs`:** 0 — the stale-key guard is gone from both handlers and from every comment referencing it.
- **`grep -c "acquireScriptLock(" apps-script/adminApi.gs`:** 13, unchanged from the pre-task value — the lock usage count did not shift.
- **`grep -c "generateNextId(" apps-script/adminApi.gs`:** 13, unchanged — confirms no call site was added/removed by this plan (the ledger uses `Utilities.getUuid()`, per 51-01).
- **Diff scope:** commit-by-commit, `git diff --diff-filter=D --name-only HEAD~1 HEAD` returned empty after every commit (no unexpected deletions). Task 2's 4 hunks and Task 3's 4 hunks are each confined entirely within their respective function bodies — no hunk touches `voidGiftCard`, `issueGiftCard`, `lookupGiftCard`, or `updateGiftCardInvoice`. `git diff --name-only HEAD~3..HEAD` (this plan's three commits) lists exactly `apps-script/adminApi.gs` and `tests/frontend/adminapi-giftcard-ledger.test.js` — no middleware file, no `js/` file, no build artifact.
- **Decision 44-02 pinned:** `updateGiftCardInvoice`'s slice still contains zero `acquireScriptLock(` — left standing per the plan's explicit instruction, asserted by the test suite's whole-file block.
- **`voidGiftCard` pinned:** its slice contains zero `appendGiftCardClaim(` — no ledger row added, asserted by the test suite's whole-file block.

## What Remains Unverified (stated per the plan's own `<verification>` section, not glossed over)

Nothing in this plan or its test suite proves any of the following at runtime — `SpreadsheetApp` does not exist outside Google's environment, and the middleware suite mocks `axios` before it ever reaches Apps Script:

- That the claim row actually lands in `GiftCardTransactions` before the balance write executes.
- That a claim row survives an interrupted execution (a real crash mid-write).
- That `needs_manual_review` is really persisted as a durable cell value rather than merely present in the return object shape asserted here.
- That a replayed `transaction_ref` genuinely leaves the balance unchanged on a second call, live.

These are exactly what 51-03's live probes against a real Google Sheet must verify (D-11's dangerous-direction requirement). A green run of this suite is proof the DECISION LOGIC and SOURCE ORDERING are correct; it is not proof the money path is fixed in production. This distinction is stated explicitly in the test file's header comment and in the new describe block's own comment, per the plan's explicit concern about STATE.md's four-days-dead-in-production precedent.

## Commits

1. `b35b7e0d` — `test(51-02): RED - claim-before-mutate source-order assertions for redeem and reload`
2. `727baf69` — `fix(51-02): redeemGiftCard claims before it mutates and guards on the ledger (H6)`
3. `98a6a452` — `fix(51-02): reloadGiftCard claims before it mutates - closes the H7 duplicate credit`

## Deviations from Plan

Two Rule 1 (auto-fixed bug) deviations, both documented above and both scoped entirely within this plan's own new code:

1. `appendGiftCardClaim`'s numeric `.row` return vs. `settleGiftCardClaim`/`flagGiftCardClaim`'s `row._row` expectation — fixed by wrapping `{ _row: claim.row }` once per claim in both handlers, not by modifying either 51-01 helper.
2. `reloadGiftCard`'s doc comment initially quoted the removed guard's literal source text, tripping the plan's own file-wide grep acceptance criterion — reworded to describe rather than reproduce it.

One out-of-scope environment fix, same category as 51-01's: this worktree's `zoho-middleware/node_modules` was empty at session start (a fresh worktree, never hydrated); ran `npm ci` against the existing `package-lock.json` so the middleware suite could run per CLAUDE.md rule 1. Dependency hydration from an already-committed lockfile, not a new/unverified package install; `node_modules/` remains gitignored and `git status --short` stayed clean.

No architectural deviations (Rule 4) were needed — the plan's design was implementable exactly as specified once the `.row`/`._row` shape mismatch above was worked around locally.

## Known Stubs

None. Nothing in this plan renders to a UI or serves placeholder data.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers. No new HTTP action or dispatch branch was added (T-51-02-09); both handlers keep their existing `server_token` dispatch entries. The `claim_tx_id`/`claim_tx_ref`/`claim_created_at` fields returned to a blocked caller are opaque identifiers surfaced only to the staff-operated, device-token-gated kiosk client (T-51-02-07, accepted per the threat model).

## Self-Check: PASSED

- `apps-script/adminApi.gs` — FOUND, `redeemGiftCard` at line 4496, `reloadGiftCard` at line 4628 (both moved down from 51-01's baseline as documented, due to the doc-comment expansion).
- `tests/frontend/adminapi-giftcard-ledger.test.js` — FOUND, 88 tests, all passing.
- `b35b7e0d` — FOUND in `git log --oneline --all`.
- `727baf69` — FOUND in `git log --oneline --all`.
- `98a6a452` — FOUND in `git log --oneline --all`.
