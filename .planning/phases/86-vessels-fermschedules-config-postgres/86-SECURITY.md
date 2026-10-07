# Phase 86 Security Review (ASVS Level 1)

Reviewed: 2026-10-07 (against merged code at HEAD 9fd41a0c, plans 86-01 to 86-16 complete; 86-18/19/20 not yet executed)
Scope: the Staff Access (allowlist) change path, the new vessel and ferm-schedule Postgres APIs, the admin-proxy
hardening, the Apps Script v61 additions (server_token attribution, `vessel_sheet_write`, trusted schedule steps).
Method: evidence-based review of code, grep gates, and test runs. No source or test files were modified.

## 1. Evidence runs

| Run | Result |
|-----|--------|
| `npx jest staff-access staff-access-routes auth-tiers-revocation auth-google-staff-access admin-proxy-attribution vessels-routes ops-proxy` | 8 suites passed, 125 tests passed |
| `npm run test:db -- staff-access-pg` (Docker Postgres) | 1 suite passed, 14 tests passed (last-owner rejection, self-demotion, break-glass counting, concurrent mutual removal, audit-in-tx rollback) |

## 2. Grep gates

| # | Gate | Result |
|---|------|--------|
| 1 | Every handler in `routes/staff-access.js` and `routes/vessels.js` is behind `requireTiers` | PASS. staff-access: all 5 routes use `guard()` (`routes/staff-access.js:141,155,178,190,202`), which calls `requireTiers(['session'])` at L82. vessels: all 6 routes call `requireTiers(TIERS)` inline (L74,87,104,121,143x2 via archiveHandler); `TIERS = ['legacy','session']` (L19), device tier excluded. Ferm-schedule CRUD has no router of its own; it goes through the admin proxy in `routes/pos.js`, which is tier gated (pre-existing). |
| 2 | `server_token` in migrations or backfill specs | PASS. Only a comment at `migrations/0004_ops_data.sql:11`; no config value usage. `config.key` CHECK at L65: `key ~ '^[a-z0-9_]+$' and key !~ '(token\|secret\|password\|key)'`. Backfill hard-rejects the same key patterns (86-09, T-86-09-01). |
| 3 | `staff` in `lib/ops-mirror.js` and `scripts/backfill/ops-replay-to-sheet.js` outside comments | PASS. Only one comment hit (`lib/ops-mirror.js:6`, "staff list ... never"). Staff list is never mirrored (D-10). |
| 4 | Raw email in log/Sentry calls in new staff code | PASS. Every `log.*` in `lib/staff-access.js` (L98,101,135) and `routes/staff-access.js` (denied warn) uses `hashEmail`. No raw email interpolation found. |
| 5 | `acting_user` assignment in `routes/pos.js` | PASS. `hardenProxyPayload` (L4054) deletes `acting_user`, `collect_vessel_status`, `vessel_sheet_write`, `schedule_steps_json` from the client payload, then sets `acting_user` only from `req.staffEmail` (L4057). Applied in both proxies (L4126 read/forward, L4207 write). `lib/ops-proxy.js:123` only reads the already-hardened value. |
| 6 | requireTiers legacy pass-through countered | PASS. `routes/staff-access.js:83` `isSession = req.authTier === 'session'`, else 403 `session_required` (matrix test in `staff-access-routes.test.js`). |

## 3. ASVS L1 control table

