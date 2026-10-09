# Phase 87 Security Review (ASVS L1)

Plan: 87-17 | Date: 2026-10-09 | Reviewer: Claude (executor) | Status: AWAITING OWNER SIGN-OFF

## Scope

Public batch token path (`/api/batch/public/*`), admin/ops proxies and the postgres intercept, freeze switch
(BATCHES_FREEZE), idempotent create, Postgres store modules (`lib/batch-pg-*.js`, `lib/batch-store.js`), mirror and
export (Apps Script v62), backfill/parity/verify/replay CLIs, daily drift check. Client files
(`js/brewpad.js`, `js/brewpad.min.js`, `js/admin.js`, `js/batch.js`) are byte-identical to baseline 3010e237.

## Gate results (one tree)

| Gate | Result |
|------|--------|
| root `npm test` | 163 suites, 2268 tests pass |
| root `npm run lint` | clean |
| middleware `npm test` | 198 suites, 3111 tests pass |
| middleware `npm run lint` | clean |
| `npm run migrate:guard` | 5 files additive-only OK (guard + allowlist) |
| `npm run test:db` | 32 suites, 353 tests pass |
| batch-focused jest (9 suites incl. single-issuer) | 126 pass |
| `test:db -- batch-pg` | 7 suites, 157 pass |
| client files vs 3010e237 | identical |
| `npm run build` | works, but stamps js/admin.js, admin.min.js and ~24 HTML files (BUILD_TIMESTAMP / cache-bust). Reverted; not a Phase 87 change |

## Grep gates

1. `export_batch_tabs` and `mirror_batch_*` are absent from routes/pos.js, lib/batch-proxy.js, lib/ops-proxy.js. PASS (present only in apps-script/adminApi.gs server_token branch).
2. `require('pg')` appears only in lib/db.js. PASS.
3. SQL in lib/batch-pg-*.js: no request value concatenated into SQL; the only `+ payload` hits are an error-message string (batch-pg-create.js:114, batch-pg-tasks.js:340). PASS.
4. No log/Sentry line in new files interpolates customer_name, customer_email, customer_phone, access_token or batch_token. PASS.
5. Public routes have no requireTiers wrapper; `batchPublicLimiter` applies (server.js:716, 731). PASS.

## ASVS L1 table

| Area | Control | Evidence | Status |
|------|---------|----------|--------|
| V2 | Token generation 128-bit `crypto.randomBytes(16)` hex; constant-time compare `timingSafeEqual` after format pre-check; old token dead after regenerate, no PG cache | batch-pg-create.js:226, batch-pg-update.js:460, batch-pg-read.js:99, batch-store.js:250, batch-rules.js:552 | Pass |
| V4 | Public field whitelist (stripForList, no access_token in lists); public task ownership (Q8); public packaging block; public reading add/update/delete ownership; only completed/notes accepted from public; admin proxies behind requireTiers; actor from session | batch-pg-tasks.js:226,229,380,428,468; batch-proxy-routes and batch-public-store tests | Pass |
| V5 | Parameterised SQL ($n) and column allow-lists; array caps 50 tasks / 20 readings; batch-id and token regexes; sanitizeInput on text fields; reject-never-coerce in backfill | grep gate 3; batch-pg-tasks.js:290,407; batch-rules.js:563 | Pass |
| V6 | Randomness only from crypto.randomBytes; no custom crypto | grep | Pass |
| V7 | Value-free logs, rejects, CLI output and Sentry (ids/counts/fields only); generic 502 server_error on store failure; no secrets/URLs in argv | grep gate 4; batch-drift.js; routes/pos.js:4313-4316 | Pass |

## Threat verification

Evidence for rows citing earlier plans comes from those plans' SUMMARY files and their tests, re-run in this session
(suites above); it was not independently re-derived line by line. Plans 18-20 are procedural and not yet executed.

