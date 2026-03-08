// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('page loads with 200 status', async ({ page }) => {
    const response = await page.goto('/');
    expect(response.status()).toBe(200);
  });

  test('has correct page title', async ({ page }) => {
    await expect(page).toHaveTitle(/Steins & Vines/i);
  });

  test('hero section is visible', async ({ page }) => {
    const hero = page.locator('.hero, #hero, [class*="hero"]').first();
    await expect(hero).toBeVisible();
  });

  test('primary navigation links present', async ({ page }) => {
    // Site nav should have links to key pages
    await expect(page.locator('a[href*="products"]').first()).toBeVisible();
    await expect(page.locator('a[href*="contact"]').first()).toBeVisible();
  });

  test('no JS errors on load (network 404s tracked separately)', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));
    await page.goto('/');
    await page.waitForTimeout(2000);
    expect(jsErrors).toHaveLength(0);
  });


  test('featured products section exists', async ({ page }) => {
    // The featured products section should at least be present in the DOM
    await expect(page.locator('#featured-products, .featured-products, [id*="featured"]').first()).toBeAttached();
  });

  test('service worker registers without error', async ({ page }) => {
    const swErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && msg.text().includes('service-worker')) {
        swErrors.push(msg.text());
      }
    });
    await page.goto('/');
    await page.waitForTimeout(1500);
    expect(swErrors).toHaveLength(0);
  });
});
