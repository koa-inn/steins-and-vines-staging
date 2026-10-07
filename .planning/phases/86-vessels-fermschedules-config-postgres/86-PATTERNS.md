# Phase 86: Vessels + FermSchedules + Config -> Postgres - Pattern Map

**Mapped:** 2026-10-07
**Files analyzed:** 36 new/modified files
**Analogs found:** 33 / 36 (three have only partial or no analog: staff-access resolve + revocation, vessel-status delta seam, staff-access owner route guards)

All paths are relative to `/Users/koa/dev/steins-and-vines-website`. Middleware, `js/admin.js` and `js/brewpad.js` are ES5 (`var`, `function`, no arrows/`let`/`const`/template literals).

**This map builds on `.planning/phases/85-recipes-recipeingredients-postgres/85-PATTERNS.md`. Do not re-derive its excerpts for migrations, backfill CLIs, replay, RUNBOOK, DUAL-LOG, or the real-PG/unit test harnesses: copy the Phase 85 file for the same role, swapping recipes for vessels / ferm schedules. This file records (a) the Phase 85 files that are the direct analogs (they now exist; 85-PATTERNS pointed at Phase 84 files), (b) excerpts verified against current line numbers, and (c) the pieces that are new in 86.**

Hard rules that shape every assignment (from CONTEXT/RESEARCH, CLAUDE.md):
- `sheets` mode (flag unset) must stay byte-identical for `admin-proxy.test.js`, `batch-admin-proxy.test.js`, `adminapi-propagate-ferm-schedule.test.js`, `adminapi-phase82-dispatch.test.js`, `admin-schedule-blast-radius.test.js`, `recipes.test.js`. Never edit existing tests; all coverage goes in NEW test files.
- D-19: TWO flags, `OPS_DATA_STORE` (vessels + ferm schedules + config, mirrored in prod) and `STAFF_ACCESS_STORE` (staff, never mirrored).
- D-17: vessel `location` is the single free-text field (trimmed); no shelf/bin columns.
- D-20: PG down => non-break-glass staff fail closed.
- Never edit `js/main*.js`; run `npm run build` after `js/admin.js` / `js/brewpad.js` edits.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `zoho-middleware/migrations/0004_ops_data.sql` (NEW) | migration | batch (DDL) | `zoho-middleware/migrations/0003_recipes.sql` | exact |
| `zoho-middleware/lib/store-flag.js` (MOD, 1 line) | config | request-response | itself L31 | exact |
| `zoho-middleware/lib/vessel-pg.js` (NEW) | service (atomic SQL) | CRUD (transactional) | `lib/recipe-pg.js` | exact |
| `zoho-middleware/lib/vessel-store.js` (NEW) | service (facade) | CRUD + mode dispatch | `lib/recipe-store.js` | exact |
| `zoho-middleware/lib/ferm-schedule-pg.js` (NEW) | service (atomic SQL) | CRUD (transactional) | `lib/recipe-pg.js` | exact |
| `zoho-middleware/lib/ferm-schedule-store.js` (NEW) | service (facade) | CRUD + mode dispatch | `lib/recipe-store.js` | exact |
| `zoho-middleware/lib/ferm-schedule-rules.js` (NEW) | utility | transform (validator) | `lib/recipe-rules.js` (sanitize + validators) | role-match |
| `zoho-middleware/lib/ops-mirror.js` (NEW) | service (worker) | event-driven (coalescing retry) | `lib/recipe-mirror.js` | exact (entity-keyed copy) |
| `zoho-middleware/lib/staff-access.js` (NEW) | service | request-response (authz decision) | `routes/auth.js` L94-97 inline allowlist + `lib/authTiers.js` resolveTier | partial |
| `zoho-middleware/lib/staff-access-pg.js` (NEW) | service (atomic SQL) | CRUD (transactional, audited) | `lib/recipe-pg.js` (`for update` + tx) | role-match |
| `zoho-middleware/lib/authTiers.js` (MOD) | middleware | request-response | itself L117-142 | exact |
| `zoho-middleware/routes/auth.js` (MOD) | route | request-response | itself L86-119 | exact |
| `zoho-middleware/routes/vessels.js` (NEW) | route | CRUD request-response | `routes/recipes.js` L735-797 (PUT/DELETE with 409 stale) | role-match |
| `zoho-middleware/routes/staff-access.js` (NEW) | route | CRUD request-response (owner-only) | `lib/authTiers.js requireTiers` + `server.js requireAllowedReferer` | partial |
| `zoho-middleware/routes/pos.js` (MOD: proxies + forwarder) | route | request-response | itself L4011-4182 | exact |
| `zoho-middleware/routes/recipes.js` (MOD: `fetchFermSchedules`) | route | request-response | itself L179-201 | exact |
| `zoho-middleware/server.js` (MOD: mount routes, sweep timer) | config/bootstrap | event-driven | itself L796-797 mount, L921-927 sweep | exact |
| `zoho-middleware/scripts/backfill/ops-backfill.js` (NEW) | script (CLI) | batch (file -> DB) | `scripts/backfill/recipes-backfill.js` | exact |
| `zoho-middleware/scripts/backfill/ops-verify.js` (NEW) | script (CLI) | batch (read-only compare) | `scripts/backfill/recipes-verify.js` | exact |
| `zoho-middleware/scripts/backfill/ops-replay-to-sheet.js` (NEW) | script (CLI) | batch -> HTTP | `scripts/backfill/recipes-replay-to-sheet.js` | exact |
| `zoho-middleware/scripts/backfill/specs/vessels.js`, `specs/config.js` (NEW); `specs/ferm-schedules.js` (reuse/loosen copy) | config (spec) | batch | `specs/recipes.js`, `specs/ferm-schedules.js` | exact |
| `apps-script/adminApi.gs` v61 (MOD, additive) | controller | request-response / file-I/O | `mirrorRecipeState` L4601 + dispatch L338 | exact |
| `apps-script/adminApi.gs` `_vesselStatusLog` / `vessel_status_changes` / `acting_user` | controller | request-response | `setVesselStatus` L2476 + server_token branch | no analog (new seam) |
| `js/admin.js` Vessels tab (NEW code) | component | CRUD request-response | Recipes tab L8300-8345 | role-match |
| `js/admin.js` Staff Access tab (NEW code) | component | CRUD request-response (owner-gated) | Recipes tab + `showConfirm` | partial |
| `js/admin.js` schedule archive / propagate Retry (MOD) | component | request-response | stale helpers L9076-9101 | role-match |
| `js/admin.js` `handleProxyResponse` (MOD, additive) | utility | transform | itself L697-708 | exact |
| `admin.html` (MOD: tab buttons + panels) | component | - | `admin.html` L124, L446 | exact |
| `js/brewpad.js` schedule editor stale/archive (MOD) | component | request-response | 85 `submitRecipeSave` branch (see 85-PATTERNS) | exact |
| `js/admin.min.js`, `js/brewpad.min.js` (BUILD) | build | - | `npm run build` | n/a |
| `docs/RUNBOOK.md` "Ops data -> Postgres (Phase 86)" + deploy row | docs | - | RUNBOOK Phase 84/85 sections | exact |
| `.planning/phases/86-.../86-DUAL-LOG.md` (NEW) | docs | - | `85-DUAL-LOG.md` / `84-DUAL-LOG.md` | exact |
| Real-PG tests: `__tests__/db/vessel-pg*.test.js`, `ferm-schedule-pg*.test.js`, `staff-access-pg.test.js`, `ops-migration.test.js`, `ops-backfill.test.js` (NEW) | test | CRUD | `__tests__/db/recipe-pg-update.test.js`, `recipes-migration.test.js`, `recipes-backfill.test.js` | exact |
| Unit tests: `vessel-store.test.js`, `ferm-schedule-store.test.js`, `ops-mirror.test.js`, `ops-store-mode.test.js`, `staff-access.test.js`, `auth-tiers-revocation.test.js`, `staff-access-routes.test.js`, `admin-proxy-attribution.test.js` (NEW) | test | request-response | `recipe-store.test.js`, `recipe-mirror.test.js`, `recipes-store-mode.test.js`, `auth-tiers-guard.test.js`, `admin-proxy.test.js` | exact / role-match |
| Backfill unit tests: `__tests__/backfill/ops-backfill-plan.test.js`, `ops-verify.test.js`, `ops-spec-headers.test.js`, `ops-replay-to-sheet.test.js` (NEW) | test | batch | `recipes-backfill-plan.test.js`, `recipes-verify.test.js`, `recipes-spec-headers.test.js`, `recipes-replay-to-sheet.test.js` | exact |
| Frontend tests: `tests/frontend/adminapi-ops-mirror.test.js`, `adminapi-vessel-status-log.test.js`, `admin-vessels-tab.test.js`, `admin-staff-access-tab.test.js`, schedule stale/propagate-retry tests (NEW) | test | jsdom / fake Sheets | `tests/frontend/adminapi-recipe-mirror.test.js`, `admin-recipes.test.js`, `admin-schedule-blast-radius.test.js` | exact / role-match |

