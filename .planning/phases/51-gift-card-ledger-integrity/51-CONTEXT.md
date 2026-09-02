# Phase 51: Gift-Card Ledger Integrity — Context

**Gathered:** 2026-09-02
**Status:** Ready for planning
**Requirement:** MONEY-03 (audit H6/H7)
**Source:** 2026-06-29 audit (H6/H7 flagged the class) + root cause located 2026-09-02 during the Sheets→Postgres research pass

<domain>
## Phase Boundary

Close the **double-spend / double-credit window** on the gift-card money path.

`redeemGiftCard` (`apps-script/adminApi.gs:4204`) and `reloadGiftCard` (`:4264`) each change a
customer balance across **four independently-committing `setValue()` calls**, with the idempotency
key `last_tx_ref` written **LAST**:

```
setValue(newBalance)   <- money moves here        (~:4246 redeem, ~:4296 reload)
setValue(newStatus)
setValue(now)
setValue(txRef)        <- idempotency key lands here  (~:4249 redeem, ~:4299 reload)
```

The guard reads `gc.last_tx_ref` (~:4221). If the script dies between the first and last write, the
balance is already changed while `last_tx_ref` is stale — so a retry with the **same**
`transaction_ref` misses the guard and applies the change **twice**. Redeem double-debits a
customer; reload double-credits.

**This requires no concurrency** — a single interrupted execution is sufficient. That is why the
pre-existing criterion 6 ("an interleaved redeem retry") does not cover it, and why criterion 7 was
added 2026-09-02.

**In scope:** the atomicity defect on both `redeemGiftCard` and `reloadGiftCard`, and durable
`needs_manual_review` on failure.

**Out of scope (owner decision D-01):** M9 formula-injection sanitization and M18 `issueGiftCard`
bounds-checking — deferred to a follow-up phase. M15 (negative-taxable custom-line tax parity) is
**moved out entirely** — it shares no code path with the gift-card ledger and was only parked here
by the audit.

</domain>

<decisions>
## Implementation Decisions

### Owner decisions taken 2026-09-02

- **D-01 — Scope: atomicity core only.** This phase covers ROADMAP criteria **1, 2, 6, 7**. It does
  NOT cover criterion 3 (M9 `=+-@` sanitization), criterion 4 (M18 header-mapped `issueGiftCard`
  + bounded numerics), or criterion 5 (M15 tax parity). Rationale: `apps-script/adminApi.gs` cannot
  be tested locally and each change costs a manual owner redeploy with **no staging gate** — keep
  the diff to the live money-path defect.
- **D-02 — Approach: append-only ledger.** Introduce a `GiftCardTransactions` sheet. The `tx_ref`
  row is written as a **CLAIM before the balance changes**, and the idempotency guard reads the
  **ledger**, not `last_tx_ref`. Chosen over in-row lock-hardening because it actually closes the
  crash window, yields an audit trail that does not exist today, and matches criterion 1's own
  existing wording ("append-only processed-ref ledger").
- **D-03 — M15 moves out.** Remove it from Phase 51's criteria and rehome it (own phase, or folded
  into an existing kiosk/tax phase). Do not plan it here.

### Non-negotiable technical constraints

- **D-04 — Reordering is NOT a fix.** Writing `txRef` first within the current schema converts
  double-debit into "customer keeps their balance and got the goods" — a different loss, not a
  closed window. Only a durable claim in the same failure domain as the balance write fixes it.
- **D-05 — A single batched `setValues()` is NOT a safe shortcut.** GiftCards column order is
  `cert_number | face_value | current_balance | status | issued_date | issued_by |
  zoho_invoice_number | notes | last_updated | last_tx_ref`. The mutated columns (3,4 and 9,10) are
  **not contiguous**, so one ranged write would also rewrite `issued_date`, `issued_by`,
  `zoho_invoice_number` and `notes`. `updateGiftCardInvoice` (`:4358`) writes
  `zoho_invoice_number` **without taking the lock** (deliberate decision 44-02), so a batched
  redeem could silently clobber a concurrent invoice-number write.
- **D-06 — Middleware-side idempotency alone does NOT close this.** `lib/money-path.js` already has
  `acquireIdempotencyLock` / `assertTxnNotReplayed` / `markTxnUsed`, but if Apps Script dies after
  debiting, the middleware sees an error, never marks the txn used, and a retry debits again. Do
  not substitute middleware guards for the durable claim. (Middleware guards may still be used as
  defence in depth.)
- **D-07 — `reloadGiftCard` has the identical defect and is IN SCOPE.** It is the H7 duplicate-credit
  case named in criterion 1. Fixing only redeem leaves half the bug live.
- **D-08 — `needs_manual_review` must be DURABLE (criterion 2).** Today it exists only as a
  middleware response flag and a cached Redis sentinel (`pos-gift-card.test.js`, `pos-money.test.js`,
  reconcile) — it is never persisted on the gift-card record. The ledger row is the natural home.
  A regression test must assert the persisted flag, not a log line.

### Deployment and verification model

- **D-09 — Manual owner redeploy, no staging gate.** `apps-script/adminApi.gs` executes in Google's
  environment. ONE Apps Script deployment and ONE Google Sheet serve BOTH staging and production.
  Batch every `.gs` edit before a single redeploy, record the current deployment version as the
  rollback target BEFORE deploying, and verify by live probe rather than test-suite proof. Reuse
  the Phase 79-04 / Phase 76-01 checkpoint pattern.