| ID | Component | Disposition | Status | Evidence |
|----|-----------|-------------|--------|----------|
| T-87-01-01 | 87-DESIGN.md | mitigate | Verified | 87-DESIGN.md holds ids/counts only (doc review, 87-01 SUMMARY) |
| T-87-01-02 | implementation starts on an unapproved design | mitigate | Verified | 87-01 design gate cleared by owner before 87-02+ (STATE history) |
| T-87-01-03 | guard weakened to admit DDL | mitigate | Verified | migrate:guard green (5 files additive-only); guard scripts untouched |
| T-87-02-01 | destructive DDL in 0005 | mitigate | Verified | migrate:guard + migration-allowlist pass in this run |
| T-87-02-02 | split-brain via BATCHES_STORE=dual | mitigate | Verified | batch-store-flag.test.js: dual refuses boot |
| T-87-02-03 | batches in PG while vessels still sheet-authoritative | mitigate | Verified | batch-store-flag.test.js: postgres refuses boot with OPS_DATA_STORE=sheets |
| T-87-02-04 | freeze auto-expiry silently reopening sheet writes | mitigate | Verified | lib/batch-flag.js plain-text freeze value; batch-store-flag tests |
| T-87-02-05 | orphan child rows | mitigate | Verified | test:db batch-pg suites (FK ON DELETE CASCADE) |
| T-87-03-01 | fixtures | mitigate | Verified | synthetic fixtures; no real emails (87-03 SUMMARY) |
| T-87-03-02 | list responses leak access_token | mitigate | Verified | stripForList golden assertions in batch-store/batch-public-store tests |
| T-87-03-03 | public response fields | accept | Accepted | Q17 parity: public response keeps customer_phone/notes/recipe_snapshot |
| T-87-03-04 | stored XSS via notes/titles | mitigate | Verified | sanitizeInput in batch-pg-create/update/tasks (grep) + parity tests |
| T-87-04-01 | mirror_batch_* callable by a client | mitigate | Verified | apps-script adminApi.gs mirror_batch_* inside server_token branch (lines 369-375) |
| T-87-04-02 | export_batch_tabs returns all customer rows | mitigate | Verified | grep gate: export_batch_tabs / mirror_batch_* absent from routes/pos.js, batch-proxy.js, ops-proxy.js |
| T-87-04-03 | mirror deletes another batch's child rows | mitigate | Verified | 87-04 SUMMARY tests: delete predicate on batch_id equality (Apps Script harness) |
| T-87-04-04 | staff hand-edits silently diverge after cutover | mitigate | Verified | D-12 notice documented in RUNBOOK; daily drift check lib/batch-drift.js registered in server.js |
| T-87-04-05 | concurrent mirror writes corrupt rows | mitigate | Verified | acquireScriptLock with release in finally (87-04 SUMMARY) |
| T-87-05-01 | rejects/summary files and stdout | mitigate | Verified | backfill CLI output ids/fields only; batches-backfill tests |
| T-87-05-02 | promote over existing data | mitigate | Verified | emptiness preconditions on six tables; batches-backfill tests |
| T-87-05-03 | DB URL in shell history | mitigate | Verified | URL in argv refused (batches-backfill.js ~L574); env only |
| T-87-05-04 | coerced bad data accepted silently | mitigate | Verified | reject-never-coerce, exit 2 on rejects; backfill tests |
| T-87-05-05 | SQL injection from cell values | mitigate | Verified | grep gate 3: fixed identifiers, values as $n |
| T-87-06-01 | token comparison timing | mitigate | Verified | crypto.timingSafeEqual lib/batch-pg-read.js:99, batch-store.js:250, batch-rules.js:552; format pre-check |
| T-87-06-02 | list endpoints leaking access_token | mitigate | Verified | stripForList golden; batch-public-store tests |
| T-87-06-03 | SQL injection via ids/filters | mitigate | Verified | grep gate 3; status filter from fixed set |
| T-87-06-04 | enumeration via not_found vs invalid_token | accept | Accepted | Q16 parity not_found vs invalid_token; 128-bit tokens + batchPublicLimiter |
| T-87-07-01 | duplicate batches from retries / parallel hooks | mitigate | Verified | test:db batch-pg-create parallel create + advisory lock tests |
| T-87-07-02 | client-supplied schedule steps | mitigate | Verified | batch-pg-create reads steps in-tx; schedule_steps_json ignored (tests) |
| T-87-07-03 | guessable batch tokens | mitigate | Verified | crypto.randomBytes(16) hex: batch-pg-create.js:226, batch-pg-update.js:460 |
| T-87-07-04 | partial writes (batch without vessel status) | mitigate | Verified | single transaction; rollback test in test:db |
| T-87-07-05 | created_by attribution | mitigate | Verified | actor from session/server only; batch-store tests |
| T-87-07-06 | stored XSS in text fields | mitigate | Verified | sanitizeInput on all text fields (grep) |
| T-87-08-01 | mass assignment (access_token, created_by) | mitigate | Verified | fixed field whitelist; mass-assignment test in batch-pg-update |
| T-87-08-02 | SQL injection in dynamic SET | mitigate | Verified | dynamic SET columns from allow-list; values $n (grep gate 3) |
| T-87-08-03 | lost update between concurrent edits | mitigate | Verified | FOR UPDATE row lock; test:db concurrency |
| T-87-08-04 | deletes invisible to rollback replay | mitigate | Verified | batch_tombstones insert, batch-pg-update.js:41 |
| T-87-08-05 | old token valid after regenerate | mitigate | Verified | no cache in PG; old-token-fails test |
| T-87-09-01 | token for batch A edits a task of batch B | mitigate | Verified | batch-pg-tasks.js:226 task ownership (Q8); regression test |
| T-87-09-02 | public packaging completion | mitigate | Verified | batch-pg-tasks.js:229 packaging blocked for public |
| T-87-09-03 | oversized bulk arrays | mitigate | Verified | caps 50 tasks (L290) / 20 readings (L407) |
| T-87-09-04 | race completing a batch twice | mitigate | Verified | batch row lock; test:db concurrency |
| T-87-09-05 | DB error text in batches_failed | mitigate | Verified | generic error codes in batches_failed |
| T-87-10-01 | staging writing the shared production workbook | mitigate | Verified | ops-mirror.js no-op off production (ops-mirror-batch tests) |
| T-87-10-02 | customer data in Sentry/logs | mitigate | Verified | Sentry tags component/entity/id only; no PII in new files (grep gate 4) |
| T-87-10-03 | stale or out-of-order mirror | mitigate | Verified | read-latest-at-send, per-id serial chain, sweep (ops-mirror-batch tests) |
| T-87-11-01 | writes during the maintenance window | mitigate | Verified | isFrozen on every WRITE op: batch-store.js:108, batch-proxy.js:67, pos.js public/reassign/stamp |
| T-87-11-02 | split brain (sheet fallback on PG error) | mitigate | Verified | no sheet fallback on PG error; 502 server_error (batch-routes-postgres tests) |
| T-87-11-03 | public token reuse after regeneration | mitigate | Verified | token checked in-transaction, no cache |
| T-87-11-04 | public field smuggling (status, vessel) | mitigate | Verified | public task updates pass only completed/notes |
| T-87-11-05 | customer fields in freeze logs | mitigate | Verified | freeze logs invoice number only (batch-store.js:205) |
| T-87-12-01 | proxy auth bypass | mitigate | Verified | intercept inside requireTiers callback after allowlist (batch-proxy-routes tests) |
| T-87-12-02 | actor from request body | mitigate | Verified | actor from req.staffEmail / hardenProxyPayload |
| T-87-12-03 | writes through an unguarded path during the window | mitigate | Verified | freeze on both proxies, public POSTs (pos.js:4307), reassign (3668), stamp (3962) |
| T-87-12-04 | error detail leaks | mitigate | Verified | 502 {error:server_error} without message |
| T-87-12-05 | public write flood | accept | Accepted | batchPublicLimiter unchanged (server.js:716,731) |
| T-87-13-01 | sale batches written to the sheet after the flip | mitigate | Verified | postgres branch first + batch-single-issuer.test.js |
| T-87-13-02 | schedule delete while referenced (unknown count) | mitigate | Verified | ferm-schedule-store.js fail-closed batch_ref_unavailable |
| T-87-13-03 | lost batch for a sale during the window | mitigate | Verified | logged maintenance + retry queue; scan-invoices post-window (D-04) |
| T-87-13-04 | customer data in freeze logs | mitigate | Verified | invoice number only in freeze logs |
| T-87-14-01 | verify/replay output | mitigate | Verified | verify/replay output ids/fields/counts (tests) |
| T-87-14-02 | accidental sheet writes | mitigate | Verified | replay dry-run unless --apply |
| T-87-14-03 | verify mutating the DB | mitigate | Verified | verify in read-only transaction |
| T-87-14-04 | DB URL / token in argv | mitigate | Verified | URLs refused in argv |
| T-87-15-01 | snapshot file committed | mitigate | Verified | assertSnapshotSafePath refuses repo paths (batches-parity.js:279,289) |
| T-87-15-02 | drift details in Sentry/logs | mitigate | Verified | batch-drift.js counts/ids/fields only |
| T-87-15-03 | drift check crashing the server | mitigate | Verified | batch-drift never throws (batch-drift tests); production-only guard |
| T-87-15-04 | session token in argv/history | mitigate | Verified | BATCH_PARITY_SESSION env only |
| T-87-16-01 | secrets/URLs in RUNBOOK | mitigate | Verified | RUNBOOK uses read -s, no credentials (87-16 SUMMARY grep) |
| T-87-16-02 | unreviewed hand SQL on production | mitigate | Verified | D-11 recipe documented in RUNBOOK |
| T-87-16-03 | rollback impossible after a week of PG writes | mitigate | Verified | replay-first rule documented; rehearsal in 87-18 |
| T-87-17-01 | a second batch issuer added later | mitigate | Verified | batch-single-issuer.test.js; stray create_batch literal in lib/vessel-store.js made it fail, reverted |
| T-87-17-02 | client file drift breaks SC2 | mitigate | Verified | git diff --exit-code 3010e237 on four client files: identical |
| T-87-17-03 | unreviewed High risk shipped | mitigate | Pending | Owner sign-off block below |
| T-87-18-01 | staging writes reach the live sheet | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-18-02 | Phase 87 code reaches production early | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-18-03 | snapshot files | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-18-04 | v62 breaks production reads | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-19-01 | two production migration windows at once / vessels not PG-authoritative | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-19-02 | mismatched data goes live | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-19-03 | sales lose their batches during the window | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-19-04 | staff edit the sheet after the flip | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-19-05 | production push without approval | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-20-01 | silent drift during the week | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-20-02 | lossy rollback | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |
| T-87-20-03 | unrecorded hand fixes | mitigate | Procedural - verified when plan executes | Executed in plans 18-20 (staging push, production cutover, rollback week) |