## Pattern Assignments

### `zoho-middleware/migrations/0004_ops_data.sql` (migration, DDL)

**Analog:** `zoho-middleware/migrations/0003_recipes.sql` (65 lines)

Copy the header-comment convention (additive only, never edit once applied, sequence seed via `setval` at backfill because the allowlist rejects `AlterSeqStmt` and bare `SELECT`), the `-- Up Migration` / `-- Down Migration` markers, and the id-default idiom (0003 L19-25):
```sql
-- Up Migration
create sequence recipe_id_seq start 1 minvalue 1;

create table recipes (
  recipe_id text primary key
    default ('SV-R-' || lpad(nextval('recipe_id_seq')::text, 6, '0'))
    check (recipe_id ~ '^SV-R-[0-9]{6,}$'),
  ...
  created_at timestamptz not null,
  updated_at timestamptz not null,
```
Apply as `ferm_schedule_id_seq` + `'FS-' || lpad(..., 4, '0')` with CHECK `'^FS-[0-9]{4,}$'` (loosened from the exactly-4-digit rehearsal regex, Pitfall 6). Composite index idiom (0003 L58-59): `create index ... on t (col, col desc);`. Down migration drops child tables, parents, then sequences (0003 L61-65).

Full recommended DDL is already in 86-RESEARCH.md Pattern 1 (vessels, ferm_schedules, config, staff_access, staff_access_audit, `vessel_position_seq`). Items to respect:
- Unconstrained `numeric` (0003 L15-16 rule applies to diameters/capacity).
- `updated_at timestamptz not null` is app-written (ms precision) because it is the D-16 stale token; do NOT default it to `now()` (microsecond vs ms mismatch breaks the epoch-ms compare in `isStale`).
- No backslashes in regexes, no triggers/functions/`AlterSeqStmt`/`select` (migration-allowlist). Test the `!~` CHECK on `config.key` against `npm run migrate:guard` FIRST (research A10); fallback = drop the CHECK and keep the backfill/app guard.
- Run `cd zoho-middleware && npm run migrate:guard`.
- Test: `__tests__/db/recipes-migration.test.js` shape for `ops-migration.test.js`.

---

### `zoho-middleware/lib/store-flag.js` (MOD, one line)

**Analog:** itself, L31:
```javascript
var STORE_ENV_NAMES = ['GIFT_CARDS_STORE', 'RECIPES_STORE'];
```
Append `'OPS_DATA_STORE', 'STAFF_ACCESS_STORE'`. `server.js isDatabaseRequired()` already iterates the list; no other change. Shared utility: run the FULL frontend and middleware suites afterwards (CLAUDE.md rule 7). `__tests__/store-flag.test.js` exists, do not edit it; add coverage in a new file.

---

### `zoho-middleware/lib/vessel-pg.js` and `lib/ferm-schedule-pg.js` (atomic SQL, transactional CRUD)

**Analog:** `zoho-middleware/lib/recipe-pg.js` (410 lines)

**Module contract** (L3-19): never requires `pg`, receives `client` from `db.withTransaction`, `$n` placeholders only, SQL held in module-level constants, business rejections resolve `{ok:false, error, message}`, infra errors are NOT caught so the tx rolls back, underscore-prefixed result keys (`_vesselId`, `_scheduleId`) are for the facade/mirror and stripped there.

**Column list drives serializer and SQL** (L23-41):
```javascript
var RECIPE_COLUMNS = [ 'recipe_id', 'name', ... ];
var NUMERIC_RECIPE_COLUMNS = { locked_price: true, ... };
var TIMESTAMP_RECIPE_COLUMNS = { created_at: true, updated_at: true };
var RECIPE_SELECT = 'select ' + RECIPE_COLUMNS.join(', ') + ' from recipes ';
```

