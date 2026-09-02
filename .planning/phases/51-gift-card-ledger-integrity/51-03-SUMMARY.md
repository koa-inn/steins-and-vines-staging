---
phase: 51-gift-card-ledger-integrity
plan: 03
subsystem: apps-script-gift-card-money-path
tags: [gift-card, idempotency, apps-script, ledger, D-09, D-11, D-12, money-path, live-verify]

# Dependency graph
requires:
  - phase: 51-02
    provides: redeemGiftCard / reloadGiftCard rewritten to claim-before-mutate, ledger-guarded
provides:
  - Live-verified, deployed claim-before-mutate gift-card ledger (Apps Script Version 51, ACTIVE)
  - docs/APPS_SCRIPT.md stuck-claim runbook, exercised for real by Probe D
  - Proof (not assertion) that D-12's crash-then-retry defect is closed on the live system
affects: [gift-card-redeem, gift-card-reload, kiosk-pos, brewpad-gift-cards, admin-gift-card-mgmt]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Claim-before-mutate proven live: appendGiftCardClaim -> balance setValue -> settleGiftCardClaim, confirmed by measured byte offsets on both handlers, not just code review"
    - "Fail-closed unsettled-claim guard, cleared by a single documented cell edit (status -> resolved) with no redeploy"

key-files:
  created: []
  modified:
    - docs/APPS_SCRIPT.md

key-decisions:
  - "Task 2's pre-flight was executed as read-only with no commit by design (frontmatter files_modified lists only docs/APPS_SCRIPT.md); this SUMMARY's Task 2 grep/byte-offset values were independently re-derived read-only against the current committed adminApi.gs by this continuation agent, since Task 2 itself produced no artifact to source them from"
  - "ensureGiftCardLedgerSheet( appears 5 times, not the 3-or-4 the plan anticipated (1 definition + redeemGiftCard + reloadGiftCard + setupGiftCardLedger wrapper + one further internal call site); reconciled against the code rather than forced to the plan's guess, per the plan's own instruction"

requirements-completed: [MONEY-03]

# Metrics
duration: "~35 min (Tasks 1+2) + owner redeploy/probe window (2026-09-02 11:35-19:58) + this continuation"
completed: 2026-09-02
---

# Phase 51 Plan 03: Gift-Card Ledger Runbook + Live Deploy & Probe Summary

Deployed the claim-before-mutate gift-card ledger to the live Apps Script project as Version 51 and proved behaviourally, against real Google Sheets round-trips, that both dangerous replay directions (same-ref and crash-then-retry-with-a-fresh-ref) are refused while a normal redeem, reload, and staff-driven stuck-claim recovery all still work.

## Performance

- **Duration:** Tasks 1-2 ~35 min (2026-09-02); owner redeploy + live probes 2026-09-02 11:55-19:58 (Task 3, blocking-human checkpoint); this continuation agent's write-up ~15 min
- **Started:** 2026-09-02T11:35:39Z (Task 1 commit)
- **Completed:** 2026-09-02T20:01:55Z (this SUMMARY)
- **Tasks:** 3 (Task 1 auto, Task 2 auto/read-only, Task 3 checkpoint:human-verify — RESOLVED)
- **Files modified:** 1 (`docs/APPS_SCRIPT.md`, Task 1 only — Task 3 shipped no code, only a live redeploy of already-committed `apps-script/adminApi.gs`)

## Accomplishments

