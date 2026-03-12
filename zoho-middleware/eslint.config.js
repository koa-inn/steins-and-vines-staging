const globals = require('globals');

module.exports = [
  {
    files: ['routes/**/*.js', 'lib/**/*.js', 'server.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      eqeqeq: 'warn',
      'no-console': 'off',
    },
  },
];
