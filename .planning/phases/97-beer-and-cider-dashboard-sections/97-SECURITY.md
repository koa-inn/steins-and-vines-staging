---
phase: 97
slug: beer-and-cider-dashboard-sections
status: verified
threats_total: 46
threats_closed: 46
threats_open: 0
asvs_level: 1
created: 2026-11-05
---

# Phase 97 - Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Browser (BrewPad) to middleware | Staff-only admin routes (legacy/session tiers) | Card facts, shaped booking rows; recipe target gravity |
| Kiosk to middleware | Device-authenticated recipe-sale body | customer_email (validated) |
| Middleware to Cal.com | Server-side bearer key, read-only list bookings | Attendee PII (never forwarded or logged) |
| Cal.com webhook to middleware | HMAC-verified | Booking events (cache invalidation only) |
| Operator to Railway/Apps Script | Owner-performed env and deploy steps | Numeric event-type ids |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status | Evidence |
|-----------|----------|-----------|-------------|------------|--------|----------|
| T-97-01 | Tampering | recipes.js target gravity | mitigate | normalizeTargetGravity rejects non-number/string, out of 2..40; pg re-validates | closed | lib/recipe-rules.js:82-92; routes/recipes.js:751-764; lib/recipe-pg.js:249-250,353-395; tests recipe-rules-target-gravity, recipes-target-gravity-route |
| T-97-02 | Info disclosure | public recipe API | mitigate | target_og/fg not in PUBLIC_RECIPE_FIELDS | closed | routes/recipes.js:58 |
| T-97-03 | Tampering | Sheet formula injection via mirror | accept | Values are validated JS numbers before mirroring | closed | Accepted risk AR-1 |
| T-97-04 | DoS | migration 0009 | mitigate | Additive nullable numeric columns; guard + allowlist | closed | migrations/0009_recipes_target_gravity.sql:7-8; ROLLOUT-LOG: migrate:guard 9 files OK, applied on staging |
| T-97-05 | Tampering | snapshot fields | mitigate | Snapshot og/target_fg from server recipe (data.data.recipe), not request body | closed | routes/pos-recipe.js:606,1524-1525 (snapshotGravity) |
| T-97-06 | Tampering | money path regression | mitigate | Snapshot built separately from line items; money-path suites green | closed | routes/pos-recipe.js:1518-1536; ROLLOUT-LOG gate 298 suites pass; pos-recipe-snapshot-gravity.test.js |
| T-97-07 | DoS | Zoho quota | mitigate | No new Zoho/cache calls in diff | closed | git diff 8a2184d6..HEAD routes/pos-recipe.js lib/brewpad-integration.js: no zohoApi/axios/cache additions |
| T-97-08 | Info disclosure | listBookings / smoke script | mitigate | No attendee data logged; smoke prints HTTP code only | closed | lib/calcom.js:118-121 (no log in listBookings); scripts/calcom-smoke.sh:55-58 (-o /dev/null -w http_code) |
| T-97-09 | Info disclosure | CALCOM_API_KEY | mitigate | Key only in server-side makeHeaders | closed | lib/calcom.js:34; not present in any route response |
| T-97-10 | Tampering | body.service selector | mitigate | beer-packaging fails closed 503 if env unset; unknown selector keeps default | closed | routes/bookings.js:357-368 |
| T-97-11 | DoS | Cal.com pagination | mitigate | 5 pages x 100 cap, withRetry; timeout tightened to 5 s by WR-03 (stricter than plan 15 s) | closed | lib/calcom.js:124-130,158-170 |
| T-97-12 | Spoofing/EoP | dashboard-cards auth | mitigate | requireTiers legacy,session (device rejected) | closed | zoho-middleware/routes/brewpad-dashboard.js:28 |
| T-97-13 | Info disclosure | dashboard-cards whitelist | mitigate | Only batch_id + parsed numbers + 80-char strings; recipe_snapshot parsed server side; no '@' test | closed | lib/batch-pg-read.js:330-369; __tests__/brewpad-dashboard-cards-route.test.js:107; ROLLOUT-LOG leak check at-sign 0 |
| T-97-14 | XSS | juice/yeast | mitigate | Server cap 80; browser escapeHTML | closed | lib/batch-pg-read.js:343; js/brewpad.js dashBcLine 9495-9503 |
| T-97-15 | DoS | Zoho quota (cards) | mitigate | Route has no Zoho/axios call (Postgres only) | closed | zoho-middleware/routes/brewpad-dashboard.js (no axios/zohoApi references) |
| T-97-16 | Tampering | target gravity inputs (client) | mitigate | Client coerces to number or ''; server validates 2..40, FG<OG | closed | js/brewpad.js bpGravityOrNull/bpReadGravityInput; lib/recipe-rules.js:82-100 |
| T-97-17 | Tampering | existing batches | mitigate | No backfill; migration has no data step; only new attaches carry values | closed | migrations/0009 (no UPDATE); routes/pos-recipe.js:1518 (new attach only) |
| T-97-18 | Info disclosure | packaging-bookings response + cache | mitigate | shapeBookings emits only start, day, kind, batch_id, customer_name (uid/end/event_type_id dropped by WR-04); name blanked if contains '@' and only for unmatched (WR-05); cache holds shaped body | closed | lib/packaging-bookings.js:75-104; routes/brewpad-dashboard.js:97-101; test packaging-bookings-route.test.js:91 |
| T-97-19 | Spoofing/EoP | packaging-bookings auth | mitigate | requireTiers legacy,session | closed | zoho-middleware/routes/brewpad-dashboard.js:55 |
| T-97-20 | Info disclosure | logs | mitigate | Counts, HTTP status, error code only | closed | routes/brewpad-dashboard.js:75-78,96-108; test packaging-bookings-route.test.js:141 |
| T-97-21 | Tampering | wrong batch link | mitigate | Tie/undated multi-match returns null; never guess | closed | lib/packaging-bookings.js:60-74; ROLLOUT-LOG UAT 9 (shared email -> no batch) |
| T-97-22 | DoS | Cal.com outage | mitigate | 5 s timeout, 200 {ok:false} soft-fail, failure never cached; WR-01 candidates failure also ok:false; 300 s success cache | closed | routes/brewpad-dashboard.js:62-118; lib/calcom.js:128 |
| T-97-23 | Tampering | forged webhook flush | accept | invalidate only after HMAC check | closed | Accepted risk AR-2; verified routes/webhooks.js:541-559 (invalidate after verifyWebhook) |
| T-97-24 | XSS | customer_name | mitigate | 80-char cap server side; escapeHTML in browser | closed | lib/packaging-bookings.js:77-80; js/brewpad.js dashCalEntryHtml 9387-9402; packcal test onerror payload |
| T-97-25 | XSS | shared row builders | mitigate | escapeHTML on interpolations incl. customer_name, batch_id | closed | js/brewpad.js (36 escapeHTML in phase diff; dash task row lines in diff); brewpad-ready-to-bottle-filter-97.test.js |
| T-97-26 | Tampering | task tick | accept | No new write path | closed | Accepted risk AR-3 |
| T-97-27 | Repudiation | pinned test edit | mitigate | Owner-approved edit recorded | closed | ROLLOUT-LOG 'Pre-existing test edits' item 2 (owner-approved 2026-11-04) |
| T-97-28 | XSS | calendar entries | mitigate | escapeHTML on every interpolation; onerror test | closed | js/brewpad.js:9387-9402; tests/frontend/brewpad-dashboard-v2-packcal.test.js:422-427 |
| T-97-29 | Info disclosure | browser data | mitigate | Route returns no emails; widget requests none | closed | lib/packaging-bookings.js:92-98; ROLLOUT-LOG leak recheck: at-sign 0, no uid |
| T-97-30 | DoS | dashboard load | mitigate | Lazy separate fetch; soft-fail notes; WR-03 client budget | closed | js/brewpad.js fetch packaging-bookings ~line 549, dashboard-cards ~673, WR-03 comment ~31 |
| T-97-31 | Spoofing | fetch credentials | accept | Same credentials:include pattern | closed | Accepted risk AR-4; server enforces requireTiers (T-97-12/19) |
| T-97-32 | XSS | card strings | mitigate | escapeHTML everywhere; server cap 80 | closed | js/brewpad.js:9495-9503, bc-card render uses escapeHTML for title/type/day/output; batch-pg-read.js:343 |
| T-97-33 | DoS | chart leaks | mitigate | bc:* charts destroyed on re-render | closed | js/brewpad.js destroyDashV2ChartsByPrefix (diff +296-299), called with 'bc:' (+730) |
| T-97-34 | Info disclosure | card data | accept | Batch-level production facts, staff only | closed | Accepted risk AR-5 |
| T-97-35 | Tampering | count drift | mitigate | Single readyToBottleList source for widget, filter and chip | closed | js/brewpad.js readyToBottleList (diff +371, +376, +487); brewpad-ready-to-bottle-filter-97.test.js |
| T-97-36 | Info disclosure | chip label | accept | Numbers only, staff page | closed | Accepted risk AR-6 |
| T-97-36a | Tampering | kiosk customer_email | mitigate | String, trim, <=254, shape regex; only sets batch customer_email | closed | routes/pos-recipe.js:1538-1544; lib/brewpad-integration.js:872 |
| T-97-36b | Info disclosure | email in logs/snapshot | mitigate | Email never in snapshot object nor log calls | closed | routes/pos-recipe.js:1518-1536 (snapshot lacks email); grep: no log call references email in pos-recipe.js/brewpad-integration.js |
| T-97-37 | Tampering | accidental prod push | mitigate | Only origin main pushed; production/main unchanged | closed | ROLLOUT-LOG 'Review fixes on staging' push row; verified git rev-parse production/main = 53484bdf |
| T-97-38 | DoS | migration failure | mitigate | Additive migration, guard+allowlist, down migration present | closed | migrations/0009 Down section; ROLLOUT-LOG staging deploy: migration applied, /health ok |
| T-97-39 | Info disclosure | rollout log | mitigate | Ids/counts only | closed | grep -c '@' 97-ROLLOUT-LOG.md = 0 |
| T-97-40 | Tampering | production env change | mitigate | Owner did it in session; only numeric id added; restart no code | closed | ROLLOUT-LOG 'Owner steps' production Railway env row |
| T-97-40a | DoS | prod restart unauthenticated | mitigate | Post-restart /health authenticated:true | closed | ROLLOUT-LOG: 2026-11-04T21:22:45Z status ok, authenticated true, database true, redis true |
| T-97-40b | Tampering | test booking left | mitigate | Owner cancelled test booking | closed | ROLLOUT-LOG UAT item 9: cancelled by owner 2026-11-05 (confirmed); log holds batch id only |
| T-97-41 | Tampering | Apps Script redeploy | mitigate | New version on same deployment; rollback recorded | closed | ROLLOUT-LOG: v66 (rollback v65); v67 (rollback v66) |
| T-97-42 | Info disclosure | live Cal.com check | mitigate | Count-only log lines and whitelisted output | closed | ROLLOUT-LOG staging live Cal.com and leak check rows: counts only |

