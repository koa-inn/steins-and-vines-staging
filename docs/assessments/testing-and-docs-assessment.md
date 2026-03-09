# Steins & Vines — Engineering Assessment
**Date:** March 9, 2026
**Scope:** Testing Infrastructure & Strategy + Documentation

---

## Part 1: Testing Strategy Assessment

### Current State

The project has a well-structured testing foundation built through a campaign-based approach documented in `TESTING.md`. Here's what exists today:

**Unit Tests — Middleware (7 files)**
| File | What it covers |
|------|---------------|
| `validate.test.js` | Input validation (98% threshold) |
| `logger.test.js` | Logging wrapper (98% threshold) |
| `zoho-api.test.js` | API helpers, retry logic, pagination |
| `zohoAuth.test.js` | OAuth flow, AES encryption/decryption |
| `cache.test.js` | Redis cache wrapper |
| `checkout.test.js` | `verifyRecaptcha`, `buildLineItems` |
| `taxes.test.js` | CSV parsing, keyword matching, tax classification |

**Unit Tests — Frontend (10 files)**
| File | What it covers |
|------|---------------|
| `utils.test.js` | `escapeHTML`, `parseCSVLine` |
| `label-cards.test.js` | `getTintClass`, `formatCurrency` |
| `catalog-view.test.js` | `getCatalogViewMode` |
| `catalog-search.test.js` | Catalog search functionality |
| `cart.test.js` | `getCartKey`, `getCartKeyForTab`, `getEffectiveMax` |
| `cart-localStorage.test.js` | Cart persistence (localStorage) |
| `cart-dom.test.js` | `renderReserveControl`, `renderWeightControl` |
| `checkout-validation.test.js` | `formatTimeslot`, `formatPhoneInput`, `isValidEmail`, `isValidPhone` |
| `checkout-completion.test.js` | `calcCompletionRange` |
| `brewpad-pure.test.js` | `escapeHTML`, `fmtDate`, `todayStr`, ABV calc, batch filters |

**E2E Tests (Playwright, 4 spec files)**
| File | Tests | What it covers |
|------|-------|---------------|
| `homepage.spec.js` | 7 | Page load, hero, nav, SW registration |
| `checkout.spec.js` | 7 | Seeded cart flow, stepper, form validation |
| `products.spec.js` | 10 | Catalog tabs, add-to-cart, cart sidebar |
| `static-pages.spec.js` | ~12 | About, contact, ingredients, sub-pages |

**CI Pipeline (`.github/workflows/tests.yml`)**
- Two parallel jobs: `test-middleware` + `test-frontend`
- E2E job runs only on push to main (after unit tests pass)
- Playwright browser caching, artifact upload on failure
- Node 20, ubuntu-latest

### What's Working Well

The campaign-based approach is smart for a project this size. Rather than trying to retrofit 100% coverage in one pass, each campaign targets specific extractable pure functions and builds coverage incrementally. The TESTING.md is an excellent operational document — it serves as both a progress tracker and a pattern reference that makes it easy for future sessions to continue the work.

The test pyramid shape is reasonable: many unit tests at the base, a handful of E2E tests at the top. The conditional export pattern (`if (typeof module !== 'undefined')`) is a pragmatic solution for testing vanilla JS modules without a bundler.

### Coverage Gaps

**Critical gaps (routes with no tests):**

| Route file | Risk | Why it matters |
|-----------|------|---------------|
| `routes/payments.js` | **HIGH** | Handles credit card charges, voids, refunds. Zero test coverage. |
| `routes/bookings.js` | MEDIUM | Customer-facing booking flow, has known double-parse bug |
| `routes/items.js` | MEDIUM | Direct Zoho passthrough with no validation (mass assignment risk) |
| `routes/pos.js` | MEDIUM | POS transactions, kiosk checkout |
| `routes/catalog.js` | LOW | Read-only catalog proxy |
| `routes/auth.js` | LOW | Google OAuth relay |
| `routes/requests.js` | LOW | Product request form (silently swallows Redis failures) |
| `routes/purchaseorders.js` | LOW | Internal admin CRUD |

**Middleware lib files excluded from coverage:**

| File | Reason | Risk |
|------|--------|------|
| `lib/gp.js` | GP SDK initialization — marked "Campaign 2+" | MEDIUM — initializes payment terminals |
| `lib/mailer.js` | Nodemailer wrapper — marked "Campaign 2+" | LOW — email sending |

**Frontend files with no unit tests:**

| File | Risk |
|------|------|
| `js/kiosk.js` (1700+ lines) | HIGH — handles POS payments, Google OAuth tokens in localStorage |
| `js/admin.js` | MEDIUM — heavy innerHTML, internal tooling |
| `js/batch.js` | LOW — public batch tracker, uses `esc()` |
| `js/modules/03-events.js` | LOW — event tracking, small file |

**E2E gaps:**
- No E2E tests for the reservation/booking flow
- No E2E tests for kiosk mode
- No E2E tests for admin panel
- No E2E tests for the contact form
- Chromium-only — no Firefox or Safari/WebKit
- No mobile viewport testing
- E2E only runs on push to main, not on PRs (by design, since it hits live staging)

### Coverage Thresholds

The current thresholds tell an interesting story:
- **Frontend global: 5% lines** — intentionally low, reflects Campaign 1 scope
- **Middleware global: 35% lines** — more mature, with per-file targets of 98% for validate.js and logger.js
- **TESTING.md claims**: middleware ≥70%, frontend ≥80% — but the jest configs say 35% and 5%. These are out of sync.

### Recommendations (Priority Order)

