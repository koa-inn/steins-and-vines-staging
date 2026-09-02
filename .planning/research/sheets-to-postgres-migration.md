# Google Sheets → Postgres: decision-grade assessment

**Researched:** 2026-09-02
**Scope:** the operational data store behind `apps-script/adminApi.gs` (the Steins & Vines
Google Sheets workbook), and whether it should move to Postgres on Railway.
**Prior art:** `.planning/notes/recipe-save-performance-and-sheets-scaling.md` (2026-09-02).
**Method:** full read of `adminApi.gs` (4,116 lines) + the three sibling `.gs` files, grep of
every dependent JS file, review of `.planning/STATE.md`, phase docs, `docs/DATA-MODEL.md`,
`docs/APPS_SCRIPT.md`, and the project memory files; plus current web research on Railway
Postgres, Apps Script quotas, and Node query layers.

---

## 0. Verdict

**Do not migrate the whole store. Migrate exactly one sheet — `GiftCards` — and stop.**

That is a sharper answer than the first-pass note's "do not migrate yet, decide with
measurements." Measurements will not change the answer for 14 of the 16 sheets, because the
thing that would justify moving them (volume, contention) is not what is actually broken. What
*is* actually broken is a **specific, reproducible, money-losing atomicity defect in
`redeemGiftCard`** that no amount of Apps Script batching fixes, because Sheets has no
transaction. That is a ~3–5 day job, not a 25–40 day one.

Everything else stays on Sheets until a named trigger fires (§9).

**Where I contradict the existing note, loudly:**

| Note said | Reality |
|---|---|
| "`acquireScriptLock()` serializes **every** write across the entire script" | **False.** 11 of ~32 write functions take the lock. 21 do not — including `updateBatch`, `deleteBatch`, `updateReservation`, `updateHold`, `createFermSchedule`, `updateGiftCardInvoice`, and the `onFormSubmit` trigger. The problem is not that the lock is too broad; it's that **it is too narrow and applied inconsistently**. |
| "Money paths first (GiftCards, **Reservations**, POS)" | Reservations in Sheets is a **fire-and-forget mirror** of the Zoho Sales Order (`checkout-helpers.js:91` — `notifyAdminPanel`). Zoho is the system of record. Reservations/Holds are display convenience and should be migrated **last or deleted**, not first. There is no "POS sheet" — POS money lives in Zoho + Redis. The only true money-of-record sheet is **GiftCards**. |
| "14 sheets" | **16.** The note missed `Vessels` (read by `getVessels`, written by `setVesselStatus`, **no admin UI at all**) and `ProductEvents` (written by the separate `trackEvent.gs` deployment). |
| "9 dependent files" | Roughly right for the middleware, but it undercounts the frontend: `js/admin.js` alone has **50 direct Apps Script call sites** and is the single largest coupling in the system. |
| "It is already contributing to the current failure" (lock, re: recipe save) | **Unsupported.** I found no evidence anywhere in the repo — logs, `.planning/debug/`, STATE.md, memory files — of a single observed `LockService` timeout. The recipe-save 15s failure is fully explained by the ~54 round-trips. Attributing any of it to the lock is speculation. |

**Where the note was right, and I'm moving on:** the N+1 diagnosis, the round-trip accounting,
the "fix Phase 79 first" ordering, and "migrating to fix *this* would carry the same N+1
patterns into the new store." All correct. Phase 79 should ship before anything here is
considered.

---

## 1. Verified migration surface

### 1.1 Headline numbers (re-derived)

| Metric | Note claimed | Verified | Notes |
|---|---|---|---|
| `adminApi.gs` lines | 4,116 | **4,116** ✅ | |
| Actions | 55 | **54** | 61 `case`/`===` string literals minus 7 status values (`pending`, `confirmed`, `archived`, `brewing`, `ready`, `completed`, `cancelled`). Close enough. |
| Sheets | 14 | **16** | +`Vessels`, +`ProductEvents` |
| Apps Script projects | (not stated) | **≥2, likely 3 deployments** | `adminApi.gs` has two deployments (`ADMIN_API_URL` execute-as-user; `FEATURED_API_URL` execute-as-me). `trackEvent.gs` is a separate project (it defines its own `doPost`). `onFormSubmit.gs` + `backup.gs` are container-bound alongside `adminApi.gs`. |
| Total `.gs` lines to port | — | **4,638** | incl. `backup.gs` (303), `onFormSubmit.gs` (153), `trackEvent.gs` (66) |
| Middleware test files touching Apps Script | — | **22 of 102** | |
| Frontend test files touching `adminApi*` | — | **15 of 92** | |

### 1.2 Per-sheet table

Hotness is inferred from call-site count and workflow frequency, not from measurement — I
cannot read the live workbook. Treat hotness as a ranked ordering, not an absolute.

