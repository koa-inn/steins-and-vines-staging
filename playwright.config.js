// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 },

  // 1 retry in CI to handle transient network hiccups
  retries: process.env.CI ? 1 : 0,

  // Serial in CI to avoid hammering staging/Zoho concurrently
  workers: process.env.CI ? 1 : undefined,

  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: process.env.BASE_URL || 'https://staging.steinsandvines.ca',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