**Serializer: NULL to `''`, numerics through `Number()`, timestamps to ISO** (L97-117):
```javascript
function textOut(value) { return value === null || value === undefined ? '' : value; }
function rowToRecipe(row) {
  var out = {};
  for (var i = 0; i < RECIPE_COLUMNS.length; i++) {
    var col = RECIPE_COLUMNS[i];
    var v = row[col];
    if (v === null || v === undefined) { out[col] = ''; }
    else if (NUMERIC_RECIPE_COLUMNS[col]) { out[col] = Number(v); }
    else if (TIMESTAMP_RECIPE_COLUMNS[col]) { out[col] = v instanceof Date ? v.toISOString() : String(v); }
    else { out[col] = v; }
  }
  return out;
}
```
Vessel serializer: sheet key order `vessel_id,type,material,capacity_liters,status,bottom_diameter_cm,top_diameter_cm,depth_cm,location,brand,notes` plus extra `archived`, `updated_at`; emit `status:'Disabled/Retired'` when `archived` (research Pattern 1). Schedule serializer: `steps` as `JSON.stringify(array)` AND `steps_parsed`; `is_active` boolean; `last_updated` key from `updated_at`; compare steps parsed (jsonb reorders keys).

**Lock + stale check (D-16)** (L73, L264-275, L342-344, L387-389):
```javascript
var LOCK_RECIPE_SQL = RECIPE_SELECT + 'where recipe_id = $1 for update';

function isStale(expected, row) {
  if (expected === undefined || expected === null || expected === '') return true;
  var t = new Date(expected).getTime();
  if (isNaN(t)) return true;
  var stored = row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime();
  return t !== stored;
}
function staleResult() { return { ok: false, error: 'stale_recipe', message: STALE_MESSAGE }; }
...
var locked = await client.query(LOCK_RECIPE_SQL, [recipeId]);
if (locked.rows.length === 0) return { ok: false, error: 'not_found', message: 'Recipe not found: ' + recipeId };
if (isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();
```
Rename error codes to `stale_vessel` / `stale_schedule`. Missing token is stale (strict, research A9). Do NOT copy `isStale` by import from recipe-pg (it is not exported); copy it into a tiny shared helper or per file, do not edit recipe-pg.

**Fixed-allowlist dynamic SET clause** (L89-91, L295-322): `UPDATE_STRING_FIELDS` / `UPDATE_NUMERIC_FIELDS` arrays, `addSet(col, value)` pushing `$n` placeholders; field names never come from payload keys. Use for `updateVessel` and `updateFermSchedule` ("touch only provided fields", always bump `updated_at`).

**Sanitise** via `require('./recipe-rules').sanitizeInput` (recipe-rules.js L17, exported L132) on name/description/category/type/notes/etc. Do not write a new sanitiser.

**Delete with reference guard** (L378-397 `deleteRecipe` taking `opts.batchRefCount` and throwing if not a non-negative integer):
```javascript
var refs = opts.batchRefCount;
if (typeof refs !== 'number' || !isFinite(refs) || refs < 0 || Math.floor(refs) !== refs) {
  throw new Error('batchRefCount required');
}
```
For schedules D-15 differs: refs > 0 returns `{ok:false, error:'schedule_in_use'}` (409) instead of deactivating; archive is its own op setting `is_active=false`. Count both recipes (`recipes.schedule_id`, via `select count(*) from recipes where schedule_id = $1` when `RECIPES_STORE != sheets`) and batches (Apps Script `ferm_schedule_ref_count`, resolved BEFORE opening the tx).

**Vessel specifics with no recipe analog:** `archived` boolean independent of `status`; `applyStatusChanges(client, changes)` idempotent "set" that skips unknown ids and never touches `archived`; archive of an `In-Use` vessel returns 409 (research A11); ID is permanent (D-08), so `updateVessel` must reject a `vessel_id` change; vessel_id validated by the CHECK regex `^[A-Z]{2,6}-[0-9]{3,}$`; `nextVesselNumber(prefix)` helper.

---

### `zoho-middleware/lib/vessel-store.js` and `lib/ferm-schedule-store.js` (facade, mode dispatch)

**Analog:** `zoho-middleware/lib/recipe-store.js` (196 lines). This is a near-exact copy target.

**Imports** (L23-28):
```javascript
var axios = require('axios');
var storeFlag = require('./store-flag');
var db = require('./db');
var recipePg = require('./recipe-pg');
var recipeMirror = require('./recipe-mirror');
var log = require('./logger');
```
Do NOT require `./constants` (route tests mock it partially; Pitfall 15).

**Mode + config** (L32-41): `storeFlag.resolveStoreMode('OPS_DATA_STORE')`; `isConfigured()` returns the Apps Script env check in `sheets`, else `db.isConfigured()`.

**Apps Script transport** (L45-62): copy `callAppsScript(action, payload)` verbatim (timeout 15000, returns `resp.data` untouched). For reads in `sheets` mode the facade must use `axios.get` with `params` exactly as the proxy does today so `admin-proxy.test.js` stays green (the schedule reads in `fetchFermSchedules` use `axios.get(url, {params:{action:'get_ferm_schedules', server_token}, timeout:12000})`).

**runPg / strip** (L66-78): copy verbatim.

**Per-op skeleton** (L133-149): sheets short-circuit first, then PG, then `.then(finish)`:
```javascript
function create(payload) {
  if (getMode() === 'sheets') return callAppsScript('create_recipe', payload);
  return runPg(function (client) {
    return recipePg.createRecipe(client, payload, { actor: 'middleware', now: new Date() });
  }).then(finish);
}
```
Difference in 86: pass `actor: opts.actor` = real `req.staffEmail` (folded todo; recipes used `'middleware'`). `finish` = `scheduleMirror(raw)` + `strip(raw)` (L117-131), calling `opsMirror.schedule('vessel', id)` / `('fermsched', id)`.

**Reference-count seam** (L156-170 `hasBatchReferences`): copy for `hasBatchReferences(scheduleId)` calling Apps Script `ferm_schedule_ref_count`, rejecting with `err.code='batch_ref_unavailable'` so delete fails closed; archive does not need it.

**Remove/delete** (L172-184): `hasBatchReferences(...).then(count => runPg(... batchRefCount: count))`.

**Read rule:** never fall back to a sheet read when PG fails (recipe-store header L7); a DB outage rejects and the route maps to 502.

**Facade return shapes** match Apps Script (research Pattern 2): `get_vessels` -> `{ok:true,data:{vessels:[...]}}`, `get_ferm_schedules` -> `{ok:true,data:{schedules:[...]}}` active only, plus an internal `includeArchived` read for `enrichFermentDays`. Exports flat: `getMode, isConfigured, list*, get*, create, update, archive, remove, hasBatchReferences, applyStatusChanges, nextVesselNumber`.

---

### `zoho-middleware/lib/ferm-schedule-rules.js` (utility, validator)

**Analog:** `zoho-middleware/lib/recipe-rules.js` (137 lines: `sanitizeInput` L17, `normalizePricingMode` L50 as a small pure-validator example, exports L131-136). Same style: pure, ES5, parity-tested against the `.gs` implementation via the `new Function` harness (`tests/frontend/adminapi-recipe-pure.test.js` L28-45). Port rules from `apps-script/adminApi.gs` `createFermSchedule` (L3555): steps array, >= 2 steps, at least one `is_packaging === true` (code uses `some`, message says "Exactly one"; port the code), numeric `step_number`/`day_offset`, string `title`, booleans. Shared by the PG layer AND `ops-backfill.js` ("every steps blob validated"). Test against all 11 live `steps` shapes (anonymised fixtures only).