| # | Sheet | Written by | Read by | Hot | Money | Locked? | Sheets-ness dependency | Portability |
|---|---|---|---|---|---|---|---|---|
| 1 | **GiftCards** | `issueGiftCard`, `redeemGiftCard`, `reloadGiftCard`, `voidGiftCard`, `updateGiftCardInvoice` | `lookupGiftCard` (every kiosk sale with a GC), `getGiftCards` (kiosk admin) | Med | **YES — balance of record** | 4 of 5 (`updateGiftCardInvoice` is **not**) | Owner reads it to answer "what's on this card?"; no other UI besides kiosk.html §Gift Card Management | **Trivially portable, must move** |
| 2 | **Recipes** | `createRecipe`, `updateRecipe`, `deleteRecipe` | `getRecipes`, `getRecipeDetail`, public `/api/recipes`, `pos-recipe.js` pricing | Med | Yes (drives sale price) | ✅ all 3 | Owner likely hand-edits `locked_price`, `status` | Entangled (pricing + Phase 73 unit guard) |
| 3 | **RecipeIngredients** | same three | same | Med | Yes | ✅ | Owner hand-edits units/quantities — **this is how the Lactic-Acid `L`→`kg` fix was applied** | Entangled |
| 4 | **Batches** | `createBatch`, `updateBatch`, `deleteBatch`, `updateBatchSchedule`, `regenerateBatchToken`, `pos.js` reconcile | `getBatches`, `getBatchDetail`, `getBatchDashboardSummary`, `checkLocationConflict`, dedup guard, public `batch.html` | **Highest** | Money-adjacent (created by kiosk sale, synced to Zoho invoice field) | `createBatch` only | Owner scans it constantly for shop-floor state; `deleteBatch` cascades to 3 child sheets | **Genuinely entangled** |
| 5 | **BatchTasks** | `createBatch` (N-row loop), `addBatchTask`, `updateBatchTask`, `bulkUpdateBatchTasks`, `handlePackagingCompletion/Uncompletion` | `getBatchDetail`, `getTasksCalendar`, `getTasksUpcoming`, dashboard | **Highest** | No | `addBatchTask` only | Likely the largest sheet (~178 batches × 8–12 steps ≈ 1,400–2,100 rows) | Portable, but volume + cascade |
| 6 | **PlatoReadings** | `addPlatoReading` (locked, **per reading**), `bulkAddPlatoReadings` (loop → locks up to 20×), `updatePlatoReading`, `deletePlatoReading` | `getBatchDetail`, `batch.html` chart | Med | No | per-reading | Owner may paste readings in bulk | **Trivially portable** |
| 7 | **VesselHistory** | `createBatch`, `updateBatch` (transfer) | `getBatchDetail` ×2 | Low | No | inherits caller | Append-only audit log | **Trivially portable** |
| 8 | **FermSchedules** | `createFermSchedule` (**unlocked, generates IDs**), `updateFermSchedule`, `deleteFermSchedule`, `propagateFermSchedule` | `getFermSchedules`, `createBatch` snapshot | Low | No | `propagate` only | Owner edits step templates | **Trivially portable** |
| 9 | **Vessels** | `setVesselStatus` only | `getVessels` (BrewPad + admin dropdowns) | Low | No | ❌ | **Hand-edited only — there is no UI to add/rename/remove a vessel anywhere in the codebase** | Portable, **but needs new admin CRUD first** |
| 10 | **Config** | *nothing in code* | `checkAuthorization` (`staff_emails`, 5-min `CacheService` TTL), `getConfig` (**no caller**), `server_token` | Low | No | ❌ | **Hand-edited only. It is the staff auth allowlist and the shared server secret.** | Portable, **needs new admin CRUD + secret relocation** |
| 11 | **Reservations** | `addReservation` (public checkout, fire-and-forget), `updateReservation`, `onFormSubmit` trigger | `getReservations`, `getDashboardSummary` | Low | **No — mirror of Zoho SO** | ❌ | Legacy pre-Zoho workflow | **Delete candidate, not migrate candidate** |
| 12 | **Holds** | `onFormSubmit`, `updateHold` | `getHolds`, dashboard | Low | No | ❌ | Legacy pre-Zoho | **Delete candidate** |
| 13 | **Kits** | `updateKits` (**no caller in repo**), `onFormSubmit` increments `on_hold` | `getKits` (admin + `brewpad-integration.js` kit registry) | Low | No | ❌ | Zoho Inventory is now SoT for products; this is a stale registry | **Delete candidate** (verify kit registry first) |
| 14 | **Schedule** | `updateSchedule` (**no caller in repo**) | `getSchedule` (admin) **+ `PUBLISHED_SCHEDULE_CSV_URL` → public site opening hours** | Low write / **public read** | No | ❌ | **Served straight from Google's CDN to every public page** (`js/modules/13-init.js:649,863`) | See §1.3 |
| 15 | **Homepage** | `updateHomepage` | `getHomepage` (**no caller**) **+ `PUBLISHED_HOMEPAGE_CSV_URL` → footer social links** | Low / **public read** | No | ❌ | Same CDN path (`13-init.js:959`) | See §1.3 |
| 16 | **ProductEvents** | `trackEvent.gs` (separate deployment, no lock) | *nothing in this repo* | Low | No | ❌ | Append-only analytics; presumably read via pivot table in the sheet | Trivially portable or **delete** |

**Trivially portable:** PlatoReadings, VesselHistory, FermSchedules, GiftCards, ProductEvents.
**Delete candidates (do this before migrating anything):** Reservations, Holds, Kits, `getConfig`, `updateSchedule`, `updateKits`, `getHomepage`. Seven actions with zero callers — that's ~13% of the action surface removable for free.
**Genuinely entangled:** Batches, BatchTasks, Recipes, RecipeIngredients, Config, Vessels.

### 1.3 The surface the note missed entirely: published-CSV public reads

`Schedule` and `Homepage` are consumed by the **public site** via `docs.google.com/.../pub?output=csv`
URLs, bypassing Apps Script and the middleware completely. Google's CDN serves them, free,
with no Railway dependency.

