module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/frontend/**/*.test.js'],
  collectCoverage: true,
  collectCoverageFrom: [
    'js/modules/02-utils.js',
    'js/modules/04-label-cards.js',
    'js/modules/05-catalog-view.js',
    'js/modules/11-cart.js',
    'js/modules/12-checkout.js'
  ],
  // Global threshold reflects Campaign 1 scope (pure functions only from large files).
  // Raise each campaign as more functions are extracted and tested.
  coverageThreshold: { global: { lines: 5 } },
  coverageReporters: ['text', 'lcov']
};