- Apps Script Version 51 ("Phase 51 gift-card ledger: claim-before-mutate (MONEY-03)") is the ACTIVE deployment, serving kiosk, admin, and BrewPad. Rollback target recorded: Version 50 (Sep 2, 2026, 7:58 AM).
- Live proof, not code-review inference, that the D-12 crash-then-retry defect this phase exists to close is now refused on the real system (Probe C).
- Live proof that the pre-existing same-ref replay guard still holds after the rewrite (Probe B) and that reload's first-ever idempotency guard holds too (Probe E, closes H7).
- The stuck-claim recovery procedure documented in Task 1 was exercised for real against a genuinely stuck claim (Probe C's aftermath) and worked exactly as documented (Probe D) — no card is left permanently bricked by the fail-closed design.
- Two operational findings surfaced during live probing that were not anticipated by the plan (see below) — both scoped to how the *owner's terminal* talks to Apps Script, not to the ledger logic itself.

## Task Commits

1. **Task 1: Runbook — stuck-claim remedy in docs/APPS_SCRIPT.md** - `36177ea9` (docs)
2. **Task 2: Pre-flight read-only gate** - no commit by design (frontmatter `files_modified` lists only `docs/APPS_SCRIPT.md`; Task 2 touched nothing)
3. **Task 3: Owner redeploy + live probes** - no repo commit (Apps Script deploy is out-of-repo; `apps-script/adminApi.gs` was already committed at `dbdfc09a` by 51-02)

**Plan metadata:** this commit (docs: complete plan)

## Task 1 — Runbook (docs/APPS_SCRIPT.md)

Commit `36177ea9` added the "Gift-Card Ledger (GiftCardTransactions)" section: what the ledger is and why (H6/H7, MONEY-03), the 12-column table, first-time `setupGiftCardLedger` setup, the stuck-claim playbook (`balance_before` vs `current_balance` comparison, both branches, single-cell `resolved` fix), what `needs_manual_review` means, and where the error strings surface in `zoho-middleware/routes/pos.js`. `git diff --name-only HEAD~1..HEAD` for that commit lists exactly `docs/APPS_SCRIPT.md`.

## Task 2 — Pre-flight gate (read-only, no commit)

Re-derived read-only against the current committed `apps-script/adminApi.gs` (this task produced no artifact of its own to source these values from, since it was a no-commit gate):

**A. Additions present:**
| Check | Expected | Actual |
|---|---|---|
| 9 named function definitions (`normalizeCertNumber`, `roundGiftCardAmount`, `ledgerFlagTrue`, `giftCardLedgerDecision`, `ensureGiftCardLedgerSheet`, `appendGiftCardClaim`, `settleGiftCardClaim`, `flagGiftCardClaim`, `setupGiftCardLedger`) | 9 | 9 |
| `giftCardLedgerDecision(` call count | 3 | 3 |
| `appendGiftCardClaim(` call count | 3 | 3 |
| `settleGiftCardClaim(` call count | 3 | 3 |
| `ensureGiftCardLedgerSheet(` call count | ~3-4 (plan: "reconcile against the code") | 5 (1 definition + redeem + reload + `setupGiftCardLedger` wrapper + one further internal call site) |
| `GIFT_CARD_TRANSACTIONS_SHEET_NAME` occurrences | at least 5 | 8 |
| `String(gc.last_tx_ref)` occurrences | 0 | 0 |
| `Utilities.getUuid(` occurrences | at least 1 | 4 |

**B. Scoped to the two handlers** (line ranges: `redeemGiftCard` 4496-4627, `reloadGiftCard` 4628-4737):

| Check | redeemGiftCard | reloadGiftCard |
|---|---|---|
| `.setValues(` count | 0 | 0 |
| `.setValue(` count | 4 | 4 |
| `acquireScriptLock(15000)` / `lock.releaseLock()` | once each (L4505 / L4601) | once each (L4637 / L4728) |
| `appendGiftCardClaim(` byte/line offset | L4555 | L4683 |
| balance `getRange(result.row, balCol).setValue(` offset | L4573 | L4700 |
| `settleGiftCardClaim(` offset | L4588 | L4715 |
| Ordering `appendGiftCardClaim < balance setValue < settleGiftCardClaim` | **CONFIRMED** (4555 < 4573 < 4588) | **CONFIRMED** (4683 < 4700 < 4715) |
| `'unsettled_claim'` / `'ledger_unavailable'` literals present | yes (L4534, L4515) | yes (L4666, L4647) |

This is the claim-before-mutate ordering proof at the source level — the single most important pre-flight value, and it matches what Probe C then proved live.

**C. Nothing forbidden touched:**
- `git diff --name-only 7d21473d^..HEAD` (7d21473d = 51-01's first commit) lists: `apps-script/adminApi.gs`, `docs/APPS_SCRIPT.md`, `tests/frontend/adminapi-giftcard-ledger.test.js`, plus `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/phases/51-gift-card-ledger-integrity/51-01-SUMMARY.md`, `.planning/phases/51-gift-card-ledger-integrity/51-02-SUMMARY.md` (expected execute-plan workflow artifacts). **No file under `zoho-middleware/` or `js/`, no `package.json`, no lockfile.**
- `voidGiftCard` (L4738-4781): 3 `.setValue(` calls, no `appendGiftCardClaim`/`settleGiftCardClaim`/`GiftCardTransactions` reference — unchanged, no ledger call, consistent with the plan (it does retain its own pre-existing `acquireScriptLock` call, unrelated to this phase).
- `updateGiftCardInvoice` (L4782-4807): zero `acquireScriptLock(` occurrences — confirmed unchanged, decision 44-02 (left outside the lock) stands.
- `acquireScriptLock(` total in file: 13. `generateNextId(` total in file: 13. (Recorded as the current values; the 51-01 SUMMARY does not itself state a numeric pre-phase baseline for either, so these are reported as the post-phase state for the record rather than compared against an unstated target.)

**D. Gates green (re-verified by this continuation agent, since Task 3 shipped no repo code change and no gate could have moved):**
- `npm test`: **94 suites / 1393 tests passed**
- `cd zoho-middleware && npm test`: **102 suites / 1527 tests passed**
- `npm run lint`: clean, 0 warnings
- `git status --porcelain` at gate-check time: clean except one pre-existing, unrelated working-tree edit to `links.html` (adds `data-track` attributes to link buttons) — **not part of this plan, not touched, not committed by this agent.**

## Task 3 — Owner redeploy + live probes (RESOLVED)

### Deployment

- Project: Apps Script "SV Website" (script id `1uD14PTT2lMWV06FAKcEs6Z_YKsEvnUuk9fOFycu7emiOPyh9jC0KTvUH`); Sheet: "STEINS AND VINES" (id `10BzcANc_-dyS-Is_C4He7mMYHfJ2OSJS9V4p7D-1JrM`).
- **Rollback target:** Version 50, Sep 2, 2026, 7:58 AM.
- **Deployed:** Version 51, Sep 2, 2026, 11:55 AM, description "Phase 51 gift-card ledger: claim-before-mutate (MONEY-03)".
- Deployment ID unchanged (same web-app URL, no config/env change needed). "Execute as: Me" and "Who has access: Anyone" both verified unchanged after deploy.
- Deployment URL and `SERVER_WRITE_TOKEN` deliberately not recorded here (T-51-03-01 mitigation).

### Pre-deploy verification (evidence the deploy was safe, not just declared safe)

- Live Version 50 `adminApi.gs` extracted and diffed against repo commit `dbdfc09a`: **byte-identical**, 4404 lines, zero diff — confirms no undocumented hand-edits existed in Google before this deploy.
- After paste, the saved editor content re-extracted and diffed against repo HEAD: **byte-identical**, 4828 lines.
- v50 -> v51 diff: +439 / -15 lines; 9 new functions added; no existing function signature removed; nothing outside the gift-card path changed.
- `setupGiftCardLedger` run 1: "Created GiftCardTransactions tab with 12 columns."
- `setupGiftCardLedger` run 2: "GiftCardTransactions tab ready (12 columns)." only — no second "Created" message. **D-10 idempotency confirmed live, not assumed.**
- `GiftCardTransactions` headers verified in the sheet, columns A-L, bold + frozen, exact order: `tx_id | cert_number | tx_ref | kind | amount | balance_before | balance_after | status | needs_manual_review | created_at | settled_at | notes`.
- Test certificate `TEST-LEDGER-01` created: `face_value` 5, `current_balance` 5, `status` active, `issued_by` phase-51-probe.
- **Blast-radius correction:** the `GiftCards` tab held NO live customer certificates at deploy time — only `GC-000001`, status void, balance 0, notes "Test". Actual blast radius was materially lower than the plan's worst-case framing assumed.

### Probe results (all against live Version 51)

| Probe | tx_ref | Response | Balance | Ledger effect |
|---|---|---|---|---|
| A — redeem 1 | PROBE-51-A | `ok:true`, `new_balance:4` | 5 -> 4 | row2 settled; `balance_before` 5 / `balance_after` 4; `needs_manual_review` FALSE; `settled_at` 2026-09-02T19:08:22.186Z; `tx_id` `0469a352-2e63-4133-9067-5731a1a509a9` |
| B — replay same ref | PROBE-51-A | `ok:true`, `idempotent:true`, `new_balance:4` | stayed 4 | no new row; `settled_at` unchanged (no re-settle) |
| C — fresh ref against a manually re-`claimed` row | PROBE-51-C | `ok:false`, `error:"unsettled_claim"`, `needs_manual_review:true`, `claim_tx_id` `0469a352-...`, `claim_tx_ref` PROBE-51-A, `claim_created_at` 2026-09-02T19:08:20.040Z | stayed 4 | no new row; row2 `needs_manual_review` flipped FALSE -> TRUE **in the cell**; row2 `notes` = "Blocked duplicate redeem attempt: incoming tx_ref=PROBE-51-C, amount=1" |
| D — after staff set `status` -> `resolved` | PROBE-51-D | `ok:true`, `new_balance:3`, `tx_id` `43be2c21-2858-4ce0-b5f2-91a838e3fa41` | 4 -> 3 | row3 settled; `balance_before` 4 / `balance_after` 3; `settled_at` 2026-09-02T19:54:20.060Z |
| D' — the now-consumed ref PROBE-51-A replayed after clearing | PROBE-51-A | `ok:true`, `idempotent:true`, `new_balance:3` | stayed 3 | no new row — clearing the card-level claim did **not** re-open the already-consumed `tx_ref` (intentional per 51-01's non-forgiving replay-protection decision) |
| E — reload 2 | PROBE-51-E | `ok:true`, `new_balance:5`, `tx_id` `8b19d10e-ab2d-42ee-a309-ae5f628ac459` | 3 -> 5 | row4 `kind`=reload settled; `balance_before` 3 / `balance_after` 5; `settled_at` 2026-09-02T19:58:10.128Z |
| E' — reload replay same ref | PROBE-51-E | `ok:true`, `idempotent:true`, `new_balance:5` | stayed 5, **not 7** | no new row |

Final ledger state: 4 rows, balances chaining 5 -> 4 -> 3 -> 5, every real movement recorded. Apps Script Executions view: all Version 51 executions "Completed", no failures, including live non-probe traffic that hit the endpoint after cutover.

### Must-have mapping

| Criterion | Result |
|---|---|
| Criterion 6 — same-ref replay refused | **PASS** (Probe B) |
| Criterion 7 / D-12 — crash-then-retry with a DIFFERENT ref refused | **PASS** (Probe C) — the defect this phase exists to close |
| Criterion 2 / D-08 — `needs_manual_review` durable in a cell, not only a log line | **PASS** (Probe C, observed directly in the sheet) |
| Stuck claim clearable by one cell edit, no redeploy, card returns to service | **PASS** (Probe D) |
| H7 — duplicate reload credit refused | **PASS** (Probe E') |
| D-10 — `setupGiftCardLedger` idempotent | **PASS** (pre-deploy verification, second run) |

### Operational findings (not code defects — process/tooling findings from live probing)

1. **A POST to the `/exec` endpoint that returns a non-JSON HTML error page may already have performed the mutation.** Observed directly: a curl invocation combining `-X POST` with `-L` forced POST through Apps Script's 302 redirect, landing on a Google Drive HTML error page — but the redeem had already executed and the ledger row was written before the response the caller saw failed to parse. Anything that treats a non-JSON response as "it did not happen" and retries is manufacturing exactly the crash-then-retry case D-12 describes. **The production middleware is not affected** — its `axios` call uses `maxRedirects:5` and follows the 302 correctly. Correct manual curl form: omit `-X POST` and let the 302 downgrade to GET, per Apps Script's own redirect contract.
2. **The Google Sheets browser view can serve a stale render even after a page reload** — a freshly written row was briefly invisible. Verify ledger state by jumping to the last populated row (Cmd+Down), not by eyeballing the top of the sheet.

### Outstanding / not done (recorded honestly, not glossed)

- **Task 3 Step 8 regression sweep was NOT performed:** a real kiosk sale paid with a real gift certificate, the kiosk Gift Cards lookup panel, void from the kiosk panel, and issuing a certificate through the cart (`updateGiftCardInvoice` / `zoho_invoice_number` check) are all unverified on live Version 51.
  - Note: the "real kiosk sale with a real gift certificate" item currently has no real subject to test against — the `GiftCards` tab holds no live customer certificates (see blast-radius correction above).
- `TEST-LEDGER-01` (current balance 5) and its 4 probe ledger rows remain in the `GiftCardTransactions` / `GiftCards` sheets, **not yet cleaned up.**

### Declined-scope follow-ups (from 51-CONTEXT.md, not part of this phase, tracked for future phases)

- **M9** — formula-injection sanitization (`=+-@` leading characters in user-supplied cell values). Deferred, D-01.
- **M18** — `issueGiftCard` header-mapped `appendRow` + bounded numeric fields. Deferred, D-01.
- **M15** — negative-taxable custom-line tax parity. Moved out of Phase 51 entirely (D-03); rehome before formally closing MONEY-03.
- `voidGiftCard` writes no ledger row (unmodified by design, confirmed in Task 2 check C).
- `updateGiftCardInvoice` remains outside `acquireScriptLock` — decision 44-02 deliberately left standing (51-02).

## Files Created/Modified

- `docs/APPS_SCRIPT.md` — Gift-Card Ledger runbook: schema, setup, stuck-claim playbook (Task 1, `36177ea9`)
- `apps-script/adminApi.gs` — no change in this plan; already committed by 51-02 (`dbdfc09a`), made live by this plan's Task 3 redeploy

## Decisions Made

- Task 2's grep/byte-offset/gate values were re-derived read-only by this continuation agent against the currently-committed `apps-script/adminApi.gs`, because Task 2 was a no-commit gate and produced no persisted artifact of its own values. This is a documentation/inspection action (not a re-run of any live probe or any Task-1/Task-2 decision) and changed nothing in the working tree.
- `ensureGiftCardLedgerSheet(` appears 5 times rather than the plan's anticipated 3-4 — reconciled against the actual code per the plan's own instruction ("record the actual number and reconcile it against the code rather than forcing it to a target") rather than treated as a discrepancy.

## Deviations from Plan

None — plan executed exactly as written across all three tasks. The two operational findings above are new information surfaced by live probing, not deviations from planned behavior; no code, test, or plan file was altered as a result of them.

## Issues Encountered

None blocking. The two operational findings (non-JSON redirect response semantics; stale Sheets browser render) are documented above as evidence for future incident response, not as problems requiring resolution in this plan.

## User Setup Required

None further — the owner's manual Apps Script redeploy (the one manual step this phase always required, D-09) is complete and verified. `TEST-LEDGER-01` and its probe rows are still in the live sheet and should be cleaned up or clearly annotated as test data by the owner at their convenience (non-blocking).

## Next Phase Readiness

- MONEY-03's core defect (crash-then-retry double-debit/double-credit) is closed and live-verified in production's shared Apps Script deployment.
- Before formally closing out gift-card money-path work: (1) run the Step 8 regression sweep against a real kiosk sale once a live customer certificate exists (or accept the risk and document why not), (2) clean up `TEST-LEDGER-01` and its probe rows, (3) rehome M15 tax parity, M9 formula-injection sanitization, and M18 `issueGiftCard` bounds-checking into a follow-up phase per D-01/D-03.
- No blockers for other in-flight work; this phase touched only the gift-card path in `apps-script/adminApi.gs` and `docs/APPS_SCRIPT.md`.

---

## Self-Check

- `docs/APPS_SCRIPT.md` contains `GiftCardTransactions` section: FOUND (grep confirms, see Task 1 above)
- Commit `36177ea9`: FOUND in `git log --oneline --all`
- Commit `dbdfc09a` (51-02, prerequisite for the live deploy): FOUND in `git log --oneline --all`
- `apps-script/adminApi.gs` handler byte offsets (append < setValue < settle) for both `redeemGiftCard` and `reloadGiftCard`: FOUND and CONFIRMED by direct `grep -n` against the current file (see Task 2 table above)
- `npm test`, `cd zoho-middleware && npm test`, `npm run lint`: all re-run and confirmed green at SUMMARY-write time

## Self-Check: PASSED

---
*Phase: 51-gift-card-ledger-integrity*
*Completed: 2026-09-02*