---

### `zoho-middleware/lib/ops-mirror.js` (worker, entity-keyed coalescing state-copy)

**Analog:** `zoho-middleware/lib/recipe-mirror.js` (239 lines). Copy the whole module shape; the only changes are an entity dimension and the Apps Script action names.

**Constants and per-key tail chain** (L30-57):
```javascript
var DIRTY_PREFIX = 'recipe:mirror-dirty:';
var RETRY_DELAYS_MS = [2000, 10000, 60000, 300000];
var MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
var recipeTails = {};
function chainForRecipe(recipeId, fn) {
  var prevTail = recipeTails[recipeId] || Promise.resolve();
  var tail = prevTail.then(fn, fn);
  recipeTails[recipeId] = tail;
  function cleanup() { if (recipeTails[recipeId] === tail) delete recipeTails[recipeId]; }
  tail.then(cleanup, cleanup);
  return tail;
}
```
For ops: prefixes `ops:mirror-dirty:vessel:` and `ops:mirror-dirty:fermsched:`; tails keyed `entity + ':' + id`; the sweep must derive entity + id from the key suffix.

**Apps Script poster** (L59-82) copy verbatim (30 s timeout, rejects unless `data.ok === true`).

**Read-latest-at-send** (L104-128): `db.withTransaction(client => vesselPg.getVessel(client, id))`; missing row -> `mirror_ferm_schedule_delete` (vessels are never deleted, so a missing vessel is an error); present -> `mirror_vessel_state` / `mirror_ferm_schedule_state` with the full serialized row.

**Retry + Sentry** (L130-152), **`schedule()` production-only gate** (L158-178):
```javascript
sheetMirror.mirrorFireAndForget('recipes.mirror', function () { ...marker... runWithRetry(recipeId, 0) });
```
Labels: `'vessels.mirror'`, `'fermsched.mirror'`. **Sweep** (L193-230): `sheetMirror.isMirrorEnabled()` + `cache.isConnected()` guard, `c.keys(DIRTY_PREFIX + '*')`, skip keys whose chain is running, hourly Sentry throttle `SWEEP_ALERT_INTERVAL_MS`. Sentry tags carry the id and component only (`component: 'ops-mirror'`), no names/emails.

**Never wire the staff list to this module** (D-10). Test: new `ops-mirror.test.js` modeled on `__tests__/recipe-mirror.test.js`.

---

### `zoho-middleware/lib/staff-access.js` (service, authz decision) - partial analog

**Analog (partial):** `routes/auth.js` L94-99, the inline env-only allowlist that this replaces:
```javascript
var allowlist = (process.env.STAFF_EMAILS || '').split(',').map(function (e) {
  return e.trim().toLowerCase();
});
if (allowlist.indexOf(email) === -1) {
  return res.status(403).json({ authorized: false });
}
```
Extract this env parse into `breakGlassEmails()`; `resolve(email)` returns `{allowed, role, source}`: env hit => `{allowed:true, role:'owner', source:'env'}` without touching the DB (D-01, works with PG down); else when `storeFlag.resolveStoreMode('STAFF_ACCESS_STORE') !== 'sheets'` query `staff_access`; PG error => deny + Sentry warning (D-20, no grace cache); else deny. In `sheets` mode `resolve` reduces to env-only so existing tests with mocked `session` and no DB keep passing (Pitfall 15). Require `store-flag`/`db` lazily inside functions. Positive-result cache <= 5 s, cleared by every staff mutation; owner-route checks bypass it. Log/Sentry with a short hash of the email, never the address. The PG leg uses `db.query` (read-only single statement) from `lib/db.js` (the only `pg` gateway).

**No analog:** the cache-with-explicit-invalidation and fail-closed-on-PG-error semantics. Use RESEARCH Pattern 6.

### `zoho-middleware/lib/staff-access-pg.js` (atomic SQL, audited)

**Analog:** `recipe-pg.js` `for update` idiom (L73, L342) and the tx contract. Follow the RESEARCH "Effective-owner guard inside the removal transaction" example: `select email, role from staff_access where role = 'owner' for update`, compute effective owners = PG owners U break-glass minus target, reject `cannot_remove_self` / `last_owner`, mutate, and insert into `staff_access_audit` in the SAME transaction (an audit failure aborts the change). Denied attempts write an `action='denied'` audit row. Emails validated/normalised lowercase before any SQL.

---

### `zoho-middleware/lib/authTiers.js` (MOD, per-request revalidation = D-03 revocation)

**Analog:** itself, L129-141 (the session branch):
```javascript
if (sid) {
  var payload = await session.getSession(sid);
  if (payload) {
    req.staffEmail = payload.email;
    session.touchSession(sid).catch(function () {});
    return 'session';
  }
}
return null;
```
Change: after `getSession` returns a payload, lazily `require('./staff-access')` and `await staffAccess.resolve(payload.email)`; not allowed => fall through to `return null` (403 via `requireTiers` L185 / the `server.js` guard); allowed => set `req.staffEmail` and `req.staffRole = decision.role` (never read the role from the session payload). `resolveTier` rejections already fail closed (`requireTiers` L186-188 `.catch` -> 403; `server.js` ~L465 try/catch). Keep `allowAdmin`/`allowKiosk` untouched. Existing `auth-tiers-guard.test.js` mocks `session`; do not edit it. New test file `auth-tiers-revocation.test.js` asserting: removed email's still-valid sid gets 403 on the next request; demotion is immediate; break-glass works with DB mocked to throw; PG error fails closed.

### `zoho-middleware/routes/auth.js` (MOD)

**Analog:** itself L86-119. Replace the inline allowlist (L94-99) with `staffAccess.resolve(email).then(d => d.allowed ? createSession : 403)`. Keep `googleVerify.verifyStaffAccessToken` first (T-46-09, never read email from `req.body`) and the cookie + `{authorized:true,email,token:sid}` response (L100-113) byte-identical. In `sheets` mode the behaviour must equal today's env-only check.

---

### `zoho-middleware/routes/vessels.js` (NEW, route)

**Analog:** `zoho-middleware/routes/recipes.js` L735-797 for the PUT/DELETE/409 mapping and error handling; guard idiom from `routes/pos.js` L4092.

