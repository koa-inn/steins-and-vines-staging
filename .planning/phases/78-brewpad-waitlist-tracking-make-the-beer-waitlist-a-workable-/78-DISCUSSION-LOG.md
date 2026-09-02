# Phase 78 — Discussion Log

**Date:** 2026-09-02
**Mode:** discuss (default, interactive)
**Human reference only — not consumed by downstream agents. CONTEXT.md is canonical.**

## Framing

Phase entered on owner request to "move back to getting the beer waitlist setup".
Scouting established the customer-facing waitlist is ALREADY live (beer.html form →
setupBeerWaitlistForm → POST /api/waitlist → MailerLite). The gap is internal: MailerLite
is the entire record and is not queryable as an ordered work list.

Side finding raised before discussion: `.planning/todos/pending/remove-dead-beer-waitlist-handler.md`
instructed deleting `setupBeerWaitlistForm()` as dead code. Phase 74-06 had since rewired that
handler to the live beer.html form, so acting on it would have broken beer signups. Todo rewritten
as a warning and STATE.md's "Pending Todos: None" corrected (commit 0c7d6282) before proceeding.

## Areas selected

Owner selected all four offered: system of record, signup failure mode, backfill, staff workflow.

## Q&A

**Q1 — Where do entries live?**
Options: Google Sheet tab (rec) / add Postgres / Zoho contacts.
→ **Google Sheet tab.** (D-01)

**Q2 — Beer-only or category column?**
Options: category column day one (rec) / beer-only / column but beer-only UI.
→ **Category column from day one.** (D-02)
Reasoning surfaced: adminApi.gs has no CI path, so later schema changes cost a manual redeploy;
cider has already launched.

**Q3 — What happens when a signup can't be fully recorded?**
Options: sheet authoritative + MailerLite best-effort (rec) / both must succeed / fail open.
→ **Sheet authoritative & blocking; MailerLite fire-and-forget.** (D-03)
Explicitly accepted trade: marketing sync can drift silently → mitigated by D-07.

**Q4 — Existing signups?**
Options: one-time CSV import (rec) / build MailerLite read integration / start fresh.
→ **One-time CSV import at cutover, subscribed_at as queue order.** (D-04)
Flagged as a manual owner step; research must confirm the export carries usable dates.

**Q5 — Statuses?**
Options: waiting→contacted→booked + removed (rec) / waiting→done + removed / add no-response.
→ **waiting → contacted → booked, plus removed.** (D-05)

**Q6 — Duplicate email?**
Options: ignore silently keep position (rec) / allow duplicate rows / reject with message.
→ **Idempotent, original position preserved, normal success response.** (D-06)

**Q7 — MailerLite drift visibility?**
Options: persisted column (rec) / log only / background retry.
→ **Persisted `mailerlite_synced` column, filterable in BrewPad.** (D-07)
Directly cites the Phase 51 criterion-2 lesson.

**Q8 — Link booked entries to customer/batch?**
Options: standalone + notes (rec) / link Zoho customer / link batch.
→ **Standalone list with free-text notes.** (D-08) Linking deferred to its own phase.

## Notes

- Every recommended option was accepted; no option was overridden.
- No scope creep raised by the owner during discussion.
- Roadmap's three open questions are all now answered: where entries live (D-01),
  linking (D-08), and generalisation (D-02).
