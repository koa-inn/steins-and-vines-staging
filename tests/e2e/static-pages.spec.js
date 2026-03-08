// @ts-check
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// About page
// ---------------------------------------------------------------------------
test.describe('About page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/about.html');
  });

  test('page loads with correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/Steins & Vines/i);
  });

  test('about page shows real owner names (not placeholder)', async ({ page }) => {
    // content/about.json has real owner names — JS replaces HTML placeholders at runtime
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/Owner Name/i);
    expect(bodyText).not.toMatch(/lorem ipsum/i);
  });

  test('navigation back to home works', async ({ page }) => {
    await page.locator('a[href*="index"], a[href="/"], .nav-logo, .site-logo').first().click();
    await expect(page).toHaveURL(/\/(index\.html)?$/);
  });
});

// ---------------------------------------------------------------------------
// Contact page
// ---------------------------------------------------------------------------
test.describe('Contact page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contact.html');
  });

  test('page loads', async ({ page }) => {
    await expect(page).toHaveTitle(/Steins & Vines/i);
  });

  test('contact form is present', async ({ page }) => {
    await expect(page.locator('form').first()).toBeVisible();
  });

  test('contact form has name, email, message fields', async ({ page }) => {
    await expect(page.locator('input[name="name"], input[id*="name"]').first()).toBeAttached();
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeAttached();
    await expect(page.locator('textarea').first()).toBeAttached();
  });

  test('does not submit empty form', async ({ page }) => {
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();
    // Should still be on contact page (not navigated away)
    await expect(page).toHaveURL(/contact\.html/);
  });
});

// ---------------------------------------------------------------------------
// Ingredients page (separate URL from products)
// ---------------------------------------------------------------------------
test.describe('Ingredients page', () => {
  test('page loads', async ({ page }) => {
    const response = await page.goto('/ingredients.html');
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(/Steins & Vines/i);
  });
});

// ---------------------------------------------------------------------------
// Products sub-pages
// ---------------------------------------------------------------------------
test.describe('Product sub-pages', () => {
  test('ferment-in-store page loads', async ({ page }) => {
    const response = await page.goto('/products/ferment-in-store.html');
    expect(response.status()).toBe(200);
  });

  test('ingredients-supplies page loads', async ({ page }) => {
    const response = await page.goto('/products/ingredients-supplies.html');
    expect(response.status()).toBe(200);
  });
});
