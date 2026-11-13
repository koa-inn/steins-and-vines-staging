# BrewPad dashboard perf harness (Phase 99)

Local, repeatable Lighthouse + axe + overflow harness (D-05 / D-06). Nothing under
`js/`, `css/` or `brewpad.html` is a test seam: the seed script and Google Identity
stub are injected into the served HTML by `server.mjs` only.

**Everything under `tests/` is publicly served on production** (only `.planning/` is
stripped). Never commit raw captures; `tests/perf/.raw/` and `tests/perf/results/` are gitignored.

## Requirements

Node 24 (lighthouse 13 needs >= 22.19; the local default Node may be 20):

    source ~/.nvm/nvm.sh && nvm exec 24 npm run perf

## Commands

| Command | What it does |
|---------|--------------|
| `npm run perf` | Serve the repo root + fixture on 127.0.0.1:8099, run Lighthouse mobile (3 cold, median), 1 warm, 1 desktop, axe at 1280/820/390 (+ expanded sections at 390), scrollWidth at 360/320. Exits 1 if mobile perf median < 0.85, axe serious+critical > 0, or overflow. |
| `npm run perf:baseline` | Same, but `--report-only` (always exit 0). |
| `npm run perf:capture` | Headed Chromium on staging to record read-only `get_*` responses to `tests/perf/.raw/capture.json`. Write actions are aborted. |

Flags for run.mjs: `--root <dir>` (e.g. a git worktree of an older commit), `--fixture <path>`
(default `tests/perf/fixture/dashboard-fixture.json`; `fixture/smoke-fixture.json` is an
empty-data fixture used to prove the auth path), `--port`, `--report-only`.
Results land in `tests/perf/results/latest.json`.

`perf:capture` ends on Enter, or SIGINT/SIGTERM, or when the file `tests/perf/.raw/DONE`
appears (for background runs).

## Cold vs warm

Cold: Lighthouse clears storage; `seed.js` also removes `bp_dash_cache*` keys. Warm: one
priming load, then a run with `?warm=1` and Lighthouse storage reset disabled, so a dashboard
cache (plan 99-04) and the HTTP cache stay in place.

## What the server rewrites at serve time

- `/brewpad.html`: inserts `/__harness/seed.js` first in head, swaps the Google GSI script for
  `/__harness/gsi-stub.js`, removes the Google Fonts link tags (fonts blocked for determinism:
  identical fallback metrics every run).
- `/js/sheets-config.js`: `MIDDLEWARE_URL` becomes `location.origin`. Local dev otherwise resolves
  to the PRODUCTION middleware, so this rewrite is mandatory.
- Mocks: `POST /api/batch/admin-proxy` (by `action`, from the fixture), `POST /auth/google`,
  and `GET /api/admin/packaging-bookings` / `/api/admin/dashboard-cards` (fixture `__rest`).
  Any miss returns 404 and is logged (`/__harness/misses`); the runner warns on misses.
- Defence in depth: `seed.js` wraps `fetch` to reject `*.up.railway.app`, googleapis, Google
  accounts/script hosts and font CDNs, and the runner launches Chrome with
  `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` so nothing but 127.0.0.1 can
  resolve at all. The server binds 127.0.0.1 and has no outbound client.

## Boot requests (recon of a stored session, 2026-11-12)

Page load with a valid `sv-brewpad-session` (token valid, expires_at > now + 5 min):

1. Static: brewpad.html, css/brewpad.min.css, js/lib/*.js, js/sheets-config.js, js/admin-config.js,
   js/vendor/qrcode.min.js, js/vendor/jspdf.umd.min.js, js/brewpad.min.js, GSI client script
   (`https://accounts.google.com/gsi/client`, stubbed), Google Fonts (removed).
2. `initGoogleAuth()` -> `gsiInitTokenClient` (GSI stub). Stored-token fast path: no Google call.
3. `checkAuthorization()`: `POST {MIDDLEWARE_URL}/auth/google` `{access_token}` -> `{authorized:true, token}`;
   stores `sv_session_token`, calls `showApp()`.
4. `showApp()` -> `eagerLoad()`: five `POST /api/batch/admin-proxy` actions: `get_dashboard_stats`,
   `get_batches {status:'all'}`, `get_vessels`, `get_ferm_schedules`, `get_tasks_upcoming {limit:200}`.
5. Dashboard v2 (`bp_dash_v2 = '1'`): `POST admin-proxy get_tasks_calendar`, `POST admin-proxy get_waitlist`,
   `GET /api/admin/packaging-bookings`, `GET /api/admin/dashboard-cards`.
6. v1 only: `GET /content/zoho-snapshot.json` (not requested in v2).
7. Fallback only: `get_batch_dashboard_summary` if `get_dashboard_stats` fails.
8. `fetchGoogleUserInfo` (googleapis userinfo) is not called on the stored-token path.

Observed on the smoke run: 1 `/auth/google`, 7 admin-proxy, 2 `/api/admin/*` GETs, 0 external requests.

## Accepted limits

- No Railway latency: the mock answers instantly, so TTI/TBT are optimistic (RESEARCH Pitfall 6).
- Fonts are blocked, so text metrics differ slightly from production.
- Lab numbers only; no real-device throttling.
- Lighthouse simulated throttling is deterministic, so the three cold runs are near-identical.