Migrating those two sheets to Postgres **converts a CDN-served static read into a
Railway-uptime dependency for opening hours and footer links on every public page.** That is
an availability *regression* on the highest-traffic surface in the system. There is a local
fallback (`/content/timeslots.csv`), but nobody keeps it current.

Verdict: **never migrate Schedule or Homepage.** If you want them off Sheets, move them into
the repo as committed content (the same pattern already used for `content/zoho-snapshot.json`),
not into Postgres.

### 1.4 Architectural seam that makes this far cheaper than it looks

Phase 76 introduced `POST /api/batch/admin-proxy` (`zoho-middleware/routes/pos.js:4026`) — an
allowlisted, session-authenticated middleware endpoint through which **BrewPad routes every
batch, schedule, reading, and vessel call**. 17 actions pass through it.

This is the single most important fact for costing a migration and the note does not mention
it. It means:

- `js/brewpad.js` (9,536 lines) needs **zero changes** to migrate Batches/BatchTasks/PlatoReadings/FermSchedules/Vessels. You swap the implementation behind the proxy.
- The same is already true for recipes (`routes/recipes.js`), gift cards (`routes/gift-cards.js`), and recipe sales (`routes/pos-recipe.js`) — all of which are middleware-mediated.

**The one surface with no seam is `js/admin.js`** — 50 direct `adminApiGet`/`adminApiPost`
calls straight to `ADMIN_API_URL` with the staff Google OAuth token. Plus `js/batch.js`
(public batch view, direct). Any migration must either route admin.js through the middleware
first (a separable, low-risk prerequisite worth doing anyway) or rewrite 50 call sites during
the cutover.

---

## 2. The concurrency ceiling — quantified

### 2.1 Where the lock actually is

11 call sites, all `LockService.getScriptLock()` via `acquireScriptLock` (`adminApi.gs:1235`):

| Function | Line | Timeout | Ops held under lock (est.) |
|---|---|---|---|
| `createBatch` | 2107 | 15,000 ms | **~12 + 2×N steps** (`generateNextId` full-column scan + `appendRow` per BatchTask) |
| `addBatchTask` | 2728 | 10,000 ms | ~3 |
| `addPlatoReading` | 2858 | 10,000 ms | ~3 |
| `propagateFermSchedule` | 3130 | 15,000 ms | ~3 + per-batch |
| `createRecipe` | 3501 | 15,000 ms | ~15 + 2×ingredients |
| `updateRecipe` | 3588 | 15,000 ms | **~54** (pre-Phase-79) |
| `deleteRecipe` | 3695 | 15,000 ms | ~15 |
| `issueGiftCard` | 3843 | 15,000 ms | ~3 |
| `redeemGiftCard` | 3925 | 15,000 ms | ~6 |
| `reloadGiftCard` | 3985 | 15,000 ms | ~6 |
| `voidGiftCard` | 4032 | 15,000 ms | ~5 |

### 2.2 Where the lock is *not*, and should be

Unlocked writers to the same workbook — **21 functions**:

`updateBatch`, `deleteBatch` (cascades across 3 sheets), `updateBatchSchedule`,
`updateBatchTask`, `bulkUpdateBatchTasks`, `updatePlatoReading`, `deletePlatoReading`,
`createFermSchedule` (**generates `FS-` IDs with no lock — ID collision is possible**),
`updateFermSchedule`, `deleteFermSchedule`, `regenerateBatchToken`, `setVesselStatus`,
`addReservation`, `updateReservation`, `updateHold`, `updateSchedule`, `updateHomepage`,
`updateKits`, `handlePackagingCompletion/Uncompletion`, **`updateGiftCardInvoice`**,
plus the `onFormSubmit` spreadsheet trigger and the entirety of `trackEvent.gs` (separate
project → **separate lock namespace**, so it can never contend with `adminApi.gs` anyway).

`updateGiftCardInvoice` is the one that matters: it writes the `GiftCards` sheet — including
`last_updated` — while `redeemGiftCard` believes it holds an exclusive lock on that row. And
`pos.js:1750–1770` calls `issue_gift_card` then `update_gift_card_invoice` back to back on the
sale path.

### 2.3 Is contention theoretical or already biting?

**Theoretical, on the evidence available.** I searched `.planning/` (including all 4
`.planning/debug/` files), `docs/`, `STATE.md`, `ROADMAP.md`, and all 8 project memory files
for any observed `LockService` timeout, "could not obtain lock", or contention symptom.
**Zero hits.** The Aug-2026 kiosk orphan incident was Helcim terminal latency, not Sheets.
The INV-000137 lost-batches incident was a dedup-guard logic bug, not contention.

**But there is one realistic, already-live contention path**, and it is on the kiosk money
path:

`lib/brewpad-integration.js:369` — *"Creates fire in parallel"*. A multi-kit invoice fires N
concurrent `create_batch` calls. Each:

1. Runs the invoice+SKU dedup guard **outside** the lock (`adminApi.gs:2036–2074`).
2. Then queues on the global lock.
3. Then holds it for ~12 + 2×steps Sheets ops.

At Apps Script's typical 100–500 ms/op and an 8-step schedule, one `createBatch` holds the
lock for **2.8–14 seconds**. Three parallel units means the third waits up to ~28 s before
starting work — against a **12,000 ms axios timeout** in `callAppsScriptCreateBatch`
(`brewpad-integration.js:275`).