**409 stale mapping** (recipes.js L755-761):
```javascript
return recipeStore.update(payload, { expectedUpdatedAt: expectedUpdatedAt }).then(function (data) {
  if (data && data.ok === false && data.error === 'stale_recipe') {
    return res.status(409).json({
      error: 'This recipe was changed since you opened it — reload to see the latest',
      code: 'stale_recipe'
    });
  }
  if (!data.ok) {
    return res.status(422).json({ error: data.message || data.error || 'Update failed', code: 'save_failed' });
  }
  ...
}).catch(function (err) {
  log.error('[api/recipes] PUT ' + req.params.id + ' failed: ' + err.message);
  res.status(502).json({ error: 'Unable to update recipe', code: 'save_failed' });
});
```
Use `code: 'stale_vessel'`; infra failures stay 502 with a generic body (no `err.message` leak).

**Auth (copy for EVERY route including GET):**
```javascript
authTiers.requireTiers(['session'])(req, res, function () { ... });   // inline, as routes/pos.js L4092
```
The `/api` global guard skips GET (`server.js` L444 `if (req.method === 'GET') return next();`), so `GET /api/vessels` MUST call `requireTiers` inline or it is public. Session tier only for the editor (legacy key is acceptable only where the proxies already allow it; vessels CRUD uses session). `sheets` mode: 503 `{error:'vessels_editor_requires_postgres'}`. Actor = `req.staffEmail`. `expected_updated_at` from body (PUT) or query (DELETE-like routes), as recipes L780.

### `zoho-middleware/routes/staff-access.js` (NEW, route) - partial analog

**Analogs:** `authTiers.requireTiers` (L162-190) for the inline guard; `server.js` `requireAllowedReferer` (L102-120) for an Origin allow-list to mirror as defence in depth (uses the module-level `allowedReferers` list; export or re-derive the origins, do not weaken it).

Guard chain, in order, on every route including `GET`: `requireTiers(['session'])` (never legacy `x-api-key`, never device) -> require the credential arrived via the `x-session-token` header, not the cookie (CSRF-immune, admin.js attaches it at L6-31) -> `staffAccess.resolve(req.staffEmail)` with cache bypass, role must be `owner` -> if `Origin` is present it must be in the allowed origins -> one PG tx via `staff-access-pg` (self/last-owner rules, audit row). `GET /api/staff-access/me` is the only route open to any session (`{email, role, break_glass}`), drives tab visibility. Non-owner mutation => 403 + audit `denied`. Break-glass emails are listed read-only and cannot be removed/demoted. No analog for the full owner-only chain; test matrix in RESEARCH "Testing notes" (anonymous / device / legacy / staff / owner x GET/POST).

---

### `zoho-middleware/routes/pos.js` (MOD: proxies and shared forwarder)

