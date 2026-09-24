---
title: Restore staff attribution on admin writes (currently recorded as kiosk-middleware)
status: pending
created: 2026-09-24
source: Phase 82 staging walk (82-09-SUMMARY.md "Findings") — owner chose follow-up over fixing before 82-10
area: admin / audit trail / apps-script + middleware
priority: medium
owner_action: false
---

## What

Since Phase 82, admin.js writes go through `POST /api/admin/proxy` and reach Apps Script
via the `server_token` branch of `doPost`, which passes a hard-coded actor (`'middleware'`,
rendered as `kiosk-middleware` in VesselHistory / `created_by` / `completed_by`). Before
Phase 82 the staff Google session email was recorded. The audit trail therefore no longer
says which staff member created a batch, moved a vessel, or completed a task.

Seen live on staging: SV-B-000218 / SV-B-000221 Location History "— kiosk-middleware".

## Likely fix

- Middleware `/api/admin/proxy` (session tier) already knows the staff email from the
  `sv_session` — forward it as a dedicated field (e.g. `acting_user`), never from req.body.
- Apps Script `doPost` `server_token` branch: use `payload.acting_user` (sanitised) as the
  actor when present, falling back to `'middleware'`. Trust is fine — only the middleware
  holds the server token.
- Regression tests: proxy injects the session email and ignores a client-supplied one;
  Apps Script server_token dispatch passes it through as the actor.
- Needs an Apps Script redeploy (record in RUNBOOK deploy table).

## Related

- BrewPad's `/api/batch/admin-proxy` (Phase 76) likely has the same gap — check both.
