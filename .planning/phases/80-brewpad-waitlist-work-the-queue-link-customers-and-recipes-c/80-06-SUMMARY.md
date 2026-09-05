---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
plan: 06
type: execute
status: complete
completed: 2026-09-05
commits:
  - a5516070  # Task 1 — author 80-CUTOVER.md
  - 1075157d  # Task 2 — owner verdicts recorded, §1a staged
  - c9910fcc  # code review + all 8 Critical/Warning fixes
  - b8f35143  # §1a — wire the beer-consult Cal.com event type
  - 6116b4cb  # §1a — record the event type in the runsheet
  - 8a3d7868  # fix: stop double-encoding the cached bookings payloads
  - 43a76763  # §6 leg 8 PASS (D-08 fail-closed vs a real Resend failure)
  - ad0d6c00  # §6 leg 7 PASS (contact end-to-end)
  - 3586b090  # §6 leg 4 upgraded to full PASS (multi-recipe)
  - 12fc04d9  # §6 leg 13 cleanup verified; stale checkpoint retired
---

# 80-06 Summary — Cutover

## Objective

Take Phase 80 from committed-but-unverified source to a live, staff-usable queue, through the one
sheet migration and the one Apps Script redeploy the phase is allowed (D-20), in the only order that
never 503s a live public signup (D-18).

## Outcome

**Complete.** All three tasks done. The runsheet, its owner decisions, the live cutover and the full
UAT are recorded in `80-CUTOVER.md`, which is the durable artifact this plan exists to produce.

| Task | Result |
|---|---|
| 1 — author `80-CUTOVER.md` | DONE (`a5516070`) |
| 2 — owner verdicts on five open items | DONE (`1075157d`) — four approved the shipped default; `eventtype` was OVERTURNED, creating the §1a prerequisite |
| 3 — live cutover: §1a → §2 → §3 → §4 → §5 → §6 | DONE — see below |

### Task 3 detail

- **§1a** — a beer-specific Cal.com event type `beer-consult` (id `6955754`) was created rather than
  reusing `FERMENT_KIT`, per the owner's overturn. Env var, `bookings.js` `ids` array, and
  `brewpad.js`'s slug-based selection with a fail-closed guard (WR-04) all landed.
- **§2** — six columns added as H..M **before** any redeploy; read probe against the still-old
  deployment returned `"ok":true`, proving old code tolerates the new columns.
- **§3** — one redeploy, v54 → v55, as a new version of the SAME deployment. Rollback target **54**
  recorded *before* the redeploy and the deployment ID verified byte-identical — closing the gap
  Phase 78 left behind.
- **§4** — four probes PASS with real response bodies, plus a bonus CR-02 formula-injection probe
  confirming `waitlistCellSafe()` apostrophe-guards `=1+1` live on v55.
- **§5** — staging deploy green, middleware `/health` 200.
- **§6** — **13 PASS / 0 PARTIAL / 0 FAIL.**

## Must-haves

| Must-have | Verdict | Evidence |
|---|---|---|
| Columns added BEFORE the redeploy (D-18) | ✅ | §2 ran and its gate probe passed before §3; §4 probe (a) shows all six keys present on v55 |
| Columns appended H..M, never inserted | ✅ | §2 step 4; positional-append check in §4 |
| Exactly ONE redeploy, same deployment, `/exec` URL unchanged (D-20) | ✅ | §3 — v54→v55, deployment ID byte-identical to the committed `ADMIN_API_URL` |
| Prior + new version numbers and deployment ID recorded | ✅ | §3 rollback table, filled with real values before redeploying |
| Contact wording and Cal.com event type owner-approved before shipping | ✅ | Owner decisions §1 (template approved) and §5 (`eventtype` overturned → `beer-consult`) |
| Every UAT leg verified server-side via `get_waitlist`, not by UI appearance | ✅ | Every leg in §6 carries a server-side assertion; leg 3 was caught as INCONCLUSIVE by this discipline and re-run properly rather than recorded as a false PASS |

## Deviations

1. **Ordering deviation (§5).** The staging push was performed before §2 and §3 at the owner's
   explicit request, leaving staging briefly running Phase 80 code against the un-migrated sheet.
   Recorded in the runsheet at the time, and resolved: §6's UAT was only attempted after §2 and §3
   completed. **D-18's load-bearing order — columns before redeploy — was never violated.**
2. **A pre-existing bug surfaced mid-UAT.** Leg 7 exposed double-encoded JSON on cached
   `/api/bookings/services` responses: the endpoint looked correct on a first call and returned
   garbage on every subsequent one, because only the cache-*hit* path was broken. Fixed with
   regression tests (`8a3d7868`). Not Phase 80 code, but Phase 80's leg 7 is what found it.
3. **Artifact contract wording.** The plan's `contains:` field specified the literal string
   `MIGRATION ORDER`; the runsheet expresses the same requirement as
   *"## 2. Sheet migration (BLOCKING, owner) — MUST happen before §3"*. The substance is present and
   was executed correctly; only the literal token differs. Recorded rather than retrofitted, since
   editing the doc purely to satisfy a string match would be gaming the check.

## Follow-ups (not blocking this plan)

- **Production cutover (§7)** — explicitly out of scope, batched with the pending 51/74/78/79
  pushes. `CALCOM_EVENT_TYPE_BEER_WAITLIST=6955754` **must be set on production Railway** as part of
  it; confirmed on staging, never verified on prod, and the contact flow fails closed without it.
- **Phase 78's missing rollback version numbers** (`78-HUMAN-UAT.md`) remain unrecovered. Flagged in
  the runsheet as a natural side-trip during §3; not taken.
- **WR-02 optimistic locking** carried forward, not closed — closing it needs a 14th column and a
  second redeploy, which D-20 forbids.
