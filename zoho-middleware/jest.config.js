module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverage: true,
  collectCoverageFrom: [
    'lib/**/*.js',
    '!lib/gp.js',      // Global Payments integration — Campaign 2+
    '!lib/mailer.js'   // Nodemailer wrapper — Campaign 2+
  ],
  // Per-file thresholds for Campaign 1 targets; global is achievable with 5 tested files
  coverageThreshold: {
    global: { lines: 35 },
    './lib/validate.js': { lines: 98 },
    './lib/logger.js': { lines: 98 }
  },
  coverageReporters: ['text', 'lcov']
};
