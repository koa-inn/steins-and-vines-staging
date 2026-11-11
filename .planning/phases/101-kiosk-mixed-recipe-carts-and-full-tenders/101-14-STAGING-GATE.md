# Phase 101 Plan 14 - Staging Gate Evidence

## Gates on HEAD 55868c68 (before push)

| Gate | Result |
|------|--------|
| Frontend `npm test` | 258 suites, 3558 tests passed |
| Middleware `npm test` (Node 24) | 310 suites, 4371 tests passed |
| `npm run lint` | clean (0 warnings) |
| `npm run build` + `git status --porcelain` | Only build-stamp noise: 27 tracked files (public/staff HTML `?v=` stamps, `js/admin.js` + `js/admin.min.js` BUILD_TIMESTAMP). Verified every changed line was a `v=` or BUILD_TIMESTAMP line, then restored with `git checkout --`. No real drift. |

## Push order

- M (last middleware-only commit) = `fd4813e21a6c7f9963d17b491ffdf5538d11cf19` (docs(101-07)); first frontend commit F = `39ab8bc2` (refactor(101-08)); F^ = M.
- HEAD = `55868c68661c43d3397a21a3bd66e475f537f0b0`
- Push 1: `git push origin M:main` (fast-forward bbca0f28..fd4813e2) at 2026-11-10T23:26:47Z.
- Staging middleware: `https://svmiddleware-staging.up.railway.app` (the `staging-api.steinsandvines.ca` host in docs/DEPLOYMENT.md does not resolve in DNS; docs are stale on this).

## Deploy evidence (before main push)

- `/health` at 2026-11-11T00:06:14Z: `status ok, authenticated true, redis true, database true`, uptime 2172.7 s, so process start was about 23:30Z, i.e. about 3 min after Push 1: Railway redeployed from M.
- cart-quote probe (no auth), 2026-11-11T00:06Z: `POST /api/kiosk/cart-quote` -> **403 {"error":"Forbidden"}** (not 404).
- Caveat: a nonexistent route `/api/kiosk/nonexistent-xyz` also returns 403 (auth guard runs before routing), and `/api/kiosk/recipe-sale` shows 403 not 410. So the unauthenticated probe is not a discriminating proof that the route exists; the restart-after-push evidence is the stronger signal. Task 2 sale exercises cart-quote authenticated.
- Local sandbox blocks outbound DNS; curl needed to run outside the sandbox.

## Frontend push

- Push 2: `git push origin main` after this gate file was committed (timestamp recorded below in the push log).
- Staging kiosk.html `?v=` stamp check: staging is behind Cloudflare Access; owner confirms visually in Task 2 (reload kiosk first).

## D-17 (owner terminal sale)

Pending - to be filled in from owner report: invoice number, card charge, Zoho invoice total, stock-drop confirmation, BrewPad batch id, void reference, owner "approved".
