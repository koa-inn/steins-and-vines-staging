const globals = require('globals');

module.exports = [
  // Global ignores — auto-generated or minified files
  {
    ignores: ['js/main.js', '**/*.min.js'],
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      eqeqeq: 'warn',
      'no-console': 'warn',
    },
  },
];
