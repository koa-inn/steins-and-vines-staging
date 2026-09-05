---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
verified: 2026-09-05T13:40:00Z
status: passed
score: 6/6 plan must-haves verified; 5/5 phase capabilities delivered and live-verified
overrides_applied: 0
gates:
  frontend_tests: "1643/1643 passing (108 suites)"
  middleware_tests: "1582/1582 passing (107 suites)"
  lint: "clean"
  uat: "13 PASS / 0 PARTIAL / 0 FAIL"
human_verification:
  - test: "Set CALCOM_EVENT_TYPE_BEER_WAITLIST=6955754 on the PRODUCTION Railway environment"
    expected: "The Contact flow resolves the beer-consult booking link in production instead of failing closed"
    why_human: "Railway dashboard access; no CLI path from here. NOT blocking this phase — production cutover is explicitly out of Phase 80's scope (§7) and is batched with the pending 51/74/78/79 pushes. Recorded so the cutover does not ship a fail-closed Contact button."
    status: OPEN
  - test: "Recover Phase 78's prior Apps Script deployment version numbers (78-HUMAN-UAT.md)"
    expected: "Phase 78's rollback table has a selectable target"
    why_human: "Apps Script UI deployment history; no CLI path. Inherited from Phase 78, not caused by Phase 80 — flagged in 80-CUTOVER.md as a natural side-trip during §3, not taken. Phase 80's own rollback target (54) IS recorded."
    status: OPEN
---

# Phase 80: BrewPad Waitlist — Work the Queue, Verification Report

**Phase Goal:** Turn the beer waitlist from a list staff *read* into one they *work* — link a row to
its Zoho customer, link it to the recipe that person will brew, contact them from BrewPad, and
override the queue order by hand when reality demands it.

**Verified:** 2026-09-05T13:40:00Z
**Status:** PASSED

## Goal-backward analysis

The phase goal is behavioural, not structural: staff should be able to run the queue without leaving
BrewPad. So the question is not "did the code land" but "can each of those five things actually be
done against the live system". Every one was exercised on staging against the deployed Apps Script
v55 and verified **server-side through `get_waitlist`**, never by UI appearance.

| # | Capability the goal promises | Delivered | Live evidence |
|---|---|---|---|
| 1 | Link a row to its Zoho customer | ✅ | Legs 1 (link existing), 2 (inline create), 3 (D-03a guard: linking never overwrites a hand-typed phone) |
| 2 | Attach the recipes they'll brew | ✅ | Leg 4 — two attached gave `recipe_ids="SV-R-000011\|SV-R-000003"`, removing one left exactly `"SV-R-000003"` |
| 3 | Contact them from BrewPad | ✅ | Leg 7 end-to-end (email delivered, `status:"contacted"`, ISO `contacted_at`), leg 8 fail-closed, leg 9 disabled on `booked` |
| 4 | Override queue order by hand | ✅ | Legs 5 (pin to position 2) and 6 (clear pin), with all six real customers' `signed_up_at` verified unchanged |
| 5 | Add someone manually (walk-ins) | ✅ | Legs 10 (new address) and 11 (D-23 already-on-list disclosure, no duplicate row, typed fields genuinely discarded) |
| — | Public promise unchanged (D-14, D-06) | ✅ | Leg 12 — `beer.html` copy unchanged, public signup response identical, no prior-state disclosure, no duplicate row |

**The goal is achieved.** All five capabilities work against the live deployment, and the
customer-facing surface the phase was constrained not to disturb is provably undisturbed.

## Plan must-haves (80-06)

6/6 verified — see `80-06-SUMMARY.md` for the evidence table. The load-bearing ones:

- **D-18 migration order held.** Columns H..M were added *before* the redeploy, with a gate probe
  proving the still-old code tolerated them. This is the ordering that would otherwise 503 every
  public signup.
- **D-20 honoured.** Exactly one redeploy, v54 → v55, as a new version of the *same* deployment. The
  `/exec` URL and deployment ID are byte-identical to the committed `ADMIN_API_URL`, so no
  `admin-config.js` edit and no Railway change were needed.
- **Rollback target recorded before the redeploy** (version 54) — closing precisely the gap Phase 78
  left open.

## Automated gates

| Gate | Result |
|---|---|
| Frontend (Jest/jsdom) | **1643/1643**, 108 suites |
| Middleware (Jest) | **1582/1582**, 107 suites |
| ESLint (`--max-warnings 0`) | clean |

## Findings

**No blocking gaps.** Three things are recorded honestly rather than papered over:

1. **Ordering deviation in §5.** The staging push happened before §2/§3 at the owner's explicit
   request, so staging briefly ran Phase 80 code against the un-migrated sheet. Recorded at the
   time; resolved, because UAT was only attempted after §2 and §3 completed. **D-18's load-bearing
   order was never violated.**
2. **Artifact-contract wording mismatch.** 80-06's `contains:` field named the literal string
   `MIGRATION ORDER`; the runsheet expresses the identical requirement as *"## 2. Sheet migration
   (BLOCKING, owner) — MUST happen before §3"*. Substance present and correctly executed; only the
   token differs. Not retrofitted — editing the doc solely to satisfy a string match would be gaming
   the check, and the check exists to ensure the instruction is *there*, which it is.
3. **A pre-existing bug found by this phase's UAT.** Leg 7 surfaced double-encoded JSON on cached
   `/api/bookings/services` responses — correct on the first call, garbage on every one after,
   because only the cache-hit path was broken. Fixed with regression tests (`8a3d7868`). Not Phase 80
   code; Phase 80's UAT is what caught it.

## Carried forward (by design, not gaps)

- **WR-02 optimistic locking** — carried forward, not closed. Closing it needs a 14th column and a
  second redeploy, which D-20 forbids.
- **Production cutover (§7)** — explicitly out of scope, batched with the pending 51/74/78/79
  pushes. See `human_verification` above for the env var it must carry.

## Verdict

**PASSED.** All five capabilities in the phase goal are delivered and live-verified, all six plan
must-haves hold, every automated gate is green, and the full 13-leg UAT is green with cleanup
verified complete. No UAT leg ever wrote to a real customer row — re-verified after every leg.
