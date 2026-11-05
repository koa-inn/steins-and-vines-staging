---
created: 2026-11-05
source: Phase 97 code review WR-07 (remainder)
---
# Recipe verify/backfill scripts ignore target_og / target_fg

Phase 97 added recipes.target_og / target_fg (migration 0009). Apps Script create/update now keep them (v67), but the recipe verify and backfill scripts still use the 19-header spec, so drift in these two columns goes undetected and a re-backfill would drop them.

Blocked on owner decisions:
- OK to update the pre-existing test `zoho-middleware/__tests__/backfill/recipes-spec-headers.test.js` (asserts exactly 19 headers).
- How the backfill should treat a sheet that lacks the new (optional) columns; today every spec header is required.

Low urgency: recipes are Postgres-primary in production.