*Status: open - closed*
*Disposition: mitigate (implementation required) - accept (documented risk) - transfer (third-party)*

Review-fix notes: mitigations for T-97-11, T-97-18, T-97-22 and T-97-29 were verified against current code after CR-01 and WR-01..07 (customer_name only on unmatched bookings and blanked on '@'; uid/end/event_type_id removed; 5 s timeouts; candidates failure returns ok:false).

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-1 | T-97-03 | Mirrored target gravity values are validated JS numbers, never strings; existing sanitize path unchanged | Plan 97-01 | 2026-11-05 |
| AR-2 | T-97-23 | Cache invalidation runs only after the HMAC check; worst case one extra Cal.com read | Plan 97-04 | 2026-11-05 |
| AR-3 | T-97-26 | No new write path; existing handler conventions (Phase 76/94) | Plan 97-07 | 2026-11-05 |
| AR-4 | T-97-31 | Same credentials:include pattern as every BrewPad call; server enforces requireTiers | Plan 97-08 | 2026-11-05 |
| AR-5 | T-97-34 | Batch-level production facts only, already staff-visible; no customer data | Plan 97-09 | 2026-11-05 |
| AR-6 | T-97-36 | Chip label is numbers only on a staff-only page | Plan 97-10 | 2026-11-05 |

---

## Unregistered Flags

None. 97-10-SUMMARY Threat Flags: "None beyond the plan's register".

Informational (not blockers): production Railway CALCOM_EVENT_TYPE_BEER_PACKAGING stored with a leading space (Number() parses it; tidy optional). Middleware npm audit high (minimatch/glob) is pre-existing and out of this phase's register.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-05 | 46 | 46 | 0 | gsd-security-auditor |

---

## Sign-Off

- [x] All threats have a disposition (40 mitigate, 6 accept, 0 transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-05
