---
phase: 97-beer-and-cider-dashboard-sections
plan: 04
subsystem: middleware
tags: [brewpad, dashboard, postgres, express]
requires: []
provides:
  - "GET /api/admin/dashboard-cards (abv/ibu/batch_size_l/juice/yeast per active batch + canning constants)"
affects: [97-09]
tech-stack:
  added: []
  patterns: ["separate read-only route instead of widening pinned aggregate"]
key-files:
  created:
    - zoho-middleware/routes/brewpad-dashboard.js
    - zoho-middleware/__tests__/batch-card-facts.test.js
    - zoho-middleware/__tests__/brewpad-dashboard-cards-route.test.js
    - zoho-middleware/__tests__/db/batch-pg-card-facts.test.js
  modified:
    - zoho-middleware/lib/batch-pg-read.js
    - zoho-middleware/lib/batch-store.js
    - zoho-middleware/server.js
key-decisions:
  - "Card facts ride on a separate staff route, not batchMeta, because existing tests pin the get_dashboard_stats payload exactly (rule 10)"
requirements-completed: [D-07, D-09, D-10, D-11, D-12, D-16, SC1, SC2, SC3]
duration: 25min
completed: 2026-11-03
---

# Phase 97 Plan 04: Beer/cider card facts route Summary

Staff-only GET /api/admin/dashboard-cards returns whitelisted abv, ibu, batch_size_l, juice and yeast per primary/secondary batch plus the shared canning constants (25 L per 28 L brew, kiosk BUNDLES['beer-25'].nominal), with no Zoho call.

## Commits
- 344cc7ce: parseCardFacts + getDashboardCardFacts (batch-pg-read)
- Task 2 commit: batch-store.dashCards, route, server mount, route tests

## Deviations from Plan
- Design deviation recorded in the plan itself: separate route rather than extending batchMeta, to leave pinned dash-stats tests untouched.
- getDashboardCardFacts maps `res.rows` (pg result), not a bare rows array.
- Verification: the full middleware suite showed 4 timeout failures under load (pos-recipe-payment-after-submit, health-database, health-database-required, read-xlsx-reset-modules); all pass when rerun alone. Unrelated to this plan.

## Verification
- batch-card-facts, route, kiosk-bundles, pinned dash-stats tests: pass. DB test batch-pg-card-facts ran against Docker Postgres and passed.
- Lint clean.

## Known Stubs
None.

## Self-Check: PASSED
