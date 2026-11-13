# Deferred items (Phase 99)

- tests/frontend/brewpad-dashboard-v2-helpers-99.test.js `dashAsOfHint > copy` fails on local Node 24.21.0:
  expects "3:05 PM" (PST) for 2026-11-06T23:05Z, receives "4:05 PM". Pre-existing from plan 99-02 (commit 8bc4c997);
  unrelated to 99-01 (pure function, no shared files). Likely the Node tzdata vs BC permanent-time issue
  (see memory node-tzdata-bc-permanent-time): America/Vancouver resolves to UTC-7 in this ICU build. Found while
  running `npm test` during 99-01 Task 1; not fixed here (existing tests must not be modified without being asked).