| ASVS | Control | Implementation | Evidence | Status |
|------|---------|----------------|----------|--------|
| V2 Authentication | Staff identity from Google-verified token; session issued only to allowlisted emails; legacy API key and device token cannot reach Staff Access | `routes/auth.js:95` (`staffAccess.resolve` after `verifyStaffAccessToken`); `routes/staff-access.js:82-84` | `auth-google-staff-access`, `staff-access-routes` (auth matrix: anonymous 401, legacy 403, device 403) | CLOSED |
| V3 Session management | Removal or demotion takes effect on the next request; definitive denial destroys the session; DB-degraded denial does not destroy it | `lib/authTiers.js:134-153` (per-request resolve, `destroySession`, role re-derived, never read from the payload) | `auth-tiers-revocation` | CLOSED (accepted: 5 s cache, section 6) |
| V3 Session management | CSRF on owner mutations despite `SameSite=None` cookie | `routes/staff-access.js:85-93`: `x-session-token` header required (cookie-only rejected, mismatch rejected) plus Origin allowlist | `staff-access-routes` "Origin check" and auth matrix | CLOSED |
| V4 Access control | Owner-only enforcement (D-02), role re-derived per request bypassing the cache | `routes/staff-access.js:100-118` (`resolve(..., {bypassCache:true})`, role must be `owner`, else 403 and `denied` audit row) | `staff-access-routes`, `staff-access` | CLOSED |
| V4 Access control | Self-removal, self-demotion and last-owner safeguards under row lock; break-glass members counted as owners | `lib/staff-access-pg.js` (`for update` serialisation) | `test:db staff-access-pg` (14 pass, includes concurrent mutual removal) | CLOSED |
| V4 Access control | Unguarded-GET sweep (ROADMAP SC3) | Gate 1 above; `GET /api/staff-access`, `/me`, `/api/vessels`, `/api/vessels/next-id` all tier checked inline | anonymous 401 tests in `staff-access-routes` and `vessels-routes` | CLOSED |
| V4 Access control | Kiosk device token cannot edit vessels; no hard delete route for vessels | `routes/vessels.js:19` tiers; no DELETE route | `vessels-routes` device 403 | CLOSED |
| V5 Validation | Email normalised and shape checked in DB and app; role enum; SQL uses placeholders and fixed field allowlists | `0004_ops_data.sql:73-74` CHECKs; 86-05 field allowlists | `staff-access-pg`, vessel store tests | CLOSED |
| V5 Validation | Stored XSS in new UI (vessel text, schedule names, staff emails) | `escapeHTML` on all interpolations; `sanitizeInput` on all server text fields | 86-04 and 86-10 tests with `<img onerror>` payloads | CLOSED |
| V5 Validation | Client cannot smuggle server-only proxy fields | `hardenProxyPayload` (Gate 5) | `admin-proxy-attribution` | CLOSED |
| V7 Errors and logging | Audit row in the same transaction as every allowlist change; failure rolls back; no update or delete path on the audit table; denied attempts audited | `lib/staff-access-pg.js`, `routes/staff-access.js:60-76` | `test:db` "audit atomicity", `recordDenied` | CLOSED |
| V7 Errors and logging | No raw emails in logs or Sentry; generic 5xx bodies | Gate 4; `unavailable()` returns generic `staff_access_unavailable`; vessels return generic 502 | `staff-access` test asserts raw email absent | CLOSED |
| V8 Data protection | Staff list never mirrored to the shared Google Sheet (D-10) | Gate 3; unknown mirror entity throws | `ops-mirror` tests | CLOSED |
| V8 Data protection | `server_token` lives only in Railway `APPS_SCRIPT_SERVER_TOKEN` and Apps Script Script Properties | Section 5 | Gate 2; `docs/APPS_SCRIPT.md:45` corrected in 86-14 (commit 103ce539) | CLOSED |
| V13 API | Fail closed on Postgres outage (D-20), break-glass env members still work (D-01); `staff_access_requires_postgres` 503 in sheets mode | `lib/staff-access.js:95-135`; `routes/staff-access.js:95-98` | `staff-access`, `staff-access-routes` "sheets mode" | CLOSED |
| V13 API | CORS origin whitelist and Referer check on API routes | `server.js:77-110` (pre-existing, unchanged) | existing suites | CLOSED |

## 4. Threat register verification