**1. Add route-level integration tests for payments.js (Campaign 3)**
This is the highest-risk untested code. Mock the GP SDK and test charge/void/refund endpoints for success paths, validation failures, declined cards, and error handling. Verify the `withAllowDuplicates(true)` behavior.

**2. Add route-level tests for checkout.js edge cases (Campaign 3)**
Checkout already has `verifyRecaptcha` and `buildLineItems` unit tests, but the actual route handler — idempotency key logic, void-on-failure flow, price anchoring — is untested at the integration level.

**3. Reconcile coverage thresholds with TESTING.md claims**
The jest configs show 5% and 35%, but TESTING.md says ≥80% and ≥70%. Update one or the other so the documentation matches reality.

**4. Add E2E test for the reservation booking flow (Campaign 4)**
This is a customer-facing flow that touches payments. Even a smoke test (load page → select date → verify deposit form appears) would catch regressions.

**5. Add Firefox/WebKit to Playwright projects (Campaign 5)**
Currently Chromium-only. Adding WebKit would catch Safari-specific CSS/JS issues that affect a significant portion of visitors.

**6. Consider running E2E on PRs against a preview deployment**
Currently E2E only runs post-merge on main. If Railway supports preview deployments, running E2E pre-merge would catch regressions before they hit staging.

**7. Extract and test kiosk.js pure functions (Campaign 5+)**
At 1700+ lines with payment terminal handling, this file has significant untested business logic. Apply the same campaign approach — extract pure functions, export conditionally, test incrementally.

---

## Part 2: Documentation Assessment

### What Exists

| Document | Location | Quality | Purpose |
|----------|----------|---------|---------|
| `style_guide.md` | Root | **Excellent** (827 lines) | Brand guide, Canadian ad compliance, color/type system, voice & tone |
| `TESTING.md` | Root | **Very Good** | Testing SOP, campaign tracker, pattern reference, architecture notes |
| `kiosk-checkout-setup.md` | (referenced) | Good | Kiosk terminal setup instructions |
| Code comments | Throughout | Variable | Inline JSDoc on some middleware functions |

### What's Missing

**1. README.md — Does not exist**
There is no README in the project root. This is the single most impactful documentation gap. A new contributor (or future-you after a break) has no entry point to understand what the project is, how to set it up, or how to deploy it.

**2. API Documentation — Does not exist**
The middleware exposes ~25 endpoints across 10 route files. There is no API reference document. Endpoint behavior must be reverse-engineered from source code.

**3. Deployment Runbook — Does not exist**
The project uses a two-repo staging/production workflow (GitHub Pages + Railway), but the deployment process is not documented. How do you deploy to staging? How do you promote to production? What's the rollback procedure?

**4. Architecture Overview — Does not exist**
The system has multiple integration points (Zoho Books, Zoho Inventory, Zoho Bookings, Global Payments, Google Apps Script, Redis, Sentry) but there's no diagram or document explaining how they connect.

**5. Environment Variables Reference — Does not exist**
The middleware references 15+ env vars (`ZOHO_ORG_ID`, `ZOHO_CLIENT_ID`, `GP_APP_KEY`, `REDIS_URL`, `SENTRY_DSN`, etc.) scattered across files. No `.env.example` or configuration reference exists.

**6. Onboarding Guide — Does not exist**
No document walks a new developer through local setup, required accounts, or how to get the middleware running locally.

### What's Good

The `style_guide.md` is genuinely impressive — it covers brand foundation, Canadian CRTC/LCRB advertising regulations, logo system, color palette, typography, photography, voice & tone, and brand governance. This is production-grade brand documentation.

`TESTING.md` is well-organized with a campaign progress table, clear SOP for adding tests, pattern reference with code examples, and architecture notes. It's a model for how operational docs should work.

### Recommendations (Priority Order)

**1. Create README.md**
Should cover: what the project is, tech stack overview, local setup (frontend + middleware), environment variables, how to run tests, deployment workflow, and links to other docs.

**2. Create .env.example for the middleware**
List all required and optional environment variables with descriptions. This is both documentation and a practical onboarding tool.

**3. Create an API reference**
At minimum, a markdown file listing each endpoint with method, path, expected body, and response shape. Can be auto-generated from a pass through the route files.

**4. Create a deployment runbook**
Document the staging → production workflow, Railway deployment, GitHub Pages setup, and rollback procedures.

**5. Add an architecture diagram**
A simple mermaid diagram showing: Browser → GitHub Pages (static), Browser → Railway (middleware) → Zoho APIs, Redis, GP SDK, Google Apps Script.

---

## New Tickets from This Assessment

The following issues are not covered by the existing 55 + 8 supplement tickets:

| # | Title | Priority | Type |
|---|-------|----------|------|
| 1 | Route-level integration tests for payments.js | Medium | Testing |
| 2 | Route-level integration tests for checkout.js edge cases | Medium | Testing |
| 3 | Reconcile coverage thresholds between jest configs and TESTING.md | Low | Testing |
| 4 | E2E test for reservation/booking flow | Medium | Testing |
| 5 | Add Firefox/WebKit to Playwright config | Low | Testing |
| 6 | Create README.md | High | Documentation |
| 7 | Create .env.example for middleware | Medium | Documentation |
| 8 | Create API endpoint reference | Medium | Documentation |
| 9 | Create deployment runbook | Medium | Documentation |
| 10 | Add architecture diagram (mermaid) | Low | Documentation |
| 11 | Extract and test kiosk.js pure functions | Low | Testing |
| 12 | E2E tests for mobile viewports | Low | Testing |
