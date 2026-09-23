# Phase 82: Store-Agnostic Prerequisites - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-23
**Phase:** 82-store-agnostic-prerequisites
**Areas discussed:** Legacy action deletion, Proxy shape & auth, Public batch page, Direct Sheets API + rollout

Scout finding presented up front: the research's "7 zero-caller actions" have live callers for get_kits, get_holds, get_schedule, get_reservations, update_hold, update_reservation, update_homepage; only get_config, update_schedule, update_kits, get_homepage are truly zero-caller.

---

## Legacy action deletion

| Option | Description | Selected |
|--------|-------------|----------|
| Dead — nobody uses it | Res & Holds tab safe to remove | |
| Still used | Must keep working until Phase 88 | |
| Not sure | Treat as live; owner check looks at activity | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Only the 4 true zero-callers | Route everything with a caller; trio stays for Phase 88 | ✓ |
| 4 + retire Res/Holds tab now | Pull part of Phase 88 forward | |
| 4 + remove dead fallback code | Also delete direct-Sheets fallbacks | |

| Option | Description | Selected |
|--------|-------------|----------|
| get_kits: keep as-is | Already middleware-mediated | ✓ |
| Rehome registry now | Derive SKUs from Zoho/committed file | |

---

## Proxy shape & auth

| Option | Description | Selected |
|--------|-------------|----------|
| Sibling /api/admin/proxy | Own allowlist, shared helper | ✓ |
| Extend /api/batch/admin-proxy | One route, ~40 actions | |
| Per-domain routes | REST endpoints per domain | |

| Option | Description | Selected |
|--------|-------------|----------|
| No cache — passthrough | Parity first | ✓ |
| Short Redis cache | 30–60s TTL, invalidate on write | |

**Notes:** Phase 76 rules (session-only auth, 401-only re-login, reads-retry/writes-don't, batch_id cache bust) carried forward without re-asking.

---

## Public batch page

| Option | Description | Selected |
|--------|-------------|----------|
| Staff, on the floor via QR | Writes must keep working | ✓ |
| Customers | Keep writes | |
| Nobody — view only | Could go read-only | |
| Not sure | Keep for parity | |

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated token routes | GET + 2 POSTs, Apps Script validates token, rate limit | ✓ |
| Middleware validates token | Sets up Phase 87 better | |

| Option | Description | Selected |
|--------|-------------|----------|
| Keep interval, rate limit only | Parity | ✓ |
| Short cache on public GET | 30s Redis per batch | |

---

## Direct Sheets API + rollout

| Option | Description | Selected |
|--------|-------------|----------|
| Route Ingredients through /api/admin/proxy | Browser needs Google only at login | ✓ |
| Leave it — out of scope | Record as known direct read | |

| Option | Description | Selected |
|--------|-------------|----------|
| Delete fallbacks | Single code path | ✓ |
| Keep, gate on MIDDLEWARE_URL | Escape hatch | |

| Option | Description | Selected |
|--------|-------------|----------|
| Apps Script first, then code | One redeploy, staging walk, single prod cutover | ✓ |
| Two waves | Two redeploys | |

| Option | Description | Selected |
|--------|-------------|----------|
| Checklist plan at start | Blocking human checkpoint, parallel to code | ✓ |
| Answer some now | | |

## Claude's Discretion

- Shared helper extraction/naming, rate-limit numbers, adminApiGet/Post internals, parity test design.

## Deferred Ideas

- Retire Res/Holds tab + Reservations/Holds/Kits sheets (Phase 88); rehome kit-SKU registry (Phase 88); middleware batch-token validation (Phase 87); caching admin/public reads (only if needed).