Consequences, in order of how bad they are:

1. **Middleware gives up while Apps Script is still working.** It queues a Redis retry
   (`queueForRetry`) that fires 5 minutes later. The batch does eventually appear — but the
   Zoho batch-status sync already fired with `okCount` = 2 instead of 3, so the invoice's
   batch field is wrong and nobody notices.
2. **The dedup guard is TOCTOU-broken.** Because the guard reads `Batches` *before* acquiring
   the lock, N concurrent calls all observe the same "0 of 3 existing" and all pass. The lock
   then serializes the writes but the invariant it exists to protect was already decided on a
   stale read. Under genuine concurrency the guard does not guarantee ≤ `unit_total` batches.
   (Retries are serialised in time, so the common case self-heals — which is exactly why this
   has never been observed.)

**Hard ceiling from Google:** simultaneous executions are capped at **30 per user** and 1,000
per script. Every middleware call runs as one identity (the deployment owner), so 30 is the
real cap. At current shop scale — 1 owner, occasional second staffer, ~178 batches/year —
concurrency is nowhere near a ceiling. The problem is not throughput; it's that a single
operation is slow enough to collide with itself under a 12 s client timeout.

**Conclusion:** the lock is not the forcing function. **Lock hold *duration* is.** And hold
duration is fixed by the same Phase 79 batching work — hoist `generateNextId` out of the
`BatchTasks` loop and batch the appends and `createBatch` drops from ~28 ops to ~5, taking the
hold from seconds to sub-second. That removes the contention risk without a migration.

**Phase 79 should be extended to cover `createBatch` and `bulkAddPlatoReadings`, not just
`updateRecipe`.** `bulkAddPlatoReadings` acquires and releases the global lock **up to 20
times in a single request** because it loops over `addPlatoReading` — that is the worst
lock-thrash in the file and the note does not mention it.

---

## 3. Atomicity: the one defect that *does* justify Postgres

The note said "no transactions" generically. Here is the concrete instance, and it is worse
than the recipe-rewrite example it cited.

**`redeemGiftCard` (`adminApi.gs:3925–3966`) decrements a real customer balance across four
separate, independently-committing `setValue()` calls, in this order:**

```js
sheet.getRange(result.row, balCol).setValue(newBalance);      // 1. money leaves the card
sheet.getRange(result.row, statusCol).setValue(newStatus);    // 2.
sheet.getRange(result.row, updatedCol).setValue(now);         // 3.
sheet.getRange(result.row, txRefCol).setValue(txRef);         // 4. idempotency key recorded LAST
```

The idempotency guard at the top of the function is `if (String(gc.last_tx_ref) === String(txRef))`.

**So if execution dies between (1) and (4) — Apps Script 6-minute cap, a transient Sheets
error, a Google-side restart — the balance is decremented and the idempotency key is not
written. A retry with the same `transaction_ref` will not be recognised as idempotent and will
decrement the balance a second time.** That is a silent double-spend against a customer,
caused by a crash window that a transaction would close completely.

Same shape, lower stakes, elsewhere:

- `updateRecipe` — delete 13 rows, then re-insert 13. Dying midway (which *is* what the 15 s
  timeout was doing) leaves a recipe with partial ingredients. On a dynamic-priced recipe that
  silently changes the sale price.
- `deleteBatch` (`adminApi.gs:2449`) cascades across `BatchTasks`, `PlatoReadings`,
  `VesselHistory` with no rollback — a partial cascade orphans child rows against a deleted
  parent.
- `createBatch` writes the batch row, then N task rows, then vessel history, then vessel
  status, catching and *swallowing* per-step errors into a `warnings` array. A batch can be
  created with a partial task list and the caller gets `ok: true`.

**This is the real argument for Postgres, and it is confined almost entirely to `GiftCards`.**
Recipes and Batches have partial-write bugs too, but their blast radius is "staff notice and
re-save." GiftCards' blast radius is "customer is charged twice and we can't prove otherwise."

---

## 4. Staged migration plan

Ordered by value-per-risk, not by the note's ordering (which put Reservations second — wrong,
see §0). Each stage is independently shippable and independently abandonable.

### Stage 0 — Prerequisites (do these regardless of whether you ever migrate)

| Item | Effort | Why |
|---|---|---|
| Ship Phase 79 batching, **extended to `createBatch` and `bulkAddPlatoReadings`** | 2–3 d | Removes the timeout AND the only realistic contention path. Owner redeploy required. |
| Delete the 7 zero-caller actions + their sheets-of-record decision (`get_config`, `update_schedule`, `update_kits`, `get_homepage`, and the Reservations/Holds/Kits legacy trio) | 1 d | Shrinks the surface ~13% for free. Verify `brewpad-integration.js:122` kit registry first — it *does* call `get_kits`. |
| Move `updateGiftCardInvoice` under the lock; move the `createBatch` dedup guard **inside** the lock | 0.5 d | Closes the two lock holes. Owner redeploy. |
| Route `js/admin.js` through `/api/batch/admin-proxy` instead of `ADMIN_API_URL` | 3–4 d | The seam that makes every later stage cheap. Worth doing on its own merits (it also unifies auth). |

**Total: ~7 days.** After this, re-measure. If the numbers are fine — and I expect they will
be — stop here for everything except Stage 2.

### Stage 1 — Infrastructure

