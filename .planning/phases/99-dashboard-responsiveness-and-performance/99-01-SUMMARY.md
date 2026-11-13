---
phase: 99-dashboard-responsiveness-and-performance
plan: 01
subsystem: testing
tags: [lighthouse, axe, playwright, perf-harness, fixture-anonymization]

requires: []
provides:
  - Local repeatable Lighthouse + axe + overflow harness for brewpad.html (npm run perf)
  - Anonymized dashboard fixture behind a PII/token guard test
  - Baseline and current-tree perf numbers in 99-PERF-LOG.md
affects: [99-02, 99-03, 99-04, 99-05, 99-06, 99-07]

tech-stack:
  added: [lighthouse 13.6.0, "@axe-core/playwright 4.14.0", chrome-launcher 1.2.3 (dev deps)]
  patterns: [serve-time injection instead of any test seam in js/, allowlist-first anonymization]

key-files:
  created:
    - tests/perf/server.mjs
    - tests/perf/run.mjs
    - tests/perf/seed.js
    - tests/perf/gsi-stub.js
    - tests/perf/capture-fixture.mjs
    - tests/perf/anonymize.js
    - tests/perf/README.md
    - tests/perf/fixture/smoke-fixture.json
    - tests/perf/fixture/dashboard-fixture.json
    - tests/frontend/perf-fixture-anonymized-99.test.js
    - .planning/phases/99-dashboard-responsiveness-and-performance/99-PERF-LOG.md
  modified: [package.json, package-lock.json, .gitignore]

key-decisions:
  - "Fixture anonymizer is allowlist-first: any string under a key not in KEEP_KEYS becomes 'Redacted text'"
  - "Person-linking ids (customer_id, zoho_contact_id, waitlist id, zoho_so_number) are pseudonymised deterministically so equality relationships survive"
  - "JSON-string fields (steps, schedule_snapshot, recipe_snapshot) are parsed, anonymized recursively and re-stringified"
  - "get_tasks_calendar invalid_action response kept as captured; fixture keeps the capture date rather than __TODAY__"

patterns-established:
  - "Harness injects seed/GSI stub at serve time only; no seam in js/, css/ or brewpad.html"

requirements-completed: [D-05, D-06]

duration: n/a
completed: 2026-11-12
---

# Phase 99 Plan 01: Perf harness and anonymized fixture Summary

**Local Lighthouse + axe + overflow harness for BrewPad with an anonymized staging-capture fixture, and a measured baseline of 0.60 mobile performance (target 0.85).**

## Accomplishments

- Task 1 (commit 8624415c): 127.0.0.1-only mock server (repo root + fixture, admin-proxy and /auth/google mocks, MIDDLEWARE_URL rewritten at serve time), seed + Google stub injection, `run.mjs` (Lighthouse mobile x3 median + warm + desktop, axe at 1280/820/390, scrollWidth 360/320), read-only staging `capture-fixture.mjs`, README. Details in tests/perf/README.md.
- Task 2: owner capture from staging (gitignored `tests/perf/.raw/capture.json`).
- Task 3 (commit 29462141): allowlist-first `anonymize.js`, committed `dashboard-fixture.json`, 19-test PII guard, baseline + current rows and payload size in 99-PERF-LOG.md.

## Task Commits

1. Task 1: harness and capture script - 8624415c
2. Task 3: anonymizer, fixture, guard test, perf log - 29462141

## Key numbers (full table in 99-PERF-LOG.md)

| Commit | Perf | a11y | Interactive cold/warm ms | LCP | TBT | CLS | axe s+c d/t/p | scrollWidth 360/320 |
|---|---|---|---|---|---|---|---|---|
| ec2ad073 baseline | 0.60 | 0.91 | 14258 / 7804 | 14258 | 52 | 0.045 | 2/2/2 rules | 360/320 |
| ae992c99 current | 0.60 | 0.91 | 14114 / 7805 | 14114 | 54 | 0.045 | 2/2/2 rules | 360/320 |

`get_dashboard_stats.data` is 398,966 bytes compact JSON. Gap to target is 25 points; baseline is not below 60 but at 0.60 a bundle split may be needed (decision for 99-07).

## KEEP_KEYS (final)

ids: batch_id, task_id, vessel_id, shelf_id, bin_id, schedule_id, recipe_id, product_sku, item_id, ingredient_id, tax_id, staffBatchIds.
dates: today, tz, month, start, end, due_date, start_date, completed_day, completed_at, completed_at_source, created_at, last_updated, last_regenerated_at, updated_at, reading_at, reading_day, signed_up_at, contacted_at, fermentation_started_at, bottling_invite_sent_at, bottling_due.
enums: status, type, material, category, source, batch_type, batch_type_source, schedule_category, product_subcategory, unit, cf_type, cf_subcategory, display_group, error.
names: name, title, product_name, recipe_name, recipe_style, item_name, juice, yeast, label (month abbreviations only).

Redacted/pseudonymised: all email keys, phone keys (555-0100), customer/contact/first/last/full name keys (Customer N), token/secret/password/session/signature, notes/description/comment/message/address, customer_id/zoho_contact_id/id/zoho_so_number (deterministic placeholders), and every other string key (created_by, location, brand, vessel label, snapshot notes, ...).

## PII review

`git diff --cached -- tests/perf/fixture/` was reviewed before commit (key-name filtered view plus distinct-value inspection of every kept text key: all product, recipe, schedule, task, ingredient and enum vocabulary; no person names, emails, phones, addresses, notes or tokens). An independent scan of distinct string shapes per key confirmed placeholders only, and a check that no raw customer-name token appears as a whole word in any kept product name. The Jest guard additionally asserts no non-example.test email, no 10-digit/phone run, no 24+ char token run, customer fields all placeholders.

## Deviations from Plan

None in scope. Additions beyond the plan text: person-linking ids are pseudonymised (customer_id, zoho_contact_id, waitlist id, zoho_so_number), JSON-string snapshot fields are walked, and a kept value containing `@` or a phone-like run is redacted defensively.

## Observations for later plans

- `get_tasks_calendar` on staging returns `{"ok":false,"error":"invalid_action"}`; kept as captured, so the calendar renders empty in the harness. For a later look; no js/ change made.
- Cold mobile is bound by load, not main-thread work: FCP 5.9 s, LCP = interactive = 14.1 s, TBT about 54 ms. Render-blocking head scripts: jspdf 366 KB, qrcode 20 KB, brewpad.min.js 417 KB, CSS 71 KB. Warm run is 0.76 / 7.8 s, the remainder being the data-fetch/render chain (99-04 target).
- axe serious+critical at all widths: `label` (5 nodes) and `color-contrast` (6 / 9 / 5 nodes at desktop / tablet / phone). CLS 0.045 occurs in 2 of 3 cold runs and the warm run. No horizontal overflow at 360 or 320.
- The fixture keeps the capture date (2026-11-12) so YTD charts are stable; prior-period tiles show "No earlier data to compare".

## Verification

Node 24: frontend 264 suites / 3631 tests pass; middleware 315 suites / 4390 tests pass; `npm run lint` clean. The new test also passes on Node 20 (19/19). Baseline worktree removed; `git ls-files tests/perf/.raw` is empty. #bp-dash-v2 renders tiles, Production over time, Products and Source mix with data; 0 fixture misses.

## Self-Check: PASSED
