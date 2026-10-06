# Phase 84 — GiftCards Dual-Window Log

Owner-maintained log for the `GIFT_CARDS_STORE=dual` window (D-01/D-02/D-03). See
`docs/RUNBOOK.md` § "Gift cards → Postgres (Phase 84)" for the full procedure this log
supports. No balances, no customer names — cert numbers and classifications only.

## Header

| Field | Value |
|-------|-------|
| Environment | production |
| `GIFT_CARDS_STORE=dual` set at | 2026-10-06 22:56:50Z (variable set); live 23:00:40Z (deploy `d85b5fca`, startup `store modes: {"GIFT_CARDS_STORE":"dual"}`) |
| Window day 1 date | 2026-10-06 |
| Current window start (resets to day 1 on any bug-classified discrepancy) | 2026-10-06 |

## Op-coverage table

One row per op. "First seen at" is the first time this op ran (real traffic or the §5
scripted $1 test-card runsheet) during the CURRENT window (resets alongside "Current window
start" above). "Sentry clean?" is yes only if zero unexplained discrepancies were raised for
that op during the current window.

| Op | First seen at | Real or scripted | Sentry clean? |
|----|----------------|-------------------|----------------|
| issue | | | |
| redeem | | | |
| reload | | | |
| lookup | | | |
| void | | | |
| adjust | | | |

## Discrepancy table

One row per Sentry `dual-write giftcards.<op> discrepancy` event or manually-found mismatch.
Every row must be classified before the flip bar can be considered met.

| Date/time | Sentry event link | Op | Cert | Classification (explained/bug) | Root cause | Fix commit | Window restarted? |
|-----------|--------------------|----|------|----------------------------------|-------------|-------------|--------------------|
| | | | | | | | |

## Flip-decision block

Filled in once the §4/§6 flip bar (≥7 consecutive days, all six ops observed, zero
unexplained discrepancies) is met and the owner decides to flip to `postgres`.

| Field | Value |
|-------|-------|
| Owner | |
| Date | |
| Decision | |

---
*Phase: 84-giftcards-postgres*
*Template created: 2026-10-03 (Plan 84-09)*

## Staging rehearsal

| Step | Date | Outcome |
|------|------|---------|
| 1. Staging push | 2026-10-03 | Owner-approved `git push origin main` → `4e8432df`. Railway staging deploy `15ed5589` SUCCESS; pre-deploy log shows `0002_gift_cards` applied ("Migrations complete!") — `npm run migrate` chains migration-guard → migration-allowlist → node-pg-migrate with `&&`, so both guards passed (closes Phase 83's "first observed guard-chain log" item). `/health`: status ok, database:true, database_required:false (store mode `sheets`, expected before step 4). Startup log: `store modes: {"GIFT_CARDS_STORE":"sheets"}`, gift-card pending sweep registered. CI: test-frontend, test-middleware, artifact-drift pass; test-e2e fails (pre-existing since ≥2026-09-23, not part of the gated deploy). |
| 2. Apps Script redeploy | 2026-10-03 | Owner pasted `apps-script/adminApi.gs` @ `2881c74c` into the live project ("SV Website", the Sep-24 project `1uD14PTT…`; the Oct-1 same-named project has no deployment). Pre-paste editor copy was byte-identical to the repo's pre-84-02 file (sha256 `dd32ba55…`); post-paste matches HEAD (`344966b3…`). Deployment `AKfycb…DI968g` (shared by staging + production middleware) updated **58 → 59** at 14:08. Rollback = 58. Production `/health` ok after deploy. Probes (owner, 14:37): `setupGiftCardLedger` → "GiftCardTransactions tab ready (12 columns)." with no error; production kiosk lookup of the sheet's only card returned the correct data (sheets mode, v59). |
| 3. Staging backfill (dry-run → promote) | 2026-10-03 | Snapshot: workbook "STEINS AND VINES" (`10BzcANc…`, bound to the live `1uD14PTT…` project) exported 14:11, kept outside the repo in `~/sv-backfill/`. Over the Railway SSH tunnel: dry-run → 0 rejects; read 1 card / 0 ledger rows; 0 TEST-* excluded; total balance $0.00; seq seed 1; unmapped headers `issued_date`, `last_tx_ref` (not needed). The live sheet genuinely holds a single `void` $0 card and an empty `GiftCardTransactions` tab. Owner approved promote → "Promoted 1 cards, 1 ledger rows; sequence at 1" (in-transaction invariants passed). |
| 4. GIFT_CARDS_STORE=dual on staging | 2026-10-03 | Set via Railway CLI (staging `sv_middleware` only). After redeploy `/health`: status ok, database:true, database_required:true. Production unchanged (no GIFT_CARDS_STORE → sheets). |
| 5. gift-cards-verify (0 mismatches) | 2026-10-03 | Fresh export 14:20 → `gift-cards-verify.js`: "Verified 1 cards: 0 mismatches". Tunnel closed afterwards. Note: the staging Postgres password was printed once in the session transcript during tunnel setup — rotate it after the rehearsal. |
| 6. iPad Safari UAT (84-10 Task 3) | 2026-10-03 run, 2026-10-06 closed | **Owner-approved with gaps** — partial run on the kiosk iPad (`kiosk-raku6d`) 15:57–16:02 PDT 10-03; owner elected on 2026-10-06 to skip the remaining steps. Per-step record below, reconstructed from the staging Postgres ledger and the complete staging deploy log for the window (`c5ca0e16`, 73 lines 21:30–23:05Z). |
| 7. Staging restored to dual | 2026-10-06 | The step-9 toggle had left staging in `sheets` since 10-03 16:02 PDT (deploy `7f6abd42`); no gift-card traffic reached it in that mode (log-checked 10-03 23:03Z → 10-06). Reset to `GIFT_CARDS_STORE=dual` via Railway CLI (staging `sv_middleware` only). Production still has no `GIFT_CARDS_STORE` (→ `sheets`). |

### iPad UAT — per-step record

Evidence key: **server** = staging ledger row and/or deploy-log line; **client-side** = the kiosk refuses this before any request, so no server trace can exist either way.

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Look up a backfilled active card; Adjust visible | **Not runnable on staging** | The only backfilled card (GC-000001) is void. Real test happens at 84-11 against the production sheet backfill. A lookup at 22:57:55Z (status 200) is consistent with GC-000001. |
| 2 | Add credit $0.25, Goodwill | **PASS** | server: GC-000002 `adjust +0.25 goodwill`, 1.00→1.25, actor "Koa", device `kiosk-raku6d`, 22:59:27Z. |
| 3 | Remove more than the balance → refused | Owner-attested / not evidenced | client-side ("Cannot go below $0.00" preview). No remove request ever reached the server. |
| 4 | Other needs a note; then remove $0.25 as Correction | **NOT RUN** (owner skipped) | No `other` adjustment and no removal in the ledger. An unscripted `+5.00 goodwill` (no note) ran at 23:01:31Z instead. Note-required rule is unit-tested (84-06/84-07). |
| 5 | Double-tap Apply → one change | Owner-attested / not evidenced | Each adjust appears exactly once (consistent with a pass, not proof). Idempotency is covered by the `adjust_key`/`tx_ref UNIQUE` tests. |
| 6 | Voided card → no Adjust button | Owner-attested / not evidenced | UI-only. |
| 7 | Sell a $1 cert **and** pay part of the sale with an existing card | **HALF RUN** | server: cash sale issued GC-000002 $1, invoice **INV-000228** (live Zoho org — staging and production share org `110002406307`), no activation warning. The redeem half (Pitfall 1 live check) **never ran** — zero `redeem` rows. Covered by 84-08 regressions; first real redeem will be observed in the 84-12 dual window (flip bar requires all six ops). |
| 8 | Void the new cert with a reason | **PASS** | server: GC-000002 void, reason "Test", 23:02:01Z. |
| 9 | `GIFT_CARDS_STORE=sheets` → note + no Adjust; then back to dual | **HALF RUN** | Switched to sheets 23:02:04Z (deploy `7f6abd42`) but no lookup followed and it was never switched back (restored 2026-10-06, row 7 above). |

**Carried to 84-11 (owner decisions):**
- Sale-path attribution: the `issue` row for GC-000002 has `actor_name`/`device_label` null while adjustments carry both (84-07 D-05 assumption — needs owner sign-off).
- GC-000002 shows `current_balance 6.25` with `status void` — confirm a void keeping its balance is intended.
- Live-books cleanup: INV-000228 ($1 gift cert, cash) is a test invoice in the real Zoho org.
- Cash-sale confirm logs `txnId="manual-confirm"` — same literal as `HANDOFF-kiosk-manual-confirm-void-txnid.md`.

**Owner decision (2026-10-06):** "can we just skip the remaining tests?" — approved to proceed to 84-11 with steps 4, 7 (redeem half) and 9 unverified live.

## Production prerequisites (84-11 Task 1)

| Item | Date | Outcome |
|------|------|---------|
| Owner decisions | 2026-10-06 | (1) D-05 sale-path attribution — **not needed at this time**. (2) Void keeps `current_balance` — **accepted**; checked: the sheet's `voidGiftCard` also leaves the balance untouched (no dual/verify mismatch), void cards reject redeem/reload, nothing sums balances (a future liability report must exclude `void`). (3) Production push must not change customer-facing pages and the beer page must stay hidden — checked: since production's last deploy (`d47dab85`) the public pages differ only in `?v=` cache stamps; no CSS / `main.js` / module / content changes; `BEER_PAGE_LIVE=false`. |
| Backups | 2026-10-02 | Nightly encrypted `pg_dump` to R2 live in production; restore drill passed (`a41ef8a9`, D-16). |
| Gated deploy, attempt 1 | 2026-10-06 | Run 37505099171 **blocked at the middleware `npm audit` step** — new critical advisory GHSA-jqcg-44mw-7w3h in `proxy-addr` 2.0.7 (express transitive). Nothing pushed. Exposure likely nil (`trust proxy: 1`, hop-count). Fixed by lockfile-only bump to 2.0.8 (`af261d83`), staging-verified (deploy `a659fb64`, healthy, dual). |
| Gated deploy, attempt 2 | 2026-10-06 17:47Z | Run 37506054882 green (both test suites incl. Testcontainers, lint, audit). Production repo `b0149bd1` → `6c6fc9f9` (= `af261d83` + CNAME). Railway deploy `8db27979` SUCCESS (previous `f104c500` = rollback target). |
| Guard chain + migration | 2026-10-06 | Production pre-deploy log: `migration-guard: 2 file(s) additive-only OK`, `migration-allowlist: 2 file(s) additive-only OK`, `0002_gift_cards` applied, "Migrations complete!". |
| Post-deploy smoke | 2026-10-06 | `/health`: status ok, authenticated:true, redis:true, database:true, **database_required:false**. Startup: `store modes: {"GIFT_CARDS_STORE":"sheets"}`; Zoho refresh token loaded from Redis and refreshed. Site serves the new build (`main.min.js?v=muwy75vy`); `kiosk-core.min.js` carries the gift-cert digit entry. |
| Beer hold-back | 2026-10-06 | Verified live (browser UA — plain curl gets a Cloudflare 403): `beer.html` `noindex, nofollow`; zero `beer.html` links on index, ferment-in-store hub, products, wine; served `BEER_PAGE_LIVE=!1`. |

## Production cutover (84-11 Task 2)

Store closed, kiosk idle (owner-confirmed). Owner ran the tunnel + CLI steps in their own terminal (password never in the session); Claude set the Railway variable and verified.

| Step | Time (UTC) | Outcome |
|------|------------|---------|
| 1. Snapshot | 2026-10-06 ~22:50 | "STEINS AND VINES" → `~/sv-backfill/prod-before.xlsx` (outside the repo). |
| 2. Tunnel | 2026-10-06 | `railway connect Postgres-EMVk --tunnel-only --environment production`. |
| 3. Dry run | 22:55:13 | Read 1 card / 0 ledger rows; TEST-* excluded 0/0; cards accepted 1 rejected **0**; ledger accepted 0 rejected **0**; total balance $0.00; seq seed 1; unmapped headers `issued_date`, `last_tx_ref` (not needed — same as staging). Note: the CLI needs `--file=PATH` (equals form); RUNBOOK §3 shorthand `--file <snapshot>` errors "unknown flag". |
| 4. Promote | 22:56:15 | "Promoted 1 cards, 1 ledger rows; sequence at 1" (target `railway` on the tunnel; DB-name prompt answered). |
| 5. `GIFT_CARDS_STORE=dual` | 22:56:50 → live 23:00:40 | Railway CLI, production `sv_middleware`. Deploy `d85b5fca` SUCCESS; `/health` database:true, **database_required:true**; Zoho refresh OK. Rollback target: unset/`sheets` (previous deploy `b6f160c1`). |
| 6. Fresh snapshot | ~23:01 | `~/sv-backfill/prod-after.xlsx`. |
| 7. Verify | ~23:03 | `gift-cards-verify.js` → **"Verified 1 cards: 0 mismatches"**. |
| 8. Close-up | — | Tunnel closed, `BACKFILL_DATABASE_URL` unset (owner). |

Window day 1 = 2026-10-06. Next: 84-11 Task 3 opening-day smoke (real active-card lookup on the production kiosk, Adjust visible, no `[dual-write] giftcards` discrepancy in Sentry). Note the live sheet holds a single void $0 card, so the first real `issue` will be the first meaningful dual write.
