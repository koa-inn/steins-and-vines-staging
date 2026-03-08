// @ts-check
const { test, expect } = require('@playwright/test');

// Pre-seed the ferment cart so the checkout page doesn't redirect away
const SEEDED_CART = JSON.stringify([
  {
    name: 'Test Wine Kit', brand: 'E2E', qty: 1,
    item_type: 'kit', price: '29.99', time: '4',
    sku: 'TEST-001', unit: '', zoho_item_id: ''
  }
]);

test.describe('Checkout / reservation page', () => {
  test.beforeEach(async ({ page }) => {
    // Seed the cart before page load so the redirect guard is satisfied
    await page.addInitScript((cart) => {
      localStorage.setItem('sv-cart-ferment', cart);
    }, SEEDED_CART);

    await page.goto('/reservation.html?cart=ferment');
  });

  test('page loads without redirect', async ({ page }) => {
    // Should stay on reservation.html (not redirect to products.html)
    await expect(page).toHaveURL(/reservation\.html/);
  });

  test('checkout stepper is visible', async ({ page }) => {
    await expect(page.locator('.checkout-stepper, #checkout-stepper')).toBeVisible();
  });

  test('step 1 (Review Items) is active on load', async ({ page }) => {
    const step1 = page.locator('.stepper-step').first();
    await expect(step1).toHaveClass(/stepper-step--active/);
  });

  test('reserved item appears in review section', async ({ page }) => {
    await expect(page.locator('[id*="reservation-items"], .reservation-items, #reservation-section').first())
      .toBeAttached({ timeout: 10000 });
    // The item name should appear somewhere on the page
    await expect(page.locator('body')).toContainText('Test Wine Kit', { timeout: 10000 });
  });

  test('contact form fields present', async ({ page }) => {
    await expect(page.locator('#res-name')).toBeAttached();
    await expect(page.locator('#res-email')).toBeAttached();
    await expect(page.locator('#res-phone')).toBeAttached();
  });

  test('email validation — invalid email shows error', async ({ page }) => {
    const emailInput = page.locator('#res-email');
    await emailInput.fill('notanemail');
    await emailInput.blur();
    // Should show a validation error
    await expect(page.locator('.form-error-msg.visible').first()).toBeVisible({ timeout: 3000 });
  });

  test('email validation — valid email clears error', async ({ page }) => {
    const emailInput = page.locator('#res-email');
    await emailInput.fill('notanemail');
    await emailInput.blur();
    await emailInput.fill('valid@example.com');
    await emailInput.blur();
    await expect(page.locator('.field-valid')).toBeVisible({ timeout: 3000 });
  });

  test('phone formats automatically on input', async ({ page }) => {
    const phoneInput = page.locator('#res-phone');
    await phoneInput.fill('6045551234');
    // The input handler reformats as (604) 555-1234
    await expect(phoneInput).toHaveValue('(604) 555-1234', { timeout: 2000 });
  });
});