Disposition column is the plan's disposition. Status: CLOSED (verified against merged code and tests above), ACCEPTED
(documented residual), SCHEDULED (control belongs to a plan not yet executed; verified at that plan's execution).
Severity is shown only for non-closed rows.

| Threat | Disp. | Evidence | Status |
|--------|-------|----------|--------|
| T-86-01-01 | mitigate | 0004 is additive DDL; migrate:guard allowlist passed in 86-01 | CLOSED |
| T-86-01-02 | mitigate | `config.key` CHECK (`0004_ops_data.sql:65`) | CLOSED |
| T-86-01-03 | mitigate | `0004_ops_data.sql:73` | CLOSED |
| T-86-01-04 | mitigate | `jsonb_typeof` CHECK (L55) plus `validateSteps` | CLOSED |
| T-86-01-05 | mitigate | `ferm_schedule_id_seq` default; parallel-create test (86-06) | CLOSED |
| T-86-02-01 | mitigate | Gate 5, `admin-proxy-attribution` | CLOSED |
| T-86-02-02 | mitigate | `SERVER_ONLY_PROXY_FIELDS` (`pos.js:4052`), both proxies | CLOSED |
| T-86-02-03 | mitigate | real email forwarded; Apps Script half 86-03 | CLOSED |
| T-86-02-04 | accept | Google-owned trust domain, pre-Phase-82 precedent | ACCEPTED (Low) |
| T-86-03-01 | mitigate | `adminApi.gs:276` read only in server_token branch | CLOSED |
| T-86-03-02 | mitigate | `adminApi.gs:503` deleted on staff path | CLOSED |
| T-86-03-03 | mitigate | `_actingUser` validation (`adminApi.gs:3925`), fallback 'middleware' | CLOSED |
| T-86-03-04 | mitigate | `vessel_sheet_write:false` honoured; set from `isMirrorEnabled()` (86-16) | CLOSED |
| T-86-03-05 | mitigate | additive only; rollback to v60 recorded (RUNBOOK §9); deploy happens in 86-18 | SCHEDULED (86-18) |
| T-86-04-01 | mitigate | escapeHTML + onerror tests (86-04) | CLOSED |
| T-86-04-02 | mitigate | `expected_updated_at`, 409 Reload | CLOSED |
| T-86-04-03 | mitigate | 409 excluded from retry | CLOSED |
| T-86-04-04 | mitigate | `schedule_in_use` 409, archive offered | CLOSED |
| T-86-05-01 | mitigate | field allowlists, `$n` placeholders | CLOSED |
| T-86-05-02 | mitigate | `vessel_id_immutable` | CLOSED |
| T-86-05-03 | mitigate | `for update` + `isStale` | CLOSED |
| T-86-05-04 | mitigate | `archived` separate; `applyStatusChanges` never writes it | CLOSED |
| T-86-05-05 | mitigate | `sanitizeInput` + escapeHTML | CLOSED |
| T-86-06-01 | mitigate | sequence default, parallel-create test | CLOSED |
| T-86-06-02 | mitigate | ref counts required, `schedule_in_use` | CLOSED |
| T-86-06-03 | mitigate | `for update` + strict `isStale` | CLOSED |
| T-86-06-04 | mitigate | `sanitizeInput` + `validateSteps` + jsonb CHECK | CLOSED |
| T-86-07-01 | mitigate | PG role wins over env membership | CLOSED |
| T-86-07-02 | mitigate | last-owner and self-removal rejected under lock; `test:db` | CLOSED |
| T-86-07-03 | mitigate | `test:db` concurrent mutual removal | CLOSED |
| T-86-07-04 | mitigate | `test:db` audit atomicity | CLOSED |
| T-86-07-05 | mitigate | fail closed for non-break-glass (`lib/staff-access.js:95-135`) | CLOSED |
| T-86-07-06 | mitigate | Gate 4 | CLOSED |
| T-86-07-07 | accept | <= 5 s positive cache, cleared on mutation, owner checks bypass it | ACCEPTED (Low) |
| T-86-08-01 | mitigate | header-addressed single-row writes (86-08 tests) | CLOSED |
| T-86-08-02 | mitigate | Gate 3 | CLOSED |
| T-86-08-03 | mitigate | text-preserving write | CLOSED |
| T-86-08-04 | accept | formula injection, pre-existing writer behaviour | ACCEPTED (Low) |
| T-86-08-05 | mitigate | per-batch try/catch, `batches_failed` | CLOSED |
| T-86-09-01 | mitigate | backfill key reject, value not echoed | CLOSED |
| T-86-09-02 | mitigate | seeds from Railway list plus explicit owners only | CLOSED |
| T-86-09-03 | mitigate | `--owners` required | CLOSED |
| T-86-09-04 | mitigate | masked output tests | CLOSED |
| T-86-09-05 | mitigate | `BACKFILL_DATABASE_URL` only, DB-name prompt | CLOSED |
| T-86-09-06 | mitigate | single transaction, rollback | CLOSED |
| T-86-10-01 | mitigate | escapeHTML + onerror test | CLOSED |
| T-86-10-02 | mitigate | server enforces owner on every route (Gate 1, V4); UI hide cosmetic | CLOSED |
| T-86-10-03 | mitigate | `expected_updated_at` stale toast | CLOSED |
| T-86-10-04 | mitigate | no delete control | CLOSED |
| T-86-10-05 | mitigate | no new origin, CSP untouched | CLOSED |
| T-86-11-01 | mitigate | Gate 3 | CLOSED |
| T-86-11-02 | mitigate | read-latest at send, per-id coalescing | CLOSED |
| T-86-11-03 | mitigate | durable marker, sweep, Sentry | CLOSED |
| T-86-11-04 | mitigate | production gate, staging no-op test | CLOSED |
| T-86-11-05 | mitigate | tags entity + id only | CLOSED |
| T-86-12-01 | mitigate | `staff-access.js:100-118`, `staff-access-routes` | CLOSED |
| T-86-12-02 | mitigate | `authTiers.js:134-153`, `auth-tiers-revocation` | CLOSED |
| T-86-12-03 | mitigate | Gate 6 | CLOSED |
| T-86-12-04 | mitigate | header-token + Origin (ASVS V3 row) | CLOSED |
| T-86-12-05 | mitigate | Gate 1 | CLOSED |
| T-86-12-06 | mitigate | break-glass env, fail closed, no session destruction when degraded | CLOSED |
| T-86-12-07 | mitigate | `denied` audit rows plus hashed warn (`staff-access.js:62`) | CLOSED |
| T-86-12-08 | mitigate | Gate 4; generic 503 | CLOSED |
| T-86-12-09 | mitigate | `verifyStaffAccessToken` runs first (`routes/auth.js`) | CLOSED |
| T-86-13-01 | mitigate | steps loaded from PG by id (86-13 tests) | CLOSED |
| T-86-13-02 | mitigate | `batch_ref_unavailable` / `recipe_ref_unavailable` fail closed | CLOSED |
| T-86-13-03 | mitigate | no sheet fallback, reject to 502 | CLOSED |
| T-86-13-04 | mitigate | actor from `req.staffEmail` | CLOSED |
| T-86-13-05 | accept | narrow check-then-act window; batch keeps schedule snapshot; Known gap for Phase 87 | ACCEPTED (Low) |
| T-86-14-01 | mitigate | masked output tests | CLOSED |
| T-86-14-02 | mitigate | `set transaction read only` | CLOSED |
| T-86-14-03 | mitigate | Gate 3 | CLOSED |
| T-86-14-04 | mitigate | RUNBOOK §8 steps 2-3 (`docs/RUNBOOK.md:965-969`); executed at the flip | SCHEDULED (86-20), see section 7 |
| T-86-14-05 | mitigate | RUNBOOK §9 orders STAFF_EMAILS restore before flag change | CLOSED |
| T-86-14-06 | mitigate | `docs/APPS_SCRIPT.md:45` corrected | CLOSED |
| T-86-15-01 | mitigate | Gate 1, anonymous 401 test | CLOSED |
| T-86-15-02 | mitigate | device 403 test | CLOSED |
| T-86-15-03 | mitigate | no DELETE route | CLOSED |
| T-86-15-04 | mitigate | generic 502 body | CLOSED |
| T-86-15-05 | mitigate | actor = `req.staffEmail` | CLOSED |
| T-86-16-01 | mitigate | `hardenProxyPayload` | CLOSED |
| T-86-16-02 | mitigate | never set on non-server_token payloads | CLOSED |
| T-86-16-03 | accept | Sentry/log + ops-verify + replay; RUNBOOK §11 | ACCEPTED (Low) |
| T-86-16-04 | mitigate | only `archive_ferm_schedule` added | CLOSED |
| T-86-16-05 | mitigate | 502 collapse unchanged | CLOSED |
| T-86-16-06 | mitigate | overlay no-ops in sheets mode; existing suites green | CLOSED |
| T-86-17-01 | mitigate | this review; block on open High | CLOSED on sign-off |
| T-86-17-02 | mitigate | section 7 | SCHEDULED (86-20) |
| T-86-17-03 | mitigate | sign-off block below | OPEN until owner signs (process item, not a code gap) |
| T-86-18-01 | mitigate | gated on signed 86-SECURITY.md | SCHEDULED (86-18) |
| T-86-18-02 | mitigate | additive diff check, rollback 60 | SCHEDULED (86-18) |
| T-86-18-03 | mitigate | bundles live before flags change | SCHEDULED (86-18) |
| T-86-18-04 | mitigate | test batches only, `vessel_sheet_write:false` | SCHEDULED (86-18) |
| T-86-18-05 | accept | Phase 83 D-11 owner decision | ACCEPTED (Low) |
| T-86-18-06 | mitigate | production/main precheck | SCHEDULED (86-18) |
| T-86-18-07 | mitigate | owner adds Vessels label header; ops-verify gate | SCHEDULED (86-18) |
| T-86-19-01 | mitigate | hold unless RECIPES_STORE=postgres | SCHEDULED (86-19) |
| T-86-19-02 | mitigate | STAFF_EMAILS untouched until after flip | SCHEDULED (86-19) |
| T-86-19-03 | mitigate | 0 rejects, 0 mismatches gates | SCHEDULED (86-19) |
| T-86-19-04 | mitigate | decision checkpoint | SCHEDULED (86-19) |
| T-86-19-05 | mitigate | backup status prerequisite | SCHEDULED (86-19) |
| T-86-19-06 | mitigate | label header gate | SCHEDULED (86-19) |
| T-86-20-01 | mitigate | D-18 blank + probe | SCHEDULED (86-20), see section 7 |
| T-86-20-02 | mitigate | trim only after `missingFromPg 0` | SCHEDULED (86-20) |
| T-86-20-03 | mitigate | owners stay in STAFF_EMAILS | SCHEDULED (86-20) |
| T-86-20-04 | mitigate | D-11 bar plus decision checkpoint | SCHEDULED (86-20) |
| T-86-20-05 | mitigate | verify + replay before sheets | SCHEDULED (86-20) |
| T-86-20-06 | mitigate | `read -s`, never logged | SCHEDULED (86-20) |

## 5. SC3: server_token location

- Middleware holds it as `APPS_SCRIPT_SERVER_TOKEN` (Railway env). Apps Script reads `SERVER_TOKEN` / `SERVER_WRITE_TOKEN` from Script Properties only (`adminApi.gs:108-110, 270-273`).
- The Postgres `config` table cannot hold it: key CHECK rejects `token|secret|password|key` (`0004_ops_data.sql:65`), and the backfill hard-rejects those keys without echoing the value.
- No migration or backfill spec references it as a value (Gate 2).
- `docs/APPS_SCRIPT.md:45` states the Config sheet never holds it (corrected in commit 103ce539). Review limit: I cannot read the live Google Sheet from here, so "no Config row in production data" rests on the backfill reject guard plus the owner's earlier Config sheet review; the owner may wish to eyeball the Config tab for a `server_token` row at sign-off.

## 6. Accepted risks

1. 5 second same-instance positive cache on the staff allowlist (T-86-07-07). Owner checks and Staff Access routes bypass it; single Railway instance.
2. `server_token` appears in query strings of Apps Script GET reads (pre-existing, Low).
3. Formula injection in mirrored sheet text (T-86-08-04, pre-existing writer behaviour, Low).
4. Delete-vs-new-reference check-then-act window on schedules (T-86-13-05, Low; batches keep a schedule snapshot).
5. Non-owner vessel mutations (`/api/vessels` POST/PUT/archive) accept the cookie session without the `x-session-token` header requirement that Staff Access has. They are staff-level, non-privileged data, and are covered by the CORS whitelist (JSON content type forces a preflight) and the Referer check. Observation only, rated Low; hardening would be to reuse the Staff Access header-token check.

## 7. Required mitigation at the production flip (D-18) - HIGH until executed, scheduled: 86-20

Finding: Apps Script `checkAuthorization` (`adminApi.gs` ~L610-720) still authorises direct OAuth callers whose email is in the Config sheet `staff_emails` cell (cached 5 min). A person removed in Staff Access who is still listed in that cell could call Apps Script directly with their own Google token, bypassing the middleware allowlist.

Required mitigation, executed at the production flip (RUNBOOK §8, `docs/RUNBOOK.md:965-973`):
1. Blank the Config `staff_emails` VALUE cell and write the retirement note in the adjacent cell.
2. Wait 5 minutes (Apps Script cache).
3. Probe a direct Apps Script call with a non-owner staff Google token; it must return `unauthorized`.
4. Only then trim Railway `STAFF_EMAILS` to the owner break-glass accounts.

Why residual risk during dual is limited: until the flip, everyone currently in Config is also in Railway `STAFF_EMAILS`, so nobody can be removed through the screen while still holding that Apps Script path unnoticed (existing staff stay break-glass), and test accounts added via the screen are never written to the Config cell. The Config cell is therefore only a bypass for people who already had access before Phase 86.

The Apps Script code limb that reads `staff_emails` is removed in Phase 88 (D-04).

No other OPEN High item was found.

## 8. Owner sign-off

Required before anything from Phase 86 is pushed to staging.

Name:
Date:
