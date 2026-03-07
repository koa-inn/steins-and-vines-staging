# Testing SOP — Steins & Vines

## Quick Start

```bash
# Middleware tests
cd zoho-middleware && npm test

# Frontend tests (from repo root)
npm test

# Coverage report
npm run test:coverage          # root frontend
cd zoho-middleware && npm run test:coverage
```

---

## Campaign Progress

| File | Target | Status |
|------|--------|--------|
| `zoho-middleware/lib/validate.js` | 100% | ✅ Done |
| `zoho-middleware/lib/logger.js` | 95% | ✅ Done |
| `zoho-middleware/lib/zoho-api.js` (`withRetry` only) | 80% | ✅ Done |
| `zoho-middleware/lib/zohoAuth.js` (`encrypt`/`decrypt`) | 70% | ✅ Done |
| `zoho-middleware/lib/cache.js` | 75% | ✅ Done |
| `js/modules/02-utils.js` (`escapeHTML`, `parseCSVLine`) | 95% | ✅ Done |
| `js/modules/04-label-cards.js` (`getTintClass`, `formatCurrency`) | 95% | ✅ Done |
| `js/modules/05-catalog-view.js` (`getCatalogViewMode`) | 90% | ✅ Done |
| `js/modules/11-cart.js` (`getCartKey`, `getCartKeyForTab`, `getEffectiveMax`) | 90% | ✅ Done |

---

## Campaign Backlog (future sessions)

- [ ] **Campaign 2:** `routes/taxes.js` — tax calculation helpers
- [ ] **Campaign 2:** `routes/checkout.js` — `verifyRecaptcha()`, price anchoring
- [ ] **Campaign 3:** `js/modules/11-cart.js` — DOM rendering (jsdom + mock products)
- [ ] **Campaign 3:** `js/modules/12-checkout.js` — form validation logic
- [ ] **Campaign 4:** `js/brewpad.js` IIFE — extract pure fns (ABV calc, date helpers, batch filters)
- [ ] **Campaign 4:** `js/admin.js` IIFE — reservation status logic
- [ ] **Campaign 5:** E2E with Playwright against staging

---

## SOP — Adding Tests for New Code

When writing a new function, ask:

1. **Pure (no DOM, no network)?** → Write a test immediately in the same session.
2. **Uses localStorage only?** → Test with jsdom's built-in `localStorage`; clear in `beforeEach(() => localStorage.clear())`.
3. **Uses fetch?** → Mock with `global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }))`.
4. **DOM-rendering?** → Defer, add to Campaign Backlog above.

**File placement:**
- Middleware function → `zoho-middleware/__tests__/<filename>.test.js`
- Frontend module function → `tests/frontend/<module-slug>.test.js`

**Adding exports to a frontend module** (append at bottom of source file):
```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { myNewFn: myNewFn };
}
```
This is a no-op in the browser. Lets Jest `require()` it without touching the build.

**Adding exports to a middleware lib file:** standard CommonJS — add to the existing `module.exports`.

---

## Pattern Reference

### Pure function
```js
const { myFn } = require('../../js/modules/02-utils');
test('handles null input', () => { expect(myFn(null)).toBe(''); });
```

### Fake timers (withRetry, debounce)
```js
jest.useFakeTimers();
const p = withRetry(fn, { retries: 2, baseDelay: 300 });
await jest.advanceTimersByTimeAsync(300);   // fires first retry delay
await jest.advanceTimersByTimeAsync(600);   // fires second retry delay
const result = await p;
```

### Redis mock
```js
jest.mock('redis', () => ({ createClient: jest.fn() }));
// In beforeEach after jest.resetModules():
const redisMock = require('redis');
redisMock.createClient.mockReturnValue(mockClient);
```

### Fetch mock
```js
global.fetch = jest.fn(() =>
  Promise.resolve({ ok: true, text: () => Promise.resolve('a,b\n1,2') })
);
```

### localStorage (jsdom — already available in testEnvironment: 'jsdom')
```js
beforeEach(() => localStorage.clear());
localStorage.setItem('key', 'val');
expect(myFn()).toBe('val');
```

---

## Architecture Notes

- **Two Jest configs**: `jest.config.js` (root, jsdom) + `zoho-middleware/jest.config.js` (node)
- **Frontend modules** use `if (typeof module !== 'undefined' && module.exports)` guard — no-op in browser
- **`zohoAuth.js`** exports `encrypt`/`decrypt` for testing; these are internal helpers exposed only via module.exports
- **`decrypt()`** returns `null` on GCM authentication failure (catch added in Campaign 1)
- **`05-catalog-view.js`** `window.addEventListener` is guarded by `typeof window !== 'undefined'` check so it loads cleanly in jsdom and Node
- **Coverage thresholds**: middleware ≥70% lines (global), frontend ≥80% lines (global) — CI fails below these

---

## CI

Tests run automatically on every push to `main` via `.github/workflows/tests.yml`.
Two parallel jobs: `test-middleware` and `test-frontend`.