## Deliberate public-path hardening (reviewed)

- Q8: public task update verifies the task belongs to the token's batch (batch-pg-tasks.js:226).
- Beyond Q8: public reading add, update and delete also enforce batch ownership (L380, L428, L468).
- Public batch-id regex accepts 6+ digits (`^SV-B-[0-9]{6,}$`); Apps Script accepted exactly 6. Wider, still anchored and token-gated.
- New validation rejects impossible reading dates, malformed start_date, and non-numeric volume or scale (previously coerced or stored).

## Accepted risks and follow-ups

| # | Item | Severity | Disposition |
|---|------|----------|-------------|
| A1 | Q17: public response keeps customer_phone, notes, recipe_snapshot (a 128-bit token holder sees them) | Low | Accepted (owner Q17, parity) |
| A2 | Q16: not_found vs invalid_token distinguishable | Low | Accepted (parity; 128-bit tokens, per-IP limiter) |
| A3 | Public write flood relies on the existing batchPublicLimiter | Low | Accepted |
| A4 | Status change plus vessel move in one edit flips the old vessel | Low | Parity smell, follow-up |
| A5 | Un-completing a packaging task always resets the status | Low | Parity smell, follow-up |
| A6 | Q18 reassign-customer new_version null bug | Low | Parity smell, follow-up |
| A7 | Concurrent queries on one pg client in batch-pg-read.loadChildren and ops-backfill (pg 9 deprecation) | Low | Follow-up before any pg 9 upgrade |
| A8 | Public route logs `err.message` of store failures server-side (routes/pos.js:4313); pg messages can echo identifiers, not request values | Info | Note only |
| A9 | Prod and staging run PG 18 while tests/CI use postgres:16 (see memory) | Info | Pre-existing, unrelated |

## Open items

None High. None Medium. No second batch issuer found by the new static test.

## Owner sign-off

Owner: ______________________  Date: ______________  (pending; set to "approved" by owner reply)
