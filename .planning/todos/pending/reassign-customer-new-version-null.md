---
title: "Reassign-customer returns new_version always null"
status: pending
created: 2026-10-09
source: phase 87-01 design doc (Q18)
area: middleware / batches
priority: low
---

Pre-existing bug: the reassign-customer path reads `last_updated` for `new_version`, but the Apps Script returns `newVersion`, so `new_version` is always null.
Not fixed in Phase 87 (parity port). Write a regression test first, then fix as one logical change.