- Provision Postgres in the Railway `sv-middleware` project, **both environments** (this alone
  fixes the "staging writes to live prod data" problem noted in STATE.md).
- Add `pg` to `zoho-middleware/dependencies`. **Note `railway.toml` runs
  `npm install --production`** — migration tooling must be a *production* dependency or run
  as a separate step.
- `lib/db.js`: a single `pg.Pool`, `query()`, and `withTransaction(fn)` helper. ~80 lines.
- Migration runner + `migrations/0001_init.sql`.
- Jest harness: one Postgres per test *process*, one database per test *file*, migrations run
  once. Wrap each test in `BEGIN`/`ROLLBACK` where the code under test uses a single connection.
- `validateEnv.js`: register `DATABASE_URL` as required.

**Effort: 2–3 days. Rollback: delete the service; nothing depends on it yet.**

### Stage 2 — GiftCards (THE migration)

This is the only stage I actually recommend committing to.

**What moves:** the `GiftCards` sheet → a `gift_cards` table + a `gift_card_transactions`
ledger table (append-only; the current schema has only `last_tx_ref`, which is why the
idempotency window exists at all).

**Cutover strategy — read-through, then flip:**

1. Migration script exports the sheet to `gift_cards` (one-time; the workbook is small).
2. `routes/gift-cards.js` and the four `pos.js` call sites (`:1709`, `:1750`, `:1770`, `:1789`)
   plus the two `lookup_gift_card` sites (`:740`, `:1402`) gain a `GIFT_CARDS_STORE` env flag:
   `sheets` (default) | `dual` | `postgres`.
3. **`dual` phase (1–2 weeks):** Postgres is authoritative for reads and writes; the Apps
   Script call still fires **fire-and-forget** so the sheet stays a human-readable mirror.
   Discrepancies logged to Sentry.
4. Flip to `postgres`. Leave the sheet as a read-only mirror indefinitely — it costs nothing
   and preserves the owner's "open the sheet and look" affordance.

**Redeem becomes:**
```sql
BEGIN;
  INSERT INTO gift_card_transactions (cert_number, tx_ref, amount)
    VALUES ($1,$2,$3) ON CONFLICT (tx_ref) DO NOTHING;   -- idempotency, atomically
  UPDATE gift_cards SET current_balance = current_balance - $3, ...
    WHERE cert_number = $1 AND current_balance >= $3 - 0.001;
COMMIT;
```
One statement pair, one commit, no crash window, no global lock, no 15 s wait.

**Rollback:** flip the env var back to `sheets`. The sheet was never stopped being written
during `dual`, so rollback is instant and lossless. After the flip to `postgres`, rollback
requires replaying the Postgres ledger back into the sheet — keep the `dual` phase running
until you trust it.

**What breaks for staff:** nothing during `dual`. After the flip, hand-editing a balance in
the sheet stops taking effect. Mitigate with a "balance adjust" button in the existing
kiosk.html Gift Card Management screen (~half a day).

**Effort: 3–5 days including tests. This is the whole recommendation.**

### Stage 3 — Recipes + RecipeIngredients *(only if triggered)*

Moves together (FK). Value is real — stable ingredient IDs (currently churned on every save,
per the note) and an atomic ingredient rewrite.

> **CORRECTION (2026-09-02, from live data during Phase 79 execution):** an earlier draft of this
> section proposed "a genuine unique constraint on `(recipe_id, item_id)`" as a benefit.
> **That constraint is wrong and would reject real production data.** Recipe `SV-R-000002` has
> **three** ingredient rows carrying the same `item_id` (`109900000000621293`) out of 13 rows —
> a recipe legitimately doses the same catalog item at multiple stages/quantities. Any
> `recipe_ingredients` schema must treat `ingredient_id` as the sole key and allow repeated
> `(recipe_id, item_id)` pairs. Phase 79's D-09 id-honouring logic correctly keys on
> `ingredient_id`, not `item_id`, and handles the duplicates.

But Phase 79 already makes saves fast, and the Phase 73/74 pricing
guards live in `js/lib/recipe-scaling.js`, not in the store — so Postgres buys correctness in
one narrow place. Seam already exists (`routes/recipes.js`, `pos-recipe.js`).
**Effort: 4–6 days.** Staff lose the ability to hand-fix a bad unit in the sheet — but the
Phase-79-era editable unit dropdown already covers that case in-app.

### Stage 4 — Vessels + FermSchedules + Config *(only if triggered)*

Small tables, trivially portable, **but each requires new admin CRUD that does not exist
today** (§6). `Config` also means relocating `server_token` and `staff_emails` — the latter is
the auth allowlist, so this stage has a security review attached. **Effort: 2–3 days port +
2–3 days CRUD.**

### Stage 5 — Batches + BatchTasks + PlatoReadings + VesselHistory *(the big one)*

Only worth it if BatchTasks growth actually starts biting the linear scans. The admin-proxy
seam covers BrewPad, but `js/admin.js` and `js/batch.js` (public batch view, direct to Apps
Script) both need rewiring — which is why Stage 0's admin.js work matters.
**Effort: 8–12 days.** Dual-write here is genuinely hard (four correlated tables, a public
token-authenticated read path) — I'd do a maintenance-window cutover instead, on a Sunday.

### Stage 6 — Retire the legacy sheets

Reservations/Holds/Kits: **delete, don't migrate.** Schedule/Homepage: **move to committed
repo content, not Postgres** (§1.3). ProductEvents: delete or leave alone.
**Effort: 3–5 days.**

