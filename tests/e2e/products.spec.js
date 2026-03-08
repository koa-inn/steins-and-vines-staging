// @ts-check
const { test, expect } = require('@playwright/test');

// Generous timeout — Zoho API can be slow on first request
const PRODUCTS_TIMEOUT = 20000;

test.describe('Products page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/products.html');
  });

  test('page title correct', async ({ page }) => {
    await expect(page).toHaveTitle(/Steins & Vines/i);
  });

  test('kits tab is active by default', async ({ page }) => {
    const kitsTab = page.locator('[data-product-tab="kits"]');
    await expect(kitsTab).toHaveClass(/active/);
  });

  test('ingredients tab button present', async ({ page }) => {
    await expect(page.locator('[data-product-tab="ingredients"]')).toBeVisible();
  });

  test('product catalog container exists', async ({ page }) => {
    await expect(page.locator('#product-catalog')).toBeAttached();
  });

  test('products load or show loading/error state within timeout', async ({ page }) => {
    // Accept any of: product cards, loading overlay still shown, or error state
    await expect(
      page.locator('.product-card, .label-wine, .label-beer, .loading-overlay, .error-state, [class*="product-card"]').first()
    ).toBeVisible({ timeout: PRODUCTS_TIMEOUT });
  });

  test('switching to ingredients tab changes active state', async ({ page }) => {
    await page.locator('[data-product-tab="ingredients"]').click();
    await expect(page.locator('[data-product-tab="ingredients"]')).toHaveClass(/active/);
    await expect(page.locator('[data-product-tab="kits"]')).not.toHaveClass(/active/);
  });

  test('cart sidebar present on desktop', async ({ page }) => {
    await expect(page.locator('.cart-sidebar')).toBeAttached();
  });

  test('reservation bar present', async ({ page }) => {
    await expect(page.locator('.reservation-bar').first()).toBeAttached();
  });
});

test.describe('Products — add to cart', () => {
  test('clicking Reserve adds item and shows qty controls', async ({ page }) => {
    await page.goto('/products.html');

    // Wait for at least one kit product with an enabled Reserve button
    const reserveBtn = page.locator('.product-reserve-btn:not([disabled])').first();
    await expect(reserveBtn).toBeVisible({ timeout: PRODUCTS_TIMEOUT });

    await reserveBtn.click();

    // After click, should show qty controls (not Reserve button)
    const qtyControls = page.locator('.product-qty-controls').first();
    await expect(qtyControls).toBeVisible({ timeout: 5000 });
  });

  test('cart sidebar shows item after add', async ({ page }) => {
    await page.goto('/products.html');

    const reserveBtn = page.locator('.product-reserve-btn:not([disabled])').first();
    await expect(reserveBtn).toBeVisible({ timeout: PRODUCTS_TIMEOUT });
    await reserveBtn.click();

    // On desktop, sidebar should reflect added item
    await expect(page.locator('#cart-sidebar-items')).not.toContainText('Your cart is empty', { timeout: 5000 });
  });
});