- **D-10 — Create the ledger sheet programmatically, not by hand.** An `getSheetByName() ||
  insertSheet()` + header-write path is safer than asking the owner to hand-create a sheet with
  exact headers. Must be idempotent on repeat runs.
- **D-11 — Money-path probes must prove the DANGEROUS direction.** A live probe must demonstrate
  that a replayed `transaction_ref` does NOT change the balance a second time. Use a low-value
  test certificate; do not probe against a real customer's card.

### Claude's Discretion

- Whether to retire the `last_tx_ref` column, keep writing it as a human-readable mirror, or leave
  it untouched. The guard MUST read the ledger either way.
- The exact ledger column set. `.planning/notes/sheets-to-postgres-data-conversion.md` §3.1 carries
  the target Postgres shape (`cert_number`, `tx_ref`, `kind`, `amount`, `balance_after`,
  `created_at`) — mirroring it keeps this work aligned with any future migration rather than
  throwaway, and it needs a status/needs_review field for D-08.
- Whether `voidGiftCard` (`:4314`, three `setValue` calls, status-only, no money movement) is worth
  including. It is a lower-severity non-atomicity — include only if it falls out of the same change.
- Whether to bring `updateGiftCardInvoice` under the lock as part of this phase or leave decision
  44-02 standing. Note the research doc's Stage 0 recommends closing it.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The defect
- `.planning/ROADMAP.md` — Phase 51 section, including the "ROOT CAUSE LOCATED" block added 2026-09-02
- `apps-script/adminApi.gs` — `redeemGiftCard` (:4204), `reloadGiftCard` (:4264), `voidGiftCard`
  (:4314), `updateGiftCardInvoice` (:4358), `issueGiftCard` (:4121), `lookupGiftCard` (:4172),
  gift-card action dispatch (:299-311), `acquireScriptLock` (:1235), `findRowById` (:1369)

### Prior art to follow
- `.planning/phases/79-apps-script-recipe-save-performance-updaterecipe-times-out-a/79-04-PLAN.md`
  — the Apps-Script owner-redeploy checkpoint + live-probe pattern, just exercised successfully
- `.planning/phases/79-.../79-03-PLAN.md` — batched-write and grid-growth patterns in the same file
- `zoho-middleware/lib/money-path.js` — existing idempotency primitives (defence in depth only, per D-06)
- `zoho-middleware/routes/gift-cards.js` and the `pos.js` gift-card call sites

### Related analysis
- `.planning/research/sheets-to-postgres-migration.md` §3 — independently reached the same ledger
  conclusion; §Stage 0 recommends bringing `updateGiftCardInvoice` under the lock
- `.planning/notes/sheets-to-postgres-data-conversion.md` §3.1 — target ledger shape and DDL

### Project rules
- `CLAUDE.md` — regression test FIRST on bug fixes (rule 3), one logical change per commit (rule 4),
  grep all usages before modifying (rule 6), Apps Script needs manual redeploy, do NOT modify
  existing tests (rule 10)

</canonical_refs>

<specifics>
## Specific Ideas

**Current GiftCards sheet (10 columns, `adminApi.gs:4144-4156`):**
```
cert_number | face_value | current_balance | status | issued_date
  | issued_by | zoho_invoice_number | notes | last_updated | last_tx_ref
```
Status values are `active` | `depleted` | `void` (confirmed at `:4352` — it is `void`, not `voided`).

**The failure sequence to close:**
1. `redeemGiftCard` acquires the lock, reads the row, checks `gc.last_tx_ref !== txRef` → proceeds
2. writes `current_balance` — **money has now moved**
3. script dies (timeout, quota, deploy, transient Google error)
4. `last_tx_ref` still holds the *previous* ref
5. client retries with the same `transaction_ref`
6. guard passes again → **balance decremented twice for one sale**

**Existing money-path decisions that must not be broken:**
- `[44-05]` reload increments the balance FIRST, before the Zoho invoice/payment, deliberately to
  protect customer value; Zoho failure logs CRITICAL + `needs_manual_review` with no auto-reversal.
- `[44-02]` `updateGiftCardInvoice` has no LockService — recorded as safe because an invoice-number
  overwrite is idempotent.
- `[54-01]` `D-54-GC` put `/api/kiosk/gift-card/void` in the kiosk device-token scope, consciously
  superseding D-46-02. Do not narrow it.

</specifics>

<deferred>
## Deferred Ideas

- **M9 — formula-injection sanitization** (`=+-@` leading characters in user-supplied cell values,
  e.g. a void reason containing `=IMPORTRANGE(...)`). Real, but not the live money defect. Follow-up phase.
- **M18 — `issueGiftCard` header-mapped `appendRow` + bounded numeric fields.** Follow-up phase.
- **M15 — negative-taxable custom-line tax parity.** Moved out of Phase 51 entirely (D-03); belongs
  with the kiosk/tax work, not the gift-card ledger.
- **Postgres migration.** The research recommends GiftCards as the one table worth migrating, but
  **this phase is not gated on it** — fix the atomicity on Sheets now. Mirroring the ledger's column
  shape keeps the later migration cheap.

</deferred>

---

*Phase: 51-gift-card-ledger-integrity*
*Context gathered: 2026-09-02 from the located root cause + owner decisions*