### Honest total

| Path | Effort | My recommendation |
|---|---|---|
| Stage 0 only | ~7 days | **Do this now** |
| Stage 0 + Stage 2 (GiftCards) | ~12 days | **Do this. This is the answer.** |
| Everything through Stage 6 | **25–40 developer-days** | Don't, unless §9 fires |

25–40 days for a solo developer running a business is 3–6 months of evenings, during which the
system is in a partially-migrated state and every stage needs an owner Apps Script redeploy
plus a Railway middleware deploy. That is the honest cost, and it is the number the "just move
to a real database" instinct never includes.

---

## 5. Technology choices

### 5.1 Hosting: Railway Postgres — yes, with a caveat

Railway is the right answer purely because the middleware already lives there: internal
networking, one dashboard, one bill, and `DATABASE_URL` is injected automatically.

- **Pricing (2026):** Serverless Postgres is usage-based — Launch $0.106/CU-hr, Scale
  $0.222/CU-hr, storage $0.35/GB, no monthly minimum. At this workload (sub-100 MB, near-zero
  sustained CPU) the marginal cost is realistically **a few dollars a month**, likely absorbed
  by the existing Hobby/Pro plan credit.
- **Backups:** Railway does automated volume backups (daily/6-day, weekly/1-month,
  monthly/3-month schedules, stackable) and **Point-in-Time Recovery via pgBackRest** —
  weekly full + daily incremental base backups, WAL archived continuously, ~4-week restore
  window, restore into the same project/environment. PITR has no separate fee; you pay bucket
  storage + egress. Sources conflict on plan gating (some report backups as Pro-only); **verify
  this on your own account before relying on it.**
- **Caveat — the backup story you already have is good.** `apps-script/backup.gs` makes a full
  nightly Drive copy of the workbook with 14-day retention, for free, restorable by any human
  with the Drive link. Postgres restore is a Railway-dashboard operation the owner has never
  done. **Net backup posture after migration is arguably *worse* until someone rehearses a
  restore.** Budget a restore drill.
- **Alternatives considered:** Neon (scale-to-zero, instant copy-on-write branching, free tier
  100 CU-hr / 0.5 GB) is technically nicer and cheaper, and its branching would be genuinely
  useful for the staging-vs-prod isolation problem. **Rejected** because it adds a second
  vendor, a second bill, and cross-network latency from Railway for a workload that will never
  need scale-to-zero. Supabase rejected for the same reason plus its free projects auto-pause
  after 7 days of inactivity — fatal for a shop that closes for a holiday.

### 5.2 Query layer: **raw `pg`. Not Kysely, not Drizzle, not Prisma.**

This is not a close call, and the general 2026 advice ("Drizzle on postgres.js") is simply
wrong for this codebase.

`zoho-middleware/package.json`: Node 20, CommonJS, **zero TypeScript files**, no build step,
no bundler, ESLint + Jest only. `js/` is deliberately ES5.

- **Drizzle / Kysely / Prisma exist to deliver compile-time type inference from a schema.**
  In a codebase with no compiler, that entire value proposition evaluates to zero. You'd pay
  the full cost (schema DSL, codegen or a build step, a new mental model, ~8–12% runtime
  overhead) for none of the benefit.
- Prisma additionally requires a generate step and ships a query engine — a large, opaque
  dependency for a project whose middleware deploy is `npm install --production && node server.js`.
- **`pg` is already the ecosystem default for exactly this situation.** The 2026 "use
  postgres.js instead" advice is aimed at greenfield TypeScript; the same sources say to stay
  on `pg` for existing codebases. Do that.

**Test ergonomics is the decider, and it's what a regression-test-first team should weigh
heaviest.** With raw `pg` a regression test is:

```js
await db.query('INSERT INTO gift_cards ...');
await request(app).post('/api/gift-cards/redeem').send({...});
const { rows } = await db.query('SELECT current_balance FROM gift_cards WHERE ...');
```

