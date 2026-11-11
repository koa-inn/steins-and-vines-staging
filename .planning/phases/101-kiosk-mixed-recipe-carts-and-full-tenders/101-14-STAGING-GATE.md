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

## D-17 (owner terminal sale) - PASSED, owner "approved"

Evidence verified by the orchestrator via the Zoho Books API (staging org 110002406307).

| Item | Value |
|------|-------|
| Invoice | **INV-000267** (invoice_id 109900000001869101), ref KIOSK-1794421520565 |
| When / how | 2026-11-11 10:25 PT, staging terminal, manual confirm |
| Status | paid, balance 0 |
| Card charge | $100.09 (ONE payment) |
| Zoho invoice total | $100.09 = sub_total 96.67 + tax 3.09 + adjustment 0.33 ("Recipe package price"); charge == total |
| Invoice count | ONE invoice for the mixed sale |
| Lines | Product "1 Piece S-type Airlock" (sku 13102) $2.00 @ BC PST+GST 12% first, then recipe "Bavarian Style Lager" (in-store, 28 L, SV-R-000016): 13 ingredient lines (zero-rated) + Brewing Fee $45 (GST) + Materials Fee $5 (PST+GST). Matches 101-06 ordering. |
| Stock drop | Confirmed. Gambrinus Pilsner Malt 25.7 -> 21.08 kg across the two test sales (4.62 kg each); airlock stock_on_hand 10 after sale |
| BrewPad batch | Confirmed by owner, id not captured |
| Void | Charge voided in Helcim per owner; void reference not captured |
| Owner | "approved" |

Supplementary: earlier recipe-only sale **INV-000266** ($97.85 = 95 + 2.85 tax + 0.33 adj; 18:21Z) also booked as one invoice.

Open housekeeping: INV-000266 and INV-000267 remain status "paid" in Zoho (a Helcim void does not touch Zoho). Reverse/void these test invoices manually.

### Issues found during the gate

1. **Bug (fixed, a8828ab8, pushed to staging):** the kiosk sends `recipes[].modified_ingredients: null` for unmodified recipes; `validateRecipeEntries` rejected null, so every `/api/kiosk/cart-quote` returned 400 and the cart showed $0. Fix treats null as absent; regression test `zoho-middleware/__tests__/recipe-entries-null-modified-101.test.js`. Suites green after fix (middleware 311/4374, frontend 258/3558, lint clean). Root gap: server tests never sent null, client tests mocked the server.
2. **Ops, pre-existing (must be handled before Plan 15 prod release):** after a middleware redeploy the ingredient catalog (Redis `zoho:ingredients:all` + `ingredients-all-cache.json`) is empty; staging has `ZOHO_SCHEDULED_JOBS=off`, so recipe-quote/cart-quote 503 ("Price unavailable - check connection"). Each recipe sale also busts the Redis keys, so if the file fallback was never written the next quote 503s. Warmed manually via `GET /api/ingredients` until the log showed "Wrote file fallback (212 items)". Prod needs either a full catalog rebuild right after deploy or (recommended) a follow-up fix so `getIngredientCatalog` refreshes instead of 503 when Redis and file are both empty.
3. `docs/DEPLOYMENT.md` lists `staging-api.steinsandvines.ca`, which does not resolve; real host is `svmiddleware-staging.up.railway.app`.
4. One `/api/kiosk/sale` 502 "Terminal error" at 18:21:19Z just before INV-000266 (terminal retry, no booking).