**Analog:** itself, L4011-4182. Keep action names (existing UIs call them by name); intercept inside/around the shared forwarder; do NOT add CRUD actions to the allowlists except `archive_ferm_schedule` (add to both `ADMIN_PROXY_ACTIONS` L4044 and `ADMIN_PANEL_PROXY_ACTIONS` L4137; in `sheets` mode it forwards as `delete_ferm_schedule`, today's soft deactivate).

**Payload hardening after the body merge** (current, L4102-4106 and L4174-4178):
```javascript
var payload = Object.assign({}, body, {
  action: action,
  server_token: process.env.APPS_SCRIPT_SERVER_TOKEN
});
delete payload.token;
```
Extend (RESEARCH Pattern 10 / hardening block) with, immediately after the merge and in BOTH proxies: `delete payload.acting_user; delete payload.schedule_steps_json; delete payload.collect_vessel_status; delete payload.vessel_sheet_write; if (req.staffEmail) payload.acting_user = req.staffEmail;` then, when mode != sheets, set `collect_vessel_status = true` and `vessel_sheet_write = sheetMirror.isMirrorEnabled()`. Never read these from the client.

**Forwarder** (L4011-4032): `isRead ? axios.get(url,{params,timeout:15000,maxRedirects:5}) : axios.post(url, JSON.stringify(payload), {headers:{'Content-Type':'application/json'},timeout:15000,maxRedirects:5})`; upstream failure collapses to `502 {ok:false,error:'server_error'}` with `log.error('[' + logTag + '] ' + action + ' failed: ' + err.message)`. Additions, all no-ops in `sheets` mode: read overlay (`get_vessels`, `get_ferm_schedules` answered from the store without calling Apps Script; `get_batch_init` forwarded then `data.schedules` replaced from the store, Pitfall 3); write interception for `create_/update_/delete_/archive_/propagate_ferm_schedule`; after an upstream write response, `vesselStore.applyStatusChanges(resp.data.vessel_status_changes)` BEFORE `res.json` (Pitfall 9 / Pattern 4); for `create_batch` with `schedule_id`, resolve the schedule from PG and add `schedule_steps_json` (server_token path only). The public batch routes (L4216+) also reach `setVesselStatus`; they call the same forwarder with `isRead=false`, so delta application must live in the forwarder, not in the two proxies. The refactor must keep the exact axios call sequence the existing proxy tests mock.

**Propagate (D-14):** handler loads steps from PG by id (ignore client `steps`), calls Apps Script `propagate_ferm_schedule`, returns `{ok, batches_updated, ..., batches_failed:[{batch_id,error}]}`.

### `zoho-middleware/routes/recipes.js` (MOD)

**Analog:** itself, `fetchFermSchedules` L179-201 (Redis `FERM_SCHEDULES` 300 s cache around a direct `axios.get` to Apps Script). In `OPS_DATA_STORE != sheets` call the store (`includeArchived: true`) and bypass or bust that cache; in `sheets` keep the code path untouched. Never rejects (`.catch` returns `[]`, L197-200). `enrichFermentDays` only needs `schedule_id` truthiness; archived schedules must still resolve (Pitfall 8).

### `zoho-middleware/server.js` (MOD)

**Analog:** itself. Mount new routers next to L796-797 (`app.use('/', require('./routes/recipes'));`), e.g. `app.use('/', require('./routes/vessels'));` and `routes/staff-access`. Sweep timer: copy L921-927 verbatim for `opsMirror.sweep()`:
```javascript
// Phase 85 D-02: re-drive recipe sheet mirrors that did not land (survives redeploys)
setInterval(function () {
  recipeMirror.sweep().catch(function (err) {
    log.error('[recipes-mirror] sweep failed: ' + err.message);
  });
}, 5 * 60 * 1000);
```
Keep `STAFF_EMAILS` in `validateEnv` REQUIRED_IN_PROD (`lib/validateEnv.js` L22; break-glass must exist) and the fail-closed check at `server.js` L459 keyed on `process.env.STAFF_EMAILS` unchanged.

---

### `zoho-middleware/scripts/backfill/ops-backfill.js`, `ops-verify.js`, `ops-replay-to-sheet.js` (CLIs)

**Analogs:** `recipes-backfill.js`, `recipes-verify.js`, `recipes-replay-to-sheet.js` (and through them the gift-card versions). Follow 85-PATTERNS sections for these three files, with these recipe-to-ops substitutions:

**Header/imports/exits** (recipes-backfill.js L28-55):
```javascript
var db = require('../../lib/db');
var readXlsx = require('./read-xlsx');
var normalizeLib = require('./normalize');
var normalizeRow = normalizeLib.normalizeRow;
var rejectsLib = require('./rejects');
var backfillCli = require('./backfill');
var EXIT = backfillCli.EXIT;
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;
var checkHeaders = backfillCli.checkHeaders;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var INSERT_BATCH_SIZE = 500;
```
Pure `buildOpsBackfillPlan` exported separately; CLI behind `require.main === module`; equals-form flags `--file=PATH` (required), `--out-dir`, `--timezone`, `--dry-run | --promote`, plus new REQUIRED `--owners=a@x,b@y` (>= 1; never guess owners); DB from `BACKFILL_DATABASE_URL` only; pool via `db.createPool(url, {max:2})`; empty-target preconditions via `to_regclass` outside the tx; DB-name prompt; one transaction for all four tables (vessels, ferm_schedules, config, staff_access); `setval('ferm_schedule_id_seq', max FS suffix)` and `setval('vessel_position_seq', count)` only when seed > 0; in-transaction invariants return `{ok:false, failedCheck}` naming the check only; exit codes 0 ok / 1 error / 2 rejects / 3 check failed. Output ids/field names/counts only; emails masked.

**Ops-specific plan rules (RESEARCH Pattern 8, none auto-fixed):** vessel id trim + regex + duplicate reject; `position` = 1-based sheet row order; `location` trimmed; `Disabled/Retired` => `archived=true,status='Empty'`, any other status rejected; schedules: `normalizeBoolean` for `is_active` (accept real booleans and `'TRUE'/'FALSE'`, reject blank), `steps` via `ferm-schedule-rules`, id regex `^FS-[0-9]{4,}$`, header mapping `is_active`->DDL name and `last_updated`->`updated_at`; Config: hard-reject any key matching `token|secret|password|key`, refuse to import `staff_emails` as a config row (it seeds `staff_access` instead), import only `hold_expiry_hours` and `google_calendar_id`.

**Specs** (`scripts/backfill/specs/`): new `vessels.js` and `config.js`; for FermSchedules copy `specs/ferm-schedules.js` (columns incl. `{ name: 'steps', header: 'steps', type: 'jsonb', ...}`, `is_active`->`active` rename L27-33) and rename `active` to the final DDL column and loosen `pad: 4`. Do not register in `specs/index.js` (dedicated multi-table CLI). Pin real headers in a NEW `ops-spec-headers.test.js` (never edit `spec-headers.test.js`). Vessels has 11 headed columns of 28 physical (snapshot fact).

**ops-verify:** read-only transaction, constant SQL, pure exported comparator reporting `{id, field}` only, numerics by `Number`, `''` == NULL, trimmed text, archived <-> `Disabled/Retired`, steps compared PARSED, staff set-equality with masked output, assert no `server_token`-like key in the Config tab. Never derive expected vessel status from batches (7 known live mismatches, Pitfall 2).

**ops-replay-to-sheet:** dry-run default, `--apply`; vessels via `mirror_vessel_state`, schedules via `mirror_ferm_schedule_state`; stop at first `{ok:false}`; payload identical to what `ops-mirror` sends. Staff list is never replayed.

---

### `apps-script/adminApi.gs` v61 (MOD, additive)

**Analog:** `mirrorRecipeState` (L4601) and its dispatch (L338-344), which reflects the Phase 84 `mirror_gift_card_state` pattern at L334.

**Dispatch registration with cache eviction by the dispatcher** (L338-343):
```javascript
if (action === 'mirror_recipe_state') {
  var mrsResult = mirrorRecipeState(payload);
  _invalidateRecipeCache(payload.recipe && payload.recipe.recipe_id || payload.recipe_id);
  return _jsonResponse(mrsResult);
}
```
Add `mirror_vessel_state`, `mirror_ferm_schedule_state`, `mirror_ferm_schedule_delete`, `ferm_schedule_ref_count` inside the same `server_token` branch. Schedule mirror actions must evict `'gfs'` AND `'gbi'` plus `invalidateSheetCache(FERM_SCHEDULES_SHEET_NAME)` (Pitfall 4: the existing CRUD evicts only `gfs`).

**Function body:** validate payload and id regex up front (`mirrorRecipeState` L4601-4616 returns `{ok:false,error:'missing_fields'|'invalid_id'}`), then `acquireScriptLock(15000)`, header-addressed writes (never fixed column positions), `sheet_not_found` guard, write values verbatim, never re-sanitise. Vessel mirror writes `archived` as `status 'Disabled/Retired'` and preserves unknown extra columns. Schedule mirror writes `is_active` as a real boolean and `steps` as `JSON.stringify`. `ferm_schedule_ref_count` reads Batches fresh (not the `gbl` cache) and counts all batches regardless of status; shape `{ok:true,count}`.

**New seam with no analog (Pattern 4/10):**
- `setVesselStatus(vesselId, newStatus)` (L2476-2497) currently scans `getDataRange()` for `vessel_id`/`status` columns and `setValue`s. Add a request-scoped `_vesselStatusLog` (reset at top of `doPost`), push `{vessel_id,status}` before the write, skip the cell write when the payload carried `vessel_sheet_write === false`, and attach `vessel_status_changes` in `_jsonResponse` ONLY when non-empty so existing response shapes do not change. Callers: `createBatch` L2747, `updateBatch` L2838/L2900, `deleteBatch` L2951, `updateBatchTask` L3155, `handlePackagingCompletion` L3327, `handlePackagingUncompletion` L3357.
- `acting_user`: one `_actingUser(payload)` helper (trimmed, <= 254 chars, email-shaped else `''`) replacing the `'middleware'` literals with `actor || 'middleware'` in the server_token branch; `create_batch` keeps `'kiosk-middleware'` when no actor.
- `createBatch` (L2581, L2618) prefers `schedule_steps_json` only on the server_token path (strip on the staff-OAuth path).
- `propagateFermSchedule` (L3660): per-batch `try/catch` recording `batches_failed` and continuing; keep `adminapi-propagate-ferm-schedule.test.js` green.
- Do not edit `getVessels` (L2454) or existing CRUD function behaviour beyond the above. The deployment is shared by staging and production: every change additive. Record the deploy and rollback version (60) in the RUNBOOK table.

**Tests (new files only):** `tests/frontend/adminapi-ops-mirror.test.js` copying the fake-Sheets harness of `tests/frontend/adminapi-recipe-mirror.test.js` / `adminapi-giftcard-mirror.test.js` (`ADMIN_API_PATH`, `makeFakeSheet(headerRow)`, fake lock, `new Function` injection); `adminapi-vessel-status-log.test.js` and acting-user dispatch tests in the style of `adminapi-phase82-dispatch.test.js`.

---

### `js/admin.js` (MOD)

**handleProxyResponse (additive fix)** - current L697-708:
```javascript
function handleProxyResponse(r) {
  if (r.status === 401) { enterLoggedOutState(); throw new Error('Session expired'); }
  return r.json().then(function (data) {
    if (!r.ok || !data || !data.ok) {
      throw new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
    }
    return data;
  });
}
```
Change the throw to build the Error, then set `err.code = data && data.code; err.status = r.status;` before throwing, so 409 `stale_schedule` / `schedule_in_use` reach the toast. Purely additive (message unchanged).

**Stale helpers (generalise, do not edit)** - L9076-9101:
```javascript
var STALE_RECIPE_MESSAGE = 'This recipe was changed since you opened it — reload to see the latest';
function recipeStatusPreservingJson(r) {
  return r.json().catch(function () { return {}; }).then(function (data) {
    return { status: r.status, data: data };
  });
}
function throwIfStaleRecipe(result) {
  if (result.status === 409 && result.data && result.data.code === 'stale_recipe') {
    var e = new Error(result.data.error || STALE_RECIPE_MESSAGE);
    e.code = 'stale_recipe';
    throw e;
  }
}
function showStaleRecipeToast(err, onReload) {
  showToast(err.message || STALE_RECIPE_MESSAGE, 'error', {
    actionLabel: 'Reload', duration: 15000, onAction: onReload
  });
}
```
Add sibling `*Vessel` / `*Schedule` variants (reuse `recipeStatusPreservingJson` for the response-wrapping step) and call sites that include `expected_updated_at` from the loaded row. `showToast(message, type, {actionLabel, onAction, duration})` is the Retry/Reload/Archive-instead action vehicle.

**Lazy-loaded tab wiring - Vessels and Staff Access tabs** (L8300-8345), copy exactly:
```javascript
var _recipesDataLoaded = false; var _recipesDataLoading = false;
var _recipesOrigInitTabNav = initTabNavigation;
initTabNavigation = function () {
  _recipesOrigInitTabNav();
  var tabBtns = document.querySelectorAll('.admin-tab-btn');
  tabBtns.forEach(function (btn) {
    if (btn.getAttribute('data-tab') === 'recipes') {
      btn.addEventListener('click', function () { triggerRecipesLoad(); });
    }
  });
};
function triggerRecipesLoad() {
  if (_recipesDataLoaded || _recipesDataLoading) return;
  _recipesDataLoading = true; _recipesDataLoaded = true;
  initRecipesTab();
}
```
Fetch middleware calls with `credentials: 'include'`; the global wrapper (L6-31) attaches `x-session-token`. Use `openModal`/`closeModal` (L1214/1222) for forms, `showConfirm(message, onConfirm, onCancel)` (L193) for archive/remove, `escapeHTML` (L5020) for every interpolated value (do NOT copy the raw interpolation in the schedule cards at L7230). Staff Access tab is hidden by default and shown only after `GET /api/staff-access/me` returns `role:'owner'`; surface `cannot_remove_self` / `last_owner` via `showToast(..., 'error')`. Schedule UI: "Delete" becomes Archive (primary) + Delete; a 409 `schedule_in_use` toast offers Archive via `actionLabel`; propagate result renders `batches_failed` with a Retry action (keep the existing save-then-propagate two-call flow at L7265-7507).

### `admin.html` (MOD)

**Analog:** itself. Tab button (L124): `<button type="button" class="admin-tab-btn" data-tab="recipes">Recipes</button>`; add `data-tab="vessels"` next to Scheduling/Ingredients (D-05) and `data-tab="staff-access"` (hidden by default). Panel (L446): `<div class="admin-tab-panel" id="tab-recipes">` (panel id is `'tab-' + data-tab`); header/table structure `.admin-panel-header`, `.admin-panel-actions`, `.admin-table-wrap > table.admin-table` per Recipes L446-476. No new third-party domain, so the CSP `<meta>` is untouched (CLAUDE.md rule 12).

### `js/brewpad.js` (MOD)

**Analog:** Phase 85 `submitRecipeSave` branch (85-PATTERNS "js/brewpad.js"): `adminApiPost` already propagates `err.status` / `err.code`; add `stale_schedule` / `schedule_in_use` branches beside the existing `unit_mismatch` branch, keep 409 out of the transient-retry set (`isTransient = !status || status === 502 || 503 || 504`) and prove it in a test. Touch points: schedule editor (research cites L9456, L9750, L10084), `get_vessels` dropdown consumers (L3398, L6902-6935) need NO change because archived vessels serialise as `status:'Disabled/Retired'` and existing filters already hide them (Pitfall 1). `npm run build` afterwards.

---

### Tests - copy targets (new files only)

| New test | Copy the harness from | Notes |
|----------|-----------------------|-------|
| `__tests__/db/vessel-pg*.test.js`, `ferm-schedule-pg*.test.js`, `staff-access-pg.test.js` | `__tests__/db/recipe-pg-update.test.js`, `recipe-pg-create.test.js`, `recipe-pg-delete.test.js` (`pg-harness` `describeDb`/`startPostgres`/`applyMigrations`, per-test rollback client; concurrency tests use dedicated pool clients) | Parallel creates give distinct `FS-` ids; stale rolled back; delete blocked/allowed; archive of In-Use blocked; status-delta idempotence; last-owner / mutual-removal serialised by `for update`; audit row atomic with the change |
| `ops-migration.test.js`, `ops-backfill.test.js` | `__tests__/db/recipes-migration.test.js`, `recipes-backfill.test.js` | `setval` seeds; empty-target precondition |
| `vessel-store.test.js`, `ferm-schedule-store.test.js`, `ops-store-mode.test.js` | `__tests__/recipe-store.test.js`; `recipes-store-mode.test.js` (L1-60: `jest.mock('express')` capturing router handlers incl. `put`/`delete`, `jest.mock('axios')`, mocked cache/logger/constants, `jest.resetModules()` + `jest.doMock('../lib/<store>')`) | sheets mode: real facade + mocked axios, call sequence identical to today |
| `ops-mirror.test.js` | `__tests__/recipe-mirror.test.js` | staging no-op; marker; coalescing; backoff; sweep |
| `staff-access.test.js`, `auth-tiers-revocation.test.js`, `staff-access-routes.test.js` | `__tests__/auth-tiers-guard.test.js` | env break-glass with DB down; PG error fail closed; anon/device/legacy/staff/owner x GET/POST matrix; GET unauthenticated => 401/403 |
| `admin-proxy-attribution.test.js` | `__tests__/admin-proxy.test.js`, `batch-admin-proxy.test.js` | session email injected as `acting_user`; client-supplied `acting_user`/`collect_vessel_status`/`vessel_sheet_write`/`schedule_steps_json` ignored; legacy => absent; write the regression test FIRST (bug-fix rule) |
| `__tests__/backfill/ops-*.test.js` | `recipes-backfill-plan.test.js`, `recipes-verify.test.js`, `recipes-spec-headers.test.js`, `recipes-replay-to-sheet.test.js` (ExcelJS temp workbooks) | Include rejects for secret-like Config key, blank `is_active`, bad `steps`, dup vessel id |

## Shared Patterns

### Postgres access - single gateway
**Source:** `zoho-middleware/lib/db.js` (exports `query, withTransaction, isConfigured, createPool, close`).
**Apply to:** every new lib, route and CLI. Nothing else may `require('pg')` or `new Pool()`.

### Store-mode resolution
**Source:** `lib/store-flag.js` `resolveStoreMode(name)` (L40-52; invalid value exits the process at boot, values rejected not coerced).
**Apply to:** vessel/schedule facades (`OPS_DATA_STORE`), `staff-access.js` (`STAFF_ACCESS_STORE`), routes (503 in sheets for vessel editor), recipes.js cache bypass.

### Sheet-mirror production gate
**Source:** `lib/sheet-mirror.js` `mirrorFireAndForget(label, fn)`, `isMirrorEnabled()`.
**Apply to:** `ops-mirror.js` and the `vessel_sheet_write` flag in the forwarder. Never re-implement the production check. Staff list: no mirror, no gate.

### Stale-save contract (D-16)
**Source:** `lib/recipe-pg.js` L264-275 `isStale`/`staleResult`, `routes/recipes.js` L755-761 409 mapping, `js/admin.js` L9076-9101 helpers.
**Apply to:** vessel update/archive routes, ferm-schedule update/delete/archive through the proxy interception, both editors. Only in dual/postgres modes; sheets stays last-save-wins.

### Auth on every route (GET included)
**Source:** `lib/authTiers.js` `requireTiers` L162-190; `server.js` L444 GET skip.
**Apply to:** `routes/vessels.js`, `routes/staff-access.js`, any new GET. Inline `authTiers.requireTiers([...])(req, res, function () {...})`, never as a third `router.get` argument (authTiers header note).

### Error handling and logging
**Source:** `routes/recipes.js` L769-772 and `routes/pos.js` L4028-4031: log `err.message` server-side, return generic body (`502 {ok:false,error:'server_error'}` or `{error:'Unable to ...'}`), never leak upstream text. Emails and names never in Sentry tags or log lines (use id or short hash).

### Business rejection vs infra failure
**Source:** `lib/recipe-pg.js` header L10-13 and `lib/recipe-store.js` header L15-18: business failures resolve `{ok:false,error,message}`, map to 4xx/409; only infra failures reject and map to 502.

### Test protection
CLAUDE.md rule 10 and RESEARCH Project Constraints: no edits to existing tests; sheets/unset mode byte-identical.

### Build and verification gates
`cd zoho-middleware && npm test`, root `npm test`, `npm run lint` (middleware `--max-warnings 0` over `routes/ lib/ scripts/ server.js`), `npm run migrate:guard`, `npm run test:db` (Docker Desktop must be running; locally self-skips), `npm run build` after admin/brewpad edits.

## No Analog Found

| File / Concern | Role | Data Flow | Reason |
|----------------|------|-----------|--------|
| Per-request allowlist revalidation with fail-closed + explicit cache invalidation (`staff-access.resolve`) | service | request-response | Today's allowlist is an env read at login only (`routes/auth.js` L94); use RESEARCH Pattern 6 and the `authTiers.js` L129-141 insertion point |
| Owner-only mutation chain (header-token-only, Origin check, owner role re-derived, audited tx, effective-owner `for update`) | route + service | CRUD | Nothing in the codebase combines these; compose from `requireTiers`, `requireAllowedReferer`, and the `recipe-pg` lock idiom |
| Vessel-status delta seam (`_vesselStatusLog`, `vessel_status_changes` in the response, `applyStatusChanges` in the shared forwarder, `vessel_sheet_write` flag) | controller + service | request-response | Apps Script has never reported side effects back to the middleware; RESEARCH Pattern 4 (assumption A6) |
| `acting_user` pass-through in the Apps Script `server_token` branch | controller | request-response | New; folded todo `.planning/todos/pending/admin-write-attribution-kiosk-middleware.md` is the spec |
| Staff audit log (append-only `staff_access_audit` written in the same tx) | service | CRUD | No audit table exists yet; DDL in RESEARCH Pattern 1 |
| Schedule `schedule_steps_json` injection for `createBatch` | controller | request-response | New (assumption A7) |

## Metadata

**Analog search scope:** `zoho-middleware/lib/`, `zoho-middleware/routes/`, `zoho-middleware/migrations/`, `zoho-middleware/scripts/backfill/` (incl. `specs/`), `zoho-middleware/__tests__/` (root, `db/`, `backfill/`), `zoho-middleware/server.js`, `apps-script/adminApi.gs`, `js/admin.js`, `admin.html`, `.planning/phases/85-*/85-PATTERNS.md`
**Files read (full or targeted):** `lib/recipe-store.js` (full), `lib/recipe-mirror.js` (full), `lib/recipe-pg.js` (1-140, 255-410), `lib/authTiers.js` (full), `lib/session.js` (full), `lib/store-flag.js` (full), `routes/auth.js` (full), `migrations/0003_recipes.sql` (full), `routes/pos.js` (3985-4185), `routes/recipes.js` (170-210, 735-797), `server.js` (100-120, 436-470, 915-935, mount lines), `scripts/backfill/recipes-backfill.js` (1-60), `scripts/backfill/recipes-replay-to-sheet.js` (1-30), `scripts/backfill/specs/ferm-schedules.js` (full), `apps-script/adminApi.gs` (332-345, 2454-2500, 4601-4625), `js/admin.js` (4-34, 690-712, 8300-8345, 9076-9105), `admin.html` (120-136), `__tests__/recipes-store-mode.test.js` (1-60), plus 86-CONTEXT.md, 86-RESEARCH.md, 85-PATTERNS.md
**Line numbers** were read 2026-10-07; re-grep `routes/pos.js` and `adminApi.gs` offsets before execution (RESEARCH validity note).
**Pattern extraction date:** 2026-10-07