No mock, no fixture DSL, no ORM semantics to reason about. The RED test in a
write-the-failing-test-first workflow reads like the bug report. With an ORM you spend the
first hour of every bug fix deciding whether the bug is in your code or in the ORM's query
generation — the exact failure mode STATE.md already records twice ("green tests ≠ working
system" / "the unit tests mocked cache/Zoho with the WRONG contract").

**Test harness recommendation:** **Testcontainers** (`@testcontainers/postgresql`) — one
container per Jest worker process, one fresh database per test file, migrations applied once.
**Reject `pg-mem`**: it's an in-memory reimplementation, and it will not faithfully reproduce
the exact thing you're migrating *for* — transactional semantics under concurrent access. A
gift-card double-spend test that passes against a Postgres emulator proves nothing.

Requires Docker locally. If that's unacceptable, fall back to a local Postgres via Homebrew
and a `TEST_DATABASE_URL` — same tests, worse CI story.

### 5.3 Migrations: **`node-pg-migrate`**

Postgres-only, SQL-first, ~460k weekly downloads, plain-JS or plain-SQL migration files, no
TypeScript requirement. Umzug is more popular but is a generic runner that expects you to
bring your own DB layer — more assembly for no gain here. Postgrator is too small to bet on.

Install as a **production** dependency (or add a `release` step) because of the
`npm install --production` build command.

### 5.4 Summary

```
pg                 ^8.x    (production)
node-pg-migrate    ^7.x    (production — see build command note)
@testcontainers/postgresql  (dev)
```

Three packages. No build step. No new language. That is the right shape for this project.

---

## 6. "Sheets as staff UI" — the honest cost

This is the part the note flagged as important and did not cost. Having read `admin.html`,
`kiosk.html`, and `brewpad.html`, the answer is **better than feared, but non-zero, and
concentrated in two specific sheets.**

### Already covered by existing app UI

`admin.html` has tabs for: Batches, Recipes, Scheduling, Reservations & Holds, Kiosk Orders,
Kiosk Sale, Kit Inventory, Ingredients, Supplier Orders, Consignment, Homepage, Export/Sync.
`kiosk.html` has Gift Card Management. `brewpad.html` covers batches, tasks, readings,
schedules.

So for **Batches, BatchTasks, PlatoReadings, FermSchedules, Recipes, Homepage, and GiftCards
there is already an app equivalent.** The sheet is a convenience, not the only door.

### Genuinely has no app equivalent

| What | Where staff do it today | What would have to be built |
|---|---|---|
| **Add / rename / retire a vessel** | Hand-edit the `Vessels` sheet. Grep confirms **no vessel CRUD exists anywhere** — the app only ever *reads* `get_vessels` for dropdowns and *writes* `status` via `setVesselStatus`. | A small Vessels admin table: add/edit/archive vessel_id, shelf, bin, status. **~1 day.** |
| **Add / remove a staff member (auth allowlist)** | Hand-edit `staff_emails` in the `Config` sheet. Takes effect in ≤5 min (`CacheService` TTL). | A Staff Access screen, plus a decision about where `server_token` lives (it should move to Railway env vars, not a DB row). **~1–1.5 days + security review.** |
| **Bulk data correction** — e.g. the Lactic Acid `L`→`kg` fix, or backfilling a batch after an incident (INV-000171, INV-000137 both required this) | Open the sheet, fix cells, done. This has happened **at least three times in the last four months** per the memory files. | Nothing replaces "select a column and type." The realistic substitute is `railway connect` + `psql`, which is fine for the developer and unusable for the owner. **This is the irreducible loss.** |
| **Ad-hoc "how many X this year?"** | Sort/filter/pivot in the sheet. | A read-only SQL console, or accept `psql`. |

### The part that is genuinely irreducible

The owner's ability to *look at the data and fix it by hand, without a developer* is a real
operational capability that Postgres deletes. Every incident in the memory files (kiosk orphan
reconciliation, INV-000137 lost batches, INV-000171 backfill, the recipe unit fix) was resolved
partly by direct sheet inspection.

**Mitigation that actually works, and costs almost nothing: keep writing the sheet.** For any
migrated table, keep a fire-and-forget mirror write to Sheets. It's one extra HTTP call on a
non-blocking path, it preserves inspection and pivoting and the nightly Drive backup, and it
means a botched cutover has a warm fallback. The cost is that hand-edits stop being
authoritative — which is a communication problem, not an engineering one.

**Minimum before any sheet can truly go away:** Vessels CRUD + Staff Access screen (~2–2.5
days) — and even then, plan for a read-only mirror rather than a clean break.

---

## 7. Cheaper alternatives, and when each is the right answer

### A. Batching + caching alone (Phase 79, extended)

**What it does:** collapses `updateRecipe` ~54 → ~5 ops, `createBatch` ~28 → ~5, and
`bulkAddPlatoReadings` from 20 lock acquisitions to 1. Removes the timeout, removes the only
realistic contention path, cuts lock hold time by ~5×.
**What it does NOT solve:** atomicity (the gift-card double-spend window survives untouched),
the TOCTOU dedup guard, linear scans as `BatchTasks` grows, staging/prod sharing one workbook.
**Right answer when:** always. This is strictly prerequisite to everything else. **Do it first.**

### B. Move only GiftCards

**What it does:** closes the only true money-of-record atomicity hole, adds a real transaction
ledger, removes gift-card operations from the global lock entirely.
**What it does NOT solve:** anything about batches, recipes, or scans.
**Right answer when:** now. **This is my recommendation.**

### C. Keep Sheets as system of record, add a Postgres read replica

**What it does:** an hourly (or write-triggered) sync into Postgres for reporting, dashboards,
and expensive aggregates (`getBatchDashboardSummary`, `getTasksCalendar`). Reads get indexes;
writes stay on Sheets and stay hand-editable.
**What it does NOT solve:** atomicity, the lock, or write latency — every write still goes
through Apps Script. And it adds a whole new failure mode: replica drift, which is worse than
no replica because staff will trust it.
**Right answer when:** reporting becomes the pain (e.g. the owner wants year-over-year batch
analytics) *and* writes are already fast. **Not this project's problem. Skip.**

### D. Replace Apps Script with direct Sheets API calls from the middleware

Use `googleapis` + a service account, call `spreadsheets.values.batchUpdate` from Express,
delete `adminApi.gs`.
**What it does:** removes the manual-redeploy problem entirely (Apps Script becomes normal,
testable, CI-deployed JS in the middleware — which fixes the "no Jest harness, green tests ≠
working system" anti-pattern STATE.md calls out). Removes `LockService`. Gets you real
per-request logging and Sentry. Batch APIs make round-trips cheap by construction.
**What it does NOT solve:** **atomicity — Sheets still has no transaction.** And it *removes*
the only mutual exclusion you currently have, replacing `LockService` with... nothing, unless
you build a Redis lock (Redis is already there, so this is feasible). It also has real cost:
~4,600 lines of `.gs` to port, service-account setup, and the Sheets API's own quota (300
read/write requests per minute per project).
**Right answer when:** the manual-redeploy friction becomes the dominant pain rather than
correctness. That is a real possibility — STATE.md documents a change that "passed its suite
for 4 days while dead in prod" precisely because the logic lived in un-CI'd Apps Script.
**This is the strongest alternative to a Postgres migration and deserves a serious look
before Stages 3–5.** It is roughly the same effort as Stage 5 alone (~10–15 days) and delivers
testability across the *entire* surface rather than transactions across part of it.

### E. Do nothing beyond Phase 79

**Right answer when:** Phase 79 measurements come back healthy and no §9 trigger has fired.
Given the actual scale — 178 batches/year, one owner, one occasional staffer — this is a
defensible answer for another two years. **The only reason it is not my recommendation is the
gift-card double-spend window, which is a correctness bug with money attached, not a
performance concern.**

---

## 8. What I could not verify

Stated plainly rather than hedged:

- **Live row counts.** I have no access to the workbook. `BatchTasks` at ~1,400–2,100 rows is
  arithmetic from "178 batches" × assumed step count, not a measurement. **Get the real number
  before evaluating trigger 5 in §9.**
- **Whether the sheets contain formulas, conditional formatting, pivot tables, or external
  links.** I checked the code; I cannot check the document. This is the single biggest
  unknown in the migration surface and the owner can answer it in ten minutes:
  *open each tab, `Ctrl+~` to reveal formulas, check Data → Named ranges, check for charts.*
  Any tab with formulas is materially harder to migrate than this document implies.
- **Actual per-operation Sheets latency.** The 100–500 ms figure is inherited from the prior
  note and is a plausible community number, not a measurement from this deployment. Phase 79
  should instrument it.
- **Which Railway plan the project is on**, and therefore whether automated backups/PITR are
  included or gated. Sources disagree. Check the dashboard.
- **Whether `LockService` has ever timed out in production.** No evidence found in the repo,
  but Apps Script execution logs live in Google's console, not here. **Worth one look at
  Apps Script → Executions, filtered to failures.** That single check would move the
  concurrency question from "theoretical" to answered.

---

## 9. The trigger condition

Commit to migrating a given area **only** when one of these is observed. Not before.

| # | Trigger (measurable) | Migrate |
|---|---|---|
| **T1** | *Already met.* `redeemGiftCard` decrements a balance across 4 non-atomic writes with the idempotency key written last. No measurement needed — read `adminApi.gs:3925–3966`. | **GiftCards — Stage 2, now** |
| **T2** | Any single confirmed instance of a gift-card balance being wrong, or a customer reporting a card debited twice. | GiftCards, immediately, as an incident |
| **T3** | After Phase 79 ships: median `create_batch` latency measured at the middleware **> 4 s**, or p95 **> 10 s**, over any 30-day window | Batches + BatchTasks (Stage 5) |
| **T4** | **≥2** `LockService` timeout failures appear in the Apps Script Executions log in any single month | Whichever handler is timing out; likely Batches |
| **T5** | `BatchTasks` exceeds **5,000 rows** *and* T3 is also met | Batches + BatchTasks. Row count alone is **not** a trigger — the linear scans only matter once they dominate a request that is already slow. |
| **T6** | A third concurrent writer appears — a second regular staff member on BrewPad, a second kiosk, or a second location | Reassess the whole plan; the concurrency arithmetic changes |
| **T7** | Staging writes to live production data cause a real incident (currently guaranteed possible — staging and prod share one workbook, per STATE.md 2026-08-27) | Stage 1 infra + whichever sheet was corrupted. **This is the most likely trigger to fire and the least anticipated.** |
| **T8** | An Apps-Script-resident bug ships and sits undetected in production for **> 48 h** because it has no Jest coverage (this has already happened once — commit `fda6e40`, 4 days) | **Alternative D**, not Postgres. The problem is testability, not the store. |

**If none of T2–T8 fire within 12 months of Phase 79 shipping, the right decision is to never
migrate the rest.** Sheets is a genuinely good fit for a 178-batch-a-year shop with one
operator who wants to look at his data — and the nightly Drive backup, free CDN reads, and
zero-cost hosting are real advantages that a Postgres migration gives away.

---

## 10. Recommendation in one paragraph

Ship Phase 79 first, extended to cover `createBatch` and `bulkAddPlatoReadings` — that removes
the timeout and the only realistic lock contention without touching the store. Then do the
four Stage-0 hygiene items (~7 days), of which routing `js/admin.js` through the existing
`/api/batch/admin-proxy` seam is the highest-leverage and pays for itself regardless of what
happens next. Then migrate **GiftCards and only GiftCards** to Postgres on Railway, using raw
`pg` + `node-pg-migrate` + Testcontainers, with a dual-write window and a permanent
fire-and-forget mirror back to the sheet (~5 days). Total ~12 days. Do not migrate Batches,
Recipes, or anything else until a trigger in §9 fires with an actual measurement behind it —
and if the trigger that fires is T8 (untestable Apps Script), the right response is
**Alternative D** (move `adminApi.gs` into the middleware as ordinary CI-tested JavaScript
calling the Sheets API), not a database migration.
